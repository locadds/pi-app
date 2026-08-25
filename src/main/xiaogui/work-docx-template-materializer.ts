import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type JSZip from 'jszip'

import type {
  TemplateIntakeCandidateV1,
  TemplateIntakeDecisionV1,
  TemplateIntakeFinalDecisionItemV1,
  TemplateIntakeReportV1,
  TemplateIntakeSourceAnchorV1,
} from '@shared/xiaogui-work-docx-template-intake'
import { createTemplateIntakeReportSummaryV1 } from '@shared/xiaogui-work-docx-template-intake'
import type {
  TemplateMaterializeDynamicItemV1,
  TemplateMaterializeErrorCodeV1,
  TemplateMaterializePlanV1,
} from '@shared/xiaogui-work-docx-template-materialize'
import { TEMPLATE_MATERIALIZE_VERSION_V1 } from '@shared/xiaogui-work-docx-template-materialize'

import { inspectSafeDocxArchiveV1 } from './docx-safety'

const PARAGRAPH_RE = /<w:p\b[\s\S]*?<\/w:p>/g
const TABLE_RE = /<w:tbl\b[\s\S]*?<\/w:tbl>/g
const ROW_RE = /<w:tr\b[\s\S]*?<\/w:tr>/g
const CELL_RE = /<w:tc\b[\s\S]*?<\/w:tc>/g
const TEXT_BOX_RE = /<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g
const FIELD_NAME_RE = /^[\p{L}][\p{L}\p{N}_.-]{0,63}$/u
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const MATERIALIZED_ZIP_ENTRY_DATE = new Date('2000-01-01T00:00:00.000Z')

type XmlMatch = { value: string; index: number }
type MutableXmlPart = { name: string; xml: string }
type AnchorTarget = {
  key: string
  partName: string
  kind: 'PARAGRAPH' | 'CELL'
  start: number
  end: number
  orderIndex: number
  tableIndex?: number
  rowIndex?: number
  rowStart?: number
  rowEnd?: number
}
type AnchorAction = {
  candidate: TemplateIntakeCandidateV1
  decision: TemplateIntakeFinalDecisionItemV1
  name?: string
}
type RangeEdit = { start: number; end: number; replacement: string }
type StructuralEdit = RangeEdit & { candidateId: string; partName: string }

export class TemplateMaterializerErrorV1 extends Error {
  constructor(
    readonly code: TemplateMaterializeErrorCodeV1,
    readonly internalDetail?: string,
  ) {
    super(internalDetail ? `${code}:${internalDetail}` : code)
  }
}

export interface MaterializeConfirmedTemplateInputV1 {
  source: Buffer
  report: TemplateIntakeReportV1
  decision: TemplateIntakeDecisionV1
}

export interface MaterializeConfirmedTemplateResultV1 {
  content: Buffer
  decisionSha256: string
  plan: TemplateMaterializePlanV1
}

function fail(code: TemplateMaterializeErrorCodeV1): never {
  throw new TemplateMaterializerErrorV1(code)
}

