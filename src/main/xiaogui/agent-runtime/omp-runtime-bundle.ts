import { availableParallelism } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  OMP_ACP_APPROVED_VERSION_V1,
  OMP_ACP_SAFE_ARGS_V1,
  OMP_ACP_SOURCE_REVISION_V1,
} from './omp-acp-adapter'
import {
  OMP_ACP_APPROVED_ARCHIVE_URL_V1,
  OMP_ACP_APPROVED_NPM_INTEGRITY_V1,
  OMP_ACP_APPROVED_PACKAGE_NAME_V1,
  OMP_ACP_ENTRY_RELATIVE_PATH_V1,
} from './omp-trusted-installation'

const ACTIVATION_POINTER_FILE = 'active-v1.json'
const BUNDLE_RECEIPT_FILE = 'bundle-receipt-v1.json'
const MAX_BUNDLE_FILES = 50_000
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024
const BUNDLE_DIRECTORY = /^bundle-[0-9a-f]{32}$/
const SHA256 = /^sha256:[0-9a-f]{64}$/

export interface OmpRuntimeBundleCriticalFileV1 {
  readonly relativePath: string
  readonly byteLength: number
  readonly digest: string
}

export interface OmpRuntimeBundleManifestV1 {
  readonly schemaVersion: 1
  readonly packageName: typeof OMP_ACP_APPROVED_PACKAGE_NAME_V1
  readonly version: typeof OMP_ACP_APPROVED_VERSION_V1
  readonly sourceRevision: typeof OMP_ACP_SOURCE_REVISION_V1
  readonly npmIntegrity: typeof OMP_ACP_APPROVED_NPM_INTEGRITY_V1
  readonly packageArchiveUrl: typeof OMP_ACP_APPROVED_ARCHIVE_URL_V1
  readonly entryRelativePath: typeof OMP_ACP_ENTRY_RELATIVE_PATH_V1
  readonly safeArgs: readonly string[]
  readonly rootPackageJsonDigest: string
  readonly dependencyLockDigest: string
  readonly treeDigest: string
  readonly fileCount: number
  readonly directoryCount: number
  readonly byteLength: number
  readonly criticalFiles: readonly OmpRuntimeBundleCriticalFileV1[]
  readonly manifestDigest: string
}

const OMP_RUNTIME_BUNDLE_MANIFEST_UNSIGNED_V1 = Object.freeze({
  schemaVersion: 1 as const,
  packageName: OMP_ACP_APPROVED_PACKAGE_NAME_V1,
  version: OMP_ACP_APPROVED_VERSION_V1,
  sourceRevision: OMP_ACP_SOURCE_REVISION_V1,
  npmIntegrity: OMP_ACP_APPROVED_NPM_INTEGRITY_V1,
  packageArchiveUrl: OMP_ACP_APPROVED_ARCHIVE_URL_V1,
  entryRelativePath: OMP_ACP_ENTRY_RELATIVE_PATH_V1,
  safeArgs: Object.freeze([...OMP_ACP_SAFE_ARGS_V1]),
  rootPackageJsonDigest: 'sha256:32d1c44fc1f6e9e006c7ee33cbd97e0c12c2dc84bfc3a43e922c6a43fe3bdc0e',
  dependencyLockDigest: 'sha256:eaee273001814f97cb4657730ee0f9715d1d6b298e9cdf67f7a69a4db0fa9e57',
  treeDigest: 'sha256:b1e7aacadfc4791ab7cd092e17b96bfb15781f7b220bfc7eabb7a6d430f98591',
  fileCount: 24_230,
  directoryCount: 2_144,
  byteLength: 802_081_247,
  criticalFiles: Object.freeze([
    Object.freeze({
      relativePath: 'package.json',
      byteLength: 129,
      digest: 'sha256:32d1c44fc1f6e9e006c7ee33cbd97e0c12c2dc84bfc3a43e922c6a43fe3bdc0e',
    }),
    Object.freeze({
      relativePath: 'bun.lock',
      byteLength: 48_998,
      digest: 'sha256:eaee273001814f97cb4657730ee0f9715d1d6b298e9cdf67f7a69a4db0fa9e57',
    }),
    Object.freeze({
      relativePath: 'node_modules/@oh-my-pi/pi-coding-agent/package.json',
      byteLength: 17_876,
      digest: 'sha256:34571a48e10b2c8860e3ca6531d50611c95deeb0c0eda69bf89b3bb8284a948d',
    }),
    Object.freeze({
      relativePath: 'node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js',
      byteLength: 21_366_713,
      digest: 'sha256:8ed76a9e7a0aa09d7190b4cf700a546b172923a94ea775334ef0f0145235c5cd',
    }),
    Object.freeze({
      relativePath: 'node_modules/@oh-my-pi/pi-natives/package.json',
      byteLength: 2_947,
      digest: 'sha256:98e167fb74db8f96158e08b511ebd20463f4038a9a10f2262663bb410ca175a9',
    }),
    Object.freeze({
      relativePath: 'node_modules/@oh-my-pi/pi-natives/native/index.js',
      byteLength: 7_452,
      digest: 'sha256:cda64abf00152a3be36068f1e70abef2859e26525b9dfef06832631b8282260d',
    }),
    Object.freeze({
      relativePath: 'node_modules/@oh-my-pi/pi-natives-win32-x64/package.json',
      byteLength: 464,
      digest: 'sha256:ff26d343fbfa78e558d8960629fafe6f90ab130288ad96af0a27b184b3e5da1e',
    }),
    Object.freeze({
      relativePath: 'node_modules/@oh-my-pi/pi-natives-win32-x64/pi_natives.win32-x64-baseline.node',
      byteLength: 175_602_176,
      digest: 'sha256:bdfdc8abaebd2feede9d9756059da7d50ec4e2bba4b82cc91310ab22444f895e',
    }),
  ]),
})

