/** WORK 对话草稿生成标准 DOCX 的版本化契约。 */
export const WORK_REPORT_DOCX_VERSION_V1 = 1 as const

export interface WorkReportSectionV1 {
  heading: string
  paragraphs: readonly string[]
  bullets: readonly string[]
}

/** 模型只提交当前对话中已经形成的纯文本草稿。 */
export interface WorkReportDraftV1 {
  title: string
  sections: readonly WorkReportSectionV1[]
}

export type WorkReportDocxStatusV1 = 'PREPARED' | 'PUBLISHED' | 'CANCELLED'

/** 公开预览包含受限纯文本草稿，刻意不包含文件名或路径。 */
export interface WorkReportDocxPlanV1 {
  planVersion: typeof WORK_REPORT_DOCX_VERSION_V1
  sectionCount: number
  paragraphCount: number
  bulletCount: number
  characterCount: number
  previewSha256: string
  preview: WorkReportDraftV1
  requiresSecondConfirmation: true
}

/** 发布回执同样只包含可校验摘要，不暴露保存位置。 */
export interface WorkReportDocxReceiptV1 {
  receiptVersion: typeof WORK_REPORT_DOCX_VERSION_V1
  sectionCount: number
  paragraphCount: number
  bulletCount: number
  characterCount: number
  outputSha256: string
  publishedAtLocal: string
}

export type WorkReportDocxErrorCodeV1 =
  | 'REPORT_DOCX_SCOPE_NOT_FOUND'
  | 'REPORT_DOCX_SCOPE_MISMATCH'
  | 'REPORT_DOCX_MODE_NOT_ALLOWED'
  | 'REPORT_DOCX_OPERATION_ACTIVE'
  | 'REPORT_DOCX_NO_PENDING_OPERATION'
  | 'REPORT_DOCX_CONFIRMATION_REQUIRED'
  | 'REPORT_DOCX_DRAFT_INVALID'
  | 'REPORT_DOCX_DRAFT_TOO_LARGE'
  | 'REPORT_DOCX_PREVIEW_MISSING'
  | 'REPORT_DOCX_PREVIEW_CHANGED'
  | 'REPORT_DOCX_PREVIEW_OPEN_FAILED'
  | 'REPORT_DOCX_TARGET_INVALID'
  | 'REPORT_DOCX_TARGET_EXISTS'
  | 'REPORT_DOCX_RENDER_FAILED'
  | 'REPORT_DOCX_PUBLISH_FAILED'
  | 'REPORT_DOCX_NO_PUBLISHED_OUTPUT'
  | 'REPORT_DOCX_STORAGE_FAILED'
  | 'REPORT_DOCX_ABORTED'
