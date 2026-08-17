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
import JSZip, { type JSZipObject } from 'jszip'

import type {
  WorkDocxCancelRequestV1,
  WorkDocxCancelledResultV1,
  WorkDocxCapabilityV1,
  WorkDocxConfirmRequestV1,
  WorkDocxDiscoverResultV1,
  WorkDocxErrorCodeV1,
  WorkDocxOperationIdV1,
  WorkDocxOutcomeV1,
  WorkDocxPrepareRequestV1,
  WorkDocxPrepareResultV1,
  WorkDocxPublishedResultV1,
} from '@shared/xiaogui-work-docx'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'

const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024
const MAX_PAYLOAD_BYTES = 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_ZIP_ENTRIES = 1_000
const MAX_PLACEHOLDERS = 200
const MAX_VALUE_CHARS = 20_000
const MAX_DISPLAY_NAME_CHARS = 160
const PLACEHOLDER_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const UNSAFE_DISPLAY_NAME = /[\/\\\u0000-\u001f\u007f-\u009f]/

type WorkDocxDialogPortV1 = {
  chooseTemplate(): Promise<string | null>
  choosePayload(): Promise<string | null>
  chooseNewTarget(): Promise<string | null>
}

type WorkDocxServiceOptionsV1 = {
  lookup: SessionScopeLookupV1
  dialogs: WorkDocxDialogPortV1
  tempRoot: string
}

type PreparedOperationV1 = {
  addressKey: string
  operationId: WorkDocxOperationIdV1
  stageDir: string
  sourceTemplate: string
  sourcePayload: string
  stagedTemplate: string
  stagedPayload: string
  target: string
  placeholders: readonly string[]
  payload: Readonly<Record<string, string>>
  templateSha256: string
  payloadSha256: string
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

function zipUncompressedSize(entry: JSZipObject): number {
  if (entry.dir) return 0
  const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
  const size = Number(data?.uncompressedSize)
  if (!Number.isSafeInteger(size) || size < 0) throw new WorkDocxError('UNSAFE_DOCX')
  return size
}

async function assertSafeDocx(content: Buffer): Promise<void> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(content, { checkCRC32: true, createFolders: false })
  } catch {
    throw new WorkDocxError('UNSAFE_DOCX')
  }

  const entries = Object.values(zip.files)
  if (entries.length === 0 || entries.length > MAX_ZIP_ENTRIES) throw new WorkDocxError('UNSAFE_DOCX')

  let expandedBytes = 0
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/')
    if (name.startsWith('/') || name.split('/').includes('..')) throw new WorkDocxError('UNSAFE_DOCX')
    expandedBytes += zipUncompressedSize(entry)
    if (expandedBytes > MAX_UNCOMPRESSED_BYTES) throw new WorkDocxError('UNSAFE_DOCX')
  }

  const contentTypes = zip.file('[Content_Types].xml')
  const documentXml = zip.file('word/document.xml')
  if (!contentTypes || !documentXml) throw new WorkDocxError('UNSAFE_DOCX')

  const typeText = (await contentTypes.async('string')).toLowerCase()
  if (typeText.includes('macroenabled') || entries.some((entry) => entry.name.toLowerCase().includes('vbaproject'))) {
    throw new WorkDocxError('UNSAFE_DOCX')
  }

  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith('.rels')) continue
    const relationships = await entry.async('string')
    if (/TargetMode\s*=\s*["']External["']/i.test(relationships)) throw new WorkDocxError('UNSAFE_DOCX')
  }
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
  private readonly prepared = new Map<WorkDocxOperationIdV1, PreparedOperationV1>()
  private readonly completed = new Map<
    WorkDocxOperationIdV1,
    { addressKey: string; receipt: WorkDocxPublishedResultV1 }
  >()
  private readonly active = new Set<WorkDocxOperationIdV1>()

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

  async confirm(request: WorkDocxConfirmRequestV1): Promise<WorkDocxOutcomeV1<WorkDocxPublishedResultV1>> {
    const admitted = await this.admit(request.address)
    if (!admitted.ok) return admitted
    const requestAddressKey = addressKey(request.address)
    const previous = this.completed.get(request.operationId)
    if (previous) {
      if (previous.addressKey !== requestAddressKey) return failure('OPERATION_SCOPE_MISMATCH')
      return { ok: true, value: previous.receipt }
    }

    const operation = this.prepared.get(request.operationId)
    if (!operation) return failure('OPERATION_NOT_FOUND')
    if (operation.addressKey !== requestAddressKey) return failure('OPERATION_SCOPE_MISMATCH')
    if (this.active.has(request.operationId)) return failure('OPERATION_NOT_FOUND')
    this.active.add(request.operationId)

    try {
      if (
        (await sha256(operation.sourceTemplate)) !== operation.templateSha256 ||
        (await sha256(operation.sourcePayload)) !== operation.payloadSha256
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
        (await sha256(operation.sourcePayload)) !== operation.payloadSha256
      ) {
        throw new WorkDocxError('SOURCE_CHANGED')
      }

      await publishNewTarget(operation.target, output, operation.operationId)
      const outputSha256 = createHash('sha256').update(output).digest('hex')
      if ((await sha256(operation.target)) !== outputSha256) throw new WorkDocxError('PUBLISH_FAILED')

      const receipt: WorkDocxPublishedResultV1 = {
        kind: 'PUBLISHED',
        operationId: operation.operationId,
        outputSha256,
        templateSha256: operation.templateSha256,
        payloadSha256: operation.payloadSha256,
        originalInputsUnchanged: true,
      }
      this.completed.set(operation.operationId, { addressKey: operation.addressKey, receipt })
      this.prepared.delete(operation.operationId)
      await rm(operation.stageDir, { recursive: true, force: true }).catch(() => {})
      return { ok: true, value: receipt }
    } catch (error) {
      this.prepared.delete(operation.operationId)
      await rm(operation.stageDir, { recursive: true, force: true }).catch(() => {})
      if (error instanceof WorkDocxError) return failure(error.code)
      return failure('GENERATION_FAILED')
    } finally {
      this.active.delete(request.operationId)
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
}

export type { WorkDocxDialogPortV1, WorkDocxServiceOptionsV1 }
