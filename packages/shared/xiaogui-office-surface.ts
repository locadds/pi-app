export const OFFICE_SURFACE_PROTOCOL_V1 = 'xiaogui.office-surface.v1' as const

export type OfficeSurfaceModeV1 = 'OFF' | 'UNIVER_EXPERIMENTAL' | 'UNIVER_PREFERRED'

export type OfficeSnapshotV1 = Record<string, unknown>

export interface OfficeSurfaceCapabilityV1 {
  readonly readSnapshot: boolean
  readonly writeSnapshot: boolean
  readonly syntheticDocument: boolean
  readonly docxImport: boolean
  readonly docxExport: boolean
  readonly nonDestructiveDecoration: boolean
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

export type OfficeSurfaceParentMessageV1 =
  | (OfficeSurfaceMessageBaseV1 & { readonly type: 'PARENT_PING' })
  | (OfficeSurfaceMessageBaseV1 & { readonly type: 'PARENT_SAVE' })
  | (OfficeSurfaceMessageBaseV1 & { readonly type: 'PARENT_RELOAD' })
  | (OfficeSurfaceMessageBaseV1 & { readonly type: 'PARENT_DISPOSE' })

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
  const type = (value as Record<string, unknown>).type
  return type === 'PARENT_PING' || type === 'PARENT_SAVE' || type === 'PARENT_RELOAD' || type === 'PARENT_DISPOSE'
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
  ].every((key) => typeof capabilities[key] === 'boolean')
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}
