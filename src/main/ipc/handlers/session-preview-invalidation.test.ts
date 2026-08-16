import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: Record<string, unknown>) => Promise<unknown>>(),
  listSessions: vi.fn(),
  invalidateListSessions: vi.fn(),
  newSession: vi.fn(),
  forkSession: vi.fn(),
  cloneSession: vi.fn(),
  resolveScope: vi.fn(),
  registerNewScope: vi.fn(),
  deriveScope: vi.fn(),
  setMode: vi.fn(),
  getMode: vi.fn(() => 'WORK'),
  focusExistingSession: vi.fn(() => false),
  loadSession: vi.fn(),
  setPendingWorkerSessionFile: vi.fn(),
  renamePiSessionOnDisk: vi.fn(),
  authorizeTrustedSessionFile: vi.fn((workspaceId: string, sessionFile: string) => ({
    ok: true,
    cwd: workspaceId,
    sessionFile,
  })),
  deleteSessionFile: vi.fn(),
}))

vi.mock('../registry', () => ({
  registerHandler: (channel: string, handler: (request: Record<string, unknown>) => Promise<unknown>) => {
    mocks.handlers.set(channel, handler)
  },
  registerHandlerWithSchema: (
    channel: string,
    _schema: unknown,
    handler: (request: Record<string, unknown>) => Promise<unknown>,
  ) => {
    mocks.handlers.set(channel, handler)
  },
}))

vi.mock('../../session-preview-process', () => ({
  sessionPreviewProcess: {
    listSessions: mocks.listSessions,
    invalidateListSessions: mocks.invalidateListSessions,
    getTree: vi.fn(),
    getMessages: vi.fn(),
  },
}))

vi.mock('../../worker-manager', () => ({
  workerManager: {
    cwd: '/workspace',
    isRunning: true,
    start: vi.fn(),
    newSession: mocks.newSession,
    forkSession: mocks.forkSession,
    cloneSession: mocks.cloneSession,
    focusExistingSession: mocks.focusExistingSession,
    loadSession: mocks.loadSession,
    deleteSessionFile: mocks.deleteSessionFile,
    getState: vi.fn(async () => ({})),
  },
}))

vi.mock('../../config-store', () => ({ configStore: { get: vi.fn(() => '/workspace') } }))
vi.mock('../../session-bind-state', () => ({
  ensureWorkerSessionBound: vi.fn(),
  getPendingWorkerSessionFile: vi.fn(),
  setPendingEphemeralSandboxDraft: vi.fn(),
  setPendingWorkerSessionFile: mocks.setPendingWorkerSessionFile,
}))
vi.mock('../../xiaogui/scope-service', () => ({
  sessionScopeResolverV1: {
    resolve: mocks.resolveScope,
    registerNew: mocks.registerNewScope,
    derive: mocks.deriveScope,
  },
}))
vi.mock('../../xiaogui/sidecar-bridge', () => ({
  xiaogui: { setMode: mocks.setMode, getMode: mocks.getMode },
}))
vi.mock('../../session-prepare', () => ({ resolvePreparedSessionFile: vi.fn() }))
vi.mock('../../session-display-names', () => ({
  clearSessionDisplayName: vi.fn(),
  resolveSessionListTitle: vi.fn((_file, fallback) => fallback),
}))
vi.mock('../../rename-pi-session', () => ({ renamePiSessionOnDisk: mocks.renamePiSessionOnDisk }))
vi.mock('../../sandbox-workspaces', () => ({
  bindSandboxSession: vi.fn(),
  isSandboxWorkspacePath: vi.fn(() => false),
  renameSandboxWorkspace: vi.fn(),
}))
vi.mock('../../pi-rewind-read', () => ({ listRewindCheckpoints: vi.fn() }))
vi.mock('../../session-branch-anchors', () => ({ listMessageAnchorsFromSessionFile: vi.fn() }))
vi.mock('../../session-file-meta', () => ({ readSessionIdFromFile: vi.fn() }))
vi.mock('../../session-leaf-override', () => ({
  getSessionLeafOverride: vi.fn(),
  setSessionLeafOverride: vi.fn(),
}))
vi.mock('../../session-fork-candidates', () => ({ listForkCandidatesFromSessionFile: vi.fn() }))
vi.mock('../../trusted-workspace', () => ({
  authorizeTrustedSessionFile: mocks.authorizeTrustedSessionFile,
}))

