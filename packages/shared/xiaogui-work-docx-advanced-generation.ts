/** WORK 正式模板到高级成品文档的版本化契约。 */
export const ADVANCED_GENERATION_VERSION_V1 = 1 as const

export type AdvancedGenerationStatusV1 = 'SELECTED' | 'PREPARED' | 'PUBLISHED' | 'CANCELLED' | 'STALE'

export interface AdvancedTemplateSlotV1 {
  slotId: string
  sourceKind: 'PARAGRAPH' | 'TABLE_CELL'
  ordinal: number
  preview: string
}

export interface AdvancedTemplateRepeatBlockV1 {
  name: string
  slots: readonly AdvancedTemplateSlotV1[]
}

export interface AdvancedTemplateConditionalBlockV1 {
  name: string
  preview: string
}

/** 只向 Worker/模型公开无路径、无全文的模板结构摘要。 */
export interface AdvancedTemplateSchemaV1 {
  schemaVersion: typeof ADVANCED_GENERATION_VERSION_V1
  template: { displayName: string; sha256: string; byteLength: number }
  variables: readonly string[]
  repeatBlocks: readonly AdvancedTemplateRepeatBlockV1[]
  conditionalBlocks: readonly AdvancedTemplateConditionalBlockV1[]
  warnings: readonly string[]
  requiresCompleteData: true
  originalTemplateReadOnly: true
}

export interface AdvancedVariableInputV1 {
  name: string
  status: 'RESOLVED' | 'UNRESOLVED'
  value?: string | number | boolean
}

export interface AdvancedRepeatSlotInputV1 {
  slotId: string
  value: string | number | boolean
}

export interface AdvancedRepeatRecordInputV1 {
  slots: readonly AdvancedRepeatSlotInputV1[]
}

export interface AdvancedRepeatBlockInputV1 {
  name: string
  status: 'RESOLVED' | 'UNRESOLVED'
  records?: readonly AdvancedRepeatRecordInputV1[]
}

export interface AdvancedConditionalInputV1 {
  name: string
  status: 'RESOLVED' | 'UNRESOLVED'
  value?: boolean
}

export interface AdvancedTemplateDataV1 {
  dataVersion: typeof ADVANCED_GENERATION_VERSION_V1
  variables: readonly AdvancedVariableInputV1[]
  repeatBlocks: readonly AdvancedRepeatBlockInputV1[]
  conditionalBlocks: readonly AdvancedConditionalInputV1[]
}

export interface AdvancedGenerationPlanV1 {
  planVersion: typeof ADVANCED_GENERATION_VERSION_V1
  schema: AdvancedTemplateSchemaV1
  dataSha256: string
  previewSha256: string
  repeatRecordCount: number
  retainedConditionalCount: number
  requiresSecondConfirmation: true
  originalTemplateUnchanged: true
}

export interface AdvancedGenerationReceiptV1 {
  receiptVersion: typeof ADVANCED_GENERATION_VERSION_V1
  templateSha256: string
  dataSha256: string
  outputSha256: string
  repeatRecordCount: number
  retainedConditionalCount: number
  originalTemplateUnchanged: true
  publishedAtLocal: string
}

export type AdvancedGenerationErrorCodeV1 =
  | 'ADVANCED_GENERATION_SCOPE_NOT_FOUND'
  | 'ADVANCED_GENERATION_SCOPE_MISMATCH'
  | 'ADVANCED_GENERATION_MODE_NOT_ALLOWED'
  | 'ADVANCED_GENERATION_OPERATION_ACTIVE'
  | 'ADVANCED_GENERATION_NO_PENDING_OPERATION'
  | 'ADVANCED_GENERATION_CONFIRMATION_REQUIRED'
  | 'ADVANCED_GENERATION_SELECTION_CANCELLED'
  | 'ADVANCED_GENERATION_TEMPLATE_MISSING'
  | 'ADVANCED_GENERATION_TEMPLATE_CHANGED'
  | 'ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED'
  | 'ADVANCED_GENERATION_STRUCTURE_INVALID'
  | 'ADVANCED_GENERATION_INPUT_REQUIRED'
  | 'ADVANCED_GENERATION_DATA_INVALID'
  | 'ADVANCED_GENERATION_PREVIEW_OPEN_FAILED'
  | 'ADVANCED_GENERATION_TARGET_INVALID'
  | 'ADVANCED_GENERATION_TARGET_EXISTS'
  | 'ADVANCED_GENERATION_RENDER_FAILED'
  | 'ADVANCED_GENERATION_PUBLISH_FAILED'
  | 'ADVANCED_GENERATION_NO_PUBLISHED_OUTPUT'
  | 'ADVANCED_GENERATION_STORAGE_FAILED'
  | 'ADVANCED_GENERATION_ABORTED'
