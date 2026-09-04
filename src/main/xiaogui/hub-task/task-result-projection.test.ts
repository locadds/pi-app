import { describe, expect, it } from 'vitest'

import type { DeliveryBatchProjectionV1 } from '@shared/xiaogui-delivery'
import { canonicalizeXiaoguiTaskResultEnvelopeV1 } from '@shared/xiaogui-hub-task-contract'
import { projectHubTaskResultFromDeliveryV1 } from './task-result-projection'

const base = {
  resultId: 'xgh_result_1',
  assignmentId: 'xgh_assignment_1',
  taskId: 'xgh_task_1',
  occurredAt: '2026-09-04T00:00:00.000Z',
}

function delivery(state: DeliveryBatchProjectionV1['state']): DeliveryBatchProjectionV1 {
  return {
    state,
    flowId: 'xhbf_flow',
    deliveryChangeSetId: 'xhbdcs_1',
    deliveryChangeSetDigest: `sha256:${'a'.repeat(64)}`,
  } as unknown as DeliveryBatchProjectionV1
}

describe('H1-4C controlled TaskHub result projection', () => {
  it('turns an existing verified delivery candidate into a safe result-ready envelope', () => {
    const result = projectHubTaskResultFromDeliveryV1({ ...base, delivery: delivery('READY_FOR_REVIEW') })
    expect(result).toEqual(expect.objectContaining({
      schemaVersion: 'xiaogui.task-result.v1',
      outcome: 'RESULT_READY',
      verification: { verdict: 'PASS', summary: '本机交付验证已通过。' },
      artifactRefs: [{
        artifactId: 'xhbdcs_1',
        mediaType: 'application/vnd.xiaogui.delivery-changeset-ref+json',
        sha256: `sha256:${'a'.repeat(64)}`,
      }],
    }))
    expect(result?.resultSha256).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(result?.resultSha256).not.toContain('D:')
    if (!result) throw new Error('expected result')
    const { resultSha256: _digest, ...unsigned } = result
    expect(canonicalizeXiaoguiTaskResultEnvelopeV1(unsigned)).toContain('RESULT_READY')
  })

  it.each([
    ['REJECTED', 'EXECUTION_FAILED', 'FAIL'],
    ['OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN'],
  ] as const)('maps %s without exposing local delivery internals', (state, outcome, verdict) => {
    const result = projectHubTaskResultFromDeliveryV1({ ...base, delivery: delivery(state) })
    expect(result).toEqual(expect.objectContaining({ outcome, verification: expect.objectContaining({ verdict }) }))
    expect(JSON.stringify(result)).not.toMatch(/[A-Za-z]:[\\/]/)
    expect(JSON.stringify(result)).not.toContain('flowId')
  })

  it('does not report a terminal result before the existing delivery workflow reaches a terminal projection', () => {
    expect(projectHubTaskResultFromDeliveryV1({ ...base, delivery: delivery('VERIFYING') })).toBeNull()
  })
})
