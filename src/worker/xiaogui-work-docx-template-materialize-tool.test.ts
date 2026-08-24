import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'

import {
  addXiaoguiWorkDocxTemplateMaterializeTool,
  XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_TOOL_NAME,
} from './xiaogui-work-docx-template-materialize-tool'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())

vi.mock('./worker-host-tool-channel.js', () => ({
  requestWorkerHostTool: requestWorkerHostToolMock,
}))

function loadTool() {
  const base = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
  const result = addXiaoguiWorkDocxTemplateMaterializeTool(base, {
    getSourceSessionId: () => 'session-1',
    getSourceRunId: () => 'run-1',
  })
  return result.extensions[0]?.tools.get(XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_TOOL_NAME)?.definition
}

beforeEach(() => requestWorkerHostToolMock.mockReset())

describe('小规 WORK 正式模板物化隐藏工具', () => {
  it('只提供自然语言入口，并明确预览后下一轮才能另存', () => {
    const tool = loadTool()
    expect(tool?.label).toBe('生成正式 Word 模板')
    expect(tool?.promptGuidelines?.join('\n')).toContain('PREPARE 生成并打开预览后必须结束本轮')
    expect(tool?.promptGuidelines?.join('\n')).toContain('当前简单字段生成器不会展开')
    expect(tool?.label).not.toMatch(/\bpi\b/i)
  })

  it('公开结果只给摘要，不泄露内部路径或操作编号', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PREPARED',
        plan: {
          variables: [{ name: '项目名称' }],
          repeatBlocks: [{ name: '工作明细' }],
          conditionalBlocks: [],
          excludedCandidateCount: 2,
          removedMediaCount: 1,
          advancedGenerationRequired: true,
        },
      },
    })
    const execute = loadTool()?.execute as unknown as (
      toolCallId: string,
      params: { action: 'PREPARE' },
      signal: AbortSignal,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: { kind: string } }>

    const outcome = await execute(
      'call-1',
      { action: 'PREPARE' },
      new AbortController().signal,
    )

    expect(requestWorkerHostToolMock).toHaveBeenCalledWith(
      {
        method: 'xiaogui.work.docx-template-materialize.v1',
        payload: {
          action: 'PREPARE',
          sourceSessionId: 'session-1',
          sourceRunId: 'run-1',
          toolCallId: 'call-1',
        },
      },
      expect.any(AbortSignal),
    )
    expect(outcome.content[0]?.text).toContain('原 Word 未修改')
    expect(outcome.content[0]?.text).toContain('下一条消息')
    expect(outcome.content[0]?.text).not.toMatch(/[A-Z]:[\\/]/)
    expect(JSON.stringify(outcome.details)).not.toContain('operation')
  })
})
