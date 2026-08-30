export const OFFICE_DRAWING_DEGRADATION_PREFIX_V1 = 'XIAOGUI_DOCX_DRAWING_DEGRADATION_V1:'

export type OfficeDrawingDegradationReasonV1 =
  | 'GROUP_DRAWING'
  | 'MISSING_RELATIONSHIP'
  | 'RELATIONSHIP_NOT_FOUND'
  | 'EXTERNAL_IMAGE'
  | 'NON_IMAGE_RELATIONSHIP'
  | 'MEDIA_MISSING'
  | 'UNSUPPORTED_FORMAT'
  | 'SVG_RASTER_FALLBACK'
  | 'OLE_RASTER_PREVIEW'
  | 'CROP_NOT_APPLIED'
  | 'COMPLEX_WRAP_APPROXIMATION'

export interface OfficeDrawingDegradationV1 {
  readonly kind: 'XIAOGUI_DOCX_DRAWING_DEGRADATION'
  readonly version: 1
  readonly id: string
  readonly part: 'BODY' | 'HEADER' | 'FOOTER'
  readonly partIndex: number
  readonly sequence: number
  readonly severity: 'INFO' | 'WARNING'
  readonly reason: OfficeDrawingDegradationReasonV1
  readonly message: string
  readonly relationshipId?: string
  readonly format?: string
}

export interface OfficeSurfaceWarningDisplayItemV1 {
  readonly key: string
  readonly message: string
  readonly raw: string
  readonly degradation: OfficeDrawingDegradationV1 | null
}

const REASONS = new Set<OfficeDrawingDegradationReasonV1>([
  'GROUP_DRAWING',
  'MISSING_RELATIONSHIP',
  'RELATIONSHIP_NOT_FOUND',
  'EXTERNAL_IMAGE',
  'NON_IMAGE_RELATIONSHIP',
  'MEDIA_MISSING',
  'UNSUPPORTED_FORMAT',
  'SVG_RASTER_FALLBACK',
  'OLE_RASTER_PREVIEW',
  'CROP_NOT_APPLIED',
  'COMPLEX_WRAP_APPROXIMATION',
])

export function encodeOfficeDrawingDegradationV1(record: OfficeDrawingDegradationV1): string {
  const safeRecord: OfficeDrawingDegradationV1 = {
    kind: record.kind,
    version: record.version,
    id: record.id,
    part: record.part,
    partIndex: record.partIndex,
    sequence: record.sequence,
    severity: record.severity,
    reason: record.reason,
    message: redactDrawingLocationV1(record.message),
    ...(isSafeDrawingSummaryV1(record.relationshipId) ? { relationshipId: record.relationshipId } : {}),
    ...(isSafeDrawingSummaryV1(record.format) ? { format: record.format } : {}),
  }
  return `${OFFICE_DRAWING_DEGRADATION_PREFIX_V1}${JSON.stringify(safeRecord)}`
}

export function parseOfficeDrawingDegradationV1(value: string): OfficeDrawingDegradationV1 | null {
  if (!value.startsWith(OFFICE_DRAWING_DEGRADATION_PREFIX_V1)) return null
  try {
    const parsed: unknown = JSON.parse(value.slice(OFFICE_DRAWING_DEGRADATION_PREFIX_V1.length))
    if (!parsed || typeof parsed !== 'object') return null
    const candidate = parsed as Partial<OfficeDrawingDegradationV1>
    const partIndex = candidate.partIndex
    const sequence = candidate.sequence
    if (
      candidate.kind !== 'XIAOGUI_DOCX_DRAWING_DEGRADATION'
      || candidate.version !== 1
      || typeof candidate.id !== 'string'
      || !candidate.id
      || (candidate.part !== 'BODY' && candidate.part !== 'HEADER' && candidate.part !== 'FOOTER')
      || typeof partIndex !== 'number'
      || !Number.isInteger(partIndex)
      || typeof sequence !== 'number'
      || !Number.isInteger(sequence)
      || (candidate.severity !== 'INFO' && candidate.severity !== 'WARNING')
      || !candidate.reason
      || !REASONS.has(candidate.reason)
      || typeof candidate.message !== 'string'
      || !candidate.message
    ) return null
    return {
      kind: candidate.kind,
      version: candidate.version,
      id: candidate.id,
      part: candidate.part,
      partIndex,
      sequence,
      severity: candidate.severity,
      reason: candidate.reason,
      message: redactDrawingLocationV1(candidate.message),
      ...(isSafeDrawingSummaryV1(candidate.relationshipId) ? { relationshipId: candidate.relationshipId } : {}),
      ...(isSafeDrawingSummaryV1(candidate.format) ? { format: candidate.format } : {}),
    }
  } catch {
    return null
  }
}

function isSafeDrawingSummaryV1(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value))
}

function redactDrawingLocationV1(message: string): string {
  return message
    .replace(/(?:https?|file):\/\/[^\s，。；）)]+/gi, '[外部位置已隐藏]')
    .replace(/\\\\[^\s，。；）)]+/g, '[外部位置已隐藏]')
    .replace(/\b[A-Za-z]:[\\/][^\s，。；）)]+/g, '[本机位置已隐藏]')
}

/**
 * The Office IPC schema intentionally transports warnings as strings. This
 * projection restores structured drawing degradations for display without
 * hiding ordinary or malformed warnings.
 */
export function officeSurfaceWarningDisplayItemsV1(
  warnings: readonly string[],
): readonly OfficeSurfaceWarningDisplayItemV1[] {
  return warnings.map((raw, index) => {
    const degradation = parseOfficeDrawingDegradationV1(raw)
    return {
      key: degradation ? `drawing-${degradation.id}` : `warning-${index + 1}`,
      message: degradation?.message ?? raw,
      raw,
      degradation,
    }
  })
}