export const OMP_RUNTIME_BUNDLE_MANIFEST_V1: OmpRuntimeBundleManifestV1 = Object.freeze({
  ...OMP_RUNTIME_BUNDLE_MANIFEST_UNSIGNED_V1,
  manifestDigest: digestJson({
    domain: 'xiaogui.omp-runtime-bundle.manifest.v1',
    ...OMP_RUNTIME_BUNDLE_MANIFEST_UNSIGNED_V1,
  }),
})

export interface OmpRuntimeBundleMeasurementV1 {
  readonly rootPackageJsonDigest: string
  readonly dependencyLockDigest: string
  readonly treeDigest: string
  readonly fileCount: number
  readonly directoryCount: number
  readonly byteLength: number
  readonly criticalFiles: readonly OmpRuntimeBundleCriticalFileV1[]
}

export type OmpRuntimeBundleVerificationV1 =
  | { readonly ok: true; readonly measurement: OmpRuntimeBundleMeasurementV1 }
  | { readonly ok: false; readonly reasonCode: string }

export interface OmpRuntimeBundleVerificationPortV1 {
  verify(runtimeRoot: string): Promise<OmpRuntimeBundleVerificationV1>
}

export interface OmpRuntimeBundleStorageLayoutV1 {
  readonly selectedStorageDirectory: string
  readonly rootDir: string
  readonly versionsDir: string
  readonly activePointerPath: string
}

export interface OmpRuntimeBundleActivationReceiptV1 {
  readonly schemaVersion: 1
  readonly manifestDigest: string
  readonly packageName: typeof OMP_ACP_APPROVED_PACKAGE_NAME_V1
  readonly version: typeof OMP_ACP_APPROVED_VERSION_V1
  readonly sourceRevision: typeof OMP_ACP_SOURCE_REVISION_V1
  readonly entryRelativePath: typeof OMP_ACP_ENTRY_RELATIVE_PATH_V1
  readonly rootPackageJsonDigest: string
  readonly dependencyLockDigest: string
  readonly treeDigest: string
  readonly fileCount: number
  readonly directoryCount: number
  readonly byteLength: number
  readonly privateStateDirDigest: string
  readonly recordedAt: string
  readonly receiptDigest: string
}

export interface OmpRuntimeBundleActivationPointerV1 {
  readonly schemaVersion: 1
  readonly manifestDigest: string
  readonly version: typeof OMP_ACP_APPROVED_VERSION_V1
  readonly runtimeDirectoryName: string
  readonly bundleTreeDigest: string
  readonly activationReceiptDigest: string
  readonly activatedAt: string
  readonly pointerDigest: string
}

export type OmpActivatedRuntimeBundleInspectionV1 =
  | {
      readonly ok: true
      readonly runtimeRoot: string
      readonly packageRoot: string
      readonly receipt: OmpRuntimeBundleActivationReceiptV1
    }
  | { readonly ok: false; readonly reasonCode: string }

export interface OmpActivatedRuntimeBundleInspectionPortV1 {
  inspect(options?: { readonly fresh?: boolean }): Promise<OmpActivatedRuntimeBundleInspectionV1>
}

export type OmpRuntimeBundleAssemblyResultV1 =
  | {
      readonly ok: true
      readonly status: 'ACTIVATED' | 'ALREADY_ACTIVE'
      readonly activationReceiptDigest: string
      readonly manifestDigest: string
      readonly bundleByteLength: number
      readonly retainedPreviousActivation: boolean
    }
  | {
      readonly ok: false
      readonly reasonCode: string
      readonly requiredBytes?: number
      readonly availableBytes?: number
    }

/** Maps a user-selected private asset directory to the fixed, versioned OMP layout. */
export function resolveOmpRuntimeBundleStorageLayoutV1(
  selectedStorageDirectory: string,
): OmpRuntimeBundleStorageLayoutV1 {
  const selected = exactAbsolutePath(selectedStorageDirectory, 'OMP_RUNTIME_STORAGE_DIR_INVALID')
  const rootDir = join(selected, 'xiaogui', 'agent-runtime', `omp-v${OMP_ACP_APPROVED_VERSION_V1}`)
  return Object.freeze({
    selectedStorageDirectory: selected,
    rootDir,
    versionsDir: join(rootDir, 'versions'),
    activePointerPath: join(rootDir, ACTIVATION_POINTER_FILE),
  })
}

