import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'
import type {
  BeforeAgentStartEvent,
  AgentSession,
  AgentSessionServices,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'

import {
  buildXiaoguiPromptSessionStateV1,
  createXiaoguiPromptSessionExtensionV1,
} from './session-extension'

describe('Pi 0.84.1 Xiaogui Prompt Session extension', () => {
  it.each([true, false])(
    'uses ExtensionContext trust=%s as the effective Prompt fact',
    async (projectTrusted) => {
    let handler: ((event: BeforeAgentStartEvent, context: ExtensionContext) => unknown) | undefined
    const pi = {
      on: vi.fn((event: string, callback: typeof handler) => {
        if (event === 'before_agent_start') handler = callback
      }),
    } as unknown as ExtensionAPI
    const source = {
      schemaVersion: 1 as const,
      mode: 'WORK' as const,
      phase: 'ASK' as const,
      workspaceAvailable: true,
      projectTrusted: true,
      enabledCapabilities: ['work.file-organize' as const],
      availableToolNames: ['read'],
      sessionKey: 'xgs1_one',
      projectId: 'xgp1_project',
    }
    const resolved = vi.fn()
    const extension = createXiaoguiPromptSessionExtensionV1(source, resolved)
    await extension.factory(pi)

    const extensionContext = {
      isProjectTrusted: () => projectTrusted,
      abort: vi.fn(),
    } as unknown as ExtensionContext
    const result = await handler!({
      type: 'before_agent_start',
      prompt: 'user task',
      systemPrompt: 'USER SYSTEM\n\n<project_context>facts</project_context>',
      systemPromptOptions: {
        cwd: 'C:/project',
        customPrompt: 'USER SYSTEM',
        selectedTools: ['read'],
        toolSnippets: { read: '读取文件' },
        promptGuidelines: ['只读取完成任务所需的内容'],
      },
    } as BeforeAgentStartEvent, extensionContext) as { systemPrompt: string }

    expect(result.systemPrompt).toContain('# 当前模式：WORK｜工作')
    expect(result.systemPrompt).toContain('read: 读取文件')
    expect(result.systemPrompt).toContain('<project_context>facts</project_context>')
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        projectTrusted,
        enabledCapabilities: ['work.file-organize'],
      }),
      diagnostics: expect.objectContaining({
        manifest: expect.objectContaining({
          mode: 'WORK',
          phase: 'ASK',
          projectTrusted,
          toolNames: ['read'],
        }),
      }),
    }))
    const resolvedState = resolved.mock.calls[0]?.[0]
    expect(resolvedState.productPrompt).toContain('# 小规 Agent')
    expect(resolvedState.productPrompt).not.toContain('USER SYSTEM')
    expect(resolvedState.productPrompt).not.toContain('<project_context>facts</project_context>')
    expect(result.systemPrompt.length)
      .toBe(resolvedState.diagnostics.manifest.completePromptCharacterCount)
    expect(createHash('sha256').update(result.systemPrompt, 'utf8').digest('hex'))
      .toBe(resolvedState.diagnostics.manifest.completePromptSha256)
    expect(extensionContext.abort).not.toHaveBeenCalled()
  })

  it('hard-aborts when final before_agent_start assembly fails unexpectedly', async () => {
    let handler: ((event: BeforeAgentStartEvent, context: ExtensionContext) => unknown) | undefined
    const pi = {
      on: vi.fn((event: string, callback: typeof handler) => {
        if (event === 'before_agent_start') handler = callback
      }),
    } as unknown as ExtensionAPI
    const context = {
      schemaVersion: 1 as const,
      mode: 'DESIGN' as const,
      phase: 'ASK' as const,
      workspaceAvailable: true,
      projectTrusted: false,
      enabledCapabilities: ['design.analysis' as const],
      availableToolNames: ['read'],
    }
    const failure = vi.fn()
    const extension = createXiaoguiPromptSessionExtensionV1(context, vi.fn(), failure)
    await extension.factory(pi)
    const extensionContext = {
      isProjectTrusted: () => false,
      abort: vi.fn(),
    } as unknown as ExtensionContext

    await expect(handler!({
      type: 'before_agent_start',
      prompt: 'task',
      systemPrompt: '<!-- XIAOGUI:PRODUCT:BEGIN --> malformed',
      systemPromptOptions: {
        cwd: 'C:/project',
        selectedTools: ['read'],
        toolSnippets: {},
        promptGuidelines: [],
      },
    } as BeforeAgentStartEvent, extensionContext)).rejects
      .toThrow('XIAOGUI_PROMPT_PRODUCT_MARKER_MALFORMED')
    expect(extensionContext.abort).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({
      message: 'XIAOGUI_PROMPT_PRODUCT_MARKER_MALFORMED',
    }))
  })

  it.each([true, false])(
    'initializes with Session SettingsManager trust=%s despite a wrong Main candidate',
    (projectTrusted) => {
      const candidate = {
        schemaVersion: 1 as const,
        mode: 'WORK' as const,
        phase: 'ASK' as const,
        workspaceAvailable: true,
        projectTrusted: !projectTrusted,
        enabledCapabilities: ['work.file-organize' as const],
        availableToolNames: ['read'],
      }
      const session = {
        settingsManager: { isProjectTrusted: () => projectTrusted },
        systemPrompt: 'PI base',
        getActiveToolNames: () => ['read'],
        getToolDefinition: () => ({ promptSnippet: 'read files', promptGuidelines: [] }),
      } as unknown as AgentSession
      const services = {
        resourceLoader: { getSystemPrompt: () => undefined },
      } as unknown as AgentSessionServices

      const state = buildXiaoguiPromptSessionStateV1(session, services, candidate)

      expect(state.context.projectTrusted).toBe(projectTrusted)
      expect(state.diagnostics.manifest.projectTrusted).toBe(projectTrusted)
    },
  )

  it('fails closed when Session trust cannot be established', () => {
    const candidate = {
      schemaVersion: 1 as const,
      mode: 'WORK' as const,
      phase: 'ASK' as const,
      workspaceAvailable: true,
      projectTrusted: true,
      enabledCapabilities: ['work.file-organize' as const],
      availableToolNames: ['read'],
    }
    const session = {
      settingsManager: {},
      systemPrompt: 'PI base',
      getActiveToolNames: () => ['read'],
      getToolDefinition: () => ({ promptSnippet: 'read files', promptGuidelines: [] }),
    } as unknown as AgentSession
    const services = {
      resourceLoader: { getSystemPrompt: () => undefined },
    } as unknown as AgentSessionServices

    const state = buildXiaoguiPromptSessionStateV1(session, services, candidate)

    expect(state.context.projectTrusted).toBe(false)
    expect(state.diagnostics.manifest.projectTrusted).toBe(false)
    expect(state.productPrompt).toContain('项目信任：未信任')
  })
})
