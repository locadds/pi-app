import type { SessionAddressV1 } from './xiaogui-session-scope'

/**
 * WORK 文档快照：主进程按页抽取的规范化文本。
 *
 * 契约约束：
 * - 绝不携带地址、绝对路径、临时路径、文件句柄或密码；
 * - 首版只允许 kind: 'PDF'，抽取器固定为 unpdf 1.6.2 内嵌的 PDF.js；
 * - textSha256 对规范化单页 UTF-8 文本计算；contentSha256 对按页码排序后的
 *   { pageNumber, textSha256 }[] 稳定 JSON 计算。
 */
export type DocumentSnapshotWarningV1 = 'TRUNCATED' | 'SCANNED_OR_EMPTY'

export interface DocumentSnapshotPageV1 {
  pageNumber: number
  text: string
  textSha256: string
}

export interface DocumentSnapshotV1 {
  version: 'document-snapshot.v1'
  kind: 'PDF'
  sourceDisplayName: string
  sourceSha256: string
  extractorId: 'unpdf'
  extractorVersion: '1.6.2'
  pageCount: number
  pages: readonly DocumentSnapshotPageV1[]
  contentSha256: string
  warnings: readonly DocumentSnapshotWarningV1[]
  originalInputUnchanged: true
}

export type WorkDocumentSnapshotErrorCodeV1 =
  | 'SCOPE_NOT_FOUND'
  | 'SCOPE_MISMATCH'
  | 'MODE_NOT_ALLOWED'
  | 'INPUT_INVALID'
  | 'INPUT_TOO_LARGE'
  | 'PAGE_RANGE_INVALID'
  | 'PDF_ENCRYPTED'
  | 'PDF_CORRUPTED'
  | 'PARSE_TIMEOUT'
  | 'PARSE_ABORTED'
  | 'PARSE_FAILED'
  | 'SOURCE_CHANGED'

export type WorkDocumentSnapshotOutcomeV1<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: WorkDocumentSnapshotErrorCodeV1; messageKey: string } }

export interface WorkDocumentSnapshotReadRequestV1 {
  address: SessionAddressV1
  /** 1 起始；省略时从第 1 页开始。 */
  startPage?: number
  /** 1 起始含端点；省略时从 startPage 起最多读取 20 页。 */
  endPage?: number
}

export type WorkDocumentSnapshotReadResultV1 =
  | { kind: 'CANCELLED' }
  | { kind: 'READY'; snapshot: DocumentSnapshotV1 }
