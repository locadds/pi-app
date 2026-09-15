import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'

import type { DeliveryTargetV1 } from '@shared/xiaogui-delivery'
import type { Sha256Digest } from '@shared/xiaogui-task-verification'

import type { ProjectWorkspaceResolverV1 } from './attempt-workspace'
import type {
  DeliveryIntegrationFileV1,
  DeliveryIntegrationFileV2,
  DeliveryIntegrationResultV1,
  DeliveryIntegrationWorktreePortV1,
  DeliveryIntegrationWorktreePortV2,
} from './delivery-composer'

export interface MainProcessDeliveryIntegrationWorktreeOptionsV1 {
  readonly projectResolver: ProjectWorkspaceResolverV1
  readonly managedRoot: string
  readonly target: DeliveryTargetV1
  readonly batchId: string
}

export class MainProcessDeliveryIntegrationWorktreePortV1 implements DeliveryIntegrationWorktreePortV1, DeliveryIntegrationWorktreePortV2 {
  constructor(private readonly options: MainProcessDeliveryIntegrationWorktreeOptionsV1) {}

  async integrate(files: readonly DeliveryIntegrationFileV1[]): Promise<DeliveryIntegrationResultV1> {
    return this.integrateFiles(files, 1)
  }

  /**
   * Versioned DELETE/CREATE seam. V1 deliberately remains CREATE/MODIFY-only;
   * this method reuses the same Main-owned Git worktree and baseline guards.
   */
  async integrateV2(files: readonly DeliveryIntegrationFileV2[]): Promise<DeliveryIntegrationResultV1> {
    return this.integrateFiles(files, 2)
  }

