import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleClone, handleFork } from './handlers/worker-handlers-session'
import { st } from './worker-runtime'

const originalState = { ...st }

function installSession(leafId = 'leaf-current') {
  const fork = vi.fn().mockResolvedValue({ cancelled: false, selectedText: 'original prompt' })
  st.runtime = { fork } as never
  st.session = {
    sessionId: 'session-source',
    sessionFile: '/sessions/source.jsonl',
    isStreaming: false,
    thinkingLevel: 'medium',
    model: { provider: 'provider', id: 'model' },
    sessionManager: { getLeafId: () => leafId },
  } as never
  st.currentSessionId = 'session-source'
  st.agentTurnActive = false
  st.promptSent = false
  st.promptContextCandidate = null
  st.promptTurnContext = null
  st.promptStickyCapabilities = []
  st.promptTurnStickyCapabilities = []
  st.promptContext = {
    schemaVersion: 1,
    mode: 'CODING',
    phase: 'EXECUTE',
    workspaceAvailable: true,
    projectTrusted: true,
    enabledCapabilities: ['coding.workspace'],
    availableToolNames: ['read'],
    sessionKey: 'session-source',
  }
  return fork
}

beforeEach(() => {
  Object.assign(st, originalState)
})

afterEach(() => {
  Object.assign(st, originalState)
})

describe('worker session branch actions', () => {
  it('forks before the selected user entry and returns editor prefill', async () => {
    const fork = installSession()
    const replies: unknown[] = []

    await handleFork({ type: 'fork', entryId: 'user-entry' } as never, (reply) => replies.push(reply))

    expect(fork).toHaveBeenCalledWith('user-entry', { position: 'before' })
    expect(replies).toEqual([
      expect.objectContaining({ type: 'fork-done', cancelled: false, editorText: 'original prompt' }),
    ])
  })

  it('clones at the current leaf without editor prefill', async () => {
    const fork = installSession('assistant-leaf')
    const replies: unknown[] = []

    await handleClone({ type: 'clone' } as never, (reply) => replies.push(reply))

    expect(fork).toHaveBeenCalledWith('assistant-leaf', { position: 'at' })
    expect(replies).toEqual([
      expect.not.objectContaining({ editorText: expect.anything() }),
    ])
    expect(replies).toEqual([expect.objectContaining({ type: 'clone-done', cancelled: false })])
  })

  it('returns SESSION_BUSY without mutating the runtime', async () => {
    const fork = installSession()
    st.agentTurnActive = true
    const replies: unknown[] = []

    await handleFork({ type: 'fork', entryId: 'user-entry' } as never, (reply) => replies.push(reply))
    await handleClone({ type: 'clone' } as never, (reply) => replies.push(reply))

    expect(fork).not.toHaveBeenCalled()
    expect(st.promptSent).toBe(false)
    expect(replies).toEqual([
      { type: 'error', error: 'SESSION_BUSY' },
      { type: 'error', error: 'SESSION_BUSY' },
    ])
  })
})
