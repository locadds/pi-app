import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ExtensionContext,
  LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'
import { TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1 } from '@shared/xiaogui-prompt-capabilities'
import {
  TEMPLATE_INTAKE_RISK_FLAG_LABELS_V1,
  TEMPLATE_INTAKE_RISK_FLAGS_V1,
  type TemplateIntakeReportV1,
} from '@shared/xiaogui-work-docx-template-intake'

import {
  __test,
  addXiaoguiWorkDocxTemplateIntakeTool,
  XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_TOOL_NAME,
} from './xiaogui-work-docx-template-intake-tool'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())
const requestTemplateIntakeReviewMock = vi.hoisted(() => vi.fn())

it('provides a validator-valid VARIABLE example with its required suggestedName', () => {
  const prompt = TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.systemPrompt
  const example = prompt.split('\n').find((line) => line.startsWith('只返回严格 JSON：'))!
  const raw = example.slice('只返回严格 JSON：'.length)
  const parsed = JSON.parse(raw)
  expect(parsed.suggestions.some((item: { kind: string }) => item.kind === 'VARIABLE')).toBe(true)
  const fragments = [
    { fragmentId: 'F001', kind: 'PARAGRAPH' as const, anchor: { part: 'BODY' as const, paragraphIndex: 1 }, text: '项目名称：示例项目甲' },
    { fragmentId: 'F002', kind: 'PARAGRAPH' as const, anchor: { part: 'BODY' as const, paragraphIndex: 2 }, text: '签字：张三' },
  ]
  expect(__test.validateSuggestions(raw, fragments)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'VARIABLE', suggestedName: '项目名称' }),
  ]))
})

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

function modelResponse(text: string, stopReason = 'stop') {
  return {
    content: [{ type: 'text', text }],
    stopReason,
    usage: {},
  }
}

