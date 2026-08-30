import type {
  ITable,
  ITableCell,
  ITableCellBorder,
  ITableCellMargin,
  ITableRow,
} from '@univerjs/core'

const TWIPS_PER_PIXEL = 15
const POINTS_TO_PIXELS = 4 / 3

const DEFAULT_TABLE_WIDTH = 600
const DEFAULT_CELL_MARGIN: ITableCellMargin = {
  start: { v: 8 },
  end: { v: 8 },
  top: { v: 4 },
  bottom: { v: 4 },
}
const NO_BORDER: ITableCellBorder = {
  color: { rgb: 'transparent' },
  width: { v: 0 },
  dashStyle: 1,
}

interface DocxTableStyleDefinitionV1 {
  readonly basedOn?: string
  readonly tablePropertiesXml?: string
  readonly rowPropertiesXml?: string
  readonly cellPropertiesXml?: string
  readonly conditionalStyleCount: number
}

export interface DocxTableStyleCatalogV1 {
  readonly defaultStyleId?: string
  readonly styles: ReadonlyMap<string, DocxTableStyleDefinitionV1>
}

export interface DocxUniverTableCellPlanV1 {
  readonly logicalColumnIndex: number
  readonly sourceCellIndex?: number
  readonly sourceCellXml?: string
  readonly paragraphXmls: readonly string[]
  readonly covered: boolean
  readonly cell: ITableCell
}

export interface DocxUniverTableRowPlanV1 {
  readonly sourceRowIndex: number
  readonly sourceRowXml: string
  readonly cells: readonly DocxUniverTableCellPlanV1[]
  readonly row: ITableRow
}

export interface DocxUniverTableAdaptationV1 {
  readonly table: ITable
  readonly rows: readonly DocxUniverTableRowPlanV1[]
  readonly sourceCellCount: number
  readonly logicalColumnCount: number
  readonly nestedTableCount: number
  readonly warnings: readonly string[]
}

export interface AdaptDocxTableToUniverInputV1 {
  readonly tableXml: string
  readonly tableId: string
  readonly styles: DocxTableStyleCatalogV1
}

interface SourceCellV1 {
  readonly sourceCellIndex: number
  readonly sourceCellXml: string
  readonly paragraphXmls: readonly string[]
  readonly logicalColumnIndex: number
  readonly columnSpan: number
  readonly verticalMerge: 'RESTART' | 'CONTINUE' | undefined
  readonly nestedTableCount: number
  readonly cell: ITableCell
}

interface SourceRowV1 {
  readonly sourceRowIndex: number
  readonly sourceRowXml: string
  readonly gridBefore: number
  readonly gridAfter: number
  readonly cells: readonly SourceCellV1[]
  readonly rowHeight: ITableRow['trHeight']
  readonly repeatHeaderRow: 0 | 1
}

interface MutableCellPlanV1 {
  logicalColumnIndex: number
  sourceCellIndex?: number
  sourceCellXml?: string
  paragraphXmls: string[]
  covered: boolean
  cell: ITableCell
}

interface BorderSetV1 {
  top?: ITableCellBorder
  bottom?: ITableCellBorder
  left?: ITableCellBorder
  right?: ITableCellBorder
  insideH?: ITableCellBorder
  insideV?: ITableCellBorder
}

export function createDocxTableStyleCatalogV1(stylesXml: string): DocxTableStyleCatalogV1 {
  const styles = new Map<string, DocxTableStyleDefinitionV1>()
  let defaultStyleId: string | undefined
  for (const styleXml of collectElements(stylesXml, 'w:style')) {
    const openTag = firstOpenTag(styleXml, 'w:style') ?? ''
    if (attribute(openTag, 'w:type') !== 'table') continue
    const styleId = attribute(openTag, 'w:styleId')
    if (!styleId) continue
    const defaultValue = attribute(openTag, 'w:default')
    if (defaultValue && !['0', 'false', 'off', 'none'].includes(defaultValue.toLowerCase())) defaultStyleId = styleId
    styles.set(styleId, {
      basedOn: attributeOfFirst(styleXml, 'w:basedOn', 'w:val'),
      tablePropertiesXml: firstElement(styleXml, 'w:tblPr'),
      rowPropertiesXml: firstElement(styleXml, 'w:trPr'),
      cellPropertiesXml: firstElement(styleXml, 'w:tcPr'),
      conditionalStyleCount: countOpeningTags(styleXml, 'w:tblStylePr'),
    })
  }
  return { defaultStyleId, styles }
}

