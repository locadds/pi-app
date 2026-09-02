import type { IDocumentData } from '@univerjs/core'
import type { FDocument } from '@univerjs/docs-ui/facade'

import type { OfficeStructuredDocumentProjectionV1 } from '@shared/xiaogui-office-surface'

export const OFFICE_WORKTREE_ENVELOPE_VERSION_V1 = 1 as const

export interface OfficeUniverWorktreeEnvelopeV1 {
  readonly envelopeVersion: typeof OFFICE_WORKTREE_ENVELOPE_VERSION_V1
  readonly kind: 'XIAOGUI_UNIVER_WORKTREE'
  readonly document: IDocumentData
  readonly projection: Omit<OfficeStructuredDocumentProjectionV1, 'plainText' | 'univerDocument'>
}

export interface ProjectionMaterializeResultV1 {
  readonly mappedOccurrenceIds: readonly string[]
  readonly unmappedOccurrenceIds: readonly string[]
}

/**
 * The main process already builds the Univer snapshot. The viewer only verifies
 * that every advertised occurrence still points at the original text.
 */
export async function materializeStructuredProjectionV1(
  projection: OfficeStructuredDocumentProjectionV1,
  document: FDocument,
): Promise<ProjectionMaterializeResultV1> {
  const dataStream = document.getSnapshot().body?.dataStream ?? ''
  const mapped: string[] = []
  const unmapped: string[] = []
  for (const occurrence of projection.occurrences) {
    if (
      dataStream.slice(occurrence.startUtf16, occurrence.endUtf16Exclusive)
      === occurrence.originalText
    ) mapped.push(occurrence.occurrenceId)
    else unmapped.push(occurrence.occurrenceId)
  }
  return { mappedOccurrenceIds: mapped, unmappedOccurrenceIds: unmapped }
}

export function isOfficeUniverWorktreeEnvelopeV1(value: unknown): value is OfficeUniverWorktreeEnvelopeV1 {
  if (!value || typeof value !== 'object') return false
  const envelope = value as Record<string, unknown>
  return envelope.envelopeVersion === OFFICE_WORKTREE_ENVELOPE_VERSION_V1
    && envelope.kind === 'XIAOGUI_UNIVER_WORKTREE'
    && isOfficeUniverDocumentSnapshotV1(envelope.document)
    && !!envelope.projection
    && typeof envelope.projection === 'object'
}

export function isOfficeUniverDocumentSnapshotV1(value: unknown): value is Partial<IDocumentData> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Record<string, unknown>
  const body = snapshot.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  if (typeof (body as Record<string, unknown>).dataStream !== 'string') return false
  if ('id' in snapshot && typeof snapshot.id !== 'string') return false
  return !('documentStyle' in snapshot)
    || (!!snapshot.documentStyle && typeof snapshot.documentStyle === 'object' && !Array.isArray(snapshot.documentStyle))
}

export function worktreeEnvelopeV1(
  document: IDocumentData,
  projection: OfficeStructuredDocumentProjectionV1,
): OfficeUniverWorktreeEnvelopeV1 {
  const {
    plainText: _plainText,
    univerDocument: _univerDocument,
    ...projectionMetadata
  } = projection
  return {
    envelopeVersion: OFFICE_WORKTREE_ENVELOPE_VERSION_V1,
    kind: 'XIAOGUI_UNIVER_WORKTREE',
    document,
    projection: projectionMetadata,
  }
}
