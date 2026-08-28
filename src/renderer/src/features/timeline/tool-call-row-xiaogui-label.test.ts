import { describe, expect, it } from 'vitest'

import { xiaoguiToolActivityLabel, xiaoguiToolDisplayName } from './tool-call-row'

const TOOL_NAME = 'xiaogui_work_docx_template_intake'

describe('小规文档模板提取工具中文状态', () => {
  it('运行、成功和失败均不显示内部英文工具编号', () => {
    expect(xiaoguiToolDisplayName(TOOL_NAME)).toBe('提取文档模板')
    expect(
      xiaoguiToolActivityLabel({ id: '1', toolName: TOOL_NAME, toolPhase: 'start' }),
    ).toBe('正在提取文档模板…')
    expect(
      xiaoguiToolActivityLabel({ id: '2', toolName: TOOL_NAME, toolPhase: 'end' }),
    ).toBe('成功提取文档模板')
    expect(
      xiaoguiToolActivityLabel({ id: '3', toolName: TOOL_NAME, toolPhase: 'end', isError: true }),
    ).toBe('提取文档模板失败')
  })
})
