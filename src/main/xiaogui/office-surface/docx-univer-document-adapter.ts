import type JSZip from 'jszip'

import type {
  ICustomBlock,
  IDocumentBody,
  IDocumentData,
  IParagraphStyle,
  ITextRun,
  ITextStyle,
} from '@univerjs/core'
import {
  createUniverDocDrawingResourcesV1,
  getDocxUniverDrawingWarningsV1,
  prepareDocxUniverDrawingPackageV1,
  prepareDocxUniverDrawingPartContextV1,
  readDocxUniverDrawingV1,
  selectDocxUniverAlternateContentV1,
  type DocxUniverDrawingPackageV1,
  type DocxUniverDrawingPartContextV1,
  type UniverImageDrawingV1,
} from './docx-univer-drawing-adapter'

import {
  adaptDocxTableToUniverV1,
  createDocxTableStyleCatalogV1,
  type DocxTableStyleCatalogV1,
} from './docx-univer-table-adapter'

const PARAGRAPH = '\r'
const SECTION_BREAK = '\n'
const PAGE_BREAK = '\f'
const TAB = '\t'
const TABLE_START = '\x1A'
const TABLE_ROW_START = '\x1B'
const TABLE_CELL_START = '\x1C'
const TABLE_CELL_END = '\x1D'
const TABLE_ROW_END = '\x0E'
const TABLE_END = '\x0F'
const DRAWING_BLOCK = '\b'

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
  readonly tableStyles: DocxTableStyleCatalogV1
  readonly drawing: DocxUniverDrawingPartContextV1
}

interface MutableBodyV1 {
  dataStream: string
  textRuns: ITextRun[]
  paragraphs: NonNullable<IDocumentBody['paragraphs']>
  sectionBreaks: NonNullable<IDocumentBody['sectionBreaks']>
  tables: NonNullable<IDocumentBody['tables']>
  tableSource: NonNullable<IDocumentData['tableSource']>
  customBlocks: ICustomBlock[]
  drawings: Record<string, UniverImageDrawingV1>
  drawingsOrder: string[]
  anchors: DocxUniverTextAnchorV1[]
  paragraphCount: number
  tableCount: number
  tableCellCount: number
  textBoxCount: number
  drawingCount: number
  renderedDrawingCount: number
  approximateFloatingDrawingCount: number
  warnings: string[]
}

interface ParsedDrawingV1 {
  readonly streamOffset: number
  readonly drawing: UniverImageDrawingV1
  readonly approximateFloating: boolean
}

interface ParsedParagraphV1 {
  readonly text: string
  readonly streamText: string
  readonly textRuns: readonly { readonly start: number; readonly end: number; readonly style: ITextStyle }[]
  readonly paragraphStyle: IParagraphStyle
  readonly textBoxes: readonly string[]
  readonly drawingCount: number
  readonly drawings: readonly ParsedDrawingV1[]
}

interface VisibleAccumulatorV1 {
  text: string
  offsets: number[]
}

type HeaderFooterReferenceTypeV1 = 'default' | 'first' | 'even'

interface PackageRelationshipV1 {
  readonly id: string
  readonly target: string
  readonly packagePath?: string
  readonly type?: string
  readonly external: boolean
}

interface SectionHeaderFooterReferencesV1 {
  readonly headers: Partial<Record<HeaderFooterReferenceTypeV1, string>>
  readonly footers: Partial<Record<HeaderFooterReferenceTypeV1, string>>
}

type UniverHeaderSnapshotWithTablesV1 = NonNullable<IDocumentData['headers']>[string] & {
  readonly tableSource?: NonNullable<IDocumentData['tableSource']>
}

type UniverFooterSnapshotWithTablesV1 = NonNullable<IDocumentData['footers']>[string] & {
  readonly tableSource?: NonNullable<IDocumentData['tableSource']>
}

