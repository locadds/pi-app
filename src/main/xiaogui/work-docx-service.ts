import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

import { PatchType, TextRun, patchDetector, patchDocument } from 'docx'
import JSZip from 'jszip'

import type {
  WorkDocxCancelRequestV1,
  WorkDocxCancelledResultV1,
  WorkDocxCapabilityV1,
  WorkDocxConfirmRequestV1,
  WorkDocxDiscoverResultV1,
  WorkDocxErrorCodeV1,
  WorkDocxOperationIdV1,
  WorkDocxOutcomeV1,
  WorkDocxOutputAccessRequestV1,
  WorkDocxOutputAccessResultV1,
  WorkDocxPrepareRequestV1,
  WorkDocxPrepareResultV1,
  WorkDocxPublishedResultV1,
} from '@shared/xiaogui-work-docx'
import type {
  WorkDocxTemplateFieldInputV1,
  WorkDocxTemplateFieldLocationV1,
  WorkDocxTemplateFieldV1,
  WorkDocxTemplateProfileV1,
} from '@shared/xiaogui-work-docx-template-data'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import type {
  TemplateLibraryDetailV1,
  TemplateLibraryFieldSummaryV1,
} from '@shared/xiaogui-template-library'
import {
  DOCX_SAFETY_MAX_FILE_BYTES_V1,
  DocxSafetyErrorV1,
  inspectSafeDocxArchiveV1,
} from './docx-safety'
import type { TemplateLibraryServiceV1 } from './template-library-service'

const MAX_TEMPLATE_BYTES = DOCX_SAFETY_MAX_FILE_BYTES_V1
const MAX_PAYLOAD_BYTES = 1024 * 1024
const MAX_PLACEHOLDERS = 200
const MAX_VALUE_CHARS = 20_000
const MAX_DISPLAY_NAME_CHARS = 160
const MAX_SOURCE_SUMMARY_CHARS = 500
const PLACEHOLDER_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const TEMPLATE_FIELD_KEY = /^[\p{L}][\p{L}\p{N}_.-]{0,63}$/u
const UNSAFE_DISPLAY_NAME = /[\/\\\u0000-\u001f\u007f-\u009f]/

type WorkDocxDialogPortV1 = {
  chooseTemplate(): Promise<string | null>
  choosePayload(): Promise<string | null>
  chooseNewTarget(): Promise<string | null>
}

type WorkDocxOutputAccessPortV1 = {
  openPath(path: string): Promise<string>
  revealPath(path: string): Promise<void>
}

type WorkDocxServiceOptionsV1 = {
  lookup: SessionScopeLookupV1
  dialogs: WorkDocxDialogPortV1
  tempRoot: string
  outputAccess?: WorkDocxOutputAccessPortV1
  templateLibrary?: Pick<TemplateLibraryServiceV1, 'list' | 'getDetail' | 'resolveVersionForUse'>
}

type PreparedOperationV1 = {
  inputKind: 'LEGACY_JSON' | 'TEMPLATE_DATA'
  addressKey: string
  operationId: WorkDocxOperationIdV1
  stageDir: string
  sourceTemplate: string
  sourcePayload?: string
  stagedTemplate: string
  stagedPayload?: string
  target: string
  placeholders: readonly string[]
  payload: Readonly<Record<string, string>>
  templateSha256: string
  payloadSha256?: string
  dataSha256?: string
  templateVersionId?: string
  fieldIds?: readonly string[]
}

export type WorkDocxTemplateSelectionIdV1 = string & {
  readonly __brand: 'WorkDocxTemplateSelectionIdV1'
}

type WorkDocxTemplateSelectRequestV1 = {
  address: SessionAddressV1
  /** 仅由可信模板选择器回传；模型不生成此编号。 */
  templateVersionId?: string
}
type WorkDocxTemplateSelectResultV1 =
  | { kind: 'CANCELLED' }
  | {
      kind: 'TEMPLATE_PREPARATION_REQUIRED'
      templateDisplayName: string
      templateSha256: string
      profile: WorkDocxTemplateProfileV1
    }
  | {
      kind: 'TEMPLATE_SELECTED'
      selectionId: WorkDocxTemplateSelectionIdV1
      templateDisplayName: string
      templateSha256: string
      templateVersionId?: string
      fields: readonly WorkDocxTemplateFieldV1[]
      profile: WorkDocxTemplateProfileV1
    }

type WorkDocxTemplateDataPrepareRequestV1 = {
  address: SessionAddressV1
  selectionId: WorkDocxTemplateSelectionIdV1
  fields: readonly WorkDocxTemplateFieldInputV1[]
}
type WorkDocxTemplateDataPrepareResultV1 =
  | {
      kind: 'INPUT_REQUIRED'
      unresolvedFields: readonly string[]
      unresolvedFieldIds: readonly string[]
    }
  | { kind: 'CANCELLED' }
  | {
      kind: 'PREPARED'
      operationId: WorkDocxOperationIdV1
      templateDisplayName: string
      fields: readonly string[]
      fieldIds: readonly string[]
      templateSha256: string
      dataSha256: string
      templateVersionId?: string
    }
