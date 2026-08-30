import type JSZip from 'jszip'

import type {
  IDocumentBody,
  IDocumentData,
  IParagraphStyle,
  ITable,
  ITableCell,
  ITableRow,
  ITextRun,
  ITextStyle,
} from '@univerjs/core'

const PARAGRAPH = '\r'
const SECTION_BREAK = '\n'
const PAGE_BREAK = '\f'
const TAB = '\t'
const TABLE_START = '\x1A'
const TABLE_ROW_START = '\x1B'
const TABLE_CELL_START = '\x1C'
const TABLE_CELL_END = '\x1D'
const TABLE_ROW_END = '\x1E'
const TABLE_END = '\x1F'

const DEFAULT_PAGE_WIDTH = 793.7
const DEFAULT_PAGE_HEIGHT = 1122.5
const DEFAULT_MARGIN = 96

export interface DocxUniverTextAnchorV1 {
  readonly anchorKey: string
  readonly text: string
  /** For every visible UTF-16 offset, records the corresponding Univer data-stream offset. */
  readonly documentOffsets: readonly number[]
}

export interface DocxUniverDocumentBuildResultV1 {
  readonly document: IDocumentData
  readonly anchors: readonly DocxUniverTextAnchorV1[]
  readonly warnings: readonly string[]
  readonly statistics: {
    readonly paragraphCount: number
    readonly tableCount: number
    readonly tableCellCount: number
    readonly textBoxCount: number
    readonly drawingCount: number
    readonly mediaCount: number
  }
}

export interface BuildDocxUniverDocumentInputV1 {
  readonly zip: JSZip
  readonly mainXml: string
  readonly documentId: string
  readonly title: string
}

interface StyleDefinitionV1 {
  readonly basedOn?: string
  readonly paragraphStyle?: IParagraphStyle
  readonly textStyle?: ITextStyle
}

interface StyleCatalogV1 {
  readonly defaultTextStyle: ITextStyle
  readonly defaultParagraphStyle: IParagraphStyle
  readonly paragraphStyles: ReadonlyMap<string, StyleDefinitionV1>
  readonly characterStyles: ReadonlyMap<string, StyleDefinitionV1>
}

interface BodyBuildContextV1 {
  readonly part: 'BODY' | 'HEADER' | 'FOOTER'
  readonly partIndex: number
  readonly styles: StyleCatalogV1
}

interface MutableBodyV1 {
  dataStream: string
  textRuns: ITextRun[]
  paragraphs: NonNullable<IDocumentBody['paragraphs']>
  sectionBreaks: NonNullable<IDocumentBody['sectionBreaks']>
  tables: NonNullable<IDocumentBody['tables']>
  tableSource: Record<string, ITable>
  anchors: DocxUniverTextAnchorV1[]
  paragraphCount: number
  tableCount: number
  tableCellCount: number
  textBoxCount: number
  drawingCount: number
}

interface ParsedParagraphV1 {
  readonly text: string
  readonly streamText: string
  readonly textRuns: readonly { readonly start: number; readonly end: number; readonly style: ITextStyle }[]
  readonly paragraphStyle: IParagraphStyle
  readonly textBoxes: readonly string[]
  readonly drawingCount: number
}

interface VisibleAccumulatorV1 {
  text: string
  offsets: number[]
}

