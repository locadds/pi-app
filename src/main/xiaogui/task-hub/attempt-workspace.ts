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

export interface UserApprovedFileSelectionV1 {
  readonly operation: 'MODIFY' | 'CREATE'
  readonly relativePath: string
}

export interface AttemptFileScopeResolverV1 {
  resolveApprovedFiles(
    projectId: string,
    selections: readonly UserApprovedFileSelectionV1[],
  ): Promise<readonly AttemptFileGrantV1[]>
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
  readonly projectId: string
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

export interface TaskPatchFileSnapshotV1 {
  readonly operation: 'MODIFY' | 'CREATE'
  readonly relativePath: string
  readonly baselineDigest: string | null
  readonly contentDigest: string
  readonly contentBase64: string
}

export interface TaskPatchArtifactV1 {
  readonly kind: 'TASK_PATCH_V1'
  readonly version: 1
  readonly files: readonly TaskPatchFileSnapshotV1[]
}

/**
 * Main-process-only capture. `privateVerificationContext.worktreeRoot` must
 * never be copied into a shared projection or renderer DTO.
 */
export interface AttemptTaskPatchCaptureV1 {
  readonly inputTreeHash: string
  readonly resultTreeHash: string
  readonly patchArtifactId: string
  readonly patchArtifactDigest: string
  readonly patchArtifactBytes: Uint8Array
  readonly changedFiles: readonly TaskPatchFileSnapshotV1[]
  readonly privateVerificationContext: {
    readonly attemptWorktreeId: string
    readonly worktreeRoot: string
    readonly baseRevision: string
    readonly baselineGitTreeOid: string
    readonly manifestDigest: string
    readonly manifestVersion: number
  }
}

export interface AttemptTaskPatchCapturePortV1 {
  captureTaskPatch(attemptId: string): Promise<AttemptTaskPatchCaptureV1>
}

export interface AttemptRuntimeAllowedFileV1 {
  readonly relativePath: string
  readonly contentDigest: string
}

export interface AttemptRuntimeWorkspaceAccessV1 {
  readonly workspace: RuntimeWorkspaceBindingV1
  readonly rootPath: string
  readonly allowedFiles: readonly AttemptRuntimeAllowedFileV1[]
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
  | 'NO_APPROVED_CHANGES'
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
  readonly requestDigest: string
  readonly manifestVersion: number
  readonly state: CreateBatchStateV1
  readonly targets: readonly CreateBatchTargetV1[]
}

export interface PreparedRecord {
  readonly request: AttemptWorkspacePrepareRequestV1
  readonly result: AttemptWorkspacePreparedV1
}

export interface AttemptWorkspaceLeaseV1 {
  readonly attemptId: string
  readonly requestConflictDigest: string
  readonly projectId: string
  readonly projectRoot: string
  readonly managedRoot: string
  readonly worktreeRoot: string
  readonly baseRevision: string
  readonly baselineTreeHash: string
  readonly ownerId: string
  readonly attemptWorktreeId: string
}

export interface AttemptWorkspaceRegistryV1 {
  getPrepared(attemptId: string): PreparedRecord | undefined
  putPrepared(record: PreparedRecord): void
  getLease(attemptId: string): AttemptWorkspaceLeaseV1 | undefined
  putLease(lease: AttemptWorkspaceLeaseV1): void
  getManifest(attemptId: string): AttemptFileManifestV1 | undefined
  commitManifestAndCreateBatch(manifest: AttemptFileManifestV1, batch?: CreateBatchRecordV1): void
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
  private readonly leases = new Map<string, AttemptWorkspaceLeaseV1>()
  private readonly manifests = new Map<string, AttemptFileManifestV1>()
  private readonly scopeRequests = new Map<string, AttemptScopeExpansionRequestV1>()
  private readonly createBatches = new Map<string, CreateBatchRecordV1>()

  getPrepared(attemptId: string): PreparedRecord | undefined {
    return this.prepared.get(attemptId)
  }

  putPrepared(record: PreparedRecord): void {
    this.prepared.set(record.request.attemptId, record)
  }

  getLease(attemptId: string): AttemptWorkspaceLeaseV1 | undefined {
    return this.leases.get(attemptId)
  }

  putLease(lease: AttemptWorkspaceLeaseV1): void {
    const existing = this.leases.get(lease.attemptId)
    if (existing && existing.requestConflictDigest !== lease.requestConflictDigest) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    this.leases.set(lease.attemptId, lease)
  }

  getManifest(attemptId: string): AttemptFileManifestV1 | undefined {
    return this.manifests.get(attemptId)
  }

  commitManifestAndCreateBatch(manifest: AttemptFileManifestV1, batch?: CreateBatchRecordV1): void {
    const current = this.manifests.get(manifest.attemptId)
    const currentBatch = batch ? this.createBatches.get(batch.batchId) : undefined
    if (currentBatch && batch && !sameCreateBatchIdentity(currentBatch, batch)) {
      throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    }
    if (current?.version === manifest.version && current.manifestDigest === manifest.manifestDigest) {
      if (batch) this.createBatches.set(batch.batchId, batch)
      return
    }
    if ((current?.version ?? 0) !== manifest.version - 1) throw new AttemptWorkspaceError('MANIFEST_VERSION_CONFLICT')
    this.manifests.set(manifest.attemptId, manifest)
    if (batch) this.createBatches.set(batch.batchId, batch)
  }