  private async integrateFiles(
    files: readonly DeliveryIntegrationFileV1[] | readonly DeliveryIntegrationFileV2[],
    version: 1 | 2,
  ): Promise<DeliveryIntegrationResultV1> {
    if (files.length === 0) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    if (version === 2) {
      const seen = new Set<string>()
      for (const file of files) {
        const relativePath = normalizeRelativePath(file.relativePath)
        const key = pathKey(relativePath)
        if (seen.has(key)) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
        seen.add(key)
      }
    }
    const managedRoot = await ensureManagedRoot(this.options.managedRoot)
    const repositoryRoot = await realpath(resolve(await this.options.projectResolver.resolveProjectRoot(this.options.target.projectId)))
    const worktreeRoot = resolve(managedRoot, safeDirectoryName(this.options.batchId))
    if (!isInside(managedRoot, worktreeRoot)) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_OUTSIDE_ROOT')

    await assertGitBaseline(repositoryRoot, this.options.target)
    const approvedBaselines = version === 1
      ? await readApprovedModifyBaselines(repositoryRoot, files as readonly DeliveryIntegrationFileV1[])
      : await readApprovedBaselinesV2(repositoryRoot, files as readonly DeliveryIntegrationFileV2[])
    if (existsSync(worktreeRoot)) {
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_BASELINE_DRIFT')
    }
    let worktreeAdded = false
    let failed: DeliveryIntegrationWorktreeErrorV1 | null = null
    try {
      await git(repositoryRoot, ['worktree', 'add', '--detach', worktreeRoot, this.options.target.baseRevision], 'DELIVERY_WORKTREE_WRITE_FAILED')
      worktreeAdded = true
      const realWorktreeRoot = await realpath(worktreeRoot)
      if (pathKey(realWorktreeRoot) !== pathKey(worktreeRoot) || !isInside(managedRoot, realWorktreeRoot)) {
        throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_OUTSIDE_ROOT')
      }
      await seedApprovedModifyBaselines(realWorktreeRoot, this.options.target.baseRevision, approvedBaselines)
      await assertGitBaseline(realWorktreeRoot, this.options.target)
      for (const file of files) {
        const relativePath = normalizeRelativePath(file.relativePath)
        const target = resolve(realWorktreeRoot, relativePath.replace(/\//g, sep))
        if (!isInside(realWorktreeRoot, target)) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
        await assertDeliveryParentChain(realWorktreeRoot, target)
        if (version === 1) {
          await assertFilePrecondition(target, file as DeliveryIntegrationFileV1)
        } else {
          await assertFilePreconditionV2(target, file as DeliveryIntegrationFileV2)
        }
        if (file.operation === 'DELETE') {
          await unlink(target)
        } else {
          await mkdir(dirname(target), { recursive: true })
          await assertDeliveryParentChain(realWorktreeRoot, target)
          await writeFile(target, Buffer.from(file.content))
        }
      }
      await git(realWorktreeRoot, ['add', '--', ...files.map((file) => normalizeRelativePath(file.relativePath))], 'DELIVERY_WORKTREE_WRITE_FAILED')
      const treeHash = exactGitOid(await git(realWorktreeRoot, ['write-tree'], 'DELIVERY_WORKTREE_WRITE_FAILED'))
      return {
        integrationTreeHash: digestJson({ kind: `DELIVERY_INTEGRATION_TREE_V${version}`, gitTreeOid: treeHash }),
        privateIntegrationContext: {
          worktreeRoot: realWorktreeRoot,
          trustedToolchainRoot: repositoryRoot,
        },
      }
    } catch (error) {
      failed = asDeliveryIntegrationError(error)
      throw failed
    } finally {
      if (worktreeAdded && failed) {
        try {
          await cleanupDeliveryIntegrationWorktreeRootV1(repositoryRoot, worktreeRoot)
        } catch (cleanupError) {
          throw DeliveryIntegrationWorktreeErrorV1.cleanupFailed(failed, asDeliveryIntegrationError(cleanupError))
        }
      }
    }
  }
}

export type DeliveryIntegrationWorktreeSafeCodeV1 =
  | 'DELIVERY_WORKTREE_ROOT_INVALID'
  | 'DELIVERY_WORKTREE_OUTSIDE_ROOT'
  | 'DELIVERY_WORKTREE_BASELINE_DRIFT'
  | 'DELIVERY_WORKTREE_FILE_INVALID'
  | 'DELIVERY_WORKTREE_WRITE_FAILED'
  | 'DELIVERY_WORKTREE_CLEANUP_FAILED'

export class DeliveryIntegrationWorktreeErrorV1 extends Error {
  readonly originalReasonCode?: DeliveryIntegrationWorktreeSafeCodeV1
  readonly cleanupReasonCode?: DeliveryIntegrationWorktreeSafeCodeV1

  constructor(
    readonly reasonCode: DeliveryIntegrationWorktreeSafeCodeV1,
    audit?: {
      readonly originalReasonCode: DeliveryIntegrationWorktreeSafeCodeV1
      readonly cleanupReasonCode: DeliveryIntegrationWorktreeSafeCodeV1
      readonly cause: DeliveryIntegrationWorktreeErrorV1
    },
  ) {
    super(reasonCode)
    this.name = 'DeliveryIntegrationWorktreeErrorV1'
    if (audit) {
      this.originalReasonCode = audit.originalReasonCode
      this.cleanupReasonCode = audit.cleanupReasonCode
      Object.assign(this, { cause: audit.cause })
    }
  }

  static cleanupFailed(
    original: DeliveryIntegrationWorktreeErrorV1,
    cleanup: DeliveryIntegrationWorktreeErrorV1,
  ): DeliveryIntegrationWorktreeErrorV1 {
    return new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_CLEANUP_FAILED', {
      originalReasonCode: original.reasonCode,
      cleanupReasonCode: cleanup.reasonCode,
      cause: original,
    })
  }
}

export async function cleanupDeliveryIntegrationWorktreeRootV1(repositoryRoot: string, worktreeRoot: string): Promise<void> {
  if (typeof worktreeRoot !== 'string' || !isAbsolute(worktreeRoot)) return
  if (existsSync(worktreeRoot)) {
    await git(repositoryRoot, ['worktree', 'remove', '--force', worktreeRoot], 'DELIVERY_WORKTREE_WRITE_FAILED')
  }
  await git(repositoryRoot, ['worktree', 'prune'], 'DELIVERY_WORKTREE_WRITE_FAILED')
}

function asDeliveryIntegrationError(error: unknown): DeliveryIntegrationWorktreeErrorV1 {
  if (error instanceof DeliveryIntegrationWorktreeErrorV1) return error
  const wrapped = new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_WRITE_FAILED')
  Object.assign(wrapped, { cause: error })
  return wrapped
}

async function ensureManagedRoot(value: string): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_ROOT_INVALID')
  }
  await mkdir(value, { recursive: true })
  return realpath(resolve(value))
}

