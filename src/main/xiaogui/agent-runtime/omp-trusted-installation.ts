import { createHash } from 'node:crypto'
import {
  lstatSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  OMP_ACP_APPROVED_VERSION_V1,
  OMP_ACP_SOURCE_REVISION_V1,
} from './omp-acp-adapter'

export const OMP_ACP_APPROVED_PACKAGE_NAME_V1 = '@oh-my-pi/pi-coding-agent'
export const OMP_ACP_APPROVED_NPM_INTEGRITY_V1 =
  'sha512-azsUetojUyT2e+CyDPun2LgFrCts8FtnvBlbPrzYj6Y7UbRIkdebqhNZVhMrOrueNnRsLetqcrY8EPomxTlvCg=='
export const OMP_ACP_APPROVED_ARCHIVE_URL_V1 =
  'https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/-/pi-coding-agent-18.1.2.tgz'
export const OMP_ACP_ENTRY_RELATIVE_PATH_V1 = 'dist/cli.js'

/**
 * Extracted-tree trust root derived from the pinned npm archive after its
 * SHA-512 SRI was verified. A caller cannot replace this evidence with a
 * matching version string or a self-asserted integrity value.
 */
const OMP_ACP_APPROVED_PACKAGE_MEASUREMENT_V1 = Object.freeze({
  packageJsonDigest: 'sha256:34571a48e10b2c8860e3ca6531d50611c95deeb0c0eda69bf89b3bb8284a948d',
  entryDigest: 'sha256:8ed76a9e7a0aa09d7190b4cf700a546b172923a94ea775334ef0f0145235c5cd',
  treeDigest: 'sha256:159d43dce438cc5a26fde64639d755612f5c97eb8067e8650487542495a685da',
  packageFileCount: 3_136,
  packageByteLength: 48_326_575,
})

const MAX_PACKAGE_FILES = 20_000
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024

interface OmpPackageMeasurementV1 {
  readonly packageJsonDigest: string
  readonly entryDigest: string
  readonly treeDigest: string
  readonly packageFileCount: number
  readonly packageByteLength: number
}

export interface OmpTrustedInstallationReceiptV1 {
  readonly schemaVersion: 1
  readonly packageName: typeof OMP_ACP_APPROVED_PACKAGE_NAME_V1
  readonly version: typeof OMP_ACP_APPROVED_VERSION_V1
  readonly sourceRevision: typeof OMP_ACP_SOURCE_REVISION_V1
  readonly npmIntegrity: typeof OMP_ACP_APPROVED_NPM_INTEGRITY_V1
  readonly packageArchiveUrl: typeof OMP_ACP_APPROVED_ARCHIVE_URL_V1
  readonly entryRelativePath: typeof OMP_ACP_ENTRY_RELATIVE_PATH_V1
  readonly packageJsonDigest: string
  readonly entryDigest: string
  readonly treeDigest: string
  readonly packageFileCount: number
  readonly packageByteLength: number
  readonly privateStateDirDigest: string
  readonly recordedAt: string
  readonly receiptDigest: string
}

export type OmpTrustedInstallationInspectionV1 =
  | { readonly ok: true; readonly receipt: OmpTrustedInstallationReceiptV1 }
  | { readonly ok: false; readonly reasonCode: string }

export interface OmpTrustedInstallationOptionsV1 {
  readonly packageRoot: string
  readonly privateStateDir: string
  readonly receiptPath: string
  readonly now?: () => string
}

/**
 * Verifies an already acquired fixed OMP package against the independently
 * pinned extracted-tree trust root and records an immutable local receipt. A
 * PATH version string or caller-provided integrity assertion is never accepted.
 */
export class OmpTrustedInstallationModuleV1 {
  private readonly packageRoot: string
  private readonly privateStateDir: string
  private readonly receiptPath: string
  private readonly now: () => string

  constructor(options: OmpTrustedInstallationOptionsV1) {
    this.packageRoot = exactAbsolutePath(options.packageRoot, 'OMP_INSTALL_ROOT_INVALID')
    this.privateStateDir = exactAbsolutePath(options.privateStateDir, 'OMP_STATE_DIR_INVALID')
    this.receiptPath = exactAbsolutePath(options.receiptPath, 'OMP_RECEIPT_PATH_INVALID')
    this.now = options.now ?? (() => new Date().toISOString())
  }

