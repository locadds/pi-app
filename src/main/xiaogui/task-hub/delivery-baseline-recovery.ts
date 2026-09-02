import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { TextDecoder } from 'node:util'

import {
  deliveryChangeSetDigestV1,
  deliveryTargetFingerprintV1,
  type DeliveryBatchId,
  type DeliveryChangeSetV1,
  type DeliveryTargetV1,
} from '@shared/xiaogui-delivery'
import type { ArtifactId, Sha256Digest, TaskChangeSetId } from '@shared/xiaogui-task-verification'

import type { ProjectWorkspaceResolverV1 } from './attempt-workspace'

export interface DeliveryBaselineRecoveryDesiredFileV1 {
  readonly relativePath: string
  readonly contentArtifactId: ArtifactId
  readonly contentDigest: Sha256Digest
  readonly content: Uint8Array
}

export interface DeliveryBaselineRecoveryInputV1 {
  readonly sourceBatchId: DeliveryBatchId
  readonly sourceChangeSet: DeliveryChangeSetV1
  readonly desiredFiles: readonly DeliveryBaselineRecoveryDesiredFileV1[]
  readonly currentTarget: DeliveryTargetV1
}

export interface DeliveryBaselineRecoveredFileV1 {
  readonly operation: 'MODIFY' | 'CREATE'
  readonly relativePath: string
  readonly baselineDigest: Sha256Digest | null
  readonly contentDigest: Sha256Digest
  readonly content: Uint8Array
  readonly sourceContentArtifactId: ArtifactId
  readonly sourceTaskChangeSetIds: readonly TaskChangeSetId[]
}

export interface DeliveryBaselineRecoveryPrivateContextV1 {
  readonly worktreeRoot: string
  readonly trustedToolchainRoot: string
}

export interface DeliveryBaselineRecoveryEvidenceMaterialV1 {
  readonly kind: 'DELIVERY_BASELINE_RECOVERY_EVIDENCE_V1'
  readonly version: 1
  readonly sourceBatchId: DeliveryBatchId
  readonly sourceDeliveryChangeSetId: DeliveryChangeSetV1['deliveryChangeSetId']
  readonly sourceDeliveryChangeSetDigest: Sha256Digest
  readonly sourceTargetFingerprint: Sha256Digest
  readonly currentTargetFingerprint: Sha256Digest
  readonly recoveredFileSetDigest: Sha256Digest
  readonly recoveredFileCount: number
  readonly directReplacementCount: number
  readonly threeWayMergeCount: number
  readonly createCount: number
}

export interface DeliveryBaselineRecoveryResultV1 {
  readonly files: readonly DeliveryBaselineRecoveredFileV1[]
  readonly currentTarget: DeliveryTargetV1
  readonly integrationTreeHash: Sha256Digest
  readonly privateIntegrationContext: DeliveryBaselineRecoveryPrivateContextV1
  /** Contains lineage and digests only; never absolute filesystem paths or bytes. */
  readonly evidenceMaterial: DeliveryBaselineRecoveryEvidenceMaterialV1
}

export interface DeliveryBaselineRecoveryPortV1 {
  recover(input: DeliveryBaselineRecoveryInputV1): Promise<DeliveryBaselineRecoveryResultV1>
  recheckTarget(target: DeliveryTargetV1): Promise<void>
  cleanup(context: DeliveryBaselineRecoveryPrivateContextV1): Promise<void>
}

export interface MainProcessDeliveryBaselineRecoveryOptionsV1 {
  readonly projectResolver: ProjectWorkspaceResolverV1
  readonly managedRoot: string
}

