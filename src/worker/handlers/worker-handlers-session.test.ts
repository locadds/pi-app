import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { WorkerModelRuntime } from '../worker-runtime'
import { handleListsessions, handleLoadsession, handleSetmodel } from './worker-handlers-session'
import { bindWorkerExecutionIdentityV1, st } from '../worker-runtime'
import { freezeXiaoguiPromptContextV1 } from '../xiaogui-prompt/session-binding'

function modelRuntimeWith(getModel: (provider: string, modelId: string) => unknown): WorkerModelRuntime {
  return {
    getModel: vi.fn(getModel),
    getAvailable: vi.fn(async () => []),
    refresh: vi.fn(async () => ({ providers: [] })),
  } as unknown as WorkerModelRuntime
}

function sessionWith(options: {
  current?: { provider: string; id: string }
  setModel?: (model: { provider: string; id: string }) => Promise<void>
}): AgentSession {
  const current = options.current ?? { provider: 'anthropic', id: 'old' }
  return {
    model: current,
    thinkingLevel: 'medium',
    setModel: options.setModel ?? (async (model) => Object.assign(current, model)),
  } as unknown as AgentSession
}

afterEach(() => {
  st.session = null
  st.modelRuntime = null
  st.runtime = null
  st.workerExecutionIdentity = null
  st.consumedSessionOperationNonces.clear()
  st.promptContext = null
  st.promptContextCandidate = null
  st.promptTurnContext = null
  st.promptStickyCapabilities = []
  st.promptTurnStickyCapabilities = []
  st.pendingPromptContext = null
  st.promptDiagnostics = null
  st.promptPreflight = null
  st.agentTurnActive = false
})

function promptContext(phase: 'ASK' | 'EXECUTE', sessionKey = 'xgs1_one') {
  return freezeXiaoguiPromptContextV1({
    schemaVersion: 1,
    mode: 'WORK',
    phase,
    workspaceAvailable: true,
    projectTrusted: true,
    enabledCapabilities: ['work.file-organize'],
    availableToolNames: ['read'],
    sessionKey,
    projectId: 'xgp1_project',
  })
}

function bindTestWorker(sessionFile: string, nonce: string) {
  const authorizedCwd = 'C:\\project'
  const projectIdentityDigest = `sha256:${'1'.repeat(64)}`
  const slotBindingDigest = `sha256:${'2'.repeat(64)}`
  st.currentCwd = authorizedCwd
  bindWorkerExecutionIdentityV1({
    authorizedCwd,
    projectIdentityDigest,
    slotBindingDigest,
  })
  return {
    schemaVersion: 1 as const,
    sessionFile,
    authorizedCwd,
    projectIdentityDigest,
    slotBindingDigest,
    operationNonce: nonce,
  }
}

describe('handleSetmodel', () => {
  it('resolves through the service-owned ModelRuntime without session.modelRegistry', async () => {
    const model = { provider: 'openai', id: 'gpt/new' }
    const current = { provider: 'anthropic', id: 'old' }
    const modelRuntime = modelRuntimeWith(() => model)
    st.modelRuntime = modelRuntime
    st.session = sessionWith({
      current,
      setModel: async () => { Object.assign(current, model) },
    })
    const reply = vi.fn()

    await handleSetmodel({ provider: 'openai', modelId: 'gpt/new' }, reply)

    expect(modelRuntime.getModel).toHaveBeenCalledWith('openai', 'gpt/new')
    expect(reply).toHaveBeenCalledWith({ type: 'setModel-done', modelId: 'openai/gpt/new' })
  })

  it('rejects a model missing from the service-owned ModelRuntime', async () => {
    st.modelRuntime = modelRuntimeWith(() => undefined)
    st.session = sessionWith({})
    const reply = vi.fn()

    await handleSetmodel({ provider: 'openai', modelId: 'gpt/new' }, reply)

    expect(reply).toHaveBeenCalledWith({ type: 'error', error: 'MODEL_NOT_FOUND: openai/gpt/new' })
  })

  it('reports setModel failure instead of silently confirming success', async () => {
    st.modelRuntime = modelRuntimeWith(() => ({ provider: 'openai', id: 'gpt/new' }))
    st.session = sessionWith({
      setModel: async () => { throw new Error('provider rejected model') },
    })
    const reply = vi.fn()

    await handleSetmodel({ provider: 'openai', modelId: 'gpt/new' }, reply)

    expect(reply).toHaveBeenCalledWith({ type: 'error', error: 'provider rejected model' })
  })

  it('rejects when the runtime remains on the previous model', async () => {
    st.modelRuntime = modelRuntimeWith(() => ({ provider: 'openai', id: 'gpt/new' }))
    st.session = sessionWith({
      setModel: async () => undefined,
    })
    const reply = vi.fn()

    await handleSetmodel({ provider: 'openai', modelId: 'gpt/new' }, reply)

    expect(reply).toHaveBeenCalledWith({ type: 'error', error: 'MODEL_NOT_CONFIRMED: anthropic/old' })
  })

  it('returns the actual runtime model after confirmation', async () => {
    const current = { provider: 'anthropic', id: 'old' }
    st.modelRuntime = modelRuntimeWith(() => ({ provider: 'openai', id: 'gpt/new' }))
    st.session = sessionWith({
      current,
      setModel: async () => { Object.assign(current, { provider: 'openai', id: 'gpt/new' }) },
    })
    const reply = vi.fn()

    await handleSetmodel({ provider: 'openai', modelId: 'gpt/new' }, reply)

    expect(reply).toHaveBeenCalledWith({ type: 'setModel-done', modelId: 'openai/gpt/new' })
  })
})