export function adaptDocxTableToUniverV1(
  input: AdaptDocxTableToUniverInputV1,
): DocxUniverTableAdaptationV1 {
  const warnings: string[] = []
  const tableProperties = firstElement(input.tableXml, 'w:tblPr') ?? ''
  const styleId = attributeOfFirst(tableProperties, 'w:tblStyle', 'w:val') ?? input.styles.defaultStyleId
  const resolvedStyles = resolveTableStyles(styleId, input.styles)
  const tablePropertySources = [
    ...resolvedStyles.map((style) => style.tablePropertiesXml),
    tableProperties,
  ].filter((value): value is string => !!value)
  const rowPropertySources = resolvedStyles
    .map((style) => style.rowPropertiesXml)
    .filter((value): value is string => !!value)
  const cellPropertySources = resolvedStyles
    .map((style) => style.cellPropertiesXml)
    .filter((value): value is string => !!value)

  if (resolvedStyles.some((style) => style.conditionalStyleCount > 0)) {
    warnings.push(`表格 ${input.tableId} 使用条件表格样式；首行/带状行列等条件格式尚不能可靠还原，请人工复核。`)
  }
  const widthTag = lastOpenTagInSources(tablePropertySources, 'w:tblW')
  const widthType = attribute(widthTag ?? '', 'w:type') ?? 'auto'
  const widthTwips = numericAttribute(widthTag ?? '', 'w:w')
  if (widthTag && widthType !== 'dxa' && widthType !== 'nil') {
    warnings.push(`表格 ${input.tableId} 使用百分比或自动宽度；已按列网格近似显示，请人工复核自动适配结果。`)
  }
  if (hasElement(input.tableXml, 'w:tblpPr')) {
    warnings.push(`表格 ${input.tableId} 是浮动表格；Univer 当前按行内表格显示，浮动位置需人工复核。`)
  }
  if (hasElement(input.tableXml, 'w:tblCellSpacing')) {
    warnings.push(`表格 ${input.tableId} 使用单元格间距；Univer 0.25.1 文档表格不支持等价映射，间距可能有差异。`)
  }

  const gridWidths = readGridWidths(input.tableXml)
  const sourceRows = readSourceRows(
    input.tableXml,
    rowPropertySources,
    cellPropertySources,
    input.tableId,
    warnings,
  )
  const sourceCellCount = sourceRows.reduce((sum, row) => sum + row.cells.length, 0)
  const nestedTableCount = sourceRows.reduce(
    (sum, row) => sum + row.cells.reduce((rowSum, cell) => rowSum + cell.nestedTableCount, 0),
    0,
  )
  if (nestedTableCount > 0) {
    warnings.push(`表格 ${input.tableId} 包含 ${nestedTableCount} 个嵌套表格；仅保留外层单元格的直属段落，嵌套表格未静默冒充还原成功。`)
  }
  const maximumRowColumns = sourceRows.reduce((maximum, row) => {
    const contentColumns = row.cells.reduce((sum, cell) => sum + cell.columnSpan, 0)
    return Math.max(maximum, row.gridBefore + contentColumns + row.gridAfter)
  }, 0)
  const logicalColumnCount = Math.max(1, gridWidths.length, maximumRowColumns)
  if (gridWidths.length === 0) {
    warnings.push(`表格 ${input.tableId} 缺少 tblGrid；列宽已按可用表宽平均估算，请人工复核。`)
  }
  if (sourceRows.some((row) => row.gridBefore > 0 || row.gridAfter > 0)) {
    warnings.push(`表格 ${input.tableId} 使用 gridBefore/gridAfter 非规则行网格；已补空白逻辑单元格并标记复核。`)
  }

  const explicitWidth = widthType === 'dxa' && widthTwips !== undefined && widthTwips > 0
    ? widthTwips / TWIPS_PER_PIXEL
    : undefined
  const fallbackWidth = explicitWidth ?? DEFAULT_TABLE_WIDTH
  const columnWidths = Array.from({ length: logicalColumnCount }, (_, index) => (
    gridWidths[index] ?? fallbackWidth / logicalColumnCount
  ))
  const tableBorders = readTableBorders(tablePropertySources)
  const tableCellMargin = readTableCellMargin(tablePropertySources) ?? cloneMargin(DEFAULT_CELL_MARGIN)
  const mutableRows = materializeLogicalRows(sourceRows, logicalColumnCount, input.tableId, warnings)
  applyVerticalMerges(mutableRows, input.tableId, warnings)
  applyCellBorders(mutableRows, tableBorders, cellPropertySources)

  const tableRows: ITableRow[] = mutableRows.map((row, rowIndex) => ({
    tableCells: row.map((plan) => plan.cell),
    trHeight: sourceRows[rowIndex]?.rowHeight ?? { val: { v: 0 }, hRule: 0 },
    repeatHeaderRow: sourceRows[rowIndex]?.repeatHeaderRow ?? 0,
  }))
  const rows: DocxUniverTableRowPlanV1[] = mutableRows.map((cells, rowIndex) => ({
    sourceRowIndex: sourceRows[rowIndex]?.sourceRowIndex ?? rowIndex + 1,
    sourceRowXml: sourceRows[rowIndex]?.sourceRowXml ?? '',
    cells,
    row: tableRows[rowIndex],
  }))
  const tableWidth = explicitWidth ?? columnWidths.reduce((sum, width) => sum + width, 0)
  const table: ITable = {
    tableId: input.tableId,
    tableRows,
    tableColumns: columnWidths.map((width) => ({ size: { type: 1, width: { v: width } } })),
    align: readTableAlignment(tablePropertySources),
    indent: { v: readTableIndent(tablePropertySources) },
    textWrap: 0,
    position: {
      positionH: { relativeFrom: 0, posOffset: 0 },
      positionV: { relativeFrom: 0, posOffset: 0 },
    },
    dist: { distT: 0, distB: 0, distL: 0, distR: 0 },
    size: { type: explicitWidth ? 1 : 0, width: { v: tableWidth } },
    cellMargin: tableCellMargin,
    layout: readTableLayout(tablePropertySources),
  }

  return {
    table,
    rows,
    sourceCellCount,
    logicalColumnCount,
    nestedTableCount,
    warnings: [...new Set(warnings)],
  }
}

