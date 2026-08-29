import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import type {
  TemplateIntakeCandidateKindV1,
  TemplateIntakeCandidateV1,
  TemplateIntakeDecisionV1,
  TemplateIntakeDraftDecisionItemV1,
  TemplateIntakeErrorCodeV1,
  TemplateIntakeFinalDecisionItemV1,
  TemplateIntakeReportV1,
  TemplateIntakeRiskFlagV1,
  TemplateIntakeUpdateOperationV1,
  TemplateIntakeWarningV1,
} from '@shared/xiaogui-work-docx-template-intake'
import {
  TEMPLATE_INTAKE_MAX_ANALYSIS_CHARS_V1,
  TEMPLATE_INTAKE_MAX_BATCH_CHARS_V1,
  TEMPLATE_INTAKE_MAX_BATCHES_V1,
  TEMPLATE_INTAKE_MAX_CANDIDATES_V1,
  TEMPLATE_INTAKE_MAX_PREVIEW_CHARS_V1,
  TEMPLATE_INTAKE_MAX_REPORT_BYTES_V1,
  TEMPLATE_INTAKE_REPORT_VERSION_V1,
  createTemplateIntakeReportSummaryV1,
} from '@shared/xiaogui-work-docx-template-intake'
import type { TemplateFieldGraphV2 } from '@shared/xiaogui-template-field-graph-v2'
import { TEMPLATE_FIELD_QUICK_ISSUE_TARGET_V2 } from '@shared/xiaogui-template-field-graph-v2'
import type { TemplateDraftReviewRequestV2 } from '@shared/xiaogui-template-draft-review'
import type {
  TemplateIntakeAnalysisBatchV1,
  TemplateIntakeModelAnalysisV1,
  TemplateIntakeModelSuggestionV1,
  TemplateIntakeReviewSubmissionV1,
  XiaoguiWorkDocxTemplateIntakePayloadV1,
  XiaoguiWorkDocxTemplateIntakeResultV1,
} from '@shared/worker-host-tools'
import {
  isValidTemplateReviewTextRangeV2,
  type TemplateReviewActionV2,
  type TemplateReviewActionV3,
  type TemplateReviewIssueChoiceV2,
  type TemplateReviewRenderAnchorV3,
  type TemplateReviewRequestV3,
  type TemplateReviewRiskFlagV2,
  type TemplateReviewTargetV3,
} from '@shared/xiaogui-work-template-review'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import {
  DOCX_SAFETY_MAX_FILE_BYTES_V1,
  DocxSafetyErrorV1,
  inspectSafeDocxArchiveV1,
} from './docx-safety'
import type { WorkDocxServiceV1 } from './work-docx-service'
import {
  parseTemplateIntakeSourceV1,
  sliceUnicode,
  type ParsedTemplateIntakeFragmentV1,
  type ParsedTemplateIntakeSourceV1,
  type TemplateIntakeSemanticParserV1,
} from './work-docx-template-intake-parser'
import {
  TemplateIntakeStoreLimitErrorV1,
  WorkDocxTemplateIntakeStoreV1,
  withTemplateIntakeStatusV1,
  type StoredTemplateIntakeRecordV1,
} from './work-docx-template-intake-store'
import type {
  DocumentReviewRendererV1,
  PreparedDocumentReviewRenderV1,
} from './work-document-review-renderer'
import { buildTemplateFieldGraphV2 } from './template-intelligence/template-field-graph-builder-v2'
import {
  LegacyDocSafetyErrorV1,
  LEGACY_DOC_SAFETY_MAX_FILE_BYTES_V1,
  inspectSafeLegacyDocV1,
} from './work-legacy-doc-safety'

const MAX_DISPLAY_NAME_CHARS = 160
const MAX_REASON_CHARS = 1_000
const MAX_FIELD_NAME_CHARS = 120
const MAX_PARSE_MS = 60_000
const UNSAFE_DISPLAY_NAME = /[\/\\\u0000-\u001f\u007f-\u009f]/

type TemplateIntakeDialogPortV1 = { chooseSource(): Promise<string | null> }
type TemplateIntakeHandoffPortV1 = Pick<WorkDocxServiceV1, 'consumeTemplateIntakeHandoff'>

export type TemplateIntakeServiceOutcomeV1 =
  | { ok: true; value: XiaoguiWorkDocxTemplateIntakeResultV1 }
  | {
      ok: false
      error: { code: TemplateIntakeErrorCodeV1 }
    }

export interface WorkDocxTemplateIntakeServiceOptionsV1 {
  lookup: SessionScopeLookupV1
  dialogs: TemplateIntakeDialogPortV1
  store: WorkDocxTemplateIntakeStoreV1
  handoffs: TemplateIntakeHandoffPortV1
  semanticParser?: TemplateIntakeSemanticParserV1
  reviewRenderer?: Pick<
    DocumentReviewRendererV1,
    'prepare' | 'readNormalizedDocx' | 'release'
  >
  now?: () => Date
  parseTimeoutMs?: number
  /** 设为 false 可立即回退到既有逐段复核器。 */
  templateDraftV2Enabled?: boolean
}

type PreparedReviewManifestV1 = {
  sourceSha256: string
  manifestId: string
  prepared: PreparedDocumentReviewRenderV1
}

export interface ConfirmedTemplateIntakeMaterializationSourceV1 {
  sourcePath: string
  sourceSha256: string
  sourceDisplayName: string
  sourceBytes: number
  report: TemplateIntakeReportV1
  decision: TemplateIntakeDecisionV1
}

type PrivateSourceV1 = {
  path: string
  displayName: string
  sha256: string
  byteLength: number
  inputFormat: 'DOC' | 'DOCX'
  content: Buffer
  normalizedDocx?: Buffer
  preparedReview?: PreparedDocumentReviewRenderV1
}

type PendingAnalysisV1 = {
  address: SessionAddressV1
  reportId: string
  source: Pick<
    PrivateSourceV1,
    'path' | 'displayName' | 'sha256' | 'byteLength' | 'inputFormat'
  >
  parsed: ParsedTemplateIntakeSourceV1
  batches: readonly TemplateIntakeAnalysisBatchV1[]
  createdAt: string
}

function failure(code: TemplateIntakeErrorCodeV1): TemplateIntakeServiceOutcomeV1 {
  return { ok: false, error: { code } }
}

function scopeKey(address: SessionAddressV1): string {
  return `${address.projectId}\0${address.sessionKey}`
}

function unicodeLength(text: string): number {
  return Array.from(text).length
}

function safeDisplayName(path: string): string {
  const name = basename(path)
  if (!name || name.length > MAX_DISPLAY_NAME_CHARS || UNSAFE_DISPLAY_NAME.test(name)) {
    throw new TemplateIntakeServiceErrorV1('TEMPLATE_INTAKE_INPUT_INVALID')
  }
  return name
}

class TemplateIntakeServiceErrorV1 extends Error {
  constructor(readonly code: TemplateIntakeErrorCodeV1) {
    super(code)
  }
}

function mapSafetyError(error: DocxSafetyErrorV1): TemplateIntakeServiceErrorV1 {
  return new TemplateIntakeServiceErrorV1(
    error.code === 'INPUT_TOO_LARGE'
      ? 'TEMPLATE_INTAKE_INPUT_TOO_LARGE'
      : 'TEMPLATE_INTAKE_UNSAFE_DOCX',
  )
}