export async function buildDocxUniverDocumentV1(
  input: BuildDocxUniverDocumentInputV1,
): Promise<DocxUniverDocumentBuildResultV1> {
  const stylesXml = await input.zip.file('word/styles.xml')?.async('string') ?? ''
  const styles = readStyleCatalog(stylesXml)
  const body = buildBody(input.mainXml, { part: 'BODY', partIndex: 0, styles })
  const sectionProperties = firstElement(input.mainXml, 'w:sectPr') ?? ''
  const headerPaths = Object.keys(input.zip.files)
    .filter((path) => /^word\/header\d+\.xml$/i.test(path))
    .sort(numericPartSort)
  const footerPaths = Object.keys(input.zip.files)
    .filter((path) => /^word\/footer\d+\.xml$/i.test(path))
    .sort(numericPartSort)
  const headers: NonNullable<IDocumentData['headers']> = {}
  const footers: NonNullable<IDocumentData['footers']> = {}
  let headerParagraphCount = 0
  let footerParagraphCount = 0

  for (let index = 0; index < headerPaths.length; index += 1) {
    const xml = await input.zip.file(headerPaths[index])?.async('string')
    if (!xml) continue
    const built = buildBody(xml, { part: 'HEADER', partIndex: index + 1, styles })
    const headerId = `xiaogui-header-${index + 1}`
    headers[headerId] = { headerId, body: toDocumentBody(built) }
    headerParagraphCount += built.paragraphCount
  }
  for (let index = 0; index < footerPaths.length; index += 1) {
    const xml = await input.zip.file(footerPaths[index])?.async('string')
    if (!xml) continue
    const built = buildBody(xml, { part: 'FOOTER', partIndex: index + 1, styles })
    const footerId = `xiaogui-footer-${index + 1}`
    footers[footerId] = { footerId, body: toDocumentBody(built) }
    footerParagraphCount += built.paragraphCount
  }

  const page = readPageStyle(sectionProperties)
  const mediaCount = Object.keys(input.zip.files).filter((path) => path.startsWith('word/media/')).length
  const warnings: string[] = []
  if (body.drawingCount > 0 || mediaCount > 0) {
    warnings.push(
      `原文中的 ${body.drawingCount} 个绘图对象和 ${mediaCount} 个媒体文件尚不能由当前开源 Univer 完整还原；正文、段落和表格按原结构显示，复杂对象会进入待处理清单。`,
    )
  }
  if (body.textBoxCount > 0) {
    warnings.push(`检测到 ${body.textBoxCount} 个文本框；已保留其中可读取文字，但浮动位置只能近似显示。`)
  }

  const defaultHeaderId = Object.keys(headers)[0] ?? ''
  const defaultFooterId = Object.keys(footers)[0] ?? ''
  const document: IDocumentData = {
    id: input.documentId,
    title: input.title,
    documentStyle: {
      pageSize: { width: page.width, height: page.height },
      pageOrient: page.width > page.height ? 1 : 0,
      documentFlavor: 1,
      marginTop: page.marginTop,
      marginBottom: page.marginBottom,
      marginLeft: page.marginLeft,
      marginRight: page.marginRight,
      marginHeader: page.marginHeader,
      marginFooter: page.marginFooter,
      defaultHeaderId,
      defaultFooterId,
      firstPageHeaderId: defaultHeaderId,
      firstPageFooterId: defaultFooterId,
      evenPageHeaderId: defaultHeaderId,
      evenPageFooterId: defaultFooterId,
      evenAndOddHeaders: 0,
      useFirstPageHeaderFooter: 0,
      paragraphLineGapDefault: 0,
      renderConfig: {
        zeroWidthParagraphBreak: 0,
        vertexAngle: 0,
        centerAngle: 0,
        background: { rgb: '#d9d9d9' },
      },
      textStyle: styles.defaultTextStyle,
    },
    body: toDocumentBody(body),
    tableSource: Object.keys(body.tableSource).length ? body.tableSource : undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    footers: Object.keys(footers).length ? footers : undefined,
    resources: [],
  }

  return {
    document,
    anchors: body.anchors,
    warnings,
    statistics: {
      paragraphCount: body.paragraphCount + headerParagraphCount + footerParagraphCount,
      tableCount: body.tableCount,
      tableCellCount: body.tableCellCount,
      textBoxCount: body.textBoxCount,
      drawingCount: body.drawingCount,
      mediaCount,
    },
  }
}

function buildBody(xml: string, context: BodyBuildContextV1): MutableBodyV1 {
  const body: MutableBodyV1 = {
    dataStream: '',
    textRuns: [],
    paragraphs: [],
    sectionBreaks: [],
    tables: [],
    tableSource: {},
    anchors: [],
    paragraphCount: 0,
    tableCount: 0,
    tableCellCount: 0,
    textBoxCount: 0,
    drawingCount: 0,
  }
  const container = elementContent(xml, context.part === 'BODY' ? 'w:body' : context.part === 'HEADER' ? 'w:hdr' : 'w:ftr') ?? xml
  const blocks = collectOrderedBlocks(container, ['w:p', 'w:tbl'])
  let paragraphIndex = 0
  let tableIndex = 0
  for (const block of blocks) {
    if (block.tag === 'w:p') {
      paragraphIndex += 1
      appendParagraph(body, block.xml, context, `${context.part}:${context.partIndex}:P:${paragraphIndex}`)
    } else {
      tableIndex += 1
      appendTable(body, block.xml, context, tableIndex)
    }
  }
  if (!body.dataStream.endsWith(PARAGRAPH)) appendPlainParagraph(body, '', defaultParagraphStyle(context.styles), undefined)
  body.dataStream += SECTION_BREAK
  body.sectionBreaks.push({ startIndex: body.dataStream.length - 1 })
  return body
}

