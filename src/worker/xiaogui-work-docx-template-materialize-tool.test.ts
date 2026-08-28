import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'

import {
  addXiaoguiWorkDocxTemplateMaterializeTool,
  XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_TOOL_NAME,
} from './xiaogui-work-docx-template-materialize-tool'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())
const requestTemplateMaterializePreviewMock = vi.hoisted(() => vi.fn())

vi.mock('./worker-host-tool-channel.js', () => ({
  requestWorkerHostTool: requestWorkerHostToolMock,
}))
vi.mock('./desktop-ui-bridge.js', () => ({
  getDesktopUIBridge: () => ({
    requestTemplateMaterializePreview: requestTemplateMaterializePreviewMock,
  }),
}))

function loadTool() {
  const base = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
  const result = addXiaoguiWorkDocxTemplateMaterializeTool(base, {
    getSourceSessionId: () => 'session-1',
    getSourceRunId: () => 'run-1',
  })
  return result.extensions[0]?.tools.get(XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_TOOL_NAME)?.definition
}

beforeEach(() => {
  requestWorkerHostToolMock.mockReset()
  requestTemplateMaterializePreviewMock.mockReset()
})

describe('小规 WORK 正式模板物化隐藏工具', () => {
  it('只提供自然语言入口，并明确由内置预览完成最终确认', () => {
    const tool = loadTool()
    expect(tool?.label).toBe('生成正式文档模板')
    expect(tool?.promptGuidelines?.join('\n')).toContain('小规内置整份预览')
    expect(tool?.promptGuidelines?.join('\n')).toContain('当前简单字段生成器不会展开')
    expect(tool?.label).not.toMatch(/\bpi\b/i)
  })

  it('公开结果只给摘要，不泄露内部路径或操作编号', async () => {
    const plan = {
      materializeVersion: 1,
      reportSummary: { reportId: 'report-1', fileDisplayName: '原文档.docx', fileSha256: 'a'.repeat(64), candidateCount: 1, warningCount: 0 },
      source: { displayName: '原文档.docx', sha256: 'a'.repeat(64), byteLength: 1200 },
      previewSha256: 'b'.repeat(64),
      variables: [{ name: '项目名称', kind: 'VARIABLE', sourceAnchors: [] }],
      repeatBlocks: [{ name: '工作明细', kind: 'REPEAT', sourceAnchors: [] }],
      conditionalBlocks: [],
      excludedCandidateCount: 2,
      removedMediaCount: 1,
      retainedHighRiskCount: 0,
      warnings: [],
      requiresSecondConfirmation: true,
      originalSourceUnchanged: true,
      advancedGenerationRequired: true,
    } as const
    const preview = {
      previewVersion: 1,
      plan,
      suggestedTemplateName: '原文档模板',
      document: {
        reviewVersion: 2,
        reviewId: 'preview-1',
        status: 'PREVIEWING',
        source: { displayName: '原文档-模板.docx', sha256: plan.previewSha256, byteLength: 1300, inputFormat: 'DOCX' },
        render: { mode: 'PDF', pageCount: 1, pages: [{ pageNumber: 1, pageToken: 'opaque-page', widthPoints: 600, heightPoints: 800, textLayerAvailable: true }], warnings: [] },
        targetCount: 0,
        pendingTargetCount: 0,
        resolvedTargetCount: 0,
        unmappedTargetCount: 0,
        requiresHumanConfirmation: true,
        sourceReadOnly: true,
        createdAt: '2026-08-28T10:00:00+08:00',
        updatedAt: '2026-08-28T10:00:00+08:00',
      },
    } as const
    requestWorkerHostToolMock.mockResolvedValueOnce({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PREPARED',
        plan,
        preview,
        previewConfirmationToken: 'private-confirmation-token',
      },
    }).mockResolvedValueOnce({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PUBLISHED',
        receipt: {
          receiptVersion: 1,
          reportId: 'report-1',
          sourceSha256: 'a'.repeat(64),
          decisionSha256: 'c'.repeat(64),
          outputSha256: plan.previewSha256,
          variableNames: ['项目名称'],
          repeatBlockNames: ['工作明细'],
          conditionalBlockNames: [],
          excludedCandidateCount: 2,
          removedMediaCount: 1,
          originalSourceUnchanged: true,
          publishedAtLocal: '2026-08-28T10:01:00+08:00',
          library: { entryId: 'entry-1', versionId: 'version-1', versionNumber: 1, templateName: '原文档模板' },
        },
      },
    })
    requestTemplateMaterializePreviewMock.mockResolvedValue({
      action: 'CONFIRM',
      previewSha256: plan.previewSha256,
    })
    const execute = loadTool()?.execute as unknown as (
      toolCallId: string,
      params: { action: 'PREPARE' },
      signal: AbortSignal,
      onUpdate: unknown,
      context: { ui: object },
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: { kind: string } }>

    const outcome = await execute(
      'call-1',
      { action: 'PREPARE' },
      new AbortController().signal,
      undefined,
      { ui: {} },
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
    expect(requestTemplateMaterializePreviewMock).toHaveBeenCalledWith(
      'call-1',
      preview,
      expect.any(AbortSignal),
    )
    expect(requestWorkerHostToolMock).toHaveBeenLastCalledWith(
      {
        method: 'xiaogui.work.docx-template-materialize.v1',
        payload: expect.objectContaining({
          action: 'CONFIRM',
          previewConfirmationToken: 'private-confirmation-token',
          templateName: '原文档模板',
        }),
      },
      expect.any(AbortSignal),
    )
    expect(outcome.content[0]?.text).toContain('已保存到本机模板库')
    expect(outcome.content[0]?.text).not.toMatch(/[A-Z]:[\\/]/)
    expect(JSON.stringify(outcome.details)).not.toContain('operation')
    expect(JSON.stringify(outcome.details)).not.toContain('private-confirmation-token')
  })
})
