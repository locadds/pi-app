import { describe, expect, it } from 'vitest'

import type { AttemptId, FlowId, SystemAgentOutcomeRecordIntentM2BV1, TaskRunId } from './xiaogui-collaboration-hub'

const flowId = 'xhbf_flow' as FlowId
const taskRunId = 'xhbtr_task' as TaskRunId
const attemptId = 'xhba_attempt' as AttemptId
const failure = { kind: 'AGENT_FAILURE', failureClass: 'RUNTIME', safeCode: 'RUNTIME_FAILED', receiptDigest: 'sha256:failed' } as const

describe('xiaogui collaboration hub shared contract', () => {
  it('closes M2B system agent outcome DTOs by outcome kind', () => {
    const failed = {
      type: 'system.agent.outcome.record',
      flowId,
      taskRunId,
      attemptId,
      runtimeSessionId: 'runtime-1',
      outcome: 'FAILED',
      receiptDigest: 'sha256:failed',
      failure,
    } satisfies SystemAgentOutcomeRecordIntentM2BV1
    expect(failed.failure.safeCode).toBe('RUNTIME_FAILED')

    // @ts-expect-error FAILED must include a closed AgentFailureSignal.
    const missingSignal: SystemAgentOutcomeRecordIntentM2BV1 = {
      type: 'system.agent.outcome.record',
      flowId,
      taskRunId,
      attemptId,
      runtimeSessionId: 'runtime-1',
      outcome: 'FAILED',
      receiptDigest: 'sha256:failed',
    }
    expect(missingSignal.outcome).toBe('FAILED')

    // @ts-expect-error OUTCOME_UNKNOWN must not carry a failure signal.
    const unknownWithSignal: SystemAgentOutcomeRecordIntentM2BV1 = {
      type: 'system.agent.outcome.record',
      flowId,
      taskRunId,
      attemptId,
      runtimeSessionId: 'runtime-1',
      outcome: 'OUTCOME_UNKNOWN',
      receiptDigest: 'sha256:unknown',
      failure,
    }
    expect(unknownWithSignal.outcome).toBe('OUTCOME_UNKNOWN')
  })
})
