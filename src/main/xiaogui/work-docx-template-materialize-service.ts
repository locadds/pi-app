import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from 'node:path'

import type {
  TemplateMaterializeErrorCodeV1,
  TemplateMaterializePreviewRequestV1,
  TemplateMaterializeReceiptV1,
} from '@shared/xiaogui-work-docx-template-materialize'
import type {
  TemplateLibraryFieldSummaryV1,
  TemplateLibrarySaveMetadataV1,
} from '@shared/xiaogui-template-library'
import type {
  XiaoguiWorkDocxTemplateMaterializePayloadV1,
  XiaoguiWorkDocxTemplateMaterializeResultV1,
} from '@shared/worker-host-tools'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'

import {
  DOCX_SAFETY_MAX_FILE_BYTES_V1,
  DocxSafetyErrorV1,
  inspectSafeDocxArchiveV1,
} from './docx-safety'
import type {
  ConfirmedTemplateIntakeMaterializationSourceV1,
  WorkDocxTemplateIntakeServiceV1,
} from './work-docx-template-intake-service'
import {
  materializeConfirmedTemplateV1,
  TemplateMaterializerErrorV1,
} from './work-docx-template-materializer'
import {
  WorkDocxTemplateMaterializeStoreV1,
  type StoredTemplateMaterializeRecordV1,
} from './work-docx-template-materialize-store'
import {
  TemplateLibraryServiceErrorV1,
  type TemplateLibraryServiceV1,
} from './template-library-service'
import type { DocumentReviewRendererV1 } from './work-document-review-renderer'
import type {
  TemplateReviewReplacementImageStoreV1,
  TemplateReviewReplacementImageV1,
} from './work-document-review-image-store'
import {
  LEGACY_DOC_SAFETY_MAX_FILE_BYTES_V1,
  inspectSafeLegacyDocV1,
} from './work-legacy-doc-safety'

type TemplateMaterializeDialogPortV1 = {
  chooseNewTarget(suggestedName: string): Promise<string | null>
}

type TemplateMaterializeOutputAccessPortV1 = {
  openPath(path: string): Promise<string>
  revealPath(path: string): Promise<void>
}

type ConfirmedIntakeReaderV1 = Pick<
  WorkDocxTemplateIntakeServiceV1,
  'loadConfirmedForMaterialization'
>

export interface WorkDocxTemplateMaterializeServiceOptionsV1 {
  lookup: SessionScopeLookupV1
  intake: ConfirmedIntakeReaderV1
  store: WorkDocxTemplateMaterializeStoreV1
  dialogs: TemplateMaterializeDialogPortV1
  outputAccess: TemplateMaterializeOutputAccessPortV1
  tempRoot: string
  /** 配置后正式模板优先保存到本机模板库；省略时保留旧版“直接另存”兼容行为。 */
  templateLibrary?: Pick<
    TemplateLibraryServiceV1,
    'getConfiguration' | 'saveFromBuffer' | 'resolveVersionForUse'
  >
  configureTemplateLibrary?: () => Promise<{ configured: boolean }>
  documentReviewRenderer?: Pick<DocumentReviewRendererV1, 'prepare' | 'readNormalizedDocx' | 'release'>
  replacementImageStore?: Pick<TemplateReviewReplacementImageStoreV1, 'resolve'>
  now?: () => Date
}

export type TemplateMaterializeServiceOutcomeV1 =
  | { ok: true; value: XiaoguiWorkDocxTemplateMaterializeResultV1 }
  | { ok: false; error: { code: TemplateMaterializeErrorCodeV1 } }

class TemplateMaterializeServiceErrorV1 extends Error {
  constructor(readonly code: TemplateMaterializeErrorCodeV1) {
    super(code)
  }
}

function failure(code: TemplateMaterializeErrorCodeV1): TemplateMaterializeServiceOutcomeV1 {
  return { ok: false, error: { code } }
}

function scopeKey(address: SessionAddressV1): string {
  return `${address.projectId}\0${address.sessionKey}`
}

