import { createHash } from 'node:crypto'

import Docxtemplater from 'docxtemplater'
import PizZip from 'pizzip'

import type {
  AdvancedGenerationErrorCodeV1,
  AdvancedGenerationPlanV1,
  AdvancedTemplateDataV1,
  AdvancedTemplateRepeatBlockV1,
  AdvancedTemplateSchemaV1,
  AdvancedTemplateSlotV1,
} from '@shared/xiaogui-work-docx-advanced-generation'
import { ADVANCED_GENERATION_VERSION_V1 } from '@shared/xiaogui-work-docx-advanced-generation'

import { inspectSafeDocxArchiveV1 } from './docx-safety'

const FIXED_ZIP_DATE = new Date('2000-01-01T00:00:00.000Z')
const FIELD_NAME_RE = /^[\p{L}][\p{L}\p{N}_.-]{0,63}$/u
const CUSTOM_TAG_RE = /^xiaogui\.(repeat|conditional):([\p{L}][\p{L}\p{N}_.-]{0,63})$/u
const XML_PART_RE = /^word\/(?:document|header[^/]*|footer[^/]*)\.xml$/i
const MAX_VARIABLES = 200
const MAX_BLOCKS = 50
const MAX_SLOTS_PER_BLOCK = 50
const MAX_RECORDS_PER_BLOCK = 500
const MAX_DATA_BYTES = 2 * 1024 * 1024
const MAX_VALUE_CHARS = 20_000

type ControlKind = 'repeat' | 'conditional'
type ControlRange = { start: number; end: number }
type AdaptedPart = { xml: string; repeats: AdvancedTemplateRepeatBlockV1[]; conditions: { name: string; preview: string }[] }

export class AdvancedGenerationRendererErrorV1 extends Error {
  constructor(readonly code: AdvancedGenerationErrorCodeV1, message: string = code) {
    super(message)
  }
}

function fail(code: AdvancedGenerationErrorCodeV1, message?: string): never {
  throw new AdvancedGenerationRendererErrorV1(code, message)
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function visibleText(xml: string): string {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXml(match[1]))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function findControlRanges(xml: string): ControlRange[] {
  const token = /<(\/?)w:sdt\b[^>]*>/g
  const stack: number[] = []
  const ranges: ControlRange[] = []
  for (const match of xml.matchAll(token)) {
    const index = match.index ?? 0
    if (match[1]) {
      const start = stack.pop()
      if (start === undefined) fail('ADVANCED_GENERATION_STRUCTURE_INVALID')
      ranges.push({ start, end: index + match[0].length })
    } else if (!/\/\s*>$/.test(match[0])) {
      stack.push(index)
    }
  }
  if (stack.length > 0) fail('ADVANCED_GENERATION_STRUCTURE_INVALID')
  return ranges
}

function customTag(fragment: string): { kind: ControlKind; name: string } | null {
  const properties = fragment.slice(0, fragment.indexOf('<w:sdtContent'))
  const value = properties.match(/<w:tag\b[^>]*\bw:val=(?:"([^"]*)"|'([^']*)')[^>]*\/?\s*>/)?.slice(1).find(Boolean)
  if (!value?.startsWith('xiaogui.')) return null
  const parsed = CUSTOM_TAG_RE.exec(decodeXml(value))
  if (!parsed) fail('ADVANCED_GENERATION_STRUCTURE_INVALID')
  return { kind: parsed[1] as ControlKind, name: parsed[2] }
}

function controlContent(fragment: string): string {
  const match = /<w:sdtContent\b[^>]*>([\s\S]*)<\/w:sdtContent>/.exec(fragment)
  if (!match) fail('ADVANCED_GENERATION_STRUCTURE_INVALID')
  return match[1]
}

function assertSupportedControl(fragment: string, kind: ControlKind): void {
  if ((fragment.match(/<w:sdt\b/g) ?? []).length !== 1) fail('ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED')
  if (/<w:(?:drawing|pict|object|fldSimple|instrText|bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd|footnoteReference|endnoteReference)\b/i.test(fragment)) {
    fail('ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED')
  }
  if (/<w:(?:vMerge|gridSpan)\b/i.test(fragment)) fail('ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED')
  const content = controlContent(fragment)
  if (kind === 'repeat' && /^\s*<w:tc\b/i.test(content)) fail('ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED')
}

function replaceUnitText(xml: string, value: string): string {
  let replaced = false
  const result = xml.replace(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g, (_all, attributes) => {
    const text = replaced ? '' : value
    replaced = true
    return `<w:t${attributes}>${text}</w:t>`
  })
  if (!replaced) fail('ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED')
  return result
}

function internalBlockName(kind: ControlKind, name: string): string {
  return `__xiaogui_${kind}_${sha256(name).slice(0, 16)}`
}

function repeatContent(content: string, internalName: string): { xml: string; slots: AdvancedTemplateSlotV1[] } {
  const tableShape = /<w:tr\b/i.test(content)
  const unitPattern = tableShape ? /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g : /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  const units = [...content.matchAll(unitPattern)].filter((match) => visibleText(match[0]).length > 0)
  if (units.length === 0 || units.length > MAX_SLOTS_PER_BLOCK) fail('ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED')
  let xml = content
  const slots = units.map((unit, index) => ({
    slotId: `s${index + 1}`,
    sourceKind: tableShape ? ('TABLE_CELL' as const) : ('PARAGRAPH' as const),
    ordinal: index + 1,
    preview: visibleText(unit[0]).slice(0, 120),
  }))
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]
    const start = unit.index ?? 0
    const prefix = index === 0 ? `{{-w:sdt ${internalName}}}` : ''
    const suffix = index === units.length - 1 ? `{{/${internalName}}}` : ''
    const replacement = replaceUnitText(unit[0], `${prefix}{{${slots[index].slotId}}}${suffix}`)
    xml = xml.slice(0, start) + replacement + xml.slice(start + unit[0].length)
  }
  return { xml, slots }
}