export type DeliveryBaselineRecoverySafeCodeV1 =
  | 'DELIVERY_RECOVERY_ROOT_INVALID'
  | 'DELIVERY_RECOVERY_WORKTREE_OUTSIDE_ROOT'
  | 'DELIVERY_RECOVERY_TARGET_DIRTY'
  | 'DELIVERY_RECOVERY_TARGET_BASELINE_DRIFT'
  | 'DELIVERY_RECOVERY_SOURCE_CHANGESET_INVALID'
  | 'DELIVERY_RECOVERY_FILE_INVALID'
  | 'DELIVERY_RECOVERY_DESIRED_DIGEST_DRIFT'
  | 'DELIVERY_RECOVERY_BASELINE_DIGEST_DRIFT'
  | 'DELIVERY_RECOVERY_FILE_CONFLICT'
  | 'DELIVERY_RECOVERY_BINARY_UNSUPPORTED'
  | 'DELIVERY_RECOVERY_MERGE_FAILED'
  | 'DELIVERY_RECOVERY_WORKTREE_SETUP_FAILED'
  | 'DELIVERY_RECOVERY_WORKTREE_WRITE_FAILED'
  | 'DELIVERY_RECOVERY_WORKTREE_CLEANUP_FAILED'

export class DeliveryBaselineRecoveryErrorV1 extends Error {
  constructor(readonly reasonCode: DeliveryBaselineRecoverySafeCodeV1) {
    super(reasonCode)
    this.name = 'DeliveryBaselineRecoveryErrorV1'
  }
}

interface PreparedRecoveryFileV1 extends DeliveryBaselineRecoveredFileV1 {
  readonly strategy: 'DIRECT_REPLACEMENT' | 'THREE_WAY_MERGE' | 'CREATE'
}

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true })

export class MainProcessDeliveryBaselineRecoveryPortV1 implements DeliveryBaselineRecoveryPortV1 {
  constructor(private readonly options: MainProcessDeliveryBaselineRecoveryOptionsV1) {}

  async recover(input: DeliveryBaselineRecoveryInputV1): Promise<DeliveryBaselineRecoveryResultV1> {
    const managedRoot = await ensureManagedRoot(this.options.managedRoot)
    const repositoryRoot = await this.resolveRepositoryRoot(input.currentTarget)
    assertRecoveryInput(input)
    await assertCurrentTarget(repositoryRoot, input.currentTarget)

    const worktreeRoot = resolve(managedRoot, recoveryDirectoryName(input.sourceBatchId))
    assertManagedRecoveryWorktreeRoot(managedRoot, worktreeRoot)
    await removeManagedResidual(repositoryRoot, managedRoot, worktreeRoot)

    let keepWorktree = false
    try {
      await gitText(repositoryRoot, ['worktree', 'add', '--detach', worktreeRoot, input.currentTarget.baseRevision], 'DELIVERY_RECOVERY_WORKTREE_SETUP_FAILED')
      let realWorktreeRoot: string
      try {
        realWorktreeRoot = await realpath(worktreeRoot)
      } catch {
        throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_WORKTREE_SETUP_FAILED')
      }
      if (pathKey(realWorktreeRoot) !== pathKey(worktreeRoot) || !isInside(managedRoot, realWorktreeRoot)) {
        throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_WORKTREE_OUTSIDE_ROOT')
      }
      const files = await recoverFiles(repositoryRoot, realWorktreeRoot, managedRoot, input)
      await gitText(realWorktreeRoot, ['add', '--', ...files.map((file) => file.relativePath)], 'DELIVERY_RECOVERY_WORKTREE_WRITE_FAILED')
      const treeOid = exactGitOid(await gitText(realWorktreeRoot, ['write-tree'], 'DELIVERY_RECOVERY_WORKTREE_WRITE_FAILED'))
      const result = buildResult(input, repositoryRoot, realWorktreeRoot, treeOid, files)
      keepWorktree = true
      return result
    } finally {
      if (!keepWorktree) await bestEffortRemoveWorktree(repositoryRoot, managedRoot, worktreeRoot)
    }
  }

  async recheckTarget(target: DeliveryTargetV1): Promise<void> {
    const repositoryRoot = await this.resolveRepositoryRoot(target)
    await assertCurrentTarget(repositoryRoot, target)
  }

