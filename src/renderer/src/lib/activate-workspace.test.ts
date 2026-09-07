import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activateWorkspace } from './activate-workspace'
import { useUIStore } from '@renderer/stores/ui-store'
import { openSessionIntoWorker } from '@renderer/lib/open-session'
import { useXiaoguiStore, type XiaoguiMode } from '@renderer/xiaogui/stores/xiaogui-store'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(method: string, request?: unknown) => Promise<unknown>>(
    async (method: string) => {
      if (method === 'workspace.open') return { ok: true }
      if (method === 'session.list') return { sessions: [] }
      if (method === 'settings.set') return { ok: true }
      return {}
    },
  ),
  openSessionIntoWorker: vi.fn(async () => {}),
  navigationAssert: vi.fn(() => true),
}))

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: (method: string, request?: unknown) => mocks.invoke(method, request) } }))
vi.mock('@renderer/lib/open-session', () => ({
  openSessionIntoWorker: mocks.openSessionIntoWorker,
  openSessionPreview: vi.fn(async () => {}),
}))
vi.mock('@renderer/lib/session-shell', () => ({ focusSessionSync: vi.fn() }))
vi.mock('@renderer/lib/capture-live-session-timeline', () => ({
  captureVisibleLiveSessionTimeline: vi.fn(),
}))
vi.mock('@renderer/lib/session-worker-sync', () => ({ fetchWorkerLiveSnapshot: vi.fn(async () => {}) }))
vi.mock('@renderer/lib/composer-run-display', () => ({ refreshComposerRunDisplay: vi.fn() }))
vi.mock('@renderer/lib/workspace-session-choice', () => ({
  chooseWorkspaceSession: vi.fn(() => undefined),
}))
vi.mock('@renderer/lib/session-navigation', () => ({
  beginSessionNavigation: vi.fn(() => 1),
  assertSessionNavigation: mocks.navigationAssert,
}))

