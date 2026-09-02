import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path'

import type {
  AdvancedGenerationErrorCodeV1,
  AdvancedGenerationPlanV1,
  AdvancedGenerationReceiptV1,
  AdvancedTemplateDataV1,
} from '@shared/xiaogui-work-docx-advanced-generation'
import type { XiaoguiWorkDocxAdvancedGenerationPayloadV1, XiaoguiWorkDocxAdvancedGenerationResultV1 } from '@shared/worker-host-tools'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'

import { DOCX_SAFETY_MAX_FILE_BYTES_V1, DocxSafetyErrorV1, inspectSafeDocxArchiveV1 } from './docx-safety'
import { AdvancedGenerationRendererErrorV1, analyzeAdvancedTemplateV1, renderAdvancedTemplateV1 } from './work-docx-advanced-renderer'
import { WorkDocxAdvancedGenerationStoreV1, type StoredAdvancedGenerationRecordV1 } from './work-docx-advanced-generation-store'

type DialogPort = { chooseTemplate(): Promise<string | null>; chooseNewTarget(suggestedName: string): Promise<string | null> }
type OutputPort = { openPath(path: string): Promise<string>; revealPath(path: string): Promise<void> }

export interface WorkDocxAdvancedGenerationServiceOptionsV1 {
  lookup: SessionScopeLookupV1
  store: WorkDocxAdvancedGenerationStoreV1
  dialogs: DialogPort
  outputAccess: OutputPort
  tempRoot: string
  now?: () => Date
}

export type AdvancedGenerationServiceOutcomeV1 =
  | { ok: true; value: XiaoguiWorkDocxAdvancedGenerationResultV1 }
  | { ok: false; error: { code: AdvancedGenerationErrorCodeV1 } }

class ServiceError extends Error {
  constructor(readonly code: AdvancedGenerationErrorCodeV1) { super(code) }
}

const failure = (code: AdvancedGenerationErrorCodeV1): AdvancedGenerationServiceOutcomeV1 => ({ ok: false, error: { code } })
const hash = (content: Buffer): string => createHash('sha256').update(content).digest('hex')
const scopeKey = (address: SessionAddressV1): string => `${address.projectId}\0${address.sessionKey}`

async function readTemplate(path: string, changed = false): Promise<Buffer> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > DOCX_SAFETY_MAX_FILE_BYTES_V1 || extname(path).toLowerCase() !== '.docx') throw new ServiceError(changed ? 'ADVANCED_GENERATION_TEMPLATE_CHANGED' : 'ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED')
    const content = await readFile(path)
    await inspectSafeDocxArchiveV1(content)
    return content
  } catch (error) {
    if (error instanceof ServiceError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ServiceError('ADVANCED_GENERATION_TEMPLATE_MISSING')
    if (error instanceof DocxSafetyErrorV1) throw new ServiceError(changed ? 'ADVANCED_GENERATION_TEMPLATE_CHANGED' : 'ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED')
    throw new ServiceError('ADVANCED_GENERATION_RENDER_FAILED')
  }
}