function collectMatches(text: string, pattern: RegExp): XmlMatch[] {
  pattern.lastIndex = 0
  return [...text.matchAll(pattern)].map((match) => ({
    value: match[0],
    index: match.index ?? 0,
  }))
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
  return [...withBreaks.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXmlText(match[1]))
    .join('')
    .replace(/\r\n?/g, '\n')
    .trim()
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function maskRanges(text: string, matches: readonly XmlMatch[]): string {
  if (matches.length === 0) return text
  const chars = text.split('')
  for (const match of matches) {
    for (let index = match.index; index < match.index + match.value.length; index += 1) {
      chars[index] = ' '
    }
  }
  return chars.join('')
}

function countBefore(xml: string, offset: number, pattern: RegExp): number {
  return xml.slice(0, offset).match(pattern)?.length ?? 0
}

function anchorKey(anchor: TemplateIntakeSourceAnchorV1): string {
  return [
    anchor.part,
    anchor.sectionIndex ?? '',
    anchor.partIndex ?? '',
    anchor.paragraphIndex ?? '',
    anchor.tableIndex ?? '',
    anchor.rowIndex ?? '',
    anchor.cellIndex ?? '',
    anchor.drawingIndex ?? '',
  ].join(':')
}

function paragraphTargets(
  part: MutableXmlPart,
  sourcePart: 'BODY' | 'HEADER' | 'FOOTER',
  partIndex: number | undefined,
): AnchorTarget[] {
  const excluded = [...collectMatches(part.xml, TABLE_RE), ...collectMatches(part.xml, TEXT_BOX_RE)]
  const masked = maskRanges(part.xml, excluded)
  let paragraphIndex = 0
  const targets: AnchorTarget[] = []
  for (const match of collectMatches(masked, PARAGRAPH_RE)) {
    if (!visibleText(match.value)) continue
    paragraphIndex += 1
    const anchor: TemplateIntakeSourceAnchorV1 = {
      part: sourcePart,
      ...(sourcePart === 'BODY'
        ? { sectionIndex: countBefore(part.xml, match.index, /<w:sectPr\b/g) + 1 }
        : { partIndex }),
      paragraphIndex,
    }
    targets.push({
      key: anchorKey(anchor),
      partName: part.name,
      kind: 'PARAGRAPH',
      start: match.index,
      end: match.index + match.value.length,
      orderIndex: targets.length,
    })
  }
  return targets
}

function tableTargets(part: MutableXmlPart): AnchorTarget[] {
  const targets: AnchorTarget[] = []
  for (const [tableOffset, table] of collectMatches(part.xml, TABLE_RE).entries()) {
    for (const [rowOffset, row] of collectMatches(table.value, ROW_RE).entries()) {
      const rowStart = table.index + row.index
      const rowEnd = rowStart + row.value.length
      for (const [cellOffset, cell] of collectMatches(row.value, CELL_RE).entries()) {
        if (!visibleText(cell.value)) continue
        const start = rowStart + cell.index
        const anchor: TemplateIntakeSourceAnchorV1 = {
          part: 'TABLE',
          sectionIndex: countBefore(part.xml, table.index, /<w:sectPr\b/g) + 1,
          tableIndex: tableOffset + 1,
          rowIndex: rowOffset + 1,
          cellIndex: cellOffset + 1,
        }
        targets.push({
          key: anchorKey(anchor),
          partName: part.name,
          kind: 'CELL',
          start,
          end: start + cell.value.length,
          orderIndex: targets.length,
          tableIndex: tableOffset + 1,
          rowIndex: rowOffset + 1,
          rowStart,
          rowEnd,
        })
      }
    }
  }
  return targets
}

function collectAnchorTargets(parts: readonly MutableXmlPart[]): Map<string, AnchorTarget> {
  const targets = new Map<string, AnchorTarget>()
  const document = parts.find((part) => part.name === 'word/document.xml')
  if (!document) fail('TEMPLATE_MATERIALIZE_GENERATION_FAILED')
  const headers = parts.filter((part) => /^word\/header[^/]*\.xml$/i.test(part.name)).sort((a, b) => a.name.localeCompare(b.name))
  const footers = parts.filter((part) => /^word\/footer[^/]*\.xml$/i.test(part.name)).sort((a, b) => a.name.localeCompare(b.name))
  const all = [
    ...paragraphTargets(document, 'BODY', undefined),
    ...tableTargets(document),
    ...headers.flatMap((part, index) => paragraphTargets(part, 'HEADER', index + 1)),
    ...footers.flatMap((part, index) => paragraphTargets(part, 'FOOTER', index + 1)),
  ]
  for (const target of all) {
    if (targets.has(target.key)) fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
    targets.set(target.key, target)
  }
  return targets
}

function replaceVisibleText(xml: string, replacement: string): string {
  if (/<w:(?:instrText|fldSimple|fldChar)\b/i.test(xml) || /<w:sdt\b/i.test(xml)) {
    fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
  }
  let replaced = false
  const output = xml
    .replace(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g, (_whole, attributes: string) => {
      const text = replaced ? '' : escapeXmlText(replacement)
      replaced = true
      return `<w:t${attributes}>${text}</w:t>`
    })
    .replace(/<w:(?:tab|br|cr)\b[^>]*\/?\s*>/g, '')
  if (!replaced) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
  return output
}

function clearTargetContent(xml: string, kind: AnchorTarget['kind']): string {
  if (kind === 'PARAGRAPH') {
    const opening = xml.match(/^<w:p\b[^>]*>/)?.[0]
    if (!opening || !/<\/w:p>$/.test(xml)) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
    const properties = xml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? ''
    return `${opening}${properties}</w:p>`
  }
  const opening = xml.match(/^<w:tc\b[^>]*>/)?.[0]
  if (!opening || !/<\/w:tc>$/.test(xml)) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
  const properties = xml.match(/<w:tcPr\b[\s\S]*?<\/w:tcPr>/)?.[0] ?? ''
  return `${opening}${properties}<w:p/></w:tc>`
}

function applyRangeEdits(xml: string, edits: readonly RangeEdit[]): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start)
  let lastStart = Number.POSITIVE_INFINITY
  let output = xml
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end <= edit.start || edit.end > output.length || edit.end > lastStart) {
      fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
    }
    output = `${output.slice(0, edit.start)}${edit.replacement}${output.slice(edit.end)}`
    lastStart = edit.start
  }
  return output
}