type WorkDocxTemplateSelectionCancelRequestV1 = {
  address: SessionAddressV1
  selectionId: WorkDocxTemplateSelectionIdV1
}
type WorkDocxTemplateSelectionCancelledResultV1 = { kind: 'CANCELLED' }
type WorkDocxTemplateDataPublishedResultV1 = {
  kind: 'PUBLISHED'
  operationId: WorkDocxOperationIdV1
  outputSha256: string
  templateSha256: string
  dataSha256: string
  templateVersionId?: string
  originalInputsUnchanged: true
}

type SelectedTemplateV1 = {
  addressKey: string
  selectionId: WorkDocxTemplateSelectionIdV1
  stageDir: string
  sourceTemplate: string
  stagedTemplate: string
  templateDisplayName: string
  templateSha256: string
  templateVersionId?: string
  fields: readonly WorkDocxTemplateFieldV1[]
  profile: WorkDocxTemplateProfileV1
}

export type WorkDocxTemplateIntakeHandoffV1 = {
  sourcePath: string
  templateDisplayName: string
  templateSha256: string
  byteLength: number
  profile: WorkDocxTemplateProfileV1
}

type CompletedOperationV1 = {
  addressKey: string
  target: string
  inputKind: PreparedOperationV1['inputKind']
  operationId: WorkDocxOperationIdV1
  outputSha256: string
  templateSha256: string
  inputSha256: string
  templateVersionId?: string
}

type InternalPublishedResultV1 = Omit<CompletedOperationV1, 'addressKey' | 'target'> & {
  originalInputsUnchanged: true
}

class WorkDocxError extends Error {
  constructor(readonly code: WorkDocxErrorCodeV1) {
    super(code)
  }
}

const CAPABILITY: WorkDocxCapabilityV1 = {
  id: 'docx-template-patch',
  version: '9.7.1',
  status: 'AVAILABLE',
  intents: ['PREPARE', 'CONFIRM', 'CANCEL'],
}

function failure<T>(code: WorkDocxErrorCodeV1): WorkDocxOutcomeV1<T> {
  return { ok: false, error: { code, messageKey: `xiaogui.work.docx.${code.toLowerCase()}` } }
}

function addressKey(address: SessionAddressV1): string {
  return `${address.projectId}\0${address.sessionKey}`
}

function safeDisplayName(path: string): string {
  const name = basename(path)
  if (name.length === 0 || name.length > MAX_DISPLAY_NAME_CHARS || UNSAFE_DISPLAY_NAME.test(name)) {
    throw new WorkDocxError('INPUT_INVALID')
  }
  return name
}

async function sha256(path: string): Promise<string> {
  const content = await readFile(path)
  return createHash('sha256').update(content).digest('hex')
}

async function readLimited(path: string, limit: number): Promise<Buffer> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new WorkDocxError('INPUT_INVALID')
  if (info.size > limit) throw new WorkDocxError('INPUT_TOO_LARGE')
  return readFile(path)
}

async function assertSafeDocx(content: Buffer): Promise<void> {
  try {
    await inspectSafeDocxArchiveV1(content)
  } catch (error) {
    if (error instanceof DocxSafetyErrorV1) {
      throw new WorkDocxError(error.code === 'INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' : 'UNSAFE_DOCX')
    }
    throw error
  }
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

function visibleXmlText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function literalOccurrences(text: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1
    offset += needle.length
  }
  return count
}

