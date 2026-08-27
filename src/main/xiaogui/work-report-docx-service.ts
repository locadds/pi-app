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
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'

import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'

import type {
  WorkReportDocxErrorCodeV1,
  WorkReportDocxPlanV1,
  WorkReportDocxReceiptV1,
  WorkReportDraftV1,
} from '@shared/xiaogui-work-report-docx'
import type {
  XiaoguiWorkReportDocxPayloadV1,
  XiaoguiWorkReportDocxResultV1,
} from '@shared/worker-host-tools'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'

import {
  DOCX_SAFETY_MAX_FILE_BYTES_V1,
  DocxSafetyErrorV1,
  inspectSafeDocxArchiveV1,
} from './docx-safety'
import {
  WorkReportDocxStoreV1,
  type StoredWorkReportDocxRecordV1,
} from './work-report-docx-store'

const MAX_TITLE_CHARACTERS = 120
const MAX_SECTIONS = 20
const MAX_SECTION_ITEMS = 20
const MAX_BULLETS = 30
const MAX_ITEM_CHARACTERS = 4_000
const MAX_TOTAL_CHARACTERS = 30_000
const INVALID_XML_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u

type DialogPort = { chooseNewTarget(suggestedName: string): Promise<string | null> }
type OutputPort = { openPath(path: string): Promise<string>; revealPath(path: string): Promise<void> }

export interface WorkReportDocxServiceOptionsV1 {
  lookup: SessionScopeLookupV1
  store: WorkReportDocxStoreV1
  dialogs: DialogPort
  outputAccess: OutputPort
  tempRoot: string
  now?: () => Date
}

export type WorkReportDocxServiceOutcomeV1 =
  | { ok: true; value: XiaoguiWorkReportDocxResultV1 }
  | { ok: false; error: { code: WorkReportDocxErrorCodeV1 } }

class ServiceError extends Error {
  constructor(readonly code: WorkReportDocxErrorCodeV1) {
    super(code)
  }
}

const failure = (code: WorkReportDocxErrorCodeV1): WorkReportDocxServiceOutcomeV1 => ({
  ok: false,
  error: { code },
})
const hash = (content: Buffer): string => createHash('sha256').update(content).digest('hex')
const scopeKey = (address: SessionAddressV1): string =>
  `${address.projectId}\0${address.sessionKey}`

function cleanText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') throw new ServiceError('REPORT_DOCX_DRAFT_INVALID')
  const normalized = value.replace(/\r\n?/gu, '\n').trim()
  if (!normalized || normalized.length > maximum || INVALID_XML_CONTROL.test(normalized)) {
    throw new ServiceError('REPORT_DOCX_DRAFT_INVALID')
  }
  return normalized
}

function normalizeDraft(draft: WorkReportDraftV1): WorkReportDraftV1 {
  if (!draft || typeof draft !== 'object' || !Array.isArray(draft.sections)) {
    throw new ServiceError('REPORT_DOCX_DRAFT_INVALID')
  }
  if (draft.sections.length < 1 || draft.sections.length > MAX_SECTIONS) {
    throw new ServiceError('REPORT_DOCX_DRAFT_INVALID')
  }
  const normalized: WorkReportDraftV1 = {
    title: cleanText(draft.title, MAX_TITLE_CHARACTERS),
    sections: draft.sections.map((section) => {
      if (
        !section ||
        typeof section !== 'object' ||
        !Array.isArray(section.paragraphs) ||
        !Array.isArray(section.bullets) ||
        section.paragraphs.length > MAX_SECTION_ITEMS ||
        section.bullets.length > MAX_BULLETS
      ) {
        throw new ServiceError('REPORT_DOCX_DRAFT_INVALID')
      }
      return {
        heading: cleanText(section.heading, MAX_TITLE_CHARACTERS),
        paragraphs: section.paragraphs.map((item: unknown) => cleanText(item, MAX_ITEM_CHARACTERS)),
        bullets: section.bullets.map((item: unknown) => cleanText(item, MAX_ITEM_CHARACTERS)),
      }
    }),
  }
  if (draftCharacterCount(normalized) > MAX_TOTAL_CHARACTERS) {
    throw new ServiceError('REPORT_DOCX_DRAFT_TOO_LARGE')
  }
  return normalized
}

