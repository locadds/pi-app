import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'

import {
  addXiaoguiWorkReportDocxTool,
  XIAOGUI_WORK_REPORT_DOCX_TOOL_NAME,
} from './xiaogui-work-report-docx-tool'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())

vi.mock('./worker-host-tool-channel.js', () => ({
  requestWorkerHostTool: requestWorkerHostToolMock,
}))

const DRAFT = {
  title: '内部项目汇报',
  sections: [{ heading: '进展', paragraphs: ['正文不应出现在工具结果。'], bullets: ['第一项'] }],
} as const

function loadTool() {
  const base = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
  const result = addXiaoguiWorkReportDocxTool(base, {
    getSourceSessionId: () => 'session-1',
    getSourceRunId: () => 'run-1',
  })
  return result.extensions[0]?.tools.get(XIAOGUI_WORK_REPORT_DOCX_TOOL_NAME)?.definition
}

type Execute = (
  toolCallId: string,
  params:
    | { action: 'PREPARE'; draft: typeof DRAFT }
    | { action: 'CONFIRM' | 'CANCEL' | 'OPEN' | 'REVEAL' },
  signal: AbortSignal,
) => Promise<{
  content: Array<{ type: string; text: string }>
  details: { kind: string }
  isError?: boolean
}>

beforeEach(() => requestWorkerHostToolMock.mockReset())

describe('小规 WORK 标准报告 DOCX 隐藏工具', () => {
  it('以自然语言草稿为入口，公开结果只返回无路径摘要', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_REPORT_DOCX_PREPARED',
        plan: {
          planVersion: 1,
          sectionCount: 1,
          paragraphCount: 1,
          bulletCount: 1,
          characterCount: 24,
          previewSha256: 'a'.repeat(64),
          preview: DRAFT,
          requiresSecondConfirmation: true,
        },
      },
    })
    const tool = loadTool()
    const execute = tool?.execute as unknown as Execute

    const outcome = await execute(
      'tool-1',
      { action: 'PREPARE', draft: DRAFT },
      new AbortController().signal,
    )

    expect(tool?.label).toBe('生成标准 Word 报告')
    expect(tool?.parameters).toMatchObject({ type: 'object', additionalProperties: false })
    expect(tool?.promptGuidelines?.join('\n')).toContain('下一条消息')
    expect(JSON.stringify(tool?.parameters)).not.toContain('RESUME')
    expect(requestWorkerHostToolMock).toHaveBeenCalledWith(
      {
        method: 'xiaogui.work.report-docx.v1',
        payload: {
          action: 'PREPARE',
          draft: DRAFT,
          sourceSessionId: 'session-1',
          sourceRunId: 'run-1',
          toolCallId: 'tool-1',
        },
      },
      expect.any(AbortSignal),
    )
    const publicResult = JSON.stringify(outcome)
    expect(publicResult).toContain(DRAFT.title)
    expect(publicResult).toContain('正文不应出现在工具结果')
    expect(publicResult).toContain('- 第一项')
    expect(outcome.content[0]?.text).toContain('如确认继续，请单独回复“确认”。')
    expect(publicResult).not.toMatch(/[A-Z]:[\\/]/)
    expect(publicResult).not.toContain('operationId')
  })

  it('CONFIRM 越过两轮门后不接受本地取消或超时信号', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_REPORT_DOCX_PUBLISHED',
        receipt: {
          receiptVersion: 1,
          sectionCount: 1,
          paragraphCount: 1,
          bulletCount: 1,
          characterCount: 24,
          outputSha256: 'b'.repeat(64),
          publishedAtLocal: '2026-08-27T16:00:00.000+08:00',
        },
      },
    })
    const execute = loadTool()?.execute as unknown as Execute

    await execute('tool-2', { action: 'CONFIRM' }, new AbortController().signal)

    expect(requestWorkerHostToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'xiaogui.work.report-docx.v1',
        payload: expect.objectContaining({ action: 'CONFIRM' }),
      }),
      undefined,
    )
  })
})
