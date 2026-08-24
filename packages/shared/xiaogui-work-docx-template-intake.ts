/** WORK 普通成品 Word 只读整理契约。所有序号均从 1 开始。 */

export const TEMPLATE_INTAKE_REPORT_VERSION_V1 = 1 as const
export const TEMPLATE_INTAKE_MAX_PREVIEW_CHARS_V1 = 500 as const
export const TEMPLATE_INTAKE_MAX_CANDIDATES_V1 = 200 as const
export const TEMPLATE_INTAKE_MAX_REPORT_BYTES_V1 = 2 * 1024 * 1024
export const TEMPLATE_INTAKE_MAX_ANALYSIS_CHARS_V1 = 200_000 as const
export const TEMPLATE_INTAKE_MAX_BATCH_CHARS_V1 = 20_000 as const
export const TEMPLATE_INTAKE_MAX_BATCHES_V1 = 10 as const
export const TEMPLATE_INTAKE_REVIEW_PAGE_SIZE_V1 = 20 as const

export type TemplateIntakeActionV1 =
  | 'START'
  | 'UPDATE'
  | 'REVIEW'
  | 'RESUME'
  | 'DELETE'
  | 'CANCEL'

export type TemplateIntakeReportStatusV1 =
  | 'ANALYZING'
  | 'DRAFT'
  | 'REVIEWING'
  | 'CONFIRMED'
  | 'STALE'
  | 'CANCELLED'

export const TEMPLATE_INTAKE_ALLOWED_ACTIONS_BY_STATUS_V1 = {
  ANALYZING: ['CANCEL'],
  DRAFT: ['UPDATE', 'REVIEW', 'RESUME', 'DELETE', 'CANCEL'],
  REVIEWING: ['REVIEW', 'CANCEL'],
  CONFIRMED: ['RESUME', 'DELETE'],
  STALE: ['START', 'DELETE'],
  CANCELLED: ['START', 'RESUME', 'DELETE'],
} as const satisfies Record<TemplateIntakeReportStatusV1, readonly TemplateIntakeActionV1[]>

export type TemplateIntakeSourcePartV1 =
  | 'BODY'
  | 'HEADER'
  | 'FOOTER'
  | 'TABLE'
  | 'TEXT_BOX'
  | 'DRAWING'

/**
 * 无路径来源锚点。只表达 Word 内的逻辑位置，不携带 OOXML、全文或内部存储标识。
 */
export interface TemplateIntakeSourceAnchorV1 {
  part: TemplateIntakeSourcePartV1
  sectionIndex?: number
  partIndex?: number
  paragraphIndex?: number
  tableIndex?: number
  rowIndex?: number
  cellIndex?: number
  drawingIndex?: number
}

export type TemplateIntakePageCountBasisV1 =
  | 'ACTUAL_RENDERING'
  | 'DOCUMENT_PROPERTY'
  | 'UNKNOWN'

export interface TemplateIntakeDocumentProfileV1 {
  pageCount: {
    value: number | null
    basis: TemplateIntakePageCountBasisV1
  }
  sectionCount: number
  headerPartCount: number
  footerPartCount: number
  tableCount: number
  mediaCount: number
  inlineDrawingCount: number
  floatingDrawingCount: number
  textBoxCount: number
  fieldCount: number
  contentControlCount: number
  /** OCR 关闭时不能可靠判断就必须为 null。 */
  scannedPageCount: number | null
}

export type TemplateIntakeCandidateKindV1 =
  | 'FIXED'
  | 'VARIABLE'
  | 'REPEAT'
  | 'CONDITIONAL'
  | 'EXCLUDE'
  | 'UNRESOLVED'

export type TemplateIntakeFinalDecisionKindV1 = Exclude<
  TemplateIntakeCandidateKindV1,
  'UNRESOLVED'
>

export type TemplateIntakeRiskFlagV1 =
  | 'SIGNATURE'
  | 'SEAL'
  | 'CONTACT_INFORMATION'
  | 'OLD_PROJECT_DRAWING'
  | 'SCANNED_ATTACHMENT'
  | 'FLOATING_OBJECT'
  | 'TEXT_BOX'
  | 'OTHER'

export interface TemplateIntakeCandidateV1 {
  candidateId: string
  kind: TemplateIntakeCandidateKindV1
  /** 最多 500 个 Unicode 字符；不得包含文件路径或完整 OOXML。 */
  preview: string
  sourceAnchors: readonly TemplateIntakeSourceAnchorV1[]
  reason: string
  /** 确定性规则可使用 1；无法可靠判断时为 null。 */
  confidence: number | null
  riskFlags: readonly TemplateIntakeRiskFlagV1[]
  defaultDecision: TemplateIntakeCandidateKindV1
  suggestedName?: string
}

export type TemplateIntakeWarningCodeV1 =
  | 'PAGE_COUNT_UNKNOWN'
  | 'SCAN_COUNT_UNKNOWN'
  | 'SEMANTIC_ALIGNMENT_FAILED'
  | 'SEMANTIC_COUNT_MISMATCH'
  | 'FLOATING_CONTENT_REQUIRES_REVIEW'
  | 'TEXT_BOX_REQUIRES_REVIEW'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_OUTPUT_INVALID'
  | 'ANALYSIS_LIMIT_EXCEEDED'
  | 'CANDIDATE_LIMIT_EXCEEDED'
  | 'REPORT_SIZE_LIMIT_EXCEEDED'
  | 'SOURCE_CHANGED'
  | 'OTHER'

export interface TemplateIntakeWarningV1 {
  code: TemplateIntakeWarningCodeV1
  message: string
  sourceAnchors?: readonly TemplateIntakeSourceAnchorV1[]
}

