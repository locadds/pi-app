import { CustomDecorationType, type IDocumentData } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import { addCustomDecorationFactory } from '@univerjs/docs-ui'
import type { FDocument } from '@univerjs/docs-ui/facade'

import type {
  OfficeStructuredDocumentProjectionV1,
  OfficeSurfaceProjectedOccurrenceV1,
} from '@shared/xiaogui-office-surface'

export const OFFICE_WORKTREE_ENVELOPE_VERSION_V1 = 1 as const

export interface OfficeUniverWorktreeEnvelopeV1 {
  readonly envelopeVersion: typeof OFFICE_WORKTREE_ENVELOPE_VERSION_V1
  readonly kind: 'XIAOGUI_UNIVER_WORKTREE'
  readonly document: IDocumentData
  readonly projection: Omit<OfficeStructuredDocumentProjectionV1, 'plainText'>
}

export interface ProjectionMaterializeResultV1 {
  readonly mappedOccurrenceIds: readonly string[]
  readonly unmappedOccurrenceIds: readonly string[]
}

export async function materializeStructuredProjectionV1(
  projection: OfficeStructuredDocumentProjectionV1,
  document: FDocument,
  univerAPI: FUniver,
): Promise<ProjectionMaterializeResultV1> {
  // Univer documents use CRLF paragraph separators. `appendText` inserts raw
  // bytes and therefore leaves projected LF-only DOCX text outside the normal
  // paragraph model (the snapshot contains it, but the canvas stays blank).
  // The public paragraph API normalizes the separators and refreshes layout.
  await document.insertParagraph(projection.plainText)
  const dataStream = document.getSnapshot().body?.dataStream ?? ''
  const mapped: string[] = []
  const unmapped: string[] = []

  for (const occurrence of projection.occurrences) {
    const range = resolveOccurrenceRange(dataStream, projection.plainText, occurrence)
    if (!range) {
      unmapped.push(occurrence.occurrenceId)
      continue
    }
    const mutation = addCustomDecorationFactory({
      unitId: document.getId(),
      id: occurrenceDecorationIdV1(occurrence.occurrenceId),
      type: CustomDecorationType.COMMENT,
      ranges: [{
        startOffset: range.start,
        endOffset: range.end,
        collapsed: false,
      }],
    })
    const executed = await univerAPI.executeCommand(mutation.id, mutation.params)
    if (executed) mapped.push(occurrence.occurrenceId)
    else unmapped.push(occurrence.occurrenceId)
  }
  return { mappedOccurrenceIds: mapped, unmappedOccurrenceIds: unmapped }
}

export function occurrenceDecorationIdV1(occurrenceId: string): string {
  return `xiaogui.occurrence.v1:${occurrenceId}`
}

export function isOfficeUniverWorktreeEnvelopeV1(value: unknown): value is OfficeUniverWorktreeEnvelopeV1 {
  if (!value || typeof value !== 'object') return false
  const envelope = value as Record<string, unknown>
  return envelope.envelopeVersion === OFFICE_WORKTREE_ENVELOPE_VERSION_V1
    && envelope.kind === 'XIAOGUI_UNIVER_WORKTREE'
    && !!envelope.document
    && typeof envelope.document === 'object'
    && !!envelope.projection
    && typeof envelope.projection === 'object'
}

export function worktreeEnvelopeV1(
  document: IDocumentData,
  projection: OfficeStructuredDocumentProjectionV1,
): OfficeUniverWorktreeEnvelopeV1 {
  const { plainText: _plainText, ...projectionMetadata } = projection
  return {
    envelopeVersion: OFFICE_WORKTREE_ENVELOPE_VERSION_V1,
    kind: 'XIAOGUI_UNIVER_WORKTREE',
    document,
    projection: projectionMetadata,
  }
}

function resolveOccurrenceRange(
  dataStream: string,
  projectedText: string,
  occurrence: OfficeSurfaceProjectedOccurrenceV1,
): { start: number; end: number } | null {
  const base = dataStream.indexOf(projectedText)
  if (base >= 0) {
    const start = base + occurrence.startUtf16
    const end = base + occurrence.endUtf16Exclusive
    if (dataStream.slice(start, end) === occurrence.originalText) return { start, end }
  }
  const documentText = toUniverParagraphText(occurrence.originalText)
  const expected = projectedOffsetToUniverOffset(projectedText, occurrence.startUtf16)
  let nearest = -1
  let distance = Number.POSITIVE_INFINITY
  let cursor = dataStream.indexOf(documentText)
  while (cursor >= 0) {
    const nextDistance = Math.abs(cursor - expected)
    if (nextDistance < distance) {
      nearest = cursor
      distance = nextDistance
    }
    cursor = dataStream.indexOf(documentText, cursor + Math.max(1, documentText.length))
  }
  return nearest < 0 ? null : { start: nearest, end: nearest + documentText.length }
}

function projectedOffsetToUniverOffset(projectedText: string, offset: number): number {
  return toUniverParagraphText(projectedText.slice(0, Math.max(0, offset))).length
}

function toUniverParagraphText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\r\n')
}