export async function buildDocxUniverDocumentV1(
  input: BuildDocxUniverDocumentInputV1,
): Promise<DocxUniverDocumentBuildResultV1> {
  const stylesXml = await input.zip.file('word/styles.xml')?.async('string') ?? ''
  const styles = readStyleCatalog(stylesXml)
  const tableStyles = createDocxTableStyleCatalogV1(stylesXml)
  const drawingPackage = await prepareDocxUniverDrawingPackageV1(input.zip)
  const drawingSequence = { value: 0 }
  const body = buildBody(
    input.mainXml,
    await createBodyBuildContext(input.zip, {
      part: 'BODY',
      partIndex: 0,
      partPath: 'word/document.xml',
      styles,
      tableStyles,
      documentId: input.documentId,
      drawingPackage,
      drawingSequence,
    }),
  )
  const sectionPropertiesList = collectElements(input.mainXml, 'w:sectPr')
  const sectionProperties = sectionPropertiesList.at(-1) ?? ''
  const settingsXml = await input.zip.file('word/settings.xml')?.async('string') ?? ''
  const documentRelationshipsXml = await input.zip.file('word/_rels/document.xml.rels')?.async('string') ?? ''
  const documentRelationships = readPackageRelationships(documentRelationshipsXml, 'word/document.xml')
  const sectionWarnings: string[] = []
  if (sectionPropertiesList.length > 1) {
    sectionWarnings.push(
      `文档包含 ${sectionPropertiesList.length} 个分节；当前 Univer 文档样式只能等价表达一个页眉页脚集合，已仅绑定末节引用，其余分节需人工复核。`,
    )
  }
  const sectionReferences = readSectionHeaderFooterReferences(
    sectionProperties,
    documentRelationships,
    sectionWarnings,
  )
  const headerPaths = Object.keys(input.zip.files)
    .filter((path) => /^word\/header\d+\.xml$/i.test(path))
    .sort(numericPartSort)
  const footerPaths = Object.keys(input.zip.files)
    .filter((path) => /^word\/footer\d+\.xml$/i.test(path))
    .sort(numericPartSort)
  const headers: NonNullable<IDocumentData['headers']> = {}
  const footers: NonNullable<IDocumentData['footers']> = {}
  const drawings: NonNullable<IDocumentData['drawings']> = { ...body.drawings }
  const tableSource: NonNullable<IDocumentData['tableSource']> = { ...body.tableSource }
  const drawingsOrder = [...body.drawingsOrder]
  const headerFooterDrawingsOrder: string[] = []
  const headerIdsByPath = new Map<string, string>()
  const footerIdsByPath = new Map<string, string>()
  let headerParagraphCount = 0
  let footerParagraphCount = 0
  let totalDrawingCount = body.drawingCount
  let totalRenderedDrawingCount = body.renderedDrawingCount
  let approximateFloatingDrawingCount = body.approximateFloatingDrawingCount
  let totalTableCount = body.tableCount
  let totalTableCellCount = body.tableCellCount
  const tableWarnings = [...body.warnings]

  for (let index = 0; index < headerPaths.length; index += 1) {
    const xml = await input.zip.file(headerPaths[index])?.async('string')
    if (!xml) continue
    const built = buildBody(
      xml,
      await createBodyBuildContext(input.zip, {
        part: 'HEADER',
        partIndex: index + 1,
        partPath: headerPaths[index],
        styles,
        tableStyles,
        documentId: input.documentId,
        drawingPackage,
        drawingSequence,
      }),
    )
    const headerId = `xiaogui-header-${index + 1}`
    const headerSnapshot: UniverHeaderSnapshotWithTablesV1 = {
      headerId,
      body: toDocumentBody(built),
      tableSource: Object.keys(built.tableSource).length ? built.tableSource : undefined,
    }
    headers[headerId] = headerSnapshot
    headerIdsByPath.set(normalizePackagePath(headerPaths[index]), headerId)
    Object.assign(drawings, built.drawings)
    Object.assign(tableSource, built.tableSource)
    headerFooterDrawingsOrder.push(...built.drawingsOrder)
    headerParagraphCount += built.paragraphCount
    totalDrawingCount += built.drawingCount
    totalRenderedDrawingCount += built.renderedDrawingCount
    approximateFloatingDrawingCount += built.approximateFloatingDrawingCount
    totalTableCount += built.tableCount
    totalTableCellCount += built.tableCellCount
    tableWarnings.push(...built.warnings)
  }
  for (let index = 0; index < footerPaths.length; index += 1) {
    const xml = await input.zip.file(footerPaths[index])?.async('string')
    if (!xml) continue
    const built = buildBody(
      xml,
      await createBodyBuildContext(input.zip, {
        part: 'FOOTER',
        partIndex: index + 1,
        partPath: footerPaths[index],
        styles,
        tableStyles,
        documentId: input.documentId,
        drawingPackage,
        drawingSequence,
      }),
    )
    const footerId = `xiaogui-footer-${index + 1}`
    const footerSnapshot: UniverFooterSnapshotWithTablesV1 = {
      footerId,
      body: toDocumentBody(built),
      tableSource: Object.keys(built.tableSource).length ? built.tableSource : undefined,
    }
    footers[footerId] = footerSnapshot
    footerIdsByPath.set(normalizePackagePath(footerPaths[index]), footerId)
    Object.assign(drawings, built.drawings)
    Object.assign(tableSource, built.tableSource)
    headerFooterDrawingsOrder.push(...built.drawingsOrder)
    footerParagraphCount += built.paragraphCount
    totalDrawingCount += built.drawingCount
    totalRenderedDrawingCount += built.renderedDrawingCount
    approximateFloatingDrawingCount += built.approximateFloatingDrawingCount
    totalTableCount += built.tableCount
    totalTableCellCount += built.tableCellCount
    tableWarnings.push(...built.warnings)
  }

  const page = readPageStyle(sectionProperties)
  const mediaCount = drawingPackage.mediaCount
  const warnings: string[] = [...tableWarnings, ...sectionWarnings]
  if (totalRenderedDrawingCount > 0) {
    warnings.push(`已从原文档导入 ${totalRenderedDrawingCount} 个图片对象；图片内容保留在本机私有工作副本中。`)
  }
  const unsupportedDrawingCount = Math.max(0, totalDrawingCount - totalRenderedDrawingCount)
  if (unsupportedDrawingCount > 0) {
    warnings.push(
      `另有 ${unsupportedDrawingCount} 个绘图对象无法可靠映射为浏览器图片，已明确保留为待处理项，不会冒充还原成功。`,
    )
  }
  if (approximateFloatingDrawingCount > 0) {
    warnings.push(`其中 ${approximateFloatingDrawingCount} 个浮动图片按原锚点近似定位；请在生成正式模板前核对版式。`)
  }
  if (mediaCount > totalRenderedDrawingCount) {
    warnings.push(`文档包含 ${mediaCount} 个媒体文件；未被正文、页眉或页脚引用的媒体不会显示。`)
  }
  if (body.textBoxCount > 0) {
    warnings.push(`检测到 ${body.textBoxCount} 个文本框；已保留其中可读取文字，但浮动位置只能近似显示。`)
  }
  warnings.push(...getDocxUniverDrawingWarningsV1(drawingPackage))

  const defaultHeaderId = resolveHeaderFooterSnapshotId(
    sectionReferences.headers.default,
    headerIdsByPath,
    '默认页眉',
    warnings,
  )
  const firstPageHeaderId = resolveHeaderFooterSnapshotId(
    sectionReferences.headers.first,
    headerIdsByPath,
    '首页页眉',
    warnings,
  )
  const evenPageHeaderId = resolveHeaderFooterSnapshotId(
    sectionReferences.headers.even,
    headerIdsByPath,
    '偶数页页眉',
    warnings,
  )
  const defaultFooterId = resolveHeaderFooterSnapshotId(
    sectionReferences.footers.default,
    footerIdsByPath,
    '默认页脚',
    warnings,
  )
  const firstPageFooterId = resolveHeaderFooterSnapshotId(
    sectionReferences.footers.first,
    footerIdsByPath,
    '首页页脚',
    warnings,
  )
  const evenPageFooterId = resolveHeaderFooterSnapshotId(
    sectionReferences.footers.even,
    footerIdsByPath,
    '偶数页页脚',
    warnings,
  )
  const allDrawingsOrder = [...drawingsOrder, ...headerFooterDrawingsOrder]
  const drawingResources = createUniverDocDrawingResourcesV1(drawings, allDrawingsOrder)
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
      firstPageHeaderId,
      firstPageFooterId,
      evenPageHeaderId,
      evenPageFooterId,
      evenAndOddHeaders: wordBoolean(settingsXml, 'w:evenAndOddHeaders') ? 1 : 0,
      useFirstPageHeaderFooter: wordBoolean(sectionProperties, 'w:titlePg') ? 1 : 0,
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
    tableSource: Object.keys(tableSource).length ? tableSource : undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    footers: Object.keys(footers).length ? footers : undefined,
    drawings: Object.keys(drawings).length ? drawings : undefined,
    drawingsOrder: allDrawingsOrder.length ? allDrawingsOrder : undefined,
    headerFooterDrawingsOrder: headerFooterDrawingsOrder.length ? headerFooterDrawingsOrder : undefined,
    // Univer hydrates its drawing manager from this plugin resource during
    // the first document render. The typed fields above remain the portable
    // source of truth for later snapshots and non-rendering consumers.
    resources: drawingResources,
  }

  return {
    document,
    anchors: body.anchors,
    warnings,
    statistics: {
      paragraphCount: body.paragraphCount + headerParagraphCount + footerParagraphCount,
      tableCount: totalTableCount,
      tableCellCount: totalTableCellCount,
      textBoxCount: body.textBoxCount,
      drawingCount: totalDrawingCount,
      mediaCount,
    },
  }
}

