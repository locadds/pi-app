import { describe, expect, it, vi } from 'vitest'

import type {
  RuntimeEventV1,
  RuntimeOutcomeV1,
  RuntimePermissionDecisionV1,
} from '@shared/xiaogui-agent-runtime'

import type { AgentRuntimeHostV1 } from '../agent-runtime/runtime-host'
import { createRuntimeOutcomeMonitorV1 } from './runtime-outcome-monitor'

describe('RuntimeOutcomeMonitorV1', () => {
  it('polls through RUNTIME_STILL_RUNNING and delivers a terminal outcome once per session', async () => {
    const inspect = vi
      .fn<AgentRuntimeHostV1['inspect']>()
      .mockResolvedValueOnce(running('runtime-1'))
      .mockResolvedValueOnce(succeeded('runtime-1'))
    const sleep = vi.fn(async () => undefined)
    const first = vi.fn()
    const duplicate = vi.fn()
    const monitor = createRuntimeOutcomeMonitorV1({ runtime: runtimeWith(inspect), sleep, intervalMs: 25 })

    monitor.watch('runtime-1', first)
    monitor.watch('runtime-1', duplicate)
    await eventually(() => expect(first).toHaveBeenCalledOnce())
    monitor.watch('runtime-1', duplicate)
    await monitor.close()

    expect(inspect).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledOnce()
    expect(sleep).toHaveBeenCalledWith(25)
    expect(first).toHaveBeenCalledWith(succeeded('runtime-1'))
    expect(duplicate).not.toHaveBeenCalled()
  })

  it.each<RuntimeOutcomeV1>([
    { state: 'FAILED', runtimeSessionId: 'runtime-1', receiptDigest: 'sha256:failed', reasonCode: 'RUNTIME_FAILED' },
    { state: 'INTERRUPTED', runtimeSessionId: 'runtime-1', receiptDigest: 'sha256:interrupted', reasonCode: 'RUNTIME_CANCELLED' },
    {
      state: 'OUTCOME_UNKNOWN',
      runtimeSessionId: 'runtime-1',
      inspectHandleDigest: 'sha256:unknown',
      reasonCode: 'PROCESS_DISCONNECTED',
    },
  ])('delivers $state once without another poll', async (outcome) => {
    const inspect = vi.fn<AgentRuntimeHostV1['inspect']>().mockResolvedValue(outcome)
    const callback = vi.fn()
    const monitor = createRuntimeOutcomeMonitorV1({ runtime: runtimeWith(inspect), sleep: async () => undefined, intervalMs: 0 })

    monitor.watch('runtime-1', callback)
    await eventually(() => expect(callback).toHaveBeenCalledOnce())
    await monitor.close()

    expect(inspect).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(outcome)
  })

  it('turns an inspect rejection into one OUTCOME_UNKNOWN callback', async () => {
    const inspect = vi.fn<AgentRuntimeHostV1['inspect']>().mockRejectedValue(new Error('adapter disconnected'))
    const callback = vi.fn()
    const monitor = createRuntimeOutcomeMonitorV1({ runtime: runtimeWith(inspect), sleep: async () => undefined })

    monitor.watch('runtime-1', callback)
    await eventually(() => expect(callback).toHaveBeenCalledOnce())
    await monitor.close()

    expect(callback).toHaveBeenCalledWith({
      state: 'OUTCOME_UNKNOWN',
      runtimeSessionId: 'runtime-1',
      inspectHandleDigest: 'sha256:runtime-monitor-inspect-error',
      reasonCode: 'RUNTIME_ADAPTER_ERROR',
    })
  })

  it('drains permission events and applies the supplied one-time decision before inspecting', async () => {
    const permissionEvent = requestedPermission('runtime-1')
    const stream = vi.fn(async function* (_runtimeSessionId: string, afterSequence: number) {
      if (afterSequence < permissionEvent.sequence) yield permissionEvent
    })
    const permission = vi.fn(async () => ({ accepted: true }))
    const inspect = vi.fn<AgentRuntimeHostV1['inspect']>().mockResolvedValue(succeeded('runtime-1'))
    const callback = vi.fn()
    const decision = allowOnce(permissionEvent)
    const decisionFactory = vi.fn(async () => decision)
    const runtime = { stream, permission, inspect } as unknown as AgentRuntimeHostV1
    const monitor = createRuntimeOutcomeMonitorV1({ runtime, sleep: async () => undefined })

    monitor.watch('runtime-1', callback, decisionFactory)
    await eventually(() => expect(callback).toHaveBeenCalledOnce())
    await monitor.close()

    expect(decisionFactory).toHaveBeenCalledWith(permissionEvent)
    expect(permission).toHaveBeenCalledWith(decision)
    expect(permission.mock.invocationCallOrder[0]).toBeLessThan(inspect.mock.invocationCallOrder[0])
    expect(callback).toHaveBeenCalledWith(succeeded('runtime-1'))
  })

  it('fails closed and interrupts when a permission decision is rejected', async () => {
    const permissionEvent = requestedPermission('runtime-1')
    const stream = vi.fn(async function* () {
      yield permissionEvent
    })
    const permission = vi.fn(async () => ({ accepted: false, reasonCode: 'PERMISSION_SCOPE_MISMATCH' }))
    const interrupt = vi.fn(async () => ({ requested: true as const }))
    const inspect = vi.fn<AgentRuntimeHostV1['inspect']>()
    const callback = vi.fn()
    const runtime = { stream, permission, interrupt, inspect } as unknown as AgentRuntimeHostV1
    const monitor = createRuntimeOutcomeMonitorV1({ runtime, sleep: async () => undefined })

    monitor.watch('runtime-1', callback, () => allowOnce(permissionEvent))
    await eventually(() => expect(callback).toHaveBeenCalledOnce())
    await monitor.close()

    expect(interrupt).toHaveBeenCalledWith(expect.objectContaining({
      runtimeSessionId: 'runtime-1',
      reason: 'PERMISSION_SCOPE_MISMATCH',
    }))
    expect(inspect).not.toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      state: 'OUTCOME_UNKNOWN',
      runtimeSessionId: 'runtime-1',
      reasonCode: 'PERMISSION_SCOPE_MISMATCH',
    }))
  })

  it('turns a stream-level OUTCOME_UNKNOWN event into an immediate fail-closed callback', async () => {
    const stream = vi.fn(async function* () {
      yield {
        type: 'OUTCOME_UNKNOWN' as const,
        runtimeSessionId: 'runtime-1',
        sequence: 1,
        reasonCode: 'EVENT_SEQUENCE_GAP',
      }
    })
    const interrupt = vi.fn(async () => ({ requested: true as const }))
    const inspect = vi.fn<AgentRuntimeHostV1['inspect']>()
    const callback = vi.fn()
    const runtime = { stream, interrupt, inspect } as unknown as AgentRuntimeHostV1
    const monitor = createRuntimeOutcomeMonitorV1({ runtime, sleep: async () => undefined })

    monitor.watch('runtime-1', callback, () => {
      throw new Error('no permission decision expected')
    })
    await eventually(() => expect(callback).toHaveBeenCalledOnce())
    await monitor.close()

    expect(inspect).not.toHaveBeenCalled()
    expect(interrupt).toHaveBeenCalledWith(expect.objectContaining({ reason: 'EVENT_SEQUENCE_GAP' }))
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      state: 'OUTCOME_UNKNOWN',
      reasonCode: 'EVENT_SEQUENCE_GAP',
    }))
  })

  it('cancels pending polling on close and ignores watches after close', async () => {
    const inspect = vi.fn<AgentRuntimeHostV1['inspect']>().mockResolvedValue(running('runtime-1'))
    const sleepStarted = deferred<void>()
    const neverFinishSleeping = deferred<void>()
    const sleep = vi.fn(() => {
      sleepStarted.resolve()
      return neverFinishSleeping.promise
    })
    const callback = vi.fn()
    const monitor = createRuntimeOutcomeMonitorV1({ runtime: runtimeWith(inspect), sleep })

    monitor.watch('runtime-1', callback)
    await sleepStarted.promise
    const firstClose = monitor.close()
    const secondClose = monitor.close()
    await expect(firstClose).resolves.toBeUndefined()
    await expect(secondClose).resolves.toBeUndefined()
    monitor.watch('runtime-2', callback)

    expect(inspect).toHaveBeenCalledOnce()
    expect(callback).not.toHaveBeenCalled()
  })

  it('waits for an in-flight async callback and contains its rejection', async () => {
    const inspect = vi.fn<AgentRuntimeHostV1['inspect']>().mockResolvedValue(succeeded('runtime-1'))
    const callbackStarted = deferred<void>()
    const callbackFinished = deferred<void>()
    const callback = vi.fn(async () => {
      callbackStarted.resolve()
      await callbackFinished.promise
      throw new Error('consumer failed')
    })
    const monitor = createRuntimeOutcomeMonitorV1({ runtime: runtimeWith(inspect), sleep: async () => undefined })

    monitor.watch('runtime-1', callback)
    await callbackStarted.promise
    let closed = false
    const close = monitor.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)

    callbackFinished.resolve()
    await expect(close).resolves.toBeUndefined()
    expect(callback).toHaveBeenCalledOnce()
  })
})

