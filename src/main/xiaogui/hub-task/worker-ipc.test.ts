import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HubTaskWorkerServiceV1 } from './worker-service'
import { registerHubTaskWorkerHandlers } from './worker-ipc'

const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()

vi.mock('../../ipc/registry', () => ({
  registerHandler: vi.fn((channel: string, handler: (payload: unknown) => Promise<unknown>) => {
    handlers.set(channel, handler)
  }),
}))

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
}

function inboxEntry() {
  return {
    assignment: {
      assignmentId: 'xgh_assignment_1',
      taskId: 'xgh_task_1',
      decisionState: 'PENDING' as const,
      deliveryState: 'QUEUED' as const,
      executionState: 'NOT_STARTED' as const,
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    },
    offer: {
      taskId: 'xgh_task_1',
      mode: 'DIRECT' as const,
      title: '整理院内资料',
      taskContent: '先生成一份待批准计划。',
      constraints: ['不自动执行'],
      acceptanceRequirements: ['人工批准'],
      attachmentRefs: ['artifact:1'],
      packageSha256: `sha256:${'a'.repeat(64)}`,
    },
    openedAt: null,
    localDeliveryState: 'NOT_OPENED' as const,
    localPlanDraft: null,
  }
}

function service(): HubTaskWorkerServiceV1 {
  const entry = inboxEntry()
  return {
    connect: vi.fn(async () => ({ ok: true as const, value: { configured: true, state: 'READY' as const, lastSyncedAt: null, pendingReceiptCount: 0 } })),
    status: vi.fn(() => ({ configured: true, state: 'READY' as const, lastSyncedAt: null, pendingReceiptCount: 0 })),
    refresh: vi.fn(async () => ({ ok: true as const, value: { configured: true, state: 'READY' as const, lastSyncedAt: null, pendingReceiptCount: 0 } })),
    listInbox: vi.fn(() => [entry]),
    openAssignment: vi.fn(async () => ({ ok: true as const, value: entry })),
    decideAssignment: vi.fn(async () => ({ ok: true as const, value: entry })),
    returnAssignment: vi.fn(async () => ({ ok: true as const, value: entry })),
    createPlanDraft: vi.fn(async () => ({ ok: true as const, value: { flowId: 'xhbf_1', revisionId: 'xhbr_1' } })),
    listExecutionBindings: vi.fn(() => []),
    recordExecutionStarted: vi.fn(async () => undefined),
    reportDeliveryOutcome: vi.fn(async () => undefined),
    reportExecutionOutcome: vi.fn(async () => undefined),
    startPolling: vi.fn(),
    close: vi.fn(),
  }
}

afterEach(() => handlers.clear())

describe('HubTaskWorker IPC', () => {
  it('never returns credential, node, or local TaskHub identifiers to the Renderer', async () => {
    const worker = service()
    registerHubTaskWorkerHandlers(worker, `sha256:${'b'.repeat(64)}`)

    const list = await handlers.get('ipc:xiaogui.hubTask.inbox.list')!({})
    expect(list).toEqual({
      ok: true,
      value: [expect.objectContaining({ assignmentId: 'xgh_assignment_1', title: '整理院内资料', attachmentCount: 1 })],
    })
    const publicText = JSON.stringify(list)
    for (const forbidden of ['subjectId', 'nodeId', 'keyId', 'deviceToken', 'privateKeyPem', 'endpoint', 'flowId', 'revisionId', 'projectId', 'sessionKey']) {
      expect(publicText).not.toContain(forbidden)
    }
  })

  it('pairs only from explicitly supplied account input and creates a plan using the canonical session address', async () => {
    const worker = service()
    registerHubTaskWorkerHandlers(
      worker,
      `sha256:${'b'.repeat(64)}`,
      vi.fn(async () => ({ endpoint: 'http://hub.intranet:3000', accessToken: 'account-token-never-returned-to-renderer' })),
    )

    await expect(handlers.get('ipc:xiaogui.hubTask.connect')!({
      endpoint: 'http://hub.intranet:3000',
      username: 'planner.a',
      password: 'correct-horse-battery-staple',
    })).resolves.toMatchObject({ ok: true })
    expect(worker.connect).toHaveBeenCalledWith(expect.objectContaining({ installationIdDigest: `sha256:${'b'.repeat(64)}` }))

    await expect(handlers.get('ipc:xiaogui.hubTask.inbox.createPlanDraft')!({ assignmentId: 'xgh_assignment_1', address: ADDRESS }))
      .resolves.toEqual({ ok: true, value: { localPlanDraftCreated: true } })
    expect(worker.createPlanDraft).toHaveBeenCalledWith('xgh_assignment_1', ADDRESS)
  })

  it('rejects an untrusted input shape without calling the worker', async () => {
    const worker = service()
    registerHubTaskWorkerHandlers(worker, `sha256:${'b'.repeat(64)}`)

    await expect(handlers.get('ipc:xiaogui.hubTask.inbox.open')!({ assignmentId: 'xgh_assignment_1', privateKeyPem: 'forged' }))
      .resolves.toEqual({ ok: false, code: 'HUB_WORKER_INPUT_INVALID' })
    expect(worker.openAssignment).not.toHaveBeenCalled()
  })
})
