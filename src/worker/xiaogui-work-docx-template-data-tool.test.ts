import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'

import {
  addXiaoguiWorkDocxTemplateDataTool,
  XIAOGUI_WORK_DOCX_TOOL_NAME,
} from './xiaogui-work-docx-template-data-tool'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())

vi.mock('./worker-host-tool-channel.js', () => ({
  requestWorkerHostTool: requestWorkerHostToolMock,
}))

function loadTool() {
  const base = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
  const result = addXiaoguiWorkDocxTemplateDataTool(base, {
    getSourceSessionId: () => 'session-1',
    getSourceRunId: () => 'run-1',
  })
  return result.extensions[0]?.tools.get(XIAOGUI_WORK_DOCX_TOOL_NAME)?.definition
}

beforeEach(() => requestWorkerHostToolMock.mockReset())

describe('xiaogui WORK DOCX template-data Pi tool', () => {
  it('registers one natural-language template tool without a JSON workflow', () => {
    const tool = loadTool()

    expect(tool?.label).toBe('按模板生成文档')
    expect(tool?.description).toContain('当前对话整理字段')
    expect(tool?.description).not.toContain('JSON')
    expect(tool?.promptGuidelines?.join('\n')).toContain('不能猜测')
    expect(tool?.promptGuidelines?.join('\n')).toContain('不得同一轮调用 CONFIRM')
  })

  it('explains that an unmarked finished document needs template preparation', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_PREPARATION_REQUIRED',
        templateDisplayName: '方案文本.docx',
        templateSha256: 'a'.repeat(64),
        profile: {
          bodyPartCount: 1,
          sectionCount: 5,
          headerPartCount: 2,
          footerPartCount: 2,
          inlineDrawingCount: 19,
          floatingDrawingCount: 8,
          mediaCount: 20,
          fieldCount: 0,
        },
      },
    })
    const execute = loadTool()?.execute as unknown as (
      toolCallId: string,
      params: { action: 'SELECT_TEMPLATE' },
      signal: AbortSignal,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: { kind: string } }>

    const outcome = await execute(
      'call-select',
      { action: 'SELECT_TEMPLATE' },
      new AbortController().signal,
    )

    expect(requestWorkerHostToolMock).toHaveBeenCalledWith(
      {
        method: 'xiaogui.work.docx-template-data.v1',
        payload: {
          action: 'SELECT_TEMPLATE',
          sourceSessionId: 'session-1',
          sourceRunId: 'run-1',
          toolCallId: 'call-select',
        },
      },
      expect.any(AbortSignal),
    )
    expect(outcome.content[0]?.text).toContain('这是一份成品文档，需要先整理成模板')
    expect(outcome.content[0]?.text).toContain('没有选择保存位置')
    expect(outcome.content[0]?.text).not.toContain('aaaaaaaa')
    expect(outcome.content[0]?.text).not.toMatch(/[A-Z]:[\\/]/)
  })

  it('uses the exact historical library version named by the user without exposing its identifier', async () => {
    const versionId = 'xgtlv1_history-version'
    requestWorkerHostToolMock
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_LIBRARY_CHOICES',
          templates: [
            {
              entryId: 'xgtle1_weekly',
              name: '项目周报模板',
              purpose: '生成项目周报',
              tags: ['周报'],
              status: 'ACTIVE',
              latestVersion: {
                versionId: 'xgtlv1_latest-version',
                versionNumber: 2,
                isLatest: true,
                createdAt: '2026-08-28T08:00:00.000Z',
                byteLength: 1024,
                sha256: 'b'.repeat(64),
                fields: [],
              },
              versions: [
                {
                  versionId: 'xgtlv1_latest-version',
                  versionNumber: 2,
                  isLatest: true,
                  createdAt: '2026-08-28T08:00:00.000Z',
                  byteLength: 1024,
                  sha256: 'b'.repeat(64),
                  fields: [],
                },
                {
                  versionId,
                  versionNumber: 1,
                  isLatest: false,
                  createdAt: '2026-08-27T08:00:00.000Z',
                  byteLength: 1000,
                  sha256: 'c'.repeat(64),
                  fields: [],
                },
              ],
              createdAt: '2026-08-27T08:00:00.000Z',
              updatedAt: '2026-08-28T08:00:00.000Z',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_SELECTED',
          templateDisplayName: '项目周报模板（第 1 版）.docx',
          templateSha256: 'c'.repeat(64),
          fields: [
            {
              fieldId: 'xgfield2_project_name',
              name: '项目名称',
              required: true,
              occurrences: 1,
              locations: ['正文'],
            },
          ],
          profile: {
            bodyPartCount: 1,
            sectionCount: 1,
            headerPartCount: 0,
            footerPartCount: 0,
            inlineDrawingCount: 0,
            floatingDrawingCount: 0,
            mediaCount: 0,
            fieldCount: 1,
          },
        },
      })
    const execute = loadTool()?.execute as unknown as (
      toolCallId: string,
      params: {
        action: 'SELECT_TEMPLATE'
        libraryTemplateName: string
        libraryVersionNumber: number
      },
      signal: AbortSignal,
    ) => Promise<{
      content: Array<{ type: string; text: string }>
      details: { kind: string }
    }>

    const outcome = await execute(
      'call-history',
      {
        action: 'SELECT_TEMPLATE',
        libraryTemplateName: '项目周报模板',
        libraryVersionNumber: 1,
      },
      new AbortController().signal,
    )

    expect(requestWorkerHostToolMock).toHaveBeenNthCalledWith(
      2,
      {
        method: 'xiaogui.work.docx-template-data.v1',
        payload: {
          action: 'SELECT_TEMPLATE',
          templateVersionId: versionId,
          sourceSessionId: 'session-1',
          sourceRunId: 'run-1',
          toolCallId: 'call-history',
        },
      },
      expect.any(AbortSignal),
    )
    expect(outcome.details.kind).toBe('XIAOGUI_WORK_DOCX_TEMPLATE_SELECTED')
    expect(outcome.content[0]?.text).toContain('项目周报模板（第 1 版）')
    expect(JSON.stringify(outcome)).not.toContain(versionId)
    expect(JSON.stringify(outcome)).not.toMatch(/[A-Z]:[\\/]/)
  })
})