  async cleanup(context: DeliveryBaselineRecoveryPrivateContextV1): Promise<void> {
    const managedRoot = await ensureManagedRoot(this.options.managedRoot)
    const worktreeRoot = resolve(context.worktreeRoot)
    assertManagedRecoveryWorktreeRoot(managedRoot, worktreeRoot)
    let repositoryRoot: string
    try {
      repositoryRoot = await realpath(resolve(context.trustedToolchainRoot))
    } catch {
      throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_WORKTREE_CLEANUP_FAILED')
    }
    await removeManagedWorktree(repositoryRoot, managedRoot, worktreeRoot, 'DELIVERY_RECOVERY_WORKTREE_CLEANUP_FAILED')
    await removeManagedInputsRoot(managedRoot, recoveryInputsRoot(worktreeRoot))
  }

  private async resolveRepositoryRoot(target: DeliveryTargetV1): Promise<string> {
    try {
      return await realpath(resolve(await this.options.projectResolver.resolveProjectRoot(target.projectId)))
    } catch {
      throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_TARGET_BASELINE_DRIFT')
    }
  }
}

function assertRecoveryInput(input: DeliveryBaselineRecoveryInputV1): void {
  if (
    !input.sourceChangeSet ||
    input.sourceBatchId !== input.sourceChangeSet.batchId ||
    input.sourceChangeSet.target.projectId !== input.currentTarget.projectId ||
    input.sourceChangeSet.digest !== deliveryChangeSetDigestV1(withoutDigest(input.sourceChangeSet)) ||
    !Array.isArray(input.sourceChangeSet.fileChanges) ||
    input.sourceChangeSet.fileChanges.length === 0 ||
    !Array.isArray(input.desiredFiles)
  ) {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_SOURCE_CHANGESET_INVALID')
  }

  const desiredByPath = new Map<string, DeliveryBaselineRecoveryDesiredFileV1>()
  for (const desired of input.desiredFiles) {
    const relativePath = normalizeRelativePath(desired.relativePath)
    const key = pathKey(relativePath)
    if (desiredByPath.has(key) || desired.relativePath !== relativePath) {
      throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
    }
    desiredByPath.set(key, desired)
  }

  const seen = new Set<string>()
  for (const file of input.sourceChangeSet.fileChanges) {
    const relativePath = normalizeRelativePath(file.relativePath)
    const key = pathKey(relativePath)
    if (
      seen.has(key) ||
      file.relativePath !== relativePath ||
      (file.operation !== 'MODIFY' && file.operation !== 'CREATE') ||
      (file.operation === 'MODIFY' && file.baselineDigest === null) ||
      (file.operation === 'CREATE' && file.baselineDigest !== null)
    ) {
      throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
    }
    seen.add(key)
    const desired = desiredByPath.get(key)
    if (
      !desired ||
      desired.contentArtifactId !== file.contentArtifactId ||
      desired.contentDigest !== file.contentDigest ||
      digestBytes(desired.content) !== file.contentDigest
    ) {
      throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_DESIRED_DIGEST_DRIFT')
    }
  }
  if (desiredByPath.size !== seen.size) throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
}

async function assertCurrentTarget(repositoryRoot: string, target: DeliveryTargetV1): Promise<void> {
  const [head, tree, status] = await Promise.all([
    gitText(repositoryRoot, ['rev-parse', '--verify', 'HEAD'], 'DELIVERY_RECOVERY_TARGET_BASELINE_DRIFT'),
    gitText(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{tree}'], 'DELIVERY_RECOVERY_TARGET_BASELINE_DRIFT'),
    gitText(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 'DELIVERY_RECOVERY_TARGET_BASELINE_DRIFT'),
  ])
  if (status.split(/\r?\n/).some((line) => line.length > 0)) {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_TARGET_DIRTY')
  }
  const expectedFingerprint = deliveryTargetFingerprintV1({
    projectId: target.projectId,
    baseRevision: target.baseRevision,
    baselineTreeHash: target.baselineTreeHash,
  })
  if (
    exactGitOid(head) !== target.baseRevision ||
    exactGitOid(tree) !== target.baselineTreeHash ||
    target.initialTargetFingerprint !== expectedFingerprint
  ) {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_TARGET_BASELINE_DRIFT')
  }
}

async function ensureManagedRoot(value: string): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_ROOT_INVALID')
  }
  try {
    await mkdir(value, { recursive: true })
    return await realpath(resolve(value))
  } catch {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_ROOT_INVALID')
  }
}

