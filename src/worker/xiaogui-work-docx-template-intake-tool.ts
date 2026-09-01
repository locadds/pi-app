import { randomUUID } from 'node:crypto'

import {
  createSyntheticSourceInfo,
  defineTool,
  type Extension,
  type ExtensionContext,
  type LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { z } from 'zod'

import {
  TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1,
  TEMPLATE_INTAKE_RISK_FLAG_GUIDANCE_V1,
  XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1,
} from '@shared/xiaogui-prompt-capabilities'
import {
  type TemplateIntakeDraftDecisionItemV1,
  type TemplateIntakeReportV1,
  type TemplateIntakeUpdateOperationV1,
  TEMPLATE_INTAKE_RISK_FLAG_LABELS_V1,
  TEMPLATE_INTAKE_RISK_FLAGS_V1,
} from '@shared/xiaogui-work-docx-template-intake'
import { summarizeTemplateReviewActionsV2 } from '@shared/xiaogui-template-review-decisions'
import type { TemplateDraftReviewRequestV2 } from '@shared/xiaogui-template-draft-review'
import type {
  TemplateReviewActionV2,
  TemplateReviewRequestV2,
  TemplateReviewRequestV3,
  TemplateReviewResultV2,
  TemplateReviewRiskFlagV2,
  TemplateReviewSourceAnchorV2,
  TemplateReviewTargetV2,
} from '@shared/xiaogui-work-template-review'
import {
  XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_METHOD_V1,
  type TemplateIntakeAnalysisBatchV1,
  type TemplateIntakeAnalysisFragmentV1,
  type TemplateIntakeModelAnalysisV1,
  type TemplateIntakeModelSuggestionV1,
  type XiaoguiWorkDocxTemplateIntakeResultV1,
  type WorkerHostToolErrorCodeV1,
} from '@shared/worker-host-tools'

import { getDesktopUIBridge } from './desktop-ui-bridge.js'
import { requestWorkerHostTool } from './worker-host-tool-channel.js'

const TOOL_PROMPT = XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1.xiaogui_work_docx_template_intake
export const XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_TOOL_NAME = TOOL_PROMPT.name

const DecisionKindSchema = Type.Union([
  Type.Literal('FIXED'),
  Type.Literal('VARIABLE'),
  Type.Literal('REPEAT'),
  Type.Literal('CONDITIONAL'),
  Type.Literal('EXCLUDE'),
  Type.Literal('UNRESOLVED'),
])

const RiskFlagSchema = Type.Union(
  TEMPLATE_INTAKE_RISK_FLAGS_V1.map((flag) => Type.Literal(flag)),
)
const RiskFlagDescription = `风险代码：${TEMPLATE_INTAKE_RISK_FLAGS_V1
  .map((flag) => `${TEMPLATE_INTAKE_RISK_FLAG_LABELS_V1[flag]} ${flag}`)
  .join('、')}`

const UpdateFieldsSchema = {
  decision: DecisionKindSchema,
  fieldName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
}

const UpdateOperationSchema = Type.Object(
  {
    candidateIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
        minItems: 1,
        maxItems: 200,
        description: '与 match 二选一；仅在已经掌握主进程签发的候选编号时使用。',
      }),
    ),
    match: Type.Optional(
      Type.Object(
        {
          kinds: Type.Optional(
            Type.Array(DecisionKindSchema, {
              minItems: 1,
              maxItems: 6,
              description: '按当前候选分类匹配；同一数组内任一匹配即可',
            }),
          ),
          riskFlags: Type.Optional(
            Type.Array(RiskFlagSchema, {
              minItems: 1,
              maxItems: 8,
              description: RiskFlagDescription,
            }),
          ),
          keywords: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
              minItems: 1,
              maxItems: 20,
              description: '仅匹配短预览、判断理由和建议字段名；同一数组内任一匹配即可',
            }),
          ),
        },
        {
          additionalProperties: false,
          minProperties: 1,
          description: '与 candidateIds 二选一；不同匹配维度必须同时满足。',
        },
      ),
    ),
    ...UpdateFieldsSchema,
  },
  {
    additionalProperties: false,
    description: 'candidateIds 与 match 必须且只能提供一个，主进程会再次严格校验。',
  },
)

