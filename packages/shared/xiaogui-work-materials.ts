export const WORK_MATERIALS_SNAPSHOT_VERSION_V1 = 'work-materials-snapshot.v1' as const

export type WorkMaterialReadStatusV1 =
  | 'CONTENT_EXTRACTED'
  | 'METADATA_ONLY'
  | 'READ_FAILED'

export type WorkMaterialExtractorV1 = 'PLAIN_TEXT' | 'OFFICEPARSER' | 'METADATA'

export type WorkMaterialWarningV1 =
  | 'CONTENT_TRUNCATED'
  | 'CONTENT_BUDGET_EXHAUSTED'
  | 'FILE_TOO_LARGE'
  | 'FORMAT_NOT_SEMANTICALLY_SUPPORTED'
  | 'SYMLINK_NOT_FOLLOWED'
  | 'READ_FAILED'
  | 'PARSE_FAILED'
  | 'NO_TEXT_EXTRACTED'
  | 'INVENTORY_TRUNCATED'
  | 'INFRASTRUCTURE_DIRECTORY_SKIPPED'

export interface WorkMaterialFileV1 {
  /** 用户明确批准：WORK 工具结果允许携带本机真实路径。 */
  absolutePath: string
  displayName: string
  extension: string
  byteSize: number
  status: WorkMaterialReadStatusV1
  extractor: WorkMaterialExtractorV1
  content?: string
  warnings: readonly WorkMaterialWarningV1[]
}

export interface WorkMaterialsSnapshotV1 {
  version: typeof WORK_MATERIALS_SNAPSHOT_VERSION_V1
  requestedPaths: readonly string[]
  totalFileCount: number
  totalDirectoryCount: number
  extractedFileCount: number
  metadataOnlyFileCount: number
  failedFileCount: number
  files: readonly WorkMaterialFileV1[]
  warnings: readonly WorkMaterialWarningV1[]
  originalInputsUnchanged: true
}
