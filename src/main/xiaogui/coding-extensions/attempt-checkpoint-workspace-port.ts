import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import type {
  AttemptCheckpointWorkspacePort,
  AttemptWorkspaceCheckpointSnapshotV1,
} from './checkpoint-module'

export type AttemptCheckpointWorkspaceAvailabilityV1 = 'IDLE' | 'BUSY' | 'UNAVAILABLE' | 'OUTCOME_UNKNOWN'

/**
 * Main-process-only authority result. The absolute root is intentionally kept
 * behind this adapter and must never be copied into shared contracts or IPC.
 */
export interface AttemptCheckpointWorkspaceBindingV1 {
  readonly attemptId: string
  readonly state: AttemptCheckpointWorkspaceAvailabilityV1
  readonly worktreeBindingDigest: string
  readonly worktreeRoot: string
}

export interface AttemptCheckpointWorkspaceAuthorityV1 {
  inspect(attemptId: string): Promise<AttemptCheckpointWorkspaceBindingV1 | undefined>
}

export type AttemptCheckpointWorkspaceAdapterErrorCodeV1 =
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_BUSY'
  | 'ATTEMPT_UNAVAILABLE'
  | 'BINDING_MISMATCH'
  | 'WORKTREE_OUTSIDE_MANAGED_ROOT'
  | 'WORKTREE_NOT_LINKED'
  | 'WORKTREE_CHANGED'
  | 'BASELINE_MISMATCH'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_INVALID'
  | 'SNAPSHOT_DIGEST_MISMATCH'
  | 'UNSUPPORTED_ENTRY'
  | 'RESTORE_FAILED'
  | 'OUTCOME_UNKNOWN'

export class AttemptCheckpointWorkspaceAdapterError extends Error {
  constructor(readonly code: AttemptCheckpointWorkspaceAdapterErrorCodeV1) {
    super(code)
    this.name = 'AttemptCheckpointWorkspaceAdapterError'
  }
}

export interface AttemptCheckpointWorkspaceRestorePreviewV1 {
  readonly schemaVersion: 1
  readonly attemptId: string
  readonly worktreeBindingDigest: string
  readonly targetSnapshotDigest: string
  readonly currentSnapshotDigest: string
  readonly changedRelativePaths: readonly string[]
  readonly changeCount: number
  readonly changeSummaryDigest: string
}

export interface GitAttemptCheckpointWorkspaceAdapterOptionsV1 {
  readonly authority: AttemptCheckpointWorkspaceAuthorityV1
  readonly managedRoot: string
  readonly snapshotRoot: string
  readonly idFactory?: () => string
}

interface IndexEntryV1 {
  readonly relativePath: string
  readonly mode: string
  readonly objectId: string
  readonly stage: number
}

interface SnapshotFileV1 {
  readonly relativePath: string
  readonly inHead: boolean
  readonly inIndex: boolean
  readonly untracked: boolean
  readonly kind: 'FILE' | 'SYMLINK' | 'MISSING'
  readonly fileMode?: number
  readonly blobDigest?: string
}

interface CollectedWorkspaceStateV1 {
  readonly baselineDigest: string
  readonly headOid: string
  readonly headTreeOid: string
  readonly indexBytes: Buffer
  readonly indexFileDigest: string
  readonly indexEntries: readonly IndexEntryV1[]
  readonly files: readonly SnapshotFileV1[]
  readonly blobs: ReadonlyMap<string, Buffer>
  readonly snapshotDigest: string
  readonly changeSummaryDigest: string
}

interface StoredWorkspaceSnapshotV1 {
  readonly schemaVersion: 1
  readonly snapshotRef: string
  readonly attemptId: string
  readonly worktreeBindingDigest: string
  readonly baselineDigest: string
  readonly headOid: string
  readonly headTreeOid: string
  readonly indexFileDigest: string
  readonly indexEntries: readonly IndexEntryV1[]
  readonly files: readonly SnapshotFileV1[]
  readonly snapshotDigest: string
  readonly changeSummaryDigest: string
}