function conditionalContent(content: string, internalName: string): string {
  const runs = [...content.matchAll(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g)]
  if (runs.length === 0) fail('ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED')
  let xml = content
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]
    const start = run.index ?? 0
    const parts = /^(<w:t\b[^>]*>)([\s\S]*)(<\/w:t>)$/.exec(run[0])
    if (!parts) fail('ADVANCED_GENERATION_STRUCTURE_INVALID')
    const prefix = index === 0 ? `{{-w:sdt ${internalName}}}` : ''
    const suffix = index === runs.length - 1 ? `{{/${internalName}}}` : ''
    const replacement = `${parts[1]}${prefix}${parts[2]}${suffix}${parts[3]}`
    xml = xml.slice(0, start) + replacement + xml.slice(start + run[0].length)
  }
  return xml
}

function adaptPart(source: string): AdaptedPart {
  const ranges = findControlRanges(source).sort((left, right) => right.start - left.start)
  const repeats: AdvancedTemplateRepeatBlockV1[] = []
  const conditions: { name: string; preview: string }[] = []
  let xml = source
  for (const range of ranges) {
    const fragment = source.slice(range.start, range.end)
    const tag = customTag(fragment)
    if (tag) assertSupportedControl(fragment, tag.kind)
  }
  for (const range of ranges) {
    const fragment = xml.slice(range.start, range.end)
    const tag = customTag(fragment)
    if (!tag) continue
    assertSupportedControl(fragment, tag.kind)
    const content = controlContent(fragment)
    const internalName = internalBlockName(tag.kind, tag.name)
    let adapted: string
    if (tag.kind === 'repeat') {
      const result = repeatContent(content, internalName)
      adapted = result.xml
      repeats.push({ name: tag.name, slots: result.slots })
    } else {
      adapted = conditionalContent(content, internalName)
      conditions.push({ name: tag.name, preview: visibleText(content).slice(0, 120) })
    }
    const replacement = fragment.replace(content, adapted)
    xml = xml.slice(0, range.start) + replacement + xml.slice(range.end)
  }
  return { xml, repeats, conditions }
}

function unwrapCustomControls(xml: string): string {
  let output = xml
  const ranges = findControlRanges(output).sort((left, right) => right.start - left.start)
  for (const range of ranges) {
    const fragment = output.slice(range.start, range.end)
    if (!customTag(fragment)) continue
    const content = controlContent(fragment)
    output = output.slice(0, range.start) + content + output.slice(range.end)
  }
  return output
}

