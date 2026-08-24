import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ExtensionContext,
  LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'
import type { TemplateIntakeReportV1 } from '@shared/xiaogui-work-docx-template-intake'

import {
  addXiaoguiWorkDocxTemplateIntakeTool,
  XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_TOOL_NAME,
} from './xiaogui-work-docx-template-intake-tool'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())
const requestTemplateIntakeReviewMock = vi.hoisted(() => vi.fn())

vi.mock('./worker-host-tool-channel.js', () => ({
  requestWorkerHostTool: requestWorkerHostToolMock,
}))

vi.mock('./desktop-ui-bridge.js', () => ({
  getDesktopUIBridge: () => ({
    requestTemplateIntakeReview: requestTemplateIntakeReviewMock,
  }),
}))

const REPORT: TemplateIntakeReportV1 = {
  reportVersion: 1,
  reportId: 'report-1',
  status: 'DRAFT',
  file: { displayName: '方案文本.docx', sha256: 'a'.repeat(64), byteLength: 1234 },
  profile: {
    pageCount: { value: null, basis: 'UNKNOWN' },
    sectionCount: 1,
    headerPartCount: 0,
    footerPartCount: 0,
    tableCount: 0,
    mediaCount: 0,
    inlineDrawingCount: 0,
    floatingDrawingCount: 0,
    textBoxCount: 0,
    fieldCount: 0,
    contentControlCount: 0,
    scannedPageCount: null,
  },
  versions: {
    safetyGate: 'xiaogui-docx-safety.v1',
    structureParser: 'jszip@3.10.1',
    semanticParser: 'officeparser@7.8.0',
    rules: 'xiaogui-template-intake-rules.v1',
    model: 'test/model',
  },
  warnings: [],
  candidates: [
    {
      candidateId: 'candidate-1',
      kind: 'VARIABLE',
      preview: '项目名称',
      sourceAnchors: [{ part: 'BODY', paragraphIndex: 1 }],
      reason: '不同项目需要替换',
      confidence: 0.9,
      riskFlags: [],
      defaultDecision: 'VARIABLE',
      suggestedName: '项目名称',
    },
  ],
  requiresHumanConfirmation: true,
  canMaterializeTemplate: false,
  createdAt: '2026-08-24T16:00:00+08:00',
  updatedAt: '2026-08-24T16:00:00+08:00',
}

function loadTool() {
  const base = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
  const result = addXiaoguiWorkDocxTemplateIntakeTool(base, {
    getSourceSessionId: () => 'session-1',
    getSourceRunId: () => 'run-1',
  })
  return result.extensions[0]?.tools.get(XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_TOOL_NAME)?.definition
}

function modelResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: {},
  }
}

function context(complete = vi.fn()): ExtensionContext {
  return {
    ui: {},
    model: { provider: 'test', id: 'model' },
    modelRegistry: { complete },
  } as unknown as ExtensionContext
}

type Execute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  onUpdate: undefined,
  context: ExtensionContext,
) => Promise<{
  content: Array<{ type: string; text: string }>
  details: unknown
  isError?: boolean
}>

beforeEach(() => {
  requestWorkerHostToolMock.mockReset()
  requestTemplateIntakeReviewMock.mockReset()
})

