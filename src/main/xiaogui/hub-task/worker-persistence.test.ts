import { describe, expect, it } from 'vitest'

import { createHubTaskWorkerStateStoreV1 } from './worker-state'
import { createHubTaskWorkerStatePersistenceV1 } from './worker-persistence'

const PACKAGE_SHA256 = `sha256:${'a'.repeat(64)}`

describe('HubTaskWorkerStatePersistenceV1', () => {
  it('persists the main-process inbox mirror without using a credential backing', () => {
    const values = new Map<string, unknown>()
    const persistence = createHubTaskWorkerStatePersistenceV1({
      get: (key) => values.get(key),
      set: (key, value) => values.set(key, value),
    })
    const first = createHubTaskWorkerStateStoreV1(persistence)
    first.upsertAssignment({
      assignment: {
        assignmentId: 'xgh_assignment_1',
        taskId: 'xgh_task_1',
        decisionState: 'PENDING',
        deliveryState: 'QUEUED',
        executionState: 'NOT_STARTED',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
      offer: {
        taskId: 'xgh_task_1',
        mode: 'DIRECT',
        title: '整理院内资料',
        taskContent: '先生成待批准的本机计划。',
        constraints: [],
        acceptanceRequirements: [],
        attachmentRefs: [],
        packageSha256: PACKAGE_SHA256,
      },
    })

    const restarted = createHubTaskWorkerStateStoreV1(persistence)
    expect(restarted.listAssignments()).toEqual([
      expect.objectContaining({ offer: expect.objectContaining({ title: '整理院内资料' }) }),
    ])
    expect(JSON.stringify(values.get('state'))).not.toContain('privateKeyPem')
    expect(JSON.stringify(values.get('state'))).not.toContain('deviceToken')
    expect(restarted.snapshot().results).toEqual({})
  })

  it('fails closed to an empty state when an on-disk state object is malformed', () => {
    const persistence = createHubTaskWorkerStatePersistenceV1({
      get: () => ({ version: 1, assignments: 'not-a-map', receipts: {}, lastReceiptSequence: 0, cursor: null }),
      set: () => undefined,
    })

    expect(createHubTaskWorkerStateStoreV1(persistence).listAssignments()).toEqual([])
  })

  it('fails closed when a top-level-valid state contains malformed nested task or receipt data', () => {
    const persistence = createHubTaskWorkerStatePersistenceV1({
      get: () => ({
        version: 1,
        assignments: {
          xgh_assignment_1: {
            assignment: { assignmentId: 'xgh_assignment_1' },
            offer: 'not-an-offer',
          },
        },
        receipts: {
          xgh_event_1: { receipt: 'not-a-receipt', queuedAt: 'not-a-timestamp' },
        },
        lastReceiptSequence: 1,
        cursor: null,
      }),
      set: () => undefined,
    })

    const restored = createHubTaskWorkerStateStoreV1(persistence)
    expect(restored.listAssignments()).toEqual([])
    expect(restored.pendingReceipts()).toEqual([])
    expect(restored.snapshot().lastReceiptSequence).toBe(0)
  })
})
