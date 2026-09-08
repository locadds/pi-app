import { describe, expect, it, vi } from 'vitest'

import { createHubTaskExecutionLifecycleCoordinatorV1 } from './hub-execution-lifecycle'

const address = {
  projectId: `xgp1_${'a'.repeat(64)}`,
  sessionKey: `xgs1_${'b'.repeat(64)}`,
} as const

describe('HubTaskExecutionLifecycleCoordinatorV1', () => {
  it('records execution start but never invents a terminal result before verification or delivery is terminal', async () => {
    const evidence = {
      listExecutionBindings: vi.fn(() => []),
      recordExecutionStarted: vi.fn(async () => {}),
      reportDeliveryOutcome: vi.fn(async () => {}),
      reportExecutionOutcome: vi.fn(async () => {}),
    }
    const coordinator = createHubTaskExecutionLifecycleCoordinatorV1({
      application: {
        observeM2B: vi.fn(async () => ({
          ok: true,
          value: {
            activeFlow: { flowId: 'flow-1' },
            taskRuns: [{ taskRunId: 'run-1', attemptId: 'attempt-1', status: 'RUNNING' }],
            attempts: [{ attemptId: 'attempt-1', taskRunId: 'run-1', status: 'RUNNING' }],
          },
        })),
      } as never,
      taskExecution: { recover: vi.fn(async () => {}) },
      delivery: { recover: vi.fn(async () => {}), readLatestDelivery: vi.fn(() => null) },
      evidence,
    })

    await coordinator.reconcile({ address: address as never, flowId: 'flow-1', taskRunId: 'run-1', attemptId: 'attempt-1' })

    expect(evidence.recordExecutionStarted).toHaveBeenCalledWith(address as never, 'flow-1')
    expect(evidence.reportDeliveryOutcome).not.toHaveBeenCalled()
    expect(evidence.reportExecutionOutcome).not.toHaveBeenCalled()
  })

  it('reports an unverified failed execution as NOT_RUN, never RESULT_READY', async () => {
    const evidence = {
      listExecutionBindings: vi.fn(() => []),
      recordExecutionStarted: vi.fn(async () => {}),
      reportDeliveryOutcome: vi.fn(async () => {}),
      reportExecutionOutcome: vi.fn(async () => {}),
    }
    const coordinator = createHubTaskExecutionLifecycleCoordinatorV1({
      application: {
        observeM2B: vi.fn(async () => ({
          ok: true,
          value: {
            activeFlow: { flowId: 'flow-1' },
            taskRuns: [{ taskRunId: 'run-1', attemptId: 'attempt-1', status: 'FAILED' }],
            attempts: [{ attemptId: 'attempt-1', taskRunId: 'run-1', status: 'FAILED' }],
          },
        })),
      } as never,
      taskExecution: { recover: vi.fn(async () => {}) },
      delivery: { recover: vi.fn(async () => {}), readLatestDelivery: vi.fn(() => null) },
      evidence,
    })

    await coordinator.reconcile({ address: address as never, flowId: 'flow-1', taskRunId: 'run-1', attemptId: 'attempt-1' })

    expect(evidence.reportExecutionOutcome).toHaveBeenCalledWith(address as never, 'flow-1', {
      verificationState: 'NOT_RUN',
    })
    expect(evidence.reportDeliveryOutcome).not.toHaveBeenCalled()
  })
})
