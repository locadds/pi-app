import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import {
  canonicalizeXiaoguiTaskResultEnvelopeV1,
  type XiaoguiTaskDeliveryReceiptV1,
  type XiaoguiTaskResultSubmissionV1,
} from '@shared/xiaogui-hub-task-contract'
import {
  createInMemoryHubTaskWorkerStateStoreV1,
  type HubTaskWorkerAssignmentDetailV1,
} from './worker-state'

const PACKAGE_SHA256 = `sha256:${'a'.repeat(64)}`

function detail(overrides: Partial<HubTaskWorkerAssignmentDetailV1> = {}): HubTaskWorkerAssignmentDetailV1 {
  return {
    assignment: {
      assignmentId: 'xgh_assignment_1',
      taskId: 'xgh_task_1',
      decisionState: 'PENDING',
      deliveryState: 'QUEUED',
      executionState: 'NOT_STARTED',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    offer: {
      taskId: 'xgh_task_1',
      mode: 'DIRECT',
      title: '整理院内任务',
      taskContent: '请先生成一个待人工确认的任务计划。',
      constraints: ['不要自动执行'],
      acceptanceRequirements: ['用户确认计划后再执行'],
      attachmentRefs: [],
      packageSha256: PACKAGE_SHA256,
    },
    ...overrides,
  }
}

function receipt(sequence: number): XiaoguiTaskDeliveryReceiptV1 {
  return {
    schemaVersion: 'xiaogui.task-receipt.v1',
    eventId: `xgh_event_${sequence}`,
    assignmentId: 'xgh_assignment_1',
    taskId: 'xgh_task_1',
    subjectId: 'xgh_subject_1',
    nodeId: 'xgh_node_1',
    keyId: 'ed25519:test-key',
    eventType: 'USER_OPENED',
    packageSha256: PACKAGE_SHA256,
    occurredAt: '2026-09-01T00:00:00.000Z',
    sequence,
    resultSha256: null,
    signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  }
}

function resultSubmission(sequence: number): XiaoguiTaskResultSubmissionV1 {
  const result = {
    schemaVersion: 'xiaogui.task-result.v1' as const,
    resultId: 'xgh_result_1',
    assignmentId: 'xgh_assignment_1',
    taskId: 'xgh_task_1',
    outcome: 'RESULT_READY' as const,
    resultSummary: '本机已形成通过受控验证的交付候选，仍需人工批准。',
    artifactRefs: [],
    verification: { verdict: 'PASS' as const, summary: '本机交付验证已通过。' },
    occurredAt: '2026-09-01T00:02:00.000Z',
  }
  const resultSha256 = `sha256:${createHash('sha256').update(canonicalizeXiaoguiTaskResultEnvelopeV1(result), 'utf8').digest('hex')}`
  return {
    result: { ...result, resultSha256 },
    receipt: {
      ...receipt(sequence),
      eventId: `xgh_event_result_${sequence}`,
      eventType: 'RESULT_READY',
      occurredAt: result.occurredAt,
      resultSha256,
    },
  }
}

describe('HubTaskWorkerStateStoreV1', () => {
  it('persists a sanitized assignment mirror and never treats a local open as Hub delivery', () => {
    const store = createInMemoryHubTaskWorkerStateStoreV1()
    store.upsertAssignment(detail())
    store.markOpened('xgh_assignment_1', '2026-09-01T00:01:00.000Z')

    const entry = store.requireAssignment('xgh_assignment_1')
    expect(entry.openedAt).toBe('2026-09-01T00:01:00.000Z')
    expect(entry.assignment.deliveryState).toBe('QUEUED')
    expect(entry.localDeliveryState).toBe('PENDING_H1_4_RECEIPT')
  })

  it('keeps signed opening receipts durable and idempotent by event id', () => {
    const store = createInMemoryHubTaskWorkerStateStoreV1()
    store.upsertAssignment(detail())
    store.enqueueReceipt(receipt(1), '2026-09-01T00:01:00.000Z')
    store.enqueueReceipt(receipt(1), '2026-09-01T00:01:01.000Z')

    expect(store.pendingReceipts()).toEqual([
      expect.objectContaining({
        receipt: expect.objectContaining({ eventId: 'xgh_event_1', sequence: 1 }),
        queuedAt: '2026-09-01T00:01:00.000Z',
      }),
    ])
  })

  it('removes a pending receipt only after its exact verified Hub acknowledgement', () => {
    const store = createInMemoryHubTaskWorkerStateStoreV1()
    store.upsertAssignment(detail())
    store.markOpened('xgh_assignment_1', '2026-09-01T00:01:00.000Z')
    store.enqueueReceipt(receipt(1), '2026-09-01T00:01:00.000Z')
    store.enqueueReceipt(receipt(2), '2026-09-01T00:01:01.000Z')

    expect(store.acknowledgeReceipt('xgh_event_1', {
      receiptId: 'xgh_receipt_wrong',
      eventId: 'xgh_event_wrong',
      verified: true,
      duplicate: false,
      occurredAt: '2026-09-01T00:00:00.000Z',
      receivedAt: '2026-09-01T00:02:00.000Z',
    })).toBe(false)
    expect(store.pendingReceipts()).toHaveLength(2)

    expect(store.acknowledgeReceipt('xgh_event_1', {
      receiptId: 'xgh_receipt_2',
      eventId: 'xgh_event_2',
      verified: true,
      duplicate: false,
      occurredAt: '2026-09-01T00:00:00.000Z',
      receivedAt: '2026-09-01T00:02:00.000Z',
    })).toBe(false)
    expect(store.pendingReceipts().map((entry) => entry.receipt.eventId)).toEqual(['xgh_event_1', 'xgh_event_2'])

    expect(store.acknowledgeReceipt('xgh_event_1', {
      receiptId: 'xgh_receipt_1',
      eventId: 'xgh_event_1',
      verified: true,
      duplicate: true,
      occurredAt: '2026-09-01T00:00:00.000Z',
      receivedAt: '2026-09-01T00:02:00.000Z',
    })).toBe(true)
    expect(store.pendingReceipts().map((entry) => entry.receipt.eventId)).toEqual(['xgh_event_2'])
    expect(store.requireAssignment('xgh_assignment_1').localDeliveryState).toBe('HUB_CONFIRMED')
  })

  it('removes only stale local package projections after an authoritative active-node snapshot', () => {
    const store = createInMemoryHubTaskWorkerStateStoreV1()
    store.upsertAssignment(detail())
    store.markOpened('xgh_assignment_1', '2026-09-01T00:01:00.000Z')
    store.enqueueReceipt(receipt(1), '2026-09-01T00:01:00.000Z')

    store.reconcileAssignments([])

    expect(store.listAssignments()).toEqual([])
    expect(store.pendingReceipts()).toHaveLength(1)
  })

  it('records a local draft binding only after the approval-gated application accepts it', () => {
    const store = createInMemoryHubTaskWorkerStateStoreV1()
    store.upsertAssignment(detail({
      assignment: {
        ...detail().assignment,
        decisionState: 'ACCEPTED',
      },
    }))

    store.bindPlanDraft('xgh_assignment_1', {
      projectId: `xgp1_${'1'.repeat(64)}` as HubAddressV1['projectId'],
      sessionKey: `xgs1_${'2'.repeat(64)}` as HubAddressV1['sessionKey'],
      flowId: 'xhbf_1',
      revisionId: 'xhbr_1',
      createdAt: '2026-09-01T00:02:00.000Z',
    })

    expect(store.requireAssignment('xgh_assignment_1').localPlanDraft).toEqual({
      projectId: `xgp1_${'1'.repeat(64)}`,
      sessionKey: `xgs1_${'2'.repeat(64)}`,
      flowId: 'xhbf_1',
      revisionId: 'xhbr_1',
      createdAt: '2026-09-01T00:02:00.000Z',
    })
  })

  it('keeps a terminal result and its receipt as one durable item after the start receipt', () => {
    const store = createInMemoryHubTaskWorkerStateStoreV1()
    store.upsertAssignment(detail())
    store.enqueueReceipt({ ...receipt(1), eventType: 'EXECUTION_STARTED' }, '2026-09-01T00:01:00.000Z')
    store.enqueueResult(resultSubmission(2), '2026-09-01T00:02:00.000Z')

    expect(store.pendingEvidence().map((entry) => entry.kind)).toEqual(['RECEIPT', 'RESULT'])
    expect(store.hasPendingResultForAssignment('xgh_assignment_1')).toBe(true)
    expect(store.acknowledgeResult('xgh_result_1', 'xgh_event_wrong', {
      resultId: 'xgh_result_1',
      eventId: 'xgh_event_wrong',
      verified: true,
      duplicate: false,
      executionState: 'RESULT_READY',
      occurredAt: '2026-09-01T00:02:00.000Z',
      receivedAt: '2026-09-01T00:03:00.000Z',
    })).toBe(false)
    expect(store.acknowledgeResult('xgh_result_1', 'xgh_event_result_2', {
      resultId: 'xgh_result_1',
      eventId: 'xgh_event_result_2',
      verified: true,
      duplicate: false,
      executionState: 'FAILED',
      occurredAt: '2026-09-01T00:02:00.000Z',
      receivedAt: '2026-09-01T00:03:00.000Z',
    })).toBe(false)
    expect(store.pendingEvidence()).toHaveLength(2)
    expect(store.acknowledgeResult('xgh_result_1', 'xgh_event_result_2', {
      resultId: 'xgh_result_1',
      eventId: 'xgh_event_result_2',
      verified: true,
      duplicate: true,
      executionState: 'RESULT_READY',
      occurredAt: '2026-09-01T00:02:00.000Z',
      receivedAt: '2026-09-01T00:03:00.000Z',
    })).toBe(true)
    expect(store.pendingEvidence()).toHaveLength(1)
    expect(store.requireAssignment('xgh_assignment_1').assignment.executionState).toBe('RESULT_READY')
  })
})