/** Full fixed-tree verifier. A matching package version alone is never sufficient. */
export class OmpRuntimeBundleVerifierV1 implements OmpRuntimeBundleVerificationPortV1 {
  async verify(runtimeRoot: string): Promise<OmpRuntimeBundleVerificationV1> {
    try {
      const measurement = await measureRuntimeBundle(runtimeRoot, OMP_RUNTIME_BUNDLE_MANIFEST_V1.criticalFiles)
      if (!sameMeasurement(measurement, OMP_RUNTIME_BUNDLE_MANIFEST_V1)) {
        return { ok: false, reasonCode: criticalFilesMatch(measurement, OMP_RUNTIME_BUNDLE_MANIFEST_V1)
          ? 'OMP_RUNTIME_BUNDLE_CONTENT_UNAPPROVED'
          : 'OMP_RUNTIME_BUNDLE_CRITICAL_DEPENDENCY_INVALID' }
      }
      return { ok: true, measurement }
    } catch (error) {
      return { ok: false, reasonCode: reasonCode(error, 'OMP_RUNTIME_BUNDLE_INSPECTION_FAILED') }
    }
  }
}

/**
 * Generic activation transaction used by the fixed production assembler and
 * deterministic fixture tests. Its verifier establishes trust; the production
 * wrapper below always supplies OmpRuntimeBundleVerifierV1 and the fixed manifest.
 */
export class OmpRuntimeBundleActivationTransactionV1 {
  private readonly layout: OmpRuntimeBundleStorageLayoutV1
  private readonly privateStateDir: string
  private readonly now: () => string

