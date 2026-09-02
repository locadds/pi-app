import { createHash } from 'node:crypto'

import type {
  RuntimeEventV1,
  RuntimeOutcomeV1,
  RuntimePermissionDecisionV1,
} from '@shared/xiaogui-agent-runtime'

import type { AgentRuntimeHostV1 } from '../agent-runtime/runtime-host'

const DEFAULT_POLL_INTERVAL_MS = 1_000
const CLOSED = Symbol('runtime-outcome-monitor-closed')

export type RuntimeOutcomeCallbackV1 = (outcome: RuntimeOutcomeV1) => void | Promise<void>
export type RuntimePermissionRequestEventV1 = Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }>
export type RuntimePermissionDecisionFactoryV1 = (
  event: RuntimePermissionRequestEventV1,
) => RuntimePermissionDecisionV1 | Promise<RuntimePermissionDecisionV1>

export interface RuntimeOutcomeMonitorV1 {
  watch(
    runtimeSessionId: string,
    callback: RuntimeOutcomeCallbackV1,
    permissionDecisionFactory?: RuntimePermissionDecisionFactoryV1,
  ): void
  close(): Promise<void>
}

export interface RuntimeOutcomeMonitorOptionsV1 {
  runtime: AgentRuntimeHostV1
  sleep?: (delayMs: number) => Promise<void>
  intervalMs?: number
}

export function createRuntimeOutcomeMonitorV1(options: RuntimeOutcomeMonitorOptionsV1): RuntimeOutcomeMonitorV1 {
  const sleep = options.sleep ?? defaultSleep
  const intervalMs = validInterval(options.intervalMs) ? options.intervalMs : DEFAULT_POLL_INTERVAL_MS
  const watchedSessions = new Set<string>()
  const activePolls = new Map<string, Promise<void>>()
  let closed = false
  let resolveClosed!: () => void
  let closeTask: Promise<void> | undefined
  const closedSignal = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  return {
    watch(runtimeSessionId, callback, permissionDecisionFactory) {
      if (closed || watchedSessions.has(runtimeSessionId)) return
      watchedSessions.add(runtimeSessionId)

      const poll = pollUntilSettled(
        options.runtime,
        runtimeSessionId,
        callback,
        permissionDecisionFactory,
        sleep,
        intervalMs,
        closedSignal,
      ).finally(() => {
        activePolls.delete(runtimeSessionId)
      })
      activePolls.set(runtimeSessionId, poll)
    },

    close() {
      if (closeTask) return closeTask
      closed = true
      resolveClosed()
      closeTask = Promise.allSettled([...activePolls.values()]).then(() => undefined)
      return closeTask
    },
  }
}

async function pollUntilSettled(
  runtime: AgentRuntimeHostV1,
  runtimeSessionId: string,
  callback: RuntimeOutcomeCallbackV1,
  permissionDecisionFactory: RuntimePermissionDecisionFactoryV1 | undefined,
  sleep: (delayMs: number) => Promise<void>,
  intervalMs: number,
  closedSignal: Promise<void>,
): Promise<void> {
  let afterSequence = 0
  while (true) {
    if (permissionDecisionFactory) {
      const drained = await raceWithClose(
        drainPermissionEvents(runtime, runtimeSessionId, afterSequence, permissionDecisionFactory),
        closedSignal,
      )
      if (drained === CLOSED) return
      afterSequence = drained.afterSequence
      if (!drained.ok) {
        await interruptAfterPermissionFailure(runtime, runtimeSessionId, drained.reasonCode)
        await containCallback(callback, permissionFailure(runtimeSessionId, drained.reasonCode))
        return
      }
    }

    const inspected = await raceWithClose(inspect(runtime, runtimeSessionId), closedSignal)
    if (inspected === CLOSED) return

    if (inspected.state === 'OUTCOME_UNKNOWN' && inspected.reasonCode === 'RUNTIME_STILL_RUNNING') {
      const waited = await raceWithClose(safeSleep(sleep, intervalMs), closedSignal)
      if (waited === CLOSED) return
      continue
    }

    await containCallback(callback, inspected)
    return
  }
}

async function drainPermissionEvents(
  runtime: AgentRuntimeHostV1,
  runtimeSessionId: string,
  afterSequence: number,
  decisionFactory: RuntimePermissionDecisionFactoryV1,
): Promise<{ ok: true; afterSequence: number } | { ok: false; afterSequence: number; reasonCode: string }> {
  let cursor = afterSequence
  try {
    for await (const event of runtime.stream(runtimeSessionId, afterSequence)) {
      cursor = Math.max(cursor, event.sequence)
      if (event.type === 'OUTCOME_UNKNOWN') {
        return { ok: false, afterSequence: cursor, reasonCode: event.reasonCode }
      }
      if (event.type !== 'PERMISSION_REQUESTED') continue
      const decision = await decisionFactory(event)
      const result = await runtime.permission(decision)
      if (!result.accepted) {
        return {
          ok: false,
          afterSequence: cursor,
          reasonCode: result.reasonCode ?? 'RUNTIME_PERMISSION_REJECTED',
        }
      }
    }
    return { ok: true, afterSequence: cursor }
  } catch {
    return { ok: false, afterSequence: cursor, reasonCode: 'RUNTIME_PERMISSION_BROKER_ERROR' }
  }
}

async function interruptAfterPermissionFailure(
  runtime: AgentRuntimeHostV1,
  runtimeSessionId: string,
  reasonCode: string,
): Promise<void> {
  try {
    await runtime.interrupt({
      requestId: `xhbrmi_${hashHex(`permission-failure:${runtimeSessionId}`).slice(0, 48)}`,
      runtimeSessionId,
      reason: reasonCode,
    })
  } catch {
    // Best-effort cleanup; the authoritative outcome remains OUTCOME_UNKNOWN.
  }
}

function permissionFailure(runtimeSessionId: string, reasonCode: string): RuntimeOutcomeV1 {
  return {
    state: 'OUTCOME_UNKNOWN',
    runtimeSessionId,
    inspectHandleDigest: `sha256:${hashHex(JSON.stringify({
      domain: 'xiaogui.runtime-permission-failure.v1',
      runtimeSessionId,
      reasonCode,
    }))}`,
    reasonCode,
  }
}

async function containCallback(callback: RuntimeOutcomeCallbackV1, outcome: RuntimeOutcomeV1): Promise<void> {
  try {
    await callback(outcome)
  } catch {
    // A consumer failure must not escape into Electron's main process.
  }
}

async function inspect(runtime: AgentRuntimeHostV1, runtimeSessionId: string): Promise<RuntimeOutcomeV1> {
  try {
    return await runtime.inspect(runtimeSessionId)
  } catch {
    return {
      state: 'OUTCOME_UNKNOWN',
      runtimeSessionId,
      inspectHandleDigest: 'sha256:runtime-monitor-inspect-error',
      reasonCode: 'RUNTIME_ADAPTER_ERROR',
    }
  }
}

async function safeSleep(sleep: (delayMs: number) => Promise<void>, intervalMs: number): Promise<void> {
  try {
    await sleep(intervalMs)
  } catch {
    // A scheduler failure is treated as an early wake-up, not a process error.
  }
}

async function raceWithClose<T>(pending: Promise<T>, closedSignal: Promise<void>): Promise<T | typeof CLOSED> {
  return Promise.race([pending, closedSignal.then(() => CLOSED)]) as Promise<T | typeof CLOSED>
}

function validInterval(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function hashHex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
