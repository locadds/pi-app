import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { WorkerModelRuntime } from '../worker-runtime'
import { handleLoadsession, handleSetmodel } from './worker-handlers-session'
import { st } from '../worker-runtime'
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
  st.promptContext = null
  st.promptContextCandidate = null
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
  it('rejects a phase change for the same Session while a Turn is active', async () => {
    const sessionFile = 'C:\\sessions\\one.jsonl'
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
      promptContext: promptContext('EXECUTE'),
    }, reply)

    expect(reply).toHaveBeenCalledWith({
      type: 'error',
      error: 'loadSession failed: XIAOGUI_PROMPT_CONTEXT_TURN_ACTIVE',
    })
  })

  it('rejects a different opaque sessionKey for the same Session file', async () => {
    const sessionFile = 'C:\\sessions\\one.jsonl'
    st.promptContextCandidate = promptContext('ASK', 'xgs1_one')
    st.session = {
      sessionFile,
      isStreaming: false,
      sessionManager: { getLeafId: () => null },
    } as unknown as AgentSession
    const reply = vi.fn()

    await handleLoadsession({
      sessionFile,
      promptContext: promptContext('ASK', 'xgs1_two'),
    }, reply)

    expect(reply).toHaveBeenCalledWith({
      type: 'error',
      error: 'loadSession failed: XIAOGUI_PROMPT_CONTEXT_SESSION_MISMATCH',
    })
  })
})
