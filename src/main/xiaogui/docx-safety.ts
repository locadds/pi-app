import JSZip, { type JSZipObject } from 'jszip'

export const DOCX_SAFETY_MAX_FILE_BYTES_V1 = 20 * 1024 * 1024
export const DOCX_SAFETY_MAX_UNCOMPRESSED_BYTES_V1 = 64 * 1024 * 1024
export const DOCX_SAFETY_MAX_ZIP_ENTRIES_V1 = 1_000

export type DocxSafetyErrorCodeV1 = 'INPUT_TOO_LARGE' | 'UNSAFE_DOCX'

export class DocxSafetyErrorV1 extends Error {
  constructor(readonly code: DocxSafetyErrorCodeV1) {
    super(code)
  }
}

export interface SafeDocxArchiveV1 {
  zip: JSZip
  entryCount: number
  expandedBytes: number
}

function zipUncompressedSize(entry: JSZipObject): number {
  if (entry.dir) return 0
  const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
  const size = Number(data?.uncompressedSize)
  if (!Number.isSafeInteger(size) || size < 0) throw new DocxSafetyErrorV1('UNSAFE_DOCX')
  return size
}

/**
 * WORK Word 能力共用的唯一 DOCX 安全门。
 * 只有此函数成功返回后，调用方才可以把同一 Buffer 交给后续解析器。
 */
export async function inspectSafeDocxArchiveV1(content: Buffer): Promise<SafeDocxArchiveV1> {
  if (content.byteLength > DOCX_SAFETY_MAX_FILE_BYTES_V1) {
    throw new DocxSafetyErrorV1('INPUT_TOO_LARGE')
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(content, { checkCRC32: true, createFolders: false })
  } catch {
    throw new DocxSafetyErrorV1('UNSAFE_DOCX')
  }

  const entries = Object.values(zip.files)
  if (entries.length === 0 || entries.length > DOCX_SAFETY_MAX_ZIP_ENTRIES_V1) {
    throw new DocxSafetyErrorV1('UNSAFE_DOCX')
  }

  let expandedBytes = 0
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/')
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new DocxSafetyErrorV1('UNSAFE_DOCX')
    }
    expandedBytes += zipUncompressedSize(entry)
    if (expandedBytes > DOCX_SAFETY_MAX_UNCOMPRESSED_BYTES_V1) {
      throw new DocxSafetyErrorV1('UNSAFE_DOCX')
    }
  }

  const contentTypes = zip.file('[Content_Types].xml')
  const documentXml = zip.file('word/document.xml')
  if (!contentTypes || !documentXml) throw new DocxSafetyErrorV1('UNSAFE_DOCX')

  const typeText = (await contentTypes.async('string')).toLowerCase()
  if (
    typeText.includes('macroenabled') ||
    entries.some((entry) => entry.name.toLowerCase().includes('vbaproject'))
  ) {
    throw new DocxSafetyErrorV1('UNSAFE_DOCX')
  }

  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith('.rels')) continue
    const relationships = await entry.async('string')
    if (/TargetMode\s*=\s*["']External["']/i.test(relationships)) {
      throw new DocxSafetyErrorV1('UNSAFE_DOCX')
    }
  }

  return { zip, entryCount: entries.length, expandedBytes }
}