function context(
  complete = vi.fn(),
  model: Record<string, unknown> = { provider: 'test', id: 'model' },
): ExtensionContext {
  return {
    ui: {},
    model,
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
  it('uses a separately versioned analysis Prompt and rejects invalid structured output explicitly', () => {
    expect(TEMPLATE_INTAKE_RISK_FLAGS_V1).toEqual([
      'SIGNATURE',
      'SEAL',
      'CONTACT_INFORMATION',
      'OLD_PROJECT_DRAWING',
      'SCANNED_ATTACHMENT',
      'FLOATING_OBJECT',
      'TEXT_BOX',
      'OTHER',
    ])
    expect(TEMPLATE_INTAKE_RISK_FLAG_LABELS_V1).toEqual({
      SIGNATURE: '签字',
      SEAL: '印章',
      CONTACT_INFORMATION: '联系方式',
      OLD_PROJECT_DRAWING: '旧项目图件',
      SCANNED_ATTACHMENT: '扫描附件',
      FLOATING_OBJECT: '浮动对象',
      TEXT_BOX: '文本框',
      OTHER: '其他',
    })
    expect(TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.id)
      .toBe('template-intake-analysis')
    expect(TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.version).toBe('1.2.2')
    expect(TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.systemPrompt)
      .toContain('template-intake-analysis@1.2.2')
    expect(TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.systemPrompt)
      .toContain('occurrence 仅限 SELECTION 使用')
    expect(TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.systemPrompt)
      .toContain('WHOLE_FRAGMENT 必须同时省略 selectedText 和 occurrence')
    expect(TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.systemPrompt)
      .toContain('未提到的原文默认保留')
    expect(TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.systemPrompt)
      .toContain('签字 SIGNATURE、印章 SEAL、联系方式 CONTACT_INFORMATION、旧项目图件 OLD_PROJECT_DRAWING、扫描附件 SCANNED_ATTACHMENT、浮动对象 FLOATING_OBJECT、文本框 TEXT_BOX、其他 OTHER')
    expect(TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.systemPrompt)
      .toContain('没有对应风险时 riskFlags 必须为空数组')
    expect(TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.systemPrompt)
      .toContain('"riskFlags":["SIGNATURE"]')
    expect(JSON.stringify(loadTool()?.parameters))
      .toContain('风险代码：签字 SIGNATURE、印章 SEAL、联系方式 CONTACT_INFORMATION、旧项目图件 OLD_PROJECT_DRAWING、扫描附件 SCANNED_ATTACHMENT、浮动对象 FLOATING_OBJECT、文本框 TEXT_BOX、其他 OTHER')

    const fragments = [{
      fragmentId: 'F001',
      kind: 'PARAGRAPH' as const,
      anchor: { part: 'BODY' as const, paragraphIndex: 1 },
      text: '项目名称：下盐公路工程（一期）',
    }]

    expect(() => __test.validateSuggestions('not json', fragments))
      .toThrow('MODEL_JSON_INVALID')
    expect(() => __test.validateSuggestions(JSON.stringify({
      suggestions: [{
        fragmentIds: ['F999'],
        scope: 'SELECTION',
        selectedText: '下盐公路工程',
        kind: 'VARIABLE',
        reason: '项目名称每次使用时变化',
        confidence: 0.9,
        suggestedName: '项目名称',
      }],
    }), fragments)).toThrow('MODEL_FRAGMENT_UNKNOWN')

    expect(__test.validateSuggestions(JSON.stringify({
      suggestions: [{
        fragmentIds: ['F001'],
        scope: 'SELECTION',
        selectedText: '下盐公路工程',
        kind: 'VARIABLE',
        reason: '项目名称每次使用时变化',
        confidence: 0.97,
        suggestedName: '项目名称',
        riskFlags: ['OTHER'],
      }],
    }), fragments)).toEqual([expect.objectContaining({
      fragmentIds: ['F001'],
      scope: 'SELECTION',
      riskFlags: ['OTHER'],
      selection: {
        originalText: '下盐公路工程',
        startUtf16: 5,
        endUtf16Exclusive: 11,
      },
    })])
    expect(() => __test.validateSuggestions(JSON.stringify({
      suggestions: [{
        fragmentIds: ['F001'],
        scope: 'SELECTION',
        selectedText: '下盐公路工程',
        kind: 'VARIABLE',
        reason: '项目名称每次使用时变化',
        confidence: 0.97,
        suggestedName: '项目名称',
        riskFlags: ['STAMP'],
      }],
    }), fragments)).toThrow('MODEL_SCHEMA_INVALID')

    // 模型不必穷举固定段落；没有建议即表示原文保留。
    expect(__test.validateSuggestions('{"suggestions":[]}', fragments)).toEqual([])

    const repeated = [{ ...fragments[0], text: '项目简称：小规；曾用简称：小规' }]
    const ambiguous = {
      suggestions: [{
        fragmentIds: ['F001'],
        scope: 'SELECTION',
        selectedText: '小规',
        kind: 'VARIABLE',
        reason: '简称随项目变化',
        confidence: 0.9,
        suggestedName: '项目简称',
      }],
    }
    expect(() => __test.validateSuggestions(JSON.stringify(ambiguous), repeated))
      .toThrow('MODEL_SELECTION_NOT_FOUND')
    expect(__test.validateSuggestions(JSON.stringify({
      suggestions: [{ ...ambiguous.suggestions[0], occurrence: 2 }],
    }), repeated)[0]?.selection).toEqual({
      originalText: '小规',
      startUtf16: 13,
      endUtf16Exclusive: 15,
    })
  })

  it('is a hidden natural-language intake ending at a read-only report', () => {
    const tool = loadTool()

    expect(tool?.label).toBe('整理普通成品文档模板')
    expect(tool?.promptGuidelines?.join('\n')).toContain('必须先询问是否整理')
    expect(tool?.promptGuidelines?.join('\n')).toContain('不得声称已经写入原文档')
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
      .mockResolvedValueOnce(modelResponse(JSON.stringify({
        suggestions: [{
          fragmentIds: ['F001'],
          scope: 'SELECTION',
          selectedText: '旧项目',
          kind: 'VARIABLE',
          reason: '不同项目需要替换',
          confidence: 0.9,
          suggestedName: '项目名称',
          riskFlags: ['STAMP'],
        }],
      })))
      .mockResolvedValueOnce(
        modelResponse(
          JSON.stringify({
            suggestions: [
              {
                fragmentIds: ['F001'],
                scope: 'SELECTION',
                selectedText: '旧项目',
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
      expect(call[1].systemPrompt).toBe(TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.systemPrompt)
      expect(call[2]).toMatchObject({ cacheRetention: 'none' })
      expect(call[2].sessionId).toEqual(expect.any(String))
    }
    expect(complete.mock.calls[1]?.[1].messages[0]?.content[0]?.text)
      .toContain('riskFlags 只能使用以下合法值')
    expect(complete.mock.calls[1]?.[1].messages[0]?.content[0]?.text)
      .toContain('其他 OTHER')
    expect(complete.mock.calls[1]?.[1].messages[0]?.content[0]?.text)
      .toContain('MODEL_SCHEMA_INVALID')
    expect(complete.mock.calls[1]?.[1].messages[0]?.content[0]?.text)
      .toContain('<fragment id="F001" kind="PARAGRAPH">\n项目名称：旧项目\n</fragment>')
    const secondHostPayload = requestWorkerHostToolMock.mock.calls[1]?.[0]?.payload
    expect(secondHostPayload.analysis).toMatchObject({ status: 'COMPLETE' })
    const published = JSON.stringify(result)
    expect(published).toContain('方案文本.docx')
    expect(published).not.toContain('项目名称：旧项目')
    expect(published).not.toContain('signed-fragment-1')
    expect(published).not.toMatch(/[A-Z]:[\\/]/)
    expect(result.content[0]?.text).toContain('没有修改文档')
    expect(result.content[0]?.text).toContain('已生成模板整理报告（只读）')
    expect(result.content[0]?.text).not.toContain('只读模板整理报告')
    expect(result.content[0]?.text)
      .toContain('如需开始人工复核，请单独回复“复核”或“打开复核卡”。')
  })

  it.each([
    { occurrence: 1 }, { selectedText: '合成材料说明' }, { selectedText: '合成材料说明', occurrence: 1 },
  ])('rejects selection-only fields on WHOLE_FRAGMENT: %o', (fields) => {
    const fragments = [{
      fragmentId: 'F001', kind: 'PARAGRAPH' as const,
      anchor: { part: 'BODY' as const, paragraphIndex: 1 }, text: '合成材料说明',
    }]
    const whole = { fragmentIds: ['F001'], scope: 'WHOLE_FRAGMENT', kind: 'EXCLUDE', reason: '合成说明应移除', confidence: 0.9 }
    expect(() => __test.validateSuggestions(JSON.stringify({ suggestions: [{ ...whole, ...fields }] }), fragments))
      .toThrow('MODEL_SCHEMA_WHOLE_FRAGMENT_FIELDS')
    expect(__test.validateSuggestions(JSON.stringify({ suggestions: [whole] }), fragments))
      .toEqual([whole])
  })

  it('repairs WHOLE_FRAGMENT occurrence with the concrete error and original aliased source', async () => {
    const whole = { fragmentIds: ['F001'], scope: 'WHOLE_FRAGMENT', kind: 'EXCLUDE', reason: '合成说明应移除', confidence: 0.9 }
    const complete = vi.fn()
      .mockResolvedValueOnce(modelResponse(JSON.stringify({ suggestions: [{ ...whole, occurrence: 1 }] })))
      .mockResolvedValueOnce(modelResponse(JSON.stringify({ suggestions: [whole] })))
    const result = await __test.analyzeBatches(context(complete), [{
      batchIndex: 1, characterCount: 6,
      fragments: [{ fragmentId: 'source-1', kind: 'PARAGRAPH', anchor: { part: 'BODY', paragraphIndex: 1 }, text: '合成材料说明' }],
    }], undefined)
    expect(complete).toHaveBeenCalledTimes(2)
    const repair = complete.mock.calls[1]![1].messages[0].content[0].text
    expect(repair).toContain('MODEL_SCHEMA_WHOLE_FRAGMENT_FIELDS')
    expect(repair).toContain('WHOLE_FRAGMENT 必须同时省略 selectedText 和 occurrence')
    expect(repair).toContain('<fragment id="F001" kind="PARAGRAPH">\n合成材料说明\n</fragment>')
    expect(repair).not.toContain('source-1')
    expect(result).toMatchObject({ status: 'COMPLETE', suggestions: [{ ...whole, fragmentIds: ['source-1'] }] })
  })

  it('repairs a missing suggestedName with the exact suggestion index and kind', async () => {
    const missingSuggestedName = {
      fragmentIds: ['F001'], scope: 'SELECTION', selectedText: '旧项目', kind: 'VARIABLE',
      reason: '项目名称随项目变化', confidence: 0.9,
    }
    const repaired = { ...missingSuggestedName, suggestedName: '项目名称' }
    const complete = vi.fn()
      .mockResolvedValueOnce(modelResponse(JSON.stringify({ suggestions: [missingSuggestedName] })))
      .mockResolvedValueOnce(modelResponse(JSON.stringify({ suggestions: [repaired] })))
    const fragments = [{
      fragmentId: 'source-1', kind: 'PARAGRAPH' as const,
      anchor: { part: 'BODY' as const, paragraphIndex: 1 }, text: '项目名称：旧项目',
    }]

    expect(() => __test.validateSuggestions(JSON.stringify({ suggestions: [missingSuggestedName] }), [{
      ...fragments[0], fragmentId: 'F001',
    }])).toThrow('MODEL_SCHEMA_SUGGESTED_NAME_REQUIRED: suggestion[1] kind=VARIABLE')

    const result = await __test.analyzeBatches(context(complete), [{
      batchIndex: 1, characterCount: fragments[0].text.length, fragments,
    }], undefined)

    expect(complete).toHaveBeenCalledTimes(2)
    const repair = complete.mock.calls[1]![1].messages[0].content[0].text
    expect(repair).toContain('MODEL_SCHEMA_SUGGESTED_NAME_REQUIRED: suggestion[1] kind=VARIABLE')
    expect(result).toMatchObject({
      status: 'COMPLETE',
      suggestions: [{
        fragmentIds: ['source-1'],
        scope: 'SELECTION',
        selection: { originalText: '旧项目', startUtf16: 5, endUtf16Exclusive: 8 },
        kind: 'VARIABLE',
        reason: '项目名称随项目变化',
        confidence: 0.9,
        suggestedName: '项目名称',
      }],
    })
  })

  it('safely degrades when repair still omits a required suggestedName', async () => {
    const invalid = JSON.stringify({ suggestions: [{
      fragmentIds: ['F001'], scope: 'SELECTION', selectedText: '旧项目', kind: 'VARIABLE',
      reason: '项目名称随项目变化', confidence: 0.9,
    }] })
    const complete = vi.fn()
      .mockResolvedValueOnce(modelResponse(invalid))
      .mockResolvedValueOnce(modelResponse(invalid))

    const result = await __test.analyzeBatches(context(complete), [{
      batchIndex: 1, characterCount: 7,
      fragments: [{
        fragmentId: 'source-1', kind: 'PARAGRAPH',
        anchor: { part: 'BODY', paragraphIndex: 1 }, text: '项目名称：旧项目',
      }],
    }], undefined)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ status: 'DEGRADED', warning: { code: 'MODEL_OUTPUT_INVALID' } })
    expect(result).not.toHaveProperty('suggestions')
  })

  it('uses only one repair across batches and fails closed when a later batch is invalid', async () => {
    const invalid = JSON.stringify({ suggestions: [{
      fragmentIds: ['F001'], scope: 'WHOLE_FRAGMENT', occurrence: 1, kind: 'EXCLUDE', reason: '移除说明', confidence: 0.9,
    }] })
    const complete = vi.fn()
      .mockResolvedValueOnce(modelResponse(invalid))
      .mockResolvedValueOnce(modelResponse('{"suggestions":[]}'))
      .mockResolvedValueOnce(modelResponse(invalid))
    const batches = [1, 2].map((index) => ({
      batchIndex: index, characterCount: 6,
      fragments: [{ fragmentId: `source-${index}`, kind: 'PARAGRAPH' as const, anchor: { part: 'BODY' as const, paragraphIndex: index }, text: '合成材料说明' }],
    }))
    const result = await __test.analyzeBatches(context(complete), batches, undefined)
    expect(complete).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ status: 'DEGRADED', warning: { code: 'MODEL_OUTPUT_INVALID' } })
    expect(result).not.toHaveProperty('suggestions')
  })

  it.each([
    'invalid JSON', 'selection not found', 'selection overlap', 'provider unavailable',
  ])('classifies analysis failure after one repair: %s', async (failure) => {
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
    const selection = {
      fragmentIds: ['F001'], scope: 'SELECTION', selectedText: '正文',
      kind: 'VARIABLE', suggestedName: '内容', reason: '内容随项目变化', confidence: 0.9,
    }
    const repaired = failure === 'invalid JSON'
      ? 'still invalid'
      : JSON.stringify({ suggestions: failure === 'selection not found'
        ? [{ ...selection, selectedText: '不存在的文字' }]
        : [selection, selection] })
    const complete = vi
      .fn()
      .mockResolvedValueOnce(modelResponse('invalid'))
    if (failure === 'provider unavailable') {
      complete.mockRejectedValueOnce(new Error('PROVIDER_REQUEST_FAILED'))
    } else {
      complete.mockResolvedValueOnce(modelResponse(repaired))
    }
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
        code: failure === 'provider unavailable' ? 'MODEL_UNAVAILABLE' : 'MODEL_OUTPUT_INVALID',
        message: failure === 'provider unavailable'
          ? '临时模型分析不可用，已安全降级'
          : '模型输出经一次修复后仍不符合要求，已安全降级',
      },
    })
  })

  it('uses compact aliases and one whole-document call when the selected model can hold it', async () => {
    const fragmentIds = Array.from(
      { length: 131 },
      (_, index) => `xgtif1_${String(index + 1).padStart(3, '0')}_${'a'.repeat(48)}`,
    )
    const fragments = fragmentIds.map((fragmentId, index) => ({
      fragmentId,
      kind: 'PARAGRAPH' as const,
      anchor: { part: 'BODY' as const, paragraphIndex: index + 1 },
      text: `第 ${index + 1} 段项目内容`,
    }))
    requestWorkerHostToolMock
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED',
          reportId: 'report-large',
          fileDisplayName: '长篇方案.docx',
          deterministicWarnings: [],
          analysisBatches: [
            { batchIndex: 1, characterCount: 1_000, fragments: fragments.slice(0, 80) },
            { batchIndex: 2, characterCount: 800, fragments: fragments.slice(80) },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY',
          report: REPORT,
          draftDecisions: [],
        },
      })
    const aliases = fragmentIds.map((_, index) => `F${String(index + 1).padStart(3, '0')}`)
    const complete = vi.fn().mockResolvedValue(
      modelResponse(
        JSON.stringify({
          suggestions: [
            {
              fragmentIds: aliases,
              scope: 'WHOLE_FRAGMENT',
              kind: 'FIXED',
              reason: '全文结构中的通用固定内容',
              confidence: 0.9,
            },
          ],
        }),
      ),
    )
    const execute = loadTool()?.execute as unknown as Execute

    await execute(
      'call-large',
      { action: 'START' },
      new AbortController().signal,
      undefined,
      context(complete, {
        provider: 'kimi-coding',
        id: 'k3-256k',
        contextWindow: 262_144,
        maxTokens: 131_072,
      }),
    )

    expect(complete).toHaveBeenCalledTimes(1)
    const prompt = String(complete.mock.calls[0]?.[1]?.messages?.[0]?.content?.[0]?.text)
    expect(prompt).toContain('F001')
    expect(prompt).toContain('F131')
    expect(prompt).toContain('未输出的原文自动保留')
    expect(prompt).not.toContain(fragmentIds[0])
    expect(complete.mock.calls[0]?.[2]?.maxTokens).toBeGreaterThan(4_096)
    expect(
      requestWorkerHostToolMock.mock.calls[1]?.[0]?.payload.analysis.suggestions[0].fragmentIds,
    ).toEqual(fragmentIds)
  })

  it('classifies length-truncated JSON as invalid model output instead of unavailable model', async () => {
    requestWorkerHostToolMock
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED',
          reportId: 'report-truncated',
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
          report: REPORT,
          draftDecisions: [],
        },
      })
    const truncated =
      '{"suggestions":[{"fragmentIds":["F001"],"scope":"WHOLE_FRAGMENT","kind":"FIXED","reason":"固定","confidence":0.9}'
    const complete = vi
      .fn()
      .mockResolvedValueOnce(modelResponse(truncated, 'length'))
      .mockResolvedValueOnce(modelResponse(truncated, 'length'))
    const execute = loadTool()?.execute as unknown as Execute

    await execute(
      'call-truncated',
      { action: 'START' },
      new AbortController().signal,
      undefined,
      context(complete),
    )

    expect(complete).toHaveBeenCalledTimes(2)
    expect(requestWorkerHostToolMock.mock.calls[1]?.[0]?.payload.analysis.warning.code).toBe(
      'MODEL_OUTPUT_INVALID',
    )
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
      actions: [{ targetId: 'candidate-1', kind: 'FIELD', fieldName: '项目名称' }],
      issueChoicesV2: [{
        issueId: 'issue-1',
        action: 'ACCEPT_SUGGESTION',
        reason: '本机用户已确认字段建议',
      }],
      confirmedAtLocal: '2026-08-24T16:09:00+08:00',
      confirmedBy: 'LOCAL_USER',
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
      expect.objectContaining({
        reviewVersion: 2,
        document: expect.objectContaining({ reviewId: 'report-1', status: 'REVIEWING' }),
        targets: [expect.objectContaining({ targetId: 'candidate-1' })],
      }),
      expect.any(AbortSignal),
    )
    expect(requestWorkerHostToolMock.mock.calls[1]?.[0]?.payload).toMatchObject({
      action: 'REVIEW',
      submission: {
        decisions: [{ candidateId: 'candidate-1', decision: 'VARIABLE', fieldName: '项目名称' }],
        reviewActionsV2: [{ targetId: 'candidate-1', kind: 'FIELD', fieldName: '项目名称' }],
        issueChoicesV2: [{
          issueId: 'issue-1',
          action: 'ACCEPT_SUGGESTION',
          reason: '本机用户已确认字段建议',
        }],
      },
    })
    expect(result.content[0]?.text).toContain('没有修改文档')
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
    requestTemplateIntakeReviewMock.mockResolvedValue({
      cancelled: true,
      draftActions: [{ targetId: 'candidate-1', kind: 'FIELD', fieldName: '项目名称' }],
    })
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
        {
          candidateIds: ['candidate-1'],
          decision: 'VARIABLE',
          fieldName: '项目名称',
          reviewActionsV2: [
            { targetId: 'candidate-1', kind: 'FIELD', fieldName: '项目名称' },
          ],
        },
      ],
    })
    expect(result.content[0]?.text).toContain('草稿仍保留')
  })
})
