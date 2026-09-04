import { createHash } from 'node:crypto'

import {
  XIAOGUI_HUB_TASK_RESULT_SCHEMA_V1,
  canonicalizeXiaoguiTaskResultEnvelopeV1,
  type XiaoguiTaskResultEnvelopeV1,
} from '@shared/xiaogui-hub-task-contract'
import type { DeliveryBatchProjectionV1 } from '@shared/xiaogui-delivery'

/**
 * Convert the already-authoritative local Delivery/Evidence projection into
 * the narrow H1-4C result envelope. This module never reads file bytes, raw
 * test output, paths, prompts, or Agent/session identifiers.
 */
export function projectHubTaskResultFromDeliveryV1(input: {
  resultId: string
  assignmentId: string
  taskId: string
  occurredAt: string
  delivery: DeliveryBatchProjectionV1
}): XiaoguiTaskResultEnvelopeV1 | null {
  const mapped = mapDeliveryState(input.delivery.state)
  if (!mapped) return null

  const unsigned = {
    schemaVersion: XIAOGUI_HUB_TASK_RESULT_SCHEMA_V1,
    resultId: input.resultId,
    assignmentId: input.assignmentId,
    taskId: input.taskId,
    outcome: mapped.outcome,
    resultSummary: mapped.resultSummary,
    artifactRefs: toArtifactRefs(input.delivery),
    verification: mapped.verification,
    occurredAt: input.occurredAt,
  } as const

  return {
    ...unsigned,
    resultSha256: sha256(canonicalizeXiaoguiTaskResultEnvelopeV1(unsigned)),
  }
}

function mapDeliveryState(state: DeliveryBatchProjectionV1['state']): Pick<
  XiaoguiTaskResultEnvelopeV1,
  'outcome' | 'resultSummary' | 'verification'
> | null {
  switch (state) {
    // The local verification gate has passed, but an operator must still
    // approve before any user project write can happen.
    case 'READY_FOR_REVIEW':
    case 'APPROVED':
    case 'APPLYING':
    case 'APPLIED':
      return {
        outcome: 'RESULT_READY',
        resultSummary: '本机已形成通过受控验证的交付候选，仍需人工批准。',
        verification: { verdict: 'PASS', summary: '本机交付验证已通过。' },
      }
    case 'REJECTED':
      return {
        outcome: 'EXECUTION_FAILED',
        resultSummary: '本机交付验证未通过，未生成可应用交付。',
        verification: { verdict: 'FAIL', summary: '本机交付验证未通过。' },
      }
    case 'OUTCOME_UNKNOWN':
      return {
        outcome: 'OUTCOME_UNKNOWN',
        resultSummary: '本机交付结果暂时无法确认，未自动应用任何变更。',
        verification: { verdict: 'OUTCOME_UNKNOWN', summary: '本机交付验证结果暂时无法确认。' },
      }
    default:
      return null
  }
}

function toArtifactRefs(delivery: DeliveryBatchProjectionV1): XiaoguiTaskResultEnvelopeV1['artifactRefs'] {
  if (!delivery.deliveryChangeSetId || !delivery.deliveryChangeSetDigest) return []
  return [{
    artifactId: delivery.deliveryChangeSetId,
    mediaType: 'application/vnd.xiaogui.delivery-changeset-ref+json',
    sha256: delivery.deliveryChangeSetDigest,
  }]
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}