function runtimeWith(inspect: AgentRuntimeHostV1['inspect']): AgentRuntimeHostV1 {
  return { inspect } as AgentRuntimeHostV1
}

function running(runtimeSessionId: string): RuntimeOutcomeV1 {
  return {
    state: 'OUTCOME_UNKNOWN',
    runtimeSessionId,
    inspectHandleDigest: 'sha256:still-running',
    reasonCode: 'RUNTIME_STILL_RUNNING',
  }
}

function succeeded(runtimeSessionId: string): RuntimeOutcomeV1 {
  return { state: 'SUCCEEDED', runtimeSessionId, receiptDigest: 'sha256:succeeded', candidateDigest: 'sha256:candidate' }
}

function requestedPermission(runtimeSessionId: string): Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> {
  return {
    type: 'PERMISSION_REQUESTED',
    permissionRequestId: 'write-perm-1',
    runtimeSessionId,
    sequence: 1,
    challengeDigest: 'sha256:challenge',
    decisionRequired: 'ALLOW_ONCE_OR_DENY',
    permissionPurpose: 'FILE_WRITE',
    scope: {
      projectId: 'project-1',
      sessionKey: 'session-1',
      sessionMode: 'CODING',
      flowId: 'flow-1',
      taskRunId: 'task-run-1',
      attemptId: 'attempt-1',
      attemptDigest: 'sha256:attempt',
      workspaceReceiptId: 'workspace-receipt-1',
      workspaceReceiptDigest: 'sha256:workspace-receipt',
    },
  }
}

function allowOnce(
  event: Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }>,
): RuntimePermissionDecisionV1 {
  return {
    type: 'ALLOW_ONCE',
    permissionRequestId: event.permissionRequestId,
    challengeDigest: event.challengeDigest,
    decisionRequestId: 'decision-1',
    scope: event.scope,
    runtimeSessionId: event.runtimeSessionId,
    proofId: 'proof-1',
    proofDigest: 'sha256:proof',
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      if (attempt === 19) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
}