async function assertGitBaseline(repositoryRoot: string, target: DeliveryTargetV1): Promise<void> {
  const [head, tree, status] = await Promise.all([
    git(repositoryRoot, ['rev-parse', '--verify', 'HEAD'], 'DELIVERY_WORKTREE_BASELINE_DRIFT'),
    git(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{tree}'], 'DELIVERY_WORKTREE_BASELINE_DRIFT'),
    git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 'DELIVERY_WORKTREE_BASELINE_DRIFT'),
  ])
  if (
    exactGitOid(head) !== target.baseRevision ||
    exactGitOid(tree) !== target.baselineTreeHash ||
    status.split(/\r?\n/).some((line) => line.trim().length > 0)
  ) {
    throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_BASELINE_DRIFT')
  }
}

async function assertFilePrecondition(realPath: string, file: DeliveryIntegrationFileV1): Promise<void> {
  try {
    const info = await lstat(realPath)
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    }
    if (file.operation === 'CREATE') throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    const current = await readFile(realPath)
    if (digestBytes(current) !== file.baselineDigest) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_BASELINE_DRIFT')
  } catch (error) {
    if (error instanceof DeliveryIntegrationWorktreeErrorV1) throw error
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT' && file.operation === 'CREATE') return
    throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
  }
}

async function assertFilePreconditionV2(realPath: string, file: DeliveryIntegrationFileV2): Promise<void> {
  if (file.operation === 'CREATE') {
    if (file.baselineDigest !== null || digestBytes(Buffer.from(file.content)) !== file.contentDigest) {
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    }
    try {
      await lstat(realPath)
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_BASELINE_DRIFT')
    } catch (error) {
      if (error instanceof DeliveryIntegrationWorktreeErrorV1) throw error
      if ((error as { code?: unknown }).code === 'ENOENT') return
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    }
  }

  if (typeof file.baselineDigest !== 'string' || file.baselineDigest.length === 0) {
    throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
  }
  if (file.operation === 'DELETE' && file.contentDigest !== null) {
    throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
  }
  if (file.operation === 'MODIFY' && digestBytes(Buffer.from(file.content)) !== file.contentDigest) {
    throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
  }
  try {
    const info = await lstat(realPath)
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    }
    const current = await readFile(realPath)
    if (digestBytes(current) !== file.baselineDigest) {
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_BASELINE_DRIFT')
    }
  } catch (error) {
    if (error instanceof DeliveryIntegrationWorktreeErrorV1) throw error
    throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
  }
}

interface ApprovedModifyBaselineV1 {
  readonly relativePath: string
  readonly baselineDigest: Sha256Digest
  readonly bytes: Buffer
}

async function readApprovedModifyBaselines(
  repositoryRoot: string,
  files: readonly DeliveryIntegrationFileV1[],
): Promise<readonly ApprovedModifyBaselineV1[]> {
  const baselines: ApprovedModifyBaselineV1[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const relativePath = normalizeRelativePath(file.relativePath)
    // Ordered same-file changes are valid when each later precondition names
    // the previous verified result. Only the first MODIFY for a path must be
    // anchored to the captured source checkout; a CREATE first occurrence has
    // no source precondition, and later changes are checked in the integration
    // worktree after earlier files have been applied.
    const key = pathKey(relativePath)
    if (seen.has(key)) continue
    seen.add(key)
    if (file.operation !== 'MODIFY') continue
    const target = resolve(repositoryRoot, relativePath.replace(/\\/g, sep))
    if (!isInside(repositoryRoot, target)) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    await assertDeliveryParentChain(repositoryRoot, target)
    const bytes = await readStableRegularFile(target)
    if (digestBytes(bytes) !== file.baselineDigest) {
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_BASELINE_DRIFT')
    }
    baselines.push({ relativePath, baselineDigest: file.baselineDigest, bytes })
  }
  return baselines
}

async function readApprovedBaselinesV2(
  repositoryRoot: string,
  files: readonly DeliveryIntegrationFileV2[],
): Promise<readonly ApprovedModifyBaselineV1[]> {
  const baselines: ApprovedModifyBaselineV1[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (file.operation === 'CREATE') continue
    const relativePath = normalizeRelativePath(file.relativePath)
    const key = pathKey(relativePath)
    if (seen.has(key)) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    seen.add(key)
    const target = resolve(repositoryRoot, relativePath.replace(/\\/g, sep))
    if (!isInside(repositoryRoot, target)) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    await assertDeliveryParentChain(repositoryRoot, target)
    const bytes = await readStableRegularFile(target)
    if (file.baselineDigest === null || digestBytes(bytes) !== file.baselineDigest) {
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_BASELINE_DRIFT')
    }
    baselines.push({ relativePath, baselineDigest: file.baselineDigest, bytes })
  }
  return baselines
}

