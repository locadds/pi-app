import { describe, expect, it, vi } from 'vitest'

import type { HubAddressV1, SessionCollaborationProjectionM2BV1 } from '@shared/xiaogui-collaboration-hub'
import type { DeliveryBatchProjectionV1 } from '@shared/xiaogui-delivery'
import {
  createHubTaskExecutionLifecycleCoordinatorV1,
  type HubTaskExecutionEvidencePortV1,
} from './hub-execution-lifecycle'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as HubAddressV1

function projection(input: {
  taskStatus: SessionCollaborationProjectionM2BV1['taskRuns'][number]['status']
  attemptStatus: SessionCollaborationProjectionM2BV1['attempts'][number]['status']
  verificationState?: 'FAILED' | 'OUTCOME_UNKNOWN'
  secondTask?: boolean
}): SessionCollaborationProjectionM2BV1 {
  const taskRuns = [{
    taskRunId: 'xhbtr_current',
    taskSpecId: 'xhbts_current',
    taskKey: 'task-current',
    status: input.taskStatus,
    attemptId: 'xhba_current',
  }]
  const attempts = [{
    attemptId: 'xhba_current',
    taskRunId: 'xhbtr_current',
    status: input.attemptStatus,
    ...(input.verificationState
      ? {
          verificationSummary: {
            scope: 'TASK',
            state: input.verificationState,
            verdict: input.verificationState === 'FAILED' ? 'FAIL' : 'OUTCOME_UNKNOWN',
          },
        }
      : {}),
  }]
  if (input.secondTask) {
    taskRuns.push({
      taskRunId: 'xhbtr_other',
      taskSpecId: 'xhbts_other',
      taskKey: 'task-other',
      status: 'FAILED',
      attemptId: 'xhba_other',
    })
    attempts.push({
      attemptId: 'xhba_other',
      taskRunId: 'xhbtr_other',
      status: 'FAILED',
    })
  }
  return {
    version: 'm2b.v1',
    activeFlow: { flowId: 'xhbf_current', status: 'PLAN_ACTIVE' },
    taskRuns,
    attempts,
  } as unknown as SessionCollaborationProjectionM2BV1
}

function harness(input: {
  current: SessionCollaborationProjectionM2BV1
  delivery?: DeliveryBatchProjectionV1 | null
  events?: string[]
}) {
  const events = input.events ?? []
  const evidence: HubTaskExecutionEvidencePortV1 = {
    listExecutionBindings: () => [{ address: ADDRESS, flowId: 'xhbf_current' }],
    recordExecutionStarted: vi.fn(async () => { events.push('start') }),
    reportDeliveryOutcome: vi.fn(async () => { events.push('delivery-result') }),
    reportExecutionOutcome: vi.fn(async (_address, _flowId, terminal) => {
      events.push(`execution-result:${terminal.verificationState}`)
    }),
  }
  const coordinator = createHubTaskExecutionLifecycleCoordinatorV1({
    application: {
      observeM2B: vi.fn(async () => ({ ok: true as const, value: input.current })),
    },
    taskExecution: {
      recover: vi.fn(async () => { events.push('task-recover') }),
    },
    delivery: {
      recover: vi.fn(async () => { events.push('delivery-recover') }),
      readLatestDelivery: vi.fn(() => {
        events.push('delivery-read')
        return input.delivery ?? null
      }),
    },
    evidence,
  })
  return { coordinator, evidence, events }
}

