import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: Record<string, unknown>) => Promise<unknown>>(),
  lookup: vi.fn(),
  cwd: null as string | null,
  hasActiveTurns: false,
  directConfirmationPending: false,
  extensionUiDialogSource: new Map<string, unknown>(),
  mode: 'WORK' as 'WORK' | 'DESIGN' | 'CODING',
  phase: 'ASK' as 'ASK' | 'PLAN' | 'EXECUTE',
  stop: vi.fn(async () => {}),
  start: vi.fn(async () => ({})),
  getEffectivePromptManifest: vi.fn(async () => ({
    manifest: {
      mode: mocks.mode,
      capabilityIds: mocks.mode === 'CODING' ? ['coding.workspace'] : ['work.file-organize'],
      toolNames: mocks.mode === 'CODING' ? ['read', 'write'] : ['read', 'xiaogui_read_pdf'],
    },
  })),
  setExecutionPhase: vi.fn((phase: 'ASK' | 'PLAN' | 'EXECUTE') => {
    mocks.phase = phase
    return phase
  }),
  setMode: vi.fn((mode: 'WORK' | 'DESIGN' | 'CODING') => {
    mocks.mode = mode
    return mode
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
    getEffectivePromptManifest: mocks.getEffectivePromptManifest,
  },
}))
vi.mock('../config-store', () => ({ configStore: { get: vi.fn() } }))
vi.mock('../worker-manager-pool', () => ({
  extensionUiDialogSource: mocks.extensionUiDialogSource,
}))
vi.mock('../direct-extension-ui', () => ({
  requestDirectExtensionUI: vi.fn(),
  hasPendingDirectExtensionUI: () => mocks.directConfirmationPending,
}))
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
    setMode: mocks.setMode,
    getMode: vi.fn(() => mocks.mode),
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
    mocks.directConfirmationPending = false
    mocks.extensionUiDialogSource.clear()
    mocks.mode = 'WORK'
    mocks.phase = 'ASK'
    mocks.stop.mockReset().mockResolvedValue(undefined)
    mocks.start.mockReset().mockResolvedValue({})
    mocks.getEffectivePromptManifest.mockReset().mockImplementation(async () => ({
      manifest: {
        mode: mocks.mode,
        capabilityIds: mocks.mode === 'CODING' ? ['coding.workspace'] : ['work.file-organize'],
        toolNames: mocks.mode === 'CODING' ? ['read', 'write'] : ['read', 'xiaogui_read_pdf'],
      },
    }))
    mocks.setExecutionPhase.mockClear()
    mocks.setMode.mockClear()
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

  it('rejects mode switching before mutation while a Turn or Tool confirmation is active', async () => {
    mocks.cwd = 'C:\\workspace'
    mocks.hasActiveTurns = true

    await expect(
      mocks.handlers.get('ipc:xiaogui.mode.switch')!({ mode: 'CODING' }),
    ).rejects.toThrow('XIAOGUI_MODE_SWITCH_TURN_ACTIVE')

    expect(mocks.mode).toBe('WORK')
    expect(mocks.setMode).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('rejects mode switching while a Worker Tool confirmation remains pending', async () => {
    mocks.extensionUiDialogSource.set('confirmation', {})

    await expect(
      mocks.handlers.get('ipc:xiaogui.mode.switch')!({ mode: 'CODING' }),
    ).rejects.toThrow('XIAOGUI_MODE_SWITCH_TURN_ACTIVE')
    expect(mocks.setMode).not.toHaveBeenCalled()
  })

  it('rejects mode switching while a direct confirmation remains pending', async () => {
    mocks.directConfirmationPending = true

    await expect(
      mocks.handlers.get('ipc:xiaogui.mode.switch')!({ mode: 'CODING' }),
    ).rejects.toThrow('XIAOGUI_MODE_SWITCH_TURN_ACTIVE')
    expect(mocks.setMode).not.toHaveBeenCalled()
  })

  it('P16 safe-rebuild: acknowledges WORK to CODING only after the idle Worker Prompt Context is rebuilt', async () => {
    mocks.cwd = 'C:\\workspace'

    await expect(
      mocks.handlers.get('ipc:xiaogui.mode.switch')!({ mode: 'CODING' }),
    ).resolves.toEqual({ ok: true, mode: 'CODING', promptContextStatus: 'REBUILT' })

    expect(mocks.mode).toBe('CODING')
    expect(mocks.stop).toHaveBeenCalledOnce()
    expect(mocks.start).toHaveBeenCalledWith('C:\\workspace')
    expect(mocks.getEffectivePromptManifest).toHaveBeenCalledOnce()
  })

  it('P16 fail-closed: rolls back when the rebuilt Worker still reports the WORK Prompt Context', async () => {
    mocks.cwd = 'C:\\workspace'
    mocks.getEffectivePromptManifest.mockResolvedValueOnce({
      manifest: {
        mode: 'WORK',
        capabilityIds: ['work.file-organize'],
        toolNames: ['read', 'xiaogui_read_pdf'],
      },
    })

    await expect(
      mocks.handlers.get('ipc:xiaogui.mode.switch')!({ mode: 'CODING' }),
    ).rejects.toThrow('XIAOGUI_MODE_WORKER_REBUILD_FAILED')

    expect(mocks.mode).toBe('WORK')
  })

  it('fails and rolls mode back when the idle Worker Prompt Context cannot be rebuilt', async () => {
    mocks.cwd = 'C:\\workspace'
    mocks.start.mockRejectedValueOnce(new Error('worker start failed'))

    await expect(
      mocks.handlers.get('ipc:xiaogui.mode.switch')!({ mode: 'CODING' }),
    ).rejects.toThrow('XIAOGUI_MODE_WORKER_REBUILD_FAILED')

    expect(mocks.mode).toBe('WORK')
    expect(mocks.setMode.mock.calls.map(([mode]) => mode)).toEqual(['CODING', 'WORK'])
  })

  it('marks the switch safe when no Worker Prompt Context is currently bound', async () => {
    await expect(
      mocks.handlers.get('ipc:xiaogui.mode.switch')!({ mode: 'CODING' }),
    ).resolves.toEqual({ ok: true, mode: 'CODING', promptContextStatus: 'NOT_BOUND' })
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