function readSourceRows(
  tableXml: string,
  rowPropertySources: readonly string[],
  cellPropertySources: readonly string[],
  tableId: string,
  warnings: string[],
): SourceRowV1[] {
  const tableContent = elementContent(tableXml, 'w:tbl') ?? tableXml
  const rowXmls = collectOrderedBlocks(tableContent, ['w:tr']).map((block) => block.xml)
  return rowXmls.map((rowXml, rowIndex) => {
    const rowProperties = firstElement(rowXml, 'w:trPr') ?? ''
    const gridBefore = numericAttributeOfFirst(rowProperties, 'w:gridBefore', 'w:val') ?? 0
    const gridAfter = numericAttributeOfFirst(rowProperties, 'w:gridAfter', 'w:val') ?? 0
    const rowContent = elementContent(rowXml, 'w:tr') ?? rowXml
    const cellXmls = collectOrderedBlocks(rowContent, ['w:tc']).map((block) => block.xml)
    let logicalColumnIndex = gridBefore
    const cells = cellXmls.map((cellXml, cellIndex): SourceCellV1 => {
      const properties = firstElement(cellXml, 'w:tcPr') ?? ''
      const columnSpan = Math.max(1, numericAttributeOfFirst(properties, 'w:gridSpan', 'w:val') ?? 1)
      const verticalMerge = readVerticalMerge(properties)
      const cellContent = elementContent(cellXml, 'w:tc') ?? cellXml
      const directBlocks = collectOrderedBlocks(cellContent, ['w:p', 'w:tbl'])
      const paragraphXmls = directBlocks.filter((block) => block.tag === 'w:p').map((block) => block.xml)
      const nestedTableCount = countOpeningTags(cellContent, 'w:tbl')
      if (hasElement(properties, 'w:hMerge')) {
        warnings.push(`表格 ${tableId} 第 ${rowIndex + 1} 行第 ${cellIndex + 1} 单元格使用旧式 hMerge；请改用 gridSpan 或人工复核。`)
      }
      if (hasElement(properties, 'w:textDirection')) {
        warnings.push(`表格 ${tableId} 第 ${rowIndex + 1} 行第 ${cellIndex + 1} 单元格使用竖排/旋转文字；当前无法等价显示。`)
      }
      const widthTag = firstOpenTag(properties, 'w:tcW')
      const widthType = attribute(widthTag ?? '', 'w:type')
      if (widthTag && widthType && widthType !== 'dxa' && widthType !== 'nil') {
        warnings.push(`表格 ${tableId} 第 ${rowIndex + 1} 行第 ${cellIndex + 1} 单元格使用百分比或自动宽度；已按列网格近似。`)
      }
      const cell = readTableCell([...cellPropertySources, properties], columnSpan)
      const source: SourceCellV1 = {
        sourceCellIndex: cellIndex + 1,
        sourceCellXml: cellXml,
        paragraphXmls,
        logicalColumnIndex,
        columnSpan,
        verticalMerge,
        nestedTableCount,
        cell,
      }
      logicalColumnIndex += columnSpan
      return source
    })
    return {
      sourceRowIndex: rowIndex + 1,
      sourceRowXml: rowXml,
      gridBefore,
      gridAfter,
      cells,
      rowHeight: readTableRowHeight([...rowPropertySources, rowProperties]),
      repeatHeaderRow: wordBoolean(rowProperties, 'w:tblHeader') ? 1 : 0,
    }
  })
}