describe('activateWorkspace clears the stale session list on a real workspace switch', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'workspace.open') return { ok: true }
      if (method === 'session.list') return { sessions: [] }
      if (method === 'settings.set') return { ok: true }
      return {}
    })
    mocks.openSessionIntoWorker.mockReset()
    mocks.openSessionIntoWorker.mockResolvedValue(undefined)
    mocks.navigationAssert.mockReset()
    mocks.navigationAssert.mockReturnValue(true)
    useUIStore.setState({
      currentWorkspace: '/proj/A',
      sessions: [{ sessionId: 'a1', title: 'A的会话', updatedAt: 1, modelId: 'm' }],
      workerLiveSnapshot: { sessionId: 'a1', sessionFile: '/proj/A/a1.jsonl', status: 'running' },
    })
  })

  it('clears sessions synchronously when switching to another workspace', async () => {
    const promise = activateWorkspace('/proj/B')
    // 同步部分先执行：setWorkspace + 清空旧工作区 sessions（防止新文件夹树短暂显示旧会话）
    expect(useUIStore.getState().currentWorkspace).toBe('/proj/B')
    expect(useUIStore.getState().sessions).toEqual([])
    await promise
  })

  it('clears the old worker snapshot when switching to another workspace home', async () => {
    await activateWorkspace('/proj/B', { preferHome: true })

    expect(useUIStore.getState().workerLiveSnapshot).toEqual({
      sessionId: null,
      sessionFile: null,
      status: 'idle',
    })
  })

  it('keeps sessions when reactivating the same workspace', async () => {
    const promise = activateWorkspace('/proj/A')
    expect(useUIStore.getState().sessions).toHaveLength(1)
    await promise
  })

  it.each(['WORK', 'CODING'] as XiaoguiMode[])('waits for trusted prepare before binding an explicitly selected %s session', async (mode) => {
    useXiaoguiStore.setState({ mode })
    let resolvePrepare: ((value: { sessionId: string; sessionFile: string; bound?: boolean }) => void) | undefined
    mocks.invoke.mockImplementation((method: string) => {
      if (method === 'workspace.open') return Promise.resolve({ ok: true })
      if (method === 'session.list') return Promise.resolve({ sessions: [] })
      if (method === 'session.prepare') {
        return new Promise<{ sessionId: string; sessionFile: string; bound?: boolean }>((resolve) => {
          resolvePrepare = resolve
        })
      }
      return Promise.resolve({})
    })

    const opening = activateWorkspace('/proj/B', {
      sessionId: 'persisted-metadata-id',
      sessionFile: 'C:/sessions/target.jsonl',
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(openSessionIntoWorker).not.toHaveBeenCalled()

    resolvePrepare?.({
      sessionId: 'main-verified-pi-id',
      sessionFile: 'c:\\sessions\\target.jsonl',
      bound: false,
    })
    await opening

    expect(mocks.invoke).toHaveBeenCalledWith('session.prepare', {
      workspaceId: '/proj/B',
      sessionFile: 'C:/sessions/target.jsonl',
      bind: false,
    })
    expect(openSessionIntoWorker).toHaveBeenCalledWith(
      'main-verified-pi-id',
      'c:\\sessions\\target.jsonl',
      expect.any(Number),
      { workerReady: true },
    )
    expect(useXiaoguiStore.getState().mode).toBe(mode)
    expect(mocks.invoke).not.toHaveBeenCalledWith('xiaogui.mode.switch', expect.anything())
  })

  it.each([
    ['not found', { sessionId: null, sessionFile: 'C:/sessions/target.jsonl' }],
    ['blank session id', { sessionId: ' ', sessionFile: 'C:/sessions/target.jsonl' }],
    ['path mismatch', { sessionId: 'main-verified-pi-id', sessionFile: 'C:/sessions/other.jsonl' }],
  ])('does not bind an explicitly selected session when trusted prepare is $s', async (_caseName, prepared) => {
    mocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'workspace.open') return { ok: true }
      if (method === 'session.list') return { sessions: [{ sessionId: 'nearest', sessionFile: 'C:/sessions/nearest.jsonl' }] }
      if (method === 'session.prepare') return prepared
      return {}
    })

    await activateWorkspace('/proj/B', {
      sessionId: 'persisted-metadata-id',
      sessionFile: 'C:/sessions/target.jsonl',
    })

    expect(openSessionIntoWorker).not.toHaveBeenCalled()
  })

  it('does not prepare or bind an explicitly selected session when workspace registration fails', async () => {
    mocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'workspace.open') throw new Error('trusted_workspace_required')
      if (method === 'session.prepare') return { sessionId: 'main-verified-pi-id', sessionFile: 'C:/sessions/target.jsonl' }
      return { sessions: [] }
    })

    await activateWorkspace('/proj/B', {
      sessionId: 'persisted-metadata-id',
      sessionFile: 'C:/sessions/target.jsonl',
    })

    expect(mocks.invoke).not.toHaveBeenCalledWith('session.prepare', expect.anything())
    expect(openSessionIntoWorker).not.toHaveBeenCalled()
  })

  it('does not bind an explicitly selected session when trusted prepare rejects', async () => {
    mocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'workspace.open') return { ok: true }
      if (method === 'session.list') return { sessions: [] }
      if (method === 'session.prepare') throw new Error('trusted_session_not_listed')
      return {}
    })

    await activateWorkspace('/proj/B', {
      sessionId: 'persisted-metadata-id',
      sessionFile: 'C:/sessions/target.jsonl',
    })

    expect(openSessionIntoWorker).not.toHaveBeenCalled()
  })

  it('does not bind an explicitly selected session after its navigation expires', async () => {
    let resolvePrepare: ((value: { sessionId: string; sessionFile: string }) => void) | undefined
    mocks.invoke.mockImplementation((method: string) => {
      if (method === 'workspace.open') return Promise.resolve({ ok: true })
      if (method === 'session.list') return Promise.resolve({ sessions: [] })
      if (method === 'session.prepare') {
        return new Promise<{ sessionId: string; sessionFile: string }>((resolve) => {
          resolvePrepare = resolve
        })
      }
      return Promise.resolve({})
    })

    const opening = activateWorkspace('/proj/B', {
      sessionId: 'persisted-metadata-id',
      sessionFile: 'C:/sessions/target.jsonl',
    })
    await Promise.resolve()
    await Promise.resolve()
    mocks.navigationAssert.mockReturnValue(false)
    resolvePrepare?.({ sessionId: 'main-verified-pi-id', sessionFile: 'C:/sessions/target.jsonl' })
    await opening

    expect(openSessionIntoWorker).not.toHaveBeenCalled()
  })
})
