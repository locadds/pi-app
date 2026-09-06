import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testRoot = mkdtempSync(join(tmpdir(), 'xiaogui-trusted-handler-chain-'))
const trustedProject = join(testRoot, 'project')
const sessionsDir = join(testRoot, 'sessions')
mkdirSync(trustedProject, { recursive: true })
mkdirSync(sessionsDir, { recursive: true })

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: Record<string, unknown>) => Promise<unknown>>(),
  registrations: new Set<string>(),
  dialogPath: '',
  config: {
    currentProject: null as string | null,
    recentProjects: [] as string[],
    agentRuntime: { mode: 'host' as const, distro: null as string | null },
  },
  rememberedBinding: null as object | null,
  start: vi.fn(),
  focusExistingSession: vi.fn(),
  loadSession: vi.fn(),
  sendPrompt: vi.fn(),
  resolveCodingContext: vi.fn(),
  ensureWorkerSessionBound: vi.fn(),
  setPendingWorkerSessionBinding: vi.fn(),
  listSessions: vi.fn(),
}))

function pathKey(value: string): string {
  const normalized = resolve(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [mocks.dialogPath] })),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  shell: { openExternal: vi.fn() },
}))

vi.mock('../../trusted-project-registration', () => ({
  trustedProjectRegistrationV1: {
    register: vi.fn((path: string) => {
      const canonical = resolve(path)
      mocks.registrations.add(pathKey(canonical))
      return { ok: true as const, cwd: canonical }
    }),
    authorize: vi.fn((path: string | undefined) => {
      const canonical = resolve(String(path || ''))
      return mocks.registrations.has(pathKey(canonical))
        ? { ok: true as const, cwd: canonical }
        : { ok: false as const, error: 'trusted_project_open_required' }
    }),
    revoke: vi.fn((path: string) => mocks.registrations.delete(pathKey(path))),
  },
}))

vi.mock('../registry', () => ({
  registerHandler: (channel: string, handler: (request: Record<string, unknown>) => Promise<unknown>) => {
    mocks.handlers.set(channel, handler)
  },
  registerHandlerWithSchema: (
    channel: string,
    schema: { safeParse: (value: unknown) => { success: boolean; data?: Record<string, unknown>; error?: Error } },
    handler: (request: Record<string, unknown>) => Promise<unknown>,
  ) => {
    mocks.handlers.set(channel, async (request) => {
      const parsed = schema.safeParse(request)
      if (!parsed.success) throw new Error(`Invalid IPC input for ${channel}`)
      return handler(parsed.data!)
    })
  },
  sendEvent: vi.fn(),
}))

vi.mock('../../config-store', () => ({
  configStore: {
    get: vi.fn((key: keyof typeof mocks.config) => mocks.config[key]),
    getAll: vi.fn(() => ({ ...mocks.config })),
    set: vi.fn((key: keyof typeof mocks.config, value: never) => {
      ;(mocks.config as Record<string, unknown>)[key] = value
    }),
    addRecentProject: vi.fn((path: string) => {
      mocks.config.recentProjects = [path, ...mocks.config.recentProjects.filter((item) => item !== path)]
    }),
    removeRecentProject: vi.fn(),
  },
}))

vi.mock('../../worker-manager', () => ({
  workerManager: {
    cwd: null,
    isRunning: false,
    hasActiveTurns: false,
    start: mocks.start,
    focusExistingSession: mocks.focusExistingSession,
    rememberSessionBinding: vi.fn((binding: object) => {
      mocks.rememberedBinding = binding
    }),
    resolveRegisteredSessionBinding: vi.fn(() => mocks.rememberedBinding),
    readLiveSessionBinding: vi.fn(() => null),
    loadSession: mocks.loadSession,
    sendPrompt: mocks.sendPrompt,
    stop: vi.fn(),
    getState: vi.fn(async () => null),
    clearForegroundSession: vi.fn(),
    forgetSessionBinding: vi.fn(),
    deleteSessionFile: vi.fn(),
    getSessionTree: vi.fn(),
  },
}))

vi.mock('../../session-preview-process', () => ({
  sessionPreviewProcess: {
    listSessions: mocks.listSessions,
    invalidateListSessions: vi.fn(),
    getTree: vi.fn(),
    getMessages: vi.fn(),
    stop: vi.fn(),
  },
}))

const scope = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
  sessionMode: 'WORK' as const,
  rootPath: trustedProject,
  sessionFile: '',
}

