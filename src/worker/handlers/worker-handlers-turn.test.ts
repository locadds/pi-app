import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '@earendil-works/pi-coding-agent'

import { st } from '../worker-runtime'
import { handlePrompt } from './worker-handlers-turn'

afterEach(() => {
  st.session = null
  st.promptPreflight = null
  st.promptContext = null
  st.promptContextCandidate = null
  st.promptDiagnostics = null
  st.agentTurnActive = false
  st.promptPreflightActive = false
})

describe('Worker Prompt dispatch preflight', () => {
  it('does not enter Pi session.prompt when effective Prompt validation fails', async () => {
    const prompt = vi.fn(async () => {})
    st.session = {
      prompt,
      isStreaming: false,
      sessionFile: 'C:\\sessions\\one.jsonl',
    } as unknown as AgentSession
    st.promptContextCandidate = {
      schemaVersion: 1,
      mode: 'WORK',
      phase: 'ASK',
      workspaceAvailable: true,
      projectTrusted: false,
      enabledCapabilities: ['work.file-organize'],
      availableToolNames: ['read'],
    }
    st.promptPreflight = () => {
      throw new Error('XIAOGUI_PROMPT_CONTEXT_TOOL_MISMATCH')
    }
    const reply = vi.fn()

    await handlePrompt({ text: 'do work' }, reply)

    expect(reply).toHaveBeenCalledWith({
      type: 'error',
      error: 'prompt preflight failed: XIAOGUI_PROMPT_CONTEXT_TOOL_MISMATCH',
    })
    expect(prompt).not.toHaveBeenCalled()
    expect(st.agentTurnActive).toBe(false)
  })

  it('blocks the Provider when Pi reaches dispatch without confirmed final assembly', async () => {
    const provider = vi.fn()
    const prompt = vi.fn(async (
      _text: string,
      options?: { preflightResult?: (passed: boolean) => void },
    ) => {
      options?.preflightResult?.(true)
      provider()
    })
    const context = {
      schemaVersion: 1 as const,
      mode: 'WORK' as const,
      phase: 'ASK' as const,
      workspaceAvailable: true,
      projectTrusted: false,
      enabledCapabilities: ['work.file-organize' as const],
      availableToolNames: ['read'],
    }
    st.session = {
      prompt,
      isStreaming: false,
      sessionFile: 'C:\\sessions\\one.jsonl',
    } as unknown as AgentSession
    st.promptContextCandidate = context
    st.promptPreflight = () => ({ context, diagnostics: {} as never })
    const reply = vi.fn()

    await handlePrompt({ text: 'do work' }, reply)
    expect(reply).toHaveBeenCalledWith({ type: 'prompt-done' })
    await vi.waitFor(() => expect(st.agentTurnActive).toBe(false))

    expect(prompt).toHaveBeenCalledOnce()
    expect(provider).not.toHaveBeenCalled()
  })
})