interface ValidatedWorkspaceV1 {
  readonly binding: AttemptCheckpointWorkspaceBindingV1
  readonly rootPath: string
  readonly indexPath: string
}

const SNAPSHOT_REF_PATTERN = /^xgwc_[A-Za-z0-9._-]{1,96}$/
const RELATIVE_PATH_LIMIT = 4096

/**
 * Git worktree checkpoint adapter. It captures the worktree and its private
 * index without changing either, and restores only a verified linked Attempt
 * worktree below `managedRoot`. The opaque `snapshotRef` never contains a path.
 *
 * `restore` is also the rollback operation: the checkpoint module can pass the
 * rollback snapshot it captured immediately before a forward restore.
 */
export class GitAttemptCheckpointWorkspaceAdapterV1 implements AttemptCheckpointWorkspacePort {
  private readonly authority: AttemptCheckpointWorkspaceAuthorityV1
  private readonly managedRoot: string
  private readonly snapshotRoot: string
  private readonly idFactory: () => string

  constructor(options: GitAttemptCheckpointWorkspaceAdapterOptionsV1) {
    this.authority = options.authority
    this.managedRoot = ensurePrivateRoot(options.managedRoot)
    this.snapshotRoot = ensurePrivateRoot(options.snapshotRoot)
    this.idFactory = options.idFactory ?? randomUUID
  }

  async inspect(input: {
    attemptId: string
    worktreeBindingDigest: string
  }): Promise<Omit<AttemptWorkspaceCheckpointSnapshotV1, 'snapshotRef'>> {
    const workspace = await this.requireWorkspace(input)
    const state = await collectWorkspaceState(workspace)
    await this.requireStableWorkspace(input, workspace)
    return snapshotProjection(input, state)
  }

  async capture(input: {
    attemptId: string
    worktreeBindingDigest: string
  }): Promise<AttemptWorkspaceCheckpointSnapshotV1> {
    const workspace = await this.requireWorkspace(input)
    const state = await collectWorkspaceState(workspace)
    const snapshotRef = this.nextSnapshotRef()
    await this.persistSnapshot(snapshotRef, input, state)
    try {
      const stableState = await collectWorkspaceState(await this.requireStableWorkspace(input, workspace))
      if (!sameState(state, stableState)) throw error('WORKTREE_CHANGED')
    } catch (cause) {
      await this.removeSnapshot(snapshotRef)
      throw cause
    }
    return {
      ...snapshotProjection(input, state),
      snapshotRef,
    }
  }

  async previewRestore(input: {
    attemptId: string
    worktreeBindingDigest: string
    snapshotRef: string
    expectedDigest: string
  }): Promise<AttemptCheckpointWorkspaceRestorePreviewV1> {
    const workspace = await this.requireWorkspace(input)
    const target = await this.readSnapshot(input)
    const current = await collectWorkspaceState(workspace)
    await this.requireStableWorkspace(input, workspace)
    if (target.baselineDigest !== current.baselineDigest) throw error('BASELINE_MISMATCH')
    const changedRelativePaths = diffRelativePaths(current, target)
    return {
      schemaVersion: 1,
      attemptId: input.attemptId,
      worktreeBindingDigest: input.worktreeBindingDigest,
      targetSnapshotDigest: target.snapshotDigest,
      currentSnapshotDigest: current.snapshotDigest,
      changedRelativePaths,
      changeCount: changedRelativePaths.length,
      changeSummaryDigest: digestJson({
        attemptId: input.attemptId,
        targetSnapshotDigest: target.snapshotDigest,
        currentSnapshotDigest: current.snapshotDigest,
        changedRelativePaths,
      }),
    }
  }

