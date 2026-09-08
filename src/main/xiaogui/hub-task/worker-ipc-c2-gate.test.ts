import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HubTaskWorkerServiceV1 } from './worker-service'
import { registerHubTaskWorkerHandlers } from './worker-ipc'

const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
vi.mock('../../ipc/registry', () => ({
  registerHandler: vi.fn((channel: string, handler: (payload: unknown) => Promise<unknown>) => handlers.set(channel, handler)),
}))

afterEach(() => handlers.clear())

describe('H1 Hub IPC bridge', () => {
  it('keeps login explicit and exposes only validated inbox actions', async () => {
    const service = {
      status: vi.fn(() => ({ configured: false, state: 'UNCONFIGURED', lastSyncedAt: null, pendingReceiptCount: 0 })),
      connect: vi.fn(async () => ({ ok: true as const, value: { configured: true, state: 'READY' as const, lastSyncedAt: null, pendingReceiptCount: 0 } })),
      refresh: vi.fn(),
      listInbox: vi.fn(() => []),
      openAssignment: vi.fn(),
      decideAssignment: vi.fn(),
      returnAssignment: vi.fn(),
      createPlanDraft: vi.fn(),
    } as unknown as HubTaskWorkerServiceV1
    registerHubTaskWorkerHandlers(
      service,
      `sha256:${'a'.repeat(64)}`,
      vi.fn(async () => ({ endpoint: 'http://hub.intranet:3000', accessToken: 'a'.repeat(20) })),
    )

    expect([...handlers.keys()].sort()).toEqual([
      'ipc:xiaogui.hubTask.connect',
      'ipc:xiaogui.hubTask.inbox.createPlanDraft',
      'ipc:xiaogui.hubTask.inbox.decision',
      'ipc:xiaogui.hubTask.inbox.list',
      'ipc:xiaogui.hubTask.inbox.open',
      'ipc:xiaogui.hubTask.inbox.return',
      'ipc:xiaogui.hubTask.refresh',
      'ipc:xiaogui.hubTask.status',
    ])
    await expect(handlers.get('ipc:xiaogui.hubTask.connect')!({ endpoint: 'invalid' })).resolves.toEqual({
      ok: false, code: 'HUB_WORKER_INPUT_INVALID',
    })
    expect(service.connect).not.toHaveBeenCalled()
    await expect(handlers.get('ipc:xiaogui.hubTask.connect')!({
      endpoint: 'http://hub.intranet:3000', username: 'planner', password: 'password-123',
    })).resolves.toMatchObject({ ok: true })
    expect(service.connect).toHaveBeenCalledWith(expect.objectContaining({ installationIdDigest: `sha256:${'a'.repeat(64)}` }))
  })
})
