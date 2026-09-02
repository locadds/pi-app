import { describe, expect, it } from 'vitest'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import type { XiaoguiTaskDeliveryReceiptV1 } from '@shared/xiaogui-hub-task-contract'
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

    expect(store.acknowledgeReceipt({
      receiptId: 'xgh_receipt_wrong',
      eventId: 'xgh_event_wrong',
      verified: true,
      duplicate: false,
      occurredAt: '2026-09-01T00:00:00.000Z',
      receivedAt: '2026-09-01T00:02:00.000Z',
    })).toBe(false)
    expect(store.pendingReceipts()).toHaveLength(1)

    expect(store.acknowledgeReceipt({
      receiptId: 'xgh_receipt_1',
      eventId: 'xgh_event_1',
      verified: true,
      duplicate: true,
      occurredAt: '2026-09-01T00:00:00.000Z',
      receivedAt: '2026-09-01T00:02:00.000Z',
    })).toBe(true)
    expect(store.pendingReceipts()).toEqual([])
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
})