vi.mock('../../xiaogui/scope-service', () => ({
  sessionScopeResolverV1: {
    resolveExisting: vi.fn(async (ref) => ({ ...scope, ...ref })),
    resolve: vi.fn(async (ref) => ({ ...scope, ...ref })),
    registerNew: vi.fn(),
    derive: vi.fn(),
  },
}))
vi.mock('../../xiaogui/sidecar-bridge', () => ({
  xiaogui: { setMode: vi.fn(), getMode: vi.fn(() => 'WORK') },
}))
vi.mock('../../xiaogui/coding-extensions/checkpoint-default-composition', () => ({
  recordDefaultCodingCheckpointSessionAddressV1: vi.fn(),
}))
vi.mock('../../session-bind-state', () => ({
  ensureWorkerSessionBound: mocks.ensureWorkerSessionBound,
  getPendingWorkerSessionBinding: vi.fn(() => null),
  setPendingWorkerSessionBinding: mocks.setPendingWorkerSessionBinding,
  setPendingEphemeralSandboxDraft: vi.fn(),
}))
vi.mock('../../xiaogui/coding-extensions/context-composition', () => ({
  resolveCodingContextForPromptV1: mocks.resolveCodingContext,
}))
vi.mock('../../clipboard-temp-images', () => ({ writeClipboardTempImage: vi.fn() }))
vi.mock('../../../extension-compat/adapter-loader', () => ({ invalidateAdapterCatalog: vi.fn() }))
vi.mock('../../sqlite-index', () => ({ sqliteIndex: { upsertWorkspace: vi.fn() } }))
vi.mock('../../window', () => ({ getMainWindow: vi.fn(() => null) }))
vi.mock('../../git-workspace-watch', () => ({ refreshGitWorkspaceWatch: vi.fn() }))
vi.mock('../../xiaogui/scope-store', () => ({ getScope: vi.fn(), setScope: vi.fn() }))
vi.mock('../../xiaogui/design-extension-deploy', () => ({ ensureDesignExtensionDeployed: vi.fn() }))
vi.mock('../../sandbox-workspaces', () => ({
  bindSandboxSession: vi.fn(),
  createSandboxWorkspace: vi.fn(),
  deleteSandboxWorkspace: vi.fn(),
  isSandboxWorkspacePath: vi.fn(() => false),
  listSandboxWorkspaces: vi.fn(() => []),
  renameSandboxWorkspace: vi.fn(),
  sandboxOwnsSessionFile: vi.fn(() => false),
  findSandboxWorkspaceForSessionFile: vi.fn(() => null),
}))
vi.mock('../../session-display-names', () => ({
  clearSessionDisplayName: vi.fn(),
  resolveSessionListTitle: vi.fn((_path, fallback) => fallback),
}))
vi.mock('../../session-leaf-override', () => ({
  getSessionLeafOverride: vi.fn(),
  setSessionLeafOverride: vi.fn(),
}))
vi.mock('../../pi-rewind-read', () => ({ listRewindCheckpoints: vi.fn() }))
vi.mock('../../session-branch-anchors', () => ({ listMessageAnchorsFromSessionFile: vi.fn() }))
vi.mock('../../rename-pi-session', () => ({ renamePiSessionOnDisk: vi.fn() }))
vi.mock('../../session-fork-candidates', () => ({ listForkCandidatesFromSessionFile: vi.fn() }))
vi.mock('../../sdk-manager', () => ({ invalidateSdkManagerCaches: vi.fn() }))
vi.mock('../../asr-config-store', () => ({
  asrConfigForSettingsResponse: vi.fn((value) => value),
  loadAsrConfig: vi.fn(),
  saveAsrConfig: vi.fn(),
}))

import { registerDialogHandlers } from './dialog'
import { registerPromptHandlers } from './prompt'
import { registerSessionHandlers } from './session'
import { registerSettingsHandlers } from './settings'
import { registerWorkspaceHandlers } from './workspace'