export interface TemplateIntakeVersionInfoV1 {
  safetyGate: string
  structureParser: string
  semanticParser: string
  rules: string
  /** 当前 WORK 会话模型不可用或安全降级时为 null。 */
  model: string | null
}

export interface TemplateIntakeReportV1 {
  reportVersion: typeof TEMPLATE_INTAKE_REPORT_VERSION_V1
  reportId: string
  status: TemplateIntakeReportStatusV1
  file: {
    displayName: string
    sha256: string
    byteLength: number
  }
  profile: TemplateIntakeDocumentProfileV1
  versions: TemplateIntakeVersionInfoV1
  warnings: readonly TemplateIntakeWarningV1[]
  candidates: readonly TemplateIntakeCandidateV1[]
  requiresHumanConfirmation: true
  canMaterializeTemplate: false
  createdAt: string
  updatedAt: string
}

export interface TemplateIntakeDraftDecisionItemV1 {
  candidateId: string
  decision: TemplateIntakeCandidateKindV1
  fieldName?: string
  /** 高风险内容不再排除时必填。 */
  highRiskOverrideReason?: string
  /** 只允许结构化复核卡在第二次确认后写入 true。 */
  highRiskOverrideConfirmed?: true
}

export interface TemplateIntakeFinalDecisionItemV1
  extends Omit<TemplateIntakeDraftDecisionItemV1, 'decision'> {
  decision: TemplateIntakeFinalDecisionKindV1
}

export interface TemplateIntakeReportSummaryV1 {
  reportId: string
  fileDisplayName: string
  fileSha256: string
  candidateCount: number
  warningCount: number
}

export interface TemplateIntakeDecisionV1 {
  decisionVersion: 1
  reportId: string
  reportSummary: TemplateIntakeReportSummaryV1
  decisions: readonly TemplateIntakeFinalDecisionItemV1[]
  confirmedAtLocal: string
  confirmedBy: 'LOCAL_USER'
}

/** Worker 发给现有 Extension UI 的无路径复核卡载荷。 */
export interface TemplateIntakeReviewRequestV1 {
  report: TemplateIntakeReportV1
  draftDecisions: readonly TemplateIntakeDraftDecisionItemV1[]
  pageSize: typeof TEMPLATE_INTAKE_REVIEW_PAGE_SIZE_V1
}

/** 关闭或挂起不会产生此结果；只有明确提交才返回完整决定清单。 */
export type TemplateIntakeReviewResultV1 =
  | {
      cancelled: true
      /** 关闭复核卡时仍回传逐项草稿，供主进程私有保存；不会生成确认记录。 */
      draftDecisions: readonly TemplateIntakeDraftDecisionItemV1[]
    }
  | {
      cancelled: false
      decisions: readonly TemplateIntakeFinalDecisionItemV1[]
    }

export interface TemplateIntakeUpdateMatchV1 {
  /** 同一维度内“任一匹配”，不同维度之间“同时满足”。 */
  kinds?: readonly TemplateIntakeCandidateKindV1[]
  riskFlags?: readonly TemplateIntakeRiskFlagV1[]
  /** 仅匹配无路径短预览、判断理由和建议字段名。 */
  keywords?: readonly string[]
}

interface TemplateIntakeUpdateOperationBaseV1 {
  decision: TemplateIntakeCandidateKindV1
  fieldName?: string
  reason?: string
}

/** 必须使用候选编号或主进程条件匹配之一，不能同时使用。 */
export type TemplateIntakeUpdateOperationV1 = TemplateIntakeUpdateOperationBaseV1 &
  (
    | { candidateIds: readonly string[]; match?: never }
    | { candidateIds?: never; match: TemplateIntakeUpdateMatchV1 }
  )

export type TemplateIntakeErrorCodeV1 =
  | 'TEMPLATE_INTAKE_SCOPE_NOT_FOUND'
  | 'TEMPLATE_INTAKE_SCOPE_MISMATCH'
  | 'TEMPLATE_INTAKE_MODE_NOT_ALLOWED'
  | 'TEMPLATE_INTAKE_INPUT_INVALID'
  | 'TEMPLATE_INTAKE_INPUT_TOO_LARGE'
  | 'TEMPLATE_INTAKE_UNSAFE_DOCX'
  | 'TEMPLATE_INTAKE_OPERATION_ACTIVE'
  | 'TEMPLATE_INTAKE_REPORT_NOT_FOUND'
  | 'TEMPLATE_INTAKE_REPORT_LIMIT_REACHED'
  | 'TEMPLATE_INTAKE_SOURCE_MISSING'
  | 'TEMPLATE_INTAKE_SOURCE_CHANGED'
  | 'TEMPLATE_INTAKE_PARSER_FAILED'
  | 'TEMPLATE_INTAKE_REPORT_NOT_CONFIRMABLE'
  | 'TEMPLATE_INTAKE_HIGH_RISK_REASON_REQUIRED'
  | 'TEMPLATE_INTAKE_SECOND_CONFIRMATION_REQUIRED'
  | 'TEMPLATE_INTAKE_DELETE_CONFIRMATION_REQUIRED'
  | 'TEMPLATE_INTAKE_STORAGE_FAILED'
  | 'TEMPLATE_INTAKE_ABORTED'

export function createTemplateIntakeReportSummaryV1(
  report: TemplateIntakeReportV1,
): TemplateIntakeReportSummaryV1 {
  return {
    reportId: report.reportId,
    fileDisplayName: report.file.displayName,
    fileSha256: report.file.sha256,
    candidateCount: report.candidates.length,
    warningCount: report.warnings.length,
  }
}
