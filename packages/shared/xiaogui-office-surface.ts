export const OFFICE_SURFACE_PROTOCOL_V1 = 'xiaogui.office-surface.v1' as const

export type OfficeSurfaceModeV1 = 'OFF' | 'UNIVER_EXPERIMENTAL' | 'UNIVER_PREFERRED'

export type OfficeSnapshotV1 = Record<string, unknown>

export type OfficeSurfacePurposeV1 =
  | 'TEMPLATE_DRAFT'
  | 'MATERIALIZED_PREVIEW'
  | 'TEMPLATE_LIBRARY_PREVIEW'

export interface OfficeSurfaceSourceAnchorV1 {
  readonly part: 'BODY' | 'HEADER' | 'FOOTER' | 'TABLE_CELL' | 'TEXT_BOX' | 'DRAWING'
  readonly sectionIndex?: number
  readonly partIndex?: number
  readonly paragraphIndex?: number
  readonly tableIndex?: number
  readonly rowIndex?: number
  readonly cellIndex?: number
  readonly drawingIndex?: number
}

export interface OfficeSurfaceFieldV1 {
  readonly fieldId: string
  readonly displayName: string
  readonly occurrenceIds: readonly string[]
}

export interface OfficeSurfaceOccurrenceV1 {
  readonly occurrenceId: string
  readonly fieldId: string
  readonly originalText: string
  readonly sourceAnchor: OfficeSurfaceSourceAnchorV1
  readonly textRange?: {
    readonly startUtf16: number
    readonly endUtf16Exclusive: number
  }
  readonly state: 'FIELD' | 'WARNING' | 'BLOCKING'
}

export interface OfficeSurfaceProjectedOccurrenceV1 {
  readonly occurrenceId: string
  readonly fieldId: string
  readonly originalText: string
  readonly startUtf16: number
  readonly endUtf16Exclusive: number
  readonly state: OfficeSurfaceOccurrenceV1['state']
}

/**
 * 开源 Univer 不包含官方 DOCX Exchange。单机试验版先把安全解析后的
 * 文档结构投影成可编辑正文；它不是 DOCX 像素级导入结果。
 */
export interface OfficeStructuredDocumentProjectionV1 {
  readonly projectionVersion: 1
  readonly kind: 'XIAOGUI_DOCX_STRUCTURED_PROJECTION'
  readonly documentId: string
  readonly title: string
  readonly sourceSha256: string
  readonly plainText: string
  readonly fields: readonly OfficeSurfaceFieldV1[]
  readonly occurrences: readonly OfficeSurfaceProjectedOccurrenceV1[]
  readonly warnings: readonly string[]
  readonly statistics: {
    readonly paragraphCount: number
    readonly tableCount: number
    readonly tableCellCount: number
    readonly mappedOccurrenceCount: number
    readonly unmappedOccurrenceCount: number
  }
}

export interface OfficeSurfaceSessionPrepareV1 {
  readonly purpose: OfficeSurfacePurposeV1
  readonly documentToken: string
  readonly title: string
  readonly fields?: readonly OfficeSurfaceFieldV1[]
  readonly occurrences?: readonly OfficeSurfaceOccurrenceV1[]
}

export interface OfficeSurfaceSessionReadyV1 {
  readonly sessionVersion: 1
  readonly sessionId: string
  readonly mode: Exclude<OfficeSurfaceModeV1, 'OFF'>
  readonly gatewayOrigin: string
  /** 仅由可信 Renderer 经 MessagePort 交给 Viewer，不得写入 URL 或会话。 */
  readonly gatewayAccessToken: string
  readonly sourceSha256: string
  readonly warnings: readonly string[]
  readonly statistics: OfficeStructuredDocumentProjectionV1['statistics']
}

export interface OfficeSurfaceCapabilityV1 {
  readonly readSnapshot: boolean
  readonly writeSnapshot: boolean
  readonly syntheticDocument: boolean
  readonly docxImport: boolean
  readonly docxExport: boolean
  readonly nonDestructiveDecoration: boolean
  readonly structuredDocxProjection: boolean
}

interface OfficeSurfaceMessageBaseV1 {
  readonly protocol: typeof OFFICE_SURFACE_PROTOCOL_V1
  readonly channelNonce: string
}

export type OfficeSurfaceViewerMessageV1 =
  | (OfficeSurfaceMessageBaseV1 & {
      readonly type: 'VIEWER_READY'
      readonly capabilities: OfficeSurfaceCapabilityV1
    })
  | (OfficeSurfaceMessageBaseV1 & {
      readonly type: 'VIEWER_DIRTY_STATE'
      readonly dirty: boolean
      readonly headSha256: string
    })
  | (OfficeSurfaceMessageBaseV1 & {
      readonly type: 'VIEWER_ERROR'
      readonly code: string
      readonly message: string
    })

