import { describe, expect, it, vi } from 'vitest'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import {
  createHubTaskWorkerServiceV1,
  createInMemoryHubTaskWorkerCredentialsV1,
  type XiaoguiHubTaskWorkerPortV1,
} from './worker-service'
import {
  createHubTaskWorkerStateStoreV1,
  createInMemoryHubTaskWorkerStateStoreV1,
  type HubTaskWorkerStatePersistenceV1,
  type HubTaskWorkerStateV1,
  type HubTaskWorkerStateStoreV1,
} from './worker-state'
import { createHubTaskExecutionLifecycleCoordinatorV1 } from '../task-hub/hub-execution-lifecycle'

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
    submitResult: vi.fn(async (submission) => ({
      resultId: submission.result.resultId,
      eventId: submission.receipt.eventId,
      verified: true as const,
      duplicate: false,
      executionState: submission.result.outcome === 'RESULT_READY'
        ? 'RESULT_READY' as const
        : submission.result.outcome === 'EXECUTION_FAILED'
          ? 'FAILED' as const
          : 'OUTCOME_UNKNOWN' as const,
      occurredAt: submission.result.occurredAt,
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

function boundWorkerHarness() {
  const state = createInMemoryHubTaskWorkerStateStoreV1()
  const credentials = createInMemoryHubTaskWorkerCredentialsV1()
  const hubPort = port()
  const detail = {
    assignment: {
      assignmentId: 'xgh_assignment_terminal',
      taskId: 'xgh_task_terminal',
      decisionState: 'ACCEPTED' as const,
      deliveryState: 'OPENED' as const,
      executionState: 'NOT_STARTED' as const,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    offer: {
      taskId: 'xgh_task_terminal',
      mode: 'DIRECT' as const,
      title: '受控结果回传',
      taskContent: '执行本机任务并仅回传受控结果。',
      constraints: ['不得自动应用'],
      acceptanceRequirements: ['保留人工门'],
      attachmentRefs: [],
      packageSha256: PACKAGE_SHA256,
    },
  }
  state.upsertAssignment(detail)
  state.markOpened(detail.assignment.assignmentId, '2026-09-01T00:00:30.000Z')
  state.bindPlanDraft(detail.assignment.assignmentId, {
    ...ADDRESS,
    flowId: 'xhbf_terminal',
    revisionId: 'xhbr_terminal',
    createdAt: '2026-09-01T00:00:45.000Z',
  })
  credentials.write({
    endpoint: 'http://hub.intranet:3000',
    accessToken: 'hub-access-token-which-never-reaches-renderer',
    node: {
      subjectId: 'xgh_subject_1',
      nodeId: 'xgh_node_1',
      keyId: 'ed25519:test-key',
      deviceToken: 'node-token-never-reaches-renderer',
      privateKeyPem: 'PRIVATE',
    },
  })
  ;(hubPort.submitReceipt as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'OFFLINE' })
  ;(hubPort.submitResult as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'OFFLINE' })
  let id = 0
  const service = createHubTaskWorkerServiceV1({
    state,
    credentials,
    createPort: () => hubPort,
    application: { perform: vi.fn() },
    now: () => '2026-09-01T00:01:00.000Z',
    idFactory: (prefix) => `${prefix}_${++id}`,
    signReceipt: (unsigned) => ({
      ...unsigned,
      signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    }),
  })
  return { state, service }
}

describe('HubTaskWorkerServiceV1', () => {
  it.each([
    ['NOT_RUN', 'EXECUTION_FAILED', 'FAIL', '未进入受控验证阶段。'],
    ['FAIL', 'EXECUTION_FAILED', 'FAIL', '本机受控验证未通过。'],
    ['UNKNOWN', 'OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN', '本机受控执行结果暂时无法确认。'],
  ] as const)(
    'queues ordered start evidence and a controlled %s terminal result without Delivery',
    async (verificationState, eventType, verdict, summary) => {
      const { state, service } = boundWorkerHarness()

      expect(service.listExecutionBindings()).toEqual([{
        address: ADDRESS,
        flowId: 'xhbf_terminal',
      }])
      await service.recordExecutionStarted(ADDRESS, 'xhbf_terminal')
      await service.reportExecutionOutcome(ADDRESS, 'xhbf_terminal', { verificationState })

      expect(state.pendingEvidence()).toEqual([
        expect.objectContaining({
          kind: 'RECEIPT',
          receipt: expect.objectContaining({ eventType: 'EXECUTION_STARTED', sequence: 1 }),
        }),
        expect.objectContaining({
          kind: 'RESULT',
          submission: expect.objectContaining({
            result: expect.objectContaining({
              outcome: eventType,
              artifactRefs: [],
              verification: { verdict, summary },
            }),
            receipt: expect.objectContaining({ eventType, sequence: 2 }),
          }),
        }),
      ])
      service.close()
    },
  )

  it('rebuilds ordered start and result evidence from a persisted terminal Delivery during startup recovery', async () => {
    let persisted: HubTaskWorkerStateV1 | undefined
    const persistence: HubTaskWorkerStatePersistenceV1 = {
      read: () => persisted ? structuredClone(persisted) : undefined,
      write: (value) => { persisted = structuredClone(value) },
    }
    const beforeRestart = createHubTaskWorkerStateStoreV1(persistence)
    beforeRestart.upsertAssignment({
      assignment: {
        assignmentId: 'xgh_assignment_1',
        taskId: 'xgh_task_1',
        decisionState: 'ACCEPTED',
        deliveryState: 'OPENED',
        executionState: 'NOT_STARTED',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:01:00.000Z',
      },
      offer: {
        taskId: 'xgh_task_1',
        mode: 'DIRECT',
        title: '整理院内任务',
        taskContent: '请先生成一份待人工确认的任务计划。',
        constraints: ['不要自动执行'],
        acceptanceRequirements: ['用户确认计划后再执行'],
        attachmentRefs: [],
        packageSha256: PACKAGE_SHA256,
      },
    })
    beforeRestart.markOpened('xgh_assignment_1', '2026-09-01T00:00:30.000Z')
    beforeRestart.bindPlanDraft('xgh_assignment_1', {
      ...ADDRESS,
      flowId: 'xhbf_1',
      revisionId: 'xhbr_1',
      createdAt: '2026-09-01T00:00:45.000Z',
    })

    const restartedState = createHubTaskWorkerStateStoreV1(persistence)
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    credentials.write({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'hub-access-token-which-never-reaches-renderer',
      node: {
        subjectId: 'xgh_subject_1',
        nodeId: 'xgh_node_1',
        keyId: 'ed25519:test-key',
        deviceToken: 'node-token-never-reaches-renderer',
        privateKeyPem: 'PRIVATE',
      },
    })
    const hubPort = port()
    ;(hubPort.submitReceipt as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'OFFLINE' })
    ;(hubPort.submitResult as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'OFFLINE' })
    const readDelivery = vi.fn(() => ({
      state: 'READY_FOR_REVIEW',
      flowId: 'xhbf_1',
      deliveryChangeSetId: 'xhbdcs_1',
      deliveryChangeSetDigest: `sha256:${'d'.repeat(64)}`,
    } as never))
    let id = 0
    const restarted = createHubTaskWorkerServiceV1({
      state: restartedState,
      credentials,
      createPort: () => hubPort,
      application: { perform: vi.fn() },
      now: () => '2026-09-01T00:02:00.000Z',
      idFactory: (prefix) => `${prefix}_${++id}`,
      signReceipt: (unsigned) => ({
        ...unsigned,
        signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }),
    })
    const lifecycle = createHubTaskExecutionLifecycleCoordinatorV1({
      application: {
        observeM2B: vi.fn(async () => ({
          ok: true as const,
          value: {
            activeFlow: { flowId: 'xhbf_1' },
            taskRuns: [{ taskRunId: 'xhbtr_1', attemptId: 'xhba_1', status: 'RUNNING' }],
            attempts: [{ attemptId: 'xhba_1', taskRunId: 'xhbtr_1', status: 'RUNNING' }],
          } as never,
        })),
      },
      taskExecution: { recover: vi.fn(async () => undefined) },
      delivery: {
        recover: vi.fn(async () => undefined),
        readLatestDelivery: readDelivery,
      },
      evidence: restarted,
    })

    await lifecycle.recover()

    expect(readDelivery).toHaveBeenCalledWith(ADDRESS, 'xhbf_1')
    expect(restartedState.pendingEvidence()).toEqual([
      expect.objectContaining({
        kind: 'RECEIPT',
        receipt: expect.objectContaining({ eventType: 'EXECUTION_STARTED', sequence: 1 }),
      }),
      expect.objectContaining({
        kind: 'RESULT',
        submission: expect.objectContaining({
          result: expect.objectContaining({ outcome: 'RESULT_READY' }),
          receipt: expect.objectContaining({ eventType: 'RESULT_READY', sequence: 2 }),
        }),
      }),
    ])
    restarted.close()
  })

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

  it('queues execution start before a controlled Delivery result, then uploads both in signed sequence order', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    const hubPort = port()
    const detail = {
      assignment: {
        assignmentId: 'xgh_assignment_1',
        taskId: 'xgh_task_1',
        decisionState: 'ACCEPTED' as const,
        deliveryState: 'OPENED' as const,
        executionState: 'NOT_STARTED' as const,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
      offer: {
        taskId: 'xgh_task_1',
        mode: 'DIRECT' as const,
        title: '整理院内任务',
        taskContent: '请先生成一份待人工确认的任务计划。',
        constraints: ['不要自动执行'],
        acceptanceRequirements: ['用户确认计划后再执行'],
        attachmentRefs: [],
        packageSha256: PACKAGE_SHA256,
      },
    }
    state.upsertAssignment(detail)
    state.markOpened('xgh_assignment_1', '2026-09-01T00:00:00.000Z')
    state.bindPlanDraft('xgh_assignment_1', {
      ...ADDRESS,
      flowId: 'xhbf_1',
      revisionId: 'xhbr_1',
      createdAt: '2026-09-01T00:00:00.000Z',
    })
    credentials.write({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'hub-access-token-which-never-reaches-renderer',
      node: {
        subjectId: 'xgh_subject_1',
        nodeId: 'xgh_node_1',
        keyId: 'ed25519:test-key',
        deviceToken: 'node-token-never-reaches-renderer',
        privateKeyPem: 'PRIVATE',
      },
    })
    ;(hubPort.submitReceipt as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'OFFLINE' })
    let id = 0
    const service = createHubTaskWorkerServiceV1({
      state,
      credentials,
      createPort: () => hubPort,
      application: { perform: vi.fn() },
      now: () => '2026-09-01T00:01:00.000Z',
      idFactory: (prefix) => `${prefix}_${++id}`,
      signReceipt: (unsigned) => ({
        ...unsigned,
        signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }),
    })

    await service.recordExecutionStarted(ADDRESS, 'xhbf_1')
    await service.reportDeliveryOutcome(ADDRESS, {
      state: 'READY_FOR_REVIEW',
      flowId: 'xhbf_1',
      deliveryChangeSetId: 'xhbdcs_1',
      deliveryChangeSetDigest: `sha256:${'d'.repeat(64)}`,
    } as never)

    expect(state.pendingEvidence().map((entry) => entry.kind === 'RECEIPT'
      ? [entry.kind, entry.receipt.eventType, entry.receipt.sequence]
      : [entry.kind, entry.submission.result.outcome, entry.submission.receipt.sequence],
    )).toEqual([
      ['RECEIPT', 'EXECUTION_STARTED', 1],
      ['RESULT', 'RESULT_READY', 2],
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))
    ;(hubPort.submitReceipt as ReturnType<typeof vi.fn>).mockImplementation(async (receipt) => ({
      receiptId: `xgh_receipt_${receipt.eventId}`,
      eventId: receipt.eventId,
      verified: true as const,
      duplicate: false,
      occurredAt: receipt.occurredAt,
      receivedAt: '2026-09-01T00:02:00.000Z',
    }))
    ;(hubPort.pollAssignments as ReturnType<typeof vi.fn>).mockResolvedValue({
      cursor: 'snapshot-1',
      assignments: [{ ...detail.assignment, executionState: 'RESULT_READY' as const }],
    })
    ;(hubPort.downloadAssignment as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...detail,
      assignment: { ...detail.assignment, executionState: 'RESULT_READY' as const },
    })

    await expect(service.refresh()).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({ state: 'READY', pendingReceiptCount: 0 }),
    })
    expect(hubPort.submitReceipt).toHaveBeenLastCalledWith(expect.objectContaining({
      eventType: 'EXECUTION_STARTED',
      resultSha256: null,
      sequence: 1,
    }))
    expect(hubPort.submitResult).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ outcome: 'RESULT_READY' }),
      receipt: expect.objectContaining({ eventType: 'RESULT_READY', sequence: 2 }),
    }))
    expect(state.pendingEvidence()).toEqual([])
    expect(state.requireAssignment('xgh_assignment_1').assignment.executionState).toBe('RESULT_READY')
    service.close()
  })

})
