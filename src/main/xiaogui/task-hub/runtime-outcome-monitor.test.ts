import { describe, expect, it, vi } from 'vitest'

import type { RuntimeOutcomeV1 } from '@shared/xiaogui-agent-runtime'

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