async function readPrivateSource(
  path: string,
  renderer?: WorkDocxTemplateIntakeServiceOptionsV1['reviewRenderer'],
  normalizeDoc = false,
  signal?: AbortSignal,
): Promise<PrivateSourceV1> {
  const extension = extname(path).toLowerCase()
  if (extension !== '.docx' && extension !== '.doc') {
    throw new TemplateIntakeServiceErrorV1('TEMPLATE_INTAKE_INPUT_INVALID')
  }
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TemplateIntakeServiceErrorV1('TEMPLATE_INTAKE_SOURCE_MISSING')
    }
    throw new TemplateIntakeServiceErrorV1('TEMPLATE_INTAKE_INPUT_INVALID')
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new TemplateIntakeServiceErrorV1('TEMPLATE_INTAKE_INPUT_INVALID')
  }
  const maxBytes = extension === '.doc'
    ? LEGACY_DOC_SAFETY_MAX_FILE_BYTES_V1
    : DOCX_SAFETY_MAX_FILE_BYTES_V1
  if (info.size > maxBytes) {
    throw new TemplateIntakeServiceErrorV1('TEMPLATE_INTAKE_INPUT_TOO_LARGE')
  }
  const content = await readFile(path)
  let normalizedDocx: Buffer | undefined
  let preparedReview: PreparedDocumentReviewRenderV1 | undefined
  if (extension === '.docx') {
    try {
      await inspectSafeDocxArchiveV1(content)
    } catch (error) {
      if (error instanceof DocxSafetyErrorV1) throw mapSafetyError(error)
      throw error
    }
  } else {
    try {
      inspectSafeLegacyDocV1(content)
    } catch (error) {
      if (error instanceof LegacyDocSafetyErrorV1) {
        throw new TemplateIntakeServiceErrorV1(
          error.code === 'INPUT_TOO_LARGE'
            ? 'TEMPLATE_INTAKE_INPUT_TOO_LARGE'
            : 'TEMPLATE_INTAKE_UNSAFE_DOC',
        )
      }
      throw error
    }
    if (normalizeDoc) {
      if (!renderer) throw new TemplateIntakeServiceErrorV1('TEMPLATE_INTAKE_CONVERSION_FAILED')
      preparedReview = await renderer.prepare(content, 'DOC', signal)
      normalizedDocx = renderer.readNormalizedDocx(preparedReview.manifestId) ?? undefined
      if (!normalizedDocx) {
        renderer.release(preparedReview.manifestId)
        throw new TemplateIntakeServiceErrorV1('TEMPLATE_INTAKE_CONVERSION_FAILED')
      }
    }
  }
  return {
    path,
    displayName: safeDisplayName(path),
    sha256: createHash('sha256').update(content).digest('hex'),
    byteLength: content.byteLength,
    inputFormat: extension === '.doc' ? 'DOC' : 'DOCX',
    content,
    ...(normalizedDocx ? { normalizedDocx } : {}),
    ...(preparedReview ? { preparedReview } : {}),
  }
}

function riskFlagsForText(text: string): TemplateIntakeRiskFlagV1[] {
  const flags: TemplateIntakeRiskFlagV1[] = []
  if (/(?:签字|签名|签署|编制人|审核人|审定人|批准人)/i.test(text)) flags.push('SIGNATURE')
  if (/(?:印章|盖章|公章|签章)/i.test(text)) flags.push('SEAL')
  if (/(?:联系方式|联系人|联系电话|手机号码|电子邮箱|邮箱|电话\s*[:：])/i.test(text)) {
    flags.push('CONTACT_INFORMATION')
  }
  if (/(?:旧项目|原项目|原方案图|旧图件|历史图件)/i.test(text)) flags.push('OLD_PROJECT_DRAWING')
  if (/(?:扫描件|扫描附件|签章页扫描|附件扫描)/i.test(text)) flags.push('SCANNED_ATTACHMENT')
  return [...new Set(flags)]
}

function buildDeterministicCandidate(fragment: ParsedTemplateIntakeFragmentV1): TemplateIntakeCandidateV1 | null {
  const flags = riskFlagsForText(fragment.text)
  if (flags.length === 0) return null
  return {
    candidateId: `xgtic1_${randomUUID()}`,
    kind: 'EXCLUDE',
    preview: sliceUnicode(fragment.text, TEMPLATE_INTAKE_MAX_PREVIEW_CHARS_V1),
    sourceAnchors: [fragment.anchor],
    reason: '命中签字、印章、联系方式、旧项目图件或扫描附件的确定性风险规则，默认排除并等待人工确认',
    confidence: 1,
    riskFlags: flags,
    defaultDecision: 'EXCLUDE',
  }
}

function candidateFromSuggestion(
  suggestion: TemplateIntakeModelSuggestionV1,
  fragments: readonly ParsedTemplateIntakeFragmentV1[],
): TemplateIntakeCandidateV1 {
  const text = fragments.map((fragment) => fragment.text).join('\n')
  return {
    candidateId: `xgtic1_${randomUUID()}`,
    kind: suggestion.kind,
    preview: sliceUnicode(text, TEMPLATE_INTAKE_MAX_PREVIEW_CHARS_V1),
    sourceAnchors: fragments.map((fragment) => fragment.anchor),
    reason: sliceUnicode(suggestion.reason, MAX_REASON_CHARS),
    confidence: suggestion.confidence,
    riskFlags: [],
    defaultDecision: suggestion.kind,
    ...(suggestion.suggestedName
      ? { suggestedName: sliceUnicode(suggestion.suggestedName, MAX_FIELD_NAME_CHARS) }
      : {}),
  }
}

function unresolvedCandidate(fragment: ParsedTemplateIntakeFragmentV1, reason: string): TemplateIntakeCandidateV1 {
  return {
    candidateId: `xgtic1_${randomUUID()}`,
    kind: 'UNRESOLVED',
    preview: sliceUnicode(fragment.text, TEMPLATE_INTAKE_MAX_PREVIEW_CHARS_V1),
    sourceAnchors: [fragment.anchor],
    reason,
    confidence: null,
    riskFlags: [],
    defaultDecision: 'UNRESOLVED',
  }
}