function appendParagraph(
  body: MutableBodyV1,
  paragraphXml: string,
  context: BodyBuildContextV1,
  anchorKey?: string,
): void {
  const parsed = parseParagraph(paragraphXml, context.styles)
  const paragraphStart = body.dataStream.length
  const visible: VisibleAccumulatorV1 = { text: '', offsets: [] }
  appendStyledText(body, parsed.streamText, parsed.textRuns, visible)
  const paragraphEnd = body.dataStream.length
  body.dataStream += PARAGRAPH
  body.paragraphs.push({ startIndex: paragraphEnd, paragraphStyle: parsed.paragraphStyle })
  body.paragraphCount += 1
  body.drawingCount += parsed.drawingCount
  if (anchorKey) {
    visible.offsets.push(paragraphEnd)
    body.anchors.push({ anchorKey, text: parsed.text, documentOffsets: visible.offsets })
  }
  for (const textBoxXml of parsed.textBoxes) {
    body.textBoxCount += 1
    const textBoxParagraphs = collectOrderedBlocks(textBoxXml, ['w:p'])
    for (const textBoxParagraph of textBoxParagraphs) {
      appendParagraph(body, textBoxParagraph.xml, context)
    }
  }
  if (paragraphStart === paragraphEnd && parsed.textBoxes.length && body.paragraphs.length > 1) {
    // Keep the original anchor paragraph but avoid adding additional visual content.
  }
}

function appendPlainParagraph(
  body: MutableBodyV1,
  text: string,
  paragraphStyle: IParagraphStyle,
  anchorKey?: string,
): void {
  const start = body.dataStream.length
  body.dataStream += text
  if (text) body.textRuns.push({ st: start, ed: start + text.length, ts: {} })
  body.dataStream += PARAGRAPH
  body.paragraphs.push({ startIndex: body.dataStream.length - 1, paragraphStyle })
  body.paragraphCount += 1
  if (anchorKey) {
    body.anchors.push({
      anchorKey,
      text,
      documentOffsets: Array.from({ length: text.length + 1 }, (_, index) => start + index),
    })
  }
}

