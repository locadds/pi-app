import { describe, expect, it, vi } from 'vitest'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import {
  createHubTaskWorkerServiceV1,
  createInMemoryHubTaskWorkerCredentialsV1,
  type XiaoguiHubTaskWorkerPortV1,
} from './worker-service'
import {
  createInMemoryHubTaskWorkerStateStoreV1,
  type HubTaskWorkerStateStoreV1,
} from './worker-state'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as HubAddressV1
const PACKAGE_SHA256 = `sha256:${'a'.repeat(64)}`

function port(): XiaoguiHubTaskWorkerPortV1 {
  return {
    pairOrReplaceNode: vi.fn(async () => ({
      binding: {
        nodeId: 'xgh_node_1',
        subjectId: 'xgh_subject_1',
        installationIdDigest: `sha256:${'b'.repeat(64)}`,
        keyId: 'ed25519:test-key',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
        publicKeyDigest: `sha256:${'c'.repeat(64)}`,
        state: 'ACTIVE' as const,
        pairedAt: '2026-09-01T00:00:00.000Z',
        revokedAt: null,
        lastSeenAt: '2026-09-01T00:00:00.000Z',
      },
      deviceToken: 'device-token-which-never-reaches-renderer',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
    })),
    pollAssignments: vi.fn(async () => ({
      cursor: 'snapshot-1',
      assignments: [{
        assignmentId: 'xgh_assignment_1',
        taskId: 'xgh_task_1',
        decisionState: 'PENDING' as const,
        deliveryState: 'QUEUED' as const,
        executionState: 'NOT_STARTED' as const,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      }],
    })),
    downloadAssignment: vi.fn(async () => ({
      assignment: {
        assignmentId: 'xgh_assignment_1',
        taskId: 'xgh_task_1',
        decisionState: 'PENDING' as const,
        deliveryState: 'QUEUED' as const,
        executionState: 'NOT_STARTED' as const,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
      offer: {
        taskId: 'xgh_task_1',
        mode: 'DIRECT' as const,
        title: '整理院内任务',
        taskContent: '请先生成一个待人工确认的任务计划。',
        constraints: ['不要自动执行'],
        acceptanceRequirements: ['用户确认计划后再执行'],
        attachmentRefs: [],
        packageSha256: PACKAGE_SHA256,
      },
    })),
    submitDecision: vi.fn(async () => ({
      assignment: {
        assignmentId: 'xgh_assignment_1',
        taskId: 'xgh_task_1',
        decisionState: 'ACCEPTED' as const,
        deliveryState: 'QUEUED' as const,
        executionState: 'NOT_STARTED' as const,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:02:00.000Z',
      },
      offer: {
        taskId: 'xgh_task_1',
        mode: 'DIRECT' as const,
        title: '整理院内任务',
        taskContent: '请先生成一个待人工确认的任务计划。',
        constraints: ['不要自动执行'],
        acceptanceRequirements: ['用户确认计划后再执行'],
        attachmentRefs: [],
        packageSha256: PACKAGE_SHA256,
      },
    })),
    returnAssignment: vi.fn(async () => ({
      assignment: {
        assignmentId: 'xgh_assignment_1',
        taskId: 'xgh_task_1',
        decisionState: 'RETURNED' as const,
        deliveryState: 'QUEUED' as const,
        executionState: 'NOT_STARTED' as const,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:03:00.000Z',
      },
      offer: {
        taskId: 'xgh_task_1',
        mode: 'POOL' as const,
        title: '整理院内任务',
        taskContent: '请先生成一个待人工确认的任务计划。',
        constraints: ['不要自动执行'],
        acceptanceRequirements: ['用户确认计划后再执行'],
        attachmentRefs: [],
        packageSha256: PACKAGE_SHA256,
      },
    })),
    claimOffer: vi.fn(async () => ({ assignment: {} as never, offer: {} as never })),
    submitReceipt: vi.fn(async (receipt) => ({
      receiptId: `xgh_receipt_${receipt.eventId}`,
      eventId: receipt.eventId,
      verified: true as const,
      duplicate: false,
      occurredAt: receipt.occurredAt,
      receivedAt: '2026-09-01T00:02:00.000Z',
    })),
  }
}

function queueOpenedReceipt(state: HubTaskWorkerStateStoreV1, sequence = 2): void {
  state.markOpened('xgh_assignment_1', '2026-09-01T00:01:00.000Z')
  state.enqueueReceipt({
    schemaVersion: 'xiaogui.task-receipt.v1',
    eventId: `xgh_event_opened_${sequence}`,
    assignmentId: 'xgh_assignment_1',
    taskId: 'xgh_task_1',
    subjectId: 'xgh_subject_1',
    nodeId: 'xgh_node_1',
    keyId: 'ed25519:test-key',
    eventType: 'USER_OPENED',
    packageSha256: PACKAGE_SHA256,
    occurredAt: '2026-09-01T00:01:00.000Z',
    sequence,
    resultSha256: null,
    signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  }, '2026-09-01T00:01:00.000Z')
}

function receiptAck(eventId: string, duplicate = false) {
  return {
    receiptId: `xgh_receipt_${eventId}`,
    eventId,
    verified: true as const,
    duplicate,
    occurredAt: '2026-09-01T00:01:00.000Z',
    receivedAt: '2026-09-01T00:02:00.000Z',
  }
}

describe('HubTaskWorkerServiceV1', () => {
  it('requires a locally opened assignment before a decision or local plan draft can be created', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    const hubPort = port()
    const service = createHubTaskWorkerServiceV1({
      state,
      credentials,
      createPort: () => hubPort,
      application: { perform: vi.fn() },
      now: () => '2026-09-01T00:01:00.000Z',
    })

    await service.connect({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'hub-access-token-which-never-reaches-renderer',
      installationIdDigest: `sha256:${'b'.repeat(64)}`,
    })

    await expect(service.decideAssignment('xgh_assignment_1', 'ACCEPT'))
      .resolves.toEqual({ ok: false, code: 'HUB_ASSIGNMENT_NOT_READY' })
    await expect(service.createPlanDraft('xgh_assignment_1', ADDRESS))
      .resolves.toEqual({ ok: false, code: 'HUB_ASSIGNMENT_NOT_READY' })
    expect(hubPort.submitDecision).not.toHaveBeenCalled()
    service.close()
  })

  it('checks safe local credential persistence before replacing the active Hub node', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    const credentials = createInMemoryHubTaskWorkerCredentialsV1({ canPersist: false })
    const hubPort = port()
    const service = createHubTaskWorkerServiceV1({
      state,
      credentials,
      createPort: () => hubPort,
      application: { perform: vi.fn() },
    })

    await expect(service.connect({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'hub-access-token-which-never-reaches-renderer',
      installationIdDigest: `sha256:${'b'.repeat(64)}`,
    })).resolves.toEqual({ ok: false, code: 'HUB_WORKER_CREDENTIAL_STORAGE_UNAVAILABLE' })

    expect(hubPort.pairOrReplaceNode).not.toHaveBeenCalled()
    expect(credentials.snapshot()).toBeNull()
    service.close()
  })

  it('keeps a first-time connection unconfigured when pairing is only temporarily unavailable', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    const hubPort = port()
    ;(hubPort.pairOrReplaceNode as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'OFFLINE' })
    const service = createHubTaskWorkerServiceV1({
      state,
      credentials,
      createPort: () => hubPort,
      application: { perform: vi.fn() },
    })

    await expect(service.connect({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'hub-access-token-which-never-reaches-renderer',
      installationIdDigest: `sha256:${'b'.repeat(64)}`,
    })).resolves.toEqual({ ok: false, code: 'HUB_WORKER_CONNECTION_FAILED' })

    expect(service.status()).toEqual(expect.objectContaining({ configured: false, state: 'OFFLINE' }))
    expect(credentials.snapshot()).toBeNull()
    service.close()
  })

  it('keeps locally signed evidence while offline and still creates only an awaiting-approval draft', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    const hubPort = port()
    ;(hubPort.submitReceipt as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'OFFLINE' })
    const application = {
      perform: vi.fn(async () => ({
        ok: true as const,
        value: {
          requestId: 'hub-assignment:xgh_assignment_1',
          intentType: 'flow.start.with_draft' as const,
          sessionVersion: 0,
          flowId: 'xhbf_1' as never,
          revisionId: 'xhbr_1' as never,
        },
      })),
    }
    let generatedId = 0
    const service = createHubTaskWorkerServiceV1({
      state,
      credentials,
      createPort: () => hubPort,
      application,
      now: () => '2026-09-01T00:01:00.000Z',
      idFactory: (prefix) => `${prefix}_${++generatedId}`,
      signReceipt: (unsigned) => ({
        ...unsigned,
        signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }),
    })

    await service.connect({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'hub-access-token-which-never-reaches-renderer',
      installationIdDigest: `sha256:${'b'.repeat(64)}`,
    })
    expect(state.listAssignments()).toHaveLength(1)
    const refreshed = await service.refresh()
    const opened = await service.openAssignment('xgh_assignment_1')
    const decided = await service.decideAssignment('xgh_assignment_1', 'ACCEPT')
    const drafted = await service.createPlanDraft('xgh_assignment_1', ADDRESS)

    expect(refreshed).toEqual({ ok: false, code: 'HUB_WORKER_CONNECTION_FAILED' })
    expect(opened.ok).toBe(true)
    expect(decided.ok).toBe(true)
    expect(drafted).toEqual({ ok: true, value: { flowId: 'xhbf_1', revisionId: 'xhbr_1' } })
    expect(application.perform).toHaveBeenCalledWith(ADDRESS, expect.objectContaining({
      requestId: 'hub-assignment:xgh_assignment_1',
      intent: expect.objectContaining({ type: 'flow.start.with_draft' }),
    }))
    expect(application.perform).not.toHaveBeenCalledWith(ADDRESS, expect.objectContaining({
      intent: expect.objectContaining({ type: 'plan.revision.submit' }),
    }))
    expect(state.requireAssignment('xgh_assignment_1')).toEqual(expect.objectContaining({
      openedAt: '2026-09-01T00:01:00.000Z',
      localDeliveryState: 'PENDING_H1_4_RECEIPT',
      localPlanDraft: expect.objectContaining({ flowId: 'xhbf_1' }),
    }))
    expect(state.pendingReceipts()).toHaveLength(3)
    service.close()
  })

  it('retries a durable open receipt in sequence and adopts the Hub delivery snapshot after a verified ACK', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    const hubPort = port()
    const service = createHubTaskWorkerServiceV1({
      state,
      credentials,
      createPort: () => hubPort,
      application: { perform: vi.fn() },
    })

    await service.connect({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'hub-access-token-which-never-reaches-renderer',
      installationIdDigest: `sha256:${'b'.repeat(64)}`,
    })
    queueOpenedReceipt(state)
    ;(hubPort.submitReceipt as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'OFFLINE' })

    await expect(service.refresh()).resolves.toEqual({ ok: false, code: 'HUB_WORKER_CONNECTION_FAILED' })
    expect(state.pendingReceipts()).toHaveLength(1)
    expect(credentials.snapshot()).not.toBeNull()

    ;(hubPort.submitReceipt as ReturnType<typeof vi.fn>).mockImplementation(async (value) => receiptAck(value.eventId, true))
    ;(hubPort.pollAssignments as ReturnType<typeof vi.fn>).mockResolvedValue({
      cursor: 'snapshot-2',
      assignments: [{
        assignmentId: 'xgh_assignment_1',
        taskId: 'xgh_task_1',
        decisionState: 'PENDING',
        deliveryState: 'OPENED',
        executionState: 'NOT_STARTED',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:03:00.000Z',
      }],
    })
    ;(hubPort.downloadAssignment as ReturnType<typeof vi.fn>).mockResolvedValue({
      assignment: {
        assignmentId: 'xgh_assignment_1',
        taskId: 'xgh_task_1',
        decisionState: 'PENDING',
        deliveryState: 'OPENED',
        executionState: 'NOT_STARTED',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:03:00.000Z',
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
    })

    await expect(service.refresh()).resolves.toEqual({ ok: true, value: expect.objectContaining({ state: 'READY', pendingReceiptCount: 0 }) })
    expect(state.pendingReceipts()).toEqual([])
    expect(state.requireAssignment('xgh_assignment_1')).toEqual(expect.objectContaining({
      localDeliveryState: 'HUB_CONFIRMED',
      assignment: expect.objectContaining({ deliveryState: 'OPENED' }),
    }))
    service.close()
  })

  it('fails closed when the Hub ACK identifies a later pending receipt', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    const hubPort = port()
    const service = createHubTaskWorkerServiceV1({
      state,
      credentials,
      createPort: () => hubPort,
      application: { perform: vi.fn() },
    })

    await service.connect({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'hub-access-token-which-never-reaches-renderer',
      installationIdDigest: `sha256:${'b'.repeat(64)}`,
    })
    queueOpenedReceipt(state, 2)
    queueOpenedReceipt(state, 3)
    ;(hubPort.submitReceipt as ReturnType<typeof vi.fn>).mockClear()
    ;(hubPort.submitReceipt as ReturnType<typeof vi.fn>).mockImplementation(async () => receiptAck('xgh_event_opened_3'))

    await expect(service.refresh()).resolves.toEqual({ ok: false, code: 'HUB_WORKER_CONNECTION_FAILED' })
    expect(hubPort.submitReceipt).toHaveBeenCalledTimes(1)
    expect(hubPort.submitReceipt).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'xgh_event_opened_2',
      sequence: 2,
    }))
    expect(state.pendingReceipts().map((entry) => entry.receipt.eventId)).toEqual([
      'xgh_event_opened_2',
      'xgh_event_opened_3',
    ])
    expect(credentials.snapshot()).not.toBeNull()
    service.close()
  })

  it.each([
    ['STATE_CONFLICT', 'HUB_WORKER_STATE_CONFLICT', true],
    ['NODE_REVOKED', 'HUB_WORKER_NODE_REVOKED', false],
  ] as const)(
    'keeps or clears queued receipts according to a %s receipt response',
    async (failureCode, expectedCode, keepLocalState) => {
      const state = createInMemoryHubTaskWorkerStateStoreV1()
      const credentials = createInMemoryHubTaskWorkerCredentialsV1()
      const hubPort = port()
      const service = createHubTaskWorkerServiceV1({
        state,
        credentials,
        createPort: () => hubPort,
        application: { perform: vi.fn() },
      })

      await service.connect({
        endpoint: 'http://hub.intranet:3000',
        accessToken: 'hub-access-token-which-never-reaches-renderer',
        installationIdDigest: `sha256:${'b'.repeat(64)}`,
      })
      queueOpenedReceipt(state)
      ;(hubPort.submitReceipt as ReturnType<typeof vi.fn>).mockRejectedValue({ code: failureCode })

      await expect(service.refresh()).resolves.toEqual({ ok: false, code: expectedCode })
      expect(credentials.snapshot() !== null).toBe(keepLocalState)
      expect(state.pendingReceipts().length > 0).toBe(keepLocalState)
      expect(service.listInbox().length > 0).toBe(keepLocalState)
      expect(service.status().state).toBe(keepLocalState ? 'READY' : 'NODE_REVOKED')
      service.close()
    },
  )

  it.each(['NODE_REVOKED', 'AUTHENTICATION_FAILED'] as const)(
    'locks cached task content when the Worker becomes %s',
    async (failureCode) => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    const hubPort = port()
    const service = createHubTaskWorkerServiceV1({
      state,
      credentials,
      createPort: () => hubPort,
      application: { perform: vi.fn() },
      now: () => '2026-09-01T00:01:00.000Z',
      signReceipt: (unsigned) => ({
        ...unsigned,
        signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }),
    })

    await service.connect({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'hub-access-token-which-never-reaches-renderer',
      installationIdDigest: `sha256:${'b'.repeat(64)}`,
    })
    expect(state.listAssignments()).toHaveLength(1)

    ;(hubPort.pollAssignments as ReturnType<typeof vi.fn>).mockRejectedValue({ code: failureCode })
    await expect(service.refresh()).resolves.toEqual({
      ok: false,
      code: failureCode === 'NODE_REVOKED' ? 'HUB_WORKER_NODE_REVOKED' : 'HUB_WORKER_AUTHENTICATION_FAILED',
    })

    expect(service.status()).toEqual(expect.objectContaining({
      configured: false,
      state: failureCode,
    }))
    expect(credentials.snapshot()).toBeNull()
    expect(service.listInbox()).toEqual([])
    await expect(service.openAssignment('xgh_assignment_1')).resolves.toEqual({
      ok: false,
      code: failureCode === 'NODE_REVOKED' ? 'HUB_WORKER_NODE_REVOKED' : 'HUB_WORKER_AUTHENTICATION_FAILED',
    })
    await expect(service.createPlanDraft('xgh_assignment_1', ADDRESS)).resolves.toEqual({
      ok: false,
      code: failureCode === 'NODE_REVOKED' ? 'HUB_WORKER_NODE_REVOKED' : 'HUB_WORKER_AUTHENTICATION_FAILED',
    })
    service.close()
    },
  )

  it('keeps credentials and cached work when a reachable Hub reports a task-state conflict', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    const hubPort = port()
    const service = createHubTaskWorkerServiceV1({
      state,
      credentials,
      createPort: () => hubPort,
      application: { perform: vi.fn() },
    })

    await service.connect({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'hub-access-token-which-never-reaches-renderer',
      installationIdDigest: `sha256:${'b'.repeat(64)}`,
    })
    expect(state.listAssignments()).toHaveLength(1)

    ;(hubPort.pollAssignments as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'STATE_CONFLICT' })
    await expect(service.refresh()).resolves.toEqual({ ok: false, code: 'HUB_WORKER_STATE_CONFLICT' })

    expect(service.status()).toEqual(expect.objectContaining({ configured: true, state: 'READY' }))
    expect(credentials.snapshot()).not.toBeNull()
    expect(service.listInbox()).toHaveLength(1)
    service.close()
  })
})