  constructor(private readonly options: {
    readonly selectedStorageDirectory: string
    readonly privateStateDir: string
    readonly manifest: OmpRuntimeBundleManifestV1
    readonly verifier: OmpRuntimeBundleVerificationPortV1
    readonly now?: () => string
  }) {
    this.layout = resolveOmpRuntimeBundleStorageLayoutV1(options.selectedStorageDirectory)
    this.privateStateDir = exactAbsolutePath(options.privateStateDir, 'OMP_STATE_DIR_INVALID')
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async installFrom(
    sourceRuntimeRoot: string,
    options?: { readonly forceReinstall?: boolean },
  ): Promise<OmpRuntimeBundleAssemblyResultV1> {
    const source = exactAbsolutePath(sourceRuntimeRoot, 'OMP_RUNTIME_BUNDLE_SOURCE_INVALID')
    let stagingRoot: string | undefined
    let activatedRoot: string | undefined
    let pointerCommitted = false
    try {
      assertNonOverlappingRoots(source, this.layout.rootDir)
      if (await pathExists(join(source, BUNDLE_RECEIPT_FILE))) {
        return { ok: false, reasonCode: 'OMP_RUNTIME_BUNDLE_SOURCE_NOT_PRISTINE' }
      }

      const current = await this.inspector().inspect({ fresh: true })
      if (
        current.ok &&
        current.receipt.manifestDigest === this.options.manifest.manifestDigest &&
        options?.forceReinstall !== true
      ) {
        return {
          ok: true,
          status: 'ALREADY_ACTIVE',
          activationReceiptDigest: current.receipt.receiptDigest,
          manifestDigest: current.receipt.manifestDigest,
          bundleByteLength: current.receipt.byteLength,
          retainedPreviousActivation: false,
        }
      }
      if (!current.ok && current.reasonCode !== 'OMP_RUNTIME_BUNDLE_NOT_ACTIVATED') {
        return { ok: false, reasonCode: current.reasonCode }
      }
      const previousPointerBytes = await readOptionalFile(this.layout.activePointerPath)

      const sourceVerification = await this.options.verifier.verify(source)
      if (!sourceVerification.ok) return sourceVerification

      await mkdir(this.layout.versionsDir, { recursive: true })
      const storageStats = await statfs(this.layout.versionsDir)
      const blockSize = Number(storageStats.bsize)
      const availableBytes = safeFsProduct(storageStats.bavail, storageStats.bsize)
      const requiredBytes = requiredStagingBytes(sourceVerification.measurement, blockSize)
      if (availableBytes < requiredBytes) {
        return {
          ok: false,
          reasonCode: 'OMP_RUNTIME_STORAGE_INSUFFICIENT',
          requiredBytes,
          availableBytes,
        }
      }

      stagingRoot = join(
        this.layout.versionsDir,
        `.staging-${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`,
      )
      await copyRuntimeTree(source, stagingRoot)
      const stagingVerification = await this.options.verifier.verify(stagingRoot)
      if (!stagingVerification.ok) return stagingVerification
      if (!sameMeasurement(sourceVerification.measurement, stagingVerification.measurement)) {
        return { ok: false, reasonCode: 'OMP_RUNTIME_BUNDLE_COPY_MISMATCH' }
      }

      await mkdir(this.privateStateDir, { recursive: true })
      const receipt = await recordActivationReceipt(
        stagingRoot,
        this.privateStateDir,
        this.options.manifest,
        stagingVerification.measurement,
        this.now,
      )
      const runtimeDirectoryName = `bundle-${receipt.receiptDigest.slice('sha256:'.length, 'sha256:'.length + 32)}`
      activatedRoot = join(this.layout.versionsDir, runtimeDirectoryName)
      if (await pathExists(activatedRoot)) {
        return { ok: false, reasonCode: 'OMP_RUNTIME_BUNDLE_VERSION_CONFLICT' }
      }
      await rename(stagingRoot, activatedRoot)
      stagingRoot = undefined

      const pointer = activationPointer(this.options.manifest, runtimeDirectoryName, receipt, this.now())
      await writeJsonAtomically(this.layout.activePointerPath, pointer)
      try {
        const committedPointer = canonicalPointer(
          JSON.parse(await readFile(this.layout.activePointerPath, 'utf8')),
          this.options.manifest,
        )
        const committedReceipt = canonicalReceipt(
          JSON.parse(await readFile(join(activatedRoot, BUNDLE_RECEIPT_FILE), 'utf8')),
          this.options.manifest,
        )
        if (committedPointer.activationReceiptDigest !== committedReceipt.receiptDigest) {
          throw new Error('OMP_RUNTIME_BUNDLE_ACTIVATION_FAILED')
        }
      } catch (error) {
        await restoreActivationPointer(this.layout.activePointerPath, previousPointerBytes)
        throw error
      }
      pointerCommitted = true
      return {
        ok: true,
        status: 'ACTIVATED',
        activationReceiptDigest: receipt.receiptDigest,
        manifestDigest: receipt.manifestDigest,
        bundleByteLength: receipt.byteLength,
        retainedPreviousActivation: current.ok,
      }
    } catch (error) {
      return { ok: false, reasonCode: reasonCode(error, 'OMP_RUNTIME_BUNDLE_INSTALL_FAILED') }
    } finally {
      if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      if (activatedRoot && !pointerCommitted) {
        await rm(activatedRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  private inspector(): OmpRuntimeBundleActivationInspectorV1 {
    return new OmpRuntimeBundleActivationInspectorV1({
      layout: this.layout,
      privateStateDir: this.privateStateDir,
      manifest: this.options.manifest,
      verifier: this.options.verifier,
    })
  }
}

/** Production assembler: only the fixed checked-in manifest can reach activation. */
export class OmpRuntimeBundleAssemblerV1 {
  private readonly transaction: OmpRuntimeBundleActivationTransactionV1

  constructor(options: {
    readonly selectedStorageDirectory: string
    readonly privateStateDir: string
    readonly now?: () => string
  }) {
    this.transaction = new OmpRuntimeBundleActivationTransactionV1({
      ...options,
      manifest: OMP_RUNTIME_BUNDLE_MANIFEST_V1,
      verifier: new OmpRuntimeBundleVerifierV1(),
    })
  }

  installFrom(
    sourceRuntimeRoot: string,
    options?: { readonly forceReinstall?: boolean },
  ): Promise<OmpRuntimeBundleAssemblyResultV1> {
    return this.transaction.installFrom(sourceRuntimeRoot, options)
  }
}

/** Production inspection caches one successful full-tree verification per process. */
export class OmpActivatedRuntimeBundleModuleV1 implements OmpActivatedRuntimeBundleInspectionPortV1 {
  private readonly inspector: OmpRuntimeBundleActivationInspectorV1

  constructor(options: { readonly selectedStorageDirectory: string; readonly privateStateDir: string }) {
    this.inspector = new OmpRuntimeBundleActivationInspectorV1({
      layout: resolveOmpRuntimeBundleStorageLayoutV1(options.selectedStorageDirectory),
      privateStateDir: exactAbsolutePath(options.privateStateDir, 'OMP_STATE_DIR_INVALID'),
      manifest: OMP_RUNTIME_BUNDLE_MANIFEST_V1,
      verifier: new OmpRuntimeBundleVerifierV1(),
    })
  }

  inspect(options?: { readonly fresh?: boolean }): Promise<OmpActivatedRuntimeBundleInspectionV1> {
    return this.inspector.inspect(options)
  }
}

export class OmpRuntimeBundleActivationInspectorV1 implements OmpActivatedRuntimeBundleInspectionPortV1 {
  private inspection?: Promise<OmpActivatedRuntimeBundleInspectionV1>

  constructor(private readonly options: {
    readonly layout: OmpRuntimeBundleStorageLayoutV1
    readonly privateStateDir: string
    readonly manifest: OmpRuntimeBundleManifestV1
    readonly verifier: OmpRuntimeBundleVerificationPortV1
  }) {}

  async inspect(options?: { readonly fresh?: boolean }): Promise<OmpActivatedRuntimeBundleInspectionV1> {
    if (options?.fresh) this.inspection = undefined
    if (this.inspection) {
      const cached = await this.inspection
      if (cached.ok) {
        const guarded = await this.guardCachedInspection(cached)
        if (guarded) {
          if (!guarded.ok) this.inspection = undefined
          return guarded
        }
      }
      this.inspection = undefined
    }
    this.inspection ??= this.inspectFresh()
    const result = await this.inspection
    if (!result.ok) this.inspection = undefined
    return result
  }

  private async inspectFresh(): Promise<OmpActivatedRuntimeBundleInspectionV1> {
    try {
      const { runtimeRoot, receipt } = await this.readActivationEnvelope()
      const verification = await this.options.verifier.verify(runtimeRoot)
      if (!verification.ok) return verification
      if (!sameMeasurement(verification.measurement, receipt)) {
        return { ok: false, reasonCode: 'OMP_RUNTIME_BUNDLE_ACTIVATION_INVALID' }
      }
      const packageRoot = await safeChildDirectory(
        runtimeRoot,
        'node_modules/@oh-my-pi/pi-coding-agent',
        'OMP_RUNTIME_BUNDLE_PACKAGE_INVALID',
      )
      return { ok: true, runtimeRoot, packageRoot, receipt }
    } catch (error) {
      return { ok: false, reasonCode: reasonCode(error, 'OMP_RUNTIME_BUNDLE_ACTIVATION_INVALID') }
    }
  }

  private async guardCachedInspection(
    cached: Extract<OmpActivatedRuntimeBundleInspectionV1, { readonly ok: true }>,
  ): Promise<OmpActivatedRuntimeBundleInspectionV1 | null> {
    try {
      const current = await this.readActivationEnvelope()
      if (
        pathKey(current.runtimeRoot) !== pathKey(cached.runtimeRoot) ||
        current.receipt.receiptDigest !== cached.receipt.receiptDigest
      ) return null
      const critical = await verifyCriticalFilesLive(current.runtimeRoot, this.options.manifest.criticalFiles)
      return critical.ok ? cached : critical
    } catch (error) {
      return { ok: false, reasonCode: reasonCode(error, 'OMP_RUNTIME_BUNDLE_ACTIVATION_INVALID') }
    }
  }

  private async readActivationEnvelope(): Promise<{
    readonly runtimeRoot: string
    readonly receipt: OmpRuntimeBundleActivationReceiptV1
  }> {
    if (!await pathExists(this.options.layout.activePointerPath)) {
      throw new Error('OMP_RUNTIME_BUNDLE_NOT_ACTIVATED')
    }
    const pointer = canonicalPointer(
      JSON.parse(await readFile(this.options.layout.activePointerPath, 'utf8')),
      this.options.manifest,
    )
    const runtimeRoot = safeVersionRoot(this.options.layout.versionsDir, pointer.runtimeDirectoryName)
    const receipt = canonicalReceipt(
      JSON.parse(await readFile(join(runtimeRoot, BUNDLE_RECEIPT_FILE), 'utf8')),
      this.options.manifest,
    )
    if (
      pointer.activationReceiptDigest !== receipt.receiptDigest ||
      pointer.bundleTreeDigest !== receipt.treeDigest ||
      receipt.privateStateDirDigest !== await privateStateDirDigest(this.options.privateStateDir)
    ) throw new Error('OMP_RUNTIME_BUNDLE_ACTIVATION_INVALID')
    return Object.freeze({ runtimeRoot, receipt })
  }
}

async function verifyCriticalFilesLive(
  runtimeRoot: string,
  criticalFiles: readonly OmpRuntimeBundleCriticalFileV1[],
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reasonCode: string }> {
  try {
    const root = await exactRealDirectory(runtimeRoot, 'OMP_RUNTIME_BUNDLE_ROOT_INVALID')
    const prefix = `${pathKey(root)}${sep}`
    const measured = await mapConcurrent(
      criticalFiles,
      Math.max(1, Math.min(availableParallelism(), 8)),
      async (expected) => {
        const absolutePath = resolve(root, ...expected.relativePath.split('/'))
        const info = await lstat(absolutePath)
        const actualPath = await realpath(absolutePath)
        if (
          !pathKey(absolutePath).startsWith(prefix) ||
          info.isSymbolicLink() ||
          !info.isFile() ||
          pathKey(actualPath) !== pathKey(absolutePath) ||
          info.size !== expected.byteLength
        ) throw new Error('OMP_RUNTIME_BUNDLE_CRITICAL_DEPENDENCY_INVALID')
        return {
          relativePath: expected.relativePath,
          byteLength: info.size,
          digest: await digestFile(absolutePath, info.size),
        }
      },
    )
    return measured.every((file, index) => {
      const expected = criticalFiles[index]
      return file.relativePath === expected?.relativePath &&
        file.byteLength === expected.byteLength &&
        file.digest === expected.digest
    })
      ? { ok: true }
      : { ok: false, reasonCode: 'OMP_RUNTIME_BUNDLE_CRITICAL_DEPENDENCY_INVALID' }
  } catch {
    return { ok: false, reasonCode: 'OMP_RUNTIME_BUNDLE_CRITICAL_DEPENDENCY_INVALID' }
  }
}

async function measureRuntimeBundle(
  runtimeRoot: string,
  criticalFiles: readonly OmpRuntimeBundleCriticalFileV1[],
): Promise<OmpRuntimeBundleMeasurementV1> {
  const root = await exactRealDirectory(runtimeRoot, 'OMP_RUNTIME_BUNDLE_ROOT_INVALID')
  const files: Array<{ absolutePath: string; relativePath: string; byteLength: number }> = []
  let directoryCount = 0
  let byteLength = 0

  const visit = async (directory: string): Promise<void> => {
    directoryCount += 1
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('OMP_RUNTIME_BUNDLE_LINK_FORBIDDEN')
      if (entry.isDirectory()) {
        await visit(absolutePath)
        continue
      }
      if (!entry.isFile()) throw new Error('OMP_RUNTIME_BUNDLE_ENTRY_UNSUPPORTED')
      const info = await lstat(absolutePath)
      const relativePath = relative(root, absolutePath).split(sep).join('/')
      if (relativePath === BUNDLE_RECEIPT_FILE) continue
      files.push({ absolutePath, relativePath, byteLength: info.size })
      byteLength += info.size
      if (files.length > MAX_BUNDLE_FILES || byteLength > MAX_BUNDLE_BYTES) {
        throw new Error('OMP_RUNTIME_BUNDLE_LIMIT_EXCEEDED')
      }
    }
  }
  await visit(root)

  const hashed = await mapConcurrent(files, Math.max(1, Math.min(availableParallelism(), 12)), async (file) => ({
    relativePath: file.relativePath,
    byteLength: file.byteLength,
    digest: await digestFile(file.absolutePath, file.byteLength),
  }))
  const byPath = new Map(hashed.map((file) => [file.relativePath, file]))
  const measuredCritical = criticalFiles.map((expected) => {
    const actual = byPath.get(expected.relativePath)
    return actual
      ? Object.freeze({
          relativePath: actual.relativePath,
          byteLength: actual.byteLength,
          digest: actual.digest,
        })
      : Object.freeze({ relativePath: expected.relativePath, byteLength: 0, digest: 'sha256:missing' })
  })
  return Object.freeze({
    rootPackageJsonDigest: byPath.get('package.json')?.digest ?? 'sha256:missing',
    dependencyLockDigest: byPath.get('bun.lock')?.digest ?? 'sha256:missing',
    treeDigest: digestText(`xiaogui.omp-runtime-bundle.tree.v1\0${JSON.stringify(hashed)}`),
    fileCount: hashed.length,
    directoryCount,
    byteLength,
    criticalFiles: Object.freeze(measuredCritical),
  })
}

async function digestFile(path: string, expectedSize: number): Promise<string> {
  const before = await stat(path)
  if (!before.isFile() || before.size !== expectedSize) throw new Error('OMP_RUNTIME_BUNDLE_FILE_CHANGED')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  const after = await stat(path)
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error('OMP_RUNTIME_BUNDLE_FILE_CHANGED')
  }
  return `sha256:${hash.digest('hex')}`
}

async function copyRuntimeTree(sourceRoot: string, targetRoot: string): Promise<void> {
  await mkdir(targetRoot, { recursive: false })
  const copyDirectory = async (source: string, target: string): Promise<void> => {
    const entries = (await readdir(source, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      const sourcePath = join(source, entry.name)
      const targetPath = join(target, entry.name)
      if (entry.isSymbolicLink()) throw new Error('OMP_RUNTIME_BUNDLE_LINK_FORBIDDEN')
      if (entry.isDirectory()) {
        await mkdir(targetPath)
        await copyDirectory(sourcePath, targetPath)
        continue
      }
      if (!entry.isFile()) throw new Error('OMP_RUNTIME_BUNDLE_ENTRY_UNSUPPORTED')
      await copyFile(sourcePath, targetPath)
    }
  }
  await copyDirectory(sourceRoot, targetRoot)
}

async function recordActivationReceipt(
  stagingRoot: string,
  privateStateDir: string,
  manifest: OmpRuntimeBundleManifestV1,
  measurement: OmpRuntimeBundleMeasurementV1,
  now: () => string,
): Promise<OmpRuntimeBundleActivationReceiptV1> {
  const recordedAt = validTimestamp(now())
  const unsigned = {
    schemaVersion: 1 as const,
    manifestDigest: manifest.manifestDigest,
    packageName: manifest.packageName,
    version: manifest.version,
    sourceRevision: manifest.sourceRevision,
    entryRelativePath: manifest.entryRelativePath,
    rootPackageJsonDigest: measurement.rootPackageJsonDigest,
    dependencyLockDigest: measurement.dependencyLockDigest,
    treeDigest: measurement.treeDigest,
    fileCount: measurement.fileCount,
    directoryCount: measurement.directoryCount,
    byteLength: measurement.byteLength,
    privateStateDirDigest: await privateStateDirDigest(privateStateDir),
    recordedAt,
  } as const
  const receipt = Object.freeze({ ...unsigned, receiptDigest: digestJson(unsigned) })
  await writeJsonAtomically(join(stagingRoot, BUNDLE_RECEIPT_FILE), receipt, false)
  return receipt
}

function activationPointer(
  manifest: OmpRuntimeBundleManifestV1,
  runtimeDirectoryName: string,
  receipt: OmpRuntimeBundleActivationReceiptV1,
  activatedAtValue: string,
): OmpRuntimeBundleActivationPointerV1 {
  const activatedAt = validTimestamp(activatedAtValue)
  const unsigned = {
    schemaVersion: 1 as const,
    manifestDigest: manifest.manifestDigest,
    version: manifest.version,
    runtimeDirectoryName,
    bundleTreeDigest: receipt.treeDigest,
    activationReceiptDigest: receipt.receiptDigest,
    activatedAt,
  } as const
  return Object.freeze({ ...unsigned, pointerDigest: digestJson(unsigned) })
}

function canonicalPointer(value: unknown, manifest: OmpRuntimeBundleManifestV1): OmpRuntimeBundleActivationPointerV1 {
  const expectedKeys = [
    'schemaVersion', 'manifestDigest', 'version', 'runtimeDirectoryName', 'bundleTreeDigest',
    'activationReceiptDigest', 'activatedAt', 'pointerDigest',
  ]
  const pointer = exactObject(value, expectedKeys, 'OMP_RUNTIME_BUNDLE_POINTER_INVALID')
  if (
    pointer.schemaVersion !== 1 ||
    pointer.manifestDigest !== manifest.manifestDigest ||
    pointer.version !== manifest.version ||
    typeof pointer.runtimeDirectoryName !== 'string' ||
    !BUNDLE_DIRECTORY.test(pointer.runtimeDirectoryName) ||
    pointer.bundleTreeDigest !== manifest.treeDigest ||
    !isDigest(pointer.activationReceiptDigest) ||
    typeof pointer.activatedAt !== 'string' ||
    !isDigest(pointer.pointerDigest)
  ) throw new Error('OMP_RUNTIME_BUNDLE_POINTER_INVALID')
  const { pointerDigest, ...unsigned } = pointer
  if (pointerDigest !== digestJson(unsigned)) throw new Error('OMP_RUNTIME_BUNDLE_POINTER_INVALID')
  validTimestamp(pointer.activatedAt as string)
  return Object.freeze(pointer as unknown as OmpRuntimeBundleActivationPointerV1)
}

function canonicalReceipt(value: unknown, manifest: OmpRuntimeBundleManifestV1): OmpRuntimeBundleActivationReceiptV1 {
  const expectedKeys = [
    'schemaVersion', 'manifestDigest', 'packageName', 'version', 'sourceRevision', 'entryRelativePath',
    'rootPackageJsonDigest', 'dependencyLockDigest', 'treeDigest', 'fileCount', 'directoryCount',
    'byteLength', 'privateStateDirDigest', 'recordedAt', 'receiptDigest',
  ]
  const receipt = exactObject(value, expectedKeys, 'OMP_RUNTIME_BUNDLE_RECEIPT_INVALID')
  if (
    receipt.schemaVersion !== 1 ||
    receipt.manifestDigest !== manifest.manifestDigest ||
    receipt.packageName !== manifest.packageName ||
    receipt.version !== manifest.version ||
    receipt.sourceRevision !== manifest.sourceRevision ||
    receipt.entryRelativePath !== manifest.entryRelativePath ||
    receipt.rootPackageJsonDigest !== manifest.rootPackageJsonDigest ||
    receipt.dependencyLockDigest !== manifest.dependencyLockDigest ||
    receipt.treeDigest !== manifest.treeDigest ||
    receipt.fileCount !== manifest.fileCount ||
    receipt.directoryCount !== manifest.directoryCount ||
    receipt.byteLength !== manifest.byteLength ||
    !isDigest(receipt.privateStateDirDigest) ||
    typeof receipt.recordedAt !== 'string' ||
    !isDigest(receipt.receiptDigest)
  ) throw new Error('OMP_RUNTIME_BUNDLE_RECEIPT_INVALID')
  const { receiptDigest, ...unsigned } = receipt
  if (receiptDigest !== digestJson(unsigned)) throw new Error('OMP_RUNTIME_BUNDLE_RECEIPT_INVALID')
  validTimestamp(receipt.recordedAt as string)
  return Object.freeze(receipt as unknown as OmpRuntimeBundleActivationReceiptV1)
}

async function privateStateDirDigest(value: string): Promise<string> {
  const lexical = exactAbsolutePath(value, 'OMP_STATE_DIR_INVALID')
  const actual = await exactRealDirectory(lexical, 'OMP_PRIVATE_STATE_DIR_INVALID')
  return digestText(`xiaogui.omp.private-state.v1\0${pathKey(actual)}`)
}

async function exactRealDirectory(value: string, code: string): Promise<string> {
  const lexical = exactAbsolutePath(value, code)
  const info = await lstat(lexical)
  const actual = await realpath(lexical)
  if (info.isSymbolicLink() || !info.isDirectory() || pathKey(actual) !== pathKey(lexical)) {
    throw new Error(code)
  }
  return actual
}

function safeVersionRoot(versionsDir: string, name: string): string {
  if (!BUNDLE_DIRECTORY.test(name)) throw new Error('OMP_RUNTIME_BUNDLE_POINTER_INVALID')
  const root = resolve(versionsDir, name)
  if (dirname(root) !== resolve(versionsDir)) throw new Error('OMP_RUNTIME_BUNDLE_POINTER_INVALID')
  return root
}

async function safeChildDirectory(root: string, relativePath: string, code: string): Promise<string> {
  const child = resolve(root, ...relativePath.split('/'))
  const prefix = `${pathKey(resolve(root))}${sep}`
  if (!pathKey(child).startsWith(prefix)) throw new Error(code)
  return exactRealDirectory(child, code)
}

async function writeJsonAtomically(path: string, value: unknown, replace = true): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    if (!replace && await pathExists(path)) throw new Error('OMP_RUNTIME_BUNDLE_RECEIPT_CONFLICT')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function sameMeasurement(
  actual: OmpRuntimeBundleMeasurementV1,
  expected: Pick<OmpRuntimeBundleManifestV1 | OmpRuntimeBundleActivationReceiptV1,
    'rootPackageJsonDigest' | 'dependencyLockDigest' | 'treeDigest' | 'fileCount' | 'directoryCount' | 'byteLength'>,
): boolean {
  return actual.rootPackageJsonDigest === expected.rootPackageJsonDigest &&
    actual.dependencyLockDigest === expected.dependencyLockDigest &&
    actual.treeDigest === expected.treeDigest &&
    actual.fileCount === expected.fileCount &&
    actual.directoryCount === expected.directoryCount &&
    actual.byteLength === expected.byteLength
}

function criticalFilesMatch(
  actual: OmpRuntimeBundleMeasurementV1,
  expected: OmpRuntimeBundleManifestV1,
): boolean {
  return actual.criticalFiles.length === expected.criticalFiles.length && actual.criticalFiles.every((file, index) => {
    const expectedFile = expected.criticalFiles[index]
    return file.relativePath === expectedFile?.relativePath &&
      file.byteLength === expectedFile.byteLength &&
      file.digest === expectedFile.digest
  })
}

function requiredStagingBytes(measurement: OmpRuntimeBundleMeasurementV1, blockSize: number): number {
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) throw new Error('OMP_RUNTIME_STORAGE_STATS_INVALID')
  const metadataEntries = measurement.fileCount + measurement.directoryCount + 1
  const value = measurement.byteLength + metadataEntries * blockSize
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('OMP_RUNTIME_STORAGE_STATS_INVALID')
  return value
}

function safeFsProduct(left: bigint | number, right: bigint | number): number {
  const value = Number(left) * Number(right)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('OMP_RUNTIME_STORAGE_STATS_INVALID')
  return value
}

function assertNonOverlappingRoots(source: string, target: string): void {
  const sourceKey = pathKey(resolve(source))
  const targetKey = pathKey(resolve(target))
  if (
    sourceKey === targetKey ||
    sourceKey.startsWith(`${targetKey}${sep}`) ||
    targetKey.startsWith(`${sourceKey}${sep}`)
  ) throw new Error('OMP_RUNTIME_BUNDLE_ROOT_OVERLAP')
}

function exactObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code)
  const object = value as Record<string, unknown>
  if (Object.keys(object).sort(compareText).join('\0') !== [...keys].sort(compareText).join('\0')) {
    throw new Error(code)
  }
  return object
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await map(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length || 1) }, () => worker()))
  return results
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function readOptionalFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function restoreActivationPointer(path: string, previous: Buffer | null): Promise<void> {
  if (previous === null) {
    await rm(path, { force: true })
    return
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.rollback.tmp`
  try {
    await writeFile(temporary, previous, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function exactAbsolutePath(value: string, code: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !isAbsolute(value)) throw new Error(code)
  return resolve(value)
}

function reasonCode(error: unknown, fallback: string): string {
  return error instanceof Error && /^OMP_[A-Z0-9_]+$/.test(error.message) ? error.message : fallback
}

function validTimestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('OMP_RUNTIME_BUNDLE_TIMESTAMP_INVALID')
  }
  return value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value))
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}
