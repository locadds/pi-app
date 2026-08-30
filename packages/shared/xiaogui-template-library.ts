import type {
  TemplateReviewRenderV3,
} from './xiaogui-work-template-review'
import type { TemplateFieldGraphV2 } from './xiaogui-template-field-graph-v2'

/** 小规本机个人模板库公开契约。公开数据永远不包含本机路径。 */
export const TEMPLATE_LIBRARY_CONTRACT_VERSION_V1 = 1 as const
export const TEMPLATE_LIBRARY_PREVIEW_VERSION_V1 = 1 as const
export const TEMPLATE_LIBRARY_ASSET_MANIFEST_VERSION_V2 = 2 as const

export type TemplateLibraryEntryStatusV1 = 'ACTIVE' | 'TRASHED'
export type TemplateLibraryAssetLifecycleV2 =
  | 'REVIEWING'
  | 'VALIDATING'
  | 'AVAILABLE'
  | 'VERIFIED'
  | 'STALE'
  | 'ARCHIVED'

export interface TemplateLibraryAssetManifestV2 {
  manifestVersion: typeof TEMPLATE_LIBRARY_ASSET_MANIFEST_VERSION_V2
  lifecycle: TemplateLibraryAssetLifecycleV2
  /** 复核确认后的完整业务字段图谱；不得包含路径或原始 OOXML。 */
  fieldGraph: TemplateFieldGraphV2
  issueDecisions: readonly {
    issueId: string
    action: string
    reason?: string
    resolvedAtLocal: string
  }[]
  validation: {
    status: 'PASSED' | 'WARNING' | 'FAILED'
    checks: readonly {
      code: string
      status: 'PASSED' | 'WARNING' | 'FAILED'
      message: string
    }[]
  }
  provenance: {
    reportId: string
    sourceSha256: string
    decisionSha256: string
    materializedSha256: string
    createdAtLocal: string
  }
}

export interface TemplateLibraryFieldSummaryV1 {
  /** 稳定字段编号；同一模板版本内唯一。 */
  fieldId: string
  /** 面向用户的中文字段名。 */
  name: string
  kind: 'TEXT' | 'IMAGE' | 'REPEAT' | 'CONDITIONAL'
  required: boolean
}

/** 单个不可变模板版本的无路径摘要。 */
export interface TemplateLibraryVersionSummaryV1 {
  versionId: string
  versionNumber: number
  sha256: string
  byteLength: number
  /** 该不可变版本自己的字段结构，选择历史版本时仍可直接生成。 */
  fields: readonly TemplateLibraryFieldSummaryV1[]
  /** 旧版记录可能没有；有值时才是模板资产 V2。 */
  assetManifestV2?: TemplateLibraryAssetManifestV2
  createdAt: string
  isLatest: boolean
}

/** 模板选择器、检索结果和列表统一使用的无路径摘要。 */
export interface TemplateLibrarySummaryV1 {
  libraryVersion: typeof TEMPLATE_LIBRARY_CONTRACT_VERSION_V1
  entryId: string
  name: string
  purpose?: string
  tags: readonly string[]
  fields: readonly TemplateLibraryFieldSummaryV1[]
  status: TemplateLibraryEntryStatusV1
  latestVersion: TemplateLibraryVersionSummaryV1
  versionCount: number
  createdAt: string
  updatedAt: string
  trashedAt?: string
}

export interface TemplateLibraryDetailV1 extends TemplateLibrarySummaryV1 {
  /** 新版本在前；历史版本保持不可变。 */
  versions: readonly TemplateLibraryVersionSummaryV1[]
}

export interface TemplateLibraryListQueryV1 {
  /** 同时匹配名称、用途和标签；空白等同不筛选。 */
  query?: string
  /** 必须同时包含这些标签。 */
  tags?: readonly string[]
  status?: TemplateLibraryEntryStatusV1 | 'ALL'
  limit?: number
  offset?: number
}

export interface TemplateLibraryListResultV1 {
  items: readonly TemplateLibrarySummaryV1[]
  total: number
  limit: number
  offset: number
}

export interface TemplateLibraryUsageV1 {
  uniqueAssetCount: number
  templateCount: number
  activeTemplateCount: number
  trashedTemplateCount: number
  versionCount: number
  /** 内容寻址去重后的实际 DOCX 资产占用。 */
  totalAssetBytes: number
  /** 首期没有容量上限，也不会自动清理。 */
  capacityLimitBytes: null
}

/**
 * 单次本机模板预览会话。manifestId 和 documentToken 都是不透明临时令牌；
 * 文件路径、DOCX 二进制以及 LibreOffice 私有工作目录不得进入此对象。
 */
export interface TemplateLibraryPreviewV1 {
  previewVersion: typeof TEMPLATE_LIBRARY_PREVIEW_VERSION_V1
  manifestId: string
  entryId: string
  entryName: string
  versionId: string
  versionNumber: number
  render: TemplateReviewRenderV3
}

export interface TemplateLibraryPreviewReleaseResultV1 {
  released: boolean
}

export interface TemplateLibraryConfigurationV1 {
  configured: boolean
}

export interface TemplateLibrarySaveMetadataV1 {
  name: string
  purpose?: string
  tags?: readonly string[]
  fields?: readonly TemplateLibraryFieldSummaryV1[]
  assetManifestV2?: TemplateLibraryAssetManifestV2
}

export interface TemplateLibrarySaveResultV1 {
  entry: TemplateLibraryDetailV1
  version: TemplateLibraryVersionSummaryV1
  /** 相同内容只保存一份资产；即使复用资产，仍会建立不可变的新版本。 */
  assetDeduplicated: boolean
}

export type TemplateLibraryErrorCodeV1 =
  | 'TEMPLATE_LIBRARY_NOT_CONFIGURED'
  | 'TEMPLATE_LIBRARY_ROOT_INVALID'
  | 'TEMPLATE_LIBRARY_NAME_INVALID'
  | 'TEMPLATE_LIBRARY_TAG_INVALID'
  | 'TEMPLATE_LIBRARY_FIELD_INVALID'
  | 'TEMPLATE_LIBRARY_ASSET_MANIFEST_INVALID'
  | 'TEMPLATE_LIBRARY_DOCUMENT_INVALID'
  | 'TEMPLATE_LIBRARY_ENTRY_NOT_FOUND'
  | 'TEMPLATE_LIBRARY_VERSION_NOT_FOUND'
  | 'TEMPLATE_LIBRARY_ENTRY_TRASHED'
  | 'TEMPLATE_LIBRARY_ENTRY_NOT_TRASHED'
  | 'TEMPLATE_LIBRARY_STORAGE_FAILED'
