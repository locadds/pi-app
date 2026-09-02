import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // Node 25 原生 localStorage 遮蔽 jsdom 实现（无 setItem），zustand persist
  // 写入会在测试里炸；在模块 import 前安装内存版实现（仅当环境损坏时）。
  const broken = typeof localStorage === 'undefined' || typeof localStorage.setItem !== 'function'
  if (!broken) return
  const mem = new Map<string, string>()
  const storage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => void mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  })
})

import { useUIStore } from '@renderer/stores/ui-store'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue({}),
  openSessionIntoWorker: vi.fn().mockResolvedValue(undefined),
  prepareCanonicalSessionOpen: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: mocks.invoke },
}))
vi.mock('@renderer/lib/open-session', () => ({
  openSessionIntoWorker: mocks.openSessionIntoWorker,
}))
vi.mock('@renderer/xiaogui/lib/canonical-session-open', () => ({
  prepareCanonicalSessionOpen: mocks.prepareCanonicalSessionOpen,
}))
vi.mock('@renderer/lib/composer-run-display', () => ({
  refreshComposerRunDisplay: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

import { cloneCurrentSession, forkSessionFromEntry } from './session-fork'

const codingScope = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
  sessionMode: 'CODING' as const,
}

const designScope = {
  projectId: `xgp1_${'3'.repeat(64)}`,
  sessionKey: `xgs1_${'4'.repeat(64)}`,
  sessionMode: 'DESIGN' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  useUIStore.setState({
    currentWorkspace: '/workspace',
    currentSessionId: 'source-session',
    historySessionFile: '/sessions/source.jsonl',
    sessions: [],
    composerPrefill: 'existing draft',
    runState: { status: 'idle', toolCount: 0, errorCount: 0 },
    workerLiveSnapshot: { sessionId: null, sessionFile: null, status: 'idle' },
    streamingAssistantId: null,
    optimisticPendingUserText: null,
    sessionRuntimeRunning: {},
    agentTurnBootstrapping: false,
    subagentSessionGroup: null,
  })
})

describe('session fork renderer actions', () => {
  it('auto-opens the fork and prefills the original user text', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'session.fork') {
        return {
          cancelled: false,
          sessionId: 'fork-session',
          sessionFile: '/sessions/fork.jsonl',
          editorText: 'original prompt',
          session: { canonicalScope: codingScope },
        }
      }
      if (channel === 'session.list') return { sessions: [] }
      return {}
    })

    await expect(forkSessionFromEntry('user-entry')).resolves.toBe(true)

    expect(mocks.invoke).toHaveBeenCalledWith(
      'session.fork',
      expect.objectContaining({
        sessionFile: '/sessions/source.jsonl',
        entryId: 'user-entry',
        position: 'before',
      }),
    )
    expect(mocks.openSessionIntoWorker).toHaveBeenCalledWith('fork-session', '/sessions/fork.jsonl')
    expect(mocks.prepareCanonicalSessionOpen).toHaveBeenCalledWith(codingScope)
    expect(useUIStore.getState().composerPrefill).toBe('original prompt')
  })

  it('auto-opens the clone and clears composer prefill', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'session.clone') {
        return {
          cancelled: false,
          sessionId: 'clone-session',
          sessionFile: '/sessions/clone.jsonl',
          session: { canonicalScope: designScope },
        }
      }
      if (channel === 'session.list') return { sessions: [] }
      return {}
    })

    await expect(cloneCurrentSession()).resolves.toBe(true)

    expect(mocks.openSessionIntoWorker).toHaveBeenCalledWith('clone-session', '/sessions/clone.jsonl')
    expect(mocks.prepareCanonicalSessionOpen).toHaveBeenCalledWith(designScope)
    expect(useUIStore.getState().composerPrefill).toBeNull()
  })

  it('fork consumes the main-process canonical scope without renderer path tagging', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'session.fork') {
        return {
          cancelled: false,
          sessionId: 'fork-session',
          sessionFile: '/sessions/fork.jsonl',
          session: { canonicalScope: codingScope },
        }
      }
      if (channel === 'session.list') return { sessions: [] }
      return {}
    })

    await expect(forkSessionFromEntry('user-entry')).resolves.toBe(true)

    expect(mocks.prepareCanonicalSessionOpen).toHaveBeenCalledWith(codingScope)
    expect(mocks.invoke).not.toHaveBeenCalledWith('xiaogui.scope.set', expect.anything())
  })

  it('clone consumes the inherited canonical scope without renderer path tagging', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'session.clone') {
        return {
          cancelled: false,
          sessionId: 'clone-session',
          sessionFile: '/sessions/clone.jsonl',
          session: { canonicalScope: designScope },
        }
      }
      if (channel === 'session.list') return { sessions: [] }
      return {}
    })

    await expect(cloneCurrentSession()).resolves.toBe(true)

    expect(mocks.prepareCanonicalSessionOpen).toHaveBeenCalledWith(designScope)
    expect(mocks.invoke).not.toHaveBeenCalledWith('xiaogui.scope.set', expect.anything())
  })

  it('should_block_branch_mutations_in_read_only_subagent_preview', async () => {
    useUIStore.setState({
      currentSessionId: 'child-session',
      historySessionFile: '/sessions/child.jsonl',
      subagentSessionGroup: {
        workspacePath: '/workspace',
        parentSessionId: 'source-session',
        parentSessionFile: '/sessions/source.jsonl',
        previewSessionFile: '/sessions/child.jsonl',
        children: [
          {
            key: 'call-1:0',
            agent: 'scout',
            state: 'completed',
            sessionFile: '/sessions/child.jsonl',
          },
        ],
      },
    })

    await expect(forkSessionFromEntry('user-entry')).resolves.toBe(false)
    await expect(cloneCurrentSession()).resolves.toBe(false)

    expect(mocks.invoke).not.toHaveBeenCalledWith('session.fork', expect.anything())
    expect(mocks.invoke).not.toHaveBeenCalledWith('session.clone', expect.anything())
  })
})