async function inspectTemplate(
  content: Buffer,
  placeholders: readonly string[],
  templateSha256: string,
): Promise<{ fields: readonly WorkDocxTemplateFieldV1[]; profile: WorkDocxTemplateProfileV1 }> {
  const zip = await JSZip.loadAsync(content, { checkCRC32: true, createFolders: false })
  const documentXml = await zip.file('word/document.xml')!.async('string')
  const headerNames = Object.keys(zip.files)
    .filter((name) => /^word\/header[^/]*\.xml$/i.test(name))
    .sort()
  const footerNames = Object.keys(zip.files)
    .filter((name) => /^word\/footer[^/]*\.xml$/i.test(name))
    .sort()
  const headers = await Promise.all(headerNames.map(async (name) => zip.file(name)!.async('string')))
  const footers = await Promise.all(footerNames.map(async (name) => zip.file(name)!.async('string')))
  const allWordXml = [documentXml, ...headers, ...footers]
  const bodyText = visibleXmlText(documentXml)
  const headerTexts = headers.map(visibleXmlText)
  const footerTexts = footers.map(visibleXmlText)

  const fields = placeholders.map((name) => {
    const token = `{{${name}}}`
    const bodyOccurrences = literalOccurrences(bodyText, token)
    const headerOccurrences = headerTexts.reduce(
      (total, text) => total + literalOccurrences(text, token),
      0,
    )
    const footerOccurrences = footerTexts.reduce(
      (total, text) => total + literalOccurrences(text, token),
      0,
    )
    const occurrences = bodyOccurrences + headerOccurrences + footerOccurrences
    const locations: WorkDocxTemplateFieldLocationV1[] = []
    if (bodyOccurrences > 0) locations.push('正文')
    if (headerOccurrences > 0) locations.push('页眉')
    if (footerOccurrences > 0) locations.push('页脚')
    if (locations.length === 0) locations.push('未知')
    return {
      fieldId: stableTemplateFieldId(templateSha256, name),
      name,
      required: true,
      occurrences: Math.max(1, occurrences),
      locations,
    }
  })

  return {
    fields,
    profile: {
      bodyPartCount: 1,
      sectionCount: Math.max(1, countMatches(documentXml, /<w:sectPr\b/g)),
      headerPartCount: headerNames.length,
      footerPartCount: footerNames.length,
      inlineDrawingCount: allWordXml.reduce(
        (total, xml) => total + countMatches(xml, /<wp:inline\b/g),
        0,
      ),
      floatingDrawingCount: allWordXml.reduce(
        (total, xml) => total + countMatches(xml, /<wp:anchor\b/g),
        0,
      ),
      mediaCount: Object.keys(zip.files).filter(
        (name) => /^word\/media\/[^/]+$/i.test(name) && !zip.files[name].dir,
      ).length,
      fieldCount: allWordXml.reduce(
        (total, xml) =>
          total +
          countMatches(xml, /<w:fldSimple\b/g) +
          countMatches(xml, /<w:fldChar\b[^>]*w:fldCharType=["']begin["']/g),
        0,
      ),
    },
  }
}

function stableTemplateFieldId(templateSha256: string, name: string): string {
  return `xgfield1_${createHash('sha256')
    .update(`${templateSha256}\0${name.normalize('NFKC')}`)
    .digest('hex')
    .slice(0, 32)}`
}

function reconcileLibraryFields(
  inspected: readonly WorkDocxTemplateFieldV1[],
  libraryFields: readonly TemplateLibraryFieldSummaryV1[] | undefined,
): readonly WorkDocxTemplateFieldV1[] {
  if (!libraryFields?.length) return inspected
  const byName = new Map(
    libraryFields.map((field) => [field.name.normalize('NFKC').trim(), field]),
  )
  return inspected.map((field) => {
    const libraryField = byName.get(field.name.normalize('NFKC').trim())
    return libraryField
      ? { ...field, fieldId: libraryField.fieldId, required: libraryField.required }
      : field
  })
}

function normalizePayload(value: unknown, placeholders: readonly string[]): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkDocxError('INPUT_INVALID')
  const source = value as Record<string, unknown>
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>

  for (const placeholder of placeholders) {
    if (!PLACEHOLDER_KEY.test(placeholder) || ['__proto__', 'constructor', 'prototype'].includes(placeholder)) {
      throw new WorkDocxError('INPUT_INVALID')
    }
    if (!Object.prototype.hasOwnProperty.call(source, placeholder)) throw new WorkDocxError('PLACEHOLDER_MISSING')
    const raw = source[placeholder]
    if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new WorkDocxError('INPUT_INVALID')
    const text = String(raw)
    if (text.length > MAX_VALUE_CHARS) throw new WorkDocxError('INPUT_TOO_LARGE')
    normalized[placeholder] = text
  }
  return normalized
}

function normalizeTemplateData(
  fields: WorkDocxTemplateDataPrepareRequestV1['fields'],
  expectedFields: readonly WorkDocxTemplateFieldV1[],
):
  | {
      kind: 'INPUT_REQUIRED'
      unresolvedFields: readonly string[]
      unresolvedFieldIds: readonly string[]
    }
  | { kind: 'READY'; payload: Readonly<Record<string, string>>; dataSha256: string } {
  if (!Array.isArray(fields) || fields.length > expectedFields.length || fields.length > MAX_PLACEHOLDERS) {
    throw new WorkDocxError('PLACEHOLDER_MISSING')
  }
  const expected = new Map(expectedFields.map((field) => [field.fieldId, field]))
  const seen = new Set<string>()
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>
  const canonical: { fieldId: string; name: string; value: string | number | boolean }[] = []
  const unresolved: WorkDocxTemplateFieldV1[] = []

  for (const field of fields) {
    const expectedField = field && typeof field === 'object' ? expected.get(field.fieldId) : undefined
    if (
      !field ||
      typeof field !== 'object' ||
      !expectedField ||
      typeof field.fieldId !== 'string' ||
      !TEMPLATE_FIELD_KEY.test(field.name) ||
      ['__proto__', 'constructor', 'prototype'].includes(field.name) ||
      field.name.normalize('NFKC').trim() !== expectedField.name.normalize('NFKC').trim() ||
      seen.has(field.fieldId) ||
      (field.sourceSummary !== undefined &&
        (typeof field.sourceSummary !== 'string' || field.sourceSummary.length > MAX_SOURCE_SUMMARY_CHARS))
    ) {
      throw new WorkDocxError('INPUT_INVALID')
    }
    seen.add(field.fieldId)
    if (field.status === 'UNRESOLVED') {
      if (expectedField.required) unresolved.push(expectedField)
      else {
        normalized[expectedField.name] = ''
        canonical.push({ fieldId: expectedField.fieldId, name: expectedField.name, value: '' })
      }
      continue
    }
    if (
      field.status !== 'READY' ||
      !['string', 'number', 'boolean'].includes(typeof field.value) ||
      (typeof field.value === 'number' && !Number.isFinite(field.value))
    ) {
      throw new WorkDocxError('INPUT_INVALID')
    }
    const text = String(field.value)
    if (text.length > MAX_VALUE_CHARS) throw new WorkDocxError('INPUT_TOO_LARGE')
    normalized[expectedField.name] = text
    canonical.push({ fieldId: expectedField.fieldId, name: expectedField.name, value: field.value })
  }
  for (const expectedField of expectedFields) {
    if (seen.has(expectedField.fieldId)) continue
    if (expectedField.required) unresolved.push(expectedField)
    else {
      normalized[expectedField.name] = ''
      canonical.push({ fieldId: expectedField.fieldId, name: expectedField.name, value: '' })
    }
  }
  if (unresolved.length > 0) {
    const ordered = [...unresolved].sort((left, right) => left.name.localeCompare(right.name))
    return {
      kind: 'INPUT_REQUIRED',
      unresolvedFields: ordered.map((field) => field.name),
      unresolvedFieldIds: ordered.map((field) => field.fieldId),
    }
  }
  canonical.sort((left, right) => left.fieldId.localeCompare(right.fieldId))
  return {
    kind: 'READY',
    payload: normalized,
    dataSha256: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  }
}

async function assertNewTarget(path: string): Promise<void> {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== '.docx') throw new WorkDocxError('INPUT_INVALID')
  try {
    await access(path, fsConstants.F_OK)
    throw new WorkDocxError('TARGET_EXISTS')
  } catch (error) {
    if (error instanceof WorkDocxError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw new WorkDocxError('INPUT_INVALID')
  }

  const parent = dirname(path)
  const parentInfo = await lstat(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new WorkDocxError('INPUT_INVALID')
  const lexicalParent = resolve(parent).toLowerCase()
  const physicalParent = (await realpath(parent)).toLowerCase()
  if (lexicalParent !== physicalParent) throw new WorkDocxError('INPUT_INVALID')
}

async function publishNewTarget(target: string, content: Buffer, operationId: WorkDocxOperationIdV1): Promise<void> {
  await assertNewTarget(target)
  const temporary = join(dirname(target), `.${basename(target)}.${operationId}.tmp`)
  let temporaryCreated = false
  try {
    const handle = await open(temporary, 'wx')
    temporaryCreated = true
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(temporary, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkDocxError('TARGET_EXISTS')
    throw new WorkDocxError('PUBLISH_FAILED')
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => {})
  }
}

export class WorkDocxServiceV1 {
  private readonly selected = new Map<WorkDocxTemplateSelectionIdV1, SelectedTemplateV1>()
  private readonly prepared = new Map<WorkDocxOperationIdV1, PreparedOperationV1>()
  private readonly completed = new Map<WorkDocxOperationIdV1, CompletedOperationV1>()
  private readonly active = new Set<WorkDocxOperationIdV1>()
  private readonly templateIntakeHandoffs = new Map<string, WorkDocxTemplateIntakeHandoffV1>()

  constructor(private readonly options: WorkDocxServiceOptionsV1) {}

  private async admit(address: SessionAddressV1): Promise<WorkDocxOutcomeV1<true>> {
    const lookup = await this.options.lookup.lookup(address)
    if (lookup.kind === 'NOT_FOUND') return failure('SCOPE_NOT_FOUND')
    if (lookup.kind === 'PROJECT_MISMATCH') return failure('SCOPE_MISMATCH')
    if (lookup.scope.sessionMode !== 'WORK') return failure('MODE_NOT_ALLOWED')
    return { ok: true, value: true }
  }

  async discover(address: SessionAddressV1): Promise<WorkDocxOutcomeV1<WorkDocxDiscoverResultV1>> {
    const admitted = await this.admit(address)
    if (!admitted.ok) return admitted
    return { ok: true, value: { capabilities: [CAPABILITY] } }
  }

  private async discardSelection(selection: SelectedTemplateV1): Promise<void> {
    this.selected.delete(selection.selectionId)
    await rm(selection.stageDir, { recursive: true, force: true }).catch(() => {})
  }

  async selectTemplate(
    request: WorkDocxTemplateSelectRequestV1,
  ): Promise<WorkDocxOutcomeV1<WorkDocxTemplateSelectResultV1>> {
    const admitted = await this.admit(request.address)
    if (!admitted.ok) return admitted

    let stageDir: string | null = null
    try {
      const libraryVersion = request.templateVersionId
        ? await this.options.templateLibrary?.resolveVersionForUse(request.templateVersionId)
        : null
      if (request.templateVersionId && !libraryVersion) throw new WorkDocxError('OPERATION_NOT_FOUND')
      const sourceTemplate = libraryVersion?.assetPath ?? await this.options.dialogs.chooseTemplate()
      if (!sourceTemplate) return { ok: true, value: { kind: 'CANCELLED' } }
      if (extname(sourceTemplate).toLowerCase() !== '.docx') throw new WorkDocxError('INPUT_INVALID')

      const templateDisplayName = libraryVersion
        ? `${libraryVersion.entry.name}（第 ${libraryVersion.version.versionNumber} 版）.docx`
        : safeDisplayName(sourceTemplate)
      const templateBefore = await readLimited(sourceTemplate, MAX_TEMPLATE_BYTES)
      await assertSafeDocx(templateBefore)
      const templateSha256 = createHash('sha256').update(templateBefore).digest('hex')
      const placeholders = [...new Set(await patchDetector({ data: templateBefore }))].sort()
      if (placeholders.length > MAX_PLACEHOLDERS) throw new WorkDocxError('INPUT_TOO_LARGE')
      for (const placeholder of placeholders) {
        if (!TEMPLATE_FIELD_KEY.test(placeholder) || ['__proto__', 'constructor', 'prototype'].includes(placeholder)) {
          throw new WorkDocxError('INPUT_INVALID')
        }
      }
      const inspection = await inspectTemplate(templateBefore, placeholders, templateSha256)
      const selectedFields = reconcileLibraryFields(
        inspection.fields,
        libraryVersion?.version.fields,
      )

      if (placeholders.length === 0) {
        this.templateIntakeHandoffs.set(addressKey(request.address), {
          sourcePath: sourceTemplate,
          templateDisplayName,
          templateSha256,
          byteLength: templateBefore.byteLength,
          profile: inspection.profile,
        })
        return {
          ok: true,
          value: {
            kind: 'TEMPLATE_PREPARATION_REQUIRED',
            templateDisplayName,
            templateSha256,
            profile: inspection.profile,
          },
        }
      }

      await mkdir(this.options.tempRoot, { recursive: true })
      stageDir = await mkdtemp(join(this.options.tempRoot, 'selection-'))
      const stagedTemplate = join(stageDir, 'template.docx')
      await copyFile(sourceTemplate, stagedTemplate, fsConstants.COPYFILE_EXCL)
      if ((await sha256(stagedTemplate)) !== templateSha256) throw new WorkDocxError('INPUT_INVALID')

      const selectionId = `xgws1_${randomUUID()}` as WorkDocxTemplateSelectionIdV1
      this.selected.set(selectionId, {
        addressKey: addressKey(request.address),
        selectionId,
        stageDir,
        sourceTemplate,
        stagedTemplate,
        templateDisplayName,
        templateSha256,
        ...(libraryVersion ? { templateVersionId: libraryVersion.version.versionId } : {}),
        fields: selectedFields,
        profile: inspection.profile,
      })
      stageDir = null
      return {
        ok: true,
        value: {
          kind: 'TEMPLATE_SELECTED',
          selectionId,
          templateDisplayName,
          templateSha256,
          ...(libraryVersion ? { templateVersionId: libraryVersion.version.versionId } : {}),
          fields: selectedFields,
          profile: inspection.profile,
        },
      }
    } catch (error) {
      if (error instanceof WorkDocxError) return failure(error.code)
      return failure('GENERATION_FAILED')
    } finally {
      if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async listLibraryTemplates(
    address: SessionAddressV1,
  ): Promise<WorkDocxOutcomeV1<readonly TemplateLibraryDetailV1[]>> {
    const admitted = await this.admit(address)
    if (!admitted.ok) return admitted
    if (!this.options.templateLibrary) return { ok: true, value: [] }
    try {
      const listed = await this.options.templateLibrary.list({ status: 'ACTIVE', limit: 50, offset: 0 })
      const details = await Promise.all(
        listed.items.map((item) => this.options.templateLibrary!.getDetail(item.entryId)),
      )
      return { ok: true, value: details }
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'TEMPLATE_LIBRARY_NOT_CONFIGURED'
      ) {
        return { ok: true, value: [] }
      }
      return failure('GENERATION_FAILED')
    }
  }

  /** 仅供同一主进程内的普通成品 Word 整理服务消费；不会进入 Worker 或渲染层。 */
  consumeTemplateIntakeHandoff(address: SessionAddressV1): WorkDocxTemplateIntakeHandoffV1 | null {
    const key = addressKey(address)
    const handoff = this.templateIntakeHandoffs.get(key) ?? null
    this.templateIntakeHandoffs.delete(key)
    return handoff
  }

  async prepareTemplateData(
    request: WorkDocxTemplateDataPrepareRequestV1,
  ): Promise<WorkDocxOutcomeV1<WorkDocxTemplateDataPrepareResultV1>> {
    const admitted = await this.admit(request.address)
    if (!admitted.ok) return admitted
    const selection = this.selected.get(request.selectionId)
    if (!selection) return failure('OPERATION_NOT_FOUND')
    if (selection.addressKey !== addressKey(request.address)) return failure('OPERATION_SCOPE_MISMATCH')

    try {
      if ((await sha256(selection.sourceTemplate)) !== selection.templateSha256) {
        await this.discardSelection(selection)
        return failure('SOURCE_CHANGED')
      }
      const normalized = normalizeTemplateData(
        request.fields,
        selection.fields,
      )
      if (normalized.kind === 'INPUT_REQUIRED') {
        return { ok: true, value: normalized }
      }

      const target = await this.options.dialogs.chooseNewTarget()
      if (!target) return { ok: true, value: { kind: 'CANCELLED' } }
      await assertNewTarget(target)
      if ((await sha256(selection.sourceTemplate)) !== selection.templateSha256) {
        await this.discardSelection(selection)
        return failure('SOURCE_CHANGED')
      }

      const operationId = `xgw1_${randomUUID()}` as WorkDocxOperationIdV1
      const fieldNames = selection.fields.map((field) => field.name)
      this.prepared.set(operationId, {
        inputKind: 'TEMPLATE_DATA',
        addressKey: selection.addressKey,
        operationId,
        stageDir: selection.stageDir,
        sourceTemplate: selection.sourceTemplate,
        stagedTemplate: selection.stagedTemplate,
        target,
        placeholders: fieldNames,
        payload: normalized.payload,
        templateSha256: selection.templateSha256,
        dataSha256: normalized.dataSha256,
        ...(selection.templateVersionId ? { templateVersionId: selection.templateVersionId } : {}),
        fieldIds: selection.fields.map((field) => field.fieldId),
      })
      this.selected.delete(selection.selectionId)
      return {
        ok: true,
        value: {
          kind: 'PREPARED',
          operationId,
          templateDisplayName: selection.templateDisplayName,
          fields: fieldNames,
          fieldIds: selection.fields.map((field) => field.fieldId),
          templateSha256: selection.templateSha256,
          dataSha256: normalized.dataSha256,
          ...(selection.templateVersionId ? { templateVersionId: selection.templateVersionId } : {}),
        },
      }
    } catch (error) {
      if (error instanceof WorkDocxError) return failure(error.code)
      return failure('GENERATION_FAILED')
    }
  }

  async cancelTemplateSelection(
    request: WorkDocxTemplateSelectionCancelRequestV1,
  ): Promise<WorkDocxOutcomeV1<WorkDocxTemplateSelectionCancelledResultV1>> {
    const admitted = await this.admit(request.address)
    if (!admitted.ok) return admitted
    const selection = this.selected.get(request.selectionId)
    if (!selection) return failure('OPERATION_NOT_FOUND')
    if (selection.addressKey !== addressKey(request.address)) return failure('OPERATION_SCOPE_MISMATCH')
    await this.discardSelection(selection)
    return { ok: true, value: { kind: 'CANCELLED' } }
  }

  async prepare(request: WorkDocxPrepareRequestV1): Promise<WorkDocxOutcomeV1<WorkDocxPrepareResultV1>> {
    const admitted = await this.admit(request.address)
    if (!admitted.ok) return admitted

    let stageDir: string | null = null
    try {
      const sourceTemplate = await this.options.dialogs.chooseTemplate()
      if (!sourceTemplate) return { ok: true, value: { kind: 'CANCELLED' } }
      const sourcePayload = await this.options.dialogs.choosePayload()
      if (!sourcePayload) return { ok: true, value: { kind: 'CANCELLED' } }
      const target = await this.options.dialogs.chooseNewTarget()
      if (!target) return { ok: true, value: { kind: 'CANCELLED' } }

      if (extname(sourceTemplate).toLowerCase() !== '.docx' || extname(sourcePayload).toLowerCase() !== '.json') {
        throw new WorkDocxError('INPUT_INVALID')
      }
      const templateDisplayName = safeDisplayName(sourceTemplate)
      const payloadDisplayName = safeDisplayName(sourcePayload)
      await assertNewTarget(target)
      await mkdir(this.options.tempRoot, { recursive: true })
      stageDir = await mkdtemp(join(this.options.tempRoot, 'operation-'))
      const stagedTemplate = join(stageDir, 'template.docx')
      const stagedPayload = join(stageDir, 'payload.json')

      const templateBefore = await readLimited(sourceTemplate, MAX_TEMPLATE_BYTES)
      const payloadBefore = await readLimited(sourcePayload, MAX_PAYLOAD_BYTES)
      await assertSafeDocx(templateBefore)
      await copyFile(sourceTemplate, stagedTemplate, fsConstants.COPYFILE_EXCL)
      await copyFile(sourcePayload, stagedPayload, fsConstants.COPYFILE_EXCL)

      const templateSha256 = createHash('sha256').update(templateBefore).digest('hex')
      const payloadSha256 = createHash('sha256').update(payloadBefore).digest('hex')
      if ((await sha256(stagedTemplate)) !== templateSha256 || (await sha256(stagedPayload)) !== payloadSha256) {
        throw new WorkDocxError('INPUT_INVALID')
      }

      const placeholders = [...new Set(await patchDetector({ data: templateBefore }))].sort()
      if (placeholders.length === 0 || placeholders.length > MAX_PLACEHOLDERS) {
        throw new WorkDocxError('PLACEHOLDER_MISSING')
      }
      const payload = normalizePayload(JSON.parse(payloadBefore.toString('utf8')) as unknown, placeholders)
      const operationId = `xgw1_${randomUUID()}` as WorkDocxOperationIdV1
      this.prepared.set(operationId, {
        inputKind: 'LEGACY_JSON',
        addressKey: addressKey(request.address),
        operationId,
        stageDir,
        sourceTemplate,
        sourcePayload,
        stagedTemplate,
        stagedPayload,
        target,
        placeholders,
        payload,
        templateSha256,
        payloadSha256,
      })
      stageDir = null
      return {
        ok: true,
        value: {
          kind: 'PREPARED',
          operationId,
          templateDisplayName,
          payloadDisplayName,
          placeholders,
          templateSha256,
          payloadSha256,
        },
      }
    } catch (error) {
      if (error instanceof WorkDocxError) return failure(error.code)
      if (error instanceof SyntaxError) return failure('INPUT_INVALID')
      return failure('GENERATION_FAILED')
    } finally {
      if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async confirmOperation(
    address: SessionAddressV1,
    operationId: WorkDocxOperationIdV1,
    inputKind: PreparedOperationV1['inputKind'],
  ): Promise<WorkDocxOutcomeV1<InternalPublishedResultV1>> {
    const requestAddressKey = addressKey(address)
    const previous = this.completed.get(operationId)
    if (previous) {
      if (previous.addressKey !== requestAddressKey) return failure('OPERATION_SCOPE_MISMATCH')
      if (previous.inputKind !== inputKind) return failure('OPERATION_NOT_FOUND')
      return {
        ok: true,
        value: {
          inputKind: previous.inputKind,
          operationId: previous.operationId,
          outputSha256: previous.outputSha256,
          templateSha256: previous.templateSha256,
          inputSha256: previous.inputSha256,
          ...(previous.templateVersionId ? { templateVersionId: previous.templateVersionId } : {}),
          originalInputsUnchanged: true,
        },
      }
    }

    const operation = this.prepared.get(operationId)
    if (!operation) return failure('OPERATION_NOT_FOUND')
    if (operation.addressKey !== requestAddressKey) return failure('OPERATION_SCOPE_MISMATCH')
    if (operation.inputKind !== inputKind) return failure('OPERATION_NOT_FOUND')
    if (this.active.has(operationId)) return failure('OPERATION_NOT_FOUND')
    this.active.add(operationId)

    try {
      if (
        (await sha256(operation.sourceTemplate)) !== operation.templateSha256 ||
        (operation.sourcePayload !== undefined &&
          operation.payloadSha256 !== undefined &&
          (await sha256(operation.sourcePayload)) !== operation.payloadSha256)
      ) {
        throw new WorkDocxError('SOURCE_CHANGED')
      }

      const template = await readLimited(operation.stagedTemplate, MAX_TEMPLATE_BYTES)
      const patches = Object.fromEntries(
        operation.placeholders.map((placeholder) => [
          placeholder,
          { type: PatchType.PARAGRAPH, children: [new TextRun(operation.payload[placeholder])] },
        ]),
      )
      let output: Buffer
      try {
        output = await patchDocument({
          outputType: 'nodebuffer',
          data: template,
          patches,
          keepOriginalStyles: true,
        })
      } catch {
        throw new WorkDocxError('GENERATION_FAILED')
      }

      await assertSafeDocx(output)
      if ((await patchDetector({ data: output })).length > 0) throw new WorkDocxError('PLACEHOLDER_MISSING')
      if (
        (await sha256(operation.sourceTemplate)) !== operation.templateSha256 ||
        (operation.sourcePayload !== undefined &&
          operation.payloadSha256 !== undefined &&
          (await sha256(operation.sourcePayload)) !== operation.payloadSha256)
      ) {
        throw new WorkDocxError('SOURCE_CHANGED')
      }

      await publishNewTarget(operation.target, output, operation.operationId)
      const outputSha256 = createHash('sha256').update(output).digest('hex')
      if ((await sha256(operation.target)) !== outputSha256) throw new WorkDocxError('PUBLISH_FAILED')

      const inputSha256 =
        operation.inputKind === 'LEGACY_JSON' ? operation.payloadSha256 : operation.dataSha256
      if (!inputSha256) throw new WorkDocxError('GENERATION_FAILED')
      const receipt: InternalPublishedResultV1 = {
        inputKind: operation.inputKind,
        operationId: operation.operationId,
        outputSha256,
        templateSha256: operation.templateSha256,
        inputSha256,
        ...(operation.templateVersionId ? { templateVersionId: operation.templateVersionId } : {}),
        originalInputsUnchanged: true,
      }
      this.completed.set(operation.operationId, {
        addressKey: operation.addressKey,
        target: operation.target,
        inputKind: operation.inputKind,
        operationId: operation.operationId,
        outputSha256,
        templateSha256: operation.templateSha256,
        inputSha256,
        ...(operation.templateVersionId ? { templateVersionId: operation.templateVersionId } : {}),
      })
      this.prepared.delete(operation.operationId)
      await rm(operation.stageDir, { recursive: true, force: true }).catch(() => {})
      return { ok: true, value: receipt }
    } catch (error) {
      this.prepared.delete(operation.operationId)
      await rm(operation.stageDir, { recursive: true, force: true }).catch(() => {})
      if (error instanceof WorkDocxError) return failure(error.code)
      return failure('GENERATION_FAILED')
    } finally {
      this.active.delete(operationId)
    }
  }

  async confirm(request: WorkDocxConfirmRequestV1): Promise<WorkDocxOutcomeV1<WorkDocxPublishedResultV1>> {
    const admitted = await this.admit(request.address)
    if (!admitted.ok) return admitted
    const outcome = await this.confirmOperation(request.address, request.operationId, 'LEGACY_JSON')
    if (!outcome.ok) return outcome
    return {
      ok: true,
      value: {
        kind: 'PUBLISHED',
        operationId: outcome.value.operationId,
        outputSha256: outcome.value.outputSha256,
        templateSha256: outcome.value.templateSha256,
        payloadSha256: outcome.value.inputSha256,
        originalInputsUnchanged: true,
      },
    }
  }

  async confirmTemplateData(
    request: WorkDocxConfirmRequestV1,
  ): Promise<WorkDocxOutcomeV1<WorkDocxTemplateDataPublishedResultV1>> {
    const admitted = await this.admit(request.address)
    if (!admitted.ok) return admitted
    const outcome = await this.confirmOperation(request.address, request.operationId, 'TEMPLATE_DATA')
    if (!outcome.ok) return outcome
    return {
      ok: true,
      value: {
        kind: 'PUBLISHED',
        operationId: outcome.value.operationId,
        outputSha256: outcome.value.outputSha256,
        templateSha256: outcome.value.templateSha256,
        dataSha256: outcome.value.inputSha256,
        ...(outcome.value.templateVersionId ? { templateVersionId: outcome.value.templateVersionId } : {}),
        originalInputsUnchanged: true,
      },
    }
  }

  async cancel(request: WorkDocxCancelRequestV1): Promise<WorkDocxOutcomeV1<WorkDocxCancelledResultV1>> {
    const admitted = await this.admit(request.address)
    if (!admitted.ok) return admitted
    const requestAddressKey = addressKey(request.address)

    if (this.completed.has(request.operationId)) {
      const entry = this.completed.get(request.operationId)!
      if (entry.addressKey !== requestAddressKey) return failure('OPERATION_SCOPE_MISMATCH')
      return failure('OPERATION_NOT_FOUND')
    }

    const operation = this.prepared.get(request.operationId)
    if (!operation) return failure('OPERATION_NOT_FOUND')
    if (operation.addressKey !== requestAddressKey) return failure('OPERATION_SCOPE_MISMATCH')
    if (this.active.has(request.operationId)) return failure('OPERATION_NOT_FOUND')
    this.active.add(request.operationId)

    try {
      await rm(operation.stageDir, { recursive: true, force: true })
    } catch {
      return failure('PUBLISH_FAILED')
    } finally {
      this.active.delete(request.operationId)
    }
    this.prepared.delete(request.operationId)
    return { ok: true, value: { kind: 'CANCELLED', operationId: request.operationId } }
  }

  async accessOutput(
    request: WorkDocxOutputAccessRequestV1,
  ): Promise<WorkDocxOutcomeV1<WorkDocxOutputAccessResultV1>> {
    const admitted = await this.admit(request.address)
    if (!admitted.ok) return admitted

    const operation = this.completed.get(request.operationId)
    if (!operation) return failure('OPERATION_NOT_FOUND')
    if (operation.addressKey !== addressKey(request.address)) return failure('OPERATION_SCOPE_MISMATCH')
    if (!this.options.outputAccess) return failure('OUTPUT_ACCESS_FAILED')

    try {
      if ((await sha256(operation.target)) !== operation.outputSha256) {
        return failure('OUTPUT_ACCESS_FAILED')
      }
      if (request.action === 'OPEN') {
        const errorMessage = await this.options.outputAccess.openPath(operation.target)
        if (errorMessage) return failure('OUTPUT_ACCESS_FAILED')
      } else {
        await this.options.outputAccess.revealPath(operation.target)
      }
      return {
        ok: true,
        value: {
          kind: 'ACCESSED',
          operationId: request.operationId,
          action: request.action,
        },
      }
    } catch {
      return failure('OUTPUT_ACCESS_FAILED')
    }
  }
}

export type { WorkDocxDialogPortV1, WorkDocxOutputAccessPortV1, WorkDocxServiceOptionsV1 }