function materializeLogicalRows(
  sourceRows: readonly SourceRowV1[],
  logicalColumnCount: number,
  tableId: string,
  warnings: string[],
): MutableCellPlanV1[][] {
  return sourceRows.map((row) => {
    const cells: Array<MutableCellPlanV1 | undefined> = Array.from({ length: logicalColumnCount })
    for (const source of row.cells) {
      if (source.logicalColumnIndex >= logicalColumnCount) {
        warnings.push(`表格 ${tableId} 第 ${row.sourceRowIndex} 行单元格超出逻辑列网格，已保留告警。`)
        continue
      }
      cells[source.logicalColumnIndex] = {
        logicalColumnIndex: source.logicalColumnIndex,
        sourceCellIndex: source.sourceCellIndex,
        sourceCellXml: source.sourceCellXml,
        paragraphXmls: [...source.paragraphXmls],
        covered: false,
        cell: { ...source.cell },
      }
      for (let offset = 1; offset < source.columnSpan; offset += 1) {
        const column = source.logicalColumnIndex + offset
        if (column >= logicalColumnCount) break
        cells[column] = {
          logicalColumnIndex: column,
          paragraphXmls: [],
          covered: true,
          cell: { columnSpan: 0 },
        }
      }
    }
    return cells.map((cell, column) => cell ?? ({
      logicalColumnIndex: column,
      paragraphXmls: [],
      covered: false,
      cell: {},
    }))
  })
}