// 保持顶层 object，规避 OpenAI 兼容接口拒绝顶层 anyOf；动作专属字段
// 由主进程的版本化 Zod 契约继续严格校验。
const ActionSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal('START'),
      Type.Literal('UPDATE'),
      Type.Literal('REOPEN'),
      Type.Literal('REVIEW'),
      Type.Literal('RESUME'),
      Type.Literal('DELETE'),
      Type.Literal('CANCEL'),
    ]),
    operations: Type.Optional(
      Type.Array(UpdateOperationSchema, {
        minItems: 1,
        maxItems: 200,
        description: 'UPDATE 或 REOPEN 使用。',
      }),
    ),
    reportId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 160, description: 'RESUME 可选，DELETE 必填。' }),
    ),
    confirmed: Type.Optional(
      Type.Literal(true, { description: '仅 DELETE 使用；用户明确要求删除时必须为 true。' }),
    ),
  },
  { additionalProperties: false },
)

const ModelSuggestionSchema = z
  .object({
    fragmentIds: z.array(z.string().min(1).max(160)).min(1).max(200),
    scope: z.enum(['SELECTION', 'WHOLE_FRAGMENT']),
    selectedText: z.string().min(1).max(500).optional(),
    occurrence: z.number().int().min(1).max(1_000).optional(),
    kind: z.enum(['FIXED', 'VARIABLE', 'REPEAT', 'CONDITIONAL', 'EXCLUDE', 'UNRESOLVED']),
    reason: z.string().min(1).max(1_000),
    confidence: z.number().min(0).max(1).nullable(),
    suggestedName: z.string().min(1).max(120).optional(),
    riskFlags: z.array(z.enum(TEMPLATE_INTAKE_RISK_FLAGS_V1)).max(8).optional(),
  })
  .strict()

const ModelResponseSchema = z
  .object({ suggestions: z.array(ModelSuggestionSchema).max(200) })
  .strict()

export interface XiaoguiWorkDocxTemplateIntakeToolOptions {
  getSourceSessionId: () => string | undefined
  getSourceRunId: () => string | undefined
}

type SafeToolDetails =
  | Exclude<
      XiaoguiWorkDocxTemplateIntakeResultV1,
      { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED' }
    >
  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REVIEW_CANCELLED'
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_FAILED'
      code: WorkerHostToolErrorCodeV1
      message: string
      traceId?: string
    }

const INTAKE_RESULT_KINDS = new Set<XiaoguiWorkDocxTemplateIntakeResultV1['kind']>([
  'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_SELECTION_CANCELLED',
  'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED',
  'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY',
  'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED',
  'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REVIEW_REQUIRED',
  'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CONFIRMED',
  'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_RESUMED',
  'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_DELETED',
  'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CANCELLED',
])

function isTemplateIntakeResult(value: unknown): value is XiaoguiWorkDocxTemplateIntakeResultV1 {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === 'string' && INTAKE_RESULT_KINDS.has(kind as XiaoguiWorkDocxTemplateIntakeResultV1['kind'])
}

function extractText(response: {
  content: ReadonlyArray<{ type: string; text?: string }>
}): string {
  return response.content
    .filter((part): part is { type: 'text'; text: string } =>
      part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n')
}

function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text.trim())
  } catch {
    throw new Error('MODEL_JSON_INVALID')
  }
}