function draftCharacterCount(draft: WorkReportDraftV1): number {
  return (
    draft.title.length +
    draft.sections.reduce(
      (total, section) =>
        total +
        section.heading.length +
        section.paragraphs.reduce((sum, item) => sum + item.length, 0) +
        section.bullets.reduce((sum, item) => sum + item.length, 0),
      0,
    )
  )
}

async function renderDraft(draft: WorkReportDraftV1): Promise<Buffer> {
  try {
    const children: Paragraph[] = [
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        children: [new TextRun(draft.title)],
      }),
    ]
    for (const section of draft.sections) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun(section.heading)],
        }),
      )
      for (const paragraph of section.paragraphs) {
        children.push(new Paragraph({ children: [new TextRun(paragraph)] }))
      }
      for (const bullet of section.bullets) {
        children.push(
          new Paragraph({ bullet: { level: 0 }, children: [new TextRun(bullet)] }),
        )
      }
    }
    const document = new Document({
      creator: '小规',
      title: draft.title,
      description: '由小规根据当前 WORK 对话草稿生成的标准报告',
      styles: {
        default: {
          document: {
            run: { font: 'Microsoft YaHei', size: 24, color: '202124' },
            paragraph: { spacing: { line: 360, after: 160 } },
          },
          title: {
            run: { font: 'Microsoft YaHei', size: 40, bold: true, color: '1F2937' },
            paragraph: { spacing: { before: 120, after: 360 } },
          },
          heading1: {
            run: { font: 'Microsoft YaHei', size: 32, bold: true, color: '1F2937' },
            paragraph: { spacing: { before: 280, after: 160 }, keepNext: true },
          },
          listParagraph: {
            run: { font: 'Microsoft YaHei', size: 24, color: '202124' },
            paragraph: { spacing: { line: 360, after: 100 } },
          },
        },
      },
      sections: [
        {
          properties: {
            page: { margin: { top: 1_440, right: 1_440, bottom: 1_440, left: 1_440 } },
          },
          children,
        },
      ],
    })
    const content = await Packer.toBuffer(document)
    await inspectSafeDocxArchiveV1(content)
    return content
  } catch (error) {
    if (error instanceof ServiceError) throw error
    throw new ServiceError('REPORT_DOCX_RENDER_FAILED')
  }
}

function planFor(draft: WorkReportDraftV1, content: Buffer): WorkReportDocxPlanV1 {
  return {
    planVersion: 1,
    sectionCount: draft.sections.length,
    paragraphCount: draft.sections.reduce((sum, section) => sum + section.paragraphs.length, 0),
    bulletCount: draft.sections.reduce((sum, section) => sum + section.bullets.length, 0),
    characterCount: draftCharacterCount(draft),
    previewSha256: hash(content),
    preview: draft,
    requiresSecondConfirmation: true,
  }
}

function pathWithin(root: string, path: string): boolean {
  const normalizedRoot = resolve(root).toLocaleLowerCase()
  const normalizedPath = resolve(path).toLocaleLowerCase()
  return normalizedPath.startsWith(`${normalizedRoot}${sep}`)
}