describe('HubTaskExecutionLifecycleCoordinatorV1', () => {
  it('reports OUTCOME_UNKNOWN ahead of a simultaneous known failure, after start evidence', async () => {
    const { coordinator, evidence, events } = harness({
      current: projection({ taskStatus: 'FAILED', attemptStatus: 'OUTCOME_UNKNOWN' }),
    })

    await coordinator.reconcile({ address: ADDRESS, flowId: 'xhbf_current' })

    expect(events).toEqual(['start', 'delivery-read', 'execution-result:UNKNOWN'])
    expect(evidence.reportExecutionOutcome).toHaveBeenCalledWith(
      ADDRESS,
      'xhbf_current',
      { verificationState: 'UNKNOWN' },
    )
  })

  it('reports a terminal Delivery before considering execution failure or unknown state', async () => {
    const { coordinator, evidence, events } = harness({
      current: projection({ taskStatus: 'OUTCOME_UNKNOWN', attemptStatus: 'OUTCOME_UNKNOWN' }),
      delivery: {
        state: 'READY_FOR_REVIEW',
        flowId: 'xhbf_current',
      } as DeliveryBatchProjectionV1,
    })

    await coordinator.reconcile({ address: ADDRESS, flowId: 'xhbf_current' })

    expect(events).toEqual(['start', 'delivery-read', 'delivery-result'])
    expect(evidence.reportExecutionOutcome).not.toHaveBeenCalled()
  })

  it('reports a known pre-verification failure when no terminal Delivery exists', async () => {
    const { coordinator, evidence, events } = harness({
      current: projection({ taskStatus: 'FAILED', attemptStatus: 'FAILED' }),
    })

    await coordinator.reconcile({ address: ADDRESS, flowId: 'xhbf_current' })

    expect(events).toEqual(['start', 'delivery-read', 'execution-result:NOT_RUN'])
    expect(evidence.reportExecutionOutcome).toHaveBeenCalledWith(
      ADDRESS,
      'xhbf_current',
      { verificationState: 'NOT_RUN' },
    )
  })

  it('uses exact task and Attempt hints instead of aggregating another task in the Session', async () => {
    const { coordinator, evidence } = harness({
      current: projection({
        taskStatus: 'RUNNING',
        attemptStatus: 'RUNNING',
        secondTask: true,
      }),
    })

    await coordinator.reconcile({
      address: ADDRESS,
      flowId: 'xhbf_current',
      taskRunId: 'xhbtr_current',
      attemptId: 'xhba_current',
    })

    expect(evidence.recordExecutionStarted).toHaveBeenCalledOnce()
    expect(evidence.reportExecutionOutcome).not.toHaveBeenCalled()
  })

  it('queues start evidence before recovering local authority and then reports persisted Delivery', async () => {
    const events: string[] = []
    const { coordinator } = harness({
      events,
      current: projection({ taskStatus: 'RUNNING', attemptStatus: 'RUNNING' }),
      delivery: {
        state: 'READY_FOR_REVIEW',
        flowId: 'xhbf_current',
      } as DeliveryBatchProjectionV1,
    })

    await coordinator.recover()

    expect(events).toEqual([
      'start',
      'task-recover',
      'delivery-recover',
      'start',
      'delivery-read',
      'delivery-result',
    ])
  })

  it('keeps startup recovery fail-closed when the initial authority read throws', async () => {
    const events: string[] = []
    const evidence: HubTaskExecutionEvidencePortV1 = {
      listExecutionBindings: () => [{ address: ADDRESS, flowId: 'xhbf_current' }],
      recordExecutionStarted: vi.fn(async () => { events.push('start') }),
      reportDeliveryOutcome: vi.fn(async () => { events.push('delivery-result') }),
      reportExecutionOutcome: vi.fn(async () => { events.push('execution-result') }),
    }
    const coordinator = createHubTaskExecutionLifecycleCoordinatorV1({
      application: {
        observeM2B: vi.fn(async () => { throw new Error('temporary read failure') }),
      },
      taskExecution: {
        recover: vi.fn(async () => { events.push('task-recover') }),
      },
      delivery: {
        recover: vi.fn(async () => { events.push('delivery-recover') }),
        readLatestDelivery: vi.fn(() => null),
      },
      evidence,
    })

    await expect(coordinator.recover()).resolves.toBeUndefined()

    expect(events).toEqual(['task-recover', 'delivery-recover'])
    expect(evidence.recordExecutionStarted).not.toHaveBeenCalled()
    expect(evidence.reportExecutionOutcome).not.toHaveBeenCalled()
  })

  it('keeps a reconcile call awaitable while startup recovery is still active', async () => {
    let releaseTaskRecovery!: () => void
    const taskRecovery = new Promise<void>((resolve) => { releaseTaskRecovery = resolve })
    const events: string[] = []
    const evidence: HubTaskExecutionEvidencePortV1 = {
      listExecutionBindings: () => [{ address: ADDRESS, flowId: 'xhbf_current' }],
      recordExecutionStarted: vi.fn(async () => { events.push('start') }),
      reportDeliveryOutcome: vi.fn(async () => { events.push('delivery-result') }),
      reportExecutionOutcome: vi.fn(async () => { events.push('execution-result') }),
    }
    const coordinator = createHubTaskExecutionLifecycleCoordinatorV1({
      application: {
        observeM2B: vi.fn(async () => ({
          ok: true as const,
          value: projection({ taskStatus: 'RUNNING', attemptStatus: 'RUNNING' }),
        })),
      },
      taskExecution: {
        recover: vi.fn(async () => {
          events.push('task-recover')
          await taskRecovery
        }),
      },
      delivery: {
        recover: vi.fn(async () => { events.push('delivery-recover') }),
        readLatestDelivery: vi.fn(() => null),
      },
      evidence,
    })

    const recovery = coordinator.recover()
    let reconciliationSettled = false
    const reconciliation = coordinator
      .reconcile({ address: ADDRESS, flowId: 'xhbf_current' })
      .then(() => { reconciliationSettled = true })
    await Promise.resolve()

    expect(reconciliationSettled).toBe(false)

    releaseTaskRecovery()
    await recovery
    await reconciliation
    expect(reconciliationSettled).toBe(true)
    expect(events.indexOf('delivery-recover')).toBeGreaterThan(events.indexOf('task-recover'))
  })
})
