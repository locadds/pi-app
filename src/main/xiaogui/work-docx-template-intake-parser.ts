import { randomUUID } from 'node:crypto'

import { parseOffice, type OfficeContentNode, type OfficeParserAST } from 'officeparser/slim'

import type {
  TemplateIntakeCandidateV1,
  TemplateIntakeDocumentProfileV1,
  TemplateIntakeRiskFlagV1,
  TemplateIntakeSourceAnchorV1,
  TemplateIntakeWarningV1,
} from '@shared/xiaogui-work-docx-template-intake'
import type {
  TemplateIntakeAnalysisFragmentKindV1,
  TemplateIntakeAnalysisFragmentV1,
} from '@shared/worker-host-tools'
import {
  DOCX_SAFETY_MAX_UNCOMPRESSED_BYTES_V1,
  DOCX_SAFETY_MAX_ZIP_ENTRIES_V1,
  inspectSafeDocxArchiveV1,
} from './docx-safety'

export interface ParsedTemplateIntakeFragmentV1 extends TemplateIntakeAnalysisFragmentV1 {
  semanticAligned: boolean
  sourceOrder: number
}

export interface ParsedTemplateIntakeSourceV1 {
  profile: TemplateIntakeDocumentProfileV1
  fragments: readonly ParsedTemplateIntakeFragmentV1[]
  deterministicCandidates: readonly TemplateIntakeCandidateV1[]
  warnings: readonly TemplateIntakeWarningV1[]
}

export interface TemplateIntakeSemanticSnapshotV1 {
  mainText: string
  headerText: string
  footerText: string
  tableCount: number
  warningCount: number
}

export type TemplateIntakeSemanticParserV1 = (
  content: Buffer,
  signal: AbortSignal,
) => Promise<TemplateIntakeSemanticSnapshotV1>

type XmlMatch = { value: string; index: number }
type FragmentSeed = Omit<ParsedTemplateIntakeFragmentV1, 'fragmentId' | 'semanticAligned'>

const PARAGRAPH_RE = /<w:p\b[\s\S]*?<\/w:p>/g
const TABLE_RE = /<w:tbl\b[\s\S]*?<\/w:tbl>/g
const ROW_RE = /<w:tr\b[\s\S]*?<\/w:tr>/g
const CELL_RE = /<w:tc\b[\s\S]*?<\/w:tc>/g
const TEXT_BOX_RE = /<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g

function collectMatches(text: string, pattern: RegExp): XmlMatch[] {
  const matches: XmlMatch[] = []
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    matches.push({ value: match[0], index: match.index ?? 0 })
  }
  return matches
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

function visibleText(xml: string): string {
  const withBreaks = xml.replace(/<w:(?:tab|br|cr)\b[^>]*\/?\s*>/g, '\n')
  const chunks = [...withBreaks.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) =>
    decodeXmlText(match[1]),
  )
  return chunks.join('').replace(/\r\n?/g, '\n').trim()
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function maskRanges(text: string, matches: readonly XmlMatch[]): string {
  if (matches.length === 0) return text
  // RegExp 的 match.index 是 UTF-16 码元偏移；split('') 保持相同索引语义。
  const chars = text.split('')
  for (const match of matches) {
    for (let index = match.index; index < match.index + match.value.length; index += 1) {
      chars[index] = ' '
    }
  }
  return chars.join('')
}

function countBefore(xml: string, offset: number, pattern: RegExp): number {
  const prefix = xml.slice(0, offset)
  return prefix.match(pattern)?.length ?? 0
}

function isHeading(paragraphXml: string): boolean {
  const match = paragraphXml.match(/<w:pStyle\b[^>]*w:val=["']([^"']+)["']/i)
  return Boolean(match && /^(?:heading|标题)/i.test(match[1]))
}

function paragraphSeeds(
  xml: string,
  part: 'BODY' | 'HEADER' | 'FOOTER',
  partIndex: number | undefined,
  sourceBase: number,
): FragmentSeed[] {
  const excluded = [...collectMatches(xml, TABLE_RE), ...collectMatches(xml, TEXT_BOX_RE)]
  const visibleXml = maskRanges(xml, excluded)
  let paragraphIndex = 0
  return collectMatches(visibleXml, PARAGRAPH_RE).flatMap((match) => {
    const text = visibleText(match.value)
    if (!text) return []
    paragraphIndex += 1
    return [
      {
        kind:
          part === 'HEADER'
            ? ('HEADER' as const)
            : part === 'FOOTER'
              ? ('FOOTER' as const)
              : isHeading(match.value)
                ? ('HEADING' as const)
                : ('PARAGRAPH' as const),
        anchor: {
          part,
          ...(part === 'BODY'
            ? { sectionIndex: countBefore(xml, match.index, /<w:sectPr\b/g) + 1 }
            : { partIndex }),
          paragraphIndex,
        },
        text,
        sourceOrder: sourceBase + match.index,
      },
    ]
  })
}