describe('xiaogui WORK finished-DOCX intake tool', () => {
  it('is a hidden natural-language intake ending at a read-only report', () => {
    const tool = loadTool()

    expect(tool?.label).toBe('整理普通 Word 模板')
    expect(tool?.promptGuidelines?.join('\n')).toContain('必须先询问是否整理')
    expect(tool?.promptGuidelines?.join('\n')).toContain('不得声称已经写入 Word')
  })

  it('uses one transient repair call and never publishes full fragments or paths', async () => {
    requestWorkerHostToolMock
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED',
          reportId: 'report-1',
          fileDisplayName: '方案文本.docx',
          deterministicWarnings: [],
          analysisBatches: [
            {
              batchIndex: 1,
              characterCount: 8,
              fragments: [
                {
                  fragmentId: 'signed-fragment-1',
                  kind: 'PARAGRAPH',
                  anchor: { part: 'BODY', paragraphIndex: 1 },
                  text: '项目名称：旧项目',
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY',
          report: REPORT,
          draftDecisions: [{ candidateId: 'candidate-1', decision: 'VARIABLE' }],
        },
      })
    const complete = vi
      .fn()
      .mockResolvedValueOnce(modelResponse('{not-json'))
      .mockResolvedValueOnce(
        modelResponse(
          JSON.stringify({
            suggestions: [
              {
                fragmentIds: ['signed-fragment-1'],
                kind: 'VARIABLE',
                reason: '不同项目需要替换',
                confidence: 0.9,
                suggestedName: '项目名称',
              },
            ],
          }),
        ),
      )
    const execute = loadTool()?.execute as unknown as Execute

    const result = await execute(
      'call-start',
      { action: 'START' },
      new AbortController().signal,
      undefined,
      context(complete),
    )

    expect(complete).toHaveBeenCalledTimes(2)
    for (const call of complete.mock.calls) {
      expect(call[2]).toMatchObject({ cacheRetention: 'none' })
      expect(call[2].sessionId).toEqual(expect.any(String))
    }
    const secondHostPayload = requestWorkerHostToolMock.mock.calls[1]?.[0]?.payload
    expect(secondHostPayload.analysis).toMatchObject({ status: 'COMPLETE' })
    const published = JSON.stringify(result)
    expect(published).toContain('方案文本.docx')
    expect(published).not.toContain('项目名称：旧项目')
    expect(published).not.toContain('signed-fragment-1')
    expect(published).not.toMatch(/[A-Z]:[\\/]/)
    expect(result.content[0]?.text).toContain('没有修改 Word')
  })

  it('repairs only once then safely degrades invalid model output', async () => {
    requestWorkerHostToolMock
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED',
          reportId: 'report-1',
          fileDisplayName: '方案文本.docx',
          deterministicWarnings: [],
          analysisBatches: [
            {
              batchIndex: 1,
              characterCount: 4,
              fragments: [
                {
                  fragmentId: 'fragment-1',
                  kind: 'PARAGRAPH',
                  anchor: { part: 'BODY', paragraphIndex: 1 },
                  text: '正文',
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY',
          report: { ...REPORT, versions: { ...REPORT.versions, model: 'test/model' } },
          draftDecisions: [{ candidateId: 'candidate-1', decision: 'UNRESOLVED' }],
        },
      })
    const complete = vi
      .fn()
      .mockResolvedValueOnce(modelResponse('invalid'))
      .mockResolvedValueOnce(modelResponse('still invalid'))
    const execute = loadTool()?.execute as unknown as Execute

    await execute(
      'call-degrade',
      { action: 'START' },
      new AbortController().signal,
      undefined,
      context(complete),
    )

    expect(complete).toHaveBeenCalledTimes(2)
    expect(requestWorkerHostToolMock.mock.calls[1]?.[0]?.payload.analysis).toEqual({
      status: 'DEGRADED',
      modelVersion: 'test/model',
      warning: {
        code: 'MODEL_OUTPUT_INVALID',
        message: '模型输出经一次修复后仍不符合要求，已安全降级',
      },
    })
  })

  it('opens review only on REVIEW and submits the complete UI result', async () => {
    const draftDecisions = [{ candidateId: 'candidate-1', decision: 'VARIABLE' as const }]
    requestWorkerHostToolMock
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REVIEW_REQUIRED',
          report: { ...REPORT, status: 'REVIEWING' },
          draftDecisions,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CONFIRMED',
          decision: {
            decisionVersion: 1,
            reportId: 'report-1',
            reportSummary: {
              reportId: 'report-1',
              fileDisplayName: '方案文本.docx',
              fileSha256: 'a'.repeat(64),
              candidateCount: 1,
              warningCount: 0,
            },
            decisions: [{ candidateId: 'candidate-1', decision: 'VARIABLE', fieldName: '项目名称' }],
            confirmedAtLocal: '2026-08-24T16:10:00+08:00',
            confirmedBy: 'LOCAL_USER',
          },
        },
      })
    requestTemplateIntakeReviewMock.mockResolvedValue({
      cancelled: false,
      decisions: [{ candidateId: 'candidate-1', decision: 'VARIABLE', fieldName: '项目名称' }],
    })
    const execute = loadTool()?.execute as unknown as Execute

    const result = await execute(
      'call-review',
      { action: 'REVIEW' },
      new AbortController().signal,
      undefined,
      context(),
    )

    expect(requestTemplateIntakeReviewMock).toHaveBeenCalledWith(
      'call-review',
      { report: { ...REPORT, status: 'REVIEWING' }, draftDecisions, pageSize: 20 },
      expect.any(AbortSignal),
    )
    expect(requestWorkerHostToolMock.mock.calls[1]?.[0]?.payload).toMatchObject({
      action: 'REVIEW',
      submission: {
        decisions: [{ candidateId: 'candidate-1', decision: 'VARIABLE', fieldName: '项目名称' }],
      },
    })
    expect(result.content[0]?.text).toContain('没有修改 Word')
  })

  it('persists review-card draft decisions when the user closes without confirming', async () => {
    const draftDecisions = [
      { candidateId: 'candidate-1', decision: 'VARIABLE' as const, fieldName: '项目名称' },
    ]
    requestWorkerHostToolMock
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REVIEW_REQUIRED',
          report: REPORT,
          draftDecisions: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED',
          report: REPORT,
          draftDecisions,
        },
      })
    requestTemplateIntakeReviewMock.mockResolvedValue({ cancelled: true, draftDecisions })
    const execute = loadTool()?.execute as unknown as Execute

    const result = await execute(
      'call-review-cancel',
      { action: 'REVIEW' },
      new AbortController().signal,
      undefined,
      context(),
    )

    expect(requestWorkerHostToolMock.mock.calls[1]?.[0]?.payload).toMatchObject({
      action: 'UPDATE',
      operations: [
        { candidateIds: ['candidate-1'], decision: 'VARIABLE', fieldName: '项目名称' },
      ],
    })
    expect(result.content[0]?.text).toContain('草稿仍保留')
  })
})