async function createPreview(tempRoot: string, content: Buffer): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  const directory = await mkdtemp(join(tempRoot, 'operation-'))
  const path = join(directory, '小规标准报告预览.docx')
  try {
    await writeFile(path, content, { flag: 'wx' })
    if (hash(await readFile(path)) !== hash(content)) {
      throw new ServiceError('REPORT_DOCX_RENDER_FAILED')
    }
    return path
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function readPreview(
  tempRoot: string,
  record: StoredWorkReportDocxRecordV1,
): Promise<Buffer> {
  if (!pathWithin(tempRoot, record.previewPath)) {
    throw new ServiceError('REPORT_DOCX_PREVIEW_CHANGED')
  }
  try {
    const info = await lstat(record.previewPath)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > DOCX_SAFETY_MAX_FILE_BYTES_V1 ||
      extname(record.previewPath).toLowerCase() !== '.docx'
    ) {
      throw new ServiceError('REPORT_DOCX_PREVIEW_CHANGED')
    }
    const content = await readFile(record.previewPath)
    if (hash(content) !== record.plan.previewSha256) {
      throw new ServiceError('REPORT_DOCX_PREVIEW_CHANGED')
    }
    await inspectSafeDocxArchiveV1(content)
    return content
  } catch (error) {
    if (error instanceof ServiceError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ServiceError('REPORT_DOCX_PREVIEW_MISSING')
    }
    if (error instanceof DocxSafetyErrorV1) {
      throw new ServiceError('REPORT_DOCX_PREVIEW_CHANGED')
    }
    throw new ServiceError('REPORT_DOCX_PREVIEW_CHANGED')
  }
}

async function removePreview(tempRoot: string, path: string): Promise<void> {
  if (!pathWithin(tempRoot, path)) return
  await rm(dirname(path), { recursive: true, force: true }).catch(() => {})
}

function suggestedFileName(title: string): string {
  const stem = title
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .slice(0, 80)
  const safe = stem && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem) ? stem : '标准报告'
  return `${safe}.docx`
}

async function assertNewTarget(target: string): Promise<void> {
  if (!isAbsolute(target) || extname(target).toLowerCase() !== '.docx') {
    throw new ServiceError('REPORT_DOCX_TARGET_INVALID')
  }
  try {
    await access(target, fsConstants.F_OK)
    throw new ServiceError('REPORT_DOCX_TARGET_EXISTS')
  } catch (error) {
    if (error instanceof ServiceError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ServiceError('REPORT_DOCX_TARGET_INVALID')
    }
  }
  try {
    const parent = dirname(target)
    const info = await lstat(parent)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      resolve(parent).toLocaleLowerCase() !== (await realpath(parent)).toLocaleLowerCase()
    ) {
      throw new ServiceError('REPORT_DOCX_TARGET_INVALID')
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error
    throw new ServiceError('REPORT_DOCX_TARGET_INVALID')
  }
}

async function publish(target: string, content: Buffer, operationId: string): Promise<void> {
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
      throw new ServiceError('REPORT_DOCX_TARGET_EXISTS')
    }
    throw new ServiceError('REPORT_DOCX_PUBLISH_FAILED')
  } finally {
    if (created) await unlink(temporary).catch(() => {})
  }
}

function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absolute = Math.abs(offset)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

export class WorkReportDocxServiceV1 {
  private readonly activeScopes = new Set<string>()

  constructor(private readonly options: WorkReportDocxServiceOptionsV1) {}