async function removeManagedResidual(repositoryRoot: string, managedRoot: string, worktreeRoot: string): Promise<void> {
  assertManagedRecoveryWorktreeRoot(managedRoot, worktreeRoot)
  await removeManagedWorktree(repositoryRoot, managedRoot, worktreeRoot, 'DELIVERY_RECOVERY_WORKTREE_CLEANUP_FAILED')
  await removeManagedInputsRoot(managedRoot, recoveryInputsRoot(worktreeRoot))
}

async function removeManagedWorktree(
  repositoryRoot: string,
  managedRoot: string,
  worktreeRoot: string,
  failure: DeliveryBaselineRecoverySafeCodeV1,
): Promise<void> {
  assertManagedRecoveryWorktreeRoot(managedRoot, worktreeRoot)
  const registered = await registeredWorktrees(repositoryRoot)
  if (registered.some((candidate) => pathKey(resolve(candidate)) === pathKey(worktreeRoot))) {
    if (existsSync(worktreeRoot)) await gitText(repositoryRoot, ['worktree', 'remove', '--force', worktreeRoot], failure)
  } else if (existsSync(worktreeRoot)) {
    await removeOwnedDirectory(managedRoot, worktreeRoot, failure)
  }
  await gitText(repositoryRoot, ['worktree', 'prune'], failure)
}

async function bestEffortRemoveWorktree(repositoryRoot: string, managedRoot: string, worktreeRoot: string): Promise<void> {
  try {
    assertManagedRecoveryWorktreeRoot(managedRoot, worktreeRoot)
    await removeManagedWorktree(repositoryRoot, managedRoot, worktreeRoot, 'DELIVERY_RECOVERY_WORKTREE_CLEANUP_FAILED')
    await removeManagedInputsRoot(managedRoot, recoveryInputsRoot(worktreeRoot))
  } catch {
    // The original recovery error remains authoritative. A later request will retry
    // cleanup through the same deterministic managed path before doing any work.
  }
}

async function registeredWorktrees(repositoryRoot: string): Promise<readonly string[]> {
  const output = await gitText(repositoryRoot, ['worktree', 'list', '--porcelain'], 'DELIVERY_RECOVERY_WORKTREE_CLEANUP_FAILED')
  return output.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))
}

function assertManagedRecoveryWorktreeRoot(managedRoot: string, candidate: string): void {
  const resolvedRoot = resolve(managedRoot)
  const resolvedCandidate = resolve(candidate)
  if (
    pathKey(dirname(resolvedCandidate)) !== pathKey(resolvedRoot) ||
    !/^delivery-recovery-[0-9a-f]{32}$/.test(basename(resolvedCandidate))
  ) {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_WORKTREE_OUTSIDE_ROOT')
  }
}

function recoveryInputsRoot(worktreeRoot: string): string {
  return `${worktreeRoot}-inputs`
}

async function removeManagedInputsRoot(managedRoot: string, candidate: string): Promise<void> {
  const resolvedRoot = resolve(managedRoot)
  const resolvedCandidate = resolve(candidate)
  if (
    pathKey(dirname(resolvedCandidate)) !== pathKey(resolvedRoot) ||
    !/^delivery-recovery-[0-9a-f]{32}-inputs$/.test(basename(resolvedCandidate))
  ) {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_WORKTREE_OUTSIDE_ROOT')
  }
  await removeOwnedDirectory(resolvedRoot, resolvedCandidate, 'DELIVERY_RECOVERY_WORKTREE_CLEANUP_FAILED')
}

async function removeOwnedDirectory(
  managedRoot: string,
  candidate: string,
  failure: DeliveryBaselineRecoverySafeCodeV1,
): Promise<void> {
  if (!existsSync(candidate)) return
  let realCandidate: string
  try {
    realCandidate = await realpath(candidate)
  } catch (error) {
    if (isMissing(error)) return
    throw new DeliveryBaselineRecoveryErrorV1(failure)
  }
  if (pathKey(realCandidate) !== pathKey(candidate) || !isInside(managedRoot, realCandidate)) {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_WORKTREE_OUTSIDE_ROOT')
  }
  try {
    await rm(realCandidate, { recursive: true, force: true })
  } catch {
    throw new DeliveryBaselineRecoveryErrorV1(failure)
  }
}

