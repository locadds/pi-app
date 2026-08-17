import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'

import type { AttemptId, WorkspacePreparedReceiptM2BV1, WorkspaceReceiptId } from '@shared/xiaogui-collaboration-hub'
import type { RuntimeWorkspaceBindingV1 } from '@shared/xiaogui-agent-runtime'

export type AttemptFileOperationV1 = 'MODIFY' | 'CREATE' | 'DELETE'
export type CreateBatchStateV1 = 'PENDING' | 'COMMITTED' | 'ROLLED_BACK'
export type ScopeExpansionStateV1 = 'REQUESTED' | 'APPROVED' | 'REJECTED'

export interface AttemptFileGrantV1 {
  readonly operation: AttemptFileOperationV1
  readonly relativePath: string
  readonly baselineDigest?: string
}

export interface AttemptFileManifestV1 {
  readonly attemptId: string
  readonly version: number
  readonly grants: readonly AttemptFileGrantV1[]
  readonly manifestDigest: string
}

export interface AttemptScopeExpansionRequestV1 {
  readonly requestId: string
  readonly attemptId: string
  readonly baseManifestVersion: number
  readonly requestedGrants: readonly AttemptFileGrantV1[]
  readonly reasonDigest: string
  readonly requestDigest: string
  readonly state: ScopeExpansionStateV1
}

export interface AttemptWorkspacePrepareRequestV1 {
  readonly attemptId: AttemptId | string
  readonly compositionAttemptId: string
  readonly requestDigest: string
  readonly baselineBindingDigest: string
  readonly compositionDigest: string
  readonly targetProjectRoot: string
  readonly managedRoot: string
  readonly baseRevision: string
  readonly baselineTreeHash: string
  readonly manifest: Omit<AttemptFileManifestV1, 'manifestDigest'>
  readonly ownerId: string
  readonly faultInjection?: 'BEFORE_CREATE' | 'AFTER_CREATE_BEFORE_MANIFEST_COMMIT' | 'AFTER_MANIFEST_COMMIT'
}

export interface AttemptWorktreeHandleV1 {
  readonly attemptId: string
  readonly attemptWorktreeId: string
  readonly rootPath: string
  readonly manifestDigest: string
  readonly manifestVersion: number
}

export interface AttemptWorkspacePreparedV1 {
  readonly receipt: WorkspacePreparedReceiptM2BV1
  readonly workspace: RuntimeWorkspaceBindingV1
  readonly handle: AttemptWorktreeHandleV1
  readonly manifest: AttemptFileManifestV1
  readonly allowedRelativePaths: readonly string[]
}

export interface AttemptWorkspaceInspectionV1 {
  readonly ok: boolean
  readonly actualRelativePaths: readonly string[]
  readonly rejectedReasonCode?: AttemptWorkspaceReasonCodeV1
  readonly inspectionDigest: string
}

interface PorcelainChangeV1 {
  readonly status: string
  readonly relativePath: string
}

export type AttemptWorkspaceReasonCodeV1 =
  | 'ATTEMPT_ID_INVALID'
  | 'BASE_REVISION_NOT_COMMIT'
  | 'BASELINE_TREE_MISMATCH'
  | 'CREATE_BATCH_PENDING'
  | 'DELETE_FORBIDDEN'
  | 'GIT_COMMAND_FAILED'
  | 'MANAGED_ROOT_INVALID'
  | 'MANIFEST_CONFLICT'
  | 'MANIFEST_VERSION_CONFLICT'
  | 'PATH_ALIAS'
  | 'PATH_CONFLICT'
  | 'PATH_FORBIDDEN'
  | 'PATH_OUTSIDE_ROOT'
  | 'REPO_NOT_CLEAN_FOR_BASELINE'
  | 'REPO_NOT_GIT'
  | 'TARGET_ALREADY_EXISTS'
  | 'TARGET_DIGEST_MISMATCH'
  | 'TARGET_HARDLINK'
  | 'TARGET_MISSING'
  | 'TARGET_NOT_EMPTY'
  | 'TARGET_NOT_FILE'
  | 'WORKTREE_ALREADY_EXISTS'
  | 'WORKTREE_DRIFT'