async function seedApprovedModifyBaselines(
  worktreeRoot: string,
  baseRevision: string,
  baselines: readonly ApprovedModifyBaselineV1[],
): Promise<void> {
  for (const baseline of baselines) {
    const target = resolve(worktreeRoot, baseline.relativePath.replace(/\\/g, sep))
    if (!isInside(worktreeRoot, target)) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    await assertDeliveryParentChain(worktreeRoot, target)
    const current = await readStableRegularFile(target)
    if (digestBytes(current) !== baseline.baselineDigest) {
      const checkoutBytes = await gitBytes(worktreeRoot, [
        'cat-file',
        '--filters',
        `--path=${baseline.relativePath}`,
        `${baseRevision}:${baseline.relativePath}`,
      ])
      // Only replace Git's known checkout-filtered representation. An
      // arbitrary result written after worktree creation must remain intact.
      if (!current.equals(checkoutBytes)) {
        throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_BASELINE_DRIFT')
      }
      await writeFile(target, baseline.bytes)
    }
    const seeded = await readStableRegularFile(target)
    if (digestBytes(seeded) !== baseline.baselineDigest || !seeded.equals(baseline.bytes)) {
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_BASELINE_DRIFT')
    }
  }
  if (baselines.length > 0) {
    await git(
      worktreeRoot,
      ['add', '--', ...baselines.map((baseline) => baseline.relativePath)],
      'DELIVERY_WORKTREE_BASELINE_DRIFT',
    )
  }
}

async function assertDeliveryParentChain(rootPath: string, target: string): Promise<void> {
  let current = dirname(target)
  while (true) {
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
      }
      const realParent = await realpath(current)
      if (!isInside(rootPath, realParent) || pathKey(realParent) !== pathKey(current)) {
        throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
      }
      return
    } catch (error) {
      if (error instanceof DeliveryIntegrationWorktreeErrorV1) throw error
      if ((error as { code?: unknown }).code !== 'ENOENT') {
        throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
      }
      const parent = dirname(current)
      if (parent === current || !isInside(rootPath, parent)) {
        throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
      }
      current = parent
    }
  }
}

async function readStableRegularFile(realPath: string): Promise<Buffer> {
  try {
    const before = await lstat(realPath)
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    }
    const bytes = await readFile(realPath)
    const after = await lstat(realPath)
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.nlink !== 1 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_BASELINE_DRIFT')
    }
    return bytes
  } catch (error) {
    if (error instanceof DeliveryIntegrationWorktreeErrorV1) throw error
    throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
  }
}

function safeDirectoryName(value: string): string {
  return `delivery-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}

function normalizeRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\0') ||
    value.includes(':') ||
    win32.isAbsolute(value) ||
    posix.isAbsolute(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  ) {
    throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
  }
  const normalized = value.replace(/[\\]+/g, '/')
  const parts = normalized.split('/')
  if (parts.includes('..') || parts.includes('.') || parts.includes('') || parts.some((part) => part.toLowerCase() === '.git')) {
    throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
  }
  return posix.normalize(normalized)
}

function isInside(rootPath: string, candidate: string): boolean {
  const child = relative(rootPath, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function exactGitOid(output: string): string {
  const oid = output.trim()
  if (!/^[0-9a-f]{40}$/i.test(oid)) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_BASELINE_DRIFT')
  return oid
}

function digestJson(value: unknown): Sha256Digest {
  return digestBytes(Buffer.from(JSON.stringify(value), 'utf8'))
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}

async function git(cwd: string, args: readonly string[], failure: DeliveryIntegrationWorktreeSafeCodeV1): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new DeliveryIntegrationWorktreeErrorV1(failure))
        return
      }
      resolvePromise(stdout ?? '')
    })
  })
}

async function gitBytes(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'buffer', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const diagnostic = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
          reject(
            new DeliveryIntegrationWorktreeErrorV1(
              diagnostic.includes('not a git repository')
                ? 'DELIVERY_WORKTREE_BASELINE_DRIFT'
                : 'DELIVERY_WORKTREE_WRITE_FAILED',
            ),
          )
          return
        }
        resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''))
      },
    )
  })
}
