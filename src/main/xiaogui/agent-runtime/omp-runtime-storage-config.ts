import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

interface OmpRuntimeStorageConfigRecordV1 {
  readonly schemaVersion: 1
  readonly selectedStorageDirectory: string
  readonly recordedAt: string
  readonly recordDigest: string
}

/**
 * Main-process-only persistence for the selected large runtime asset directory.
 * It deliberately does not use the general settings store, whose aggregate
 * response is visible to the Renderer.
 */
export class OmpRuntimeStorageConfigV1 {
  private readonly configPath: string
  private readonly now: () => string

  constructor(options: { readonly configPath: string; readonly now?: () => string }) {
    this.configPath = exactAbsolutePath(options.configPath, 'OMP_RUNTIME_STORAGE_CONFIG_PATH_INVALID')
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async read(): Promise<string | null> {
    try {
      const record = canonicalRecord(JSON.parse(await readFile(this.configPath, 'utf8')))
      return record.selectedStorageDirectory
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('OMP_RUNTIME_STORAGE_CONFIG_INVALID')
    }
  }

  async save(value: string): Promise<string> {
    const selectedStorageDirectory = exactAbsolutePath(value, 'OMP_RUNTIME_STORAGE_DIR_INVALID')
    const recordedAt = validTimestamp(this.now())
    const unsigned = { schemaVersion: 1 as const, selectedStorageDirectory, recordedAt }
    const record = Object.freeze({ ...unsigned, recordDigest: digestJson(unsigned) })
    await mkdir(dirname(this.configPath), { recursive: true })
    const temporary = `${this.configPath}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.configPath)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    return selectedStorageDirectory
  }
}

function canonicalRecord(value: unknown): OmpRuntimeStorageConfigRecordV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OMP_RUNTIME_STORAGE_CONFIG_INVALID')
  }
  const record = value as Record<string, unknown>
  const keys = ['schemaVersion', 'selectedStorageDirectory', 'recordedAt', 'recordDigest']
  if (Object.keys(record).sort().join('\0') !== keys.sort().join('\0')) {
    throw new Error('OMP_RUNTIME_STORAGE_CONFIG_INVALID')
  }
  if (
    record.schemaVersion !== 1 ||
    !validAbsolutePath(record.selectedStorageDirectory) ||
    typeof record.recordedAt !== 'string' ||
    typeof record.recordDigest !== 'string'
  ) throw new Error('OMP_RUNTIME_STORAGE_CONFIG_INVALID')
  validTimestamp(record.recordedAt)
  const { recordDigest, ...unsigned } = record
  if (recordDigest !== digestJson(unsigned)) throw new Error('OMP_RUNTIME_STORAGE_CONFIG_INVALID')
  return Object.freeze(record as unknown as OmpRuntimeStorageConfigRecordV1)
}

function exactAbsolutePath(value: string, code: string): string {
  if (!validAbsolutePath(value)) throw new Error(code)
  return resolve(value)
}

function validAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && isAbsolute(value)
}

function validTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error('OMP_RUNTIME_STORAGE_CONFIG_INVALID')
  return value
}

function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`
}