function buildCandidates(
  parsed: ParsedTemplateIntakeSourceV1,
  analysis: TemplateIntakeModelAnalysisV1 | null,
): TemplateIntakeCandidateV1[] {
  const byId = new Map(parsed.fragments.map((fragment) => [fragment.fragmentId, fragment]))
  const used = new Set<string>()
  const candidates = [...parsed.deterministicCandidates]

  for (const fragment of parsed.fragments) {
    const deterministic = buildDeterministicCandidate(fragment)
    if (!deterministic) continue
    used.add(fragment.fragmentId)
    candidates.push(deterministic)
  }

  if (analysis?.status === 'COMPLETE') {
    for (const suggestion of analysis.suggestions) {
      const ids = [...new Set(suggestion.fragmentIds)]
      if (ids.length !== suggestion.fragmentIds.length) continue
      const fragments = ids.map((id) => byId.get(id)).filter(Boolean) as ParsedTemplateIntakeFragmentV1[]
      if (fragments.length !== ids.length || fragments.some((fragment) => used.has(fragment.fragmentId))) {
        continue
      }
      if (fragments.some((fragment) => !fragment.semanticAligned)) continue
      // 过大的模型分组仍保留模型语义判断，但必须拆成逐位置候选，避免削弱可追溯性。
      if (ids.length > 20) {
        for (const fragment of fragments) {
          used.add(fragment.fragmentId)
          candidates.push(candidateFromSuggestion(suggestion, [fragment]))
        }
        continue
      }
      fragments.forEach((fragment) => used.add(fragment.fragmentId))
      candidates.push(candidateFromSuggestion(suggestion, fragments))
    }
  }

  for (const fragment of parsed.fragments) {
    if (used.has(fragment.fragmentId)) continue
    candidates.push(
      unresolvedCandidate(
        fragment,
        fragment.semanticAligned
          ? analysis?.status === 'COMPLETE'
            ? '模型未给出可验证建议，需人工判断'
            : '模型不可用或已安全降级，需人工判断'
          : '结构位置与语义内容无法可靠对齐，需人工判断',
      ),
    )
  }

  if (candidates.length === 0) {
    candidates.push({
      candidateId: `xgtic1_${randomUUID()}`,
      kind: 'UNRESOLVED',
      preview: '未提取到可供自动判断的正文内容',
      sourceAnchors: [{ part: 'BODY', sectionIndex: 1, paragraphIndex: 1 }],
      reason: '文档可能主要由图片、扫描页或不受支持的复杂对象组成，必须人工确认',
      confidence: null,
      riskFlags: ['OTHER'],
      defaultDecision: 'UNRESOLVED',
    })
  }
  return candidates
}

function applyCandidateLimit(
  candidates: readonly TemplateIntakeCandidateV1[],
  warnings: TemplateIntakeWarningV1[],
): TemplateIntakeCandidateV1[] {
  if (candidates.length <= TEMPLATE_INTAKE_MAX_CANDIDATES_V1) return [...candidates]
  const remaining = candidates.length - (TEMPLATE_INTAKE_MAX_CANDIDATES_V1 - 1)
  warnings.push({
    code: 'CANDIDATE_LIMIT_EXCEEDED',
    message: `候选超过 ${TEMPLATE_INTAKE_MAX_CANDIDATES_V1} 项；已保留高风险项和前序候选，并增加一项明确的待人工展开记录`,
  })
  const ordered = [...candidates].sort((left, right) => {
    const leftRisk = left.riskFlags.length > 0 ? 1 : 0
    const rightRisk = right.riskFlags.length > 0 ? 1 : 0
    return rightRisk - leftRisk
  })
  return [
    ...ordered.slice(0, TEMPLATE_INTAKE_MAX_CANDIDATES_V1 - 1),
    {
      candidateId: `xgtic1_${randomUUID()}`,
      kind: 'UNRESOLVED',
      preview: `另有 ${remaining} 项候选未逐项展开`,
      sourceAnchors: [{ part: 'BODY', sectionIndex: 1 }],
      reason: '候选数量超过报告上限，未静默截断；需人工缩小范围或另行处理',
      confidence: null,
      riskFlags: ['OTHER'],
      defaultDecision: 'UNRESOLVED',
    },
  ]
}

function compactReportIfNeeded(report: TemplateIntakeReportV1): TemplateIntakeReportV1 {
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') <= TEMPLATE_INTAKE_MAX_REPORT_BYTES_V1) {
    return report
  }
  const warning: TemplateIntakeWarningV1 = {
    code: 'REPORT_SIZE_LIMIT_EXCEEDED',
    message: '报告接近 2 MiB 上限，已缩短候选预览和理由；没有静默丢弃候选',
  }
  const compact: TemplateIntakeReportV1 = {
    ...report,
    warnings: [...report.warnings, warning],
    candidates: report.candidates.map((candidate) => ({
      ...candidate,
      preview: sliceUnicode(candidate.preview, 120),
      reason: sliceUnicode(candidate.reason, 200),
    })),
  }
  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') > TEMPLATE_INTAKE_MAX_REPORT_BYTES_V1) {
    throw new TemplateIntakeServiceErrorV1('TEMPLATE_INTAKE_INPUT_TOO_LARGE')
  }
  return compact
}

function buildBatches(
  fragments: readonly ParsedTemplateIntakeFragmentV1[],
): readonly TemplateIntakeAnalysisBatchV1[] | null {
  const total = fragments.reduce((sum, fragment) => sum + unicodeLength(fragment.text), 0)
  if (total > TEMPLATE_INTAKE_MAX_ANALYSIS_CHARS_V1) return null
  const batches: TemplateIntakeAnalysisBatchV1[] = []
  let current: ParsedTemplateIntakeFragmentV1[] = []
  let currentCharacters = 0
  for (const fragment of fragments) {
    const length = unicodeLength(fragment.text)
    if (length > TEMPLATE_INTAKE_MAX_BATCH_CHARS_V1) return null
    if (current.length > 0 && currentCharacters + length > TEMPLATE_INTAKE_MAX_BATCH_CHARS_V1) {
      batches.push({
        batchIndex: batches.length + 1,
        characterCount: currentCharacters,
        fragments: current.map(({ fragmentId, kind, anchor, text }) => ({ fragmentId, kind, anchor, text })),
      })
      current = []
      currentCharacters = 0
    }
    current.push(fragment)
    currentCharacters += length
  }
  if (current.length > 0) {
    batches.push({
      batchIndex: batches.length + 1,
      characterCount: currentCharacters,
      fragments: current.map(({ fragmentId, kind, anchor, text }) => ({ fragmentId, kind, anchor, text })),
    })
  }
  return batches.length <= TEMPLATE_INTAKE_MAX_BATCHES_V1 ? batches : null
}

function localIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

function reviewRiskFlagsV2(candidate: TemplateIntakeCandidateV1): TemplateReviewRiskFlagV2[] {
  const flags = [...candidate.riskFlags] as TemplateReviewRiskFlagV2[]
  if (candidate.confidence == null || candidate.confidence < 0.75) flags.push('LOW_CONFIDENCE')
  if (candidate.kind === 'UNRESOLVED' && /解析|对齐|位置/.test(candidate.reason)) {
    flags.push('PARSER_EXCEPTION')
  }
  return [...new Set(flags)]
}

function reviewAnchorV2(anchor: TemplateIntakeCandidateV1['sourceAnchors'][number] | undefined) {
  if (!anchor) return { part: 'UNMAPPED' as const }
  return {
    part:
      anchor.part === 'TABLE'
        ? ('TABLE_CELL' as const)
        : anchor.part,
    ...(anchor.sectionIndex != null ? { sectionIndex: anchor.sectionIndex } : {}),
    ...(anchor.partIndex != null ? { partIndex: anchor.partIndex } : {}),
    ...(anchor.paragraphIndex != null ? { paragraphIndex: anchor.paragraphIndex } : {}),
    ...(anchor.tableIndex != null ? { tableIndex: anchor.tableIndex } : {}),
    ...(anchor.rowIndex != null ? { rowIndex: anchor.rowIndex } : {}),
    ...(anchor.cellIndex != null ? { cellIndex: anchor.cellIndex } : {}),
    ...(anchor.drawingIndex != null ? { drawingIndex: anchor.drawingIndex } : {}),
  }
}