export class AttemptWorkspaceError extends Error {
  constructor(readonly reasonCode: AttemptWorkspaceReasonCodeV1) {
    super(reasonCode)
    this.name = 'AttemptWorkspaceError'
  }
}

export interface CreateBatchTargetV1 {
  readonly relativePath: string
  readonly realPath: string
  readonly identityDigest?: string
}

export interface CreateBatchRecordV1 {
  readonly batchId: string
  readonly attemptId: string
  readonly ownerId: string
  readonly manifestVersion: number
  readonly state: CreateBatchStateV1
  readonly targets: readonly CreateBatchTargetV1[]
}

export interface PreparedRecord {
  readonly request: AttemptWorkspacePrepareRequestV1
  readonly result: AttemptWorkspacePreparedV1
}

export interface AttemptWorkspaceRegistryV1 {
  getPrepared(attemptId: string): PreparedRecord | undefined
  putPrepared(record: PreparedRecord): void
  getManifest(attemptId: string): AttemptFileManifestV1 | undefined
  putManifest(manifest: AttemptFileManifestV1): void
  putScopeRequest(request: AttemptScopeExpansionRequestV1): void
  getScopeRequest(requestId: string): AttemptScopeExpansionRequestV1 | undefined
  updateScopeRequest(requestId: string, state: ScopeExpansionStateV1): void
  putCreateBatch(batch: CreateBatchRecordV1): void
  getCreateBatch(batchId: string): CreateBatchRecordV1 | undefined
  updateCreateBatch(batch: CreateBatchRecordV1): void
  pendingCreateBatches(): readonly CreateBatchRecordV1[]
}

export class InMemoryAttemptWorkspaceRegistryV1 implements AttemptWorkspaceRegistryV1 {
  private readonly prepared = new Map<string, PreparedRecord>()
  private readonly manifests = new Map<string, AttemptFileManifestV1>()
  private readonly scopeRequests = new Map<string, AttemptScopeExpansionRequestV1>()
  private readonly createBatches = new Map<string, CreateBatchRecordV1>()

  getPrepared(attemptId: string): PreparedRecord | undefined {
    return this.prepared.get(attemptId)
  }

  putPrepared(record: PreparedRecord): void {
    this.prepared.set(record.request.attemptId, record)
  }

  getManifest(attemptId: string): AttemptFileManifestV1 | undefined {
    return this.manifests.get(attemptId)
  }

  putManifest(manifest: AttemptFileManifestV1): void {
    this.manifests.set(manifest.attemptId, manifest)
  }

  putScopeRequest(request: AttemptScopeExpansionRequestV1): void {
    this.scopeRequests.set(request.requestId, request)
  }

  getScopeRequest(requestId: string): AttemptScopeExpansionRequestV1 | undefined {
    return this.scopeRequests.get(requestId)
  }

  updateScopeRequest(requestId: string, state: ScopeExpansionStateV1): void {
    const current = this.scopeRequests.get(requestId)
    if (current) this.scopeRequests.set(requestId, { ...current, state })
  }

  putCreateBatch(batch: CreateBatchRecordV1): void {
    this.createBatches.set(batch.batchId, batch)
  }

  getCreateBatch(batchId: string): CreateBatchRecordV1 | undefined {
    return this.createBatches.get(batchId)
  }

  updateCreateBatch(batch: CreateBatchRecordV1): void {
    this.createBatches.set(batch.batchId, batch)
  }

  pendingCreateBatches(): readonly CreateBatchRecordV1[] {
    return [...this.createBatches.values()].filter((batch) => batch.state === 'PENDING')
  }
}

export class SqliteAttemptWorkspaceRegistryV1 implements AttemptWorkspaceRegistryV1 {
  private readonly db: DatabaseSync