function withoutRepeatControls(xml: string): string {
  let output = xml
  const ranges = findControlRanges(xml).sort((left, right) => right.start - left.start)
  for (const range of ranges) {
    const fragment = output.slice(range.start, range.end)
    if (customTag(fragment)?.kind !== 'repeat') continue
    output = output.slice(0, range.start) + output.slice(range.end)
  }
  return output
}

function assertUniqueNames(schema: AdvancedTemplateSchemaV1): void {
  const names = [...schema.variables, ...schema.repeatBlocks.map((item) => item.name), ...schema.conditionalBlocks.map((item) => item.name)]
  if (names.some((name) => !FIELD_NAME_RE.test(name)) || new Set(names).size !== names.length) {
    fail('ADVANCED_GENERATION_STRUCTURE_INVALID')
  }
}

async function inspectTemplate(content: Buffer, displayName: string): Promise<{ schema: AdvancedTemplateSchemaV1; adapted: Map<string, string> }> {
  const { zip: safeZip } = await inspectSafeDocxArchiveV1(content)
  const partNames = Object.keys(safeZip.files).filter((name) => XML_PART_RE.test(name)).sort()
  const adapted = new Map<string, string>()
  const repeats: AdvancedTemplateRepeatBlockV1[] = []
  const conditions: { name: string; preview: string }[] = []
  const variables = new Set<string>()
  for (const name of partNames) {
    const xml = await safeZip.file(name)!.async('string')
    for (const match of withoutRepeatControls(xml).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      const field = decodeXml(match[1]).trim()
      if (!FIELD_NAME_RE.test(field)) fail('ADVANCED_GENERATION_STRUCTURE_INVALID')
      variables.add(field)
    }
    const part = adaptPart(xml)
    repeats.push(...part.repeats)
    conditions.push(...part.conditions)
    adapted.set(name, part.xml)
  }
  if (variables.size > MAX_VARIABLES || repeats.length + conditions.length > MAX_BLOCKS) {
    fail('ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED')
  }
  const schema: AdvancedTemplateSchemaV1 = {
    schemaVersion: ADVANCED_GENERATION_VERSION_V1,
    template: { displayName, sha256: sha256(content), byteLength: content.byteLength },
    variables: [...variables].sort((left, right) => left.localeCompare(right, 'zh-CN')),
    repeatBlocks: repeats,
    conditionalBlocks: conditions,
    warnings: ['重复块按来源段落或表格单元格逐槽填写；不会猜测段内字段', '条件块只接受明确保留或删除，不执行表达式或脚本'],
    requiresCompleteData: true,
    originalTemplateReadOnly: true,
  }
  assertUniqueNames(schema)
  if (repeats.length + conditions.length === 0) fail('ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED')
  return { schema, adapted }
}

export async function analyzeAdvancedTemplateV1(content: Buffer, displayName: string): Promise<AdvancedTemplateSchemaV1> {
  return (await inspectTemplate(content, displayName)).schema
}