describe('handleLoadsession Prompt Context', () => {
  it('derives the switch target from the execution lease instead of the top-level sessionFile', async () => {
    const currentFile = 'C:\\sessions\\current.jsonl'
    const targetFile = 'C:\\sessions\\target.jsonl'
    const authorizedCwd = 'C:\\project'
    const targetSession = {
      sessionId: 'target-session',
      sessionFile: targetFile,
      model: { provider: 'test', id: 'model' },
      thinkingLevel: 'medium',
      isStreaming: false,
      sessionManager: {
        getCwd: () => authorizedCwd,
        getLeafId: () => null,
      },
    } as unknown as AgentSession
    const switchSession = vi.fn(async () => {
      st.session = targetSession
      return { cancelled: false }
    })
    st.currentCwd = authorizedCwd
    st.session = {
      sessionId: 'current-session',
      sessionFile: currentFile,
      isStreaming: false,
      sessionManager: { getCwd: () => authorizedCwd, getLeafId: () => null },
    } as unknown as AgentSession
    st.runtime = {
      switchSession,
      services: { modelRuntime: null },
      modelFallbackMessage: null,
      dispose: vi.fn(async () => undefined),
    } as never
    st.sdk = {} as never
    bindWorkerExecutionIdentityV1({
      authorizedCwd,
      projectIdentityDigest: `sha256:${'1'.repeat(64)}`,
      slotBindingDigest: `sha256:${'2'.repeat(64)}`,
    })
    const reply = vi.fn()

    await handleLoadsession({
      // Deliberately misleading legacy field: it must not decide the target.
      sessionFile: currentFile,
      sessionExecutionLease: {
        schemaVersion: 1,
        sessionFile: targetFile,
        authorizedCwd,
        projectIdentityDigest: `sha256:${'1'.repeat(64)}`,
        slotBindingDigest: `sha256:${'2'.repeat(64)}`,
        operationNonce: 'nonce-handler-target-1',
      },
      promptContext: promptContext('ASK', 'xgs1_target'),
    }, reply)

    expect(switchSession).toHaveBeenCalledWith(targetFile, { cwdOverride: authorizedCwd })
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      type: 'loadSession-done',
      sessionFile: targetFile,
    }))
  })

  it('consumes a same-session lease once before applying its leaf operation', async () => {
    const currentFile = 'C:\\sessions\\current.jsonl'
    const sessionExecutionLease = bindTestWorker(currentFile, 'nonce-handler-reuse-1')
    const currentContext = promptContext('ASK')
    st.promptContextCandidate = currentContext
    st.session = {
      sessionId: 'current-session',
      sessionFile: currentFile,
      model: { provider: 'test', id: 'model' },
      thinkingLevel: 'medium',
      isStreaming: false,
      sessionManager: {
        getCwd: () => 'C:\\project',
        getLeafId: () => null,
      },
    } as unknown as AgentSession
    const firstReply = vi.fn()
    const replayReply = vi.fn()

    await handleLoadsession({
      sessionFile: currentFile,
      sessionExecutionLease,
      promptContext: currentContext,
    }, firstReply)
    await handleLoadsession({
      sessionFile: currentFile,
      sessionExecutionLease,
      promptContext: currentContext,
    }, replayReply)

    expect(firstReply).toHaveBeenCalledWith(expect.objectContaining({ type: 'loadSession-done' }))
    expect(replayReply).toHaveBeenCalledWith({
      type: 'error',
      error: 'loadSession failed: SESSION_EXECUTION_LEASE_REPLAYED',
    })
  })

  it('rejects a phase change for the same Session while a Turn is active', async () => {
    const sessionFile = 'C:\\sessions\\one.jsonl'
    const sessionExecutionLease = bindTestWorker(sessionFile, 'nonce-turn-active-1')
    st.promptContextCandidate = promptContext('ASK')
    st.agentTurnActive = true
    st.session = {
      sessionFile,
      isStreaming: true,
      sessionManager: { getLeafId: () => null },
    } as unknown as AgentSession
    const reply = vi.fn()

    await handleLoadsession({
      sessionFile,
      sessionExecutionLease,
      promptContext: promptContext('EXECUTE'),
    }, reply)

    expect(reply).toHaveBeenCalledWith({
      type: 'error',
      error: 'loadSession failed: XIAOGUI_PROMPT_CONTEXT_TURN_ACTIVE',
    })
  })

  it('rejects a different opaque sessionKey for the same Session file', async () => {
    const sessionFile = 'C:\\sessions\\one.jsonl'
    const sessionExecutionLease = bindTestWorker(sessionFile, 'nonce-session-key-1')
    st.promptContextCandidate = promptContext('ASK', 'xgs1_one')
    st.session = {
      sessionFile,
      isStreaming: false,
      sessionManager: { getLeafId: () => null },
    } as unknown as AgentSession
    const reply = vi.fn()

    await handleLoadsession({
      sessionFile,
      sessionExecutionLease,
      promptContext: promptContext('ASK', 'xgs1_two'),
    }, reply)

    expect(reply).toHaveBeenCalledWith({
      type: 'error',
      error: 'loadSession failed: XIAOGUI_PROMPT_CONTEXT_SESSION_MISMATCH',
    })
  })
})

describe('handleListsessions project identity', () => {
  it('uses the Worker-bound project root instead of a request cwd', async () => {
    const authorizedCwd = 'C:\\project'
    bindTestWorker('C:\\sessions\\unused.jsonl', 'nonce-list-unused-1')
    const list = vi.fn(async () => [])
    st.sdk = { SessionManager: { list } } as never
    const reply = vi.fn()

    await handleListsessions({ cwd: 'C:\\other-project' }, reply)

    expect(list).toHaveBeenCalledWith(authorizedCwd)
    expect(reply).toHaveBeenCalledWith({ type: 'listSessions-done', sessions: [] })
  })
})
