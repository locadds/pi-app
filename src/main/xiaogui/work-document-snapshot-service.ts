import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'

import { getDocumentProxy } from 'unpdf'
import type { PDFDocumentProxy } from 'unpdf/pdfjs'

import type {
  DocumentSnapshotPageV1,
  DocumentSnapshotV1,
  DocumentSnapshotWarningV1,
  WorkDocumentSnapshotErrorCodeV1,
  WorkDocumentSnapshotOutcomeV1,
  WorkDocumentSnapshotReadRequestV1,
  WorkDocumentSnapshotReadResultV1,
} from '@shared/xiaogui-document-snapshot'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'

/** 资源边界：与受控快照工单第四节保持一致。 */
const MAX_INPUT_BYTES = 20 * 1024 * 1024
const MAX_PAGES_PER_READ = 20
const MAX_PAGE_CHARS = 20_000
const MAX_TOTAL_CHARS = 100_000
const DEFAULT_PARSE_TIMEOUT_MS = 60_000
const MAX_DISPLAY_NAME_CHARS = 160
const UNSAFE_DISPLAY_NAME = /[\/\\\u0000-\u001f\u007f-\u009f]/
const PDF_HEADER = '%PDF-'

export type WorkDocumentSnapshotDialogPortV1 = {
  choosePdf(): Promise<string | null>
}

export type WorkDocumentSnapshotServiceOptionsV1 = {
  lookup: SessionScopeLookupV1
  dialogs: WorkDocumentSnapshotDialogPortV1
  tempRoot: string
  parseTimeoutMs?: number
}

type PageRangeV1 = { start: number; end: number }

class WorkDocumentSnapshotError extends Error {
  constructor(readonly code: WorkDocumentSnapshotErrorCodeV1) {
    super(code)
    this.name = 'WorkDocumentSnapshotError'
  }
}

function failure<T>(code: WorkDocumentSnapshotErrorCodeV1): WorkDocumentSnapshotOutcomeV1<T> {
  return { ok: false, error: { code, messageKey: `xiaogui.work.documentSnapshot.${code.toLowerCase()}` } }
}

function sha256OfBuffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 规范化文本：换行统一 LF、Unicode 统一 NFC、去掉每行末尾空白、
 * 去掉首尾空行；不折叠正文内部空格。
 */
export function normalizePageText(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, '\n').normalize('NFC')
  const lines = normalized.split('\n').map((line) => line.replace(/[ \t]+$/g, ''))
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

function safeDisplayName(path: string): string {
  const name = basename(path)
  if (name.length === 0 || name.length > MAX_DISPLAY_NAME_CHARS || UNSAFE_DISPLAY_NAME.test(name)) {
    throw new WorkDocumentSnapshotError('INPUT_INVALID')
  }
  return name
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkDocumentSnapshotError('PARSE_ABORTED')
}

async function readInput(path: string): Promise<Buffer> {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== '.pdf') {
    throw new WorkDocumentSnapshotError('INPUT_INVALID')
  }
  let content: Buffer
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new WorkDocumentSnapshotError('INPUT_INVALID')
    if (info.size > MAX_INPUT_BYTES) throw new WorkDocumentSnapshotError('INPUT_TOO_LARGE')
    content = await readFile(path)
  } catch (error) {
    if (error instanceof WorkDocumentSnapshotError) throw error
    throw new WorkDocumentSnapshotError('INPUT_INVALID')
  }
  // Close the lstat/read TOCTOU gap: a file that grew after admission is still rejected.
  if (content.byteLength > MAX_INPUT_BYTES) throw new WorkDocumentSnapshotError('INPUT_TOO_LARGE')
  if (content.subarray(0, PDF_HEADER.length).toString('latin1') !== PDF_HEADER) {
    throw new WorkDocumentSnapshotError('INPUT_INVALID')
  }
  return content
}

function normalizePageRange(startPage?: number, endPage?: number): PageRangeV1 {
  const start = startPage ?? 1
  const end = endPage ?? start + MAX_PAGES_PER_READ - 1
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new WorkDocumentSnapshotError('PAGE_RANGE_INVALID')
  }
  if (end - start + 1 > MAX_PAGES_PER_READ) throw new WorkDocumentSnapshotError('PAGE_RANGE_INVALID')
  return { start, end }
}