function draftReviewActionsV2(
  candidate: TemplateIntakeCandidateV1,
  draft: TemplateIntakeDraftDecisionItemV1 | undefined,
): TemplateReviewActionV2[] {
  if (draft?.reviewActionsV2?.length) return [...draft.reviewActionsV2]
  if (!draft) return []
  const base = {
    targetId: candidate.candidateId,
    ...(draft.highRiskOverrideReason
      ? { highRiskOverrideReason: draft.highRiskOverrideReason }
      : {}),
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

export class WorkDocxTemplateIntakeServiceV1 {
  private readonly pending = new Map<string, PendingAnalysisV1>()
  private readonly reviewManifests = new Map<string, PreparedReviewManifestV1>()

  constructor(private readonly options: WorkDocxTemplateIntakeServiceOptionsV1) {}

  async execute(
    address: SessionAddressV1,
    payload: XiaoguiWorkDocxTemplateIntakePayloadV1,
    signal?: AbortSignal,
  ): Promise<TemplateIntakeServiceOutcomeV1> {
    const admissionError = await this.admissionError(address)
    if (admissionError) return failure(admissionError)
    if (signal?.aborted) return failure('TEMPLATE_INTAKE_ABORTED')
    try {
      switch (payload.action) {
        case 'START':
          return await this.start(address, payload.analysis, payload.reportId, signal)
        case 'UPDATE':
          return this.update(address, payload.operations, payload.reportId)
        case 'REOPEN':
          return await this.reopen(address, payload.operations)
        case 'REVIEW':
          return await this.review(address, payload.submission, signal, payload.reportId)
        case 'RESUME':
          return await this.resume(address, payload.reportId)
        case 'DELETE':
          return this.delete(address, payload.reportId, payload.confirmed)
        case 'CANCEL':
          return this.cancel(address)
      }
    } catch (error) {
      if (error instanceof TemplateIntakeServiceErrorV1) return failure(error.code)
      if (error instanceof TemplateIntakeStoreLimitErrorV1) {
        return failure('TEMPLATE_INTAKE_REPORT_LIMIT_REACHED')
      }
      if (error instanceof DocxSafetyErrorV1) return failure(mapSafetyError(error).code)
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return failure('TEMPLATE_INTAKE_ABORTED')
      }
      return failure('TEMPLATE_INTAKE_STORAGE_FAILED')
    }
  }

  close(): void {
    this.pending.clear()
    for (const manifest of this.reviewManifests.values()) {
      this.options.reviewRenderer?.release(manifest.manifestId)
    }
    this.reviewManifests.clear()
    this.options.store.close()
  }

  /** 仅供同一主进程内的模板物化模块读取；路径和确认记录不会进入 Worker。 */
  loadConfirmedForMaterialization(
    address: SessionAddressV1,
    reportId?: string,
  ): ConfirmedTemplateIntakeMaterializationSourceV1 | null {
    const record = reportId
      ? this.options.store.get(address, reportId)
      : this.options.store.latestConfirmed(address)
    if (!record || record.report.status !== 'CONFIRMED' || !record.decision) return null
    return {
      sourcePath: record.sourcePath,
      sourceSha256: record.sourceSha256,
      sourceDisplayName: record.sourceDisplayName,
      sourceBytes: record.sourceBytes,
      report: record.report,
      decision: record.decision,
    }
  }

  private async admissionError(address: SessionAddressV1): Promise<TemplateIntakeErrorCodeV1 | null> {
    const lookup = await this.options.lookup.lookup(address)
    if (lookup.kind === 'NOT_FOUND') return 'TEMPLATE_INTAKE_SCOPE_NOT_FOUND'
    if (lookup.kind === 'PROJECT_MISMATCH') return 'TEMPLATE_INTAKE_SCOPE_MISMATCH'
    if (lookup.scope.sessionMode !== 'WORK') return 'TEMPLATE_INTAKE_MODE_NOT_ALLOWED'
    return null
  }

  private async start(
    address: SessionAddressV1,
    analysis: TemplateIntakeModelAnalysisV1 | undefined,
    analysisReportId: string | undefined,
    signal?: AbortSignal,
  ): Promise<TemplateIntakeServiceOutcomeV1> {
    const key = scopeKey(address)
    const existing = this.pending.get(key)
    if (analysis) {
      if (!existing || existing.reportId !== analysisReportId) {
        return failure('TEMPLATE_INTAKE_REPORT_NOT_FOUND')
      }
      const current = await readPrivateSource(existing.source.path, this.options.reviewRenderer)
      if (current.sha256 !== existing.source.sha256) {
        this.pending.delete(key)
        return failure('TEMPLATE_INTAKE_SOURCE_CHANGED')
      }
      const report = this.buildReport(existing, analysis)
      const draftDecisions: TemplateIntakeDraftDecisionItemV1[] = []
      this.options.store.create({
        address,
        sourcePath: existing.source.path,
        sourceSha256: existing.source.sha256,
        sourceDisplayName: existing.source.displayName,
        sourceBytes: existing.source.byteLength,
        report,
        draftDecisions,
      })
      this.pending.delete(key)
      return {
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY',
          report,
          draftDecisions,
        },
      }
    }
    if (existing) return failure('TEMPLATE_INTAKE_OPERATION_ACTIVE')

    const handoff = this.options.handoffs.consumeTemplateIntakeHandoff(address)
    const selectedPath = handoff?.sourcePath ?? (await this.options.dialogs.chooseSource())
    if (!selectedPath) {
      return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_SELECTION_CANCELLED' } }
    }
    const source = await readPrivateSource(
      selectedPath,
      this.options.reviewRenderer,
      true,
      signal,
    )
    if (handoff && source.sha256 !== handoff.templateSha256) {
      if (source.preparedReview) this.options.reviewRenderer?.release(source.preparedReview.manifestId)
      throw new TemplateIntakeServiceErrorV1('TEMPLATE_INTAKE_SOURCE_CHANGED')
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(
      () => controller.abort(),
      this.options.parseTimeoutMs ?? MAX_PARSE_MS,
    )
    let parsed: ParsedTemplateIntakeSourceV1
    try {
      parsed = await parseTemplateIntakeSourceV1(
        source.normalizedDocx ?? source.content,
        controller.signal,
        this.options.semanticParser,
      )
    } catch (error) {
      if (source.preparedReview) this.options.reviewRenderer?.release(source.preparedReview.manifestId)
      if (controller.signal.aborted) {
        throw new TemplateIntakeServiceErrorV1(
          signal?.aborted ? 'TEMPLATE_INTAKE_ABORTED' : 'TEMPLATE_INTAKE_PARSER_FAILED',
        )
      }
      throw new TemplateIntakeServiceErrorV1('TEMPLATE_INTAKE_PARSER_FAILED')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    const createdAt = this.nowIso()
    const reportId = `xgti1_${randomUUID()}`
    if (source.preparedReview) {
      this.reviewManifests.set(reportId, {
        sourceSha256: source.sha256,
        manifestId: source.preparedReview.manifestId,
        prepared: source.preparedReview,
      })
    }
    const batches = buildBatches(parsed.fragments)
    const pending: PendingAnalysisV1 = {
      address,
      reportId,
      source: {
        path: source.path,
        displayName: source.displayName,
        sha256: source.sha256,
        byteLength: source.byteLength,
        inputFormat: source.inputFormat,
      },
      parsed,
      batches: batches ?? [],
      createdAt,
    }
    if (batches === null || batches.length === 0) {
      const report = this.buildReport(pending, {
        status: 'DEGRADED',
        modelVersion: null,
        warning: {
          code: batches === null ? 'ANALYSIS_LIMIT_EXCEEDED' : 'MODEL_UNAVAILABLE',
          message:
            batches === null
              ? '提取文本超过临时模型分析上限，未发送部分或截断文本，已转为结构报告和人工判断'
              : '没有可发送给模型的文本片段，已转为结构报告和人工判断',
        },
      })
      const draftDecisions: TemplateIntakeDraftDecisionItemV1[] = []
      this.options.store.create({
        address,
        sourcePath: source.path,
        sourceSha256: source.sha256,
        sourceDisplayName: source.displayName,
        sourceBytes: source.byteLength,
        report,
        draftDecisions,
      })
      return {
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY',
          report,
          draftDecisions,
        },
      }
    }
    this.pending.set(key, pending)
    return {
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED',
        reportId,
        fileDisplayName: source.displayName,
        analysisBatches: batches,
        deterministicWarnings: parsed.warnings,
      },
    }
  }

  private buildReport(
    pending: PendingAnalysisV1,
    analysis: TemplateIntakeModelAnalysisV1,
  ): TemplateIntakeReportV1 {
    const warnings: TemplateIntakeWarningV1[] = [...pending.parsed.warnings]
    if (analysis.status === 'DEGRADED') warnings.push(analysis.warning)
    const candidates = applyCandidateLimit(buildCandidates(pending.parsed, analysis), warnings)
    const now = this.nowIso()
    return compactReportIfNeeded({
      reportVersion: TEMPLATE_INTAKE_REPORT_VERSION_V1,
      reportId: pending.reportId,
      status: 'DRAFT',
      file: {
        displayName: pending.source.displayName,
        sha256: pending.source.sha256,
        byteLength: pending.source.byteLength,
      },
      profile: pending.parsed.profile,
      versions: {
        safetyGate: 'xiaogui-jszip-docx-safety-v1',
        structureParser: 'xiaogui-ooxml-structure-v1',
        semanticParser: 'officeparser@7.8.0',
        rules: 'work-p3c-template-intake-rules-v1',
        model: analysis.modelVersion,
      },
      warnings,
      candidates,
      requiresHumanConfirmation: true,
      canMaterializeTemplate: false,
      createdAt: pending.createdAt,
      updatedAt: now,
    })
  }

  private update(
    address: SessionAddressV1,
    operations: readonly TemplateIntakeUpdateOperationV1[],
    reportId?: string,
  ): TemplateIntakeServiceOutcomeV1 {
    const record = this.requireLatest(address)
    if (reportId && record.report.reportId !== reportId) {
      return failure('TEMPLATE_INTAKE_REPORT_NOT_FOUND')
    }
    if (!['DRAFT', 'REVIEWING'].includes(record.report.status)) {
      return failure('TEMPLATE_INTAKE_INPUT_INVALID')
    }
    return this.applyUpdateOperations(record, operations, 'SAVE')
  }

  private async reopen(
    address: SessionAddressV1,
    operations: readonly TemplateIntakeUpdateOperationV1[],
  ): Promise<TemplateIntakeServiceOutcomeV1> {
    const confirmed = this.requireLatest(address)
    if (confirmed.report.status !== 'CONFIRMED' || !confirmed.decision) {
      return failure('TEMPLATE_INTAKE_INPUT_INVALID')
    }

    let source: PrivateSourceV1
    try {
      source = await readPrivateSource(confirmed.sourcePath, this.options.reviewRenderer)
    } catch (error) {
      if (
        error instanceof TemplateIntakeServiceErrorV1 &&
        error.code === 'TEMPLATE_INTAKE_SOURCE_MISSING'
      ) {
        return failure('TEMPLATE_INTAKE_SOURCE_MISSING')
      }
      throw error
    }
    if (source.sha256 !== confirmed.sourceSha256) {
      return failure('TEMPLATE_INTAKE_SOURCE_CHANGED')
    }

    const previousUpdatedAt = Date.parse(confirmed.report.updatedAt)
    const reopenedAt = new Date(
      Math.max(this.now().getTime(), Number.isFinite(previousUpdatedAt) ? previousUpdatedAt + 1 : 0),
    ).toISOString()
    const draftDecisions = confirmed.decision.decisions.map((item) => ({
      candidateId: item.candidateId,
      decision: item.decision,
      ...(item.fieldName ? { fieldName: item.fieldName } : {}),
      ...(item.highRiskOverrideReason
        ? { highRiskOverrideReason: item.highRiskOverrideReason }
        : {}),
      ...(confirmed.decision?.reviewActionsV2
        ? {
            reviewActionsV2: confirmed.decision.reviewActionsV2.filter(
              (action) => action.targetId === item.candidateId,
            ),
          }
        : {}),
    }))
    const record: StoredTemplateIntakeRecordV1 = {
      ...confirmed,
      report: {
        ...confirmed.report,
        reportId: randomUUID(),
        status: 'DRAFT',
        createdAt: reopenedAt,
        updatedAt: reopenedAt,
      },
      draftDecisions,
      decision: undefined,
    }
    return this.applyUpdateOperations(record, operations, 'CREATE')
  }

  private applyUpdateOperations(
    record: StoredTemplateIntakeRecordV1,
    operations: readonly TemplateIntakeUpdateOperationV1[],
    persistence: 'CREATE' | 'SAVE',
  ): TemplateIntakeServiceOutcomeV1 {
    const candidatesById = new Map(
      record.report.candidates.map((candidate) => [candidate.candidateId, candidate]),
    )
    const decisions = new Map(record.draftDecisions.map((item) => [item.candidateId, item]))
    let matchedCandidateCount = 0
    for (const operation of operations) {
      const selectedCandidates = operation.candidateIds
        ? operation.candidateIds.map((candidateId) => candidatesById.get(candidateId))
        : record.report.candidates.filter((candidate) => {
            const match = operation.match
            if (!match) return false
            if (match.kinds && !match.kinds.includes(candidate.kind)) return false
            if (
              match.riskFlags &&
              !match.riskFlags.some((riskFlag) => candidate.riskFlags.includes(riskFlag))
            ) {
              return false
            }
            if (match.keywords) {
              const searchable = [candidate.preview, candidate.reason, candidate.suggestedName ?? '']
                .join('\n')
                .normalize('NFKC')
                .toLocaleLowerCase('zh-CN')
              if (
                !match.keywords.some((keyword) =>
                  searchable.includes(keyword.normalize('NFKC').toLocaleLowerCase('zh-CN')),
                )
              ) {
                return false
              }
            }
            return true
          })
      if (operation.candidateIds && selectedCandidates.some((candidate) => !candidate)) {
        return failure('TEMPLATE_INTAKE_INPUT_INVALID')
      }
      // 一次自然语言请求可能拆成多个条件；允许其中某个条件在当前报告中不存在，
      // 但整次 UPDATE 至少必须命中一项，避免把完全无效的请求伪装成成功。
      if (selectedCandidates.length === 0) continue
      matchedCandidateCount += selectedCandidates.length
      for (const candidate of selectedCandidates) {
        if (!candidate) return failure('TEMPLATE_INTAKE_INPUT_INVALID')
        const candidateId = candidate.candidateId
        const previous = decisions.get(candidateId)
        decisions.set(candidateId, {
          candidateId,
          decision: operation.decision,
          ...(operation.decision === 'VARIABLE'
            ? {
                fieldName:
                  operation.fieldName ??
                  previous?.fieldName ??
                  candidate.suggestedName,
              }
            : {}),
          ...(operation.reason
            ? { highRiskOverrideReason: sliceUnicode(operation.reason, MAX_REASON_CHARS) }
            : {}),
          ...(operation.reviewActionsV2
            ? { reviewActionsV2: operation.reviewActionsV2 }
            : previous?.reviewActionsV2
              ? { reviewActionsV2: previous.reviewActionsV2 }
              : {}),
        })
      }
    }
    if (matchedCandidateCount === 0) return failure('TEMPLATE_INTAKE_INPUT_INVALID')
    record.draftDecisions = [...decisions.values()]
    record.report = withTemplateIntakeStatusV1(
      record.report,
      'DRAFT',
      persistence === 'CREATE' ? record.report.updatedAt : this.nowIso(),
    )
    if (persistence === 'CREATE') this.options.store.create(record)
    else this.options.store.save(record)
    return {
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED',
        report: record.report,
        draftDecisions: record.draftDecisions,
      },
    }
  }

  private async prepareReviewRequestV3(
    record: StoredTemplateIntakeRecordV1,
    source: PrivateSourceV1,
    signal?: AbortSignal,
  ): Promise<TemplateReviewRequestV3 | undefined> {
    const renderer = this.options.reviewRenderer
    if (!renderer) return undefined
    let cached = this.reviewManifests.get(record.report.reportId)
    if (cached && cached.sourceSha256 !== source.sha256) {
      renderer.release(cached.manifestId)
      this.reviewManifests.delete(record.report.reportId)
      cached = undefined
    }
    const projectionTargets = record.report.candidates.map((candidate) => {
      const sourcePart = candidate.sourceAnchors[0]?.part
      return {
        targetId: candidate.candidateId,
        kind: sourcePart === 'DRAWING'
          ? ('IMAGE' as const)
          : sourcePart === 'TABLE'
            ? ('TABLE_CELL' as const)
            : sourcePart
              ? ('TEXT' as const)
              : ('UNMAPPED' as const),
        preview: candidate.preview,
        sourceAnchor: reviewAnchorV2(candidate.sourceAnchors[0]),
      }
    })
    if (cached && cached.prepared.projections.length !== record.report.candidates.length) {
      const normalized = renderer.readNormalizedDocx(cached.manifestId)
      renderer.release(cached.manifestId)
      this.reviewManifests.delete(record.report.reportId)
      cached = undefined
      if (normalized) {
        const prepared = await renderer.prepare(normalized, 'DOCX', signal, projectionTargets)
        cached = {
          sourceSha256: source.sha256,
          manifestId: prepared.manifestId,
          prepared,
        }
        this.reviewManifests.set(record.report.reportId, cached)
      }
    }
    if (!cached) {
      const prepared = await renderer.prepare(source.content, source.inputFormat, signal, projectionTargets)
      cached = {
        sourceSha256: source.sha256,
        manifestId: prepared.manifestId,
        prepared,
      }
      this.reviewManifests.set(record.report.reportId, cached)
    }

    const draftById = new Map(record.draftDecisions.map((item) => [item.candidateId, item]))
    const unmappedTargetIds: string[] = []
    const projectionById = new Map(cached.prepared.projections.map((projection) => [projection.targetId, projection]))
    const targets: TemplateReviewTargetV3[] = record.report.candidates.map((candidate) => {
      const sourcePart = candidate.sourceAnchors[0]?.part
      const kind = sourcePart === 'DRAWING'
        ? ('IMAGE' as const)
        : sourcePart === 'TABLE'
          ? ('TABLE_CELL' as const)
          : sourcePart
            ? ('TEXT' as const)
            : ('UNMAPPED' as const)
      const projection = projectionById.get(candidate.candidateId)
      const renderAnchor: TemplateReviewRenderAnchorV3 = projection
        ? {
            status: projection.status,
            ...(projection.startBookmark ? { startBookmark: projection.startBookmark } : {}),
            ...(projection.endBookmark ? { endBookmark: projection.endBookmark } : {}),
            textSelectionAllowed: projection.textSelectionAllowed,
            ...(projection.objectSelectionAllowed
              ? { objectSelectionAllowed: true }
              : {}),
            ...(projection.expectedTextSha256 ? { expectedTextSha256: projection.expectedTextSha256 } : {}),
            ...(projection.expectedTextLengthUtf16 ? { expectedTextLengthUtf16: projection.expectedTextLengthUtf16 } : {}),
            ...(projection.expectedCompactTextSha256
              ? { expectedCompactTextSha256: projection.expectedCompactTextSha256 }
              : {}),
            ...(projection.expectedCompactTextLengthUtf16 != null
              ? { expectedCompactTextLengthUtf16: projection.expectedCompactTextLengthUtf16 }
              : {}),
          }
        : { status: 'UNMAPPED', textSelectionAllowed: false }
      if (renderAnchor.status !== 'PROJECTED') {
        unmappedTargetIds.push(candidate.candidateId)
      }
      // 兼容旧报告：旧解析器曾在“文档内存在任一浮动对象”时给全部图片
      // 都加上 FLOATING_OBJECT。主进程已可靠投影的行内图片在复核视图中纠正该标记。
      const riskFlags = reviewRiskFlagsV2(candidate).filter(
        (flag) => !(flag === 'FLOATING_OBJECT' && renderAnchor.objectSelectionAllowed),
      )
      const draftActions = draftReviewActionsV2(candidate, draftById.get(candidate.candidateId))
      const needsReview =
        candidate.kind === 'UNRESOLVED' ||
        riskFlags.length > 0 ||
        kind === 'UNMAPPED' ||
        renderAnchor.status !== 'PROJECTED'
      return {
        targetId: candidate.candidateId,
        kind,
        preview: candidate.preview,
        sourceAnchor: reviewAnchorV2(candidate.sourceAnchors[0]),
        renderAnchor,
        reason: candidate.reason,
        confidence: candidate.confidence,
        riskFlags,
        highlight: needsReview ? ('YELLOW' as const) : ('NONE' as const),
        status: draftActions.length ? ('RESOLVED' as const) : ('PENDING' as const),
        highRisk: candidate.riskFlags.length > 0,
      }
    })
    const draftActions = record.report.candidates.flatMap((candidate) => {
      const explicit = draftReviewActionsV2(candidate, draftById.get(candidate.candidateId))
      if (explicit.length) return explicit
      const target = targets.find((item) => item.targetId === candidate.candidateId)
      return target?.highlight === 'NONE'
        ? [{ targetId: candidate.candidateId, kind: 'KEEP' as const }]
        : []
    })
    const warnings = [...cached.prepared.render.warnings]
    if (unmappedTargetIds.length > 0) {
      warnings.push({
        code: 'TARGET_LOCATION_UNMAPPED',
        message: `${unmappedTargetIds.length} 处内容无法可靠映射到页面，已列入右侧人工清单`,
        targetIds: unmappedTargetIds,
      })
    }
    const resolvedTargetCount = targets.filter(
      (target) => target.highlight === 'NONE' || target.status === 'RESOLVED',
    ).length
    return {
      reviewVersion: 3,
      document: {
        reviewVersion: 3,
        reviewId: record.report.reportId,
        status: 'REVIEWING',
        source: {
          displayName: record.report.file.displayName,
          sha256: record.report.file.sha256,
          byteLength: record.report.file.byteLength,
          inputFormat: source.inputFormat,
        },
        render: {
          ...cached.prepared.render,
          warnings,
        },
        targetCount: targets.length,
        pendingTargetCount: targets.length - resolvedTargetCount,
        resolvedTargetCount,
        unmappedTargetCount: unmappedTargetIds.length,
        requiresHumanConfirmation: true,
        sourceReadOnly: true,
        createdAt: record.report.createdAt,
        updatedAt: record.report.updatedAt,
      },
      targets,
      draftActions,
    }
  }

  private async prepareTemplateDraftRequestV2(
    record: StoredTemplateIntakeRecordV1,
    source: PrivateSourceV1,
    signal?: AbortSignal,
  ): Promise<TemplateDraftReviewRequestV2 | undefined> {
    if (this.options.templateDraftV2Enabled === false) return undefined
    const advancedReview = await this.prepareReviewRequestV3(record, source, signal)
    if (!advancedReview) return undefined
    const graph = buildTemplateFieldGraphV2(record.report)
    const issueTargetIds = new Set(
      graph.targetBindings
        .filter((binding) => binding.issueIds.length > 0)
        .map((binding) => binding.targetId),
    )
    return {
      reviewVersion: 4,
      mode: 'QUICK',
      document: {
        ...advancedReview.document,
        pendingTargetCount: graph.fieldGraph.issues.filter((item) => item.status === 'OPEN').length,
        resolvedTargetCount: 0,
      },
      fieldGraph: graph.fieldGraph,
      targetBindings: graph.targetBindings,
      recommendedActions: graph.recommendedActions,
      quickIssueLimit: TEMPLATE_FIELD_QUICK_ISSUE_TARGET_V2,
      advancedReview: {
        ...advancedReview,
        targets: advancedReview.targets.map((target) => ({
          ...target,
          highlight: issueTargetIds.has(target.targetId) ? ('YELLOW' as const) : ('NONE' as const),
        })),
      },
    }
  }

  private confirmedFieldGraphV2(
    report: TemplateIntakeReportV1,
    actions: readonly TemplateReviewActionV2[] | undefined,
    issueChoices: readonly TemplateReviewIssueChoiceV2[] | undefined,
  ): TemplateFieldGraphV2 {
    const built = buildTemplateFieldGraphV2(report)
    if (!actions?.length && !issueChoices?.length) return built.fieldGraph
    const actionByTarget = new Map((actions ?? []).map((action) => [action.targetId, action]))
    const namesByField = new Map<string, Set<string>>()
    for (const binding of built.targetBindings) {
      if (!binding.fieldId) continue
      const action = actionByTarget.get(binding.targetId)
      const name = action?.kind === 'FIELD'
        ? action.fieldName
        : action?.kind === 'REPEAT'
          ? action.blockName
          : action?.kind === 'CONDITIONAL'
            ? action.conditionName
            : null
      if (!name?.trim()) continue
      const names = namesByField.get(binding.fieldId) ?? new Set<string>()
      names.add(name.trim())
      namesByField.set(binding.fieldId, names)
    }
    const choicesByIssue = new Map(issueChoices?.map((choice) => [choice.issueId, choice]) ?? [])
    const resolvedAtLocal = this.nowIso()
    return {
      ...built.fieldGraph,
      fields: built.fieldGraph.fields.map((field) => {
        if (!actions?.length) return field
        const names = namesByField.get(field.fieldId)
        if (!names?.size) return { ...field, status: 'REMOVED' as const }
        const displayName = [...names][0]
        return {
          ...field,
          displayName,
          aliases: displayName === field.displayName
            ? field.aliases
            : [...new Set([...field.aliases, field.displayName])],
          status: 'CONFIRMED' as const,
        }
      }),
      issues: built.fieldGraph.issues.map((issue) => {
        const choice = choicesByIssue.get(issue.issueId)
        if (!choice) return issue
        return {
          ...issue,
          status: 'RESOLVED' as const,
          resolution: {
            action: choice.action,
            ...(choice.reason?.trim() ? { reason: choice.reason.trim() } : {}),
            resolvedAtLocal,
            resolvedBy: 'LOCAL_USER' as const,
          },
        }
      }),
      updatedAt: resolvedAtLocal,
    }
  }

  private async review(
    address: SessionAddressV1,
    submission: TemplateIntakeReviewSubmissionV1 | undefined,
    signal?: AbortSignal,
    reportId?: string,
  ): Promise<TemplateIntakeServiceOutcomeV1> {
    const record = this.requireLatest(address)
    if (reportId && record.report.reportId !== reportId) {
      return failure('TEMPLATE_INTAKE_REPORT_NOT_FOUND')
    }
    if (record.report.status === 'CONFIRMED') {
      return record.decision
        ? {
            ok: true,
            value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CONFIRMED', decision: record.decision },
          }
        : failure('TEMPLATE_INTAKE_STORAGE_FAILED')
    }
    if (!['DRAFT', 'REVIEWING'].includes(record.report.status)) {
      return failure('TEMPLATE_INTAKE_REPORT_NOT_CONFIRMABLE')
    }
    let source: PrivateSourceV1
    try {
      source = await readPrivateSource(record.sourcePath, this.options.reviewRenderer)
    } catch (error) {
      if (
        error instanceof TemplateIntakeServiceErrorV1 &&
        error.code === 'TEMPLATE_INTAKE_SOURCE_MISSING'
      ) {
        return failure('TEMPLATE_INTAKE_SOURCE_MISSING')
      }
      throw error
    }
    if (source.sha256 !== record.sourceSha256) {
      record.report = withTemplateIntakeStatusV1(record.report, 'STALE', this.nowIso())
      record.report = {
        ...record.report,
        warnings: [
          ...record.report.warnings,
          { code: 'SOURCE_CHANGED', message: '源 Word 已变化，原整理报告失效，必须重新分析' },
        ],
      }
      this.options.store.save(record)
      return failure('TEMPLATE_INTAKE_SOURCE_CHANGED')
    }
    if (!submission) {
      const templateDraftRequestV2 = await this.prepareTemplateDraftRequestV2(record, source, signal)
      const reviewRequestV3 = templateDraftRequestV2
        ? undefined
        : await this.prepareReviewRequestV3(record, source, signal)
      return {
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REVIEW_REQUIRED',
          report: record.report,
          draftDecisions: record.draftDecisions,
          ...(templateDraftRequestV2 ? { templateDraftRequestV2 } : {}),
          ...(reviewRequestV3 ? { reviewRequestV3 } : {}),
        },
      }
    }

    const candidates = new Map(record.report.candidates.map((candidate) => [candidate.candidateId, candidate]))
    if (submission.decisions.length !== candidates.size) {
      return failure('TEMPLATE_INTAKE_REPORT_NOT_CONFIRMABLE')
    }
    const seen = new Set<string>()
    for (const item of submission.decisions) {
      const candidate = candidates.get(item.candidateId)
      if (!candidate || seen.has(item.candidateId)) {
        return failure('TEMPLATE_INTAKE_REPORT_NOT_CONFIRMABLE')
      }
      seen.add(item.candidateId)
      if (item.decision === 'VARIABLE' && (!item.fieldName || !item.fieldName.trim())) {
        return failure('TEMPLATE_INTAKE_REPORT_NOT_CONFIRMABLE')
      }
      if (candidate.riskFlags.length > 0 && item.decision !== 'EXCLUDE') {
        if (!item.highRiskOverrideReason?.trim()) {
          return failure('TEMPLATE_INTAKE_HIGH_RISK_REASON_REQUIRED')
        }
        if (item.highRiskOverrideConfirmed !== true) {
          return failure('TEMPLATE_INTAKE_SECOND_CONFIRMATION_REQUIRED')
        }
      }
    }
    if (submission.reviewActionsV2) {
      const actionsByTarget = new Map<string, TemplateReviewActionV2[]>()
      for (const action of submission.reviewActionsV2) {
        const candidate = candidates.get(action.targetId)
        if (!candidate) return failure('TEMPLATE_INTAKE_REPORT_NOT_CONFIRMABLE')
        if (action.range) {
          if (
            !isValidTemplateReviewTextRangeV2(action.range) ||
            action.range.endUtf16Exclusive > candidate.preview.length
          ) {
            return failure('TEMPLATE_INTAKE_REPORT_NOT_CONFIRMABLE')
          }
        }
        const existing = actionsByTarget.get(action.targetId) ?? []
        if (
          action.range &&
          existing.some(
            (previous) =>
              previous.range &&
              previous.range.startUtf16 < action.range!.endUtf16Exclusive &&
              action.range!.startUtf16 < previous.range.endUtf16Exclusive,
          )
        ) {
          return failure('TEMPLATE_INTAKE_REPORT_NOT_CONFIRMABLE')
        }
        if (candidate.riskFlags.length > 0 && action.kind !== 'REMOVE') {
          if (!action.highRiskOverrideReason?.trim()) {
            return failure('TEMPLATE_INTAKE_HIGH_RISK_REASON_REQUIRED')
          }
          if (action.highRiskOverrideConfirmed !== true) {
            return failure('TEMPLATE_INTAKE_SECOND_CONFIRMATION_REQUIRED')
          }
        }
        actionsByTarget.set(action.targetId, [...existing, action])
      }
      if ([...candidates.keys()].some((candidateId) => !actionsByTarget.has(candidateId))) {
        return failure('TEMPLATE_INTAKE_REPORT_NOT_CONFIRMABLE')
      }
    }
    if (submission.issueChoicesV2) {
      const graphIssues = new Map(
        buildTemplateFieldGraphV2(record.report).fieldGraph.issues.map((issue) => [issue.issueId, issue]),
      )
      const seenIssues = new Set<string>()
      for (const choice of submission.issueChoicesV2) {
        const issue = graphIssues.get(choice.issueId)
        if (!issue || seenIssues.has(choice.issueId) || !issue.suggestedActions.includes(choice.action)) {
          return failure('TEMPLATE_INTAKE_REPORT_NOT_CONFIRMABLE')
        }
        seenIssues.add(choice.issueId)
      }
      if ([...graphIssues.keys()].some((issueId) => !seenIssues.has(issueId))) {
        return failure('TEMPLATE_INTAKE_REPORT_NOT_CONFIRMABLE')
      }
    }
    const confirmedAt = localIso(this.now())
    const decision: TemplateIntakeDecisionV1 = {
      decisionVersion: 1,
      reportId: record.report.reportId,
      reportSummary: createTemplateIntakeReportSummaryV1(record.report),
      decisions: submission.decisions,
      ...(submission.reviewActionsV2 ? { reviewActionsV2: submission.reviewActionsV2 } : {}),
      fieldGraphV2: this.confirmedFieldGraphV2(
        record.report,
        submission.reviewActionsV2,
        submission.issueChoicesV2,
      ),
      confirmedAtLocal: confirmedAt,
      confirmedBy: 'LOCAL_USER',
    }
    record.decision = decision
    record.draftDecisions = submission.decisions.map((item) => ({
      ...item,
      ...(submission.reviewActionsV2
        ? {
            reviewActionsV2: submission.reviewActionsV2.filter(
              (action) => action.targetId === item.candidateId,
            ),
          }
        : {}),
    }))
    record.report = withTemplateIntakeStatusV1(record.report, 'CONFIRMED', this.nowIso())
    this.options.store.save(record)
    const prepared = this.reviewManifests.get(record.report.reportId)
    if (prepared) {
      this.options.reviewRenderer?.release(prepared.manifestId)
      this.reviewManifests.delete(record.report.reportId)
    }
    return {
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CONFIRMED', decision },
    }
  }

  private async resume(
    address: SessionAddressV1,
    reportId?: string,
  ): Promise<TemplateIntakeServiceOutcomeV1> {
    const record = reportId
      ? this.options.store.get(address, reportId)
      : this.options.store.latest(address)
    if (!record) return failure('TEMPLATE_INTAKE_REPORT_NOT_FOUND')
    if (record.report.status === 'STALE') return failure('TEMPLATE_INTAKE_SOURCE_CHANGED')

    let source: PrivateSourceV1
    try {
      source = await readPrivateSource(record.sourcePath, this.options.reviewRenderer)
    } catch (error) {
      if (
        !(error instanceof TemplateIntakeServiceErrorV1) ||
        error.code !== 'TEMPLATE_INTAKE_SOURCE_MISSING'
      ) {
        throw error
      }
      const replacement = await this.options.dialogs.chooseSource()
      if (!replacement) return failure('TEMPLATE_INTAKE_SOURCE_MISSING')
      source = await readPrivateSource(replacement, this.options.reviewRenderer)
    }
    if (source.sha256 !== record.sourceSha256) {
      record.report = withTemplateIntakeStatusV1(record.report, 'STALE', this.nowIso())
      record.report = {
        ...record.report,
        warnings: [
          ...record.report.warnings,
          { code: 'SOURCE_CHANGED', message: '源 Word 已变化，原整理报告失效，必须重新分析' },
        ],
      }
      this.options.store.save(record)
      return failure('TEMPLATE_INTAKE_SOURCE_CHANGED')
    }
    if (record.sourcePath !== source.path) {
      record.sourcePath = source.path
      this.options.store.save(record)
    }
    return {
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_RESUMED',
        report: record.report,
        draftDecisions: record.draftDecisions,
        ...(record.decision ? { decision: record.decision } : {}),
      },
    }
  }

  private delete(
    address: SessionAddressV1,
    reportId: string,
    confirmed: true,
  ): TemplateIntakeServiceOutcomeV1 {
    if (confirmed !== true) return failure('TEMPLATE_INTAKE_DELETE_CONFIRMATION_REQUIRED')
    if (!this.options.store.delete(address, reportId)) {
      return failure('TEMPLATE_INTAKE_REPORT_NOT_FOUND')
    }
    const prepared = this.reviewManifests.get(reportId)
    if (prepared) {
      this.options.reviewRenderer?.release(prepared.manifestId)
      this.reviewManifests.delete(reportId)
    }
    const key = scopeKey(address)
    if (this.pending.get(key)?.reportId === reportId) this.pending.delete(key)
    return {
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_DELETED', reportId },
    }
  }

  private cancel(address: SessionAddressV1): TemplateIntakeServiceOutcomeV1 {
    const key = scopeKey(address)
    if (this.pending.delete(key)) {
      return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CANCELLED' } }
    }
    const record = this.options.store.latest(address)
    if (record && record.report.status !== 'CONFIRMED') {
      record.report = withTemplateIntakeStatusV1(record.report, 'CANCELLED', this.nowIso())
      this.options.store.save(record)
    }
    return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CANCELLED' } }
  }

  private requireLatest(address: SessionAddressV1): StoredTemplateIntakeRecordV1 {
    const record = this.options.store.latest(address)
    if (!record) throw new TemplateIntakeServiceErrorV1('TEMPLATE_INTAKE_REPORT_NOT_FOUND')
    return record
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}