function normalizedDynamicName(
  candidate: TemplateIntakeCandidateV1,
  decision: TemplateIntakeFinalDecisionItemV1,
  fallback: string,
): string {
  const name = (decision.fieldName ?? candidate.suggestedName ?? fallback).normalize('NFKC').trim()
  if (!FIELD_NAME_RE.test(name) || RESERVED_NAMES.has(name)) {
    fail('TEMPLATE_MATERIALIZE_DYNAMIC_NAME_INVALID')
  }
  return name
}

function buildActions(
  report: TemplateIntakeReportV1,
  decision: TemplateIntakeDecisionV1,
): {
  byAnchor: Map<string, AnchorAction>
  drawingAction: AnchorAction | null
  textBoxActions: Map<number, AnchorAction>
  dynamics: TemplateMaterializeDynamicItemV1[]
  excludedCount: number
  retainedHighRiskCount: number
} {
  if (decision.reportId !== report.reportId || decision.decisions.length !== report.candidates.length) {
    fail('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
  }
  const decisionById = new Map(decision.decisions.map((item) => [item.candidateId, item]))
  if (decisionById.size !== decision.decisions.length) fail('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
  const byAnchor = new Map<string, AnchorAction>()
  const textBoxActions = new Map<number, AnchorAction>()
  let drawingAction: AnchorAction | null = null
  const dynamics: TemplateMaterializeDynamicItemV1[] = []
  const dynamicNames = new Set<string>()
  let excludedCount = 0
  let retainedHighRiskCount = 0
  let variableIndex = 0
  let repeatIndex = 0
  let conditionalIndex = 0

  for (const candidate of report.candidates) {
    const item = decisionById.get(candidate.candidateId)
    if (!item) fail('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
    if (item.decision === 'EXCLUDE') excludedCount += 1
    if (candidate.riskFlags.length > 0 && item.decision !== 'EXCLUDE') {
      if (!item.highRiskOverrideReason?.trim() || item.highRiskOverrideConfirmed !== true) {
        fail('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
      }
      retainedHighRiskCount += 1
    }
    let name: string | undefined
    if (item.decision === 'VARIABLE') {
      variableIndex += 1
      name = normalizedDynamicName(candidate, item, `变量${variableIndex}`)
    } else if (item.decision === 'REPEAT') {
      repeatIndex += 1
      name = normalizedDynamicName(candidate, item, `重复块${repeatIndex}`)
    } else if (item.decision === 'CONDITIONAL') {
      conditionalIndex += 1
      name = normalizedDynamicName(candidate, item, `条件块${conditionalIndex}`)
    }
    const action: AnchorAction = { candidate, decision: item, ...(name ? { name } : {}) }
    if (name) {
      if (dynamicNames.has(name)) fail('TEMPLATE_MATERIALIZE_DYNAMIC_NAME_INVALID')
      dynamicNames.add(name)
      dynamics.push({ name, kind: item.decision as TemplateMaterializeDynamicItemV1['kind'], sourceAnchors: candidate.sourceAnchors })
    }
    for (const anchor of candidate.sourceAnchors) {
      if (anchor.part === 'DRAWING') {
        if (item.decision !== 'FIXED' && item.decision !== 'EXCLUDE') {
          fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
        }
        if (drawingAction && drawingAction.decision.decision !== item.decision) {
          fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
        }
        drawingAction = action
        continue
      }
      if (anchor.part === 'TEXT_BOX') {
        if (item.decision !== 'FIXED' && item.decision !== 'EXCLUDE') {
          fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
        }
        if (!anchor.drawingIndex) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
        const previous = textBoxActions.get(anchor.drawingIndex)
        if (previous && previous.decision.decision !== item.decision) {
          fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
        }
        textBoxActions.set(anchor.drawingIndex, action)
        continue
      }
      const key = anchorKey(anchor)
      const previous = byAnchor.get(key)
      if (
        previous &&
        (previous.decision.decision !== item.decision || previous.name !== name)
      ) {
        fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
      }
      byAnchor.set(key, action)
    }
  }
  if (decisionById.size !== report.candidates.length) fail('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
  return { byAnchor, drawingAction, textBoxActions, dynamics, excludedCount, retainedHighRiskCount }
}

function balancedTagRanges(
  xml: string,
  tag: 'w:drawing' | 'w:pict' | 'w:object',
): RangeEdit[] {
  const tokens = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g')
  const stack: number[] = []
  const ranges: RangeEdit[] = []
  for (const match of xml.matchAll(tokens)) {
    const index = match.index ?? 0
    if (match[1] === '/') {
      const start = stack.pop()
      if (start === undefined) fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
      ranges.push({ start, end: index + match[0].length, replacement: '' })
    } else if (!/\/\s*>$/.test(match[0])) {
      stack.push(index)
    }
  }
  if (stack.length > 0) fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
  return ranges.sort((left, right) => left.start - right.start || right.end - left.end)
}

function findEnclosingRange(xml: string, offset: number, tag: 'w:drawing' | 'w:pict'): RangeEdit | null {
  return (
    balancedTagRanges(xml, tag)
      .filter((range) => range.start <= offset && range.end >= offset)
      .sort((left, right) => left.end - left.start - (right.end - right.start))[0] ?? null
  )
}

function removeSelectedTextBoxes(
  parts: MutableXmlPart[],
  selected: ReadonlySet<number>,
): Map<string, RangeEdit[]> {
  let globalIndex = 0
  const removedByPart = new Map<string, RangeEdit[]>()
  for (const part of parts) {
    const removals = new Map<string, RangeEdit>()
    for (const match of collectMatches(part.xml, TEXT_BOX_RE)) {
      globalIndex += 1
      if (!selected.has(globalIndex)) continue
      const drawing = findEnclosingRange(part.xml, match.index, 'w:drawing')
      const pict = findEnclosingRange(part.xml, match.index, 'w:pict')
      const enclosing = [drawing, pict]
        .filter((value): value is RangeEdit => Boolean(value))
        .sort((left, right) => left.end - left.start - (right.end - right.start))[0]
      if (!enclosing) fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
      removals.set(`${enclosing.start}:${enclosing.end}`, enclosing)
    }
    if (removals.size > 0) {
      const ranges = [...removals.values()]
      part.xml = applyRangeEdits(part.xml, ranges)
      removedByPart.set(part.name, ranges)
    }
  }
  for (const index of selected) {
    if (index <= 0 || index > globalIndex) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
  }
  return removedByPart
}

function removeDrawingContentExceptConfirmedTextBoxes(
  parts: MutableXmlPart[],
  textBoxActions: ReadonlyMap<number, AnchorAction>,
): Map<string, RangeEdit[]> {
  let globalIndex = 0
  const preservedByPart = new Map<string, RangeEdit[]>()
  const excludedByPart = new Map<string, RangeEdit[]>()
  const removedByPart = new Map<string, RangeEdit[]>()
  for (const part of parts) {
    for (const textBox of collectMatches(part.xml, TEXT_BOX_RE)) {
      globalIndex += 1
      const action = textBoxActions.get(globalIndex)
      const enclosing = [
        findEnclosingRange(part.xml, textBox.index, 'w:drawing'),
        findEnclosingRange(part.xml, textBox.index, 'w:pict'),
      ]
        .filter((value): value is RangeEdit => Boolean(value))
        .sort((left, right) => left.end - left.start - (right.end - right.start))[0]
      if (!enclosing) fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
      const target = action?.decision.decision === 'FIXED' ? preservedByPart : excludedByPart
      const ranges = target.get(part.name) ?? []
      ranges.push(enclosing)
      target.set(part.name, ranges)
    }
  }
  for (const index of textBoxActions.keys()) {
    if (index <= 0 || index > globalIndex) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
  }
  for (const part of parts) {
    const preserved = preservedByPart.get(part.name) ?? []
    const excluded = excludedByPart.get(part.name) ?? []
    if (
      preserved.some((keep) =>
        excluded.some((drop) => keep.start === drop.start && keep.end === drop.end),
      )
    ) {
      fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
    }
    const candidates = [
      ...balancedTagRanges(part.xml, 'w:drawing'),
      ...balancedTagRanges(part.xml, 'w:pict'),
      ...balancedTagRanges(part.xml, 'w:object'),
    ]
      .filter(
        (range) =>
          !preserved.some((keep) => keep.start >= range.start && keep.end <= range.end),
      )
      .sort((left, right) => left.start - right.start || right.end - left.end)
    const outermost: RangeEdit[] = []
    for (const candidate of candidates) {
      if (outermost.some((range) => candidate.start >= range.start && candidate.end <= range.end)) continue
      outermost.push(candidate)
    }
    if (outermost.length > 0) {
      part.xml = applyRangeEdits(part.xml, outermost)
      removedByPart.set(part.name, outermost)
    }
  }
  return removedByPart
}

function adjustTargetAfterRemovals(
  target: AnchorTarget,
  removals: readonly RangeEdit[],
): AnchorTarget | null {
  const ordered = [...removals].sort((left, right) => left.start - right.start)
  for (const removal of ordered) {
    if (removal.start <= target.start && removal.end >= target.end) return null
    if (
      (removal.start <= target.start && removal.end > target.start) ||
      (removal.start < target.end && removal.end >= target.end)
    ) {
      fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
    }
  }
  const shifted = (offset: number): number =>
    offset -
    ordered
      .filter((removal) => removal.end <= offset)
      .reduce((total, removal) => total + removal.end - removal.start, 0)
  return {
    ...target,
    start: shifted(target.start),
    end: shifted(target.end),
    ...(target.rowStart === undefined ? {} : { rowStart: shifted(target.rowStart) }),
    ...(target.rowEnd === undefined ? {} : { rowEnd: shifted(target.rowEnd) }),
  }
}

function adjustTargetsAfterRemovals(
  targets: ReadonlyMap<string, AnchorTarget>,
  removalsByPart: ReadonlyMap<string, readonly RangeEdit[]>,
): Map<string, AnchorTarget> {
  const adjusted = new Map<string, AnchorTarget>()
  for (const [key, target] of targets) {
    const next = adjustTargetAfterRemovals(target, removalsByPart.get(target.partName) ?? [])
    if (next) adjusted.set(key, next)
  }
  return adjusted
}

function contentControl(kind: 'REPEAT' | 'CONDITIONAL', name: string, content: string): string {
  const token = kind === 'REPEAT' ? 'repeat' : 'conditional'
  const label = kind === 'REPEAT' ? '小规重复块' : '小规条件块'
  return `<w:sdt><w:sdtPr><w:alias w:val="${escapeXmlAttribute(`${label}：${name}`)}"/><w:tag w:val="${escapeXmlAttribute(`xiaogui.${token}:${name}`)}"/></w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`
}

function structuralRange(action: AnchorAction, targets: readonly AnchorTarget[]): StructuralEdit {
  if (targets.length === 0 || !action.name) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
  if (new Set(targets.map((target) => target.partName)).size !== 1) {
    fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
  }
  const partName = targets[0].partName
  const sorted = [...targets].sort((left, right) => left.start - right.start)
  let start: number
  let end: number
  if (sorted.every((target) => target.kind === 'PARAGRAPH')) {
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index].orderIndex !== sorted[index - 1].orderIndex + 1) {
        fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
      }
    }
    start = sorted[0].start
    end = sorted.at(-1)!.end
  } else if (sorted.every((target) => target.kind === 'CELL')) {
    const tableIndexes = new Set(sorted.map((target) => target.tableIndex))
    if (tableIndexes.size !== 1) fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
    const rows = [...new Set(sorted.map((target) => target.rowIndex!))].sort((a, b) => a - b)
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index] !== rows[index - 1] + 1) fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
    }
    if (rows.length === 1 && sorted.length === 1) {
      start = sorted[0].start
      end = sorted[0].end
    } else {
      start = Math.min(...sorted.map((target) => target.rowStart!))
      end = Math.max(...sorted.map((target) => target.rowEnd!))
    }
  } else {
    fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
  }
  return { start, end, replacement: '', candidateId: action.candidate.candidateId, partName }
}