async function recoverFiles(
  repositoryRoot: string,
  worktreeRoot: string,
  managedRoot: string,
  input: DeliveryBaselineRecoveryInputV1,
): Promise<readonly PreparedRecoveryFileV1[]> {
  const desiredByPath = new Map(input.desiredFiles.map((file) => [pathKey(file.relativePath), file]))
  const mergeRoot = recoveryInputsRoot(worktreeRoot)
  await removeManagedInputsRoot(managedRoot, mergeRoot)
  try {
    await mkdir(mergeRoot)
  } catch {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_WORKTREE_SETUP_FAILED')
  }
  let primaryError: unknown
  try {
    const recovered: PreparedRecoveryFileV1[] = []
    for (const file of input.sourceChangeSet.fileChanges) {
      const relativePath = normalizeRelativePath(file.relativePath)
      const desired = desiredByPath.get(pathKey(relativePath))
      if (!desired) throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
      if (file.operation === 'CREATE') {
        assertSupportedTextContent(desired.content)
        const targetPath = await resolveMissingRecoveryPath(worktreeRoot, relativePath)
        await writeCreatedRecoveryFile(targetPath, desired.content)
        recovered.push({
          operation: 'CREATE',
          relativePath,
          baselineDigest: null,
          contentDigest: desired.contentDigest,
          content: Buffer.from(desired.content),
          sourceContentArtifactId: desired.contentArtifactId,
          sourceTaskChangeSetIds: file.sourceTaskChangeSetIds,
          strategy: 'CREATE',
        })
        continue
      }

      const base = await readSourceBase(repositoryRoot, input.sourceChangeSet.target.baseRevision, relativePath)
      assertSupportedTextContent(base)
      assertSupportedTextContent(desired.content)
      if (digestBytes(base) !== file.baselineDigest) {
        throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_BASELINE_DIGEST_DRIFT')
      }
      const current = await readRegularRecoveryFile(worktreeRoot, relativePath)
      assertSupportedTextContent(current.bytes)
      const currentDigest = digestBytes(current.bytes)
      let content: Buffer
      let strategy: PreparedRecoveryFileV1['strategy']
      if (currentDigest === file.baselineDigest) {
        content = Buffer.from(desired.content)
        strategy = 'DIRECT_REPLACEMENT'
      } else {
        content = await mergeText(mergeRoot, recovered.length, current.bytes, base, Buffer.from(desired.content))
        strategy = 'THREE_WAY_MERGE'
      }
      await assertRegularFileUnchanged(current.realPath, current.bytes)
      try {
        await writeFile(current.realPath, content)
      } catch {
        throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_WORKTREE_WRITE_FAILED')
      }
      recovered.push({
        operation: 'MODIFY',
        relativePath,
        baselineDigest: currentDigest,
        contentDigest: digestBytes(content),
        content,
        sourceContentArtifactId: desired.contentArtifactId,
        sourceTaskChangeSetIds: file.sourceTaskChangeSetIds,
        strategy,
      })
    }
    return recovered
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      await removeManagedInputsRoot(managedRoot, mergeRoot)
    } catch (error) {
      if (primaryError === undefined) throw error
    }
  }
}

async function readSourceBase(repositoryRoot: string, revision: string, relativePath: string): Promise<Buffer> {
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_SOURCE_CHANGESET_INVALID')
  const entry = await gitText(
    repositoryRoot,
    ['ls-tree', revision, '--', relativePath],
    'DELIVERY_RECOVERY_BASELINE_DIGEST_DRIFT',
  )
  const match = /^(100644|100755) blob ([0-9a-f]{40})\t/.exec(entry)
  if (!match) throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
  return gitBytes(repositoryRoot, ['cat-file', 'blob', match[2]], 'DELIVERY_RECOVERY_BASELINE_DIGEST_DRIFT')
}