function renderData(schema: AdvancedTemplateSchemaV1, data: AdvancedTemplateDataV1): { values: Record<string, unknown>; normalized: AdvancedTemplateDataV1; repeatRecordCount: number; retainedConditionalCount: number } {
  if (data.dataVersion !== ADVANCED_GENERATION_VERSION_V1 || Buffer.byteLength(JSON.stringify(data)) > MAX_DATA_BYTES) fail('ADVANCED_GENERATION_DATA_INVALID')
  const values: Record<string, unknown> = {}
  const variableByName = new Map(data.variables.map((item) => [item.name, item]))
  const repeatByName = new Map(data.repeatBlocks.map((item) => [item.name, item]))
  const conditionByName = new Map(data.conditionalBlocks.map((item) => [item.name, item]))
  if (variableByName.size !== data.variables.length || repeatByName.size !== data.repeatBlocks.length || conditionByName.size !== data.conditionalBlocks.length) fail('ADVANCED_GENERATION_DATA_INVALID')
  if (variableByName.size !== schema.variables.length || repeatByName.size !== schema.repeatBlocks.length || conditionByName.size !== schema.conditionalBlocks.length) fail('ADVANCED_GENERATION_INPUT_REQUIRED')
  const cleanValue = (value: unknown): string | number | boolean => {
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'string' && value.length > MAX_VALUE_CHARS) || (typeof value === 'number' && !Number.isFinite(value))) fail('ADVANCED_GENERATION_DATA_INVALID')
    return value as string | number | boolean
  }
  for (const name of schema.variables) {
    const item = variableByName.get(name)
    if (!item || item.status !== 'RESOLVED' || item.value === undefined) fail('ADVANCED_GENERATION_INPUT_REQUIRED')
    values[name] = cleanValue(item.value)
  }
  let repeatRecordCount = 0
  for (const block of schema.repeatBlocks) {
    const item = repeatByName.get(block.name)
    if (!item || item.status !== 'RESOLVED' || !item.records || item.records.length > MAX_RECORDS_PER_BLOCK) fail('ADVANCED_GENERATION_INPUT_REQUIRED')
    repeatRecordCount += item.records.length
    values[internalBlockName('repeat', block.name)] = item.records.map((record) => {
      const slotById = new Map(record.slots.map((slot) => [slot.slotId, slot]))
      if (slotById.size !== record.slots.length || slotById.size !== block.slots.length) fail('ADVANCED_GENERATION_INPUT_REQUIRED')
      return Object.fromEntries(block.slots.map((slot) => {
        const value = slotById.get(slot.slotId)?.value
        if (value === undefined) fail('ADVANCED_GENERATION_INPUT_REQUIRED')
        return [slot.slotId, cleanValue(value)]
      }))
    })
  }
  let retainedConditionalCount = 0
  for (const block of schema.conditionalBlocks) {
    const item = conditionByName.get(block.name)
    if (!item || item.status !== 'RESOLVED' || typeof item.value !== 'boolean') fail('ADVANCED_GENERATION_INPUT_REQUIRED')
    values[internalBlockName('conditional', block.name)] = item.value
    if (item.value) retainedConditionalCount += 1
  }
  return { values, normalized: data, repeatRecordCount, retainedConditionalCount }
}

export async function renderAdvancedTemplateV1(input: { template: Buffer; displayName: string; data: AdvancedTemplateDataV1 }): Promise<{ content: Buffer; plan: AdvancedGenerationPlanV1 }> {
  const inspected = await inspectTemplate(input.template, input.displayName)
  const prepared = renderData(inspected.schema, input.data)
  const zip = new PizZip(input.template)
  for (const [name, xml] of inspected.adapted) zip.file(name, xml, { date: FIXED_ZIP_DATE })
  let rendered: Buffer
  try {
    const document = new Docxtemplater(zip, { delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true, errorLogging: false })
    document.render(prepared.values)
    rendered = document.toBuffer()
  } catch {
    fail('ADVANCED_GENERATION_RENDER_FAILED')
  }
  const { zip: normalizedZip } = await inspectSafeDocxArchiveV1(rendered)
  for (const name of Object.keys(normalizedZip.files).filter((item) => XML_PART_RE.test(item))) {
    const file = normalizedZip.file(name)
    if (!file) continue
    const xml = unwrapCustomControls(await file.async('string'))
    if (/xiaogui\.(?:repeat|conditional):|\{\{[^{}]+\}\}/.test(xml)) fail('ADVANCED_GENERATION_RENDER_FAILED')
    normalizedZip.file(name, xml)
  }
  for (const entry of Object.values(normalizedZip.files)) entry.date = FIXED_ZIP_DATE
  const content = (await normalizedZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })) as Buffer
  await inspectSafeDocxArchiveV1(content)
  const dataSha256 = sha256(JSON.stringify(prepared.normalized))
  return {
    content,
    plan: {
      planVersion: ADVANCED_GENERATION_VERSION_V1,
      schema: inspected.schema,
      dataSha256,
      previewSha256: sha256(content),
      repeatRecordCount: prepared.repeatRecordCount,
      retainedConditionalCount: prepared.retainedConditionalCount,
      requiresSecondConfirmation: true,
      originalTemplateUnchanged: true,
    },
  }
}