function relationshipOwnerPart(name: string): string | null {
  const match = name.match(/^(.+)\/_rels\/([^/]+)\.rels$/i)
  return match ? `${match[1]}/${match[2]}` : null
}

function relationshipTargetPart(ownerPart: string, target: string): string {
  return posix.normalize(posix.join(posix.dirname(ownerPart), target)).replace(/^\/+/, '')
}

function relationshipIdStillUsed(ownerXml: string, relationshipId: string): boolean {
  return ['r:embed', 'r:id', 'r:link'].some(
    (attribute) =>
      ownerXml.includes(`${attribute}="${relationshipId}"`) ||
      ownerXml.includes(`${attribute}='${relationshipId}'`),
  )
}

async function pruneUnusedMedia(zip: JSZip, parts: readonly MutableXmlPart[]): Promise<number> {
  const partByName = new Map(parts.map((part) => [part.name, part.xml]))
  const usedMedia = new Set<string>()
  const relationshipNames = Object.keys(zip.files).filter((name) => /\.rels$/i.test(name))
  for (const name of relationshipNames) {
    const ownerPart = relationshipOwnerPart(name)
    const file = zip.file(name)
    if (!ownerPart || !file) continue
    const ownerXml = partByName.get(ownerPart) ?? (await zip.file(ownerPart)?.async('string'))
    if (!ownerXml) continue
    const relationships = await file.async('string')
    const cleaned = relationships.replace(/<Relationship\b[^>]*\/?\s*>/gi, (element) => {
      const type = element.match(/\bType=["']([^"']+)["']/i)?.[1] ?? ''
      if (!/\/relationships\/image$/i.test(type)) return element
      const id = element.match(/\bId=["']([^"']+)["']/i)?.[1]
      const target = element.match(/\bTarget=["']([^"']+)["']/i)?.[1]
      if (!id || !target || !relationshipIdStillUsed(ownerXml, id)) return ''
      usedMedia.add(relationshipTargetPart(ownerPart, target))
      return element
    })
    if (cleaned !== relationships) zip.file(name, cleaned)
  }
  let removed = 0
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/media\/[^/]+$/i.test(name) || zip.files[name].dir || usedMedia.has(name)) continue
    zip.remove(name)
    removed += 1
  }
  return removed
}