function validateSuggestions(
  rawText: string,
  fragments: readonly TemplateIntakeAnalysisFragmentV1[],
): readonly TemplateIntakeModelSuggestionV1[] {
  let parsed: z.infer<typeof ModelResponseSchema>
  try {
    parsed = ModelResponseSchema.parse(parseJsonValue(rawText))
  } catch (error) {
    if (error instanceof Error && error.message === 'MODEL_JSON_INVALID') throw error
    throw new Error('MODEL_SCHEMA_INVALID')
  }
  const fragmentsById = new Map(fragments.map((fragment) => [fragment.fragmentId, fragment]))
  const wholeFragments = new Set<string>()
  const rangesByFragment = new Map<string, Array<{ start: number; end: number }>>()
  const suggestions: TemplateIntakeModelSuggestionV1[] = []
  for (const suggestion of parsed.suggestions) {
    const unique = new Set(suggestion.fragmentIds)
    if (unique.size !== suggestion.fragmentIds.length) throw new Error('MODEL_FRAGMENT_DUPLICATED')
    for (const fragmentId of suggestion.fragmentIds) {
      if (!fragmentsById.has(fragmentId)) throw new Error('MODEL_FRAGMENT_UNKNOWN')
    }
    if (
      ['VARIABLE', 'REPEAT', 'CONDITIONAL'].includes(suggestion.kind) &&
      !suggestion.suggestedName?.trim()
    ) {
      throw new Error('MODEL_SCHEMA_INVALID')
    }
    if (suggestion.scope === 'SELECTION') {
      if (
        suggestion.fragmentIds.length !== 1 ||
        !suggestion.selectedText ||
        suggestion.kind === 'FIXED' ||
        suggestion.kind === 'REPEAT' ||
        suggestion.kind === 'CONDITIONAL'
      ) {
        throw new Error('MODEL_SCHEMA_INVALID')
      }
      const fragmentId = suggestion.fragmentIds[0]
      if (wholeFragments.has(fragmentId)) throw new Error('MODEL_FRAGMENT_DUPLICATED')
      const fragment = fragmentsById.get(fragmentId)!
      const matches: number[] = []
      let cursor = 0
      while (cursor <= fragment.text.length - suggestion.selectedText.length) {
        const index = fragment.text.indexOf(suggestion.selectedText, cursor)
        if (index < 0) break
        matches.push(index)
        cursor = index + Math.max(1, suggestion.selectedText.length)
      }
      const occurrence = suggestion.occurrence ?? (matches.length === 1 ? 1 : 0)
      const startUtf16 = occurrence > 0 ? matches[occurrence - 1] : undefined
      if (startUtf16 == null) throw new Error('MODEL_SELECTION_NOT_FOUND')
      const endUtf16Exclusive = startUtf16 + suggestion.selectedText.length
      const occupied = rangesByFragment.get(fragmentId) ?? []
      if (occupied.some((range) => startUtf16 < range.end && range.start < endUtf16Exclusive)) {
        throw new Error('MODEL_SELECTION_OVERLAP')
      }
      occupied.push({ start: startUtf16, end: endUtf16Exclusive })
      rangesByFragment.set(fragmentId, occupied)
      suggestions.push({
        fragmentIds: suggestion.fragmentIds,
        scope: 'SELECTION',
        selection: {
          originalText: suggestion.selectedText,
          startUtf16,
          endUtf16Exclusive,
        },
        kind: suggestion.kind,
        reason: suggestion.reason,
        confidence: suggestion.confidence,
        ...(suggestion.suggestedName ? { suggestedName: suggestion.suggestedName } : {}),
        ...(suggestion.riskFlags?.length ? { riskFlags: suggestion.riskFlags } : {}),
      })
      continue
    }
    if (suggestion.selectedText || suggestion.occurrence) throw new Error('MODEL_SCHEMA_INVALID')
    for (const fragmentId of suggestion.fragmentIds) {
      if (wholeFragments.has(fragmentId) || (rangesByFragment.get(fragmentId)?.length ?? 0) > 0) {
        throw new Error('MODEL_FRAGMENT_DUPLICATED')
      }
      wholeFragments.add(fragmentId)
    }
    suggestions.push({
      fragmentIds: suggestion.fragmentIds,
      scope: 'WHOLE_FRAGMENT',
      kind: suggestion.kind,
      reason: suggestion.reason,
      confidence: suggestion.confidence,
      ...(suggestion.suggestedName ? { suggestedName: suggestion.suggestedName } : {}),
      ...(suggestion.riskFlags?.length ? { riskFlags: suggestion.riskFlags } : {}),
    })
  }
  return suggestions
}

function batchPrompt(batch: TemplateIntakeAnalysisBatchV1): string {
  const fragments = batch.fragments
    .map(
      (fragment) =>
        `<fragment id="${fragment.fragmentId}" kind="${fragment.kind}">\n${fragment.text}\n</fragment>`,
    )
    .join('\n')
  return `下面是同一份普通成品文档按原文顺序排列的全部待分析片段。请先结合全文语境理解用途，再只输出需要变化、移除或人工判断的位置。未输出的原文自动保留。

优先使用 scope=SELECTION 并逐字复制最小连续原文到 selectedText；同一片段可以有多个互不重叠的建议。只有整块确实需要处理时才使用 scope=WHOLE_FRAGMENT。不要为了覆盖所有 fragment 而输出 FIXED。只输出 JSON。

${fragments}`
}

const MODEL_SYSTEM_PROMPT = TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.systemPrompt

const MIN_MODEL_OUTPUT_TOKENS = 8_192
const MAX_MODEL_OUTPUT_TOKENS = 32_768
const MODEL_CONTEXT_RESERVE_TOKENS = 8_192

