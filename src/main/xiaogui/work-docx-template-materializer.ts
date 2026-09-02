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
import type { TemplateReviewActionV2, TemplateReviewTextRangeV2 } from '@shared/xiaogui-work-template-review'

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
type VisibleRangeReplacement = TemplateReviewTextRangeV2 & { replacement: string }

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
  /** 旧版 DOC 会先转换为内部 DOCX；此时报告摘要仍锚定原 DOC。 */
  originalSourceSha256?: string
  report: TemplateIntakeReportV1
  decision: TemplateIntakeDecisionV1
  replacementImages?: ReadonlyMap<
    string,
    { content: Buffer; extension: 'png' | 'jpg' | 'jpeg'; contentType: string }
  >
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

function replaceVisibleTextRanges(
  xml: string,
  edits: readonly VisibleRangeReplacement[],
): string {
  if (/<w:(?:instrText|fldSimple|fldChar)\b/i.test(xml) || /<w:sdt\b/i.test(xml)) {
    fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
  }
  const ordered = [...edits].sort(
    (left, right) =>
      left.startUtf16 - right.startUtf16 ||
      left.endUtf16Exclusive - right.endUtf16Exclusive,
  )
  if (
    ordered.some(
      (edit, index) =>
        edit.startUtf16 < 0 ||
        edit.endUtf16Exclusive <= edit.startUtf16 ||
        (index > 0 && ordered[index - 1].endUtf16Exclusive > edit.startUtf16),
    )
  ) {
    fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
  }

  type TextToken = {
    whole: string
    attributes: string
    decoded: string
    start: number
    end: number
    xmlStart: number
    xmlEnd: number
  }
  const tokens: TextToken[] = []
  let visibleOffset = 0
  for (const match of xml.matchAll(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g)) {
    const decoded = decodeXmlText(match[2])
    const xmlStart = match.index ?? 0
    tokens.push({
      whole: match[0],
      attributes: match[1],
      decoded,
      start: visibleOffset,
      end: visibleOffset + decoded.length,
      xmlStart,
      xmlEnd: xmlStart + match[0].length,
    })
    visibleOffset += decoded.length
  }
  if (tokens.length === 0) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')

  const rawVisibleText = tokens.map((token) => token.decoded).join('')
  const trimmedVisibleText = rawVisibleText.trim()
  const leadingTrim = rawVisibleText.indexOf(trimmedVisibleText)
  const visibleLength = trimmedVisibleText.length
  if (
    ordered.some(
      (edit) => edit.endUtf16Exclusive > visibleLength,
    )
  ) {
    fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
  }
  const rawEdits = ordered.map((edit) => ({
    startUtf16: edit.startUtf16 + leadingTrim,
    endUtf16Exclusive: edit.endUtf16Exclusive + leadingTrim,
    replacement: edit.replacement,
  }))

  const xmlEdits: RangeEdit[] = []
  for (const token of tokens) {
    const localEdits = rawEdits.flatMap((edit) => {
      const overlapStart = Math.max(edit.startUtf16, token.start)
      const overlapEnd = Math.min(edit.endUtf16Exclusive, token.end)
      if (overlapStart >= overlapEnd) return []
      return [{
        start: overlapStart - token.start,
        end: overlapEnd - token.start,
        replacement:
          edit.startUtf16 >= token.start && edit.startUtf16 < token.end
            ? edit.replacement
            : '',
      }]
    })
    if (localEdits.length === 0) continue
    const replaced = applyRangeEdits(token.decoded, localEdits)
    const attributes = /\bxml:space=/.test(token.attributes)
      ? token.attributes
      : /^\s|\s$/.test(replaced)
        ? `${token.attributes} xml:space="preserve"`
        : token.attributes
    xmlEdits.push({
      start: token.xmlStart,
      end: token.xmlEnd,
      replacement: `<w:t${attributes}>${escapeXmlText(replaced)}</w:t>`,
    })
  }
  if (xmlEdits.length === 0) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
  return applyRangeEdits(xml, xmlEdits)
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
  drawingActions: Map<number, AnchorAction>
  textBoxActions: Map<number, AnchorAction>
  dynamics: TemplateMaterializeDynamicItemV1[]
  excludedCount: number
  retainedHighRiskCount: number
  reviewActionsV2ByCandidate: Map<string, readonly TemplateReviewActionV2[]>
} {
  if (decision.reportId !== report.reportId || decision.decisions.length !== report.candidates.length) {
    fail('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
  }
  const decisionById = new Map(decision.decisions.map((item) => [item.candidateId, item]))
  if (decisionById.size !== decision.decisions.length) fail('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
  const byAnchor = new Map<string, AnchorAction>()
  const textBoxActions = new Map<number, AnchorAction>()
  const drawingActions = new Map<number, AnchorAction>()
  const dynamicsByName = new Map<string, TemplateMaterializeDynamicItemV1>()
  const addDynamic = (
    name: string,
    kind: TemplateMaterializeDynamicItemV1['kind'],
    sourceAnchors: readonly TemplateIntakeSourceAnchorV1[],
  ) => {
    if (!FIELD_NAME_RE.test(name) || RESERVED_NAMES.has(name)) {
      fail('TEMPLATE_MATERIALIZE_DYNAMIC_NAME_INVALID')
    }
    const existing = dynamicsByName.get(name)
    if (existing) {
      if (existing.kind !== kind) fail('TEMPLATE_MATERIALIZE_DYNAMIC_NAME_INVALID')
      const anchors = new Map(existing.sourceAnchors.map((anchor) => [anchorKey(anchor), anchor]))
      for (const anchor of sourceAnchors) anchors.set(anchorKey(anchor), anchor)
      dynamicsByName.set(name, { ...existing, sourceAnchors: [...anchors.values()] })
      return
    }
    dynamicsByName.set(name, { name, kind, sourceAnchors })
  }
  const reviewActionsV2ByCandidate = new Map<string, readonly TemplateReviewActionV2[]>()
  let excludedCount = 0
  let retainedHighRiskCount = 0
  let variableIndex = 0
  let repeatIndex = 0
  let conditionalIndex = 0

  for (const candidate of report.candidates) {
    const item = decisionById.get(candidate.candidateId)
    if (!item) fail('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
    const reviewActions = decision.reviewActionsV2?.filter(
      (action) => action.targetId === candidate.candidateId,
    )
    if (reviewActions?.length) {
      reviewActionsV2ByCandidate.set(candidate.candidateId, reviewActions)
      const retained = reviewActions.some((action) => action.kind !== 'REMOVE')
      if (!retained) excludedCount += 1
      if (candidate.riskFlags.length > 0 && retained) {
        if (
          reviewActions.some(
            (action) =>
              action.kind !== 'REMOVE' &&
              (!action.highRiskOverrideReason?.trim() || action.highRiskOverrideConfirmed !== true),
          )
        ) {
          fail('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
        }
        retainedHighRiskCount += 1
      }
      for (const reviewAction of reviewActions) {
        let dynamic:
          | { name: string; kind: TemplateMaterializeDynamicItemV1['kind'] }
          | undefined
        if (reviewAction.kind === 'FIELD') {
          dynamic = { name: reviewAction.fieldName.normalize('NFKC').trim(), kind: 'VARIABLE' }
        } else if (reviewAction.kind === 'REPEAT') {
          dynamic = { name: reviewAction.blockName.normalize('NFKC').trim(), kind: 'REPEAT' }
        } else if (reviewAction.kind === 'CONDITIONAL') {
          dynamic = {
            name: reviewAction.conditionName.normalize('NFKC').trim(),
            kind: 'CONDITIONAL',
          }
        }
        if (!dynamic) continue
        addDynamic(dynamic.name, dynamic.kind, candidate.sourceAnchors)
      }

      const fullAction = reviewActions.length === 1 && !reviewActions[0].range
        ? reviewActions[0]
        : null
      const compatibilityDecision: TemplateIntakeFinalDecisionItemV1 = {
        candidateId: candidate.candidateId,
        decision: fullAction?.kind === 'REMOVE' ? 'EXCLUDE' : 'FIXED',
      }
      const compatibilityAction: AnchorAction = {
        candidate,
        decision: compatibilityDecision,
      }
      for (const anchor of candidate.sourceAnchors) {
        if (anchor.part === 'DRAWING') {
          if (!fullAction || !['KEEP', 'REMOVE', 'REPLACE_IMAGE'].includes(fullAction.kind) || !anchor.drawingIndex) {
            fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
          }
          if (drawingActions.has(anchor.drawingIndex)) fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
          drawingActions.set(anchor.drawingIndex, compatibilityAction)
        } else if (anchor.part === 'TEXT_BOX') {
          if (!fullAction || !['KEEP', 'REMOVE'].includes(fullAction.kind) || !anchor.drawingIndex) {
            fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
          }
          textBoxActions.set(anchor.drawingIndex, compatibilityAction)
        }
      }
      continue
    }
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
      addDynamic(
        name,
        item.decision as TemplateMaterializeDynamicItemV1['kind'],
        candidate.sourceAnchors,
      )
    }
    for (const anchor of candidate.sourceAnchors) {
      if (anchor.part === 'DRAWING') {
        if (item.decision !== 'FIXED' && item.decision !== 'EXCLUDE') {
          fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
        }
        if (!anchor.drawingIndex || drawingActions.has(anchor.drawingIndex)) {
          fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
        }
        drawingActions.set(anchor.drawingIndex, action)
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
  if (
    decision.reviewActionsV2?.some(
      (action) => !report.candidates.some((candidate) => candidate.candidateId === action.targetId),
    )
  ) {
    fail('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
  }
  return {
    byAnchor,
    drawingActions,
    textBoxActions,
    dynamics: [...dynamicsByName.values()],
    excludedCount,
    retainedHighRiskCount,
    reviewActionsV2ByCandidate,
  }
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
      removedByPart.set(part.name, ranges)
    }
  }
  for (const index of selected) {
    if (index <= 0 || index > globalIndex) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
  }
  return removedByPart
}

function relationshipPartName(partName: string): string {
  return posix.join(posix.dirname(partName), '_rels', `${posix.basename(partName)}.rels`)
}

function relationshipIdWithLength(xml: string, length: number, seed: number): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const suffix = (seed + attempt).toString(36)
    const candidate = length === 1
      ? String.fromCharCode(97 + (seed + attempt) % 26)
      : `x${suffix.padStart(length - 1, '0').slice(-(length - 1))}`
    if (!new RegExp(`\\bId=["']${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(xml)) {
      return candidate
    }
  }
  fail('TEMPLATE_MATERIALIZE_GENERATION_FAILED')
}

async function addReplacementImage(
  zip: JSZip,
  part: MutableXmlPart,
  blip: XmlMatch,
  imageIndex: number,
  replacement: { content: Buffer; extension: 'png' | 'jpg' | 'jpeg'; contentType: string },
): Promise<RangeEdit> {
  const relationshipId = blip.value.match(/\br:embed=["']([^"']+)["']/)?.[1]
  if (!relationshipId) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
  const relationshipsName = relationshipPartName(part.name)
  const relationshipsEntry = zip.file(relationshipsName)
  if (!relationshipsEntry) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
  let relationships = await relationshipsEntry.async('string')
  const nextRelationshipId = relationshipIdWithLength(relationships, relationshipId.length, imageIndex)
  const extension = replacement.extension === 'jpeg' ? 'jpg' : replacement.extension
  const mediaName = `word/media/xiaogui-replacement-${imageIndex}.${extension}`
  if (zip.file(mediaName)) fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
  zip.file(mediaName, replacement.content)
  const target = posix.relative(posix.dirname(part.name), mediaName)
  const relationship = `<Relationship Id="${escapeXmlAttribute(nextRelationshipId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${escapeXmlAttribute(target)}"/>`
  if (!/<\/Relationships>\s*$/.test(relationships)) fail('TEMPLATE_MATERIALIZE_GENERATION_FAILED')
  relationships = relationships.replace(/<\/Relationships>\s*$/, `${relationship}</Relationships>`)
  zip.file(relationshipsName, relationships)

  const contentTypesEntry = zip.file('[Content_Types].xml')
  if (!contentTypesEntry) fail('TEMPLATE_MATERIALIZE_GENERATION_FAILED')
  let contentTypes = await contentTypesEntry.async('string')
  const extensionPattern = new RegExp(`<Default\\b[^>]*\\bExtension=["']${extension}["']`, 'i')
  if (!extensionPattern.test(contentTypes)) {
    const declaration = `<Default Extension="${extension}" ContentType="${escapeXmlAttribute(replacement.contentType)}"/>`
    if (!/<\/Types>\s*$/.test(contentTypes)) fail('TEMPLATE_MATERIALIZE_GENERATION_FAILED')
    contentTypes = contentTypes.replace(/<\/Types>\s*$/, `${declaration}</Types>`)
    zip.file('[Content_Types].xml', contentTypes)
  }
  const replacedBlip = blip.value.replace(
    /\br:embed=(["'])[^"']+\1/,
    `r:embed="${nextRelationshipId}"`,
  )
  if (replacedBlip.length !== blip.value.length) fail('TEMPLATE_MATERIALIZE_GENERATION_FAILED')
  return {
    start: blip.index,
    end: blip.index + blip.value.length,
    replacement: replacedBlip,
  }
}

async function applyDrawingImageActions(
  zip: JSZip,
  parts: MutableXmlPart[],
  actions: ReturnType<typeof buildActions>,
  replacements: MaterializeConfirmedTemplateInputV1['replacementImages'],
  textBoxRemovals: ReadonlyMap<string, readonly RangeEdit[]>,
): Promise<Map<string, RangeEdit[]>> {
  let imageIndex = 0
  const removalsByPart = new Map<string, RangeEdit[]>(
    [...textBoxRemovals.entries()].map(([name, ranges]) => [name, [...ranges]]),
  )
  const editsByPart = new Map<string, RangeEdit[]>()
  for (const part of parts) {
    const enclosingTextBoxes = textBoxRemovals.get(part.name) ?? []
    for (const blip of collectMatches(part.xml, /<a:blip\b[^>]*\br:embed=["'][^"']+["'][^>]*\/?\s*>/g)) {
      imageIndex += 1
      const action = actions.drawingActions.get(imageIndex)
      if (!action) continue
      const reviewAction = actions.reviewActionsV2ByCandidate.get(action.candidate.candidateId)?.[0]
      const kind = reviewAction?.kind ?? (action.decision.decision === 'EXCLUDE' ? 'REMOVE' : 'KEEP')
      const containingTextBox = enclosingTextBoxes.some(
        (range) => range.start <= blip.index && range.end >= blip.index + blip.value.length,
      )
      if (containingTextBox) {
        if (kind !== 'REMOVE') fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
        continue
      }
      if (kind === 'KEEP') continue
      if (kind === 'REMOVE') {
        const enclosing = [
          findEnclosingRange(part.xml, blip.index, 'w:drawing'),
          findEnclosingRange(part.xml, blip.index, 'w:pict'),
        ]
          .filter((value): value is RangeEdit => Boolean(value))
          .sort((left, right) => left.end - left.start - (right.end - right.start))[0]
        if (!enclosing) fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
        const removals = removalsByPart.get(part.name) ?? []
        if (removals.some((range) => range.start < enclosing.end && enclosing.start < range.end)) {
          fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
        }
        removals.push(enclosing)
        removalsByPart.set(part.name, removals)
        continue
      }
      if (kind !== 'REPLACE_IMAGE' || !reviewAction || reviewAction.kind !== 'REPLACE_IMAGE') {
        fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
      }
      const replacement = replacements?.get(reviewAction.replacementImageToken)
      if (!replacement) fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
      const edits = editsByPart.get(part.name) ?? []
      edits.push(await addReplacementImage(zip, part, blip, imageIndex, replacement))
      editsByPart.set(part.name, edits)
    }
  }
  for (const index of actions.drawingActions.keys()) {
    if (index <= 0 || index > imageIndex) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
  }
  for (const part of parts) {
    const removals = removalsByPart.get(part.name) ?? []
    const replacementsForPart = (editsByPart.get(part.name) ?? []).filter(
      (edit) => !removals.some((range) => range.start <= edit.start && range.end >= edit.end),
    )
    const edits = [...removals, ...replacementsForPart]
    if (edits.length) part.xml = applyRangeEdits(part.xml, edits)
  }
  return removalsByPart
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
  hasLocalRanges: boolean,
): string[] {
  const warnings: string[] = []
  if (variableCount > 0 && !hasLocalRanges) {
    warnings.push('未拆分的待填写内容会替换整个来源段落或整个表格单元格')
  }
  if (hasLocalRanges) warnings.push('已按模型识别或人工框选范围完成局部修改，范围外内容保持不变')
  if (structuralCount > 0) warnings.push('重复块和条件块已写入 Word 内容控件；当前简单字段生成器不会展开这些结构')
  if (retainedHighRiskCount > 0) warnings.push(`有 ${retainedHighRiskCount} 项高风险内容经人工覆盖后保留，请在预览中再次核对`)
  return warnings
}

export async function materializeConfirmedTemplateV1(
  input: MaterializeConfirmedTemplateInputV1,
): Promise<MaterializeConfirmedTemplateResultV1> {
  const normalizedSourceSha256 = createHash('sha256').update(input.source).digest('hex')
  const sourceSha256 = input.originalSourceSha256 ?? normalizedSourceSha256
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
  const originalTargets = collectAnchorTargets(parts)
  const textBoxesToRemove = new Set(
    [...actions.textBoxActions.entries()]
      .filter(([, action]) => action.decision.decision === 'EXCLUDE')
      .map(([index]) => index),
  )
  const textBoxRemovals = textBoxesToRemove.size > 0
    ? removeSelectedTextBoxes(parts, textBoxesToRemove)
    : new Map<string, RangeEdit[]>()
  const drawingRemovals = await applyDrawingImageActions(
    zip,
    parts,
    actions,
    input.replacementImages,
    textBoxRemovals,
  )

  const targets = adjustTargetsAfterRemovals(originalTargets, drawingRemovals)
  const textEdits = new Map<string, RangeEdit[]>()
  const structuralActions: AnchorAction[] = []
  const claimedFullV2Targets = new Set<string>()
  const rangeEditsByTarget = new Map<string, {
    target: AnchorTarget
    claimedRanges: TemplateReviewTextRangeV2[]
    replacements: VisibleRangeReplacement[]
  }>()
  for (const [candidateId, reviewActions] of actions.reviewActionsV2ByCandidate) {
    const candidate = input.report.candidates.find((item) => item.candidateId === candidateId)
    if (!candidate) fail('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
    const logicalAnchors = candidate.sourceAnchors.filter(
      (anchor) => anchor.part !== 'DRAWING' && anchor.part !== 'TEXT_BOX',
    )
    if (logicalAnchors.length === 0) continue
    const hasRanges = Boolean(candidate.textRange) || reviewActions.some((action) => Boolean(action.range))
    if (hasRanges && logicalAnchors.length !== 1) {
      fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
    }
    const candidateTargets = logicalAnchors.map((anchor) => {
      const key = anchorKey(anchor)
      const target = targets.get(key)
      if (!target) {
        throw new TemplateMaterializerErrorV1(
          'TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND',
          `${candidate.candidateId}:${key}`,
        )
      }
      return target
    })

    if (hasRanges) {
      const target = candidateTargets[0]
      const part = parts.find((item) => item.name === target.partName)
      if (!part) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
      const key = anchorKey(logicalAnchors[0])
      if (claimedFullV2Targets.has(key)) fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
      const current = part.xml.slice(target.start, target.end)
      const currentText = visibleText(current)
      if (
        candidate.textRange &&
        (
          candidate.textRange.endUtf16Exclusive > currentText.length ||
          currentText.slice(candidate.textRange.startUtf16, candidate.textRange.endUtf16Exclusive) !== candidate.preview
        )
      ) {
        fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
      }
      const group = rangeEditsByTarget.get(key) ?? {
        target,
        claimedRanges: [],
        replacements: [],
      }
      for (const action of reviewActions) {
        const localRange = action.range ?? (
          candidate.textRange
            ? { startUtf16: 0, endUtf16Exclusive: candidate.preview.length }
            : undefined
        )
        if (!localRange) fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
        if (
          localRange.startUtf16 < 0 ||
          localRange.endUtf16Exclusive <= localRange.startUtf16 ||
          (candidate.textRange && localRange.endUtf16Exclusive > candidate.preview.length)
        ) {
          fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
        }
        const effectiveRange = candidate.textRange
          ? {
              startUtf16: candidate.textRange.startUtf16 + localRange.startUtf16,
              endUtf16Exclusive: candidate.textRange.startUtf16 + localRange.endUtf16Exclusive,
            }
          : localRange
        if (
          effectiveRange.endUtf16Exclusive > currentText.length ||
          group.claimedRanges.some(
            (range) =>
              effectiveRange.startUtf16 < range.endUtf16Exclusive &&
              range.startUtf16 < effectiveRange.endUtf16Exclusive,
          )
        ) {
          fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
        }
        group.claimedRanges.push(effectiveRange)
        if (action.kind === 'KEEP') continue
        switch (action.kind) {
          case 'REMOVE':
            group.replacements.push({ ...effectiveRange, replacement: '' })
            break
          case 'REPLACE_TEXT':
            group.replacements.push({ ...effectiveRange, replacement: action.replacementText })
            break
          case 'FIELD':
            group.replacements.push({ ...effectiveRange, replacement: `{{${action.fieldName.normalize('NFKC').trim()}}}` })
            break
          case 'REPLACE_IMAGE':
          case 'REPEAT':
          case 'CONDITIONAL':
            fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
        }
      }
      rangeEditsByTarget.set(key, group)
      continue
    }

    for (const anchor of logicalAnchors) {
      const key = anchorKey(anchor)
      if (claimedFullV2Targets.has(key) || rangeEditsByTarget.has(key)) {
        fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
      }
      claimedFullV2Targets.add(key)
    }
    if (reviewActions.length !== 1) fail('TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT')
    const reviewAction = reviewActions[0]
    switch (reviewAction.kind) {
      case 'KEEP':
        break
      case 'REMOVE':
        for (const target of candidateTargets) {
          const part = parts.find((item) => item.name === target.partName)
          if (!part) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
          const edits = textEdits.get(target.partName) ?? []
          edits.push({
            start: target.start,
            end: target.end,
            replacement: clearTargetContent(part.xml.slice(target.start, target.end), target.kind),
          })
          textEdits.set(target.partName, edits)
        }
        break
      case 'REPLACE_TEXT':
      case 'FIELD': {
        const replacement = reviewAction.kind === 'REPLACE_TEXT'
          ? reviewAction.replacementText
          : `{{${reviewAction.fieldName.normalize('NFKC').trim()}}}`
        for (const target of candidateTargets) {
          const part = parts.find((item) => item.name === target.partName)
          if (!part) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
          const edits = textEdits.get(target.partName) ?? []
          edits.push({
            start: target.start,
            end: target.end,
            replacement: replaceVisibleText(part.xml.slice(target.start, target.end), replacement),
          })
          textEdits.set(target.partName, edits)
        }
        break
      }
      case 'REPEAT':
      case 'CONDITIONAL': {
        const name = reviewAction.kind === 'REPEAT'
          ? reviewAction.blockName.normalize('NFKC').trim()
          : reviewAction.conditionName.normalize('NFKC').trim()
        structuralActions.push({
          candidate,
          name,
          decision: {
            candidateId,
            decision: reviewAction.kind,
            fieldName: name,
          },
        })
        break
      }
      case 'REPLACE_IMAGE':
        fail('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
    }
  }
  for (const { target, replacements } of rangeEditsByTarget.values()) {
    if (replacements.length === 0) continue
    const part = parts.find((item) => item.name === target.partName)
    if (!part) fail('TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND')
    const current = part.xml.slice(target.start, target.end)
    const edits = textEdits.get(target.partName) ?? []
    edits.push({
      start: target.start,
      end: target.end,
      replacement: replaceVisibleTextRanges(current, replacements),
    })
    textEdits.set(target.partName, edits)
  }
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
  if (removedMediaCount > originalMediaNames.length) fail('TEMPLATE_MATERIALIZE_GENERATION_FAILED')

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
      byteLength: input.report.file.byteLength,
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
      Boolean(
        input.decision.reviewActionsV2?.some((action) => action.range) ||
        input.report.candidates.some((candidate) => candidate.textRange),
      ),
    ),
    requiresSecondConfirmation: true,
    originalSourceUnchanged: true,
    advancedGenerationRequired: repeatBlocks.length + conditionalBlocks.length > 0,
  }
  return { content, decisionSha256, plan }
}