function joinTextItems(items: readonly unknown[]): string {
  let text = ''
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as { str?: unknown; hasEOL?: unknown }
    if (typeof candidate.str !== 'string') continue
    text += candidate.str
    if (candidate.hasEOL === true) text += '\n'
  }
  return text
}

function classifyParseError(error: unknown, fallback: WorkDocumentSnapshotErrorCodeV1): WorkDocumentSnapshotErrorCodeV1 {
  const name = (error as { name?: unknown })?.name
  const message = String((error as { message?: unknown })?.message ?? '')
  if (name === 'PasswordException' || /password/i.test(message)) return 'PDF_ENCRYPTED'
  if (name === 'InvalidPDFException' || /invalid pdf/i.test(message)) return 'PDF_CORRUPTED'
  return fallback
}

/** 让后台仍在收敛的解析（超时/中止后）在有限时间内完成代理销毁。 */
function settleBounded(promise: Promise<unknown> | null, boundMs = 5_000): Promise<void> {
  if (!promise) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, boundMs)
    promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      },
    )
  })
}

/**
 * 受控 PDF 文本快照服务。
 *
 * 主进程保证：系统选择器取文件、输入校验、原件 SHA-256 与副本隔离、
 * 逐页 unpdf 抽取（达到上限立即停止）、60 秒解析时限与取消响应、
 * 完成或失败都销毁 PDF 代理并清理临时目录、结束时复核原件未变化。
 * 产品代码只接触副本字节；本模块不安装、不调用 @napi-rs/canvas。
 *
 * 第三方许可（正式分发前需纳入发布 NOTICE/SBOM 门）：
 * - unpdf@1.6.2：MIT；
 * - unpdf 内嵌的 PDF.js（Mozilla）：Apache-2.0。
 */
export class WorkDocumentSnapshotServiceV1 {
  constructor(private readonly options: WorkDocumentSnapshotServiceOptionsV1) {}

  private async admit(address: SessionAddressV1): Promise<WorkDocumentSnapshotOutcomeV1<true>> {
    const lookup = await this.options.lookup.lookup(address)
    if (lookup.kind === 'NOT_FOUND') return failure('SCOPE_NOT_FOUND')
    if (lookup.kind === 'PROJECT_MISMATCH') return failure('SCOPE_MISMATCH')
    if (lookup.scope.sessionMode !== 'WORK') return failure('MODE_NOT_ALLOWED')
    return { ok: true, value: true }
  }

  private async extract(
    staged: string,
    range: PageRangeV1,
    deadline: number,
    signal: AbortSignal | undefined,
    displayName: string,
    sourceSha256: string,
  ): Promise<DocumentSnapshotV1> {
    let pdf: PDFDocumentProxy | null = null
    const assertAlive = (): void => {
      if (signal?.aborted) throw new WorkDocumentSnapshotError('PARSE_ABORTED')
      if (Date.now() >= deadline) throw new WorkDocumentSnapshotError('PARSE_TIMEOUT')
    }
    try {
      const stagedBytes = await readFile(staged)
      assertAlive()
      try {
        pdf = await getDocumentProxy(new Uint8Array(stagedBytes))
      } catch (error) {
        throw new WorkDocumentSnapshotError(classifyParseError(error, 'PARSE_FAILED'))
      }
      assertAlive()

      const numPages = pdf.numPages
      if (range.start > numPages) throw new WorkDocumentSnapshotError('PAGE_RANGE_INVALID')
      const lastPage = Math.min(range.end, numPages)

      const pages: DocumentSnapshotPageV1[] = []
      let totalChars = 0
      let truncated = false
      for (let pageNumber = range.start; pageNumber <= lastPage; pageNumber++) {
        assertAlive()
        let rawText: string
        try {
          const page = await pdf.getPage(pageNumber)
          try {
            const textContent = await page.getTextContent()
            rawText = joinTextItems(textContent.items)
          } finally {
            page.cleanup()
          }
        } catch (error) {
          throw new WorkDocumentSnapshotError(classifyParseError(error, 'PDF_CORRUPTED'))
        }
        assertAlive()
        const text = normalizePageText(rawText)
        if (text.length > MAX_PAGE_CHARS || totalChars + text.length > MAX_TOTAL_CHARS) {
          truncated = true
          break
        }
        totalChars += text.length
        pages.push({ pageNumber, text, textSha256: sha256OfText(text) })
      }

      const warnings: DocumentSnapshotWarningV1[] = []
      if (truncated || lastPage < numPages) warnings.push('TRUNCATED')
      if (!truncated && pages.length > 0 && pages.every((page) => page.text.length === 0)) {
        warnings.push('SCANNED_OR_EMPTY')
      }

      const contentSha256 = sha256OfText(
        JSON.stringify(pages.map((page) => ({ pageNumber: page.pageNumber, textSha256: page.textSha256 }))),
      )

      return {
        version: 'document-snapshot.v1',
        kind: 'PDF',
        sourceDisplayName: displayName,
        sourceSha256,
        extractorId: 'unpdf',
        extractorVersion: '1.6.2',
        pageCount: numPages,
        pages,
        contentSha256,
        warnings,
        originalInputUnchanged: true,
      }
    } finally {
      if (pdf) await pdf.destroy().catch(() => {})
    }
  }

