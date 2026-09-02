import { describe, expect, it } from 'vitest'

import {
  activeToolNamesForPromptContextV1,
  workerBuiltinToolNamesForPromptContextV1,
  XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1,
} from './xiaogui-prompt-capabilities'
import { XIAOGUI_CAPABILITY_MATRIX_V1 } from './xiaogui-prompt-matrix'

const context = (phase: 'ASK' | 'PLAN' | 'EXECUTE') => ({
  mode: 'CODING' as const,
  phase,
  workspaceAvailable: true,
  enabledCapabilities: ['coding.workspace' as const],
})

describe('CODING plan draft prompt policy', () => {
  it('exposes the hidden draft tool only during CODING PLAN', () => {
    const toolName = 'xiaogui_publish_coding_plan'
    expect(workerBuiltinToolNamesForPromptContextV1(context('ASK'))).not.toContain(toolName)
    expect(workerBuiltinToolNamesForPromptContextV1(context('PLAN'))).toContain(toolName)
    expect(workerBuiltinToolNamesForPromptContextV1(context('EXECUTE'))).not.toContain(toolName)

    const registered = ['read', 'bash', 'edit', 'write', toolName]
    expect(activeToolNamesForPromptContextV1(context('ASK'), registered)).toEqual(['read'])
    expect(activeToolNamesForPromptContextV1(context('PLAN'), registered)).toEqual([
      'read',
      toolName,
    ])
    expect(activeToolNamesForPromptContextV1(context('EXECUTE'), registered)).toEqual([
      'bash',
      'edit',
      'read',
      'write',
    ])
  })

  it('keeps the PLAN-only phase and approval boundary in the shared registry', () => {
    const planTool = XIAOGUI_CAPABILITY_MATRIX_V1['coding.workspace'].tools.find(
      (tool) => tool.name === 'xiaogui_publish_coding_plan',
    )
    expect(planTool).toMatchObject({ source: 'WORKER_BUILTIN', phases: ['PLAN'] })

    const prompt = XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1.xiaogui_publish_coding_plan
    expect(prompt.label).toBe('提交编程计划草稿')
    expect(prompt.promptGuidelines.join('\n')).toContain('等待用户批准')
    expect(prompt.promptGuidelines.join('\n')).toContain('不代表已经开始执行')
  })
})