function localWarnings(
  variableCount: number,
  structuralCount: number,
  retainedHighRiskCount: number,
): string[] {
  const warnings: string[] = []
  if (variableCount > 0) warnings.push('变量会替换整个来源段落或整个表格单元格，不做段内局部猜测')
  if (structuralCount > 0) warnings.push('重复块和条件块已写入 Word 内容控件；当前简单字段生成器不会展开这些结构')
  if (retainedHighRiskCount > 0) warnings.push(`有 ${retainedHighRiskCount} 项高风险内容经人工覆盖后保留，请在预览中再次核对`)
  return warnings
}

export async function materializeConfirmedTemplateV1(
  input: MaterializeConfirmedTemplateInputV1,
): Promise<MaterializeConfirmedTemplateResultV1> {
  const sourceSha256 = createHash('sha256').update(input.source).digest('hex')
  if (sourceSha256 !== input.report.file.sha256) fail('TEMPLATE_MATERIALIZE_SOURCE_CHANGED')
  const decisionSha256 = createHash('sha256').update(JSON.stringify(input.decision)).digest('hex')
  if (
    JSON.stringify(input.decision.reportSummary) !==
    JSON.stringify(createTemplateIntakeReportSummaryV1(input.report))
  ) {
    fail('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
  }
  const { zip } = await inspectSafeDocxArchiveV1(input.source)
  const partNames = Object.keys(zip.files)
    .filter((name) => /^word\/(?:document|header[^/]*|footer[^/]*)\.xml$/i.test(name))
    .sort((left, right) => {
      if (left === 'word/document.xml') return -1
      if (right === 'word/document.xml') return 1
      return left.localeCompare(right)
    })
  const parts: MutableXmlPart[] = await Promise.all(
    partNames.map(async (name) => ({ name, xml: await zip.file(name)!.async('string') })),
  )
  const actions = buildActions(input.report, input.decision)
  const originalMediaNames = Object.keys(zip.files).filter(
    (name) => /^word\/media\/[^/]+$/i.test(name) && !zip.files[name].dir,
  )
  const removeAllDrawings = actions.drawingAction?.decision.decision === 'EXCLUDE'
  const originalTargets = collectAnchorTargets(parts)
  let drawingRemovals = new Map<string, RangeEdit[]>()
  if (removeAllDrawings) {
    drawingRemovals = removeDrawingContentExceptConfirmedTextBoxes(parts, actions.textBoxActions)
  } else {
    const textBoxesToRemove = new Set(
      [...actions.textBoxActions.entries()]
        .filter(([, action]) => action.decision.decision === 'EXCLUDE')
        .map(([index]) => index),
    )
    if (textBoxesToRemove.size > 0) {
      drawingRemovals = removeSelectedTextBoxes(parts, textBoxesToRemove)
    }
  }

  const targets = adjustTargetsAfterRemovals(originalTargets, drawingRemovals)
  const textEdits = new Map<string, RangeEdit[]>()
  const structuralActions: AnchorAction[] = []
  for (const [key, action] of actions.byAnchor) {
    const target = targets.get(key)
    if (!target) {
      throw new TemplateMaterializerErrorV1(
        'TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND',
        `${action.candidate.candidateId}:${key}`,
      )
    }
    switch (action.decision.decision) {
      case 'FIXED':
        break
      case 'EXCLUDE':
      case 'VARIABLE': {
        const part = parts.find((item) => item.name === target.partName)
        if (!part) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
        const current = part.xml.slice(target.start, target.end)
        const replacement =
          action.decision.decision === 'VARIABLE'
            ? replaceVisibleText(current, `{{${action.name}}}`)
            : clearTargetContent(current, target.kind)
        const edits = textEdits.get(target.partName) ?? []
        edits.push({ start: target.start, end: target.end, replacement })
        textEdits.set(target.partName, edits)
        break
      }
      case 'REPEAT':
      case 'CONDITIONAL':
        if (!structuralActions.includes(action)) structuralActions.push(action)
        break
    }
  }
  const structuralByPart = new Map<string, StructuralEdit[]>()
  for (const action of structuralActions) {
    const actionTargets = action.candidate.sourceAnchors.map((anchor) => {
      const target = targets.get(anchorKey(anchor))
      if (!target) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
      return target
    })
    const range = structuralRange(action, actionTargets)
    const part = parts.find((item) => item.name === range.partName)
    if (!part) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
    const wrapped = contentControl(
      action.decision.decision as 'REPEAT' | 'CONDITIONAL',
      action.name!,
      part.xml.slice(range.start, range.end),
    )
    const edits = structuralByPart.get(range.partName) ?? []
    edits.push({ ...range, replacement: wrapped })
    structuralByPart.set(range.partName, edits)
  }
  for (const part of parts) {
    const edits = [
      ...(textEdits.get(part.name) ?? []),
      ...(structuralByPart.get(part.name) ?? []),
    ]
    if (edits?.length) part.xml = applyRangeEdits(part.xml, edits)
    zip.file(part.name, part.xml)
  }

  const removedMediaCount = await pruneUnusedMedia(zip, parts)
  if (removeAllDrawings && removedMediaCount !== originalMediaNames.length) {
    fail('TEMPLATE_MATERIALIZE_GENERATION_FAILED')
  }

  for (const entry of Object.values(zip.files)) entry.date = MATERIALIZED_ZIP_ENTRY_DATE

  const content = (await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })) as Buffer
  await inspectSafeDocxArchiveV1(content)

  const variables = actions.dynamics.filter((item) => item.kind === 'VARIABLE')
  const repeatBlocks = actions.dynamics.filter((item) => item.kind === 'REPEAT')
  const conditionalBlocks = actions.dynamics.filter((item) => item.kind === 'CONDITIONAL')
  const previewSha256 = createHash('sha256').update(content).digest('hex')
  const plan: TemplateMaterializePlanV1 = {
    materializeVersion: TEMPLATE_MATERIALIZE_VERSION_V1,
    reportSummary: createTemplateIntakeReportSummaryV1(input.report),
    source: {
      displayName: input.report.file.displayName,
      sha256: sourceSha256,
      byteLength: input.source.byteLength,
    },
    previewSha256,
    variables,
    repeatBlocks,
    conditionalBlocks,
    excludedCandidateCount: actions.excludedCount,
    removedMediaCount,
    retainedHighRiskCount: actions.retainedHighRiskCount,
    warnings: localWarnings(
      variables.length,
      repeatBlocks.length + conditionalBlocks.length,
      actions.retainedHighRiskCount,
    ),
    requiresSecondConfirmation: true,
    originalSourceUnchanged: true,
    advancedGenerationRequired: repeatBlocks.length + conditionalBlocks.length > 0,
  }
  return { content, decisionSha256, plan }
}