interface AliasedAnalysisBatch {
  batch: TemplateIntakeAnalysisBatchV1
  aliasesToOriginalIds: ReadonlyMap<string, string>
}

class ModelOutputTruncatedError extends Error {
  readonly output: string

  constructor(output: string) {
    super('MODEL_OUTPUT_TRUNCATED')
    this.output = output
  }
}

function modelOutputTokenBudget(
  model: NonNullable<ExtensionContext['model']>,
  fragmentCount: number,
): number {
  const desired = Math.min(
    MAX_MODEL_OUTPUT_TOKENS,
    Math.max(MIN_MODEL_OUTPUT_TOKENS, 2_048 + fragmentCount * 192),
  )
  const declaredMaximum = Number.isFinite(model.maxTokens) && model.maxTokens > 0
    ? model.maxTokens
    : desired
  return Math.max(1, Math.floor(Math.min(desired, declaredMaximum)))
}

function aliasBatch(batch: TemplateIntakeAnalysisBatchV1): AliasedAnalysisBatch {
  const aliasesToOriginalIds = new Map<string, string>()
  const fragments = batch.fragments.map((fragment, index) => {
    const alias = `F${String(index + 1).padStart(3, '0')}`
    aliasesToOriginalIds.set(alias, fragment.fragmentId)
    return { ...fragment, fragmentId: alias }
  })
  return {
    batch: { ...batch, fragments },
    aliasesToOriginalIds,
  }
}

function mergeBatchesForWholeDocument(
  context: ExtensionContext,
  batches: readonly TemplateIntakeAnalysisBatchV1[],
): readonly TemplateIntakeAnalysisBatchV1[] {
  if (!context.model || batches.length <= 1) return batches
  const fragments = batches.flatMap((batch) => batch.fragments)
  if (fragments.length > 200) return batches
  const merged: TemplateIntakeAnalysisBatchV1 = {
    batchIndex: 1,
    characterCount: batches.reduce((total, batch) => total + batch.characterCount, 0),
    fragments,
  }
  const prompt = batchPrompt(aliasBatch(merged).batch)
  const conservativeInputTokens = MODEL_SYSTEM_PROMPT.length + prompt.length
  const requiredTokens =
    conservativeInputTokens +
    modelOutputTokenBudget(context.model, fragments.length) +
    MODEL_CONTEXT_RESERVE_TOKENS
  return context.model.contextWindow >= requiredTokens ? [merged] : batches
}

function restoreOriginalFragmentIds(
  suggestions: readonly TemplateIntakeModelSuggestionV1[],
  aliasesToOriginalIds: ReadonlyMap<string, string>,
): readonly TemplateIntakeModelSuggestionV1[] {
  return suggestions.map((suggestion) => ({
    ...suggestion,
    fragmentIds: suggestion.fragmentIds.map((alias) => {
      const originalId = aliasesToOriginalIds.get(alias)
      if (!originalId) throw new Error('MODEL_FRAGMENT_UNKNOWN')
      return originalId
    }),
  }))
}

async function completeBatch(
  context: ExtensionContext,
  batch: TemplateIntakeAnalysisBatchV1,
  signal: AbortSignal | undefined,
  repairInput?: string,
): Promise<string> {
  if (!context.model) throw new Error('MODEL_UNAVAILABLE')
  const userText = repairInput
    ? `上一份输出不符合结构、包含非法 riskFlags 或引用了不存在的片段编号。只修复格式和引用，不增加事实。\n${TEMPLATE_INTAKE_RISK_FLAG_GUIDANCE_V1}\n允许的片段编号：${batch.fragments.map((fragment) => fragment.fragmentId).join('、')}\n上一份输出：\n${repairInput.slice(0, 12_000)}`
    : batchPrompt(batch)
  const response = await context.modelRegistry.complete(
    context.model,
    {
      systemPrompt: MODEL_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: userText }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      maxTokens: modelOutputTokenBudget(context.model, batch.fragments.length),
      signal,
      cacheRetention: 'none',
      sessionId: randomUUID(),
    },
  )
  if (response.stopReason === 'aborted' || signal?.aborted) throw new Error('MODEL_ABORTED')
  const output = extractText(response)
  if (response.stopReason === 'length') throw new ModelOutputTruncatedError(output)
  return output
}

