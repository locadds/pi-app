import type { RuntimeOutcomeV1 } from '@shared/xiaogui-agent-runtime'

import type { AgentRuntimeHostV1 } from '../agent-runtime/runtime-host'

const DEFAULT_POLL_INTERVAL_MS = 1_000
const CLOSED = Symbol('runtime-outcome-monitor-closed')

export type RuntimeOutcomeCallbackV1 = (outcome: RuntimeOutcomeV1) => void | Promise<void>

export interface RuntimeOutcomeMonitorV1 {
  watch(runtimeSessionId: string, callback: RuntimeOutcomeCallbackV1): void
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
    watch(runtimeSessionId, callback) {
      if (closed || watchedSessions.has(runtimeSessionId)) return
      watchedSessions.add(runtimeSessionId)

      const poll = pollUntilSettled(options.runtime, runtimeSessionId, callback, sleep, intervalMs, closedSignal).finally(() => {
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
  sleep: (delayMs: number) => Promise<void>,
  intervalMs: number,
  closedSignal: Promise<void>,
): Promise<void> {
  while (true) {
    const inspected = await raceWithClose(inspect(runtime, runtimeSessionId), closedSignal)
    if (inspected === CLOSED) return

    if (inspected.state === 'OUTCOME_UNKNOWN' && inspected.reasonCode === 'RUNTIME_STILL_RUNNING') {
      const waited = await raceWithClose(safeSleep(sleep, intervalMs), closedSignal)
      if (waited === CLOSED) return
      continue
    }

    try {
      await callback(inspected)
    } catch {
      // A consumer failure must not escape into Electron's main process.
    }
    return
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
