import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

import type { SupportedFileType } from 'officeparser/slim'

import {
  WORK_MATERIALS_SNAPSHOT_VERSION_V1,
  type WorkMaterialFileV1,
  type WorkMaterialsSnapshotV1,
  type WorkMaterialWarningV1,
} from '@shared/xiaogui-work-materials'

const MAX_FILES = 2_500
const MAX_DIRECTORIES = 1_000
const MAX_DEPTH = 16
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_CONTENT_CHARACTERS_PER_FILE = 100_000
const MAX_CONTENT_CHARACTERS_TOTAL = 500_000
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_ZIP_ENTRIES = 1_000
const MAX_TABLE_CELLS = 200_000
const SKIPPED_INFRASTRUCTURE_DIRECTORIES = new Set(['.git', 'node_modules'])

const OFFICE_TYPES = new Map<string, SupportedFileType>([
  ['.docx', 'docx'],
  ['.pptx', 'pptx'],
  ['.xlsx', 'xlsx'],
  ['.odt', 'odt'],
  ['.odp', 'odp'],
  ['.ods', 'ods'],
  ['.pdf', 'pdf'],
  ['.rtf', 'rtf'],
  ['.epub', 'epub'],
])

const KNOWN_TEXT_EXTENSIONS = new Set([
  '.txt', '.text', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonc', '.yaml', '.yml',
  '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.ini', '.cfg', '.conf', '.log',
  '.sql', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cc', '.cpp',
  '.h', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.ps1', '.bat', '.cmd', '.tex',
])

type OfficeTextExtractorV1 = (
  content: Buffer,
  fileType: SupportedFileType,
  signal: AbortSignal,
) => Promise<string>

export interface WorkMaterialsServiceOptionsV1 {
  extractOfficeText?: OfficeTextExtractorV1
}

export interface WorkMaterialsReadInputV1 {
  cwd: string
  /** 绝对或相对路径均可；省略时读取当前 cwd。 */
  paths?: readonly string[]
}

type CandidateV1 = {
  absolutePath: string
  byteSize: number
  symbolicLink: boolean
}

function sliceUnicode(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value
  return Array.from(value).slice(0, maxCharacters).join('')
}