  async restore(input: {
    attemptId: string
    worktreeBindingDigest: string
    snapshotRef: string
    expectedDigest: string
  }): Promise<{
    attemptId: string
    worktreeBindingDigest: string
    restoredSnapshotDigest: string
  }> {
    const workspace = await this.requireWorkspace(input)
    const target = await this.readSnapshot(input)
    const current = await collectWorkspaceState(workspace)
    if (target.baselineDigest !== current.baselineDigest) throw error('BASELINE_MISMATCH')

    const rollbackRef = this.nextSnapshotRef('rollback')
    await this.persistSnapshot(rollbackRef, input, current)
    try {
      await this.applySnapshot(workspace, target)
      const stableWorkspace = await this.requireStableWorkspace(input, workspace)
      const restored = await collectWorkspaceState(stableWorkspace)
      if (restored.snapshotDigest !== target.snapshotDigest) throw error('RESTORE_FAILED')
      return {
        attemptId: input.attemptId,
        worktreeBindingDigest: input.worktreeBindingDigest,
        restoredSnapshotDigest: target.snapshotDigest,
      }
    } catch (cause) {
      try {
        const rollback = await this.readSnapshot({
          ...input,
          snapshotRef: rollbackRef,
          expectedDigest: current.snapshotDigest,
        })
        await this.applySnapshot(workspace, rollback)
        const rolledBack = await collectWorkspaceState(workspace)
        if (rolledBack.snapshotDigest !== current.snapshotDigest) throw error('OUTCOME_UNKNOWN')
      } catch {
        throw error('OUTCOME_UNKNOWN')
      }
      if (cause instanceof AttemptCheckpointWorkspaceAdapterError) throw cause
      throw error('RESTORE_FAILED')
    } finally {
      await this.removeSnapshot(rollbackRef)
    }
  }

