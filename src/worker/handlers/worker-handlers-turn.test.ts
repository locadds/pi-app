import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { xiaoguiPromptBuilderV1 } from '../xiaogui-prompt/builder'

import { handleSessionEvent, st } from '../worker-runtime'
import { handlePrompt } from './worker-handlers-turn'

afterEach(() => {
  st.session = null
  st.promptPreflight = null
  st.promptContext = null
  st.promptContextCandidate = null
  st.promptTurnContext = null
  st.promptStickyCapabilities = []
  st.promptTurnStickyCapabilities = []
  st.promptTurnStickyToolCalls.clear()
  st.promptDiagnostics = null
  st.effectivePrompt = null
  st.agentTurnActive = false
  st.promptPreflightActive = false
})

describe('Worker Prompt dispatch preflight', () => {
  it('does not enter Pi session.prompt when effective Prompt validation fails', async () => {
    const prompt = vi.fn(async () => {})
    let activeTools = ['read']
    st.session = {
      prompt,
      isStreaming: false,
      sessionFile: 'C:\\sessions\\one.jsonl',
      getAllTools: () => [{ name: 'read' }],
      setActiveToolsByName: (names: string[]) => { activeTools = names },
      getActiveToolNames: () => activeTools,
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
    let activeTools = ['read']
    st.session = {
      prompt,
      isStreaming: false,
      sessionFile: 'C:\\sessions\\one.jsonl',
      getAllTools: () => [{ name: 'read' }],
      setActiveToolsByName: (names: string[]) => { activeTools = names },
      getActiveToolNames: () => activeTools,
    } as unknown as AgentSession
    st.promptContextCandidate = context
    st.promptPreflight = () => ({
      prompt: 'effective prompt',
      productPrompt: 'product prompt',
      context,
      diagnostics: {} as never,
    })
    const reply = vi.fn()

    await handlePrompt({ text: 'do work' }, reply)
    expect(reply).toHaveBeenCalledWith({ type: 'prompt-done' })
    await vi.waitFor(() => expect(st.agentTurnActive).toBe(false))

    expect(prompt).toHaveBeenCalledOnce()
    expect(provider).not.toHaveBeenCalled()
  })

  it('P05 preserves the PREPARE capability for exactly one acknowledgement turn', async () => {
    const registered = [
      'read',
      'xiaogui_read_pdf',
      'xiaogui_work_docx',
      'xiaogui_work_docx_advanced_generation',
      'xiaogui_work_report_docx',
    ]
    let activeTools: string[] = []
    const activeHistory: string[][] = []
    let promptCount = 0
    const prompt = vi.fn(async (
      _text: string,
      options?: { preflightResult?: (passed: boolean) => void },
    ) => {
      options?.preflightResult?.(false)
      promptCount += 1
      if (promptCount !== 1) return
      handleSessionEvent({
        type: 'tool_execution_start',
        toolCallId: 'prepare-1',
        toolName: 'xiaogui_work_docx',
        args: { action: 'PREPARE' },
      } as AgentSessionEvent)
      handleSessionEvent({
        type: 'tool_execution_end',
        toolCallId: 'prepare-1',
        toolName: 'xiaogui_work_docx',
        result: {
          content: [{ type: 'text', text: '已准备' }],
          details: { kind: 'XIAOGUI_WORK_DOCX_PREPARED' },
        },
        isError: false,
      } as AgentSessionEvent)
    })
    st.session = {
      prompt,
      isStreaming: false,
      sessionFile: 'C:\\sessions\\one.jsonl',
      getAllTools: () => registered.map((name) => ({ name })),
      setActiveToolsByName: (names: string[]) => {
        activeTools = [...names]
        activeHistory.push([...names])
      },
      getActiveToolNames: () => [...activeTools],
    } as unknown as AgentSession
    st.promptContextCandidate = {
      schemaVersion: 1,
      mode: 'WORK',
      phase: 'EXECUTE',
      workspaceAvailable: true,
      projectTrusted: true,
      enabledCapabilities: [],
      availableToolNames: [],
    }
    st.promptPreflight = () => {
      const context = st.promptTurnContext!
      const built = xiaoguiPromptBuilderV1.build({
        context,
        piSystemPrompt: 'PI Harness Base',
        runtimeTools: activeTools.map((name) => ({ name })),
      })
      return {
        prompt: built.prompt,
        productPrompt: built.productPrompt,
        context: built.effectiveContext,
        diagnostics: built.diagnostics,
      }
    }

    await handlePrompt({ text: '用我自己的模板生成报告' }, vi.fn())
    await vi.waitFor(() => {
      expect(st.promptStickyCapabilities).toEqual(['work.template-generation'])
    })
    await handlePrompt({ text: '看起来可以' }, vi.fn())
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(st.promptTurnContext).toBeNull())

    expect(activeHistory).toHaveLength(2)
    for (const active of activeHistory) {
      expect(active).toContain('xiaogui_work_docx')
      expect(active).not.toContain('xiaogui_work_report_docx')
    }
    expect(st.promptStickyCapabilities).toEqual([])
  })

  it.each([
    {
      name: 'no tool call',
      emitToolResult: false,
      resultKind: null,
      isError: false,
    },
    {
      name: 'failed PREPARE',
      emitToolResult: true,
      resultKind: 'XIAOGUI_WORK_DOCX_FAILED',
      isError: true,
    },
    {
      name: 'cancelled PREPARE',
      emitToolResult: true,
      resultKind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED',
      isError: false,
    },
  ])('P05 does not create sticky state after $name', async ({
    emitToolResult,
    resultKind,
    isError,
  }) => {
    const registered = [
      'read',
      'xiaogui_read_pdf',
      'xiaogui_work_docx',
      'xiaogui_work_docx_advanced_generation',
    ]
    let activeTools: string[] = []
    const activeHistory: string[][] = []
    let promptCount = 0
    const prompt = vi.fn(async (
      _text: string,
      options?: { preflightResult?: (passed: boolean) => void },
    ) => {
      options?.preflightResult?.(false)
      promptCount += 1
      if (promptCount !== 1 || !emitToolResult) return
      handleSessionEvent({
        type: 'tool_execution_start',
        toolCallId: 'prepare-rejected',
        toolName: 'xiaogui_work_docx',
        args: { action: 'PREPARE' },
      } as AgentSessionEvent)
      handleSessionEvent({
        type: 'tool_execution_end',
        toolCallId: 'prepare-rejected',
        toolName: 'xiaogui_work_docx',
        result: {
          content: [{ type: 'text', text: '未准备' }],
          details: { kind: resultKind },
          ...(isError ? { isError: true } : {}),
        },
        isError,
      } as AgentSessionEvent)
    })
    st.session = {
      prompt,
      isStreaming: false,
      sessionFile: 'C:\\sessions\\one.jsonl',
      getAllTools: () => registered.map((name) => ({ name })),
      setActiveToolsByName: (names: string[]) => {
        activeTools = [...names]
        activeHistory.push([...names])
      },
      getActiveToolNames: () => [...activeTools],
    } as unknown as AgentSession
    st.promptContextCandidate = {
      schemaVersion: 1,
      mode: 'WORK',
      phase: 'EXECUTE',
      workspaceAvailable: true,
      projectTrusted: true,
      enabledCapabilities: [],
      availableToolNames: [],
    }
    st.promptPreflight = () => {
      const context = st.promptTurnContext!
      const built = xiaoguiPromptBuilderV1.build({
        context,
        piSystemPrompt: 'PI Harness Base',
        runtimeTools: activeTools.map((name) => ({ name })),
      })
      return {
        prompt: built.prompt,
        productPrompt: built.productPrompt,
        context: built.effectiveContext,
        diagnostics: built.diagnostics,
      }
    }

    await handlePrompt({ text: '用我自己的模板生成报告' }, vi.fn())
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(st.promptTurnContext).toBeNull())
    expect(st.promptStickyCapabilities).toEqual([])

    await handlePrompt({ text: '看起来可以' }, vi.fn())
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(st.promptTurnContext).toBeNull())

    expect(activeHistory).toHaveLength(2)
    expect(activeHistory[0]).toContain('xiaogui_work_docx')
    expect(activeHistory[1]).not.toContain('xiaogui_work_docx')
    expect(st.promptStickyCapabilities).toEqual([])
  })

  it('P16 reuses a Worker while active tools and Prompt manifest follow each frozen turn', async () => {
    const registered = ['read', 'bash', 'edit', 'write', 'xiaogui_read_pdf']
    let activeTools: string[] = []
    const manifests: Array<{ mode: string; tools: readonly string[] }> = []
    const prompt = vi.fn(async (
      _text: string,
      options?: { preflightResult?: (passed: boolean) => void },
    ) => {
      options?.preflightResult?.(false)
    })
    st.session = {
      prompt,
      isStreaming: false,
      sessionFile: 'C:\\sessions\\one.jsonl',
      getAllTools: () => registered.map((name) => ({ name })),
      setActiveToolsByName: (names: string[]) => { activeTools = [...names] },
      getActiveToolNames: () => [...activeTools],
    } as unknown as AgentSession
    st.promptPreflight = () => {
      const context = st.promptTurnContext!
      const built = xiaoguiPromptBuilderV1.build({
        context,
        piSystemPrompt: 'PI Harness Base',
        runtimeTools: activeTools.map((name) => ({ name })),
        generatedAt: '2026-08-30T00:00:00.000Z',
      })
      manifests.push({
        mode: built.diagnostics.manifest.mode,
        tools: built.diagnostics.manifest.toolNames,
      })
      return {
        prompt: built.prompt,
        productPrompt: built.productPrompt,
        context: built.effectiveContext,
        diagnostics: built.diagnostics,
      }
    }

    st.promptContextCandidate = {
      schemaVersion: 1,
      mode: 'WORK',
      phase: 'ASK',
      workspaceAvailable: true,
      projectTrusted: true,
      enabledCapabilities: [],
      availableToolNames: [],
    }
    await handlePrompt({ text: '帮我解释模板整理的流程' }, vi.fn())
    await vi.waitFor(() => expect(st.promptTurnContext).toBeNull())

    st.promptContextCandidate = {
      ...st.promptContextCandidate,
      mode: 'CODING',
      phase: 'EXECUTE',
    }
    await handlePrompt({ text: '修复并测试' }, vi.fn())
    await vi.waitFor(() => expect(st.promptTurnContext).toBeNull())

    expect(manifests).toEqual([
      { mode: 'WORK', tools: ['read', 'xiaogui_read_pdf'] },
      { mode: 'CODING', tools: ['bash', 'edit', 'read', 'write'] },
    ])
    expect(activeTools).toEqual(['bash', 'edit', 'read', 'write'])
  })
})