async function analyzeBatches(
  context: ExtensionContext,
  batches: readonly TemplateIntakeAnalysisBatchV1[],
  signal: AbortSignal | undefined,
): Promise<TemplateIntakeModelAnalysisV1> {
  if (!context.model) {
    return {
      status: 'DEGRADED',
      modelVersion: null,
      warning: { code: 'MODEL_UNAVAILABLE', message: '当前会话没有可用模型，已安全降级' },
    }
  }
  const modelVersion = `${context.model.provider}/${context.model.id}`

  const suggestions: TemplateIntakeModelSuggestionV1[] = []
  let repairUsed = false
  try {
    for (const sourceBatch of mergeBatchesForWholeDocument(context, batches)) {
      if (signal?.aborted) throw new Error('MODEL_ABORTED')
      const { batch, aliasesToOriginalIds } = aliasBatch(sourceBatch)
      let first: string
      try {
        first = await completeBatch(context, batch, signal)
      } catch (error) {
        if (!(error instanceof ModelOutputTruncatedError)) throw error
        if (repairUsed) throw new Error('MODEL_OUTPUT_INVALID')
        repairUsed = true
        const repaired = await completeBatch(context, batch, signal, error.output)
        suggestions.push(
          ...restoreOriginalFragmentIds(validateSuggestions(repaired, batch.fragments), aliasesToOriginalIds),
        )
        continue
      }
      try {
        suggestions.push(
          ...restoreOriginalFragmentIds(validateSuggestions(first, batch.fragments), aliasesToOriginalIds),
        )
      } catch {
        if (repairUsed) throw new Error('MODEL_OUTPUT_INVALID')
        repairUsed = true
        const repaired = await completeBatch(context, batch, signal, first)
        suggestions.push(
          ...restoreOriginalFragmentIds(validateSuggestions(repaired, batch.fragments), aliasesToOriginalIds),
        )
      }
    }
    return { status: 'COMPLETE', modelVersion, suggestions }
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.message === 'MODEL_ABORTED')) throw error
    const invalid =
      error instanceof z.ZodError ||
      (error instanceof Error &&
        ['MODEL_JSON_', 'MODEL_SCHEMA_', 'MODEL_FRAGMENT_', 'MODEL_OUTPUT_'].some((prefix) =>
          error.message.startsWith(prefix),
        ))
    return {
      status: 'DEGRADED',
      modelVersion,
      warning: {
        code: invalid ? 'MODEL_OUTPUT_INVALID' : 'MODEL_UNAVAILABLE',
        message: invalid
          ? '模型输出经一次修复后仍不符合要求，已安全降级'
          : '临时模型分析不可用，已安全降级',
      },
    }
  }
}

function reportText(report: TemplateIntakeReportV1, prefix: string): string {
  const counts = new Map<string, number>()
  for (const candidate of report.candidates) {
    counts.set(candidate.kind, (counts.get(candidate.kind) ?? 0) + 1)
  }
  const labels: Record<string, string> = {
    FIXED: '固定内容',
    VARIABLE: '可变字段',
    REPEAT: '重复块',
    CONDITIONAL: '条件块',
    EXCLUDE: '排除项',
    UNRESOLVED: '无法判断',
  }
  const groups = [...counts.entries()]
    .map(([kind, count]) => `${labels[kind] ?? kind} ${count} 项`)
    .join('，')
  return `${prefix}“${report.file.displayName}”：共 ${report.candidates.length} 项候选${groups ? `（${groups}）` : ''}，${report.warnings.length} 条警告。报告只读，仍需人工复核；没有修改文档，也不能生成正式模板。`
}

function draftDecisionText(decisions: readonly TemplateIntakeDraftDecisionItemV1[]): string {
  const counts = new Map<string, number>()
  for (const item of decisions) counts.set(item.decision, (counts.get(item.decision) ?? 0) + 1)
  const labels: Record<string, string> = {
    FIXED: '固定内容',
    VARIABLE: '可变字段',
    REPEAT: '重复块',
    CONDITIONAL: '条件块',
    EXCLUDE: '排除',
    UNRESOLVED: '无法判断',
  }
  const groups = [...counts.entries()]
    .map(([decision, count]) => `${labels[decision] ?? decision} ${count} 项`)
    .join('，')
  return `当前草稿已记录 ${decisions.length} 项决定${groups ? `（${groups}）` : ''}。`
}

