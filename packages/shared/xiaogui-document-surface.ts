import type {
  TemplateIssueResolutionV2,
} from './xiaogui-template-field-graph-v2'

/**
 * 模板核心与文档显示/编辑内核之间的可替换接缝。
 * 本文件不得导入 Univer、WPS、Word、ONLYOFFICE 或 docx-preview。
 */
export interface DocumentSurfaceOpenInputV1 {
  draftId: string
  documentToken: string
  readOnlySource: true
}

export interface DocumentSelectionV1 {
  occurrenceId?: string
  startUtf16?: number
  endUtf16Exclusive?: number
  text: string
}

export interface DocumentMutationReceiptV1 {
  updatedOccurrenceIds: readonly string[]
  failedOccurrenceIds: readonly string[]
  warnings: readonly string[]
}

export interface DocumentSnapshotReceiptV1 {
  documentToken: string
  sha256: string
}

export interface DocumentReviewReceiptV1 {
  blockingIssueIds: readonly string[]
  warningIssueIds: readonly string[]
}

export interface DocumentExportReceiptV1 {
  exportToken: string
  sha256: string
}

export interface DocumentSurfaceV1 {
  readonly kind: 'UNIVER' | 'ONLYOFFICE' | 'WPS_NATIVE' | 'WORD_NATIVE' | 'HTML'

  openDraft(input: DocumentSurfaceOpenInputV1): Promise<void>
  close(): Promise<void>

  focusField(fieldId: string): Promise<void>
  focusOccurrence(occurrenceId: string): Promise<void>
  focusIssue(issueId: string): Promise<void>
  highlightIssues(issueIds: readonly string[]): Promise<void>
  readSelection(): Promise<DocumentSelectionV1 | null>

  updateField(input: {
    fieldId: string
    value: string
    occurrenceIds: readonly string[]
  }): Promise<DocumentMutationReceiptV1>
  applyIssueResolution(input: {
    issueId: string
    resolution: TemplateIssueResolutionV2
  }): Promise<DocumentMutationReceiptV1>
  setOccurrenceState(input: {
    occurrenceId: string
    state: 'NORMAL' | 'FIELD' | 'WARNING' | 'BLOCKING'
  }): Promise<void>

  flush(): Promise<DocumentSnapshotReceiptV1>
  saveDraft(): Promise<DocumentSnapshotReceiptV1>
  prepareReview(): Promise<DocumentReviewReceiptV1>
  exportDraft(): Promise<DocumentExportReceiptV1>
}