async function readRegularRecoveryFile(
  worktreeRoot: string,
  relativePath: string,
): Promise<{ readonly realPath: string; readonly bytes: Buffer }> {
  const lexical = resolve(worktreeRoot, relativePath.replace(/\//g, sep))
  if (!isInside(worktreeRoot, lexical)) throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
  try {
    const realPath = await realpath(lexical)
    if (pathKey(realPath) !== pathKey(lexical) || !isInside(worktreeRoot, realPath)) {
      throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
    }
    const info = await lstat(realPath, { bigint: true })
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) {
      throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
    }
    return { realPath, bytes: await readFile(realPath) }
  } catch (error) {
    if (error instanceof DeliveryBaselineRecoveryErrorV1) throw error
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
  }
}

async function resolveMissingRecoveryPath(worktreeRoot: string, relativePath: string): Promise<string> {
  const lexical = resolve(worktreeRoot, relativePath.replace(/\//g, sep))
  if (!isInside(worktreeRoot, lexical)) throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
  const parts = relativePath.split('/')
  let cursor = worktreeRoot
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part)
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
      const realParent = await realpath(cursor)
      if (pathKey(realParent) !== pathKey(cursor) || !isInside(worktreeRoot, realParent)) {
        throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
      }
    } catch (error) {
      if (error instanceof DeliveryBaselineRecoveryErrorV1) throw error
      throw new DeliveryBaselineRecoveryErrorV1(isMissing(error) ? 'DELIVERY_RECOVERY_FILE_CONFLICT' : 'DELIVERY_RECOVERY_FILE_INVALID')
    }
  }
  try {
    await lstat(lexical)
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_CONFLICT')
  } catch (error) {
    if (error instanceof DeliveryBaselineRecoveryErrorV1) throw error
    if (isMissing(error)) return lexical
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
  }
}

async function writeCreatedRecoveryFile(targetPath: string, content: Uint8Array): Promise<void> {
  try {
    await writeFile(targetPath, Buffer.from(content), { flag: 'wx' })
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    if (code === 'EEXIST' || code === 'ENOENT') {
      throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_CONFLICT')
    }
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_WORKTREE_WRITE_FAILED')
  }
}

async function assertRegularFileUnchanged(realPath: string, expected: Uint8Array): Promise<void> {
  try {
    const info = await lstat(realPath, { bigint: true })
    if (!info.isSymbolicLink() && info.isFile() && info.nlink === 1n && digestBytes(await readFile(realPath)) === digestBytes(expected)) {
      return
    }
  } catch {
    // A concurrent change in the private worktree is still a deterministic conflict.
  }
  throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_CONFLICT')
}

async function mergeText(
  mergeRoot: string,
  index: number,
  current: Buffer,
  base: Buffer,
  desired: Buffer,
): Promise<Buffer> {
  const prefix = join(mergeRoot, String(index))
  const currentPath = `${prefix}-current`
  const basePath = `${prefix}-base`
  const desiredPath = `${prefix}-desired`
  try {
    await Promise.all([writeFile(currentPath, current), writeFile(basePath, base), writeFile(desiredPath, desired)])
  } catch {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_WORKTREE_WRITE_FAILED')
  }
  const merged = await gitMergeFile(currentPath, basePath, desiredPath)
  if (hasConflictMarkers(merged)) throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_CONFLICT')
  return merged
}