  recordVerifiedInstallation(): OmpTrustedInstallationReceiptV1 {
    if (existsSync(this.receiptPath)) {
      const existing = this.inspect()
      if (existing.ok) return existing.receipt
      throw new Error('OMP_INSTALLATION_RECEIPT_CONFLICT')
    }
    const measured = this.measurePackage()
    mkdirSync(this.privateStateDir, { recursive: true })
    const privateStateDirDigest = this.measurePrivateStateDir()
    const recordedAt = validTimestamp(this.now())
    const unsigned = {
      schemaVersion: 1 as const,
      packageName: OMP_ACP_APPROVED_PACKAGE_NAME_V1,
      version: OMP_ACP_APPROVED_VERSION_V1,
      sourceRevision: OMP_ACP_SOURCE_REVISION_V1,
      npmIntegrity: OMP_ACP_APPROVED_NPM_INTEGRITY_V1,
      packageArchiveUrl: OMP_ACP_APPROVED_ARCHIVE_URL_V1,
      entryRelativePath: OMP_ACP_ENTRY_RELATIVE_PATH_V1,
      packageJsonDigest: measured.packageJsonDigest,
      entryDigest: measured.entryDigest,
      treeDigest: measured.treeDigest,
      packageFileCount: measured.packageFileCount,
      packageByteLength: measured.packageByteLength,
      privateStateDirDigest,
      recordedAt,
    } as const satisfies Omit<OmpTrustedInstallationReceiptV1, 'receiptDigest'>
    const receipt: OmpTrustedInstallationReceiptV1 = Object.freeze({
      ...unsigned,
      receiptDigest: digestText(JSON.stringify(unsigned)),
    })
    mkdirSync(dirname(this.receiptPath), { recursive: true })
    const temporary = `${this.receiptPath}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      renameSync(temporary, this.receiptPath)
    } finally {
      rmSync(temporary, { force: true })
    }
    return receipt
  }

  inspect(): OmpTrustedInstallationInspectionV1 {
    try {
      const raw = JSON.parse(readFileSync(this.receiptPath, 'utf8')) as unknown
      const receipt = canonicalReceipt(raw)
      const measured = this.measurePackage()
      const privateStateDirDigest = this.measurePrivateStateDir()
      if (
        receipt.packageJsonDigest !== measured.packageJsonDigest ||
        receipt.entryDigest !== measured.entryDigest ||
        receipt.treeDigest !== measured.treeDigest ||
        receipt.packageFileCount !== measured.packageFileCount ||
        receipt.packageByteLength !== measured.packageByteLength ||
        receipt.privateStateDirDigest !== privateStateDirDigest
      ) return { ok: false, reasonCode: 'OMP_INSTALLATION_TAMPERED' }
      return { ok: true, receipt }
    } catch (error) {
      return {
        ok: false,
        reasonCode: error instanceof Error && /^OMP_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : 'OMP_INSTALLATION_RECEIPT_INVALID',
      }
    }
  }

  private measurePackage(): {
    readonly packageJsonDigest: string
    readonly entryDigest: string
    readonly treeDigest: string
    readonly packageFileCount: number
    readonly packageByteLength: number
  } {
    const packageRoot = realpathSync.native(this.packageRoot)
    if (!lstatSync(packageRoot).isDirectory() || pathKey(packageRoot) !== pathKey(this.packageRoot)) {
      throw new Error('OMP_INSTALL_ROOT_INVALID')
    }
    const packageJsonPath = safePackageFile(packageRoot, 'package.json')
    const entryPath = safePackageFile(packageRoot, OMP_ACP_ENTRY_RELATIVE_PATH_V1)
    const packageJsonBytes = readFileSync(packageJsonPath)
    const packageJson = JSON.parse(packageJsonBytes.toString('utf8')) as {
      name?: unknown
      version?: unknown
      license?: unknown
      bin?: unknown
    }
    if (
      packageJson.name !== OMP_ACP_APPROVED_PACKAGE_NAME_V1 ||
      packageJson.version !== OMP_ACP_APPROVED_VERSION_V1 ||
      packageJson.license !== 'MIT' ||
      !packageJson.bin ||
      typeof packageJson.bin !== 'object' ||
      (packageJson.bin as Record<string, unknown>).omp !== OMP_ACP_ENTRY_RELATIVE_PATH_V1
    ) throw new Error('OMP_PACKAGE_MANIFEST_UNAPPROVED')
    const files = packageFiles(packageRoot)
    const treeDigest = digestText(JSON.stringify(files.map((file) => ({
      relativePath: file.relativePath,
      byteLength: file.byteLength,
      digest: file.digest,
    }))))
    const measured = {
      packageJsonDigest: digestBytes(packageJsonBytes),
      entryDigest: digestBytes(readFileSync(entryPath)),
      treeDigest,
      packageFileCount: files.length,
      packageByteLength: files.reduce((total, file) => total + file.byteLength, 0),
    }
    if (!samePackageMeasurement(measured, OMP_ACP_APPROVED_PACKAGE_MEASUREMENT_V1)) {
      throw new Error('OMP_PACKAGE_CONTENT_UNAPPROVED')
    }
    return measured
  }

  private measurePrivateStateDir(): string {
    try {
      const stat = lstatSync(this.privateStateDir)
      const realStateDir = realpathSync.native(this.privateStateDir)
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        pathKey(realStateDir) !== pathKey(this.privateStateDir)
      ) throw new Error('OMP_PRIVATE_STATE_DIR_INVALID')
      return digestText(`xiaogui.omp.private-state.v1\0${pathKey(realStateDir)}`)
    } catch {
      throw new Error('OMP_PRIVATE_STATE_DIR_INVALID')
    }
  }
}

function packageFiles(root: string): readonly {
  readonly relativePath: string
  readonly byteLength: number
  readonly digest: string
}[] {
  const files: Array<{ relativePath: string; byteLength: number; digest: string }> = []
  let totalBytes = 0
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('OMP_PACKAGE_LINK_FORBIDDEN')
      if (stat.isDirectory()) {
        visit(path)
        continue
      }
      if (!stat.isFile()) throw new Error('OMP_PACKAGE_ENTRY_UNSUPPORTED')
      totalBytes += stat.size
      if (files.length >= MAX_PACKAGE_FILES || totalBytes > MAX_PACKAGE_BYTES) {
        throw new Error('OMP_PACKAGE_LIMIT_EXCEEDED')
      }
      const relativePath = relative(root, path).split(sep).join('/')
      files.push({ relativePath, byteLength: stat.size, digest: digestBytes(readFileSync(path)) })
    }
  }
  visit(root)
  return Object.freeze(files)
}

function safePackageFile(root: string, relativePath: string): string {
  const path = realpathSync.native(join(root, ...relativePath.split('/')))
  const prefix = `${pathKey(root)}${sep}`
  if (!pathKey(path).startsWith(prefix) || !lstatSync(path).isFile()) {
    throw new Error('OMP_PACKAGE_FILE_INVALID')
  }
  return path
}

function canonicalReceipt(value: unknown): OmpTrustedInstallationReceiptV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OMP_INSTALLATION_RECEIPT_INVALID')
  }
  const receipt = value as Record<string, unknown>
  const expectedKeys = [
    'schemaVersion',
    'packageName',
    'version',
    'sourceRevision',
    'npmIntegrity',
    'packageArchiveUrl',
    'entryRelativePath',
    'packageJsonDigest',
    'entryDigest',
    'treeDigest',
    'packageFileCount',
    'packageByteLength',
    'privateStateDirDigest',
    'recordedAt',
    'receiptDigest',
  ]
  if (Object.keys(receipt).sort().join('\0') !== [...expectedKeys].sort().join('\0')) {
    throw new Error('OMP_INSTALLATION_RECEIPT_INVALID')
  }
  if (
    receipt.schemaVersion !== 1 ||
    receipt.packageName !== OMP_ACP_APPROVED_PACKAGE_NAME_V1 ||
    receipt.version !== OMP_ACP_APPROVED_VERSION_V1 ||
    receipt.sourceRevision !== OMP_ACP_SOURCE_REVISION_V1 ||
    receipt.npmIntegrity !== OMP_ACP_APPROVED_NPM_INTEGRITY_V1 ||
    receipt.packageArchiveUrl !== OMP_ACP_APPROVED_ARCHIVE_URL_V1 ||
    receipt.entryRelativePath !== OMP_ACP_ENTRY_RELATIVE_PATH_V1 ||
    !isDigest(receipt.packageJsonDigest) ||
    !isDigest(receipt.entryDigest) ||
    !isDigest(receipt.treeDigest) ||
    !isSafeCount(receipt.packageFileCount, MAX_PACKAGE_FILES) ||
    !isSafeCount(receipt.packageByteLength, MAX_PACKAGE_BYTES) ||
    !isDigest(receipt.privateStateDirDigest) ||
    typeof receipt.recordedAt !== 'string' ||
    !isDigest(receipt.receiptDigest)
  ) throw new Error('OMP_INSTALLATION_RECEIPT_INVALID')
  const { receiptDigest, ...unsigned } = receipt
  if (receiptDigest !== digestText(JSON.stringify(unsigned))) {
    throw new Error('OMP_INSTALLATION_RECEIPT_INVALID')
  }
  return Object.freeze(receipt as unknown as OmpTrustedInstallationReceiptV1)
}

function samePackageMeasurement(
  actual: OmpPackageMeasurementV1,
  expected: OmpPackageMeasurementV1,
): boolean {
  return actual.packageJsonDigest === expected.packageJsonDigest &&
    actual.entryDigest === expected.entryDigest &&
    actual.treeDigest === expected.treeDigest &&
    actual.packageFileCount === expected.packageFileCount &&
    actual.packageByteLength === expected.packageByteLength
}

function exactAbsolutePath(value: string, errorCode: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !isAbsolute(value)) {
    throw new Error(errorCode)
  }
  return resolve(value)
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function digestText(value: string): string {
  return digestBytes(Buffer.from(value, 'utf8'))
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

function isSafeCount(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum
}

function validTimestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('OMP_INSTALLATION_TIMESTAMP_INVALID')
  }
  return value
}