  putScopeRequest(request: AttemptScopeExpansionRequestV1): void {
    const existing = this.scopeRequests.get(request.requestId)
    if (existing && existing.requestDigest !== request.requestDigest) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    this.scopeRequests.set(request.requestId, request)
  }

  getScopeRequest(requestId: string): AttemptScopeExpansionRequestV1 | undefined {
    return this.scopeRequests.get(requestId)
  }

  updateScopeRequest(requestId: string, state: ScopeExpansionStateV1): void {
    const current = this.scopeRequests.get(requestId)
    if (!current) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    if (current.state === state) return
    if (current.state !== 'REQUESTED') throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    this.scopeRequests.set(requestId, { ...current, state })
  }

  putCreateBatch(batch: CreateBatchRecordV1): void {
    this.updateCreateBatch(batch)
  }

  getCreateBatch(batchId: string): CreateBatchRecordV1 | undefined {
    return this.createBatches.get(batchId)
  }

  updateCreateBatch(batch: CreateBatchRecordV1): void {
    const current = this.createBatches.get(batch.batchId)
    if (current && !sameCreateBatchIdentity(current, batch)) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
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

  getLease(attemptId: string): AttemptWorkspaceLeaseV1 | undefined {
    const row = this.db.prepare('select lease_json from attempt_workspace_leases where attempt_id = ?').get(attemptId) as
      | { lease_json: string }
      | undefined
    return row ? JSON.parse(row.lease_json) : undefined
  }

  putLease(lease: AttemptWorkspaceLeaseV1): void {
    this.db
      .prepare('insert or ignore into attempt_workspace_leases (attempt_id, request_conflict_digest, lease_json) values (?, ?, ?)')
      .run(lease.attemptId, lease.requestConflictDigest, JSON.stringify(lease))
    const existing = this.getLease(lease.attemptId)
    if (!existing || existing.requestConflictDigest !== lease.requestConflictDigest) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
  }

  getManifest(attemptId: string): AttemptFileManifestV1 | undefined {
    const row = this.db.prepare('select manifest_json from attempt_file_manifests where attempt_id = ?').get(attemptId) as
      | { manifest_json: string }
      | undefined
    return row ? JSON.parse(row.manifest_json) : undefined
  }

  commitManifestAndCreateBatch(manifest: AttemptFileManifestV1, batch?: CreateBatchRecordV1): void {
    this.db.exec('begin immediate')
    try {
      const current = this.db
        .prepare('select version, manifest_digest from attempt_file_manifests where attempt_id = ?')
        .get(manifest.attemptId) as { version: number; manifest_digest: string } | undefined
      const isExactReplay = current?.version === manifest.version && current.manifest_digest === manifest.manifestDigest
      if (!isExactReplay) {
        if ((current?.version ?? 0) !== manifest.version - 1) throw new AttemptWorkspaceError('MANIFEST_VERSION_CONFLICT')
        const result = current
          ? this.db
              .prepare(
                'update attempt_file_manifests set version = ?, manifest_digest = ?, manifest_json = ? where attempt_id = ? and version = ?',
              )
              .run(manifest.version, manifest.manifestDigest, JSON.stringify(manifest), manifest.attemptId, current.version)
          : this.db
              .prepare('insert into attempt_file_manifests (attempt_id, version, manifest_digest, manifest_json) values (?, ?, ?, ?)')
              .run(manifest.attemptId, manifest.version, manifest.manifestDigest, JSON.stringify(manifest))
        if (result.changes !== 1) throw new AttemptWorkspaceError('MANIFEST_VERSION_CONFLICT')
      }
      if (batch) {
        const existingBatch = this.getCreateBatch(batch.batchId)
        if (existingBatch && !sameCreateBatchIdentity(existingBatch, batch)) {
          throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
        }
        this.db
          .prepare('insert or replace into create_batches (batch_id, attempt_id, owner_id, state, batch_json) values (?, ?, ?, ?, ?)')
          .run(batch.batchId, batch.attemptId, batch.ownerId, batch.state, JSON.stringify(batch))
      }
      this.db.exec('commit')
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }

  putScopeRequest(request: AttemptScopeExpansionRequestV1): void {
    this.db
      .prepare('insert or ignore into scope_expansion_requests (request_id, attempt_id, state, request_json) values (?, ?, ?, ?)')
      .run(request.requestId, request.attemptId, request.state, JSON.stringify(request))
    const existing = this.getScopeRequest(request.requestId)
    if (!existing || existing.requestDigest !== request.requestDigest) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
  }

  getScopeRequest(requestId: string): AttemptScopeExpansionRequestV1 | undefined {
    const row = this.db.prepare('select request_json from scope_expansion_requests where request_id = ?').get(requestId) as
      | { request_json: string }
      | undefined
    return row ? JSON.parse(row.request_json) : undefined
  }

  updateScopeRequest(requestId: string, state: ScopeExpansionStateV1): void {
    const current = this.getScopeRequest(requestId)
    if (!current) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    if (current.state === state) return
    if (current.state !== 'REQUESTED') throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    const next = { ...current, state }
    const result = this.db
      .prepare('update scope_expansion_requests set state = ?, request_json = ? where request_id = ? and state = ?')
      .run(state, JSON.stringify(next), requestId, 'REQUESTED')
    if (result.changes === 1) return
    const replayed = this.getScopeRequest(requestId)
    if (!replayed || replayed.requestDigest !== current.requestDigest || replayed.state !== state) {
      throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    }
  }

  putCreateBatch(batch: CreateBatchRecordV1): void {
    this.updateCreateBatch(batch)
  }

  getCreateBatch(batchId: string): CreateBatchRecordV1 | undefined {
    const row = this.db.prepare('select batch_json from create_batches where batch_id = ?').get(batchId) as { batch_json: string } | undefined
    return row ? JSON.parse(row.batch_json) : undefined
  }

  updateCreateBatch(batch: CreateBatchRecordV1): void {
    const current = this.getCreateBatch(batch.batchId)
    if (current && !sameCreateBatchIdentity(current, batch)) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
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
      create table if not exists attempt_workspace_leases (
        attempt_id text primary key,
        request_conflict_digest text not null,
        lease_json text not null
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
  runtimeAccess(attemptId: string): Promise<AttemptRuntimeWorkspaceAccessV1 | undefined>
  runtimeBinding(attemptId: string): Promise<RuntimeWorkspaceBindingV1 | undefined>
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
    attemptId: string
    baseManifestVersion: number
    requestDigest: string
    ownerId: string
  }): Promise<AttemptFileManifestV1>
  auditChanges(attemptId: string): Promise<AttemptWorkspaceInspectionV1>
  captureTaskPatch(attemptId: string): Promise<AttemptTaskPatchCaptureV1>
}

export interface ProjectWorkspaceResolverV1 {
  resolveProjectRoot(projectId: string): string | Promise<string>
}

export class GitAttemptWorkspaceServiceV1 implements AttemptWorkspacePortV1, AttemptFileScopeResolverV1 {
  private readonly managedRoot: string

  constructor(
    private readonly registry: AttemptWorkspaceRegistryV1,
    private readonly resolver: ProjectWorkspaceResolverV1,
    options: { managedRoot: string },
  ) {
    this.managedRoot = ensureManagedRoot(options.managedRoot)
  }

  async resolveApprovedFiles(
    projectId: string,
    selections: readonly UserApprovedFileSelectionV1[],
  ): Promise<readonly AttemptFileGrantV1[]> {
    const authoritativeRoot = safeRealpath(resolve(await this.resolver.resolveProjectRoot(cleanId(projectId))), 'REPO_NOT_GIT')
    assertGitRepository(authoritativeRoot)
    return resolveApprovedFileSelections(authoritativeRoot, selections)
  }

  async prepare(request: AttemptWorkspacePrepareRequestV1): Promise<AttemptWorkspacePreparedV1> {
    const attemptId = cleanId(request.attemptId)
    const projectId = cleanId(request.projectId)
    if (request.manifest.attemptId !== attemptId) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    if (request.manifest.version !== 1) throw new AttemptWorkspaceError('MANIFEST_VERSION_CONFLICT')
    const existing = this.registry.getPrepared(attemptId)
    if (existing) {
      if (prepareConflictDigest(existing.request) !== prepareConflictDigest(request)) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    }

    assertCommitOid(request.baseRevision)
    const repoRoot = safeRealpath(resolve(await this.resolver.resolveProjectRoot(projectId)), 'REPO_NOT_GIT')
    assertGitRepository(repoRoot)
    const existingLease = this.registry.getLease(attemptId)
    if (!existingLease) await assertCleanRepository(repoRoot)
    await assertBaseTree(repoRoot, request.baseRevision, request.baselineTreeHash)

    const managedRoot = this.managedRoot
    const worktreeRoot = resolve(managedRoot, safeAttemptDirectoryName(attemptId))
    const attemptWorktreeId = `xhbwt_${hashHex(attemptId).slice(0, 32)}`
    if (!isInside(managedRoot, worktreeRoot)) throw new AttemptWorkspaceError('PATH_OUTSIDE_ROOT')
    const lease = this.ensureLease({
      attemptId,
      request: { ...request, attemptId, projectId },
      projectId,
      repoRoot,
      managedRoot,
      worktreeRoot,
      attemptWorktreeId,
    })
    if (existing) {
      const realWorktreeRoot = safeRealpath(worktreeRoot, 'WORKTREE_DRIFT')
      await assertExistingWorktreeIdentity(realWorktreeRoot, lease)
      const manifest = this.registry.getManifest(attemptId)
      if (!manifest) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
      return this.refreshPreparedForManifest(attemptId, manifest).result
    }
    const replayedManifest = this.registry.getManifest(attemptId)
    if (existsSync(worktreeRoot)) {
      const realWorktreeRoot = safeRealpath(worktreeRoot, 'WORKTREE_DRIFT')
      await assertExistingWorktreeIdentity(realWorktreeRoot, lease)
      if (replayedManifest) {
        const expectedManifestDigest = digestJson({
          attemptId,
          version: request.manifest.version,
          grants: normalizeManifestGrants(realWorktreeRoot, request.manifest.grants, { existingCreatesAreAllowed: true }),
        })
        if (replayedManifest.manifestDigest === expectedManifestDigest) {
          const result = buildPreparedResult(request, attemptId, repoRoot, realWorktreeRoot, replayedManifest, attemptWorktreeId)
          this.registry.putPrepared({ request: { ...request, attemptId, projectId }, result })
          return result
        }
      }
      const manifest = await materializeManifest({
        rootPath: realWorktreeRoot,
        manifest: request.manifest,
        attemptId,
        ownerId: request.ownerId,
        requestDigest: request.requestDigest,
        registry: this.registry,
        faultInjection: request.faultInjection,
      })
      const result = buildPreparedResult(request, attemptId, repoRoot, realWorktreeRoot, manifest, attemptWorktreeId)
      this.registry.putPrepared({ request: { ...request, attemptId, projectId }, result })
      return result
    }

    if (request.faultInjection === 'BEFORE_CREATE') {
      throw new AttemptWorkspaceError('CREATE_BATCH_PENDING')
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
      requestDigest: request.requestDigest,
      registry: this.registry,
      faultInjection: request.faultInjection,
    })

    const result = buildPreparedResult(request, attemptId, repoRoot, realWorktreeRoot, manifest, attemptWorktreeId)
    this.registry.putPrepared({ request: { ...request, attemptId, projectId }, result })
    return result
  }

  async runtimeAccess(attemptId: string): Promise<AttemptRuntimeWorkspaceAccessV1 | undefined> {
    const manifest = this.registry.getManifest(attemptId)
    if (!manifest) return undefined
    const prepared = await this.validateCurrentWorkspace(attemptId, manifest)
    const rootPath = prepared.result.handle.rootPath
    const allowedFiles = manifest.grants.map((grant) => {
      const target = resolveManifestPath(rootPath, grant.relativePath)
      return {
        relativePath: grant.relativePath,
        contentDigest: readFileIdentity(target.realPath).contentDigest,
      }
    })
    return {
      workspace: { ...prepared.result.workspace },
      rootPath,
      allowedFiles,
    }
  }

  async runtimeBinding(attemptId: string): Promise<RuntimeWorkspaceBindingV1 | undefined> {
    return (await this.runtimeAccess(attemptId))?.workspace
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
    const manifest = this.registry.getManifest(attemptId)
    if (!manifest) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    const prepared = await this.validateCurrentWorkspace(attemptId, manifest)
    return this.inspect(prepared.result.handle)
  }

  async captureTaskPatch(attemptId: string): Promise<AttemptTaskPatchCaptureV1> {
    const audit = await this.auditChanges(attemptId)
    if (!audit.ok) throw new AttemptWorkspaceError(audit.rejectedReasonCode ?? 'PATH_FORBIDDEN')
    if (audit.actualRelativePaths.length === 0) throw new AttemptWorkspaceError('NO_APPROVED_CHANGES')

    const manifest = this.registry.getManifest(attemptId)
    const lease = this.registry.getLease(attemptId)
    if (!manifest || !lease) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    const prepared = await this.validateCurrentWorkspace(attemptId, manifest)
    const rootPath = prepared.result.handle.rootPath
    const beforeStatus = parsePorcelainStatus(
      (await git(rootPath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout,
    )
    if (
      beforeStatus.length === 0 ||
      beforeStatus.some((change) => !isManifestSubsetChange(change, manifest)) ||
      !sameStringList(
        beforeStatus.map((change) => change.relativePath),
        audit.actualRelativePaths,
      )
    ) {
      throw new AttemptWorkspaceError('PATH_FORBIDDEN')
    }

    const changedFiles: TaskPatchFileSnapshotV1[] = []
    for (const change of beforeStatus) {
      const grant = manifest.grants.find((candidate) => candidate.relativePath === change.relativePath)
      if (!grant || grant.operation === 'DELETE') throw new AttemptWorkspaceError('PATH_FORBIDDEN')
      if (grant.operation === 'MODIFY') {
        const baselineBytes = await gitBytes(lease.projectRoot, [
          'cat-file',
          '--filters',
          `--path=${grant.relativePath}`,
          `${lease.baseRevision}:${grant.relativePath}`,
        ])
        if (!grant.baselineDigest || digestBytes(baselineBytes) !== grant.baselineDigest) {
          throw new AttemptWorkspaceError('TARGET_DIGEST_MISMATCH')
        }
      }
      const target = resolveManifestPath(rootPath, grant.relativePath)
      const current = readStableTaskFile(target.realPath)
      if (grant.operation === 'MODIFY' && current.contentDigest === grant.baselineDigest) {
        // A mode-only or index-only Git change cannot be represented by the
        // content-only TASK_PATCH_V1 format, so it must not become a candidate.
        throw new AttemptWorkspaceError('PATH_FORBIDDEN')
      }
      changedFiles.push({
        operation: grant.operation,
        relativePath: grant.relativePath,
        baselineDigest: grant.operation === 'MODIFY' ? grant.baselineDigest ?? null : null,
        contentDigest: current.contentDigest,
        contentBase64: current.bytes.toString('base64'),
      })
    }

    const canonicalFiles = sortTaskPatchFiles(changedFiles)
    const inputTreeHash = digestJson({
      kind: 'GIT_TREE_INPUT_V1',
      gitTreeOid: lease.baselineTreeHash,
    })
    const resultTreeHash = digestJson({
      kind: 'TASK_RESULT_TREE_V1',
      inputTreeHash,
      files: canonicalFiles,
    })
    const patchArtifact: TaskPatchArtifactV1 = {
      kind: 'TASK_PATCH_V1',
      version: 1,
      files: canonicalFiles,
    }
    const patchArtifactBytes = Buffer.from(JSON.stringify(patchArtifact), 'utf8')
    const patchArtifactDigest = digestBytes(patchArtifactBytes)
    const patchArtifactId = `xhart_${patchArtifactDigest.slice('sha256:'.length, 'sha256:'.length + 32)}`

    const afterStatus = parsePorcelainStatus(
      (await git(rootPath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout,
    )
    if (!samePorcelainChanges(beforeStatus, afterStatus)) throw new AttemptWorkspaceError('WORKTREE_DRIFT')
    for (const snapshot of canonicalFiles) {
      const current = readStableTaskFile(resolveManifestPath(rootPath, snapshot.relativePath).realPath)
      if (current.contentDigest !== snapshot.contentDigest) throw new AttemptWorkspaceError('WORKTREE_DRIFT')
    }
    await this.validateCurrentWorkspace(attemptId, manifest)

    return {
      inputTreeHash,
      resultTreeHash,
      patchArtifactId,
      patchArtifactDigest,
      patchArtifactBytes,
      changedFiles: canonicalFiles,
      privateVerificationContext: {
        attemptWorktreeId: lease.attemptWorktreeId,
        worktreeRoot: rootPath,
        baseRevision: lease.baseRevision,
        baselineGitTreeOid: lease.baselineTreeHash,
        manifestDigest: manifest.manifestDigest,
        manifestVersion: manifest.version,
      },
    }
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
    attemptId: string
    baseManifestVersion: number
    requestDigest: string
    ownerId: string
  }): Promise<AttemptFileManifestV1> {
    const request = this.registry.getScopeRequest(input.requestId)
    if (
      !request ||
      request.attemptId !== input.attemptId ||
      request.baseManifestVersion !== input.baseManifestVersion ||
      request.requestDigest !== input.requestDigest
    ) {
      throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    }
    const current = this.registry.getManifest(request.attemptId)
    if (!current) throw new AttemptWorkspaceError('MANIFEST_VERSION_CONFLICT')
    const prepared = await this.validateCurrentWorkspace(request.attemptId, current)
    const realWorktreeRoot = prepared.result.handle.rootPath
    if (request.state === 'APPROVED') {
      if (manifestIncludesGrants(current, request.requestedGrants)) {
        this.refreshPreparedForManifest(request.attemptId, current)
        return current
      }
      throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    }
    if (request.state !== 'REQUESTED') throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    if (current.version === request.baseManifestVersion + 1 && manifestIncludesGrants(current, request.requestedGrants)) {
      this.refreshPreparedForManifest(request.attemptId, current)
      this.registry.updateScopeRequest(input.requestId, 'APPROVED')
      return current
    }
    try {
      if (current.version !== request.baseManifestVersion) throw new AttemptWorkspaceError('MANIFEST_VERSION_CONFLICT')
      const newGrants = normalizeManifestGrants(realWorktreeRoot, request.requestedGrants)
      assertNoManifestConflict(current.grants, newGrants)
      const next = await materializeManifest({
        rootPath: realWorktreeRoot,
        manifest: {
          attemptId: request.attemptId,
          version: current.version + 1,
          grants: sortManifestGrants([...current.grants, ...newGrants]),
        },
        grantsToMaterialize: newGrants,
        attemptId: request.attemptId,
        ownerId: input.ownerId,
        requestDigest: request.requestDigest,
        registry: this.registry,
      })
      this.refreshPreparedForManifest(request.attemptId, next)
      this.registry.updateScopeRequest(input.requestId, 'APPROVED')
      return next
    } catch (error) {
      const latest = this.registry.getScopeRequest(input.requestId)
      if (latest?.requestDigest === request.requestDigest && latest.state === 'REQUESTED') {
        this.registry.updateScopeRequest(input.requestId, 'REJECTED')
      }
      throw error
    }
  }

  recoverPendingCreateBatches(): void {
    for (const batch of this.registry.pendingCreateBatches()) {
      const manifest = this.registry.getManifest(batch.attemptId)
      if (manifest && manifest.version >= batch.manifestVersion && batch.targets.every((target) => manifestHasCreateTarget(manifest, target))) {
        this.registry.updateCreateBatch({ ...batch, state: 'COMMITTED' })
        continue
      }
      for (const target of batch.targets) {
        rollbackCreatedTarget(target)
      }
      this.registry.updateCreateBatch({ ...batch, state: 'ROLLED_BACK' })
    }
  }

  private refreshPreparedForManifest(attemptId: string, manifest: AttemptFileManifestV1): PreparedRecord {
    const prepared = this.registry.getPrepared(attemptId)
    const lease = this.registry.getLease(attemptId)
    if (!prepared || !lease || manifest.attemptId !== attemptId) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    if (
      prepared.result.handle.manifestVersion === manifest.version &&
      prepared.result.handle.manifestDigest === manifest.manifestDigest
    ) {
      return prepared
    }
    const result = buildPreparedResult(
      prepared.request,
      attemptId,
      lease.projectRoot,
      lease.worktreeRoot,
      manifest,
      lease.attemptWorktreeId,
    )
    const refreshed = { request: prepared.request, result }
    this.registry.putPrepared(refreshed)
    return refreshed
  }

  private async validateCurrentWorkspace(attemptId: string, manifest: AttemptFileManifestV1): Promise<PreparedRecord> {
    const lease = this.registry.getLease(attemptId)
    if (!lease || manifest.attemptId !== attemptId) throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
    const realWorktreeRoot = safeRealpath(lease.worktreeRoot, 'WORKTREE_DRIFT')
    await assertExistingWorktreeIdentity(realWorktreeRoot, lease)
    await assertBaseTree(lease.projectRoot, lease.baseRevision, lease.baselineTreeHash)
    const prepared = this.refreshPreparedForManifest(attemptId, manifest)
    if (pathKey(prepared.result.handle.rootPath) !== pathKey(realWorktreeRoot)) {
      throw new AttemptWorkspaceError('WORKTREE_DRIFT')
    }
    return prepared
  }

  private ensureLease(input: {
    attemptId: string
    request: AttemptWorkspacePrepareRequestV1
    projectId: string
    repoRoot: string
    managedRoot: string
    worktreeRoot: string
    attemptWorktreeId: string
  }): AttemptWorkspaceLeaseV1 {
    const requestConflictDigest = prepareConflictDigest(input.request)
    const existing = this.registry.getLease(input.attemptId)
    if (existing) {
      if (
        existing.requestConflictDigest !== requestConflictDigest ||
        pathKey(existing.projectRoot) !== pathKey(input.repoRoot) ||
        pathKey(existing.managedRoot) !== pathKey(input.managedRoot) ||
        pathKey(existing.worktreeRoot) !== pathKey(input.worktreeRoot) ||
        existing.attemptWorktreeId !== input.attemptWorktreeId
      ) {
        throw new AttemptWorkspaceError('MANIFEST_CONFLICT')
      }
      return existing
    }
    const lease: AttemptWorkspaceLeaseV1 = {
      attemptId: input.attemptId,
      requestConflictDigest,
      projectId: input.projectId,
      projectRoot: input.repoRoot,
      managedRoot: input.managedRoot,
      worktreeRoot: input.worktreeRoot,
      baseRevision: input.request.baseRevision,
      baselineTreeHash: input.request.baselineTreeHash,
      ownerId: input.request.ownerId,
      attemptWorktreeId: input.attemptWorktreeId,
    }
    this.registry.putLease(lease)
    return lease
  }
}

function buildPreparedResult(
  request: AttemptWorkspacePrepareRequestV1,
  attemptId: string,
  repoRoot: string,
  realWorktreeRoot: string,
  manifest: AttemptFileManifestV1,
  attemptWorktreeId: string,
): AttemptWorkspacePreparedV1 {
  const receiptBinding = {
      compositionAttemptId: request.compositionAttemptId,
      attemptId: attemptId as AttemptId,
      requestDigest: request.requestDigest,
      baselineBindingDigest: request.baselineBindingDigest,
      compositionDigest: request.compositionDigest,
    }
    const workspace: RuntimeWorkspaceBindingV1 = {
      attemptWorktreeId,
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
  requestDigest: string
  registry: AttemptWorkspaceRegistryV1
  faultInjection?: AttemptWorkspacePrepareRequestV1['faultInjection']
}): Promise<AttemptFileManifestV1> {
  if (input.faultInjection === 'BEFORE_CREATE') {
    const batch = pendingCreateBatch(input.attemptId, input.manifest.version, input.ownerId, input.requestDigest, [])
    input.registry.putCreateBatch(batch)
    throw new AttemptWorkspaceError('CREATE_BATCH_PENDING')
  }

  const batchProbe = pendingCreateBatch(input.attemptId, input.manifest.version, input.ownerId, input.requestDigest, [])
  const pendingBatch = input.registry.getCreateBatch(batchProbe.batchId)
  const grants = input.grantsToMaterialize
    ? canonicalStoredGrants(input.manifest.grants)
    : normalizeManifestGrants(input.rootPath, input.manifest.grants, { existingCreatesAreAllowed: pendingBatch?.state === 'PENDING' })
  const grantsToMaterialize =
    (input.grantsToMaterialize ? normalizeManifestGrants(input.rootPath, input.grantsToMaterialize) : undefined) ??
    normalizeManifestGrants(input.rootPath, input.manifest.grants, { existingCreatesAreAllowed: pendingBatch?.state === 'PENDING' })
  const createGrants = grantsToMaterialize.filter((grant) => grant.operation === 'CREATE')
  const createdTargets: CreateBatchTargetV1[] = pendingBatch?.state === 'PENDING' ? [...pendingBatch.targets] : []
  const batch = pendingCreateBatch(input.attemptId, input.manifest.version, input.ownerId, input.requestDigest, createdTargets)
  if (createGrants.length > 0) input.registry.putCreateBatch(batch)

  try {
    for (const grant of createGrants) {
      const target = resolveManifestPath(input.rootPath, grant.relativePath)
      const owned = createdTargets.find((candidate) => candidate.relativePath === grant.relativePath && pathKey(candidate.realPath) === pathKey(target.realPath))
      if (owned) {
        assertOwnedEmptyCreateTarget(owned)
        continue
      }
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
    input.registry.commitManifestAndCreateBatch(
      manifest,
      createGrants.length > 0 ? { ...batch, state: 'COMMITTED', targets: [...createdTargets] } : undefined,
    )
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

function assertOwnedEmptyCreateTarget(target: CreateBatchTargetV1): void {
  const identity = readFileIdentity(target.realPath)
  if (target.identityDigest && identity.identityDigest !== target.identityDigest) throw new AttemptWorkspaceError('PATH_CONFLICT')
  if (readFileSync(target.realPath).length !== 0) throw new AttemptWorkspaceError('TARGET_NOT_EMPTY')
}

function resolveApprovedFileSelections(
  rootPath: string,
  selections: readonly UserApprovedFileSelectionV1[],
): readonly AttemptFileGrantV1[] {
  if (!Array.isArray(selections)) throw new AttemptWorkspaceError('PATH_FORBIDDEN')
  const seen = new Set<string>()
  const grants: AttemptFileGrantV1[] = selections.map((selection) => {
    if (typeof selection !== 'object' || selection === null || Array.isArray(selection)) {
      throw new AttemptWorkspaceError('PATH_FORBIDDEN')
    }
    const operation = (selection as { operation?: unknown }).operation
    if (operation === 'DELETE') throw new AttemptWorkspaceError('DELETE_FORBIDDEN')
    if (operation !== 'MODIFY' && operation !== 'CREATE') throw new AttemptWorkspaceError('PATH_FORBIDDEN')
    const relativePath = normalizeRelativePath((selection as { relativePath?: unknown }).relativePath as string)
    const manifestKey = pathKey(relativePath)
    if (seen.has(manifestKey)) throw new AttemptWorkspaceError('PATH_CONFLICT')
    seen.add(manifestKey)
    const target = resolveManifestPath(rootPath, relativePath)
    if (operation === 'MODIFY') {
      return { operation, relativePath, baselineDigest: readFileIdentity(target.realPath).contentDigest }
    }
    assertCreateTarget(target.realPath)
    return { operation, relativePath }
  })
  return sortManifestGrants(grants)
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
    const manifestKey = pathKey(relativePath)
    const previous = seen.get(manifestKey)
    if (previous && previous !== grant.operation) throw new AttemptWorkspaceError('PATH_CONFLICT')
    if (previous) throw new AttemptWorkspaceError('PATH_CONFLICT')
    seen.set(manifestKey, grant.operation)
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

function canonicalStoredGrants(grants: readonly AttemptFileGrantV1[]): readonly AttemptFileGrantV1[] {
  const seen = new Map<string, AttemptFileOperationV1>()
  const normalized = grants.map((grant) => {
    if (grant.operation === 'DELETE') throw new AttemptWorkspaceError('DELETE_FORBIDDEN')
    const relativePath = normalizeRelativePath(grant.relativePath)
    const manifestKey = pathKey(relativePath)
    const previous = seen.get(manifestKey)
    if (previous) throw new AttemptWorkspaceError('PATH_CONFLICT')
    seen.set(manifestKey, grant.operation)
    return grant.operation === 'MODIFY'
      ? { operation: grant.operation, relativePath, baselineDigest: grant.baselineDigest }
      : { operation: grant.operation, relativePath }
  })
  return sortManifestGrants(normalized)
}

function sortManifestGrants(grants: readonly AttemptFileGrantV1[]): readonly AttemptFileGrantV1[] {
  return [...grants].sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.operation.localeCompare(b.operation))
}

function assertNoManifestConflict(existing: readonly AttemptFileGrantV1[], next: readonly AttemptFileGrantV1[]): void {
  const seen = new Set(existing.map((grant) => pathKey(grant.relativePath)))
  for (const grant of next) {
    if (seen.has(pathKey(grant.relativePath))) throw new AttemptWorkspaceError('PATH_CONFLICT')
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
  const rawParts = normalized.split('/')
  if (
    rawParts.includes('..') ||
    rawParts.includes('.') ||
    rawParts.includes('') ||
    rawParts.some((part) => part.toLowerCase() === '.git')
  ) {
    throw new AttemptWorkspaceError('PATH_FORBIDDEN')
  }
  const parsed = posix.normalize(normalized)
  const parts = parsed.split('/')
  if (
    parsed === '.' ||
    parsed.startsWith('../') ||
    parts.includes('..') ||
    parts.includes('.') ||
    parts.includes('') ||
    parts.some((part) => part.toLowerCase() === '.git')
  ) {
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

function readStableTaskFile(realPath: string): { bytes: Buffer; contentDigest: string } {
  const before = readFileIdentity(realPath)
  const bytes = readFileSync(realPath)
  const contentDigest = digestBytes(bytes)
  const after = readFileIdentity(realPath)
  if (
    before.identityDigest !== after.identityDigest ||
    before.contentDigest !== contentDigest ||
    after.contentDigest !== contentDigest
  ) {
    throw new AttemptWorkspaceError('WORKTREE_DRIFT')
  }
  return { bytes, contentDigest }
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

async function assertExistingWorktreeIdentity(realWorktreeRoot: string, lease: AttemptWorkspaceLeaseV1): Promise<void> {
  if (pathKey(realWorktreeRoot) !== pathKey(lease.worktreeRoot) || !isInside(lease.managedRoot, realWorktreeRoot)) {
    throw new AttemptWorkspaceError('WORKTREE_DRIFT')
  }
  const head = (await git(realWorktreeRoot, ['rev-parse', 'HEAD'])).stdout.trim()
  if (head !== lease.baseRevision) throw new AttemptWorkspaceError('WORKTREE_DRIFT')
  const topLevel = safeRealpath((await git(realWorktreeRoot, ['rev-parse', '--show-toplevel'])).stdout.trim(), 'WORKTREE_DRIFT')
  const worktreeCommonDir = safeRealpath(
    (await git(realWorktreeRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim(),
    'WORKTREE_DRIFT',
  )
  const projectCommonDir = safeRealpath(
    (await git(lease.projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim(),
    'WORKTREE_DRIFT',
  )
  if (pathKey(topLevel) !== pathKey(realWorktreeRoot) || pathKey(worktreeCommonDir) !== pathKey(projectCommonDir)) {
    throw new AttemptWorkspaceError('WORKTREE_DRIFT')
  }
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
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new AttemptWorkspaceError(stderr.includes('not a git repository') ? 'REPO_NOT_GIT' : 'GIT_COMMAND_FAILED'))
        return
      }
      resolvePromise({ stdout: stdout ?? '' })
    })
  })
}

async function gitBytes(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'buffer', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const diagnostic = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
          reject(new AttemptWorkspaceError(diagnostic.includes('not a git repository') ? 'REPO_NOT_GIT' : 'GIT_COMMAND_FAILED'))
          return
        }
        resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''))
      },
    )
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

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function samePorcelainChanges(left: readonly PorcelainChangeV1[], right: readonly PorcelainChangeV1[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (change, index) => change.status === right[index]?.status && change.relativePath === right[index]?.relativePath,
    )
  )
}

function sortTaskPatchFiles(files: readonly TaskPatchFileSnapshotV1[]): readonly TaskPatchFileSnapshotV1[] {
  return [...files].sort(
    (left, right) =>
      compareCanonicalString(left.relativePath, right.relativePath) ||
      compareCanonicalString(left.operation, right.operation),
  )
}

function compareCanonicalString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
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

function pendingCreateBatch(
  attemptId: string,
  manifestVersion: number,
  ownerId: string,
  requestDigest: string,
  targets: readonly CreateBatchTargetV1[],
): CreateBatchRecordV1 {
  return {
    batchId: `xhbc_${hashHex(`${attemptId}:${manifestVersion}:${ownerId}:${requestDigest}`).slice(0, 32)}`,
    attemptId,
    ownerId,
    requestDigest,
    manifestVersion,
    state: 'PENDING',
    targets,
  }
}

function sameCreateBatchIdentity(left: CreateBatchRecordV1, right: CreateBatchRecordV1): boolean {
  return (
    left.batchId === right.batchId &&
    left.attemptId === right.attemptId &&
    left.ownerId === right.ownerId &&
    left.requestDigest === right.requestDigest &&
    left.manifestVersion === right.manifestVersion
  )
}

function prepareConflictDigest(request: AttemptWorkspacePrepareRequestV1): string {
  return digestJson({
    attemptId: request.attemptId,
    compositionAttemptId: request.compositionAttemptId,
    requestDigest: request.requestDigest,
    baselineBindingDigest: request.baselineBindingDigest,
    compositionDigest: request.compositionDigest,
    projectId: request.projectId,
    baseRevision: request.baseRevision,
    baselineTreeHash: request.baselineTreeHash,
    manifest: request.manifest,
    ownerId: request.ownerId,
  })
}

function manifestIncludesGrants(manifest: AttemptFileManifestV1, grants: readonly AttemptFileGrantV1[]): boolean {
  return grants.every((grant) =>
    manifest.grants.some(
      (candidate) =>
        candidate.operation === grant.operation &&
        candidate.relativePath === normalizeRelativePath(grant.relativePath) &&
        candidate.baselineDigest === grant.baselineDigest,
    ),
  )
}

function manifestHasCreateTarget(manifest: AttemptFileManifestV1, target: CreateBatchTargetV1): boolean {
  return manifest.grants.some((grant) => grant.operation === 'CREATE' && grant.relativePath === normalizeRelativePath(target.relativePath))
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
