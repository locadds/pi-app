import { createHash } from 'node:crypto'

import JSZip from 'jszip'

import type {
  OfficeStructuredDocumentProjectionV1,
  OfficeSurfaceFieldV1,
  OfficeSurfaceOccurrenceV1,
  OfficeSurfaceProjectedOccurrenceV1,
} from '@shared/xiaogui-office-surface'

const MAX_PROJECTED_TEXT_UTF16 = 500_000
const MAX_OCCURRENCES = 2_000

const TABLE_RE = /<w:tbl\b[\s\S]*?<\/w:tbl>/g
const ROW_RE = /<w:tr\b[\s\S]*?<\/w:tr>/g
const CELL_RE = /<w:tc\b[\s\S]*?<\/w:tc>/g
const PARAGRAPH_RE = /<w:p\b[\s\S]*?<\/w:p>/g
const TEXT_BOX_RE = /<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g

interface XmlMatchV1 {
  readonly index: number
  readonly value: string
}

interface LogicalBlockV1 {
  readonly order: number
  readonly anchorKey: string
  readonly text: string
  startUtf16: number
}

export interface DocxUniverProjectionInputV1 {
  readonly content: Buffer
  readonly title: string
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

  const blocks: LogicalBlockV1[] = []
  const bodyStatistics = appendDocumentPartBlocks(blocks, mainXml, 'BODY', 0)
  const headerPaths = Object.keys(zip.files)
    .filter((path) => /^word\/header\d+\.xml$/i.test(path))
    .sort(numericPartSort)
  const footerPaths = Object.keys(zip.files)
    .filter((path) => /^word\/footer\d+\.xml$/i.test(path))
    .sort(numericPartSort)

  let partOrder = mainXml.length + 1
  for (let index = 0; index < headerPaths.length; index += 1) {
    const xml = await zip.file(headerPaths[index])?.async('string')
    if (!xml) continue
    appendDocumentPartBlocks(blocks, xml, 'HEADER', partOrder, index + 1)
    partOrder += xml.length + 1
  }
  for (let index = 0; index < footerPaths.length; index += 1) {
    const xml = await zip.file(footerPaths[index])?.async('string')
    if (!xml) continue
    appendDocumentPartBlocks(blocks, xml, 'FOOTER', partOrder, index + 1)
    partOrder += xml.length + 1
  }

  blocks.sort((left, right) => left.order - right.order)
  let plainText = ''
  for (const block of blocks) {
    if (!block.text) continue
    if (plainText) plainText += '\n'
    block.startUtf16 = plainText.length
    plainText += block.text
  }
  if (plainText.length > MAX_PROJECTED_TEXT_UTF16) {
    throw new Error('OFFICE_PROJECTION_TEXT_LIMIT_EXCEEDED')
  }

  const blockByAnchor = new Map(blocks.map((block) => [block.anchorKey, block]))
  const projectedOccurrences: OfficeSurfaceProjectedOccurrenceV1[] = []
  const warnings: string[] = [
    '当前为 DOCX 结构化试验视图，不代表 Word 原版式；可随时切换到兼容视图核对版式和复杂对象。',
  ]
  const usedRanges: Array<{ start: number; end: number }> = []
  const globalCursorByText = new Map<string, number>()