  private async requireWorkspace(input: {
    attemptId: string
    worktreeBindingDigest: string
  }): Promise<ValidatedWorkspaceV1> {
    const binding = await this.authority.inspect(input.attemptId)
    if (!binding || binding.attemptId !== input.attemptId) throw error('ATTEMPT_NOT_FOUND')
    if (binding.state === 'BUSY') throw error('ATTEMPT_BUSY')
    if (binding.state !== 'IDLE') throw error('ATTEMPT_UNAVAILABLE')
    if (binding.worktreeBindingDigest !== input.worktreeBindingDigest) throw error('BINDING_MISMATCH')

    const lexicalRoot = resolve(binding.worktreeRoot)
    const rootPath = safeRealpath(lexicalRoot, 'WORKTREE_OUTSIDE_MANAGED_ROOT')
    if (pathKey(rootPath) !== pathKey(lexicalRoot) || !isInside(this.managedRoot, rootPath)) {
      throw error('WORKTREE_OUTSIDE_MANAGED_ROOT')
    }
    const dotGit = join(rootPath, '.git')
    if (!existsSync(dotGit) || !lstatSync(dotGit).isFile()) throw error('WORKTREE_NOT_LINKED')

    const topLevel = safeRealpath(resolve(await gitText(rootPath, ['rev-parse', '--show-toplevel'])), 'WORKTREE_NOT_LINKED')
    const gitDir = safeRealpath(resolve(await gitText(rootPath, ['rev-parse', '--absolute-git-dir'])), 'WORKTREE_NOT_LINKED')
    const commonDir = safeRealpath(
      resolve(await gitText(rootPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])),
      'WORKTREE_NOT_LINKED',
    )
    const indexPath = resolve(await gitText(rootPath, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))
    if (
      pathKey(topLevel) !== pathKey(rootPath)
      || pathKey(gitDir) === pathKey(commonDir)
      || !isInside(gitDir, indexPath)
    ) {
      throw error('WORKTREE_NOT_LINKED')
    }
    return { binding: { ...binding, worktreeRoot: rootPath }, rootPath, indexPath }
  }

  private async requireStableWorkspace(
    input: { attemptId: string; worktreeBindingDigest: string },
    previous: ValidatedWorkspaceV1,
  ): Promise<ValidatedWorkspaceV1> {
    const current = await this.requireWorkspace(input)
    if (pathKey(current.rootPath) !== pathKey(previous.rootPath) || pathKey(current.indexPath) !== pathKey(previous.indexPath)) {
      throw error('BINDING_MISMATCH')
    }
    return current
  }

  private nextSnapshotRef(kind = 'snapshot'): string {
    const component = `${kind}-${this.idFactory()}`
    if (!/^[A-Za-z0-9._-]{1,96}$/.test(component)) throw error('SNAPSHOT_INVALID')
    return `xgwc_${component}`
  }

  private async persistSnapshot(
    snapshotRef: string,
    input: { attemptId: string; worktreeBindingDigest: string },
    state: CollectedWorkspaceStateV1,
  ): Promise<void> {
    const finalRoot = this.snapshotPath(snapshotRef)
    if (existsSync(finalRoot)) throw error('SNAPSHOT_INVALID')
    const pendingRoot = await mkdtemp(join(this.snapshotRoot, '.pending-'))
    try {
      const blobsRoot = join(pendingRoot, 'blobs')
      await mkdir(blobsRoot, { recursive: true })
      for (const [blobDigest, bytes] of state.blobs) {
        await writeFile(join(blobsRoot, digestFileName(blobDigest)), bytes, { flag: 'wx' })
      }
      await writeFile(join(pendingRoot, 'index.bin'), state.indexBytes, { flag: 'wx' })
      const manifest: StoredWorkspaceSnapshotV1 = {
        schemaVersion: 1,
        snapshotRef,
        attemptId: input.attemptId,
        worktreeBindingDigest: input.worktreeBindingDigest,
        baselineDigest: state.baselineDigest,
        headOid: state.headOid,
        headTreeOid: state.headTreeOid,
        indexFileDigest: state.indexFileDigest,
        indexEntries: state.indexEntries,
        files: state.files,
        snapshotDigest: state.snapshotDigest,
        changeSummaryDigest: state.changeSummaryDigest,
      }
      await writeFile(join(pendingRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(pendingRoot, finalRoot)
    } catch (cause) {
      await rm(pendingRoot, { recursive: true, force: true })
      if (cause instanceof AttemptCheckpointWorkspaceAdapterError) throw cause
      throw error('SNAPSHOT_INVALID')
    }
  }

  private async readSnapshot(input: {
    attemptId: string
    worktreeBindingDigest: string
    snapshotRef: string
    expectedDigest: string
  }): Promise<StoredWorkspaceSnapshotV1> {
    const snapshotRoot = this.snapshotPath(input.snapshotRef)
    if (!existsSync(snapshotRoot)) throw error('SNAPSHOT_NOT_FOUND')
    const realSnapshotRoot = safeRealpath(snapshotRoot, 'SNAPSHOT_INVALID')
    if (!isInside(this.snapshotRoot, realSnapshotRoot) || pathKey(realSnapshotRoot) !== pathKey(snapshotRoot)) {
      throw error('SNAPSHOT_INVALID')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(join(realSnapshotRoot, 'manifest.json'), 'utf8'))
    } catch {
      throw error('SNAPSHOT_INVALID')
    }
    const manifest = validateStoredSnapshot(parsed)
    if (
      manifest.snapshotRef !== input.snapshotRef
      || manifest.attemptId !== input.attemptId
      || manifest.worktreeBindingDigest !== input.worktreeBindingDigest
    ) {
      throw error('BINDING_MISMATCH')
    }
    if (manifest.snapshotDigest !== input.expectedDigest) throw error('SNAPSHOT_DIGEST_MISMATCH')
    const semanticDigest = stateDigest(manifest)
    if (semanticDigest !== manifest.snapshotDigest) throw error('SNAPSHOT_INVALID')
    const indexBytes = await readFile(join(realSnapshotRoot, 'index.bin')).catch(() => undefined)
    if (!indexBytes || digestBytes(indexBytes) !== manifest.indexFileDigest) throw error('SNAPSHOT_INVALID')
    for (const file of manifest.files) {
      if (!file.blobDigest) continue
      const bytes = await readFile(join(realSnapshotRoot, 'blobs', digestFileName(file.blobDigest))).catch(() => undefined)
      if (!bytes || digestBytes(bytes) !== file.blobDigest) throw error('SNAPSHOT_INVALID')
    }
    return manifest
  }

  private async applySnapshot(workspace: ValidatedWorkspaceV1, target: StoredWorkspaceSnapshotV1): Promise<void> {
    const current = await collectWorkspaceState(workspace)
    if (current.baselineDigest !== target.baselineDigest) throw error('BASELINE_MISMATCH')
    const changedPaths = diffRelativePaths(current, target)
    const snapshotRoot = this.snapshotPath(target.snapshotRef)

    for (const relativePath of changedPaths) {
      await rm(resolveRelativePath(workspace.rootPath, relativePath), { recursive: false, force: true })
    }
    for (const file of target.files) {
      if (file.kind === 'MISSING' || !changedPaths.includes(file.relativePath)) continue
      const targetPath = resolveRelativePath(workspace.rootPath, file.relativePath)
      await mkdir(dirname(targetPath), { recursive: true })
      const bytes = await readFile(join(snapshotRoot, 'blobs', digestFileName(requiredBlobDigest(file))))
      if (digestBytes(bytes) !== file.blobDigest) throw error('SNAPSHOT_INVALID')
      if (file.kind === 'SYMLINK') {
        await symlink(bytes.toString('utf8'), targetPath)
      } else {
        await writeFile(targetPath, bytes, { flag: 'wx' })
        if (typeof file.fileMode === 'number') await chmod(targetPath, file.fileMode)
      }
    }

    const indexLock = `${workspace.indexPath}.lock`
    if (existsSync(indexLock)) throw error('ATTEMPT_BUSY')
    const indexBytes = await readFile(join(snapshotRoot, 'index.bin'))
    if (digestBytes(indexBytes) !== target.indexFileDigest) throw error('SNAPSHOT_INVALID')
    const pendingIndex = `${workspace.indexPath}.xiaogui-${randomUUID()}.tmp`
    try {
      await writeFile(pendingIndex, indexBytes, { flag: 'wx' })
      await rename(pendingIndex, workspace.indexPath)
    } finally {
      await rm(pendingIndex, { force: true })
    }
  }

  private snapshotPath(snapshotRef: string): string {
    if (!SNAPSHOT_REF_PATTERN.test(snapshotRef)) throw error('SNAPSHOT_INVALID')
    const snapshotPath = resolve(this.snapshotRoot, snapshotRef)
    if (!isInside(this.snapshotRoot, snapshotPath)) throw error('SNAPSHOT_INVALID')
    return snapshotPath
  }

  private async removeSnapshot(snapshotRef: string): Promise<void> {
    await rm(this.snapshotPath(snapshotRef), { recursive: true, force: true })
  }
}