function tableSeeds(xml: string): FragmentSeed[] {
  const seeds: FragmentSeed[] = []
  const tables = collectMatches(xml, TABLE_RE)
  tables.forEach((table, tableOffset) => {
    const rows = collectMatches(table.value, ROW_RE)
    rows.forEach((row, rowOffset) => {
      const cells = collectMatches(row.value, CELL_RE)
      cells.forEach((cell, cellOffset) => {
        const text = visibleText(cell.value)
        if (!text) return
        seeds.push({
          kind: 'TABLE_CELL',
          anchor: {
            part: 'TABLE',
            sectionIndex: countBefore(xml, table.index, /<w:sectPr\b/g) + 1,
            tableIndex: tableOffset + 1,
            rowIndex: rowOffset + 1,
            cellIndex: cellOffset + 1,
          },
          text,
          sourceOrder: table.index + row.index + cell.index,
        })
      })
    })
  })
  return seeds
}

function textBoxCandidates(xmlParts: readonly string[]): TemplateIntakeCandidateV1[] {
  const candidates: TemplateIntakeCandidateV1[] = []
  let drawingIndex = 0
  for (const xml of xmlParts) {
    for (const match of collectMatches(xml, TEXT_BOX_RE)) {
      drawingIndex += 1
      const text = visibleText(match.value)
      candidates.push({
        candidateId: `xgtic1_${randomUUID()}`,
        kind: 'EXCLUDE',
        preview: text ? sliceUnicode(text, 500) : `文本框 ${drawingIndex}`,
        sourceAnchors: [{ part: 'TEXT_BOX', drawingIndex }],
        reason: '文本框属于复杂浮动内容，首期默认排除并交由人工确认',
        confidence: 1,
        riskFlags: ['TEXT_BOX', 'FLOATING_OBJECT'],
        defaultDecision: 'EXCLUDE',
      })
    }
  }
  return candidates
}

type DrawingCandidateKindV1 = 'INLINE' | 'FLOATING' | 'UNSUPPORTED'

function drawingCandidateKinds(xmlParts: readonly string[]): DrawingCandidateKindV1[] {
  return xmlParts.flatMap((xml) =>
    collectMatches(xml, /<w:drawing\b[\s\S]*?<\/w:drawing>/g).flatMap((drawing) => {
      const uses = drawing.value.match(/<a:blip\b[^>]*\br:embed=["'][^"']+["']/g)?.length ?? 0
      const kind: DrawingCandidateKindV1 = /<wp:anchor\b/.test(drawing.value)
        ? 'FLOATING'
        : /<wp:inline\b/.test(drawing.value)
          ? 'INLINE'
          : 'UNSUPPORTED'
      return Array.from({ length: uses }, () => kind)
    }),
  )
}

function drawingCandidates(
  kinds: readonly DrawingCandidateKindV1[],
  inlineDrawingCount: number,
  floatingDrawingCount: number,
): TemplateIntakeCandidateV1[] {
  if (kinds.length === 0) return []
  return kinds.map((kind, index) => {
    const risks: TemplateIntakeRiskFlagV1[] = ['OLD_PROJECT_DRAWING', 'SCANNED_ATTACHMENT']
    if (kind === 'FLOATING') risks.push('FLOATING_OBJECT')
    return {
      candidateId: `xgtic1_${randomUUID()}`,
      kind: 'EXCLUDE',
      preview: `图片或图件 ${index + 1}（共 ${kinds.length} 项；行内 ${inlineDrawingCount}，浮动 ${floatingDrawingCount}）`,
      sourceAnchors: [{ part: 'DRAWING', drawingIndex: index + 1 }],
      reason: '图片、扫描附件和旧项目图件无法仅凭文本可靠区分，首期按高风险规则默认排除并交由人工确认',
      confidence: 1,
      riskFlags: risks,
      defaultDecision: 'EXCLUDE',
    }
  })
}

function nodeText(nodes: readonly OfficeContentNode[] | undefined): string {
  if (!nodes) return ''
  return nodes
    .map((node) => node.text ?? nodeText(node.children))
    .filter(Boolean)
    .join('\n')
}