function buildResult(
  input: DeliveryBaselineRecoveryInputV1,
  repositoryRoot: string,
  worktreeRoot: string,
  treeOid: string,
  files: readonly PreparedRecoveryFileV1[],
): DeliveryBaselineRecoveryResultV1 {
  const publicFiles = files.map(({ strategy: _strategy, ...file }) => file)
  const currentTargetFingerprint = deliveryTargetFingerprintV1({
    projectId: input.currentTarget.projectId,
    baseRevision: input.currentTarget.baseRevision,
    baselineTreeHash: input.currentTarget.baselineTreeHash,
  })
  return {
    files: publicFiles,
    currentTarget: input.currentTarget,
    integrationTreeHash: digestJson({ kind: 'DELIVERY_INTEGRATION_TREE_V1', gitTreeOid: treeOid }),
    privateIntegrationContext: { worktreeRoot, trustedToolchainRoot: repositoryRoot },
    evidenceMaterial: {
      kind: 'DELIVERY_BASELINE_RECOVERY_EVIDENCE_V1',
      version: 1,
      sourceBatchId: input.sourceBatchId,
      sourceDeliveryChangeSetId: input.sourceChangeSet.deliveryChangeSetId,
      sourceDeliveryChangeSetDigest: input.sourceChangeSet.digest,
      sourceTargetFingerprint: input.sourceChangeSet.target.initialTargetFingerprint,
      currentTargetFingerprint,
      recoveredFileSetDigest: digestJson(files.map((file) => ({
        operation: file.operation,
        relativePath: file.relativePath,
        baselineDigest: file.baselineDigest,
        contentDigest: file.contentDigest,
        strategy: file.strategy,
      }))),
      recoveredFileCount: files.length,
      directReplacementCount: files.filter((file) => file.strategy === 'DIRECT_REPLACEMENT').length,
      threeWayMergeCount: files.filter((file) => file.strategy === 'THREE_WAY_MERGE').length,
      createCount: files.filter((file) => file.strategy === 'CREATE').length,
    },
  }
}

function normalizeRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes(':') ||
    win32.isAbsolute(value) ||
    posix.isAbsolute(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  ) {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
  }
  const normalized = value.replace(/[\\]+/g, '/')
  const parts = normalized.split('/')
  if (
    parts.includes('..') ||
    parts.includes('.') ||
    parts.includes('') ||
    parts.some((part) => part.toLowerCase() === '.git' || /[ .]$/.test(part))
  ) {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
  }
  const parsed = posix.normalize(normalized)
  if (parsed === '.' || parsed.startsWith('../')) throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_FILE_INVALID')
  return parsed
}

function recoveryDirectoryName(sourceBatchId: DeliveryBatchId): string {
  return `delivery-recovery-${createHash('sha256').update(sourceBatchId).digest('hex').slice(0, 32)}`
}

function withoutDigest(changeSet: DeliveryChangeSetV1): Omit<DeliveryChangeSetV1, 'digest'> {
  const { digest: _digest, ...value } = changeSet
  return value
}

function exactGitOid(output: string): string {
  const oid = output.trim()
  if (!/^[0-9a-f]{40}$/i.test(oid)) throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_TARGET_BASELINE_DRIFT')
  return oid
}

function isInside(rootPath: string, candidate: string): boolean {
  const child = relative(rootPath, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function hasNul(value: Uint8Array): boolean {
  return value.includes(0)
}

function assertSupportedTextContent(value: Uint8Array): void {
  if (hasNul(value)) throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_BINARY_UNSUPPORTED')
  try {
    fatalUtf8Decoder.decode(value)
  } catch {
    throw new DeliveryBaselineRecoveryErrorV1('DELIVERY_RECOVERY_BINARY_UNSUPPORTED')
  }
}

function hasConflictMarkers(value: Buffer): boolean {
  return /^(<<<<<<< |=======\r?$|>>>>>>> )/m.test(value.toString('utf8'))
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}

function digestJson(value: unknown): Sha256Digest {
  return digestBytes(Buffer.from(JSON.stringify(value), 'utf8'))
}

function gitText(cwd: string, args: readonly string[], failure: DeliveryBaselineRecoverySafeCodeV1): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new DeliveryBaselineRecoveryErrorV1(failure))
        return
      }
      resolvePromise(stdout ?? '')
    })
  })
}

function gitBytes(cwd: string, args: readonly string[], failure: DeliveryBaselineRecoverySafeCodeV1): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new DeliveryBaselineRecoveryErrorV1(failure))
        return
      }
      resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''))
    })
  })
}

function gitMergeFile(currentPath: string, basePath: string, desiredPath: string): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['merge-file', '-p', currentPath, basePath, desiredPath],
      { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) {
          resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''))
          return
        }
        const exitCode = (error as { code?: unknown }).code
        reject(new DeliveryBaselineRecoveryErrorV1(
          exitCode === 1 ? 'DELIVERY_RECOVERY_FILE_CONFLICT' : 'DELIVERY_RECOVERY_MERGE_FAILED',
        ))
      },
    )
  })
}
