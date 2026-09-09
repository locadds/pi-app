import { describe, expect, it } from 'vitest'
import { projectHubTaskResultFromExecutionTerminalV1 } from './task-result-projection'

describe('execution terminal result projection', () => {
  it.each([
    ['NOT_RUN', 'NOT_RUN', 'EXECUTION_FAILED'],
    ['FAIL', 'FAIL', 'EXECUTION_FAILED'],
    ['UNKNOWN', 'OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN'],
  ] as const)('preserves %s verification evidence', (verificationState, verdict, outcome) => {
    const result = projectHubTaskResultFromExecutionTerminalV1({
      resultId: 'result-1', assignmentId: 'assignment-1', taskId: 'task-1',
      occurredAt: '2026-09-09T00:00:00.000Z', verificationState,
    })
    expect(result.verification.verdict).toBe(verdict)
    expect(result.outcome).toBe(outcome)
  })
})
