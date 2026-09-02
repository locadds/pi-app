import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const store = {
  runState: { model: 'openai/org/model/v2', thinkingLevel: 'high' },
  sessions: [] as Array<Record<string, unknown>>,
  clearPendingNewSessionPlaceholder: vi.fn(),
  setCurrentSession: vi.fn(),
  clearFileChanges: vi.fn(),
  setHistoryMeta: vi.fn(),
  setSessions: vi.fn(),
}

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: (...args: unknown[]) => invoke(...args) },
}))

vi.mock('@renderer/stores/ui-store', () => ({
  useUIStore: { getState: () => store },
}))

vi.mock('@renderer/lib/composer-run-display', () => ({
  refreshComposerRunDisplay: vi.fn(),
}))

import { materializePendingNewSession } from './new-session'

const canonicalScope = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
  sessionMode: 'CODING',
}

describe('new session model preselection', () => {
  beforeEach(() => {
    invoke.mockReset()
    store.clearPendingNewSessionPlaceholder.mockReset()
    store.setCurrentSession.mockReset()
    store.clearFileChanges.mockReset()
    store.setHistoryMeta.mockReset()
    store.setSessions.mockReset()
    store.sessions = []
  })

  it('binds the created session before model confirmation completes', async () => {
    let confirmModel: ((value: { modelId: string }) => void) | undefined
    const onSessionCreated = vi.fn()
    invoke.mockImplementation((method: string) => {
      if (method === 'session.new') {
        return Promise.resolve({
          session: {
            sessionId: 'new-id',
            sessionFile: 'C:/sessions/new.jsonl',
            canonicalScope,
          },
        })
      }
      if (method === 'session.setPendingBind') return Promise.resolve({ ok: true })
      if (method === 'model.set')
        return new Promise((resolve) => {
          confirmModel = resolve
        })
      if (method === 'thinkingLevel.set') return Promise.resolve({ ok: true })
      if (method === 'session.list') return Promise.resolve({ sessions: [] })
      return Promise.resolve({})
    })

    const materialized = materializePendingNewSession('D:/workspace', 'first prompt', onSessionCreated, 'CODING')
    await vi.waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith('C:/sessions/new.jsonl'))
    expect(invoke).toHaveBeenCalledWith('session.new', {
      workspaceId: 'D:/workspace',
      mode: 'CODING',
    })
    expect(confirmModel).toBeDefined()

    confirmModel?.({ modelId: 'openai/org/model/v2' })
    await materialized
    expect(store.setSessions).toHaveBeenCalledWith([expect.objectContaining({ sessionId: 'new-id', canonicalScope })])
  })

  it('waits for model confirmation before finishing session materialization', async () => {
    let confirmModel: ((value: { modelId: string }) => void) | undefined
    invoke.mockImplementation((method: string) => {
      if (method === 'session.new') {
        return Promise.resolve({
          session: {
            sessionId: 'new-id',
            sessionFile: 'C:/sessions/new.jsonl',
          },
        })
      }
      if (method === 'session.setPendingBind') return Promise.resolve({ ok: true })
      if (method === 'model.set') {
        return new Promise((resolve) => {
          confirmModel = resolve
        })
      }
      if (method === 'thinkingLevel.set') return Promise.resolve({ ok: true })
      if (method === 'session.list') return Promise.resolve({ sessions: [] })
      return Promise.resolve({})
    })

    let settled = false
    const materialized = materializePendingNewSession('D:/workspace', 'first prompt').then(() => {
      settled = true
    })
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('model.set', {
        sessionId: '',
        sessionFile: 'C:/sessions/new.jsonl',
        provider: 'openai',
        modelId: 'org/model/v2',
      }),
    )

    expect(settled).toBe(false)
    expect(invoke).not.toHaveBeenCalledWith('thinkingLevel.set', expect.anything())

    confirmModel?.({ modelId: 'openai/org/model/v2' })
    await materialized

    expect(invoke).toHaveBeenCalledWith('thinkingLevel.set', {
      sessionId: '',
      sessionFile: 'C:/sessions/new.jsonl',
      level: 'high',
    })
  })

  it('rejects materialization when the Worker rejects the preselected model', async () => {
    invoke.mockImplementation(async (method: string) => {
      if (method === 'session.new') {
        return {
          session: {
            sessionId: 'new-id',
            sessionFile: 'C:/sessions/new.jsonl',
          },
        }
      }
      if (method === 'session.setPendingBind') return { ok: true }
      if (method === 'model.set') throw new Error('MODEL_NOT_FOUND')
      return { ok: true }
    })

    await expect(materializePendingNewSession('D:/workspace', 'first prompt')).rejects.toThrow('MODEL_NOT_FOUND')
    expect(invoke).not.toHaveBeenCalledWith('thinkingLevel.set', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('session.list', expect.anything())
  })

  it('rejects materialization when the Worker confirms a different model', async () => {
    invoke.mockImplementation(async (method: string) => {
      if (method === 'session.new') {
        return {
          session: {
            sessionId: 'new-id',
            sessionFile: 'C:/sessions/new.jsonl',
          },
        }
      }
      if (method === 'session.setPendingBind') return { ok: true }
      if (method === 'model.set') return { modelId: 'openai/different-model' }
      return { ok: true }
    })

    await expect(materializePendingNewSession('D:/workspace', 'first prompt')).rejects.toThrow(
      'Model selection was not confirmed: openai/different-model',
    )
    expect(invoke).not.toHaveBeenCalledWith('thinkingLevel.set', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('session.list', expect.anything())
  })

  it('keeps first-message sending available when the sidebar session refresh fails', async () => {
    store.sessions = [{ sessionId: 'existing-id', title: '已有会话', updatedAt: 1 }]
    invoke.mockImplementation(async (method: string) => {
      if (method === 'session.new') {
        return {
          session: {
            sessionId: 'new-id',
            sessionFile: 'C:/sessions/new.jsonl',
            canonicalScope,
          },
        }
      }
      if (method === 'session.setPendingBind') return { ok: true }
      if (method === 'model.set') return { modelId: 'openai/org/model/v2' }
      if (method === 'thinkingLevel.set') return { ok: true }
      if (method === 'session.list') throw new Error('cwd_not_trusted')
      return { ok: true }
    })

    await expect(materializePendingNewSession('D:/workspace', 'first prompt')).resolves.toBeUndefined()

    expect(store.setSessions).toHaveBeenCalledWith([
      expect.objectContaining({ sessionId: 'new-id', title: 'first prompt' }),
      expect.objectContaining({ sessionId: 'existing-id' }),
    ])
  })
})