  async execute(
    address: SessionAddressV1,
    payload: XiaoguiWorkReportDocxPayloadV1,
    signal?: AbortSignal,
  ): Promise<WorkReportDocxServiceOutcomeV1> {
    const admission = await this.admission(address)
    if (admission) return failure(admission)
    if (signal?.aborted) return failure('REPORT_DOCX_ABORTED')
    const key = scopeKey(address)
    if (this.activeScopes.has(key)) return failure('REPORT_DOCX_OPERATION_ACTIVE')
    this.activeScopes.add(key)
    try {
      switch (payload.action) {
        case 'PREPARE':
          return await this.prepare(address, payload.sourceRunId, payload.draft, signal)
        case 'CONFIRM':
          return await this.confirm(address, payload.sourceRunId)
        case 'CANCEL':
          return await this.cancel(address)
        case 'OPEN':
        case 'REVEAL':
          return await this.accessOutput(address, payload.action)
      }
    } catch (error) {
      if (error instanceof ServiceError) return failure(error.code)
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return failure('REPORT_DOCX_ABORTED')
      }
      return failure('REPORT_DOCX_STORAGE_FAILED')
    } finally {
      this.activeScopes.delete(key)
    }
  }

  close(): void {
    this.activeScopes.clear()
    this.options.store.close()
  }

  private async admission(
    address: SessionAddressV1,
  ): Promise<WorkReportDocxErrorCodeV1 | null> {
    const lookup = await this.options.lookup.lookup(address)
    if (lookup.kind === 'NOT_FOUND') return 'REPORT_DOCX_SCOPE_NOT_FOUND'
    if (lookup.kind === 'PROJECT_MISMATCH') return 'REPORT_DOCX_SCOPE_MISMATCH'
    if (lookup.scope.sessionMode !== 'WORK') return 'REPORT_DOCX_MODE_NOT_ALLOWED'
    return null
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private async openPreview(path: string): Promise<void> {
    if (await this.options.outputAccess.openPath(path)) {
      throw new ServiceError('REPORT_DOCX_PREVIEW_OPEN_FAILED')
    }
  }

  private async prepare(
    address: SessionAddressV1,
    sourceRunId: string,
    input: WorkReportDraftV1,
    signal?: AbortSignal,
  ): Promise<WorkReportDocxServiceOutcomeV1> {
    const draft = normalizeDraft(input)
    const existing = this.options.store.latest(address, ['PREPARED'])
    if (existing) {
      if (JSON.stringify(existing.draft) !== JSON.stringify(draft)) {
        return failure('REPORT_DOCX_OPERATION_ACTIVE')
      }
      try {
        await readPreview(this.options.tempRoot, existing)
      } catch (error) {
        if (
          !(error instanceof ServiceError) ||
          (error.code !== 'REPORT_DOCX_PREVIEW_MISSING' &&
            error.code !== 'REPORT_DOCX_PREVIEW_CHANGED')
        ) {
          throw error
        }
        await removePreview(this.options.tempRoot, existing.previewPath)
        const regenerated = await renderDraft(existing.draft)
        if (signal?.aborted) return failure('REPORT_DOCX_ABORTED')
        existing.previewPath = await createPreview(this.options.tempRoot, regenerated)
        existing.plan = planFor(existing.draft, regenerated)
      }
      if (!existing.publishedPath) throw new ServiceError('REPORT_DOCX_STORAGE_FAILED')
      await assertNewTarget(existing.publishedPath)
      existing.preparedRunId = sourceRunId
      existing.updatedAt = this.now().toISOString()
      this.options.store.save(existing)
      await this.openPreview(existing.previewPath)
      return {
        ok: true,
        value: { kind: 'XIAOGUI_WORK_REPORT_DOCX_PREPARED', plan: existing.plan },
      }
    }
    const content = await renderDraft(draft)
    if (signal?.aborted) return failure('REPORT_DOCX_ABORTED')
    const previewPath = await createPreview(this.options.tempRoot, content)
    const selected = await this.options.dialogs.chooseNewTarget(suggestedFileName(draft.title))
    if (!selected) {
      await removePreview(this.options.tempRoot, previewPath)
      return {
        ok: true,
        value: { kind: 'XIAOGUI_WORK_REPORT_DOCX_TARGET_SELECTION_CANCELLED' },
      }
    }
    if (signal?.aborted) {
      await removePreview(this.options.tempRoot, previewPath)
      return failure('REPORT_DOCX_ABORTED')
    }
    try {
      await assertNewTarget(selected)
    } catch (error) {
      await removePreview(this.options.tempRoot, previewPath)
      throw error
    }
    const now = this.now().toISOString()
    const record: StoredWorkReportDocxRecordV1 = {
      operationId: `xgrd1_${randomUUID()}`,
      address,
      draft,
      status: 'PREPARED',
      preparedRunId: sourceRunId,
      previewPath,
      plan: planFor(draft, content),
      publishedPath: selected,
      createdAt: now,
      updatedAt: now,
    }
    try {
      this.options.store.create(record)
    } catch (error) {
      await removePreview(this.options.tempRoot, previewPath)
      throw error
    }
    await this.openPreview(previewPath)
    return {
      ok: true,
      value: { kind: 'XIAOGUI_WORK_REPORT_DOCX_PREPARED', plan: record.plan },
    }
  }

  private receipt(record: StoredWorkReportDocxRecordV1): WorkReportDocxReceiptV1 {
    return {
      receiptVersion: 1,
      sectionCount: record.plan.sectionCount,
      paragraphCount: record.plan.paragraphCount,
      bulletCount: record.plan.bulletCount,
      characterCount: record.plan.characterCount,
      outputSha256: record.plan.previewSha256,
      publishedAtLocal: localIso(this.now()),
    }
  }

  private async confirm(
    address: SessionAddressV1,
    sourceRunId: string,
  ): Promise<WorkReportDocxServiceOutcomeV1> {
    const record = this.options.store.latest(address, ['PREPARED'])
    if (!record) return failure('REPORT_DOCX_NO_PENDING_OPERATION')
    if (record.preparedRunId === sourceRunId) {
      return failure('REPORT_DOCX_CONFIRMATION_REQUIRED')
    }
    const content = await readPreview(this.options.tempRoot, record)
    const target = record.publishedPath
    if (!target) throw new ServiceError('REPORT_DOCX_STORAGE_FAILED')
    let existing: Buffer | null = null
    try {
      existing = await readFile(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing && hash(existing) === record.plan.previewSha256) {
      record.receipt ??= this.receipt(record)
      record.status = 'PUBLISHED'
      record.updatedAt = this.now().toISOString()
      this.options.store.save(record)
      await removePreview(this.options.tempRoot, record.previewPath)
      return {
        ok: true,
        value: { kind: 'XIAOGUI_WORK_REPORT_DOCX_PUBLISHED', receipt: record.receipt },
      }
    }
    if (existing) return failure('REPORT_DOCX_TARGET_EXISTS')
    await assertNewTarget(target)
    await publish(target, content, record.operationId)
    if (hash(await readFile(target)) !== record.plan.previewSha256) {
      throw new ServiceError('REPORT_DOCX_PUBLISH_FAILED')
    }
    record.receipt = this.receipt(record)
    record.status = 'PUBLISHED'
    record.updatedAt = this.now().toISOString()
    try {
      this.options.store.save(record)
    } catch {
      /* publishedPath is durable; a later CONFIRM can converge from the exact hash */
    }
    await removePreview(this.options.tempRoot, record.previewPath)
    return {
      ok: true,
      value: { kind: 'XIAOGUI_WORK_REPORT_DOCX_PUBLISHED', receipt: record.receipt },
    }
  }

  private async cancel(address: SessionAddressV1): Promise<WorkReportDocxServiceOutcomeV1> {
    const record = this.options.store.latest(address, ['PREPARED'])
    if (record) {
      record.status = 'CANCELLED'
      record.updatedAt = this.now().toISOString()
      this.options.store.save(record)
      await removePreview(this.options.tempRoot, record.previewPath)
    }
    return { ok: true, value: { kind: 'XIAOGUI_WORK_REPORT_DOCX_CANCELLED' } }
  }

  private async accessOutput(
    address: SessionAddressV1,
    action: 'OPEN' | 'REVEAL',
  ): Promise<WorkReportDocxServiceOutcomeV1> {
    const record = this.options.store.latest(address, ['PUBLISHED'])
    if (!record?.publishedPath || !record.receipt) {
      return failure('REPORT_DOCX_NO_PUBLISHED_OUTPUT')
    }
    try {
      if (hash(await readFile(record.publishedPath)) !== record.receipt.outputSha256) {
        return failure('REPORT_DOCX_NO_PUBLISHED_OUTPUT')
      }
      if (action === 'OPEN') {
        if (await this.options.outputAccess.openPath(record.publishedPath)) {
          return failure('REPORT_DOCX_NO_PUBLISHED_OUTPUT')
        }
      } else {
        await this.options.outputAccess.revealPath(record.publishedPath)
      }
      return { ok: true, value: { kind: 'XIAOGUI_WORK_REPORT_DOCX_ACCESSED', action } }
    } catch {
      return failure('REPORT_DOCX_NO_PUBLISHED_OUTPUT')
    }
  }
}