function appendTable(
  body: MutableBodyV1,
  tableXml: string,
  context: BodyBuildContextV1,
  tableIndex: number,
): void {
  const tableId = `xiaogui-table-${context.part.toLowerCase()}-${context.partIndex}-${tableIndex}`
  const tableStart = body.dataStream.length
  body.dataStream += TABLE_START
  const rowXmls = collectOrderedBlocks(tableXml, ['w:tr']).map((item) => item.xml)
  const rows: ITableRow[] = []
  let maximumColumnCount = 1
  for (let rowIndex = 0; rowIndex < rowXmls.length; rowIndex += 1) {
    body.dataStream += TABLE_ROW_START
    const cellXmls = collectOrderedBlocks(rowXmls[rowIndex], ['w:tc']).map((item) => item.xml)
    maximumColumnCount = Math.max(maximumColumnCount, cellXmls.length)
    const cells: ITableCell[] = []
    for (let cellIndex = 0; cellIndex < cellXmls.length; cellIndex += 1) {
      body.tableCellCount += 1
      body.dataStream += TABLE_CELL_START
      const cellStart = body.dataStream.length
      const visible: VisibleAccumulatorV1 = { text: '', offsets: [] }
      const paragraphs = collectOrderedBlocks(cellXmls[cellIndex], ['w:p'])
      if (!paragraphs.length) {
        body.dataStream += PARAGRAPH
        body.paragraphs.push({ startIndex: body.dataStream.length - 1, paragraphStyle: defaultParagraphStyle(context.styles) })
        body.paragraphCount += 1
      } else {
        paragraphs.forEach((paragraph, paragraphInCellIndex) => {
          const parsed = parseParagraph(paragraph.xml, context.styles)
          appendStyledText(body, parsed.streamText, parsed.textRuns, visible)
          const paragraphEnd = body.dataStream.length
          body.dataStream += PARAGRAPH
          body.paragraphs.push({ startIndex: paragraphEnd, paragraphStyle: parsed.paragraphStyle })
          body.paragraphCount += 1
          body.drawingCount += parsed.drawingCount
          if (paragraphInCellIndex < paragraphs.length - 1) {
            visible.text += '\n'
            visible.offsets.push(paragraphEnd)
          }
        })
      }
      body.dataStream += SECTION_BREAK
      body.sectionBreaks.push({ startIndex: body.dataStream.length - 1 })
      body.dataStream += TABLE_CELL_END
      visible.offsets.push(Math.max(cellStart, body.dataStream.length - 2))
      body.anchors.push({
        anchorKey: `${context.part}:${context.partIndex}:T:${tableIndex}:${rowIndex + 1}:${cellIndex + 1}`,
        text: visible.text,
        documentOffsets: visible.offsets,
      })
      cells.push(readTableCell(cellXmls[cellIndex]))
    }
    body.dataStream += TABLE_ROW_END
    rows.push({
      tableCells: cells,
      trHeight: { val: { v: 30 }, hRule: 0 },
      repeatHeaderRow: hasElement(rowXmls[rowIndex], 'w:tblHeader') ? 1 : 0,
    })
  }
  body.dataStream += TABLE_END
  const tableEnd = body.dataStream.length - 1
  const columnWidths = readTableColumnWidths(tableXml, maximumColumnCount)
  body.tables.push({ startIndex: tableStart, endIndex: tableEnd, tableId })
  body.tableSource[tableId] = {
    tableId,
    tableRows: rows,
    tableColumns: columnWidths.map((width) => ({ size: { type: 1, width: { v: width } } })),
    align: readTableAlignment(tableXml),
    indent: { v: 0 },
    textWrap: 0,
    position: {
      positionH: { relativeFrom: 0, posOffset: 0 },
      positionV: { relativeFrom: 0, posOffset: 0 },
    },
    dist: { distT: 0, distB: 0, distL: 0, distR: 0 },
    size: { type: 0, width: { v: columnWidths.reduce((sum, width) => sum + width, 0) } },
    cellMargin: { start: { v: 8 }, end: { v: 8 }, top: { v: 4 }, bottom: { v: 4 } },
    layout: hasAttributeValue(tableXml, 'w:tblLayout', 'w:type', 'fixed') ? 1 : 0,
  }
  body.tableCount += 1
}

function appendStyledText(
  body: MutableBodyV1,
  streamText: string,
  runs: readonly { readonly start: number; readonly end: number; readonly style: ITextStyle }[],
  visible: VisibleAccumulatorV1,
): void {
  const base = body.dataStream.length
  body.dataStream += streamText
  for (const run of runs) {
    if (run.end <= run.start) continue
    body.textRuns.push({ st: base + run.start, ed: base + run.end, ts: run.style })
  }
  for (let index = 0; index < streamText.length; index += 1) {
    const character = streamText[index]
    if (character === PAGE_BREAK) continue
    visible.text += character
    visible.offsets.push(base + index)
  }
}

function parseParagraph(xml: string, styles: StyleCatalogV1): ParsedParagraphV1 {
  const paragraphProperties = firstElement(xml, 'w:pPr') ?? ''
  const styleId = attributeOfFirst(paragraphProperties, 'w:pStyle', 'w:val')
  const inherited = resolveStyle(styleId, styles.paragraphStyles)
  const paragraphRunProperties = firstElement(paragraphProperties, 'w:rPr') ?? ''
  const paragraphDefaultTextStyle = mergeTextStyles(
    styles.defaultTextStyle,
    inherited.textStyle,
    readTextStyle(paragraphRunProperties),
  )
  const paragraphStyle = mergeParagraphStyles(
    defaultParagraphStyle(styles),
    inherited.paragraphStyle,
    readParagraphStyle(paragraphProperties),
  )
  const textBoxes = collectElements(xml, 'w:txbxContent')
  const withoutComplexObjects = stripElements(xml, ['w:drawing', 'w:pict', 'w:object'])
  const runXmls = collectElements(withoutComplexObjects, 'w:r')
  let streamText = ''
  const textRuns: Array<{ start: number; end: number; style: ITextStyle }> = []
  for (const runXml of runXmls) {
    const runProperties = firstElement(runXml, 'w:rPr') ?? ''
    const characterStyleId = attributeOfFirst(runProperties, 'w:rStyle', 'w:val')
    const characterStyle = resolveStyle(characterStyleId, styles.characterStyles).textStyle
    const text = readRunStreamText(runXml)
    if (!text) continue
    const start = streamText.length
    streamText += text
    textRuns.push({
      start,
      end: streamText.length,
      style: mergeTextStyles(paragraphDefaultTextStyle, characterStyle, readTextStyle(runProperties)),
    })
  }
  return {
    text: streamText.replaceAll(PAGE_BREAK, ''),
    streamText,
    textRuns,
    paragraphStyle,
    textBoxes,
    drawingCount: countOpeningTags(xml, 'w:drawing') + countOpeningTags(xml, 'w:pict'),
  }
}