async function readSource(path: string): Promise<Buffer> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_SOURCE_MISSING')
    }
    throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_GENERATION_FAILED')
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > DOCX_SAFETY_MAX_FILE_BYTES_V1) {
    throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_SOURCE_CHANGED')
  }
  const content = await readFile(path)
  try {
    await inspectSafeDocxArchiveV1(content)
  } catch (error) {
    if (error instanceof DocxSafetyErrorV1) {
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_SOURCE_CHANGED')
    }
    throw error
  }
  return content
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

async function fileSha256(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function assertNewTarget(path: string, sourcePath: string): Promise<void> {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== '.docx') {
    throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_TARGET_INVALID')
  }
  if (resolve(path).toLocaleLowerCase() === resolve(sourcePath).toLocaleLowerCase()) {
    throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_TARGET_INVALID')
  }
  try {
    await access(path, fsConstants.F_OK)
    throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_TARGET_EXISTS')
  } catch (error) {
    if (error instanceof TemplateMaterializeServiceErrorV1) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_TARGET_INVALID')
    }
  }
  const parent = dirname(path)
  const info = await lstat(parent)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_TARGET_INVALID')
  }
  if (resolve(parent).toLocaleLowerCase() !== (await realpath(parent)).toLocaleLowerCase()) {
    throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_TARGET_INVALID')
  }
}

async function publishNewTarget(target: string, content: Buffer, operationId: string): Promise<void> {
  const temporary = join(dirname(target), `.${basename(target)}.${operationId}.tmp`)
  let created = false
  try {
    const handle = await open(temporary, 'wx')
    created = true
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(temporary, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_TARGET_EXISTS')
    }
    throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_PUBLISH_FAILED')
  } finally {
    if (created) await unlink(temporary).catch(() => {})
  }
}

function suggestedTemplateName(displayName: string): string {
  const stem = parse(displayName).name.slice(0, 120) || 'Word模板'
  return `${stem}-小规模板.docx`
}

function localIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

export class WorkDocxTemplateMaterializeServiceV1 {
  private readonly active = new Set<string>()
  private readonly previewManifestIds = new Map<string, string>()
  private readonly previewConfirmationTokens = new Map<string, string>()

  constructor(private readonly options: WorkDocxTemplateMaterializeServiceOptionsV1) {}

