import { createHash } from 'node:crypto'

import JSZip from 'jszip'

import type { IDocumentData, ITextRun, ITextStyle } from '@univerjs/core'
import type {
  OfficeStructuredDocumentProjectionV1,
  OfficeSurfaceFieldV1,
  OfficeSurfaceOccurrenceV1,
  OfficeSurfacePurposeV1,
  OfficeSurfaceProjectedOccurrenceV1,
  OfficeSnapshotV1,
} from '@shared/xiaogui-office-surface'
import {
  buildDocxUniverDocumentV1,
  type DocxUniverTextAnchorV1,
} from './docx-univer-document-adapter'

const MAX_PROJECTED_TEXT_UTF16 = 500_000
const MAX_OCCURRENCES = 2_000
const NON_TEXT_TOKENS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g

export interface DocxUniverProjectionInputV1 {
  readonly content: Buffer
  readonly title: string
  readonly purpose: OfficeSurfacePurposeV1
  readonly readOnly: boolean
  readonly fields?: readonly OfficeSurfaceFieldV1[]
  readonly occurrences?: readonly OfficeSurfaceOccurrenceV1[]
}

export async function projectDocxToUniverV1(
  input: DocxUniverProjectionInputV1,
): Promise<OfficeStructuredDocumentProjectionV1> {
  const occurrences = input.occurrences ?? []
  if (occurrences.length > MAX_OCCURRENCES) throw new Error('OFFICE_PROJECTION_TOO_MANY_OCCURRENCES')

  const sourceSha256 = createHash('sha256').update(input.content).digest('hex')
  const zip = await JSZip.loadAsync(input.content, { checkCRC32: true })
  const mainXml = await zip.file('word/document.xml')?.async('string')
  if (!mainXml) throw new Error('OFFICE_PROJECTION_DOCUMENT_XML_MISSING')
  const documentId = `xiaogui-docx-${sourceSha256.slice(0, 20)}`
  const built = await buildDocxUniverDocumentV1({
    zip,
    mainXml,
    documentId,
    title: cleanTitle(input.title),
  })
  const dataStream = built.document.body?.dataStream ?? ''
  const plainText = dataStream
    .replaceAll('\r', '\n')
    .replaceAll('\f', '\n')
    .replace(NON_TEXT_TOKENS_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (plainText.length > MAX_PROJECTED_TEXT_UTF16 || dataStream.length > MAX_PROJECTED_TEXT_UTF16 + 50_000) {
    throw new Error('OFFICE_PROJECTION_TEXT_LIMIT_EXCEEDED')
  }

  const anchorByKey = new Map(built.anchors.map((anchor) => [anchor.anchorKey, anchor]))
  const projectedOccurrences: OfficeSurfaceProjectedOccurrenceV1[] = []
  const warnings = [...built.warnings]
  const usedRanges: Array<{ start: number; end: number }> = []
  const globalCursorByText = new Map<string, number>()
  for (const occurrence of occurrences) {
    const anchor = anchorByKey.get(anchorKey(occurrence))
    let start = anchor ? locateInAnchor(anchor, occurrence.originalText, occurrence.textRange) : -1
    if (start < 0 && occurrence.originalText) {
      const cursor = globalCursorByText.get(occurrence.originalText) ?? 0
      start = dataStream.indexOf(occurrence.originalText, cursor)
      if (start >= 0) globalCursorByText.set(occurrence.originalText, start + occurrence.originalText.length)
    }
    const end = start + occurrence.originalText.length
    if (
      start < 0
      || end <= start
      || dataStream.slice(start, end) !== occurrence.originalText
      || usedRanges.some((range) => start < range.end && range.start < end)
    ) {
      warnings.push(`字段位置 ${occurrence.occurrenceId} 无法可靠映射，已保留在右侧问题清单。`)
      continue
    }
    usedRanges.push({ start, end })
    projectedOccurrences.push({
      occurrenceId: occurrence.occurrenceId,
      fieldId: occurrence.fieldId,
      originalText: occurrence.originalText,
      startUtf16: start,
      endUtf16Exclusive: end,
      state: occurrence.state,
    })
  }

  applyOccurrenceHighlights(built.document, projectedOccurrences)
  const unmappedOccurrenceCount = occurrences.length - projectedOccurrences.length
  if (!warnings.length) warnings.push('文档已按 DOCX 原结构导入；页面换行可能与 Microsoft Word 略有差异。')

  return {
    projectionVersion: 1,
    kind: 'XIAOGUI_DOCX_STRUCTURED_PROJECTION',
    documentId,
    title: cleanTitle(input.title),
    sourceSha256,
    purpose: input.purpose,
    readOnly: input.readOnly,
    plainText,
    univerDocument: built.document as unknown as OfficeSnapshotV1,
    fields: input.fields ?? [],
    occurrences: projectedOccurrences,
    warnings: [...new Set(warnings)],
    statistics: {
      paragraphCount: built.statistics.paragraphCount,
      tableCount: built.statistics.tableCount,
      tableCellCount: built.statistics.tableCellCount,
      mappedOccurrenceCount: projectedOccurrences.length,
      unmappedOccurrenceCount,
    },
  }
}

function applyOccurrenceHighlights(
  document: IDocumentData,
  occurrences: readonly OfficeSurfaceProjectedOccurrenceV1[],
): void {
  const body = document.body
  if (!body || !occurrences.length) return
  const originalRuns = body.textRuns ?? []
  const boundaries = new Set<number>()
  for (const run of originalRuns) {
    boundaries.add(run.st)
    boundaries.add(run.ed)
  }
  for (const occurrence of occurrences) {
    boundaries.add(occurrence.startUtf16)
    boundaries.add(occurrence.endUtf16Exclusive)
  }
  const points = [...boundaries].sort((left, right) => left - right)
  const nextRuns: ITextRun[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    if (end <= start) continue
    const original = originalRuns.find((run) => run.st <= start && end <= run.ed)
    const occurrence = occurrences.find((item) => item.startUtf16 <= start && end <= item.endUtf16Exclusive)
    if (!original && !occurrence) continue
    const style: ITextStyle = {
      ...(original?.ts ?? {}),
      ...(occurrence ? { bg: { rgb: occurrenceColor(occurrence.state) } } : {}),
    }
    const previous = nextRuns[nextRuns.length - 1]
    if (previous && previous.ed === start && JSON.stringify(previous.ts ?? {}) === JSON.stringify(style)) {
      previous.ed = end
    } else {
      nextRuns.push({ st: start, ed: end, ts: style })
    }
  }
  body.textRuns = nextRuns
}

function occurrenceColor(state: OfficeSurfaceProjectedOccurrenceV1['state']): string {
  if (state === 'BLOCKING') return '#FFD27A'
  if (state === 'WARNING') return '#FFE59A'
  return '#FFF2B2'
}

function anchorKey(occurrence: OfficeSurfaceOccurrenceV1): string {
  const anchor = occurrence.sourceAnchor
  if (anchor.part === 'TABLE_CELL') {
    return `BODY:0:T:${anchor.tableIndex ?? 0}:${anchor.rowIndex ?? 0}:${anchor.cellIndex ?? 0}`
  }
  if (anchor.part === 'HEADER' || anchor.part === 'FOOTER') {
    return `${anchor.part}:${anchor.partIndex ?? 1}:P:${anchor.paragraphIndex ?? 0}`
  }
  return `BODY:0:P:${anchor.paragraphIndex ?? 0}`
}

function locateInAnchor(
  anchor: DocxUniverTextAnchorV1,
  text: string,
  requestedRange: OfficeSurfaceOccurrenceV1['textRange'],
): number {
  if (!text) return -1
  if (
    requestedRange
    && anchor.text.slice(requestedRange.startUtf16, requestedRange.endUtf16Exclusive) === text
  ) {
    return anchor.documentOffsets[requestedRange.startUtf16] ?? -1
  }
  const index = anchor.text.indexOf(text)
  return index < 0 ? -1 : anchor.documentOffsets[index] ?? -1
}

function cleanTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) || '未命名文档'
}