function applyVerticalMerges(
  rows: MutableCellPlanV1[][],
  tableId: string,
  warnings: string[],
): void {
  let active = new Map<number, { master: MutableCellPlanV1; columnSpan: number }>()
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const next = new Map<number, { master: MutableCellPlanV1; columnSpan: number }>()
    const sourcePlans = rows[rowIndex].filter((plan) => plan.sourceCellXml)
    for (const plan of sourcePlans) {
      const properties = firstElement(plan.sourceCellXml ?? '', 'w:tcPr') ?? ''
      const merge = readVerticalMerge(properties)
      const columnSpan = Math.max(1, numericAttributeOfFirst(properties, 'w:gridSpan', 'w:val') ?? 1)
      if (merge === 'RESTART') {
        plan.cell.rowSpan = 1
        next.set(plan.logicalColumnIndex, { master: plan, columnSpan })
        continue
      }
      if (merge !== 'CONTINUE') continue
      const previous = active.get(plan.logicalColumnIndex)
      if (!previous || previous.columnSpan !== columnSpan) {
        warnings.push(`表格 ${tableId} 第 ${rowIndex + 1} 行存在无法配对的 vMerge 续接；该单元格按普通单元格显示。`)
        continue
      }
      previous.master.cell.rowSpan = Math.max(1, previous.master.cell.rowSpan ?? 1) + 1
      for (let offset = 0; offset < columnSpan; offset += 1) {
        const covered = rows[rowIndex][plan.logicalColumnIndex + offset]
        if (!covered) continue
        covered.covered = true
        covered.cell.rowSpan = 0
        covered.cell.columnSpan = 0
      }
      if (hasVisibleText(plan.sourceCellXml ?? '')) {
        warnings.push(`表格 ${tableId} 第 ${rowIndex + 1} 行的 vMerge 续接单元格含可见内容；内容不会静默并入主单元格，请人工复核。`)
      }
      next.set(plan.logicalColumnIndex, previous)
    }
    active = next
  }
  for (const row of rows) {
    for (const plan of row) {
      if (plan.cell.rowSpan === 1) delete plan.cell.rowSpan
    }
  }
}

function applyCellBorders(
  rows: readonly MutableCellPlanV1[][],
  tableBorders: BorderSetV1,
  cellPropertySources: readonly string[],
): void {
  const rowCount = rows.length
  const columnCount = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < rows[rowIndex].length; columnIndex += 1) {
      const plan = rows[rowIndex][columnIndex]
      if (plan.covered) {
        plan.cell.borderTop = cloneBorder(NO_BORDER)
        plan.cell.borderBottom = cloneBorder(NO_BORDER)
        plan.cell.borderLeft = cloneBorder(NO_BORDER)
        plan.cell.borderRight = cloneBorder(NO_BORDER)
        continue
      }
      const columnSpan = Math.max(1, plan.cell.columnSpan ?? 1)
      const rowSpan = Math.max(1, plan.cell.rowSpan ?? 1)
      const cellProperties = firstElement(plan.sourceCellXml ?? '', 'w:tcPr') ?? ''
      const direct = readCellBorders([...cellPropertySources, cellProperties])
      plan.cell.borderTop = cloneBorder(direct.top ?? (rowIndex === 0 ? tableBorders.top : tableBorders.insideH) ?? NO_BORDER)
      plan.cell.borderBottom = cloneBorder(
        direct.bottom ?? (rowIndex + rowSpan >= rowCount ? tableBorders.bottom : tableBorders.insideH) ?? NO_BORDER,
      )
      plan.cell.borderLeft = cloneBorder(direct.left ?? (columnIndex === 0 ? tableBorders.left : tableBorders.insideV) ?? NO_BORDER)
      plan.cell.borderRight = cloneBorder(
        direct.right ?? (columnIndex + columnSpan >= columnCount ? tableBorders.right : tableBorders.insideV) ?? NO_BORDER,
      )
    }
  }
}

function readTableCell(sources: readonly string[], columnSpan: number): ITableCell {
  const result: ITableCell = {}
  if (columnSpan > 1) result.columnSpan = columnSpan
  const shading = lastAttributeOfFirst(sources, 'w:shd', 'w:fill')
  if (shading && shading !== 'auto' && shading !== 'nil') result.backgroundColor = { rgb: normalizeColor(shading) }
  const widthTag = lastOpenTagInSources(sources, 'w:tcW')
  const width = numericAttribute(widthTag ?? '', 'w:w')
  const widthType = attribute(widthTag ?? '', 'w:type')
  if (width !== undefined && width > 0 && (!widthType || widthType === 'dxa')) {
    result.size = { type: 1, width: { v: width / TWIPS_PER_PIXEL } }
  }
  const margin = readCellMargin(sources)
  if (margin) result.margin = margin
  const verticalAlign = lastAttributeOfFirst(sources, 'w:vAlign', 'w:val')
  if (verticalAlign === 'top') result.vAlign = 2
  else if (verticalAlign === 'center') result.vAlign = 3
  else if (verticalAlign === 'bottom') result.vAlign = 4
  if (lastWordBoolean(sources, 'w:tcFitText')) result.tcFitText = 1
  return result
}