function snapshotProjection(
  input: { attemptId: string; worktreeBindingDigest: string },
  state: Pick<CollectedWorkspaceStateV1, 'snapshotDigest' | 'baselineDigest' | 'changeSummaryDigest'>,
): Omit<AttemptWorkspaceCheckpointSnapshotV1, 'snapshotRef'> {
  return {
    attemptId: input.attemptId,
    worktreeBindingDigest: input.worktreeBindingDigest,
    snapshotDigest: state.snapshotDigest,
    baselineDigest: state.baselineDigest,
    changeSummaryDigest: state.changeSummaryDigest,
  }
}

async function collectWorkspaceState(workspace: ValidatedWorkspaceV1): Promise<CollectedWorkspaceStateV1> {
  const [headOid, headTreeOid, headRaw, indexRaw, untrackedRaw, indexStageRaw, statusRaw, indexBytes] = await Promise.all([
    gitText(workspace.rootPath, ['rev-parse', 'HEAD']),
    gitText(workspace.rootPath, ['rev-parse', 'HEAD^{tree}']),
    gitText(workspace.rootPath, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], false),
    gitText(workspace.rootPath, ['ls-files', '-z'], false),
    gitText(workspace.rootPath, ['ls-files', '--others', '--exclude-standard', '-z'], false),
    gitText(workspace.rootPath, ['ls-files', '--stage', '-z'], false),
    gitText(workspace.rootPath, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], false),
    readFile(workspace.indexPath),
  ])
  const headPaths = new Set(parseNulList(headRaw).map(cleanRelativePath))
  const indexPaths = new Set(parseNulList(indexRaw).map(cleanRelativePath))
  const untrackedPaths = new Set(parseNulList(untrackedRaw).map(cleanRelativePath))
  const allPaths = [...new Set([...headPaths, ...indexPaths, ...untrackedPaths])].sort(compareStrings)
  const blobs = new Map<string, Buffer>()
  const files: SnapshotFileV1[] = []
  for (const relativePath of allPaths) {
    const targetPath = resolveRelativePath(workspace.rootPath, relativePath)
    let info
    try {
      info = await lstat(targetPath, { bigint: true })
    } catch (cause) {
      if (!isNodeError(cause, 'ENOENT')) throw cause
      files.push({
        relativePath,
        inHead: headPaths.has(relativePath),
        inIndex: indexPaths.has(relativePath),
        untracked: untrackedPaths.has(relativePath),
        kind: 'MISSING',
      })
      continue
    }
    if (!info.isFile() && !info.isSymbolicLink()) throw error('UNSUPPORTED_ENTRY')
    if (info.isFile() && info.nlink !== 1n) throw error('UNSUPPORTED_ENTRY')
    const bytes = info.isSymbolicLink()
      ? Buffer.from(await readlink(targetPath), 'utf8')
      : await readFile(targetPath)
    const blobDigest = digestBytes(bytes)
    blobs.set(blobDigest, bytes)
    files.push({
      relativePath,
      inHead: headPaths.has(relativePath),
      inIndex: indexPaths.has(relativePath),
      untracked: untrackedPaths.has(relativePath),
      kind: info.isSymbolicLink() ? 'SYMLINK' : 'FILE',
      fileMode: Number(info.mode & 0o777n),
      blobDigest,
    })
  }
  const baselineDigest = digestJson({ headOid, headTreeOid })
  const indexEntries = parseIndexEntries(indexStageRaw)
  const semantic = { baselineDigest, indexEntries, files }
  return {
    baselineDigest,
    headOid,
    headTreeOid,
    indexBytes,
    indexFileDigest: digestBytes(indexBytes),
    indexEntries,
    files,
    blobs,
    snapshotDigest: stateDigest(semantic),
    changeSummaryDigest: digestJson({ baselineDigest, status: statusRaw }),
  }
}