function reviewAnchorV2(
  anchor: TemplateIntakeReportV1['candidates'][number]['sourceAnchors'][number] | undefined,
): TemplateReviewSourceAnchorV2 {
  if (!anchor) return { part: 'UNMAPPED' }
  return {
    part: anchor.part === 'TABLE' ? 'TABLE_CELL' : anchor.part,
    ...(anchor.sectionIndex != null ? { sectionIndex: anchor.sectionIndex } : {}),
    ...(anchor.partIndex != null ? { partIndex: anchor.partIndex } : {}),
    ...(anchor.paragraphIndex != null ? { paragraphIndex: anchor.paragraphIndex } : {}),
    ...(anchor.tableIndex != null ? { tableIndex: anchor.tableIndex } : {}),
    ...(anchor.rowIndex != null ? { rowIndex: anchor.rowIndex } : {}),
    ...(anchor.cellIndex != null ? { cellIndex: anchor.cellIndex } : {}),
    ...(anchor.drawingIndex != null ? { drawingIndex: anchor.drawingIndex } : {}),
  }
}

function reviewRiskFlagsV2(candidate: TemplateIntakeReportV1['candidates'][number]): TemplateReviewRiskFlagV2[] {
  const flags = [...candidate.riskFlags] as TemplateReviewRiskFlagV2[]
  if (candidate.confidence == null || candidate.confidence < 0.75) flags.push('LOW_CONFIDENCE')
  if (candidate.kind === 'UNRESOLVED' && /解析|对齐|位置/.test(candidate.reason)) flags.push('PARSER_EXCEPTION')
  return [...new Set(flags)]
}

function draftActionV2(
  candidate: TemplateIntakeReportV1['candidates'][number],
  draft: TemplateIntakeDraftDecisionItemV1 | undefined,
): TemplateReviewActionV2[] {
  if (draft?.reviewActionsV2?.length) return [...draft.reviewActionsV2]
  if (!draft) return []
  const base = {
    targetId: candidate.candidateId,
    ...(draft.highRiskOverrideReason ? { highRiskOverrideReason: draft.highRiskOverrideReason } : {}),
  }
  switch (draft.decision) {
    case 'FIXED': return [{ ...base, kind: 'KEEP' }]
    case 'VARIABLE': return draft.fieldName ? [{ ...base, kind: 'FIELD', fieldName: draft.fieldName }] : []
    case 'REPEAT': return [{ ...base, kind: 'REPEAT', blockName: draft.fieldName || candidate.suggestedName || '重复内容' }]
    case 'CONDITIONAL': return [{ ...base, kind: 'CONDITIONAL', conditionName: draft.fieldName || candidate.suggestedName || '条件内容' }]
    case 'EXCLUDE': return [{ ...base, kind: 'REMOVE' }]
    case 'UNRESOLVED': return []
  }
}

function buildTemplateReviewRequestV2(
  report: TemplateIntakeReportV1,
  draftDecisions: readonly TemplateIntakeDraftDecisionItemV1[],
): TemplateReviewRequestV2 {
  const draftById = new Map(draftDecisions.map((item) => [item.candidateId, item]))
  const targets: TemplateReviewTargetV2[] = report.candidates.map((candidate) => {
    const riskFlags = reviewRiskFlagsV2(candidate)
    const part = candidate.sourceAnchors[0]?.part
    const highlight = candidate.kind === 'UNRESOLVED' || riskFlags.length > 0 ? 'YELLOW' : 'NONE'
    return {
      targetId: candidate.candidateId,
      kind: part === 'DRAWING' ? 'IMAGE' : part === 'TABLE' ? 'TABLE_CELL' : part ? 'TEXT' : 'UNMAPPED',
      preview: candidate.preview,
      sourceAnchor: reviewAnchorV2(candidate.sourceAnchors[0]),
      pageRegions: [],
      reason: candidate.reason,
      confidence: candidate.confidence,
      riskFlags,
      highlight,
      status: draftActionV2(candidate, draftById.get(candidate.candidateId)).length ? 'RESOLVED' : 'PENDING',
      highRisk: candidate.riskFlags.length > 0,
    }
  })
  const draftActions = report.candidates.flatMap((candidate) => {
    const explicit = draftActionV2(candidate, draftById.get(candidate.candidateId))
    if (explicit.length) return explicit
    const target = targets.find((item) => item.targetId === candidate.candidateId)
    return target?.highlight === 'NONE'
      ? [{ targetId: candidate.candidateId, kind: 'KEEP' as const }]
      : []
  })
  const pageCount = Math.max(1, Math.ceil(targets.length / 20))
  return {
    reviewVersion: 2,
    document: {
      reviewVersion: 2,
      reviewId: report.reportId,
      status: 'REVIEWING',
      source: {
        displayName: report.file.displayName,
        sha256: report.file.sha256,
        byteLength: report.file.byteLength,
        inputFormat: 'DOCX',
      },
      render: {
        mode: 'STRUCTURED_FALLBACK',
        pageCount,
        pages: Array.from({ length: pageCount }, (_, index) => ({
          pageNumber: index + 1,
          pageToken: `xgtr2_${report.reportId}_${index + 1}`,
          widthPoints: 595,
          heightPoints: 842,
          textLayerAvailable: true,
        })),
        warnings: [{
          code: 'STRUCTURED_FALLBACK_ACTIVE',
          message: '当前使用结构化文档视图；无法定位的内容会在复核清单中明确列出。',
        }],
      },
      targetCount: targets.length,
      pendingTargetCount: targets.filter((target) => target.highlight === 'YELLOW' && target.status === 'PENDING').length,
      resolvedTargetCount: targets.filter((target) => target.status === 'RESOLVED' || target.highlight === 'NONE').length,
      unmappedTargetCount: targets.filter((target) => target.kind === 'UNMAPPED').length,
      requiresHumanConfirmation: true,
      sourceReadOnly: true,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    },
    targets,
    draftActions,
  }
}