function readTableRowHeight(sources: readonly string[]): ITableRow['trHeight'] {
  const heightTag = lastOpenTagInSources(sources, 'w:trHeight')
  const value = numericAttribute(heightTag ?? '', 'w:val')
  if (value === undefined || value <= 0) return { val: { v: 0 }, hRule: 0 }
  const rule = attribute(heightTag ?? '', 'w:hRule')
  return {
    val: { v: value / TWIPS_PER_PIXEL },
    hRule: rule === 'exact' ? 2 : 1,
  }
}

function readVerticalMerge(properties: string): SourceCellV1['verticalMerge'] {
  const tag = firstOpenTag(properties, 'w:vMerge')
  if (!tag) return undefined
  return attribute(tag, 'w:val') === 'restart' ? 'RESTART' : 'CONTINUE'
}

function readGridWidths(tableXml: string): number[] {
  const grid = firstElement(tableXml, 'w:tblGrid') ?? ''
  return collectElements(grid, 'w:gridCol')
    .map((column) => numericAttribute(firstOpenTag(column, 'w:gridCol') ?? '', 'w:w'))
    .filter((value): value is number => value !== undefined && value > 0)
    .map((value) => value / TWIPS_PER_PIXEL)
}

function readTableBorders(sources: readonly string[]): BorderSetV1 {
  return readBorders(sources, 'w:tblBorders', {
    top: ['w:top'],
    bottom: ['w:bottom'],
    left: ['w:start', 'w:left'],
    right: ['w:end', 'w:right'],
    insideH: ['w:insideH'],
    insideV: ['w:insideV'],
  })
}

function readCellBorders(sources: readonly string[]): BorderSetV1 {
  return readBorders(sources, 'w:tcBorders', {
    top: ['w:top'],
    bottom: ['w:bottom'],
    left: ['w:start', 'w:left'],
    right: ['w:end', 'w:right'],
  })
}

function readBorders(
  sources: readonly string[],
  containerTag: string,
  tags: Partial<Record<keyof BorderSetV1, readonly string[]>>,
): BorderSetV1 {
  const result: BorderSetV1 = {}
  for (const source of sources) {
    const container = firstElement(source, containerTag)
    if (!container) continue
    for (const [key, tagNames] of Object.entries(tags) as Array<[keyof BorderSetV1, readonly string[]]>) {
      const openTag = tagNames.map((tag) => firstOpenTag(container, tag)).find(Boolean)
      if (openTag) result[key] = readBorder(openTag)
    }
  }
  return result
}

function readBorder(openTag: string): ITableCellBorder {
  const style = (attribute(openTag, 'w:val') ?? 'single').toLowerCase()
  if (style === 'nil' || style === 'none') return cloneBorder(NO_BORDER)
  const size = numericAttribute(openTag, 'w:sz') ?? 6
  const color = attribute(openTag, 'w:color')
  return {
    color: { rgb: color && color !== 'auto' ? normalizeColor(color) : '#000000' },
    width: { v: Math.max(0.5, size / 8 * POINTS_TO_PIXELS) },
    dashStyle: style.includes('dot') ? 2 : style.includes('dash') ? 3 : 1,
  }
}

function readTableCellMargin(sources: readonly string[]): ITableCellMargin | undefined {
  return readMargin(sources, 'w:tblCellMar')
}

function readCellMargin(sources: readonly string[]): ITableCellMargin | undefined {
  return readMargin(sources, 'w:tcMar')
}