  async execute(
    address: SessionAddressV1,
    payload: XiaoguiWorkDocxTemplateMaterializePayloadV1,
    signal?: AbortSignal,
  ): Promise<TemplateMaterializeServiceOutcomeV1> {
    const admission = await this.admissionError(address)
    if (admission) return failure(admission)
    if (signal?.aborted) return failure('TEMPLATE_MATERIALIZE_ABORTED')
    const key = scopeKey(address)
    if (this.active.has(key)) return failure('TEMPLATE_MATERIALIZE_OPERATION_ACTIVE')
    this.active.add(key)
    try {
      switch (payload.action) {
        case 'PREPARE':
          return await this.prepare(address, payload.sourceRunId, payload.reportId, signal)
        case 'CONFIRM':
          return await this.confirm(address, payload.sourceRunId, {
            templateName: payload.templateName,
            purpose: payload.purpose,
            tags: payload.tags,
          }, payload.previewConfirmationToken)
        case 'RESUME':
          return await this.resume(address, signal)
        case 'CANCEL':
          return await this.cancel(address)
        case 'OPEN':
        case 'REVEAL':
          return await this.accessOutput(address, payload.action)
        case 'EXPORT':
          return await this.exportCopy(address)
      }
    } catch (error) {
      if (error instanceof TemplateMaterializeServiceErrorV1) return failure(error.code)
      if (error instanceof TemplateMaterializerErrorV1) return failure(error.code)
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return failure('TEMPLATE_MATERIALIZE_ABORTED')
      }
      return failure('TEMPLATE_MATERIALIZE_STORAGE_FAILED')
    } finally {
      this.active.delete(key)
    }
  }

  close(): void {
    this.active.clear()
    for (const manifestId of this.previewManifestIds.values()) {
      this.options.documentReviewRenderer?.release(manifestId)
    }
    this.previewManifestIds.clear()
    this.previewConfirmationTokens.clear()
    this.options.store.close()
  }

  private async admissionError(
    address: SessionAddressV1,
  ): Promise<TemplateMaterializeErrorCodeV1 | null> {
    const lookup = await this.options.lookup.lookup(address)
    if (lookup.kind === 'NOT_FOUND') return 'TEMPLATE_MATERIALIZE_SCOPE_NOT_FOUND'
    if (lookup.kind === 'PROJECT_MISMATCH') return 'TEMPLATE_MATERIALIZE_SCOPE_MISMATCH'
    if (lookup.scope.sessionMode !== 'WORK') return 'TEMPLATE_MATERIALIZE_MODE_NOT_ALLOWED'
    return null
  }

  private confirmedSource(
    address: SessionAddressV1,
    reportId?: string,
  ): ConfirmedTemplateIntakeMaterializationSourceV1 {
    const source = this.options.intake.loadConfirmedForMaterialization(address, reportId)
    if (!source) {
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_REPORT_NOT_CONFIRMED')
    }
    return source
  }

  private async build(
    source: ConfirmedTemplateIntakeMaterializationSourceV1,
  ): Promise<Awaited<ReturnType<typeof materializeConfirmedTemplateV1>>> {
    const extension = extname(source.sourcePath).toLowerCase()
    let originalContent: Buffer
    let normalizedContent: Buffer
    let manifestId: string | null = null
    if (extension === '.docx') {
      originalContent = await readSource(source.sourcePath)
      normalizedContent = originalContent
    } else if (extension === '.doc') {
      const information = await lstat(source.sourcePath)
      if (!information.isFile() || information.isSymbolicLink() || information.size > LEGACY_DOC_SAFETY_MAX_FILE_BYTES_V1) {
        throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_SOURCE_CHANGED')
      }
      originalContent = await readFile(source.sourcePath)
      try {
        inspectSafeLegacyDocV1(originalContent)
      } catch {
        throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_SOURCE_CHANGED')
      }
      const renderer = this.options.documentReviewRenderer
      if (!renderer) throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_GENERATION_FAILED')
      const prepared = await renderer.prepare(originalContent, 'DOC')
      manifestId = prepared.manifestId
      const converted = renderer.readNormalizedDocx(manifestId)
      if (!converted) {
        renderer.release(manifestId)
        throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_GENERATION_FAILED')
      }
      normalizedContent = converted
    } else {
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_SOURCE_CHANGED')
    }
    if (sha256(originalContent) !== source.sourceSha256) {
      if (manifestId) this.options.documentReviewRenderer?.release(manifestId)
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_SOURCE_CHANGED')
    }
    try {
      const replacementImageTokens = [
        ...new Set(
          source.decision.reviewActionsV2
            ?.filter((action) => action.kind === 'REPLACE_IMAGE')
            .map((action) => action.replacementImageToken) ?? [],
        ),
      ]
      const replacementImages = new Map<string, TemplateReviewReplacementImageV1>()
      for (const token of replacementImageTokens) {
        const image = await this.options.replacementImageStore?.resolve(token)
        if (!image) throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT')
        replacementImages.set(token, image)
      }
      return await materializeConfirmedTemplateV1({
        source: normalizedContent,
        ...(extension === '.doc' ? { originalSourceSha256: source.sourceSha256 } : {}),
        report: source.report,
        decision: source.decision,
        ...(replacementImages.size ? { replacementImages } : {}),
      })
    } finally {
      if (manifestId) this.options.documentReviewRenderer?.release(manifestId)
    }
  }

  private async createPreview(content: Buffer): Promise<string> {
    await mkdir(this.options.tempRoot, { recursive: true })
    const directory = await mkdtemp(join(this.options.tempRoot, 'operation-'))
    const path = join(directory, '小规模板预览.docx')
    try {
      await writeFile(path, content, { flag: 'wx' })
      if ((await fileSha256(path)) !== sha256(content)) {
        throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_GENERATION_FAILED')
      }
      return path
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  private async openPreview(path: string): Promise<void> {
    const error = await this.options.outputAccess.openPath(path)
    if (error) throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_PREVIEW_OPEN_FAILED')
  }

  private releasePreviewSession(record: StoredTemplateMaterializeRecordV1): void {
    const manifestId = this.previewManifestIds.get(record.operationId)
    if (manifestId) this.options.documentReviewRenderer?.release(manifestId)
    this.previewManifestIds.delete(record.operationId)
    this.previewConfirmationTokens.delete(record.operationId)
  }

  private async prepareInternalPreview(
    record: StoredTemplateMaterializeRecordV1,
    sourceDisplayName: string,
    content: Buffer,
    signal?: AbortSignal,
  ): Promise<{
    preview: TemplateMaterializePreviewRequestV1
    previewConfirmationToken: string
  }> {
    this.releasePreviewSession(record)
    const timestamp = this.now().toISOString()
    const renderer = this.options.documentReviewRenderer
    const prepared = renderer ? await renderer.prepare(content, 'DOCX', signal) : null
    if (prepared) this.previewManifestIds.set(record.operationId, prepared.manifestId)
    // 旧测试/嵌入环境尚未注入页面渲染器时，保留原来的只读外部预览作为明确降级。
    else await this.openPreview(record.previewPath)

    const previewConfirmationToken = `xgtmc1_${randomUUID()}`
    this.previewConfirmationTokens.set(record.operationId, previewConfirmationToken)
    const sourceName = parse(sourceDisplayName).name || '文档'
    return {
      previewConfirmationToken,
      preview: {
        previewVersion: 1,
        document: {
          reviewVersion: 3,
          reviewId: record.operationId,
          status: 'PREVIEWING',
          source: {
            displayName: `${sourceName}-模板.docx`,
            sha256: record.plan.previewSha256,
            byteLength: content.byteLength,
            inputFormat: 'DOCX',
          },
          render: prepared?.render ?? {
            mode: 'STRUCTURED_FALLBACK',
            paginationBasis: 'UNKNOWN',
            approximatePageCount: null,
            warnings: [{
              code: 'STRUCTURED_FALLBACK_ACTIVE',
              message: '当前环境未接入内置页面渲染，已打开只读文档预览。',
            }],
          },
          targetCount: 0,
          pendingTargetCount: 0,
          resolvedTargetCount: 0,
          unmappedTargetCount: 0,
          requiresHumanConfirmation: true,
          sourceReadOnly: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        plan: record.plan,
        suggestedTemplateName: `${sourceName}模板`,
      },
    }
  }

  private async prepare(
    address: SessionAddressV1,
    sourceRunId: string,
    reportId: string | undefined,
    signal?: AbortSignal,
  ): Promise<TemplateMaterializeServiceOutcomeV1> {
    if (this.options.store.latest(address, ['PREPARED'])) {
      return failure('TEMPLATE_MATERIALIZE_OPERATION_ACTIVE')
    }
    const source = this.confirmedSource(address, reportId)
    const built = await this.build(source)
    if (signal?.aborted) return failure('TEMPLATE_MATERIALIZE_ABORTED')
    const previewPath = await this.createPreview(built.content)
    const now = this.now().toISOString()
    const record: StoredTemplateMaterializeRecordV1 = {
      operationId: `xgtm1_${randomUUID()}`,
      address,
      reportId: source.report.reportId,
      sourcePath: source.sourcePath,
      sourceSha256: source.sourceSha256,
      decisionSha256: built.decisionSha256,
      preparedRunId: sourceRunId,
      previewPath,
      plan: built.plan,
      status: 'PREPARED',
      createdAt: now,
      updatedAt: now,
    }
    try {
      this.options.store.create(record)
    } catch (error) {
      await rm(dirname(previewPath), { recursive: true, force: true }).catch(() => {})
      throw error
    }
    const previewSession = await this.prepareInternalPreview(
      record,
      source.sourceDisplayName,
      built.content,
      signal,
    )
    return {
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PREPARED',
        plan: built.plan,
        ...previewSession,
      },
    }
  }

  private async reload(
    record: StoredTemplateMaterializeRecordV1,
  ): Promise<{
    source: ConfirmedTemplateIntakeMaterializationSourceV1
    built: Awaited<ReturnType<typeof materializeConfirmedTemplateV1>>
  }> {
    const source = this.confirmedSource(record.address, record.reportId)
    if (source.sourceSha256 !== record.sourceSha256) {
      record.status = 'STALE'
      record.updatedAt = this.now().toISOString()
      this.options.store.save(record)
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_SOURCE_CHANGED')
    }
    const built = await this.build(source)
    if (built.decisionSha256 !== record.decisionSha256) {
      record.status = 'STALE'
      record.updatedAt = this.now().toISOString()
      this.options.store.save(record)
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_DECISION_CHANGED')
    }
    if (built.plan.previewSha256 !== record.plan.previewSha256) {
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_GENERATION_FAILED')
    }
    return { source, built }
  }

  private receipt(
    record: StoredTemplateMaterializeRecordV1,
    publishedAtLocal = localIso(this.now()),
    library?: TemplateMaterializeReceiptV1['library'],
  ): TemplateMaterializeReceiptV1 {
    return {
      receiptVersion: 1,
      reportId: record.reportId,
      sourceSha256: record.sourceSha256,
      decisionSha256: record.decisionSha256,
      outputSha256: record.plan.previewSha256,
      variableNames: [...new Set(record.plan.variables.map((item) => item.name))],
      repeatBlockNames: [...new Set(record.plan.repeatBlocks.map((item) => item.name))],
      conditionalBlockNames: [...new Set(record.plan.conditionalBlocks.map((item) => item.name))],
      excludedCandidateCount: record.plan.excludedCandidateCount,
      removedMediaCount: record.plan.removedMediaCount,
      originalSourceUnchanged: true,
      publishedAtLocal,
      ...(library ? { library } : {}),
    }
  }

  private libraryFields(record: StoredTemplateMaterializeRecordV1): TemplateLibraryFieldSummaryV1[] {
    return [
      ...record.plan.variables.map((item, index) => ({
        fieldId: `text-${index + 1}`,
        name: item.name,
        kind: 'TEXT' as const,
        required: true,
      })),
      ...record.plan.repeatBlocks.map((item, index) => ({
        fieldId: `repeat-${index + 1}`,
        name: item.name,
        kind: 'REPEAT' as const,
        required: false,
      })),
      ...record.plan.conditionalBlocks.map((item, index) => ({
        fieldId: `conditional-${index + 1}`,
        name: item.name,
        kind: 'CONDITIONAL' as const,
        required: false,
      })),
    ]
  }

  private async saveToLibrary(
    record: StoredTemplateMaterializeRecordV1,
    source: ConfirmedTemplateIntakeMaterializationSourceV1,
    built: Awaited<ReturnType<typeof materializeConfirmedTemplateV1>>,
    metadata: { templateName?: string; purpose?: string; tags?: readonly string[] },
  ): Promise<TemplateMaterializeServiceOutcomeV1> {
    const library = this.options.templateLibrary
    if (!library) throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_LIBRARY_SAVE_FAILED')
    let configuration = await library.getConfiguration()
    if (!configuration.configured) {
      configuration = await this.options.configureTemplateLibrary?.() ?? { configured: false }
    }
    if (!configuration.configured) {
      return {
        ok: true,
        value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_TARGET_SELECTION_CANCELLED' },
      }
    }
    const fallbackName = `${parse(source.sourceDisplayName).name || '文档'}模板`
    const saveMetadata: TemplateLibrarySaveMetadataV1 = {
      name: metadata.templateName?.trim() || fallbackName,
      ...(metadata.purpose?.trim() ? { purpose: metadata.purpose.trim() } : {}),
      ...(metadata.tags?.length ? { tags: metadata.tags } : {}),
      fields: this.libraryFields(record),
    }
    try {
      const saved = await library.saveFromBuffer(built.content, saveMetadata)
      const resolved = await library.resolveVersionForUse(saved.version.versionId)
      record.publishedPath = resolved.assetPath
      const receipt = this.receipt(record, localIso(this.now()), {
        entryId: saved.entry.entryId,
        versionId: saved.version.versionId,
        versionNumber: saved.version.versionNumber,
        templateName: saved.entry.name,
      })
      record.receipt = receipt
      record.status = 'PUBLISHED'
      record.updatedAt = this.now().toISOString()
      this.options.store.save(record)
      await rm(dirname(record.previewPath), { recursive: true, force: true }).catch(() => {})
      this.releasePreviewSession(record)
      return {
        ok: true,
        value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PUBLISHED', receipt },
      }
    } catch (error) {
      if (error instanceof TemplateLibraryServiceErrorV1) {
        throw new TemplateMaterializeServiceErrorV1(
          error.code === 'TEMPLATE_LIBRARY_NOT_CONFIGURED'
            ? 'TEMPLATE_MATERIALIZE_LIBRARY_NOT_CONFIGURED'
            : 'TEMPLATE_MATERIALIZE_LIBRARY_SAVE_FAILED',
        )
      }
      throw error
    }
  }

  private async finalizeExistingTarget(
    record: StoredTemplateMaterializeRecordV1,
  ): Promise<TemplateMaterializeServiceOutcomeV1 | null> {
    if (!record.publishedPath) return null
    const existingHash = await fileSha256(record.publishedPath)
    if (existingHash === null) return null
    if (existingHash !== record.plan.previewSha256) {
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_TARGET_EXISTS')
    }
    const receipt = record.receipt ?? this.receipt(record)
    record.receipt = receipt
    record.status = 'PUBLISHED'
    record.updatedAt = this.now().toISOString()
    this.options.store.save(record)
    await rm(dirname(record.previewPath), { recursive: true, force: true }).catch(() => {})
    this.releasePreviewSession(record)
    return {
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PUBLISHED', receipt },
    }
  }

  private async confirm(
    address: SessionAddressV1,
    _sourceRunId: string,
    metadata: { templateName?: string; purpose?: string; tags?: readonly string[] },
    previewConfirmationToken?: string,
  ): Promise<TemplateMaterializeServiceOutcomeV1> {
    const record = this.options.store.latest(address, ['PREPARED'])
    if (!record) return failure('TEMPLATE_MATERIALIZE_NO_PENDING_OPERATION')
    const confirmedInPreview =
      !!previewConfirmationToken &&
      this.previewConfirmationTokens.get(record.operationId) === previewConfirmationToken
    if (!confirmedInPreview) {
      return failure('TEMPLATE_MATERIALIZE_CONFIRMATION_REQUIRED')
    }
    const { source, built } = await this.reload(record)
    const reconciled = await this.finalizeExistingTarget(record)
    if (reconciled) return reconciled
    if (this.options.templateLibrary) {
      return this.saveToLibrary(record, source, built, metadata)
    }
    let target = record.publishedPath
    if (!target) {
      const selectedTarget = await this.options.dialogs.chooseNewTarget(
        suggestedTemplateName(source.sourceDisplayName),
      )
      if (!selectedTarget) {
        return {
          ok: true,
          value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_TARGET_SELECTION_CANCELLED' },
        }
      }
      target = selectedTarget
      await assertNewTarget(target, source.sourcePath)
      record.publishedPath = target
      record.updatedAt = this.now().toISOString()
      this.options.store.save(record)
    } else {
      await assertNewTarget(target, source.sourcePath)
    }
    if ((await fileSha256(source.sourcePath)) !== source.sourceSha256) {
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_SOURCE_CHANGED')
    }
    await publishNewTarget(target, built.content, record.operationId)
    if ((await fileSha256(target)) !== built.plan.previewSha256) {
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_PUBLISH_FAILED')
    }
    const receipt = this.receipt(record)
    record.receipt = receipt
    record.status = 'PUBLISHED'
    record.updatedAt = this.now().toISOString()
    try {
      this.options.store.save(record)
    } catch {
      // publishedPath was persisted before publication; RESUME can reconcile this exact hash.
    }
    await rm(dirname(record.previewPath), { recursive: true, force: true }).catch(() => {})
    this.releasePreviewSession(record)
    return {
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PUBLISHED', receipt },
    }
  }

  private async resume(
    address: SessionAddressV1,
    signal?: AbortSignal,
  ): Promise<TemplateMaterializeServiceOutcomeV1> {
    const published = this.options.store.latest(address, ['PUBLISHED'])
    const prepared = this.options.store.latest(address, ['PREPARED'])
    const record = prepared ?? published
    if (!record) return failure('TEMPLATE_MATERIALIZE_NO_PENDING_OPERATION')
    if (record.status === 'PUBLISHED') {
      if (!record.receipt) return failure('TEMPLATE_MATERIALIZE_STORAGE_FAILED')
      return {
        ok: true,
        value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_RESUMED', receipt: record.receipt },
      }
    }
    const { source, built } = await this.reload(record)
    const reconciled = await this.finalizeExistingTarget(record)
    if (reconciled) return reconciled
    if (signal?.aborted) return failure('TEMPLATE_MATERIALIZE_ABORTED')
    await rm(dirname(record.previewPath), { recursive: true, force: true }).catch(() => {})
    record.previewPath = await this.createPreview(built.content)
    record.plan = built.plan
    record.updatedAt = this.now().toISOString()
    this.options.store.save(record)
    const previewSession = await this.prepareInternalPreview(
      record,
      source.sourceDisplayName,
      built.content,
      signal,
    )
    return {
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_RESUMED',
        plan: record.plan,
        ...previewSession,
      },
    }
  }

  private async cancel(address: SessionAddressV1): Promise<TemplateMaterializeServiceOutcomeV1> {
    const record = this.options.store.latest(address, ['PREPARED'])
    if (record) {
      record.status = 'CANCELLED'
      record.updatedAt = this.now().toISOString()
      this.options.store.save(record)
      await rm(dirname(record.previewPath), { recursive: true, force: true }).catch(() => {})
      this.releasePreviewSession(record)
    }
    return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_CANCELLED' } }
  }

  private async accessOutput(
    address: SessionAddressV1,
    action: 'OPEN' | 'REVEAL',
  ): Promise<TemplateMaterializeServiceOutcomeV1> {
    const record = this.options.store.latest(address, ['PUBLISHED'])
    if (!record?.publishedPath || !record.receipt) {
      return failure('TEMPLATE_MATERIALIZE_NO_PUBLISHED_OUTPUT')
    }
    if ((await fileSha256(record.publishedPath)) !== record.receipt.outputSha256) {
      return failure('TEMPLATE_MATERIALIZE_NO_PUBLISHED_OUTPUT')
    }
    if (action === 'OPEN') {
      const error = await this.options.outputAccess.openPath(record.publishedPath)
      if (error) return failure('TEMPLATE_MATERIALIZE_NO_PUBLISHED_OUTPUT')
    } else {
      await this.options.outputAccess.revealPath(record.publishedPath)
    }
    return {
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_ACCESSED', action },
    }
  }

  private async exportCopy(
    address: SessionAddressV1,
  ): Promise<TemplateMaterializeServiceOutcomeV1> {
    const record = this.options.store.latest(address, ['PUBLISHED'])
    if (!record?.publishedPath || !record.receipt) {
      return failure('TEMPLATE_MATERIALIZE_NO_PUBLISHED_OUTPUT')
    }
    const content = await readFile(record.publishedPath)
    if (sha256(content) !== record.receipt.outputSha256) {
      return failure('TEMPLATE_MATERIALIZE_NO_PUBLISHED_OUTPUT')
    }
    const selectedTarget = await this.options.dialogs.chooseNewTarget(
      `${record.receipt.library?.templateName ?? '小规模板'}.docx`,
    )
    if (!selectedTarget) {
      return {
        ok: true,
        value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_TARGET_SELECTION_CANCELLED' },
      }
    }
    await assertNewTarget(selectedTarget, record.sourcePath)
    await publishNewTarget(selectedTarget, content, `export-${record.operationId}-${randomUUID()}`)
    if ((await fileSha256(selectedTarget)) !== record.receipt.outputSha256) {
      throw new TemplateMaterializeServiceErrorV1('TEMPLATE_MATERIALIZE_PUBLISH_FAILED')
    }
    return {
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_EXPORTED',
        outputSha256: record.receipt.outputSha256,
      },
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }
}