async function createBodyBuildContext(
  zip: JSZip,
  input: {
    readonly part: BodyBuildContextV1['part']
    readonly partIndex: number
    readonly partPath: string
    readonly styles: StyleCatalogV1
    readonly tableStyles: DocxTableStyleCatalogV1
    readonly documentId: string
    readonly drawingPackage: DocxUniverDrawingPackageV1
    readonly drawingSequence: { value: number }
  },
): Promise<BodyBuildContextV1> {
  return {
    part: input.part,
    partIndex: input.partIndex,
    styles: input.styles,
    tableStyles: input.tableStyles,
    drawing: await prepareDocxUniverDrawingPartContextV1(zip, input.drawingPackage, {
      part: input.part,
      partIndex: input.partIndex,
      partPath: input.partPath,
      documentId: input.documentId,
      drawingSequence: input.drawingSequence,
    }),
  }
}

type RunContentItemV1 =
  | { readonly kind: 'TEXT'; readonly text: string }
  | {
      readonly kind: 'DRAWING'
      readonly drawing?: UniverImageDrawingV1
      readonly approximateFloating: boolean
    }

function readRunContent(runXml: string, context: BodyBuildContextV1): RunContentItemV1[] {
  const normalizedRunXml = selectDocxUniverAlternateContentV1(runXml)
  const result: RunContentItemV1[] = []
  const token = /<w:(t|instrText)\b[^>]*>([\s\S]*?)<\/w:\1>|<w:(tab|br|cr|lastRenderedPageBreak)\b([^>]*)\/?\s*>|<(w:drawing|w:pict|w:object)\b/g
  let cursor = 0
  while (cursor < normalizedRunXml.length) {
    token.lastIndex = cursor
    const match = token.exec(normalizedRunXml)
    if (!match) break
    if (match[1]) {
      result.push({ kind: 'TEXT', text: decodeXmlText(match[2]).replace(/\r\n?/g, '\n') })
      cursor = token.lastIndex
      continue
    }
    if (match[3]) {
      const text = match[3] === 'tab'
        ? TAB
        : match[3] === 'br' && /w:type\s*=\s*["']page["']/.test(match[4] ?? '')
          ? PAGE_BREAK
          : match[3] === 'lastRenderedPageBreak'
            ? PAGE_BREAK
            : '\n'
      result.push({ kind: 'TEXT', text })
      cursor = token.lastIndex
      continue
    }
    const qualifiedTag = match[5]
    const element = balancedElementAt(normalizedRunXml, match.index, qualifiedTag)
    if (!element) {
      cursor = token.lastIndex
      continue
    }
    const parsed = readDocxUniverDrawingV1(element, context.drawing)
    result.push({
      kind: 'DRAWING',
      drawing: parsed?.drawing,
      approximateFloating: parsed?.approximateFloating ?? false,
    })
    cursor = match.index + element.length
  }
  return result
}

function buildBody(xml: string, context: BodyBuildContextV1): MutableBodyV1 {
  const body: MutableBodyV1 = {
    dataStream: '',
    textRuns: [],
    paragraphs: [],
    sectionBreaks: [],
    tables: [],
    tableSource: {},
    customBlocks: [],
    drawings: {},
    drawingsOrder: [],
    anchors: [],
    paragraphCount: 0,
    tableCount: 0,
    tableCellCount: 0,
    textBoxCount: 0,
    drawingCount: 0,
    renderedDrawingCount: 0,
    approximateFloatingDrawingCount: 0,
    warnings: [],
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
  const parsed = parseParagraph(paragraphXml, context)
  const paragraphStart = body.dataStream.length
  const visible: VisibleAccumulatorV1 = { text: '', offsets: [] }
  appendStyledText(body, parsed.streamText, parsed.textRuns, parsed.drawings, visible)
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
  const adapted = adaptDocxTableToUniverV1({
    tableXml,
    tableId,
    styles: context.tableStyles,
  })
  body.warnings.push(...adapted.warnings)
  const tableStart = body.dataStream.length
  body.dataStream += TABLE_START
  for (const row of adapted.rows) {
    body.dataStream += TABLE_ROW_START
    for (const cell of row.cells) {
      body.dataStream += TABLE_CELL_START
      const cellStart = body.dataStream.length
      const visible: VisibleAccumulatorV1 = { text: '', offsets: [] }
      const paragraphs = cell.paragraphXmls
      if (!paragraphs.length) {
        body.dataStream += PARAGRAPH
        body.paragraphs.push({ startIndex: body.dataStream.length - 1, paragraphStyle: defaultParagraphStyle(context.styles) })
        body.paragraphCount += 1
      } else {
        paragraphs.forEach((paragraphXml, paragraphInCellIndex) => {
          const parsed = parseParagraph(paragraphXml, context)
          appendStyledText(body, parsed.streamText, parsed.textRuns, parsed.drawings, visible)
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
      if (cell.sourceCellIndex !== undefined) {
        visible.offsets.push(Math.max(cellStart, body.dataStream.length - 2))
        body.anchors.push({
          anchorKey: `${context.part}:${context.partIndex}:T:${tableIndex}:${row.sourceRowIndex}:${cell.sourceCellIndex}`,
          text: visible.text,
          documentOffsets: visible.offsets,
        })
      }
    }
    body.dataStream += TABLE_ROW_END
  }
  body.dataStream += TABLE_END
  const tableEnd = body.dataStream.length
  body.tables.push({ startIndex: tableStart, endIndex: tableEnd, tableId })
  body.tableSource[tableId] = adapted.table
  body.tableCellCount += adapted.sourceCellCount
  body.tableCount += 1
}

function appendStyledText(
  body: MutableBodyV1,
  streamText: string,
  runs: readonly { readonly start: number; readonly end: number; readonly style: ITextStyle }[],
  drawings: readonly ParsedDrawingV1[],
  visible: VisibleAccumulatorV1,
): void {
  const base = body.dataStream.length
  body.dataStream += streamText
  for (const run of runs) {
    if (run.end <= run.start) continue
    body.textRuns.push({ st: base + run.start, ed: base + run.end, ts: run.style })
  }
  for (const item of drawings) {
    const startIndex = base + item.streamOffset
    body.customBlocks.push({ startIndex, blockId: item.drawing.drawingId, blockType: 0 })
    body.drawings[item.drawing.drawingId] = item.drawing
    body.drawingsOrder.push(item.drawing.drawingId)
    body.renderedDrawingCount += 1
    if (item.approximateFloating) body.approximateFloatingDrawingCount += 1
  }
  for (let index = 0; index < streamText.length; index += 1) {
    const character = streamText[index]
    if (character === PAGE_BREAK || character === DRAWING_BLOCK) continue
    visible.text += character
    visible.offsets.push(base + index)
  }
}

function parseParagraph(xml: string, context: BodyBuildContextV1): ParsedParagraphV1 {
  const { styles } = context
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
  const withoutTextBoxes = stripElements(xml, ['w:txbxContent'])
  const normalizedXml = selectDocxUniverAlternateContentV1(withoutTextBoxes)
  const runXmls = collectElements(normalizedXml, 'w:r')
  let streamText = ''
  const textRuns: Array<{ start: number; end: number; style: ITextStyle }> = []
  const drawings: ParsedDrawingV1[] = []
  for (const runXml of runXmls) {
    const runProperties = firstElement(runXml, 'w:rPr') ?? ''
    const characterStyleId = attributeOfFirst(runProperties, 'w:rStyle', 'w:val')
    const characterStyle = resolveStyle(characterStyleId, styles.characterStyles).textStyle
    const style = mergeTextStyles(paragraphDefaultTextStyle, characterStyle, readTextStyle(runProperties))
    const content = readRunContent(runXml, context)
    for (const item of content) {
      if (item.kind === 'DRAWING') {
        if (!item.drawing) continue
        drawings.push({
          streamOffset: streamText.length,
          drawing: item.drawing,
          approximateFloating: item.approximateFloating,
        })
        streamText += DRAWING_BLOCK
        continue
      }
      if (!item.text) continue
      const start = streamText.length
      streamText += item.text
      textRuns.push({ start, end: streamText.length, style })
    }
  }
  return {
    text: streamText.replaceAll(PAGE_BREAK, '').replaceAll(DRAWING_BLOCK, ''),
    streamText,
    textRuns,
    paragraphStyle,
    textBoxes,
    drawingCount:
      countOpeningTags(normalizedXml, 'w:drawing')
      + countOpeningTags(normalizedXml, 'w:pict')
      + countOpeningTags(normalizedXml, 'w:object'),
    drawings,
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

function toDocumentBody(body: MutableBodyV1): IDocumentBody {
  return {
    dataStream: body.dataStream,
    textRuns: compactTextRuns(body.textRuns),
    paragraphs: body.paragraphs,
    sectionBreaks: body.sectionBreaks,
    customBlocks: body.customBlocks,
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

function readPackageRelationships(xml: string, partPath: string): ReadonlyMap<string, PackageRelationshipV1> {
  const relationships = new Map<string, PackageRelationshipV1>()
  for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/gi)) {
    const openTag = match[0]
    const id = attribute(openTag, 'Id')
    const target = attribute(openTag, 'Target')
    if (!id || !target) continue
    const external = attribute(openTag, 'TargetMode')?.toLowerCase() === 'external'
    relationships.set(id, {
      id,
      target: decodeXmlText(target),
      packagePath: external ? undefined : resolvePackagePath(partPath, decodeXmlText(target)),
      type: attribute(openTag, 'Type'),
      external,
    })
  }
  return relationships
}

function readSectionHeaderFooterReferences(
  sectionProperties: string,
  relationships: ReadonlyMap<string, PackageRelationshipV1>,
  warnings: string[],
): SectionHeaderFooterReferencesV1 {
  return {
    headers: readSectionPartReferences(sectionProperties, 'w:headerReference', 'header', relationships, warnings),
    footers: readSectionPartReferences(sectionProperties, 'w:footerReference', 'footer', relationships, warnings),
  }
}

function readSectionPartReferences(
  sectionProperties: string,
  tagName: 'w:headerReference' | 'w:footerReference',
  relationshipKind: 'header' | 'footer',
  relationships: ReadonlyMap<string, PackageRelationshipV1>,
  warnings: string[],
): Partial<Record<HeaderFooterReferenceTypeV1, string>> {
  const references: Partial<Record<HeaderFooterReferenceTypeV1, string>> = {}
  for (const referenceXml of collectElements(sectionProperties, tagName)) {
    const openTag = firstOpenTag(referenceXml, tagName) ?? ''
    const type = attribute(openTag, 'w:type')
    const relationshipId = attribute(openTag, 'r:id')
    if (type !== 'default' && type !== 'first' && type !== 'even') {
      warnings.push(`${relationshipKind === 'header' ? '页眉' : '页脚'}引用使用未知类型 ${type ?? '(缺失)'}，未绑定到 Univer 文档样式。`)
      continue
    }
    if (!relationshipId) {
      warnings.push(`${type} ${relationshipKind === 'header' ? '页眉' : '页脚'}引用缺少 r:id，未绑定到 Univer 文档样式。`)
      continue
    }
    const relationship = relationships.get(relationshipId)
    if (!relationship) {
      warnings.push(`${type} ${relationshipKind === 'header' ? '页眉' : '页脚'}引用关系 ${relationshipId} 缺失，未显示。`)
      continue
    }
    if (relationship.external || !relationship.packagePath) {
      warnings.push(`${type} ${relationshipKind === 'header' ? '页眉' : '页脚'}引用外部部件，出于离线边界未加载。`)
      continue
    }
    if (relationship.type && !new RegExp(`/${relationshipKind}$`, 'i').test(relationship.type)) {
      warnings.push(`${type} ${relationshipKind === 'header' ? '页眉' : '页脚'}引用关系 ${relationshipId} 类型不匹配，未显示。`)
      continue
    }
    if (references[type]) {
      warnings.push(`末节包含重复的 ${type} ${relationshipKind === 'header' ? '页眉' : '页脚'}引用；已使用最后一个并标记人工复核。`)
    }
    references[type] = relationship.packagePath
  }
  return references
}

function resolveHeaderFooterSnapshotId(
  packagePath: string | undefined,
  idsByPath: ReadonlyMap<string, string>,
  label: string,
  warnings: string[],
): string {
  if (!packagePath) return ''
  const id = idsByPath.get(normalizePackagePath(packagePath))
  if (id) return id
  warnings.push(`${label}部件 ${packagePath} 缺失，未显示。`)
  return ''
}

function resolvePackagePath(partPath: string, target: string): string {
  if (target.startsWith('/')) return normalizePackagePath(target.slice(1))
  const slash = partPath.lastIndexOf('/')
  const directory = slash >= 0 ? partPath.slice(0, slash + 1) : ''
  return normalizePackagePath(`${directory}${target}`)
}

function normalizePackagePath(path: string): string {
  const output: string[] = []
  for (const segment of path.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') output.pop()
    else output.push(segment)
  }
  return output.join('/').toLowerCase()
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