function readRunStreamText(runXml: string): string {
  const tokens = [...runXml.matchAll(/<w:(t|instrText)\b[^>]*>([\s\S]*?)<\/w:\1>|<w:(tab|br|cr|lastRenderedPageBreak)\b([^>]*)\/?\s*>/g)]
  let result = ''
  for (const token of tokens) {
    if (token[1]) {
      result += decodeXmlText(token[2])
      continue
    }
    if (token[3] === 'tab') result += TAB
    else if (token[3] === 'br' && /w:type\s*=\s*["']page["']/.test(token[4] ?? '')) result += PAGE_BREAK
    else if (token[3] === 'lastRenderedPageBreak') result += PAGE_BREAK
    else result += '\n'
  }
  return result.replace(/\r\n?/g, '\n')
}

function readStyleCatalog(stylesXml: string): StyleCatalogV1 {
  const defaults = firstElement(stylesXml, 'w:docDefaults') ?? ''
  const defaultTextStyle = mergeTextStyles(
    { ff: '宋体', fs: 10.5, cl: { rgb: '#000000' } },
    readTextStyle(firstElement(firstElement(defaults, 'w:rPrDefault') ?? '', 'w:rPr') ?? ''),
  )
  const defaultParagraphStyle = mergeParagraphStyles(
    { spaceAbove: { v: 0 }, spaceBelow: { v: 0 }, lineSpacing: 1.5 },
    readParagraphStyle(firstElement(firstElement(defaults, 'w:pPrDefault') ?? '', 'w:pPr') ?? ''),
  )
  const paragraphStyles = new Map<string, StyleDefinitionV1>()
  const characterStyles = new Map<string, StyleDefinitionV1>()
  for (const styleXml of collectElements(stylesXml, 'w:style')) {
    const openTag = styleXml.slice(0, styleXml.indexOf('>') + 1)
    const id = attribute(openTag, 'w:styleId')
    if (!id) continue
    const definition: StyleDefinitionV1 = {
      basedOn: attributeOfFirst(styleXml, 'w:basedOn', 'w:val'),
      paragraphStyle: readParagraphStyle(firstElement(styleXml, 'w:pPr') ?? ''),
      textStyle: readTextStyle(firstElement(styleXml, 'w:rPr') ?? ''),
    }
    const type = attribute(openTag, 'w:type')
    if (type === 'character') characterStyles.set(id, definition)
    else if (type === 'paragraph') paragraphStyles.set(id, definition)
  }
  return { defaultTextStyle, defaultParagraphStyle, paragraphStyles, characterStyles }
}

function resolveStyle(
  styleId: string | undefined,
  catalog: ReadonlyMap<string, StyleDefinitionV1>,
  visited = new Set<string>(),
): StyleDefinitionV1 {
  if (!styleId || visited.has(styleId)) return {}
  const style = catalog.get(styleId)
  if (!style) return {}
  visited.add(styleId)
  const base = resolveStyle(style.basedOn, catalog, visited)
  return {
    paragraphStyle: mergeParagraphStyles(base.paragraphStyle, style.paragraphStyle),
    textStyle: mergeTextStyles(base.textStyle, style.textStyle),
  }
}

function readTextStyle(xml: string): ITextStyle {
  if (!xml) return {}
  const result: ITextStyle = {}
  const fonts = firstOpenTag(xml, 'w:rFonts')
  const fontFamily = fonts
    ? attribute(fonts, 'w:eastAsia') ?? attribute(fonts, 'w:ascii') ?? attribute(fonts, 'w:hAnsi')
    : undefined
  if (fontFamily) result.ff = fontFamily
  const size = numericAttributeOfFirst(xml, 'w:sz', 'w:val')
  if (size !== undefined) result.fs = size / 2
  const bold = wordBoolean(xml, 'w:b')
  if (bold !== undefined) result.bl = bold ? 1 : 0
  const italic = wordBoolean(xml, 'w:i')
  if (italic !== undefined) result.it = italic ? 1 : 0
  const underline = attributeOfFirst(xml, 'w:u', 'w:val')
  if (underline !== undefined) result.ul = { s: underline === 'none' || underline === '0' ? 0 : 1 }
  const strike = wordBoolean(xml, 'w:strike')
  if (strike !== undefined) result.st = { s: strike ? 1 : 0 }
  const color = attributeOfFirst(xml, 'w:color', 'w:val')
  if (color && color !== 'auto') result.cl = { rgb: normalizeColor(color) }
  const highlight = attributeOfFirst(xml, 'w:highlight', 'w:val')
  const shading = attributeOfFirst(xml, 'w:shd', 'w:fill')
  const background = highlightColor(highlight) ?? (shading && shading !== 'auto' ? normalizeColor(shading) : undefined)
  if (background) result.bg = { rgb: background }
  const verticalAlign = attributeOfFirst(xml, 'w:vertAlign', 'w:val')
  if (verticalAlign === 'subscript') result.va = 2
  else if (verticalAlign === 'superscript') result.va = 3
  return result
}

function readParagraphStyle(xml: string): IParagraphStyle {
  if (!xml) return {}
  const result: IParagraphStyle = {}
  const alignment = attributeOfFirst(xml, 'w:jc', 'w:val')
  const alignmentMap: Record<string, number> = {
    left: 1,
    center: 2,
    right: 3,
    both: 5,
    distribute: 6,
  }
  if (alignment && alignmentMap[alignment]) result.horizontalAlign = alignmentMap[alignment]
  const spacingTag = firstOpenTag(xml, 'w:spacing')
  if (spacingTag) {
    const before = numericAttribute(spacingTag, 'w:before')
    const after = numericAttribute(spacingTag, 'w:after')
    const line = numericAttribute(spacingTag, 'w:line')
    if (before !== undefined) result.spaceAbove = { v: before / 20 }
    if (after !== undefined) result.spaceBelow = { v: after / 20 }
    if (line !== undefined && line > 0) result.lineSpacing = line / 240
  }
  const indentTag = firstOpenTag(xml, 'w:ind')
  if (indentTag) {
    const firstLine = numericAttribute(indentTag, 'w:firstLine')
    const hanging = numericAttribute(indentTag, 'w:hanging')
    const start = numericAttribute(indentTag, 'w:start') ?? numericAttribute(indentTag, 'w:left')
    const end = numericAttribute(indentTag, 'w:end') ?? numericAttribute(indentTag, 'w:right')
    if (firstLine !== undefined) result.indentFirstLine = { v: firstLine / 15 }
    if (hanging !== undefined) result.hanging = { v: hanging / 15 }
    if (start !== undefined) result.indentStart = { v: start / 15 }
    if (end !== undefined) result.indentEnd = { v: end / 15 }
  }
  const shading = attributeOfFirst(xml, 'w:shd', 'w:fill')
  if (shading && shading !== 'auto') result.shading = { backgroundColor: { rgb: normalizeColor(shading) } }
  const runProperties = firstElement(xml, 'w:rPr')
  if (runProperties) result.textStyle = readTextStyle(runProperties)
  return result
}

function readPageStyle(xml: string): {
  width: number
  height: number
  marginTop: number
  marginBottom: number
  marginLeft: number
  marginRight: number
  marginHeader: number
  marginFooter: number
} {
  const pageSize = firstOpenTag(xml, 'w:pgSz')
  const margins = firstOpenTag(xml, 'w:pgMar')
  return {
    width: (numericAttribute(pageSize ?? '', 'w:w') ?? DEFAULT_PAGE_WIDTH * 15) / 15,
    height: (numericAttribute(pageSize ?? '', 'w:h') ?? DEFAULT_PAGE_HEIGHT * 15) / 15,
    marginTop: (numericAttribute(margins ?? '', 'w:top') ?? DEFAULT_MARGIN * 15) / 15,
    marginBottom: (numericAttribute(margins ?? '', 'w:bottom') ?? DEFAULT_MARGIN * 15) / 15,
    marginLeft: (numericAttribute(margins ?? '', 'w:left') ?? DEFAULT_MARGIN * 15) / 15,
    marginRight: (numericAttribute(margins ?? '', 'w:right') ?? DEFAULT_MARGIN * 15) / 15,
    marginHeader: (numericAttribute(margins ?? '', 'w:header') ?? 720) / 15,
    marginFooter: (numericAttribute(margins ?? '', 'w:footer') ?? 720) / 15,
  }
}

function readTableCell(xml: string): ITableCell {
  const properties = firstElement(xml, 'w:tcPr') ?? ''
  const span = numericAttributeOfFirst(properties, 'w:gridSpan', 'w:val')
  const shading = attributeOfFirst(properties, 'w:shd', 'w:fill')
  const width = numericAttributeOfFirst(properties, 'w:tcW', 'w:w')
  return {
    margin: { start: { v: 8 }, end: { v: 8 }, top: { v: 4 }, bottom: { v: 4 } },
    ...(span && span > 1 ? { columnSpan: span } : {}),
    ...(shading && shading !== 'auto' ? { backgroundColor: { rgb: normalizeColor(shading) } } : {}),
    ...(width ? { size: { type: 1, width: { v: width / 15 } } } : {}),
  }
}

function readTableColumnWidths(xml: string, count: number): number[] {
  const grid = firstElement(xml, 'w:tblGrid') ?? ''
  const widths = collectElements(grid, 'w:gridCol')
    .map((column) => numericAttribute(firstOpenTag(column, 'w:gridCol') ?? '', 'w:w'))
    .filter((value): value is number => value !== undefined && value > 0)
    .map((value) => value / 15)
  if (widths.length >= count) return widths.slice(0, count)
  const fallback = 600 / Math.max(1, count)
  return Array.from({ length: count }, (_, index) => widths[index] ?? fallback)
}

function readTableAlignment(xml: string): 0 | 1 | 2 {
  const value = attributeOfFirst(xml, 'w:jc', 'w:val')
  return value === 'center' ? 1 : value === 'right' || value === 'end' ? 2 : 0
}

function toDocumentBody(body: MutableBodyV1): IDocumentBody {
  return {
    dataStream: body.dataStream,
    textRuns: compactTextRuns(body.textRuns),
    paragraphs: body.paragraphs,
    sectionBreaks: body.sectionBreaks,
    customBlocks: [],
    customRanges: [],
    customDecorations: [],
    tables: body.tables,
  }
}

function compactTextRuns(runs: readonly ITextRun[]): ITextRun[] {
  const compacted: ITextRun[] = []
  for (const run of runs) {
    if (run.ed <= run.st) continue
    const previous = compacted[compacted.length - 1]
    if (previous && previous.ed === run.st && JSON.stringify(previous.ts ?? {}) === JSON.stringify(run.ts ?? {})) {
      previous.ed = run.ed
    } else {
      compacted.push({ ...run, ts: { ...(run.ts ?? {}) } })
    }
  }
  return compacted
}

function defaultParagraphStyle(styles: StyleCatalogV1): IParagraphStyle {
  return mergeParagraphStyles(styles.defaultParagraphStyle)
}

function mergeTextStyles(...styles: Array<ITextStyle | undefined>): ITextStyle {
  return Object.assign({}, ...styles.filter(Boolean))
}

function mergeParagraphStyles(...styles: Array<IParagraphStyle | undefined>): IParagraphStyle {
  const result = Object.assign({}, ...styles.filter(Boolean)) as IParagraphStyle
  const textStyles = styles.map((style) => style?.textStyle).filter(Boolean) as ITextStyle[]
  if (textStyles.length) result.textStyle = mergeTextStyles(...textStyles)
  return result
}

function collectOrderedBlocks(xml: string, tags: readonly string[]): Array<{ tag: string; xml: string; index: number }> {
  const results: Array<{ tag: string; xml: string; index: number }> = []
  let cursor = 0
  while (cursor < xml.length) {
    let nextTag = ''
    let nextIndex = -1
    for (const tag of tags) {
      const index = xml.indexOf(`<${tag}`, cursor)
      if (index >= 0 && (nextIndex < 0 || index < nextIndex)) {
        nextTag = tag
        nextIndex = index
      }
    }
    if (nextIndex < 0) break
    const element = balancedElementAt(xml, nextIndex, nextTag)
    if (!element) {
      cursor = nextIndex + nextTag.length + 1
      continue
    }
    results.push({ tag: nextTag, xml: element, index: nextIndex })
    cursor = nextIndex + element.length
  }
  return results
}

function collectElements(xml: string, tag: string): string[] {
  return collectOrderedBlocks(xml, [tag]).map((item) => item.xml)
}

function firstElement(xml: string, tag: string): string | undefined {
  const index = xml.indexOf(`<${tag}`)
  return index < 0 ? undefined : balancedElementAt(xml, index, tag)
}

function elementContent(xml: string, tag: string): string | undefined {
  const element = firstElement(xml, tag)
  if (!element) return undefined
  const openEnd = element.indexOf('>')
  const closeStart = element.lastIndexOf(`</${tag}>`)
  return openEnd < 0 || closeStart < 0 ? '' : element.slice(openEnd + 1, closeStart)
}

function balancedElementAt(xml: string, start: number, tag: string): string | undefined {
  const token = new RegExp(`<\/?${escapeRegExp(tag)}\\b[^>]*>`, 'g')
  token.lastIndex = start
  let depth = 0
  for (const match of xml.matchAll(token)) {
    const value = match[0]
    if (value.startsWith(`</${tag}`)) depth -= 1
    else if (!value.endsWith('/>')) depth += 1
    if (depth === 0) return xml.slice(start, (match.index ?? start) + value.length)
  }
  return undefined
}

function stripElements(xml: string, tags: readonly string[]): string {
  let result = xml
  for (const tag of tags) {
    for (const element of collectElements(result, tag)) result = result.replace(element, '')
  }
  return result
}

function firstOpenTag(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>`, 'i'))?.[0]
}

function hasElement(xml: string, tag: string): boolean {
  return new RegExp(`<${escapeRegExp(tag)}\\b`, 'i').test(xml)
}

function hasAttributeValue(xml: string, tag: string, name: string, value: string): boolean {
  const openTag = firstOpenTag(xml, tag)
  return !!openTag && attribute(openTag, name) === value
}

function attributeOfFirst(xml: string, tag: string, name: string): string | undefined {
  const openTag = firstOpenTag(xml, tag)
  return openTag ? attribute(openTag, name) : undefined
}

function numericAttributeOfFirst(xml: string, tag: string, name: string): number | undefined {
  const value = attributeOfFirst(xml, tag, name)
  return value === undefined ? undefined : finiteNumber(value)
}

function attribute(openTag: string, name: string): string | undefined {
  const match = openTag.match(new RegExp(`${escapeRegExp(name)}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return match?.[1]
}

function numericAttribute(openTag: string, name: string): number | undefined {
  const value = attribute(openTag, name)
  return value === undefined ? undefined : finiteNumber(value)
}

function finiteNumber(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function wordBoolean(xml: string, tag: string): boolean | undefined {
  const openTag = firstOpenTag(xml, tag)
  if (!openTag) return undefined
  const value = attribute(openTag, 'w:val')
  return value === undefined || !['0', 'false', 'off', 'none'].includes(value.toLowerCase())
}

function countOpeningTags(xml: string, tag: string): number {
  return [...xml.matchAll(new RegExp(`<${escapeRegExp(tag)}\\b`, 'g'))].length
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

function normalizeColor(value: string): string {
  const clean = value.replace(/^#/, '').slice(0, 6)
  return /^[0-9a-f]{6}$/i.test(clean) ? `#${clean.toUpperCase()}` : '#000000'
}

function highlightColor(value: string | undefined): string | undefined {
  if (!value || value === 'none') return undefined
  const colors: Record<string, string> = {
    yellow: '#FFFF00',
    green: '#00FF00',
    cyan: '#00FFFF',
    magenta: '#FF00FF',
    blue: '#0000FF',
    red: '#FF0000',
    darkBlue: '#000080',
    darkCyan: '#008080',
    darkGreen: '#008000',
    darkMagenta: '#800080',
    darkRed: '#800000',
    darkYellow: '#808000',
    darkGray: '#808080',
    lightGray: '#C0C0C0',
    black: '#000000',
  }
  return colors[value]
}

function numericPartSort(left: string, right: string): number {
  const leftNumber = Number(left.match(/(\d+)\.xml$/)?.[1] ?? 0)
  const rightNumber = Number(right.match(/(\d+)\.xml$/)?.[1] ?? 0)
  return leftNumber - rightNumber
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