import { registerSessionHandlers } from './session'

describe('session list preview invalidation', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.listSessions.mockReset()
    mocks.listSessions
      .mockResolvedValueOnce([{ id: 'before', path: '/sessions/before.jsonl' }])
      .mockResolvedValue([{ id: 'after', path: '/sessions/after.jsonl' }])
    mocks.invalidateListSessions.mockReset()
    mocks.invalidateListSessions.mockResolvedValue(undefined)
    mocks.newSession.mockReset()
    mocks.newSession.mockImplementation(async (_workspaceId, options) => {
      const result = { sessionId: 'new', sessionFile: '/sessions/new.jsonl' }
      await options?.beforeActivate?.(result)
      return result
    })
    mocks.forkSession.mockReset()
    mocks.forkSession.mockImplementation(async (options) => {
      const result = { sessionId: 'fork', sessionFile: '/sessions/fork.jsonl' }
      await options?.beforeActivate?.(result)
      return result
    })
    mocks.cloneSession.mockReset()
    mocks.cloneSession.mockImplementation(async (options) => {
      const result = { sessionId: 'clone', sessionFile: '/sessions/clone.jsonl' }
      await options?.beforeActivate?.(result)
      return result
    })
    const makeScope = (ref: { rootPath: string; sessionFile: string }, mode = 'WORK') => ({
      ...ref,
      projectId: `xgp1_${'a'.repeat(64)}`,
      sessionKey: `xgs1_${(ref.sessionFile.includes('source') ? 'b' : 'c').repeat(64)}`,
      sessionMode: mode,
    })
    mocks.resolveScope.mockReset()
    mocks.resolveScope.mockImplementation(async (ref) => makeScope(ref))
    mocks.registerNewScope.mockReset()
    mocks.registerNewScope.mockImplementation(async (ref, mode) => makeScope(ref, mode))
    mocks.deriveScope.mockReset()
    mocks.deriveScope.mockImplementation(async ({ target }) => makeScope(target, 'CODING'))
    mocks.setMode.mockReset()
    mocks.getMode.mockReset()
    mocks.getMode.mockReturnValue('WORK')
    mocks.focusExistingSession.mockReset()
    mocks.focusExistingSession.mockReturnValue(false)
    mocks.loadSession.mockReset()
    mocks.setPendingWorkerSessionFile.mockReset()
    mocks.renamePiSessionOnDisk.mockReset()
    mocks.renamePiSessionOnDisk.mockResolvedValue({ ok: true })
    mocks.deleteSessionFile.mockReset()
    mocks.deleteSessionFile.mockResolvedValue({ ok: true })
    mocks.authorizeTrustedSessionFile.mockReset()
    mocks.authorizeTrustedSessionFile.mockImplementation((workspaceId: string, sessionFile: string) => ({
      ok: true,
      cwd: workspaceId,
      sessionFile,
    }))
    registerSessionHandlers()
  })

  it.each([
    ['ipc:session.new', { workspaceId: '/workspace' }],
    ['ipc:session.fork', { workspaceId: '/workspace', sessionFile: '/sessions/source.jsonl', entryId: 'entry' }],
    ['ipc:session.clone', { workspaceId: '/workspace', sessionFile: '/sessions/source.jsonl' }],
    ['ipc:session.rename', { workspaceId: '/workspace', sessionFile: '/sessions/source.jsonl', title: 'renamed' }],
    ['ipc:session.delete', { workspaceId: '/workspace', sessionFile: '/sessions/source.jsonl' }],
  ])('refreshes list immediately after successful %s', async (channel, request) => {
    const before = await mocks.handlers.get('ipc:session.list')!({ workspaceId: '/workspace' })
    await mocks.handlers.get(channel)!(request)
    const after = await mocks.handlers.get('ipc:session.list')!({ workspaceId: '/workspace' })

    expect(before).toMatchObject({ sessions: [{ sessionId: 'before' }] })
    expect(after).toMatchObject({ sessions: [{ sessionId: 'after' }] })
    expect(mocks.invalidateListSessions).toHaveBeenCalledWith('/workspace')
    expect(mocks.listSessions.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidateListSessions.mock.invocationCallOrder[0],
    )
    expect(mocks.invalidateListSessions.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.listSessions.mock.invocationCallOrder[1],
    )
  })

  it('projects canonical scopes in list results', async () => {
    const result = await mocks.handlers.get('ipc:session.list')!({ workspaceId: '/workspace' })

    expect(result).toMatchObject({
      sessions: [{ canonicalScope: { sessionMode: 'WORK' } }],
    })
    expect(mocks.resolveScope).toHaveBeenCalledWith({
      rootPath: '/workspace',
      sessionFile: '/sessions/before.jsonl',
    })
  })

  it('resolves and synchronizes mode before binding an existing session', async () => {
    mocks.resolveScope.mockImplementationOnce(async (ref) => ({
      ...ref,
      projectId: `xgp1_${'a'.repeat(64)}`,
      sessionKey: `xgs1_${'b'.repeat(64)}`,
      sessionMode: 'CODING',
    }))

    const result = await mocks.handlers.get('ipc:session.setPendingBind')!({
      workspaceId: '/workspace',
      sessionFile: '/sessions/source.jsonl',
    })

    expect(result).toMatchObject({ canonicalScope: { sessionMode: 'CODING' } })
    expect(mocks.resolveScope.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setMode.mock.invocationCallOrder[0],
    )
    expect(mocks.setMode.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setPendingWorkerSessionFile.mock.invocationCallOrder[0],
    )
    expect(mocks.setPendingWorkerSessionFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.focusExistingSession.mock.invocationCallOrder[0],
    )
  })

  it('registers a new session from the creation intent before returning it', async () => {
    const result = await mocks.handlers.get('ipc:session.new')!({
      workspaceId: '/workspace',
      mode: 'DESIGN',
    })

    expect(mocks.registerNewScope).toHaveBeenCalledWith(
      { rootPath: '/workspace', sessionFile: '/sessions/new.jsonl' },
      'DESIGN',
    )
    expect(result).toMatchObject({ session: { canonicalScope: { sessionMode: 'DESIGN' } } })
  })

  it.each([
    ['ipc:session.fork', { workspaceId: '/workspace', sessionFile: '/sessions/source.jsonl', entryId: 'entry' }, 'FORK'],
    ['ipc:session.clone', { workspaceId: '/workspace', sessionFile: '/sessions/source.jsonl' }, 'CLONE'],
  ])('derives canonical scope for successful %s before returning target', async (channel, request, kind) => {
    const result = await mocks.handlers.get(channel)!(request)

    expect(mocks.deriveScope).toHaveBeenCalledWith({
      kind,
      source: { rootPath: '/workspace', sessionFile: '/sessions/source.jsonl' },
      target: {
        rootPath: '/workspace',
        sessionFile: channel.endsWith('fork') ? '/sessions/fork.jsonl' : '/sessions/clone.jsonl',
      },
    })
    expect(result).toMatchObject({ session: { canonicalScope: { sessionMode: 'CODING' } } })
  })

  it('does not bind or focus an existing session when scope persistence fails', async () => {
    mocks.resolveScope.mockRejectedValueOnce(new Error('SCOPE_PERSISTENCE_FAILED'))

    await expect(mocks.handlers.get('ipc:session.setPendingBind')!({
      workspaceId: '/workspace',
      sessionFile: '/sessions/source.jsonl',
    })).rejects.toThrow('SCOPE_PERSISTENCE_FAILED')

    expect(mocks.setMode).not.toHaveBeenCalled()
    expect(mocks.setPendingWorkerSessionFile).not.toHaveBeenCalled()
    expect(mocks.focusExistingSession).not.toHaveBeenCalled()
  })

  it('does not publish a fork target when canonical derivation fails', async () => {
    mocks.deriveScope.mockRejectedValueOnce(new Error('SCOPE_PERSISTENCE_FAILED'))

    const result = await mocks.handlers.get('ipc:session.fork')!({
      workspaceId: '/workspace',
      sessionFile: '/sessions/source.jsonl',
      entryId: 'entry',
    })

    expect(result).toMatchObject({
      cancelled: false,
      error: 'SCOPE_PERSISTENCE_FAILED',
      session: { sessionId: '', error: 'SCOPE_PERSISTENCE_FAILED' },
    })
    expect(mocks.setPendingWorkerSessionFile).not.toHaveBeenCalled()
    expect(mocks.invalidateListSessions).not.toHaveBeenCalled()
  })
})