  constructor(options: { dbPath: string }) {
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec('pragma foreign_keys = on')
    this.db.exec('pragma journal_mode = WAL')
    this.db.exec('pragma busy_timeout = 5000')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  getPrepared(attemptId: string): PreparedRecord | undefined {
    const row = this.db.prepare('select request_json, result_json from attempt_workspace_prepared where attempt_id = ?').get(attemptId) as
      | { request_json: string; result_json: string }
      | undefined
    return row ? { request: JSON.parse(row.request_json), result: JSON.parse(row.result_json) } : undefined
  }

  putPrepared(record: PreparedRecord): void {
    this.db
      .prepare('insert or replace into attempt_workspace_prepared (attempt_id, request_json, result_json) values (?, ?, ?)')
      .run(record.request.attemptId, JSON.stringify(record.request), JSON.stringify(record.result))
  }

  getManifest(attemptId: string): AttemptFileManifestV1 | undefined {
    const row = this.db.prepare('select manifest_json from attempt_file_manifests where attempt_id = ?').get(attemptId) as
      | { manifest_json: string }
      | undefined
    return row ? JSON.parse(row.manifest_json) : undefined
  }

  putManifest(manifest: AttemptFileManifestV1): void {
    this.db
      .prepare('insert or replace into attempt_file_manifests (attempt_id, version, manifest_digest, manifest_json) values (?, ?, ?, ?)')
      .run(manifest.attemptId, manifest.version, manifest.manifestDigest, JSON.stringify(manifest))
  }

  putScopeRequest(request: AttemptScopeExpansionRequestV1): void {
    this.db
      .prepare('insert or replace into scope_expansion_requests (request_id, attempt_id, state, request_json) values (?, ?, ?, ?)')
      .run(request.requestId, request.attemptId, request.state, JSON.stringify(request))
  }

  getScopeRequest(requestId: string): AttemptScopeExpansionRequestV1 | undefined {
    const row = this.db.prepare('select request_json from scope_expansion_requests where request_id = ?').get(requestId) as
      | { request_json: string }
      | undefined
    return row ? JSON.parse(row.request_json) : undefined
  }

  updateScopeRequest(requestId: string, state: ScopeExpansionStateV1): void {
    const current = this.getScopeRequest(requestId)
    if (!current) return
    this.putScopeRequest({ ...current, state })
  }

  putCreateBatch(batch: CreateBatchRecordV1): void {
    this.updateCreateBatch(batch)
  }

  getCreateBatch(batchId: string): CreateBatchRecordV1 | undefined {
    const row = this.db.prepare('select batch_json from create_batches where batch_id = ?').get(batchId) as { batch_json: string } | undefined
    return row ? JSON.parse(row.batch_json) : undefined
  }

  updateCreateBatch(batch: CreateBatchRecordV1): void {
    this.db
      .prepare('insert or replace into create_batches (batch_id, attempt_id, owner_id, state, batch_json) values (?, ?, ?, ?, ?)')
      .run(batch.batchId, batch.attemptId, batch.ownerId, batch.state, JSON.stringify(batch))
  }

  pendingCreateBatches(): readonly CreateBatchRecordV1[] {
    const rows = this.db.prepare('select batch_json from create_batches where state = ?').all('PENDING') as { batch_json: string }[]
    return rows.map((row) => JSON.parse(row.batch_json))
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists attempt_workspace_prepared (
        attempt_id text primary key,
        request_json text not null,
        result_json text not null
      );
      create table if not exists attempt_file_manifests (
        attempt_id text primary key,
        version integer not null,
        manifest_digest text not null,
        manifest_json text not null
      );
      create table if not exists scope_expansion_requests (
        request_id text primary key,
        attempt_id text not null,
        state text not null,
        request_json text not null
      );
      create table if not exists create_batches (
        batch_id text primary key,
        attempt_id text not null,
        owner_id text not null,
        state text not null,
        batch_json text not null
      );
      create index if not exists create_batches_state on create_batches(state, attempt_id);
    `)
  }
}

export interface AttemptWorkspacePortV1 {
  prepare(request: AttemptWorkspacePrepareRequestV1): Promise<AttemptWorkspacePreparedV1>
  runtimeBinding(attemptId: string): RuntimeWorkspaceBindingV1 | undefined
  manifest(attemptId: string): AttemptFileManifestV1 | undefined
  requestScopeExpansion(input: {
    requestId: string
    attemptId: string
    baseManifestVersion: number
    requestedGrants: readonly AttemptFileGrantV1[]
    reasonDigest: string
  }): AttemptScopeExpansionRequestV1
  approveScopeExpansion(input: {
    requestId: string
    handle: AttemptWorktreeHandleV1
    ownerId: string
  }): Promise<AttemptFileManifestV1>
  auditChanges(attemptId: string): Promise<AttemptWorkspaceInspectionV1>
}

export class GitAttemptWorkspaceServiceV1 implements AttemptWorkspacePortV1 {
  constructor(private readonly registry: AttemptWorkspaceRegistryV1) {}

  async prepare(request: AttemptWorkspacePrepareRequestV1): Promise<AttemptWorkspacePreparedV1> {
    const attemptId = cleanId(request.attemptId)
    if (request.manifest.attemptId !== attemptId) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    if (request.manifest.version !== 1) throw new AttemptWorkspaceError('MANIFEST_VERSION_CONFLICT')
    const existing = this.registry.getPrepared(attemptId)
    if (existing) {
      if (prepareConflictDigest(existing.request) !== prepareConflictDigest(request)) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
      return existing.result
    }

    assertCommitOid(request.baseRevision)
    const repoRoot = safeRealpath(resolve(request.targetProjectRoot), 'REPO_NOT_GIT')
    assertGitRepository(repoRoot)
    await assertCleanRepository(repoRoot)
    await assertBaseTree(repoRoot, request.baseRevision, request.baselineTreeHash)

    const managedRoot = ensureManagedRoot(request.managedRoot)
    const worktreeRoot = resolve(managedRoot, safeAttemptDirectoryName(attemptId))
    if (!isInside(managedRoot, worktreeRoot)) throw new AttemptWorkspaceError('PATH_OUTSIDE_ROOT')
    const replayedManifest = this.registry.getManifest(attemptId)
    if (existsSync(worktreeRoot)) {
      const realWorktreeRoot = safeRealpath(worktreeRoot, 'WORKTREE_DRIFT')
      const expectedManifestDigest = digestJson({
        attemptId,
        version: request.manifest.version,
        grants: normalizeManifestGrants(realWorktreeRoot, request.manifest.grants, { existingCreatesAreAllowed: true }),
      })
      if (!replayedManifest || replayedManifest.manifestDigest !== expectedManifestDigest) {
        throw new AttemptWorkspaceError('WORKTREE_ALREADY_EXISTS')
      }
      const result = buildPreparedResult(request, attemptId, repoRoot, realWorktreeRoot, replayedManifest)
      this.registry.putPrepared({ request: { ...request, attemptId }, result })
      return result
    }

    await git(repoRoot, ['worktree', 'add', '--detach', worktreeRoot, request.baseRevision])
    const realWorktreeRoot = safeRealpath(worktreeRoot, 'WORKTREE_DRIFT')
    if (pathKey(realWorktreeRoot) !== pathKey(worktreeRoot) || !isInside(managedRoot, realWorktreeRoot)) {
      throw new AttemptWorkspaceError('WORKTREE_DRIFT')
    }

    const manifest = await materializeManifest({
      rootPath: realWorktreeRoot,
      manifest: request.manifest,
      attemptId,
      ownerId: request.ownerId,
      registry: this.registry,
      faultInjection: request.faultInjection,
    })

    const result = buildPreparedResult(request, attemptId, repoRoot, realWorktreeRoot, manifest)
    this.registry.putPrepared({ request: { ...request, attemptId }, result })
    return result
  }

  runtimeBinding(attemptId: string): RuntimeWorkspaceBindingV1 | undefined {
    return this.registry.getPrepared(attemptId)?.result.workspace
  }

  manifest(attemptId: string): AttemptFileManifestV1 | undefined {
    return this.registry.getManifest(attemptId)
  }

  async inspect(handle: AttemptWorktreeHandleV1): Promise<AttemptWorkspaceInspectionV1> {
    const manifest = this.registry.getManifest(handle.attemptId)
    if (!manifest || manifest.manifestDigest !== handle.manifestDigest || manifest.version !== handle.manifestVersion) {
      throw new AttemptWorkspaceError('MANIFEST_VERSION_CONFLICT')
    }
    const status = await git(handle.rootPath, ['status', '--porcelain=v1', '--untracked-files=all'])
    const changes = parsePorcelainStatus(status.stdout)
    const actual = changes.map((change) => change.relativePath)
    const allowed = new Set(manifest.grants.map((grant) => grant.relativePath))
    const ok = changes.every((change) => allowed.has(change.relativePath)) && changes.every((change) => isManifestSubsetChange(change, manifest))
    const inspectionDigest = digestJson({ ok, actual, manifestDigest: manifest.manifestDigest })
    return ok
      ? { ok: true, actualRelativePaths: actual, inspectionDigest }
      : { ok: false, actualRelativePaths: actual, rejectedReasonCode: 'PATH_FORBIDDEN', inspectionDigest }
  }

  async auditChanges(attemptId: string): Promise<AttemptWorkspaceInspectionV1> {
    const prepared = this.registry.getPrepared(attemptId)
    if (!prepared) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    return this.inspect(prepared.result.handle)
  }

  requestScopeExpansion(input: {
    requestId: string
    attemptId: string
    baseManifestVersion: number
    requestedGrants: readonly AttemptFileGrantV1[]
    reasonDigest: string
  }): AttemptScopeExpansionRequestV1 {
    const request: AttemptScopeExpansionRequestV1 = {
      ...input,
      requestDigest: digestJson(input),
      state: 'REQUESTED',
    }
    const existing = this.registry.getScopeRequest(request.requestId)
    if (existing) {
      if (existing.requestDigest !== request.requestDigest) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
      return existing
    }
    this.registry.putScopeRequest(request)
    return request
  }

  async approveScopeExpansion(input: {
    requestId: string
    handle: AttemptWorktreeHandleV1
    ownerId: string
  }): Promise<AttemptFileManifestV1> {
    const request = this.registry.getScopeRequest(input.requestId)
    if (!request || request.state !== 'REQUESTED') throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    const current = this.registry.getManifest(request.attemptId)
    if (!current || current.version !== request.baseManifestVersion) throw new AttemptWorkspaceError('MANIFEST_VERSION_CONFLICT')
    const newGrants = normalizeManifestGrants(input.handle.rootPath, request.requestedGrants)
    assertNoManifestConflict(current.grants, newGrants)
    const next = await materializeManifest({
      rootPath: input.handle.rootPath,
      manifest: {
        attemptId: request.attemptId,
        version: current.version + 1,
        grants: [...current.grants, ...newGrants],
      },
      grantsToMaterialize: newGrants,
      attemptId: request.attemptId,
      ownerId: input.ownerId,
      registry: this.registry,
    })
    this.registry.updateScopeRequest(input.requestId, 'APPROVED')
    return next
  }

  recoverPendingCreateBatches(): void {
    for (const batch of this.registry.pendingCreateBatches()) {
      for (const target of batch.targets) {
        rollbackCreatedTarget(target)
      }
      this.registry.updateCreateBatch({ ...batch, state: 'ROLLED_BACK' })
    }
  }
}

function buildPreparedResult(
  request: AttemptWorkspacePrepareRequestV1,
  attemptId: string,
  repoRoot: string,
  realWorktreeRoot: string,
  manifest: AttemptFileManifestV1,
): AttemptWorkspacePreparedV1 {
  const receiptBinding = {
      compositionAttemptId: request.compositionAttemptId,
      attemptId: attemptId as AttemptId,
      requestDigest: request.requestDigest,
      baselineBindingDigest: request.baselineBindingDigest,
      compositionDigest: request.compositionDigest,
    }
    const workspace: RuntimeWorkspaceBindingV1 = {
      attemptWorktreeId: `xhbwt_${hashHex(attemptId).slice(0, 32)}`,
      worktreeRootDigest: digestString(realWorktreeRoot),
      baseRevisionDigest: digestString(request.baseRevision),
      targetProjectRootDigest: digestString(repoRoot),
      writePolicy: 'ATTEMPT_WORKTREE_ONLY',
    }
  const receipt: WorkspacePreparedReceiptM2BV1 = {
      status: 'PREPARED',
      workspaceReceiptId: (`xhbw_${hashHex(`${attemptId}:${manifest.manifestDigest}`).slice(0, 32)}`) as WorkspaceReceiptId,
      receiptDigest: digestJson({ ...receiptBinding, workspace, manifestDigest: manifest.manifestDigest }),
      ...receiptBinding,
    }
  return {
      receipt,
      workspace,
      manifest,
      handle: {
        attemptId,
        attemptWorktreeId: workspace.attemptWorktreeId,
        rootPath: realWorktreeRoot,
        manifestDigest: manifest.manifestDigest,
        manifestVersion: manifest.version,
      },
      allowedRelativePaths: manifest.grants.map((grant) => grant.relativePath),
    }
}

export { GitAttemptWorkspaceServiceV1 as AttemptGitWorkspacePortV1 }

async function materializeManifest(input: {
  rootPath: string
  manifest: Omit<AttemptFileManifestV1, 'manifestDigest'>
  grantsToMaterialize?: readonly AttemptFileGrantV1[]
  attemptId: string
  ownerId: string
  registry: AttemptWorkspaceRegistryV1
  faultInjection?: AttemptWorkspacePrepareRequestV1['faultInjection']
}): Promise<AttemptFileManifestV1> {
  if (input.faultInjection === 'BEFORE_CREATE') {
    const batch = pendingCreateBatch(input.attemptId, input.manifest.version, input.ownerId, [])
    input.registry.putCreateBatch(batch)
    throw new AttemptWorkspaceError('CREATE_BATCH_PENDING')
  }

  const grants = normalizeManifestGrants(input.rootPath, input.manifest.grants, { existingCreatesAreAllowed: Boolean(input.grantsToMaterialize) })
  const grantsToMaterialize = input.grantsToMaterialize ?? normalizeManifestGrants(input.rootPath, input.manifest.grants)
  const createGrants = grantsToMaterialize.filter((grant) => grant.operation === 'CREATE')
  const createdTargets: CreateBatchTargetV1[] = []
  const batch = pendingCreateBatch(input.attemptId, input.manifest.version, input.ownerId, createdTargets)
  if (createGrants.length > 0) input.registry.putCreateBatch(batch)

  try {
    for (const grant of createGrants) {
      const target = resolveManifestPath(input.rootPath, grant.relativePath)
      const descriptor = openSync(target.realPath, 'wx')
      closeSync(descriptor)
      const created = { relativePath: grant.relativePath, realPath: target.realPath, identityDigest: readFileIdentity(target.realPath).identityDigest }
      createdTargets.push(created)
      input.registry.updateCreateBatch({ ...batch, targets: [...createdTargets] })
    }
    if (input.faultInjection === 'AFTER_CREATE_BEFORE_MANIFEST_COMMIT') {
      throw new AttemptWorkspaceError('CREATE_BATCH_PENDING')
    }
    const manifest: AttemptFileManifestV1 = {
      attemptId: input.attemptId,
      version: input.manifest.version,
      grants,
      manifestDigest: digestJson({ attemptId: input.attemptId, version: input.manifest.version, grants }),
    }
    input.registry.putManifest(manifest)
    if (createGrants.length > 0) input.registry.updateCreateBatch({ ...batch, state: 'COMMITTED', targets: [...createdTargets] })
    if (input.faultInjection === 'AFTER_MANIFEST_COMMIT') {
      throw new AttemptWorkspaceError('CREATE_BATCH_PENDING')
    }
    return manifest
  } catch (error) {
    if (input.faultInjection === 'AFTER_CREATE_BEFORE_MANIFEST_COMMIT') {
      throw error
    }
    const committed = input.registry.getCreateBatch(batch.batchId)?.state === 'COMMITTED'
    if (!committed) {
      for (const target of createdTargets) rollbackCreatedTarget(target)
      if (createGrants.length > 0) input.registry.updateCreateBatch({ ...batch, state: 'ROLLED_BACK', targets: [...createdTargets] })
    }
    throw error
  }
}

function normalizeManifestGrants(
  rootPath: string,
  grants: readonly AttemptFileGrantV1[],
  options: { existingCreatesAreAllowed?: boolean } = {},
): readonly AttemptFileGrantV1[] {
  const seen = new Map<string, AttemptFileOperationV1>()
  const normalized = grants.map((grant) => {
    if (grant.operation === 'DELETE') throw new AttemptWorkspaceError('DELETE_FORBIDDEN')
    const relativePath = normalizeRelativePath(grant.relativePath)
    const previous = seen.get(relativePath)
    if (previous && previous !== grant.operation) throw new AttemptWorkspaceError('PATH_CONFLICT')
    if (previous) throw new AttemptWorkspaceError('PATH_CONFLICT')
    seen.set(relativePath, grant.operation)
    const target = resolveManifestPath(rootPath, relativePath)
    if (grant.operation === 'MODIFY') {
      const identity = readFileIdentity(target.realPath)
      if (identity.contentDigest !== grant.baselineDigest) throw new AttemptWorkspaceError('TARGET_DIGEST_MISMATCH')
      return { operation: grant.operation, relativePath, baselineDigest: grant.baselineDigest }
    }
    assertCreateTarget(target.realPath, options)
    return { operation: grant.operation, relativePath }
  })
  return [...normalized].sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.operation.localeCompare(b.operation))
}

function assertNoManifestConflict(existing: readonly AttemptFileGrantV1[], next: readonly AttemptFileGrantV1[]): void {
  const seen = new Set(existing.map((grant) => grant.relativePath))
  for (const grant of next) {
    if (seen.has(grant.relativePath)) throw new AttemptWorkspaceError('PATH_CONFLICT')
  }
}

function assertCreateTarget(realPath: string, options: { existingCreatesAreAllowed?: boolean } = {}): void {
  try {
    lstatSync(realPath)
    if (options.existingCreatesAreAllowed) {
      readFileIdentity(realPath)
      if (readFileSync(realPath).length !== 0) throw new AttemptWorkspaceError('TARGET_NOT_EMPTY')
      return
    }
    throw new AttemptWorkspaceError('TARGET_ALREADY_EXISTS')
  } catch (error) {
    if (error instanceof AttemptWorkspaceError) throw error
    if (!isNodeErrorCode(error, 'ENOENT')) throw new AttemptWorkspaceError('PATH_ALIAS')
  }
  const parent = dirname(realPath)
  const parentInfo = lstatSync(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new AttemptWorkspaceError('PATH_ALIAS')
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function resolveManifestPath(rootPath: string, relativePath: string): { realPath: string } {
  const lexical = resolve(rootPath, normalizeRelativePath(relativePath).replace(/\//g, sep))
  if (!isInside(rootPath, lexical)) throw new AttemptWorkspaceError('PATH_OUTSIDE_ROOT')
  const parent = safeRealpath(dirname(lexical), 'TARGET_MISSING')
  if (!isInside(rootPath, parent) || pathKey(parent) !== pathKey(dirname(lexical))) throw new AttemptWorkspaceError('PATH_ALIAS')
  return { realPath: join(parent, lexical.split(sep).pop() ?? '') }
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
    throw new AttemptWorkspaceError('PATH_FORBIDDEN')
  }
  const normalized = value.replace(/[\\]+/g, '/')
  const parsed = posix.normalize(normalized)
  const parts = parsed.split('/')
  if (parsed === '.' || parsed.startsWith('../') || parts.includes('..') || parts.includes('.') || parts.includes('') || parts.includes('.git')) {
    throw new AttemptWorkspaceError('PATH_FORBIDDEN')
  }
  return parsed
}

function readFileIdentity(realPath: string): { contentDigest: string; identityDigest: string } {
  let info
  try {
    info = lstatSync(realPath, { bigint: true })
  } catch {
    throw new AttemptWorkspaceError('TARGET_MISSING')
  }
  if (info.isSymbolicLink()) throw new AttemptWorkspaceError('PATH_ALIAS')
  if (!info.isFile()) throw new AttemptWorkspaceError('TARGET_NOT_FILE')
  if (info.nlink !== 1n) throw new AttemptWorkspaceError('TARGET_HARDLINK')
  const bytes = readFileSync(realPath)
  const contentDigest = digestBytes(bytes)
  return {
    contentDigest,
    identityDigest: digestJson({ dev: info.dev.toString(), ino: info.ino.toString(), size: info.size.toString(), contentDigest }),
  }
}

function rollbackCreatedTarget(target: CreateBatchTargetV1): void {
  try {
    const identity = readFileIdentity(target.realPath)
    if (target.identityDigest && identity.identityDigest !== target.identityDigest) return
    if (readFileSync(target.realPath).length !== 0) return
    unlinkSync(target.realPath)
  } catch {
    // Recovery is best-effort and ownership-checked. Unknown files are left in place.
  }
}

async function assertBaseTree(repoRoot: string, baseRevision: string, expectedTreeHash: string): Promise<void> {
  const type = (await git(repoRoot, ['cat-file', '-t', baseRevision])).stdout.trim()
  if (type !== 'commit') throw new AttemptWorkspaceError('BASE_REVISION_NOT_COMMIT')
  const tree = (await git(repoRoot, ['rev-parse', `${baseRevision}^{tree}`])).stdout.trim()
  if (tree !== expectedTreeHash) throw new AttemptWorkspaceError('BASELINE_TREE_MISMATCH')
}

async function assertCleanRepository(repoRoot: string): Promise<void> {
  const status = await git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.stdout.trim().length > 0) throw new AttemptWorkspaceError('REPO_NOT_CLEAN_FOR_BASELINE')
}

function assertGitRepository(repoRoot: string): void {
  if (!existsSync(join(repoRoot, '.git'))) throw new AttemptWorkspaceError('REPO_NOT_GIT')
}

function assertCommitOid(value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new AttemptWorkspaceError('BASE_REVISION_NOT_COMMIT')
}

function ensureManagedRoot(managedRoot: string): string {
  const lexical = resolve(managedRoot)
  mkdirSync(lexical, { recursive: true })
  const real = safeRealpath(lexical, 'MANAGED_ROOT_INVALID')
  if (pathKey(lexical) !== pathKey(real)) throw new AttemptWorkspaceError('MANAGED_ROOT_INVALID')
  return real
}

async function git(cwd: string, args: readonly string[]): Promise<{ stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new AttemptWorkspaceError(stderr.includes('not a git repository') ? 'REPO_NOT_GIT' : 'GIT_COMMAND_FAILED'))
        return
      }
      resolvePromise({ stdout: stdout ?? '' })
    })
  })
}

function parsePorcelainStatus(stdout: string): readonly PorcelainChangeV1[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2)
      const rawPath = line.slice(3).trim()
      const relativePath = status.includes('R') || status.includes('C') ? rawPath.split(' -> ').at(-1) ?? rawPath : rawPath
      return { status, relativePath: normalizeRelativePath(relativePath) }
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.status.localeCompare(b.status))
}

function isManifestSubsetChange(change: PorcelainChangeV1, manifest: AttemptFileManifestV1): boolean {
  if (change.status.includes('R') || change.status.includes('C') || change.status.includes('D')) return false
  const grant = manifest.grants.find((candidate) => candidate.relativePath === change.relativePath)
  if (!grant) return false
  if (grant.operation === 'MODIFY') return change.status.includes('M')
  if (grant.operation === 'CREATE') return change.status === '??' || change.status.includes('A')
  return false
}

function safeRealpath(path: string, reasonCode: AttemptWorkspaceReasonCodeV1): string {
  try {
    return realpathSync.native(path)
  } catch {
    throw new AttemptWorkspaceError(reasonCode)
  }
}

function isInside(rootPath: string, candidate: string): boolean {
  const child = relative(rootPath, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function cleanId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new AttemptWorkspaceError('ATTEMPT_ID_INVALID')
  return value
}

function safeAttemptDirectoryName(attemptId: string): string {
  return `attempt-${hashHex(attemptId).slice(0, 24)}`
}

function pendingCreateBatch(attemptId: string, manifestVersion: number, ownerId: string, targets: readonly CreateBatchTargetV1[]): CreateBatchRecordV1 {
  return {
    batchId: `xhbc_${hashHex(`${attemptId}:${manifestVersion}:${ownerId}`).slice(0, 32)}`,
    attemptId,
    ownerId,
    manifestVersion,
    state: 'PENDING',
    targets,
  }
}

function prepareConflictDigest(request: AttemptWorkspacePrepareRequestV1): string {
  return digestJson({
    attemptId: request.attemptId,
    compositionAttemptId: request.compositionAttemptId,
    requestDigest: request.requestDigest,
    baselineBindingDigest: request.baselineBindingDigest,
    compositionDigest: request.compositionDigest,
    targetProjectRoot: request.targetProjectRoot,
    managedRoot: request.managedRoot,
    baseRevision: request.baseRevision,
    baselineTreeHash: request.baselineTreeHash,
    manifest: request.manifest,
    ownerId: request.ownerId,
  })
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function digestBytes(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(typeof bytes === 'string' ? Buffer.from(bytes) : bytes).digest('hex')}`
}

export function digestString(value: string): string {
  return digestBytes(Buffer.from(value, 'utf8'))
}

export function digestJson(value: unknown): string {
  return digestString(JSON.stringify(value))
}

function hashHex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