function diffRelativePaths(
  current: Pick<CollectedWorkspaceStateV1, 'files' | 'indexEntries'>,
  target: Pick<StoredWorkspaceSnapshotV1, 'files' | 'indexEntries'>,
): readonly string[] {
  const currentFiles = new Map(current.files.map((file) => [file.relativePath, fileFingerprint(file)]))
  const targetFiles = new Map(target.files.map((file) => [file.relativePath, fileFingerprint(file)]))
  const currentIndex = indexFingerprints(current.indexEntries)
  const targetIndex = indexFingerprints(target.indexEntries)
  const paths = new Set([...currentFiles.keys(), ...targetFiles.keys(), ...currentIndex.keys(), ...targetIndex.keys()])
  return [...paths]
    .filter((path) => currentFiles.get(path) !== targetFiles.get(path) || currentIndex.get(path) !== targetIndex.get(path))
    .sort(compareStrings)
}

function indexFingerprints(entries: readonly IndexEntryV1[]): Map<string, string> {
  const grouped = new Map<string, IndexEntryV1[]>()
  for (const entry of entries) grouped.set(entry.relativePath, [...(grouped.get(entry.relativePath) ?? []), entry])
  return new Map([...grouped].map(([path, values]) => [path, JSON.stringify(values)]))
}

