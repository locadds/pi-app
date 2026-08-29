import type {
  TemplateIntakeReportSummaryV1,
  TemplateIntakeSourceAnchorV1,
} from './xiaogui-work-docx-template-intake'
import type { TemplateReviewDocumentV3 } from './xiaogui-work-template-review'

/** WORK 已确认整理报告到正式 Word 模板的物化契约。 */
export const TEMPLATE_MATERIALIZE_VERSION_V1 = 1 as const

export type TemplateMaterializeActionV1 =
  | 'PREPARE'
  | 'CONFIRM'
  | 'RESUME'
  | 'CANCEL'
  | 'OPEN'
  | 'REVEAL'
  | 'EXPORT'

export type TemplateMaterializeStatusV1 =
  | 'PREPARED'
  | 'PUBLISHED'
  | 'CANCELLED'
  | 'STALE'

export type TemplateMaterializeDynamicKindV1 = 'VARIABLE' | 'REPEAT' | 'CONDITIONAL'

export interface TemplateMaterializeDynamicItemV1 {
  name: string
  kind: TemplateMaterializeDynamicKindV1
  sourceAnchors: readonly TemplateIntakeSourceAnchorV1[]
}

/**
 * 无路径预览计划。变量替换整段或整单元格；重复/条件块写成 Word 内容控件。
 */
export interface TemplateMaterializePlanV1 {
  materializeVersion: typeof TEMPLATE_MATERIALIZE_VERSION_V1
  reportSummary: TemplateIntakeReportSummaryV1
  source: {
    displayName: string
    sha256: string
    byteLength: number
  }
  previewSha256: string
  variables: readonly TemplateMaterializeDynamicItemV1[]
  repeatBlocks: readonly TemplateMaterializeDynamicItemV1[]
  conditionalBlocks: readonly TemplateMaterializeDynamicItemV1[]
  excludedCandidateCount: number
  removedMediaCount: number
  retainedHighRiskCount: number
  warnings: readonly string[]
  requiresSecondConfirmation: true
  originalSourceUnchanged: true
  /** 当前简单字段生成器只消费变量；重复/条件结构留给后续高级生成器。 */
  advancedGenerationRequired: boolean
}

export interface TemplateMaterializeReceiptV1 {
  receiptVersion: 1
  reportId: string
  sourceSha256: string
  decisionSha256: string
  outputSha256: string
  variableNames: readonly string[]
  repeatBlockNames: readonly string[]
  conditionalBlockNames: readonly string[]
  excludedCandidateCount: number
  removedMediaCount: number
  originalSourceUnchanged: true
  publishedAtLocal: string
  /** 正式模板已先保存进本机模板库；不包含任何本机路径。 */
  library?: {
    entryId: string
    versionId: string
    versionNumber: number
    templateName: string
  }
}

/**
 * 修改后整份模板在小规内的只读预览。页面只通过主进程签发的令牌读取，
 * 不包含源文件、临时文件或 LibreOffice 的本机路径。
 */
export interface TemplateMaterializePreviewRequestV1 {
  previewVersion: 1
  document: TemplateReviewDocumentV3
  plan: TemplateMaterializePlanV1
  suggestedTemplateName: string
}

export type TemplateMaterializePreviewResultV1 =
  | {
      action: 'CONFIRM'
      previewSha256: string
      templateName?: string
      purpose?: string
      tags?: readonly string[]
    }
  | { action: 'MODIFY'; previewSha256: string; instruction: string }
  | { action: 'CANCEL' }

export type TemplateMaterializeErrorCodeV1 =
  | 'TEMPLATE_MATERIALIZE_SCOPE_NOT_FOUND'
  | 'TEMPLATE_MATERIALIZE_SCOPE_MISMATCH'
  | 'TEMPLATE_MATERIALIZE_MODE_NOT_ALLOWED'
  | 'TEMPLATE_MATERIALIZE_REPORT_NOT_FOUND'
  | 'TEMPLATE_MATERIALIZE_REPORT_NOT_CONFIRMED'
  | 'TEMPLATE_MATERIALIZE_OPERATION_ACTIVE'
  | 'TEMPLATE_MATERIALIZE_NO_PENDING_OPERATION'
  | 'TEMPLATE_MATERIALIZE_CONFIRMATION_REQUIRED'
  | 'TEMPLATE_MATERIALIZE_SOURCE_MISSING'
  | 'TEMPLATE_MATERIALIZE_SOURCE_CHANGED'
  | 'TEMPLATE_MATERIALIZE_DECISION_CHANGED'
  | 'TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND'
  | 'TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT'
  | 'TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT'
  | 'TEMPLATE_MATERIALIZE_DYNAMIC_NAME_INVALID'
  | 'TEMPLATE_MATERIALIZE_PREVIEW_OPEN_FAILED'
  | 'TEMPLATE_MATERIALIZE_TARGET_INVALID'
  | 'TEMPLATE_MATERIALIZE_TARGET_EXISTS'
  | 'TEMPLATE_MATERIALIZE_GENERATION_FAILED'
  | 'TEMPLATE_MATERIALIZE_PUBLISH_FAILED'
  | 'TEMPLATE_MATERIALIZE_NO_PUBLISHED_OUTPUT'
  | 'TEMPLATE_MATERIALIZE_LIBRARY_NOT_CONFIGURED'
  | 'TEMPLATE_MATERIALIZE_LIBRARY_SAVE_FAILED'
  | 'TEMPLATE_MATERIALIZE_STORAGE_FAILED'
  | 'TEMPLATE_MATERIALIZE_ABORTED'