async function fileHash(path: string): Promise<string | null> {
  try { return hash(await readFile(path)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

async function assertNewTarget(target: string, source: string): Promise<void> {
  if (!isAbsolute(target) || extname(target).toLowerCase() !== '.docx' || resolve(target).toLocaleLowerCase() === resolve(source).toLocaleLowerCase()) throw new ServiceError('ADVANCED_GENERATION_TARGET_INVALID')
  try { await access(target, fsConstants.F_OK); throw new ServiceError('ADVANCED_GENERATION_TARGET_EXISTS') } catch (error) { if (error instanceof ServiceError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ServiceError('ADVANCED_GENERATION_TARGET_INVALID') }
  const parent = dirname(target)
  const info = await lstat(parent)
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(parent).toLocaleLowerCase() !== (await realpath(parent)).toLocaleLowerCase()) throw new ServiceError('ADVANCED_GENERATION_TARGET_INVALID')
}

async function publish(target: string, content: Buffer, id: string): Promise<void> {
  const temporary = join(dirname(target), `.${basename(target)}.${id}.tmp`)
  let created = false
  try {
    const handle = await open(temporary, 'wx'); created = true
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    await link(temporary, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ServiceError('ADVANCED_GENERATION_TARGET_EXISTS')
    throw new ServiceError('ADVANCED_GENERATION_PUBLISH_FAILED')
  } finally { if (created) await unlink(temporary).catch(() => {}) }
}

function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset(); const sign = offset >= 0 ? '+' : '-'; const abs = Math.abs(offset); const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export class WorkDocxAdvancedGenerationServiceV1 {
  private readonly active = new Set<string>()
  constructor(private readonly options: WorkDocxAdvancedGenerationServiceOptionsV1) {}

  async execute(address: SessionAddressV1, payload: XiaoguiWorkDocxAdvancedGenerationPayloadV1, signal?: AbortSignal): Promise<AdvancedGenerationServiceOutcomeV1> {
    const admission = await this.admission(address); if (admission) return failure(admission)
    if (signal?.aborted) return failure('ADVANCED_GENERATION_ABORTED')
    const key = scopeKey(address); if (this.active.has(key)) return failure('ADVANCED_GENERATION_OPERATION_ACTIVE'); this.active.add(key)
    try {
      switch (payload.action) {
        case 'START': return await this.start(address, payload.sourceRunId, signal)
        case 'PREPARE': return await this.prepare(address, payload.sourceRunId, payload.data, signal)
        case 'CONFIRM': return await this.confirm(address, payload.sourceRunId)
        case 'RESUME': return await this.resume(address, signal)
        case 'CANCEL': return await this.cancel(address)
        case 'OPEN': case 'REVEAL': return await this.accessOutput(address, payload.action)
      }
    } catch (error) {
      if (error instanceof ServiceError || error instanceof AdvancedGenerationRendererErrorV1) return failure(error.code)
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return failure('ADVANCED_GENERATION_ABORTED')
      return failure('ADVANCED_GENERATION_STORAGE_FAILED')
    } finally { this.active.delete(key) }
  }

  close(): void { this.active.clear(); this.options.store.close() }

  private async admission(address: SessionAddressV1): Promise<AdvancedGenerationErrorCodeV1 | null> {
    const lookup = await this.options.lookup.lookup(address)
    if (lookup.kind === 'NOT_FOUND') return 'ADVANCED_GENERATION_SCOPE_NOT_FOUND'
    if (lookup.kind === 'PROJECT_MISMATCH') return 'ADVANCED_GENERATION_SCOPE_MISMATCH'
    if (lookup.scope.sessionMode !== 'WORK') return 'ADVANCED_GENERATION_MODE_NOT_ALLOWED'
    return null
  }

  private now(): Date { return this.options.now?.() ?? new Date() }

  private async start(address: SessionAddressV1, sourceRunId: string, signal?: AbortSignal): Promise<AdvancedGenerationServiceOutcomeV1> {
    if (this.options.store.latest(address, ['SELECTED', 'PREPARED'])) return failure('ADVANCED_GENERATION_OPERATION_ACTIVE')
    const path = await this.options.dialogs.chooseTemplate()
    if (!path) return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_SELECTION_CANCELLED' } }
    const content = await readTemplate(path)
    if (signal?.aborted) return failure('ADVANCED_GENERATION_ABORTED')
    const schema = await analyzeAdvancedTemplateV1(content, basename(path))
    const now = this.now().toISOString()
    this.options.store.create({ operationId: `xgag1_${randomUUID()}`, address, templatePath: path, templateSha256: hash(content), schema, status: 'SELECTED', selectedRunId: sourceRunId, createdAt: now, updatedAt: now })
    return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_SCHEMA_READY', schema } }
  }

  private async source(record: StoredAdvancedGenerationRecordV1): Promise<Buffer> {
    const content = await readTemplate(record.templatePath, true)
    if (hash(content) !== record.templateSha256) { record.status = 'STALE'; record.updatedAt = this.now().toISOString(); this.options.store.save(record); throw new ServiceError('ADVANCED_GENERATION_TEMPLATE_CHANGED') }
    return content
  }

  private async createPreview(content: Buffer): Promise<string> {
    await mkdir(this.options.tempRoot, { recursive: true }); const directory = await mkdtemp(join(this.options.tempRoot, 'operation-')); const path = join(directory, '小规成品预览.docx')
    try { await writeFile(path, content, { flag: 'wx' }); if ((await fileHash(path)) !== hash(content)) throw new ServiceError('ADVANCED_GENERATION_RENDER_FAILED'); return path } catch (error) { await rm(directory, { recursive: true, force: true }).catch(() => {}); throw error }
  }

  private async openPreview(path: string): Promise<void> { if (await this.options.outputAccess.openPath(path)) throw new ServiceError('ADVANCED_GENERATION_PREVIEW_OPEN_FAILED') }

  private async prepare(address: SessionAddressV1, sourceRunId: string, data: AdvancedTemplateDataV1, signal?: AbortSignal): Promise<AdvancedGenerationServiceOutcomeV1> {
    const record = this.options.store.latest(address, ['SELECTED'])
    if (!record) return failure('ADVANCED_GENERATION_NO_PENDING_OPERATION')
    const template = await this.source(record)
    const built = await renderAdvancedTemplateV1({ template, displayName: record.schema.template.displayName, data })
    if (JSON.stringify(built.plan.schema) !== JSON.stringify(record.schema)) throw new ServiceError('ADVANCED_GENERATION_TEMPLATE_CHANGED')
    if (signal?.aborted) return failure('ADVANCED_GENERATION_ABORTED')
    const previewPath = await this.createPreview(built.content)
    record.data = data; record.plan = built.plan; record.previewPath = previewPath; record.preparedRunId = sourceRunId; record.status = 'PREPARED'; record.updatedAt = this.now().toISOString(); this.options.store.save(record)
    await this.openPreview(previewPath)
    return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_PREPARED', plan: built.plan } }
  }

  private receipt(record: StoredAdvancedGenerationRecordV1): AdvancedGenerationReceiptV1 {
    if (!record.plan) throw new ServiceError('ADVANCED_GENERATION_STORAGE_FAILED')
    return { receiptVersion: 1, templateSha256: record.templateSha256, dataSha256: record.plan.dataSha256, outputSha256: record.plan.previewSha256, repeatRecordCount: record.plan.repeatRecordCount, retainedConditionalCount: record.plan.retainedConditionalCount, originalTemplateUnchanged: true, publishedAtLocal: localIso(this.now()) }
  }

  private async rebuilt(record: StoredAdvancedGenerationRecordV1): Promise<{ content: Buffer; plan: AdvancedGenerationPlanV1 }> {
    if (!record.data || !record.plan) throw new ServiceError('ADVANCED_GENERATION_STORAGE_FAILED')
    const built = await renderAdvancedTemplateV1({ template: await this.source(record), displayName: record.schema.template.displayName, data: record.data })
    if (built.plan.previewSha256 !== record.plan.previewSha256 || built.plan.dataSha256 !== record.plan.dataSha256) throw new ServiceError('ADVANCED_GENERATION_RENDER_FAILED')
    return built
  }

  private async confirm(address: SessionAddressV1, sourceRunId: string): Promise<AdvancedGenerationServiceOutcomeV1> {
    const record = this.options.store.latest(address, ['PREPARED']); if (!record || !record.preparedRunId) return failure('ADVANCED_GENERATION_NO_PENDING_OPERATION')
    if (record.preparedRunId === sourceRunId) return failure('ADVANCED_GENERATION_CONFIRMATION_REQUIRED')
    const built = await this.rebuilt(record)
    let target = record.publishedPath
    if (target) {
      const existing = await fileHash(target)
      if (existing === built.plan.previewSha256) {
        const receipt = record.receipt ?? this.receipt(record)
        record.receipt = receipt
        record.status = 'PUBLISHED'
        record.updatedAt = this.now().toISOString()
        this.options.store.save(record)
        if (record.previewPath) await rm(dirname(record.previewPath), { recursive: true, force: true }).catch(() => {})
        return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_PUBLISHED', receipt } }
      }
      if (existing !== null) return failure('ADVANCED_GENERATION_TARGET_EXISTS')
    }
    if (!target) {
      const selected = await this.options.dialogs.chooseNewTarget(`${parse(record.schema.template.displayName).name.slice(0, 120) || 'Word成品'}-成品.docx`)
      if (!selected) return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_TARGET_SELECTION_CANCELLED' } }
      target = selected
      await assertNewTarget(target, record.templatePath)
      record.publishedPath = target
      record.updatedAt = this.now().toISOString()
      this.options.store.save(record)
    } else await assertNewTarget(target, record.templatePath)
    await publish(target, built.content, record.operationId)
    if ((await fileHash(target)) !== built.plan.previewSha256) throw new ServiceError('ADVANCED_GENERATION_PUBLISH_FAILED')
    const receipt = this.receipt(record); record.receipt = receipt; record.status = 'PUBLISHED'; record.updatedAt = this.now().toISOString()
    try { this.options.store.save(record) } catch { /* 已保存目标路径；RESUME/CONFIRM 可按精确摘要收敛。 */ }
    if (record.previewPath) await rm(dirname(record.previewPath), { recursive: true, force: true }).catch(() => {})
    return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_PUBLISHED', receipt } }
  }

  private async resume(address: SessionAddressV1, signal?: AbortSignal): Promise<AdvancedGenerationServiceOutcomeV1> {
    const record = this.options.store.latest(address, ['SELECTED', 'PREPARED', 'PUBLISHED']); if (!record) return failure('ADVANCED_GENERATION_NO_PENDING_OPERATION')
    if (record.status === 'PUBLISHED') { if (!record.receipt) return failure('ADVANCED_GENERATION_STORAGE_FAILED'); return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_RESUMED', receipt: record.receipt } } }
    await this.source(record)
    if (record.status === 'SELECTED') return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_RESUMED', schema: record.schema } }
    const built = await this.rebuilt(record); if (signal?.aborted) return failure('ADVANCED_GENERATION_ABORTED')
    if (record.previewPath) await rm(dirname(record.previewPath), { recursive: true, force: true }).catch(() => {})
    record.previewPath = await this.createPreview(built.content); record.updatedAt = this.now().toISOString(); this.options.store.save(record); await this.openPreview(record.previewPath)
    return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_RESUMED', plan: built.plan } }
  }

  private async cancel(address: SessionAddressV1): Promise<AdvancedGenerationServiceOutcomeV1> {
    const record = this.options.store.latest(address, ['SELECTED', 'PREPARED']); if (record) { record.status = 'CANCELLED'; record.updatedAt = this.now().toISOString(); this.options.store.save(record); if (record.previewPath) await rm(dirname(record.previewPath), { recursive: true, force: true }).catch(() => {}) }
    return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_CANCELLED' } }
  }

  private async accessOutput(address: SessionAddressV1, action: 'OPEN' | 'REVEAL'): Promise<AdvancedGenerationServiceOutcomeV1> {
    const record = this.options.store.latest(address, ['PUBLISHED']); if (!record?.publishedPath || !record.receipt || (await fileHash(record.publishedPath)) !== record.receipt.outputSha256) return failure('ADVANCED_GENERATION_NO_PUBLISHED_OUTPUT')
    if (action === 'OPEN') { if (await this.options.outputAccess.openPath(record.publishedPath)) return failure('ADVANCED_GENERATION_NO_PUBLISHED_OUTPUT') } else await this.options.outputAccess.revealPath(record.publishedPath)
    return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_ACCESSED', action } }
  }
}
