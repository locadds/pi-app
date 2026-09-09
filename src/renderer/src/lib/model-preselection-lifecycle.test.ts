import { expect, it, vi } from 'vitest'
const { store, invoke } = vi.hoisted(() => {
  const store = {
    currentSessionId: null as string | null, historySessionFile: null as string | null,
    sessions: [] as Array<Record<string, unknown>>, lastModel: 'anthropic/old', lastThinking: 'off',
    runState: { model: 'deepseek/selected', thinkingLevel: 'off' },
    setRunState: vi.fn((patch: object): void => { Object.assign(store.runState, patch) }),
    setCurrentSession: (id: string | null) => { store.currentSessionId = id },
    setHistoryMeta: (_a: number, _b: number, file: string | null) => { store.historySessionFile = file },
    clearPendingNewSessionPlaceholder: vi.fn(), setWorkerLiveSnapshot: vi.fn(), clearTimeline: vi.fn(),
    clearFileChanges: vi.fn(), setHistoryLoading: vi.fn(), setSubagentSessionGroup: vi.fn(), setSessions: vi.fn(),
  }
  return { store, invoke: vi.fn() }
})
vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke } }))
vi.mock('@renderer/stores/ui-store', () => ({ useUIStore: { getState: () => store } }))
vi.mock('@renderer/stores/extension-ui-store', () => ({ useExtensionUIStore: { getState: () => ({ resetForSessionContext: vi.fn() }) } }))
vi.mock('@renderer/lib/session-navigation', () => ({ beginSessionNavigation: vi.fn() }))
vi.mock('@renderer/lib/blank-session-transition', () => ({ enterBlankSession: vi.fn() }))
vi.mock('@renderer/lib/session-worker-sync', () => ({ isViewingWorkerBoundSession: (a: string, b: string) => !!a && a === b }))
vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }))
import { navigateToModeHome } from '@renderer/xiaogui/lib/navigate-mode-home'
import { materializePendingNewSession } from './new-session'

it('keeps preselection through normal home refresh and new-session model confirmation', async () => {
  let runtime = { sessionFile: 'C:/sessions/old.jsonl', model: 'anthropic/old', thinkingLevel: 'off' }
  invoke.mockImplementation(async (method, args) => {
    if (method === 'ipc:runtime.getState') return { state: runtime }
    if (method === 'pi.settings.get') return { settings: { defaultProvider: 'anthropic', defaultModel: 'old' } }
    if (method === 'session.new') return { session: { sessionId: 'new', sessionFile: 'C:/sessions/new.jsonl' } }
    if (method === 'model.set') { runtime = { ...runtime, sessionFile: args.sessionFile, model: `${args.provider}/${args.modelId}` }; return { modelId: runtime.model } }
    if (method === 'session.list') return { sessions: [] }
    return {}
  })
  navigateToModeHome()
  await vi.waitFor(() => expect(store.setRunState).toHaveBeenCalled())
  await materializePendingNewSession('C:/project', 'analyze once', undefined, 'WORK')
  expect(invoke).toHaveBeenCalledWith('model.set', { sessionId: '', sessionFile: 'C:/sessions/new.jsonl', provider: 'deepseek', modelId: 'selected' })
})