function readMargin(sources: readonly string[], containerTag: string): ITableCellMargin | undefined {
  let margin: Partial<Record<keyof ITableCellMargin, { v: number }>> | undefined
  for (const source of sources) {
    const container = firstElement(source, containerTag)
    if (!container) continue
    margin ??= {}
    const values: Array<[keyof ITableCellMargin, string[]]> = [
      ['start', ['w:start', 'w:left']],
      ['end', ['w:end', 'w:right']],
      ['top', ['w:top']],
      ['bottom', ['w:bottom']],
    ]
    for (const [key, tags] of values) {
      const tag = tags.map((name) => firstOpenTag(container, name)).find(Boolean)
      const value = numericAttribute(tag ?? '', 'w:w')
      if (value !== undefined) margin[key] = { v: value / TWIPS_PER_PIXEL }
    }
  }
  if (!margin) return undefined
  return {
    start: margin.start ?? { v: DEFAULT_CELL_MARGIN.start.v },
    end: margin.end ?? { v: DEFAULT_CELL_MARGIN.end.v },
    top: margin.top ?? { v: DEFAULT_CELL_MARGIN.top.v },
    bottom: margin.bottom ?? { v: DEFAULT_CELL_MARGIN.bottom.v },
  }
}

function readTableAlignment(sources: readonly string[]): 0 | 1 | 2 {
  const value = lastAttributeOfFirst(sources, 'w:jc', 'w:val')
  return value === 'center' ? 1 : value === 'right' || value === 'end' ? 2 : 0
}

function readTableLayout(sources: readonly string[]): 0 | 1 {
  return lastAttributeOfFirst(sources, 'w:tblLayout', 'w:type') === 'fixed' ? 1 : 0
}

function readTableIndent(sources: readonly string[]): number {
  const tag = lastOpenTagInSources(sources, 'w:tblInd')
  const width = numericAttribute(tag ?? '', 'w:w')
  return width === undefined ? 0 : width / TWIPS_PER_PIXEL
}

function resolveTableStyles(
  styleId: string | undefined,
  catalog: DocxTableStyleCatalogV1,
): DocxTableStyleDefinitionV1[] {
  if (!styleId) return []
  const resolved: DocxTableStyleDefinitionV1[] = []
  const visited = new Set<string>()
  const visit = (currentId: string): void => {
    if (visited.has(currentId)) return
    visited.add(currentId)
    const current = catalog.styles.get(currentId)
    if (!current) return
    if (current.basedOn) visit(current.basedOn)
    resolved.push(current)
  }
  visit(styleId)
  return resolved
}

function cloneBorder(border: ITableCellBorder): ITableCellBorder {
  return {
    color: { ...border.color },
    ...(border.width ? { width: { ...border.width } } : {}),
    ...(border.dashStyle !== undefined ? { dashStyle: border.dashStyle } : {}),
  }
}

function cloneMargin(margin: ITableCellMargin): ITableCellMargin {
  return {
    start: { ...margin.start },
    end: { ...margin.end },
    top: { ...margin.top },
    bottom: { ...margin.bottom },
  }
}

function lastOpenTagInSources(sources: readonly string[], tag: string): string | undefined {
  let result: string | undefined
  for (const source of sources) result = firstOpenTag(source, tag) ?? result
  return result
}

function lastAttributeOfFirst(
  sources: readonly string[],
  tag: string,
  name: string,
): string | undefined {
  let result: string | undefined
  for (const source of sources) result = attributeOfFirst(source, tag, name) ?? result
  return result
}

function lastWordBoolean(sources: readonly string[], tag: string): boolean | undefined {
  let result: boolean | undefined
  for (const source of sources) result = wordBoolean(source, tag) ?? result
  return result
}

function collectOrderedBlocks(xml: string, tags: readonly string[]): Array<{ tag: string; xml: string }> {
  const results: Array<{ tag: string; xml: string }> = []
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
    results.push({ tag: nextTag, xml: element })
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
  const token = new RegExp(`</?${escapeRegExp(tag)}\\b[^>]*>`, 'g')
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
  return openTag.match(new RegExp(`${escapeRegExp(name)}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1]
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

function hasVisibleText(xml: string): boolean {
  return [...xml.matchAll(/<w:(?:t|instrText)\b[^>]*>([\s\S]*?)<\/w:(?:t|instrText)>/g)]
    .some((match) => decodeXmlText(match[1]).trim().length > 0)
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