function publicText(result: SafeToolDetails): string {
  switch (result.kind) {
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_SELECTION_CANCELLED':
      return '已取消选择文档，没有创建整理报告，也没有修改文档。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY':
      return reportText(result.report, '已生成只读模板整理报告：')
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED':
      return `${reportText(result.report, '已按你的要求逐项更新整理草稿：')} ${draftDecisionText(result.draftDecisions)}`
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REVIEW_REQUIRED':
      return '模板整理报告正在等待结构化复核。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CONFIRMED':
      return `已保存人工确认记录，共 ${result.decision.decisions.length} 项。没有修改文档，也没有生成正式模板。`
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_RESUMED':
      return reportText(result.report, result.decision ? '已恢复已确认的整理报告：' : '已恢复未完成的整理报告：')
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_DELETED':
      return '已按明确要求删除这份历史整理报告。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CANCELLED':
      return '已取消当前模板整理处理；没有修改文档。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REVIEW_CANCELLED':
      return '已结束本次复核，未生成确认记录；当前草稿仍保留，可稍后继续。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_FAILED':
      return result.message
  }
}

export function addXiaoguiWorkDocxTemplateIntakeTool(
  loaded: LoadExtensionsResult,
  options: XiaoguiWorkDocxTemplateIntakeToolOptions,
): LoadExtensionsResult {
  const sourceInfo = createSyntheticSourceInfo('<builtin:xiaogui-work-docx-template-intake>', {
    source: 'xiaogui-desktop',
    scope: 'temporary',
    origin: 'top-level',
  })
  const definition = defineTool<typeof ActionSchema, SafeToolDetails>({
    ...TOOL_PROMPT,
    parameters: ActionSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal, _onUpdate, context) {
      const sourceSessionId = options.getSourceSessionId()
      const sourceRunId = options.getSourceRunId()
      if (!sourceSessionId || !sourceRunId) {
        const details: SafeToolDetails = {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_FAILED',
          code: 'SESSION_NOT_READY',
          message: '当前用户指令尚未建立完成，请重新发送后再试',
        }
        return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
      }

      const common = { sourceSessionId, sourceRunId, toolCallId }
      const callHost = (payload: Record<string, unknown>, requestSignal = signal) =>
        requestWorkerHostTool(
          {
            method: XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_METHOD_V1,
            payload: { ...payload, ...common } as never,
          },
          requestSignal,
        )

      try {
        let outcome = await callHost(params as unknown as Record<string, unknown>)
        if (!outcome.ok) {
          const details: SafeToolDetails = {
            kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_FAILED',
            ...outcome.error,
          }
          return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
        }
        if (!isTemplateIntakeResult(outcome.value)) throw new Error('INVALID_HOST_RESULT')

        if (outcome.value.kind === 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED') {
          const reportId = outcome.value.reportId
          const analysis = await analyzeBatches(context, outcome.value.analysisBatches, signal)
          if (signal?.aborted) throw new Error('ABORTED')
          outcome = await callHost({ action: 'START', reportId, analysis })
          if (!outcome.ok) {
            const details: SafeToolDetails = {
              kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_FAILED',
              ...outcome.error,
            }
            return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
          }
          if (!isTemplateIntakeResult(outcome.value)) throw new Error('INVALID_HOST_RESULT')
        }

        if (outcome.value.kind === 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REVIEW_REQUIRED') {
          const bridge = getDesktopUIBridge(context.ui)
          if (!bridge) {
            const details: SafeToolDetails = {
              kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_FAILED',
              code: 'HOST_TOOL_UNAVAILABLE',
              message: '当前界面无法打开模板复核卡，请稍后重试',
            }
            return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
          }
          const report = outcome.value.report
          const payload: TemplateDraftReviewRequestV2 | TemplateReviewRequestV2 | TemplateReviewRequestV3 = outcome.value.templateDraftRequestV2
            ?? outcome.value.reviewRequestV3
            ?? outcome.value.reviewRequestV2
            ?? buildTemplateReviewRequestV2(report, outcome.value.draftDecisions)
          const reviewed = await bridge.requestTemplateIntakeReview(toolCallId, payload, signal)
          if (reviewed.cancelled) {
            const draftActions = 'draftActions' in reviewed ? reviewed.draftActions : []
            if (draftActions.length > 0) {
              const decisions = summarizeTemplateReviewActionsV2(report, draftActions)
              const saved = await callHost(
                {
                  action: 'UPDATE',
                  operations: decisions.map((item) => ({
                    candidateIds: [item.candidateId],
                    decision: item.decision,
                    ...(item.fieldName ? { fieldName: item.fieldName } : {}),
                    ...(item.highRiskOverrideReason ? { reason: item.highRiskOverrideReason } : {}),
                    reviewActionsV2: draftActions.filter((action) => action.targetId === item.candidateId),
                  })),
                },
                undefined,
              )
              if (!saved.ok) {
                const details: SafeToolDetails = {
                  kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_FAILED',
                  ...saved.error,
                }
                return {
                  content: [{ type: 'text', text: publicText(details) }],
                  details,
                  isError: true,
                }
              }
            }
            const details: SafeToolDetails = {
              kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REVIEW_CANCELLED',
            }
            return { content: [{ type: 'text', text: publicText(details) }], details }
          }
          if (!('actions' in reviewed)) throw new Error('INVALID_REVIEW_RESULT')
          const reviewedV2 = reviewed as Extract<TemplateReviewResultV2, { cancelled: false }>
          outcome = await callHost(
            {
              action: 'REVIEW',
              submission: {
                decisions: summarizeTemplateReviewActionsV2(report, reviewedV2.actions),
                reviewActionsV2: reviewedV2.actions,
                ...(reviewedV2.issueChoicesV2
                  ? { issueChoicesV2: reviewedV2.issueChoicesV2 }
                  : {}),
              },
            },
            undefined,
          )
          if (!outcome.ok) {
            const details: SafeToolDetails = {
              kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_FAILED',
              ...outcome.error,
            }
            return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
          }
          if (!isTemplateIntakeResult(outcome.value)) throw new Error('INVALID_HOST_RESULT')
        }

        if (outcome.value.kind === 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED') {
          const details: SafeToolDetails = {
            kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_FAILED',
            code: 'HOST_TOOL_FAILED',
            message: '模板整理没有完成，请稍后重试',
          }
          return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
        }
        const details = outcome.value as SafeToolDetails
        return { content: [{ type: 'text', text: publicText(details) }], details }
      } catch {
        if (signal?.aborted) {
          await callHost({ action: 'CANCEL' }, undefined).catch(() => undefined)
        }
        const details: SafeToolDetails = {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_FAILED',
          code: signal?.aborted ? 'TEMPLATE_INTAKE_ABORTED' : 'HOST_TOOL_FAILED',
          message: signal?.aborted ? '模板整理已取消' : '模板整理失败，请稍后重试',
        }
        return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
      }
    },
  })

  const extension: Extension = {
    path: sourceInfo.path,
    resolvedPath: sourceInfo.path,
    hidden: true,
    sourceInfo,
    handlers: new Map(),
    tools: new Map([[definition.name, { definition, sourceInfo }]]),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  }
  return { ...loaded, extensions: [...loaded.extensions, extension] }
}

export const __test = {
  validateSuggestions,
  analyzeBatches,
}