function fileFingerprint(file: SnapshotFileV1): string {
  return JSON.stringify(file)
}

function stateDigest(state: {
  baselineDigest: string
  indexEntries: readonly IndexEntryV1[]
  files: readonly SnapshotFileV1[]
}): string {
  return digestJson({
    schemaVersion: 1,
    baselineDigest: state.baselineDigest,
    indexEntries: state.indexEntries,
    files: state.files,
  })
}

function sameState(left: CollectedWorkspaceStateV1, right: CollectedWorkspaceStateV1): boolean {
  return left.snapshotDigest === right.snapshotDigest
    && left.baselineDigest === right.baselineDigest
    && left.changeSummaryDigest === right.changeSummaryDigest
}

function validateStoredSnapshot(value: unknown): StoredWorkspaceSnapshotV1 {
  if (!value || typeof value !== 'object') throw error('SNAPSHOT_INVALID')
  const input = value as Record<string, unknown>
  if (
    input.schemaVersion !== 1
    || typeof input.snapshotRef !== 'string'
    || !SNAPSHOT_REF_PATTERN.test(input.snapshotRef)
    || typeof input.attemptId !== 'string'
    || typeof input.worktreeBindingDigest !== 'string'
    || typeof input.baselineDigest !== 'string'
    || typeof input.headOid !== 'string'
    || typeof input.headTreeOid !== 'string'
    || typeof input.indexFileDigest !== 'string'
    || typeof input.snapshotDigest !== 'string'
    || typeof input.changeSummaryDigest !== 'string'
    || !Array.isArray(input.indexEntries)
    || !Array.isArray(input.files)
  ) {
    throw error('SNAPSHOT_INVALID')
  }
  const indexEntries = input.indexEntries.map((entry) => validateIndexEntry(entry))
  const files = input.files.map((file) => validateSnapshotFile(file))
  assertUnique(files.map((file) => file.relativePath))
  return {
    schemaVersion: 1,
    snapshotRef: input.snapshotRef,
    attemptId: input.attemptId,
    worktreeBindingDigest: input.worktreeBindingDigest,
    baselineDigest: input.baselineDigest,
    headOid: input.headOid,
    headTreeOid: input.headTreeOid,
    indexFileDigest: input.indexFileDigest,
    indexEntries,
    files,
    snapshotDigest: input.snapshotDigest,
    changeSummaryDigest: input.changeSummaryDigest,
  }
}

function validateIndexEntry(value: unknown): IndexEntryV1 {
  if (!value || typeof value !== 'object') throw error('SNAPSHOT_INVALID')
  const input = value as Record<string, unknown>
  if (
    typeof input.relativePath !== 'string'
    || typeof input.mode !== 'string'
    || typeof input.objectId !== 'string'
    || typeof input.stage !== 'number'
    || !/^[0-7]{6}$/.test(input.mode)
    || !/^[0-9a-f]{40,64}$/i.test(input.objectId)
    || !Number.isInteger(input.stage)
    || input.stage < 0
    || input.stage > 3
  ) {
    throw error('SNAPSHOT_INVALID')
  }
  return {
    relativePath: cleanRelativePath(input.relativePath),
    mode: input.mode,
    objectId: input.objectId,
    stage: input.stage,
  }
}

function validateSnapshotFile(value: unknown): SnapshotFileV1 {
  if (!value || typeof value !== 'object') throw error('SNAPSHOT_INVALID')
  const input = value as Record<string, unknown>
  if (
    typeof input.relativePath !== 'string'
    || typeof input.inHead !== 'boolean'
    || typeof input.inIndex !== 'boolean'
    || typeof input.untracked !== 'boolean'
    || (input.kind !== 'FILE' && input.kind !== 'SYMLINK' && input.kind !== 'MISSING')
    || (input.fileMode !== undefined && (typeof input.fileMode !== 'number' || !Number.isInteger(input.fileMode)))
    || (input.blobDigest !== undefined && typeof input.blobDigest !== 'string')
  ) {
    throw error('SNAPSHOT_INVALID')
  }
  if (input.kind === 'MISSING' ? input.blobDigest !== undefined : typeof input.blobDigest !== 'string') {
    throw error('SNAPSHOT_INVALID')
  }
  return {
    relativePath: cleanRelativePath(input.relativePath),
    inHead: input.inHead,
    inIndex: input.inIndex,
    untracked: input.untracked,
    kind: input.kind,
    fileMode: input.fileMode as number | undefined,
    blobDigest: input.blobDigest as string | undefined,
  }
}