export interface OfficeSurfacePortOfferV1 extends OfficeSurfaceMessageBaseV1 {
  readonly type: 'OFFICE_PORT_OFFER'
  readonly gatewayAccessToken: string
}

export type OfficeSurfaceParentMessageV1 =
  | (OfficeSurfaceMessageBaseV1 & { readonly type: 'PARENT_PING' })
  | (OfficeSurfaceMessageBaseV1 & { readonly type: 'PARENT_SAVE' })
  | (OfficeSurfaceMessageBaseV1 & { readonly type: 'PARENT_RELOAD' })
  | (OfficeSurfaceMessageBaseV1 & { readonly type: 'PARENT_DISPOSE' })
  | (OfficeSurfaceMessageBaseV1 & {
      readonly type: 'PARENT_FOCUS_FIELD'
      readonly fieldId: string
    })
  | (OfficeSurfaceMessageBaseV1 & {
      readonly type: 'PARENT_FOCUS_OCCURRENCE'
      readonly occurrenceId: string
    })

export function readOfficeSurfaceModeV1(
  value = typeof process === 'undefined' ? undefined : process.env.XIAOGUI_OFFICE_SURFACE,
): OfficeSurfaceModeV1 {
  return value === 'UNIVER_EXPERIMENTAL' || value === 'UNIVER_PREFERRED' ? value : 'OFF'
}

export function isOfficeSurfaceViewerMessageV1(value: unknown): value is OfficeSurfaceViewerMessageV1 {
  if (!isMessageBase(value)) return false
  const message = value as Record<string, unknown>
  if (message.type === 'VIEWER_READY') return isCapabilities(message.capabilities)
  if (message.type === 'VIEWER_DIRTY_STATE') {
    return typeof message.dirty === 'boolean' && isDigest(message.headSha256)
  }
  if (message.type === 'VIEWER_ERROR') {
    return typeof message.code === 'string' && typeof message.message === 'string'
  }
  return false
}

export function isOfficeSurfaceParentMessageV1(value: unknown): value is OfficeSurfaceParentMessageV1 {
  if (!isMessageBase(value)) return false
  const message = value as Record<string, unknown>
  const type = message.type
  if (type === 'PARENT_FOCUS_FIELD') return typeof message.fieldId === 'string' && message.fieldId.length > 0
  if (type === 'PARENT_FOCUS_OCCURRENCE') {
    return typeof message.occurrenceId === 'string' && message.occurrenceId.length > 0
  }
  return type === 'PARENT_PING' || type === 'PARENT_SAVE' || type === 'PARENT_RELOAD' || type === 'PARENT_DISPOSE'
}

export function isOfficeSurfacePortOfferV1(value: unknown): value is OfficeSurfacePortOfferV1 {
  if (!isMessageBase(value)) return false
  const message = value as Record<string, unknown>
  return message.type === 'OFFICE_PORT_OFFER'
    && typeof message.gatewayAccessToken === 'string'
    && message.gatewayAccessToken.length >= 32
    && message.gatewayAccessToken.length <= 512
}

export function isOfficeStructuredDocumentProjectionV1(
  value: unknown,
): value is OfficeStructuredDocumentProjectionV1 {
  if (!value || typeof value !== 'object') return false
  const projection = value as Record<string, unknown>
  return projection.projectionVersion === 1
    && projection.kind === 'XIAOGUI_DOCX_STRUCTURED_PROJECTION'
    && typeof projection.documentId === 'string'
    && typeof projection.title === 'string'
    && typeof projection.sourceSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(projection.sourceSha256)
    && typeof projection.plainText === 'string'
    && Array.isArray(projection.fields)
    && Array.isArray(projection.occurrences)
    && Array.isArray(projection.warnings)
}

function isMessageBase(value: unknown): value is OfficeSurfaceMessageBaseV1 & Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return message.protocol === OFFICE_SURFACE_PROTOCOL_V1
    && typeof message.channelNonce === 'string'
    && message.channelNonce.length >= 32
    && message.channelNonce.length <= 256
}

function isCapabilities(value: unknown): value is OfficeSurfaceCapabilityV1 {
  if (!value || typeof value !== 'object') return false
  const capabilities = value as Record<string, unknown>
  return [
    'readSnapshot',
    'writeSnapshot',
    'syntheticDocument',
    'docxImport',
    'docxExport',
    'nonDestructiveDecoration',
    'structuredDocxProjection',
  ].every((key) => typeof capabilities[key] === 'boolean')
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}