function countNodeType(nodes: readonly OfficeContentNode[] | undefined, type: string): number {
  if (!nodes) return 0
  return nodes.reduce(
    (count, node) => count + (node.type === type ? 1 : 0) + countNodeType(node.children, type),
    0,
  )
}

export const defaultTemplateIntakeSemanticParserV1: TemplateIntakeSemanticParserV1 = async (
  content,
  signal,
) => {
  let warningCount = 0
  const ast: OfficeParserAST = await parseOffice(content, {
    fileType: 'docx',
    ocr: false,
    extractAttachments: false,
    includeRawContent: false,
    ignoreHeadersAndFooters: false,
    abortSignal: signal,
    decompressionLimits: {
      maxUncompressedBytes: DOCX_SAFETY_MAX_UNCOMPRESSED_BYTES_V1,
      maxZipEntries: DOCX_SAFETY_MAX_ZIP_ENTRIES_V1,
      maxTableCells: 200_000,
    },
    onWarning: () => {
      warningCount += 1
    },
  })
  if (ast.type !== 'docx') throw new Error('OFFICEPARSER_TYPE_MISMATCH')
  return {
    mainText: nodeText(ast.content) || ast.toText(),
    headerText: nodeText(ast.auxiliary?.headers),
    footerText: nodeText(ast.auxiliary?.footers),
    tableCount: countNodeType(ast.content, 'table'),
    warningCount: Math.max(warningCount, ast.warnings.length),
  }
}

function alignGroup(
  seeds: readonly FragmentSeed[],
  semanticText: string,
  forceFailure: (seed: FragmentSeed) => boolean,
): ParsedTemplateIntakeFragmentV1[] {
  const normalizedSemantic = normalizeText(semanticText)
  let cursor = 0
  return [...seeds]
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
    .map((seed) => {
      const needle = normalizeText(seed.text)
      const found = forceFailure(seed) || !needle ? -1 : normalizedSemantic.indexOf(needle, cursor)
      if (found >= 0) cursor = found + needle.length
      return {
        ...seed,
        fragmentId: `xgtif1_${randomUUID()}`,
        semanticAligned: found >= 0,
      }
    })
}

