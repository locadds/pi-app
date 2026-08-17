import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'

import type { DeliveryTargetV1 } from '@shared/xiaogui-delivery'
import type { Sha256Digest } from '@shared/xiaogui-task-verification'

import type { ProjectWorkspaceResolverV1 } from './attempt-workspace'
import type {
  DeliveryIntegrationFileV1,
  DeliveryIntegrationResultV1,
  DeliveryIntegrationWorktreePortV1,
} from './delivery-composer'

export interface MainProcessDeliveryIntegrationWorktreeOptionsV1 {
  readonly projectResolver: ProjectWorkspaceResolverV1
  readonly managedRoot: string
  readonly target: DeliveryTargetV1
  readonly batchId: string
}

export class MainProcessDeliveryIntegrationWorktreePortV1 implements DeliveryIntegrationWorktreePortV1 {
  constructor(private readonly options: MainProcessDeliveryIntegrationWorktreeOptionsV1) {}

  async integrate(files: readonly DeliveryIntegrationFileV1[]): Promise<DeliveryIntegrationResultV1> {
    const managedRoot = await ensureManagedRoot(this.options.managedRoot)
    const repositoryRoot = await realpath(resolve(await this.options.projectResolver.resolveProjectRoot(this.options.target.projectId)))
    const worktreeRoot = resolve(managedRoot, safeDirectoryName(this.options.batchId))
    if (!isInside(managedRoot, worktreeRoot)) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_OUTSIDE_ROOT')

    await assertGitBaseline(repositoryRoot, this.options.target)
    if (existsSync(worktreeRoot)) {
      await git(repositoryRoot, ['worktree', 'remove', '--force', worktreeRoot], 'DELIVERY_WORKTREE_WRITE_FAILED')
      await git(repositoryRoot, ['worktree', 'prune'], 'DELIVERY_WORKTREE_WRITE_FAILED')
    }
    await git(repositoryRoot, ['worktree', 'add', '--detach', worktreeRoot, this.options.target.baseRevision], 'DELIVERY_WORKTREE_WRITE_FAILED')
    const realWorktreeRoot = await realpath(worktreeRoot)
    if (pathKey(realWorktreeRoot) !== pathKey(worktreeRoot) || !isInside(managedRoot, realWorktreeRoot)) {
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_OUTSIDE_ROOT')
    }

    try {
      for (const file of files) {
        const relativePath = normalizeRelativePath(file.relativePath)
        const target = resolve(realWorktreeRoot, relativePath.replace(/\//g, sep))
        if (!isInside(realWorktreeRoot, target)) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
        await assertFilePrecondition(target, file)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, Buffer.from(file.content))
      }
      await git(realWorktreeRoot, ['add', '--', ...files.map((file) => normalizeRelativePath(file.relativePath))], 'DELIVERY_WORKTREE_WRITE_FAILED')
      const treeHash = exactGitOid(await git(realWorktreeRoot, ['write-tree'], 'DELIVERY_WORKTREE_WRITE_FAILED'))
      return {
        integrationTreeHash: digestJson({ kind: 'DELIVERY_INTEGRATION_TREE_V1', gitTreeOid: treeHash }),
        privateIntegrationContext: {
          worktreeRoot: realWorktreeRoot,
          trustedToolchainRoot: repositoryRoot,
        },
      }
    } catch (error) {
      if (error instanceof DeliveryIntegrationWorktreeErrorV1) throw error
      throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_WRITE_FAILED')
    }
  }
}

export type DeliveryIntegrationWorktreeSafeCodeV1 =
  | 'DELIVERY_WORKTREE_ROOT_INVALID'
  | 'DELIVERY_WORKTREE_OUTSIDE_ROOT'
  | 'DELIVERY_WORKTREE_BASELINE_DRIFT'
  | 'DELIVERY_WORKTREE_FILE_INVALID'
  | 'DELIVERY_WORKTREE_WRITE_FAILED'

export class DeliveryIntegrationWorktreeErrorV1 extends Error {
  constructor(readonly reasonCode: DeliveryIntegrationWorktreeSafeCodeV1) {
    super(reasonCode)
    this.name = 'DeliveryIntegrationWorktreeErrorV1'
  }
}

export async function cleanupDeliveryIntegrationWorktreeRootV1(repositoryRoot: string, worktreeRoot: string): Promise<void> {
  if (typeof worktreeRoot !== 'string' || !isAbsolute(worktreeRoot) || !existsSync(worktreeRoot)) return
  await git(repositoryRoot, ['worktree', 'remove', '--force', worktreeRoot], 'DELIVERY_WORKTREE_WRITE_FAILED')
  await git(repositoryRoot, ['worktree', 'prune'], 'DELIVERY_WORKTREE_WRITE_FAILED')
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
    if (info.isSymbolicLink() || !info.isFile()) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    if (file.operation === 'CREATE') throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_FILE_INVALID')
    const current = await readFile(realPath)
    if (digestBytes(current) !== file.baselineDigest) throw new DeliveryIntegrationWorktreeErrorV1('DELIVERY_WORKTREE_BASELINE_DRIFT')
  } catch (error) {
    if (error instanceof DeliveryIntegrationWorktreeErrorV1) throw error
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT' && file.operation === 'CREATE') return
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