  async read(
    request: WorkDocumentSnapshotReadRequestV1,
    signal?: AbortSignal,
  ): Promise<WorkDocumentSnapshotOutcomeV1<WorkDocumentSnapshotReadResultV1>> {
    const admitted = await this.admit(request.address)
    if (!admitted.ok) return admitted

    let stageDir: string | null = null
    let parsePromise: Promise<DocumentSnapshotV1> | null = null
    try {
      throwIfAborted(signal)
      const source = await this.options.dialogs.choosePdf()
      if (!source) return { ok: true, value: { kind: 'CANCELLED' } }
      throwIfAborted(signal)

      const displayName = safeDisplayName(source)
      const sourceBytes = await readInput(source)
      const sourceSha256 = sha256OfBuffer(sourceBytes)

      await mkdir(this.options.tempRoot, { recursive: true })
      stageDir = await mkdtemp(join(this.options.tempRoot, 'snapshot-'))
      const staged = join(stageDir, 'input.pdf')
      await writeFile(staged, sourceBytes, { flag: 'wx', mode: 0o600 })
      if (sha256OfBuffer(await readFile(staged)) !== sourceSha256) {
        throw new WorkDocumentSnapshotError('INPUT_INVALID')
      }

      const range = normalizePageRange(request.startPage, request.endPage)
      throwIfAborted(signal)

      const timeoutMs = this.options.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS
      const deadline = Date.now() + timeoutMs
      parsePromise = this.extract(staged, range, deadline, signal, displayName, sourceSha256)

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new WorkDocumentSnapshotError('PARSE_TIMEOUT')),
          Math.max(0, deadline - Date.now()),
        )
      })
      timeout.catch(() => {})
      let removeAbortListener = (): void => {}
      const cancelled = signal
        ? new Promise<never>((_, reject) => {
            const onAbort = (): void => reject(new WorkDocumentSnapshotError('PARSE_ABORTED'))
            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener('abort', onAbort, { once: true })
            removeAbortListener = () => signal.removeEventListener('abort', onAbort)
          })
        : null
      cancelled?.catch(() => {})
      let snapshot: DocumentSnapshotV1
      try {
        snapshot = await Promise.race(cancelled ? [parsePromise, timeout, cancelled] : [parsePromise, timeout])
      } finally {
        removeAbortListener()
        clearTimeout(timer)
      }
      throwIfAborted(signal)

      let finalSourceBytes: Buffer
      try {
        finalSourceBytes = await readInput(source)
      } catch {
        throw new WorkDocumentSnapshotError('SOURCE_CHANGED')
      }
      if (sha256OfBuffer(finalSourceBytes) !== sourceSha256) {
        throw new WorkDocumentSnapshotError('SOURCE_CHANGED')
      }

      return { ok: true, value: { kind: 'READY', snapshot } }
    } catch (error) {
      if (error instanceof WorkDocumentSnapshotError) return failure(error.code)
      return failure('PARSE_FAILED')
    } finally {
      await settleBounded(parsePromise)
      if (stageDir) {
        await rm(stageDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        }).catch(() => {})
      }
    }
  }
}