function parseIndexEntries(raw: string): readonly IndexEntryV1[] {
  return parseNulList(raw).map((record) => {
    const tab = record.indexOf('\t')
    const metadata = tab >= 0 ? record.slice(0, tab) : ''
    const relativePath = tab >= 0 ? record.slice(tab + 1) : ''
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])$/.exec(metadata)
    if (!match) throw error('UNSUPPORTED_ENTRY')
    return {
      relativePath: cleanRelativePath(relativePath),
      mode: match[1],
      objectId: match[2],
      stage: Number(match[3]),
    }
  }).sort((left, right) => compareStrings(left.relativePath, right.relativePath) || left.stage - right.stage)
}

function parseNulList(raw: string): readonly string[] {
  if (!raw) return []
  const values = raw.split('\0')
  if (values.at(-1) === '') values.pop()
  return values
}

function cleanRelativePath(value: string): string {
  if (
    !value
    || value.length > RELATIVE_PATH_LIMIT
    || value.includes('\0')
    || value.includes('\\')
    || isAbsolute(value)
    || posix.isAbsolute(value)
  ) {
    throw error('SNAPSHOT_INVALID')
  }
  const normalized = posix.normalize(value)
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized === '.git' || normalized.startsWith('.git/')) {
    throw error('SNAPSHOT_INVALID')
  }
  return normalized
}

function resolveRelativePath(rootPath: string, relativePath: string): string {
  const safePath = cleanRelativePath(relativePath)
  const target = resolve(rootPath, ...safePath.split('/'))
  if (!isInside(rootPath, target)) throw error('SNAPSHOT_INVALID')
  return target
}

function requiredBlobDigest(file: SnapshotFileV1): string {
  if (!file.blobDigest) throw error('SNAPSHOT_INVALID')
  return file.blobDigest
}

function digestFileName(digest: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest)
  if (!match) throw error('SNAPSHOT_INVALID')
  return match[1]
}

function digestBytes(value: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function digestJson(value: unknown): string {
  return digestBytes(JSON.stringify(value))
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw error('SNAPSHOT_INVALID')
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function ensurePrivateRoot(root: string): string {
  const lexical = resolve(root)
  mkdirSync(lexical, { recursive: true })
  const real = safeRealpath(lexical, 'WORKTREE_OUTSIDE_MANAGED_ROOT')
  if (pathKey(lexical) !== pathKey(real)) throw error('WORKTREE_OUTSIDE_MANAGED_ROOT')
  return real
}

function safeRealpath(path: string, code: AttemptCheckpointWorkspaceAdapterErrorCodeV1): string {
  try {
    return realpathSync.native(path)
  } catch {
    throw error(code)
  }
}

function isInside(root: string, target: string): boolean {
  const value = relative(root, target)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

function pathKey(value: string): string {
  const resolved = resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && (value as NodeJS.ErrnoException).code === code
}

function error(code: AttemptCheckpointWorkspaceAdapterErrorCodeV1): AttemptCheckpointWorkspaceAdapterError {
  return new AttemptCheckpointWorkspaceAdapterError(code)
}

function gitText(cwd: string, args: readonly string[], trim = true): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }, (cause, stdout) => {
      if (cause) {
        reject(error('WORKTREE_NOT_LINKED'))
        return
      }
      resolveResult(trim ? stdout.trim() : stdout)
    })
  })
}