function normalizedText(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

function looksLikeText(content: Buffer): boolean {
  if (content.length === 0) return true
  const sample = content.subarray(0, Math.min(content.length, 16_384))
  let zeroBytes = 0
  for (const byte of sample) if (byte === 0) zeroBytes += 1
  if (zeroBytes > 0) return false
  const decoded = sample.toString('utf8')
  const replacementCharacters = decoded.match(/\uFFFD/g)?.length ?? 0
  return replacementCharacters <= Math.max(2, Math.floor(decoded.length * 0.01))
}

const defaultOfficeTextExtractorV1: OfficeTextExtractorV1 = async (content, fileType, signal) => {
  // 普通聊天和纯文本整理不承担 Office 解析器冷启动成本。
  const { parseOffice } = await import('officeparser/slim')
  const ast = await parseOffice(content, {
    fileType,
    ocr: false,
    extractAttachments: false,
    includeRawContent: false,
    ignoreComments: false,
    ignoreHeadersAndFooters: false,
    abortSignal: signal,
    decompressionLimits: {
      maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
      maxZipEntries: MAX_ZIP_ENTRIES,
      maxTableCells: MAX_TABLE_CELLS,
    },
  })
  return ast.toText()
}

async function collectCandidates(
  input: WorkMaterialsReadInputV1,
  signal: AbortSignal,
): Promise<{
  requestedPaths: string[]
  candidates: CandidateV1[]
  directoryCount: number
  warnings: WorkMaterialWarningV1[]
}> {
  const requested = input.paths?.length ? input.paths : [input.cwd]
  const requestedPaths = requested.map((value) => resolve(input.cwd, value))
  const candidates: CandidateV1[] = []
  const warnings = new Set<WorkMaterialWarningV1>()
  const visited = new Set<string>()
  let directoryCount = 0
  let inventoryTruncated = false

  const visit = async (path: string, depth: number): Promise<void> => {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (candidates.length >= MAX_FILES || directoryCount >= MAX_DIRECTORIES || depth > MAX_DEPTH) {
      inventoryTruncated = true
      return
    }
    let info
    try {
      info = await lstat(path)
    } catch {
      candidates.push({ absolutePath: path, byteSize: 0, symbolicLink: false })
      return
    }
    if (info.isSymbolicLink()) {
      candidates.push({ absolutePath: path, byteSize: info.size, symbolicLink: true })
      return
    }
    if (info.isFile()) {
      const physical = await realpath(path).catch(() => resolve(path))
      if (visited.has(physical)) return
      visited.add(physical)
      candidates.push({ absolutePath: physical, byteSize: info.size, symbolicLink: false })
      return
    }
    if (!info.isDirectory()) {
      candidates.push({ absolutePath: path, byteSize: info.size, symbolicLink: false })
      return
    }
    const physicalDirectory = await realpath(path).catch(() => resolve(path))
    if (visited.has(physicalDirectory)) return
    visited.add(physicalDirectory)
    directoryCount += 1
    let entries
    try {
      entries = await readdir(physicalDirectory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
    for (const entry of entries) {
      if (candidates.length >= MAX_FILES || directoryCount >= MAX_DIRECTORIES) {
        inventoryTruncated = true
        break
      }
      if (entry.isDirectory() && SKIPPED_INFRASTRUCTURE_DIRECTORIES.has(entry.name)) {
        warnings.add('INFRASTRUCTURE_DIRECTORY_SKIPPED')
        continue
      }
      await visit(join(physicalDirectory, entry.name), depth + 1)
    }
  }

  for (const path of requestedPaths) await visit(path, 0)
  if (inventoryTruncated) warnings.add('INVENTORY_TRUNCATED')
  candidates.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath, undefined, { sensitivity: 'base' }))
  return { requestedPaths, candidates, directoryCount, warnings: [...warnings] }
}

function metadataOnly(
  candidate: CandidateV1,
  warnings: readonly WorkMaterialWarningV1[],
): WorkMaterialFileV1 {
  return {
    absolutePath: candidate.absolutePath,
    displayName: basename(candidate.absolutePath),
    extension: extname(candidate.absolutePath).toLocaleLowerCase(),
    byteSize: candidate.byteSize,
    status: 'METADATA_ONLY',
    extractor: 'METADATA',
    warnings,
  }
}

export class WorkMaterialsServiceV1 {
  private readonly extractOfficeText: OfficeTextExtractorV1

  constructor(options: WorkMaterialsServiceOptionsV1 = {}) {
    this.extractOfficeText = options.extractOfficeText ?? defaultOfficeTextExtractorV1
  }

  async read(input: WorkMaterialsReadInputV1, signal: AbortSignal): Promise<WorkMaterialsSnapshotV1> {
    const collected = await collectCandidates(input, signal)
    const files: WorkMaterialFileV1[] = []
    const aggregateWarnings = new Set<WorkMaterialWarningV1>(collected.warnings)
    let remainingCharacters = MAX_CONTENT_CHARACTERS_TOTAL

    for (const candidate of collected.candidates) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (candidate.symbolicLink) {
        files.push(metadataOnly(candidate, ['SYMLINK_NOT_FOLLOWED']))
        aggregateWarnings.add('SYMLINK_NOT_FOLLOWED')
        continue
      }
      if (candidate.byteSize > MAX_FILE_BYTES) {
        files.push(metadataOnly(candidate, ['FILE_TOO_LARGE']))
        aggregateWarnings.add('FILE_TOO_LARGE')
        continue
      }
      if (remainingCharacters <= 0) {
        files.push(metadataOnly(candidate, ['CONTENT_BUDGET_EXHAUSTED']))
        aggregateWarnings.add('CONTENT_BUDGET_EXHAUSTED')
        continue
      }

      let content: Buffer
      try {
        content = await readFile(candidate.absolutePath)
      } catch {
        files.push({
          ...metadataOnly(candidate, ['READ_FAILED']),
          status: 'READ_FAILED',
        })
        aggregateWarnings.add('READ_FAILED')
        continue
      }

      const extension = extname(candidate.absolutePath).toLocaleLowerCase()
      const officeType = OFFICE_TYPES.get(extension)
      let extracted = ''
      let extractor: WorkMaterialFileV1['extractor'] = 'METADATA'
      let parseFailed = false
      if (officeType) {
        try {
          extracted = normalizedText(await this.extractOfficeText(content, officeType, signal))
          extractor = 'OFFICEPARSER'
        } catch (error) {
          if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
          parseFailed = true
        }
      } else if (KNOWN_TEXT_EXTENSIONS.has(extension) || looksLikeText(content)) {
        extracted = normalizedText(content.toString('utf8'))
        extractor = 'PLAIN_TEXT'
      }

      if (!extracted) {
        const warning: WorkMaterialWarningV1 = parseFailed
          ? 'PARSE_FAILED'
          : officeType
            ? 'NO_TEXT_EXTRACTED'
            : 'FORMAT_NOT_SEMANTICALLY_SUPPORTED'
        files.push(metadataOnly(candidate, [warning]))
        aggregateWarnings.add(warning)
        continue
      }

      const available = Math.min(MAX_CONTENT_CHARACTERS_PER_FILE, remainingCharacters)
      const bounded = sliceUnicode(extracted, available)
      const truncated = bounded.length < extracted.length
      const warnings: WorkMaterialWarningV1[] = truncated ? ['CONTENT_TRUNCATED'] : []
      if (truncated) aggregateWarnings.add('CONTENT_TRUNCATED')
      remainingCharacters -= Array.from(bounded).length
      files.push({
        absolutePath: candidate.absolutePath,
        displayName: basename(candidate.absolutePath),
        extension,
        byteSize: candidate.byteSize,
        status: 'CONTENT_EXTRACTED',
        extractor,
        content: bounded,
        warnings,
      })
    }

    return {
      version: WORK_MATERIALS_SNAPSHOT_VERSION_V1,
      requestedPaths: collected.requestedPaths,
      totalFileCount: files.length,
      totalDirectoryCount: collected.directoryCount,
      extractedFileCount: files.filter((file) => file.status === 'CONTENT_EXTRACTED').length,
      metadataOnlyFileCount: files.filter((file) => file.status === 'METADATA_ONLY').length,
      failedFileCount: files.filter((file) => file.status === 'READ_FAILED').length,
      files,
      warnings: [...aggregateWarnings],
      originalInputsUnchanged: true,
    }
  }
}
