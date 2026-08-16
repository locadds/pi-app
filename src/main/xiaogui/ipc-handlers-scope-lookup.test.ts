import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: Record<string, unknown>) => Promise<unknown>>(),
  lookup: vi.fn(),
}))

vi.mock('../ipc/registry', () => ({
  registerHandler: (
    channel: string,
    handler: (request: Record<string, unknown>) => Promise<unknown>,
  ) => mocks.handlers.set(channel, handler),
  registerHandlerWithSchema: (
    channel: string,
    schema: { safeParse: (value: unknown) => { success: boolean; data?: Record<string, unknown> } },
    handler: (request: Record<string, unknown>) => Promise<unknown>,
  ) => mocks.handlers.set(channel, async (request) => {
    const parsed = schema.safeParse(request)
    if (!parsed.success) throw new Error('invalid input')
    return handler(parsed.data!)
  }),
}))

vi.mock('../worker-manager', () => ({
  workerManager: { cwd: null, hasActiveTurns: false },
}))
vi.mock('../config-store', () => ({ configStore: { get: vi.fn() } }))
vi.mock('./scope-service', () => ({
  sessionScopeResolverV1: { lookup: mocks.lookup },
}))
vi.mock('./scope-store', () => ({
  getProjectBaseline: vi.fn(() => []),
  getScope: vi.fn(),
  listScopes: vi.fn(() => ({ mode: 'WORK', sessionModeMap: {}, projectModeMap: {} })),
  recordProjectBaseline: vi.fn(),
  setScope: vi.fn(),
}))
vi.mock('./sidecar-bridge', () => ({
  xiaogui: {
    setMode: vi.fn(),
    getMode: vi.fn(() => 'WORK'),
    setExecutionPhase: vi.fn(),
    getExecutionPhase: vi.fn(() => 'ASK'),
    invokeTool: vi.fn(),
    status: vi.fn(),
  },
}))
vi.mock('./guard-status', () => ({ readGuardStatus: vi.fn() }))
vi.mock('./design-extension-deploy', () => ({ ensureDesignExtensionDeployed: vi.fn() }))

import { registerXiaoguiHandlers } from './ipc-handlers'

describe('xiaogui canonical scope lookup IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.lookup.mockReset()
    registerXiaoguiHandlers()
  })

  it('passes only opaque ids to the read-only resolver lookup', async () => {
    const address = {
      projectId: `xgp1_${'a'.repeat(64)}`,
      sessionKey: `xgs1_${'b'.repeat(64)}`,
    }
    mocks.lookup.mockResolvedValue({ kind: 'FOUND', scope: { ...address, sessionMode: 'WORK' } })

    await expect(
      mocks.handlers.get('ipc:xiaogui.scope.lookup')!(address),
    ).resolves.toEqual({ kind: 'FOUND', scope: { ...address, sessionMode: 'WORK' } })
    expect(mocks.lookup).toHaveBeenCalledWith(address)
  })

  it('rejects path-like or malformed identities before lookup', async () => {
    await expect(
      mocks.handlers.get('ipc:xiaogui.scope.lookup')!({
        projectId: 'D:/private/project',
        sessionKey: 'D:/private/session.jsonl',
      }),
    ).rejects.toThrow('invalid input')
    expect(mocks.lookup).not.toHaveBeenCalled()
  })
})