function readPageCount(appXml: string | null): number | null {
  const match = appXml?.match(/<Pages>(\d+)<\/Pages>/i)
  if (!match) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function countMatches(xmlParts: readonly string[], pattern: RegExp): number {
  return xmlParts.reduce((total, xml) => total + (xml.match(pattern)?.length ?? 0), 0)
}

export async function parseTemplateIntakeSourceV1(
  content: Buffer,
  signal: AbortSignal,
  semanticParser: TemplateIntakeSemanticParserV1 = defaultTemplateIntakeSemanticParserV1,
): Promise<ParsedTemplateIntakeSourceV1> {
  const { zip } = await inspectSafeDocxArchiveV1(content)
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const documentXml = await zip.file('word/document.xml')!.async('string')
  const headerNames = Object.keys(zip.files)
    .filter((name) => /^word\/header[^/]*\.xml$/i.test(name))
    .sort()
  const footerNames = Object.keys(zip.files)
    .filter((name) => /^word\/footer[^/]*\.xml$/i.test(name))
    .sort()
  const headers = await Promise.all(headerNames.map(async (name) => zip.file(name)!.async('string')))
  const footers = await Promise.all(footerNames.map(async (name) => zip.file(name)!.async('string')))
  const wordXml = [documentXml, ...headers, ...footers]
  const appXmlEntry = zip.file('docProps/app.xml')
  const appXml = appXmlEntry ? await appXmlEntry.async('string') : null
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const bodySeeds = [...paragraphSeeds(documentXml, 'BODY', undefined, 0), ...tableSeeds(documentXml)]
  const headerSeeds = headers.flatMap((xml, index) =>
    paragraphSeeds(xml, 'HEADER', index + 1, (index + 1) * 1_000_000_000),
  )
  const footerSeeds = footers.flatMap((xml, index) =>
    paragraphSeeds(xml, 'FOOTER', index + 1, (index + 1) * 1_000_000_000),
  )

  let semantic: TemplateIntakeSemanticSnapshotV1
  let semanticFailed = false
  try {
    semantic = await semanticParser(content, signal)
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof DOMException && error.name === 'AbortError') ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error
    }
    semanticFailed = true
    semantic = {
      mainText: '',
      headerText: '',
      footerText: '',
      tableCount: 0,
      warningCount: 0,
    }
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const structureTableCount = collectMatches(documentXml, TABLE_RE).length
  const tableMismatch = semantic.tableCount !== structureTableCount

  const fragments = [
    ...alignGroup(bodySeeds, semantic.mainText, (seed) => tableMismatch && seed.kind === 'TABLE_CELL'),
    ...alignGroup(headerSeeds, semantic.headerText, () => false),
    ...alignGroup(footerSeeds, semantic.footerText, () => false),
  ]
  const pageCount = readPageCount(appXml)
  const inlineDrawingCount = countMatches(wordXml, /<wp:inline\b/g)
  const floatingDrawingCount = countMatches(wordXml, /<wp:anchor\b/g)
  const textBoxCount = countMatches(wordXml, /<w:txbxContent\b/g)
  const mediaCount = Object.keys(zip.files).filter(
    (name) => /^word\/media\/[^/]+$/i.test(name) && !zip.files[name].dir,
  ).length
  const imageUseCount = countMatches(wordXml, /<a:blip\b[^>]*\br:embed=["'][^"']+["']/g)
  const detectedDrawingKinds = drawingCandidateKinds(wordXml)
  const drawingKinds = [
    ...detectedDrawingKinds,
    ...Array.from(
      { length: Math.max(0, imageUseCount - detectedDrawingKinds.length) },
      () => 'UNSUPPORTED' as const,
    ),
  ]
  const warnings: TemplateIntakeWarningV1[] = [
    ...(pageCount === null
      ? [{ code: 'PAGE_COUNT_UNKNOWN' as const, message: '无法从文档属性可靠取得页数' }]
      : []),
    { code: 'SCAN_COUNT_UNKNOWN', message: 'OCR 已关闭，扫描页数量无法可靠判断' },
    ...(semanticFailed
      ? [
          {
            code: 'OTHER' as const,
            message: '语义解析器不可用，已仅保留结构基线并将相关内容降级为无法判断',
          },
        ]
      : []),
    ...(tableMismatch
      ? [
          {
            code: 'SEMANTIC_COUNT_MISMATCH' as const,
            message: `结构门识别 ${structureTableCount} 个表格，语义解析器识别 ${semantic.tableCount} 个；相关内容已降级为无法判断`,
          },
        ]
      : []),
    ...(fragments.some((fragment) => !fragment.semanticAligned)
      ? [
          {
            code: 'SEMANTIC_ALIGNMENT_FAILED' as const,
            message: '部分内容无法用规范化文本和重复顺序可靠对齐，已降级为无法判断',
          },
        ]
      : []),
    ...(floatingDrawingCount > 0
      ? [
          {
            code: 'FLOATING_CONTENT_REQUIRES_REVIEW' as const,
            message: `识别到 ${floatingDrawingCount} 个浮动对象，必须人工复核`,
          },
        ]
      : []),
    ...(textBoxCount > 0
      ? [
          {
            code: 'TEXT_BOX_REQUIRES_REVIEW' as const,
            message: `识别到 ${textBoxCount} 个文本框，必须人工复核`,
          },
        ]
      : []),
    ...(semantic.warningCount > 0
      ? [
          {
            code: 'OTHER' as const,
            message: `语义解析器返回 ${semantic.warningCount} 条非致命警告`,
          },
        ]
      : []),
  ]

  return {
    profile: {
      pageCount: { value: pageCount, basis: pageCount === null ? 'UNKNOWN' : 'DOCUMENT_PROPERTY' },
      sectionCount: Math.max(1, documentXml.match(/<w:sectPr\b/g)?.length ?? 0),
      headerPartCount: headerNames.length,
      footerPartCount: footerNames.length,
      tableCount: structureTableCount,
      mediaCount,
      inlineDrawingCount,
      floatingDrawingCount,
      textBoxCount,
      fieldCount: countMatches(wordXml, /<w:fldSimple\b/g) + countMatches(wordXml, /<w:instrText\b/g),
      contentControlCount: countMatches(wordXml, /<w:sdt\b/g),
      scannedPageCount: null,
    },
    fragments,
    deterministicCandidates: [
      ...textBoxCandidates(wordXml),
      ...drawingCandidates(drawingKinds, inlineDrawingCount, floatingDrawingCount),
    ],
    warnings,
  }
}

export function sliceUnicode(text: string, maxCharacters: number): string {
  return Array.from(text).slice(0, maxCharacters).join('')
}