  for (const occurrence of occurrences) {
    const block = blockByAnchor.get(anchorKey(occurrence))
    let start = block ? locateInBlock(block, occurrence.originalText, occurrence.textRange) : -1
    if (start < 0 && occurrence.originalText) {
      const cursor = globalCursorByText.get(occurrence.originalText) ?? 0
      start = plainText.indexOf(occurrence.originalText, cursor)
      if (start >= 0) globalCursorByText.set(occurrence.originalText, start + occurrence.originalText.length)
    }
    const end = start + occurrence.originalText.length
    if (
      start < 0
      || end <= start
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

  const unmappedOccurrenceCount = occurrences.length - projectedOccurrences.length
  if (bodyStatistics.textBoxCount > 0) {
    warnings.push(`检测到 ${bodyStatistics.textBoxCount} 个文本框；试验视图不保证其版式，请用兼容视图核对。`)
  }

  return {
    projectionVersion: 1,
    kind: 'XIAOGUI_DOCX_STRUCTURED_PROJECTION',
    documentId: `xiaogui-docx-${sourceSha256.slice(0, 20)}`,
    title: cleanTitle(input.title),
    sourceSha256,
    plainText,
    fields: input.fields ?? [],
    occurrences: projectedOccurrences,
    warnings: [...new Set(warnings)],
    statistics: {
      paragraphCount: bodyStatistics.paragraphCount,
      tableCount: bodyStatistics.tableCount,
      tableCellCount: bodyStatistics.tableCellCount,
      mappedOccurrenceCount: projectedOccurrences.length,
      unmappedOccurrenceCount,
    },
  }
}

function appendDocumentPartBlocks(
  output: LogicalBlockV1[],
  xml: string,
  part: 'BODY' | 'HEADER' | 'FOOTER',
  orderOffset: number,
  partIndex?: number,
): { paragraphCount: number; tableCount: number; tableCellCount: number; textBoxCount: number } {
  const tables = collectMatches(xml, TABLE_RE)
  const textBoxes = collectMatches(xml, TEXT_BOX_RE)
  const visibleXml = maskXmlRanges(xml, [...tables, ...textBoxes])
  const paragraphs = collectMatches(visibleXml, PARAGRAPH_RE)
    .map((paragraph) => ({ ...paragraph, value: xml.slice(paragraph.index, paragraph.index + paragraph.value.length) }))
    .filter((paragraph) => visibleText(paragraph.value).length > 0)

  paragraphs.forEach((paragraph, index) => {
    output.push({
      order: orderOffset + paragraph.index,
      anchorKey: `${part}:${partIndex ?? 0}:P:${index + 1}`,
      text: visibleText(paragraph.value),
      startUtf16: -1,
    })
  })

  let tableCellCount = 0
  tables.forEach((table, tableIndex) => {
    const rows = collectMatches(table.value, ROW_RE)
    rows.forEach((row, rowIndex) => {
      const cells = collectMatches(row.value, CELL_RE)
      cells.forEach((cell, cellIndex) => {
        tableCellCount += 1
        const text = visibleText(cell.value)
        if (!text) return
        output.push({
          order: orderOffset + table.index + row.index + cell.index,
          anchorKey: `${part}:${partIndex ?? 0}:T:${tableIndex + 1}:${rowIndex + 1}:${cellIndex + 1}`,
          text,
          startUtf16: -1,
        })
      })
    })
  })

  return {
    paragraphCount: paragraphs.length,
    tableCount: tables.length,
    tableCellCount,
    textBoxCount: textBoxes.length,
  }
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

function locateInBlock(
  block: LogicalBlockV1,
  text: string,
  requestedRange: OfficeSurfaceOccurrenceV1['textRange'],
): number {
  if (!text) return -1
  if (requestedRange && block.text.slice(requestedRange.startUtf16, requestedRange.endUtf16Exclusive) === text) {
    return block.startUtf16 + requestedRange.startUtf16
  }
  const index = block.text.indexOf(text)
  return index < 0 ? -1 : block.startUtf16 + index
}

function collectMatches(text: string, pattern: RegExp): XmlMatchV1[] {
  const matches: XmlMatchV1[] = []
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    matches.push({ index: match.index ?? 0, value: match[0] })
  }
  return matches
}

function maskXmlRanges(text: string, matches: readonly XmlMatchV1[]): string {
  if (!matches.length) return text
  const units = text.split('')
  for (const match of matches) {
    units.fill(' ', match.index, match.index + match.value.length)
  }
  return units.join('')
}

function visibleText(xml: string): string {
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/?\s*>/g, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/?\s*>/g, '\n')
  return [...withBreaks.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXmlText(match[1]))
    .join('')
    .replace(/\r\n?/g, '\n')
    .trim()
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_whole, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_whole, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function numericPartSort(left: string, right: string): number {
  const leftNumber = Number(left.match(/(\d+)\.xml$/)?.[1] ?? 0)
  const rightNumber = Number(right.match(/(\d+)\.xml$/)?.[1] ?? 0)
  return leftNumber - rightNumber
}

function cleanTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) || '未命名文档'
}
