import { describe, expect, it, vi } from 'vitest'
import type { BeforeAgentStartEvent, ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { createXiaoguiPromptSessionExtensionV1 } from './session-extension'

describe('Pi 0.84.1 Xiaogui Prompt Session extension', () => {
  it('captures a fixed Context and builds from Pi real before_agent_start facts', async () => {
    let handler: ((event: BeforeAgentStartEvent) => unknown) | undefined
    const pi = {
      on: vi.fn((event: string, callback: (value: BeforeAgentStartEvent) => unknown) => {
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
    const diagnostics = vi.fn()
    const extension = createXiaoguiPromptSessionExtensionV1(source, diagnostics)
    await extension.factory(pi)

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
    } as BeforeAgentStartEvent) as { systemPrompt: string }

    expect(result.systemPrompt).toContain('# 当前模式：WORK｜工作')
    expect(result.systemPrompt).toContain('read: 读取文件')
    expect(result.systemPrompt).toContain('<project_context>facts</project_context>')
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      manifest: expect.objectContaining({ mode: 'WORK', phase: 'ASK', toolNames: ['read'] }),
    }))
  })
})