describe('trusted project and session handler chain', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.registrations.clear()
    mocks.dialogPath = trustedProject
    mocks.config.currentProject = null
    mocks.config.recentProjects = []
    mocks.rememberedBinding = null
    mocks.start.mockReset()
    mocks.start.mockResolvedValue({ sessionId: 'worker-1', model: 'provider/model' })
    mocks.focusExistingSession.mockReset()
    mocks.loadSession.mockReset()
    mocks.sendPrompt.mockReset()
    mocks.resolveCodingContext.mockReset()
    mocks.ensureWorkerSessionBound.mockReset()
    mocks.setPendingWorkerSessionBinding.mockReset()
    mocks.listSessions.mockReset()
    mocks.listSessions.mockResolvedValue([])
    registerDialogHandlers()
    registerSettingsHandlers()
    registerWorkspaceHandlers()
    registerSessionHandlers()
    registerPromptHandlers()
  })

  afterAll(() => rmSync(testRoot, { recursive: true, force: true }))

  it('does not promote settings or raw workspace IPC paths into a project capability', async () => {
    await expect(mocks.handlers.get('ipc:settings.set')!({
      key: 'currentProject',
      value: trustedProject,
    })).rejects.toThrow('Invalid IPC input')
    await expect(mocks.handlers.get('ipc:settings.set')!({
      key: 'recentProjects',
      value: [trustedProject],
    })).rejects.toThrow('Invalid IPC input')

    // Simulate a legacy/tampered preference: it remains only a selector.
    mocks.config.currentProject = trustedProject
    mocks.config.recentProjects = [trustedProject]
    await expect(mocks.handlers.get('ipc:workspace.open')!({
      path: trustedProject,
      awaitWorker: true,
    })).rejects.toThrow('trusted_project_open_required')
    await expect(mocks.handlers.get('ipc:workspace.switch')!({
      workspaceId: trustedProject,
    })).rejects.toThrow('trusted_project_open_required')
    expect(await mocks.handlers.get('ipc:workspace.ensureWorker')!({ path: trustedProject }))
      .toMatchObject({ ok: false, error: 'trusted_project_open_required' })
    expect(mocks.start).not.toHaveBeenCalled()

    const selected = await mocks.handlers.get('ipc:dialog:openDirectory')!({}) as { path: string }
    expect(selected.path).toBe(resolve(trustedProject))
    await expect(mocks.handlers.get('ipc:workspace.open')!({
      path: selected.path,
      awaitWorker: false,
    })).resolves.toMatchObject({ workspaceId: resolve(trustedProject) })
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('does not promote a matching arbitrary JSONL before Main SessionManager discovery', async () => {
    const legitimateFile = join(sessionsDir, 'legitimate.jsonl')
    const forgedFile = join(sessionsDir, 'forged.jsonl')
    const header = (id: string) => `${JSON.stringify({ type: 'session', id, cwd: trustedProject })}\n`
    writeFileSync(legitimateFile, header('legitimate-id'), 'utf8')
    writeFileSync(forgedFile, header('forged-id'), 'utf8')

    await mocks.handlers.get('ipc:dialog:openDirectory')!({})
    await mocks.handlers.get('ipc:workspace.open')!({ path: trustedProject, awaitWorker: false })

    await expect(mocks.handlers.get('ipc:session.open')!({
      sessionId: 'forged-id',
      workspaceId: trustedProject,
      sessionFile: forgedFile,
    })).rejects.toThrow('trusted_session_not_listed')
    await expect(mocks.handlers.get('ipc:session.setPendingBind')!({
      workspaceId: trustedProject,
      sessionFile: forgedFile,
    })).rejects.toThrow('trusted_session_not_listed')
    await expect(mocks.handlers.get('ipc:session.prepare')!({
      workspaceId: trustedProject,
      sessionFile: forgedFile,
      bind: true,
    })).rejects.toThrow('trusted_session_not_listed')
    expect(await mocks.handlers.get('ipc:session.navigateTree')!({
      workspaceId: trustedProject,
      sessionFile: forgedFile,
      targetId: 'leaf-1',
    })).toMatchObject({ cancelled: true, error: 'trusted_session_not_listed' })
    await expect(mocks.handlers.get('ipc:prompt.send')!({
      sessionId: 'forged-id',
      workspaceId: trustedProject,
      sessionFile: forgedFile,
      text: 'forged',
    })).rejects.toThrow('trusted_session_binding_mismatch')
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.focusExistingSession).not.toHaveBeenCalled()
    expect(mocks.ensureWorkerSessionBound).not.toHaveBeenCalled()
    expect(mocks.resolveCodingContext).not.toHaveBeenCalled()
    expect(mocks.sendPrompt).not.toHaveBeenCalled()

    mocks.listSessions.mockResolvedValue([{
      id: 'legitimate-id',
      path: legitimateFile,
      cwd: trustedProject,
    }])
    await mocks.handlers.get('ipc:session.list')!({ workspaceId: trustedProject })
    await expect(mocks.handlers.get('ipc:session.open')!({
      sessionId: 'legitimate-id',
      workspaceId: trustedProject,
      sessionFile: legitimateFile,
    })).resolves.toMatchObject({ session: { sessionId: 'legitimate-id' } })
    expect(mocks.setPendingWorkerSessionBinding).toHaveBeenCalledOnce()
    expect(mocks.focusExistingSession).toHaveBeenCalledWith(legitimateFile)
  })
})
