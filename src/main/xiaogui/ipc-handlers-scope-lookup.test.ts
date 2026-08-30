import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: Record<string, unknown>) => Promise<unknown>>(),
  lookup: vi.fn(),
  cwd: null as string | null,
  hasActiveTurns: false,
  phase: 'ASK' as 'ASK' | 'PLAN' | 'EXECUTE',
  stop: vi.fn(async () => {}),
  start: vi.fn(async () => ({})),
  setExecutionPhase: vi.fn((phase: 'ASK' | 'PLAN' | 'EXECUTE') => {
    mocks.phase = phase
    return phase
  }),
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
  workerManager: {
    get cwd() { return mocks.cwd },
    get hasActiveTurns() { return mocks.hasActiveTurns },
    stop: mocks.stop,
    start: mocks.start,
  },
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
    setExecutionPhase: mocks.setExecutionPhase,
    getExecutionPhase: vi.fn(() => mocks.phase),
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
    mocks.cwd = null
    mocks.hasActiveTurns = false
    mocks.phase = 'ASK'
    mocks.stop.mockReset().mockResolvedValue(undefined)
    mocks.start.mockReset().mockResolvedValue({})
    mocks.setExecutionPhase.mockClear()
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

  it('rejects phase switching before mutating global state while a Turn is active', async () => {
    mocks.cwd = 'C:\\workspace'
    mocks.hasActiveTurns = true

    await expect(
      mocks.handlers.get('ipc:xiaogui.phase.switch')!({ phase: 'EXECUTE' }),
    ).rejects.toThrow('XIAOGUI_PHASE_SWITCH_TURN_ACTIVE')

    expect(mocks.phase).toBe('ASK')
    expect(mocks.setExecutionPhase).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('fails and rolls phase back when the idle Worker cannot be rebuilt', async () => {
    mocks.cwd = 'C:\\workspace'
    mocks.start.mockRejectedValue(new Error('worker start failed'))

    await expect(
      mocks.handlers.get('ipc:xiaogui.phase.switch')!({ phase: 'EXECUTE' }),
    ).rejects.toThrow('XIAOGUI_PHASE_WORKER_REBUILD_FAILED')

    expect(mocks.phase).toBe('ASK')
    expect(mocks.setExecutionPhase.mock.calls.map(([phase]) => phase))
      .toEqual(['EXECUTE', 'ASK'])
  })
})
