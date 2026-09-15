import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'

import type {
  DeliveryApplyAttemptIdV1,
  DeliveryApplyReceiptV1,
  DeliveryApplyReceiptV2,
  DeliveryApplySafeCodeV1,
  DeliveryApprovalSubjectV1,
  DeliveryChangeSetV1,
  DeliveryChangeSetV2,
  DeliveryFileChangeSummaryV1,
  DeliveryFileChangeSummaryV2,
  DeliveryGateSubjectV2,
  DeliveryTargetV1,
} from '@shared/xiaogui-delivery'
import {
  deliveryApplyReceiptDigestV1,
  deliveryApplyReceiptDigestV2,
  deliveryChangeSetDigestV1,
  deliveryChangeSetDigestV2,
  deliveryTargetFingerprintV1,
} from '@shared/xiaogui-delivery'
import type { Sha256Digest } from '@shared/xiaogui-task-verification'

import type { ProjectWorkspaceResolverV1 } from './attempt-workspace'

export interface DeliveryApplyRequestV1 {
  readonly applyAttemptId: DeliveryApplyAttemptIdV1
  readonly approval: DeliveryApprovalSubjectV1
  readonly changeSet: DeliveryChangeSetV1
  readonly fileContents: readonly DeliveryApplyFileContentV1[]
  /** Test seam only. Production callers must omit this. */
  readonly faultInjection?: DeliveryApplyFaultInjectionV1
}

export interface DeliveryApplyRequestV2 {
  readonly applyAttemptId: DeliveryApplyAttemptIdV1
  readonly approval: DeliveryGateSubjectV2
  readonly changeSet: DeliveryChangeSetV2
  readonly fileContents: readonly DeliveryApplyFileContentV2[]
  /** Test seam only. Production callers must omit this. */
  readonly faultInjection?: DeliveryApplyFaultInjectionV1
}

export interface DeliveryApplyFileContentV2 {
  readonly relativePath: string
  readonly contentArtifactId: string
  readonly content: Uint8Array
  readonly contentDigest: Sha256Digest
}

export interface DeliveryApplyFileContentV1 {
  readonly relativePath: string
  readonly contentArtifactId: string
  readonly content: Uint8Array
  readonly contentDigest: Sha256Digest
}

export interface DeliveryApplyFaultInjectionV1 {
  readonly failAfterWrites?: number
  readonly corruptRollbackForRelativePath?: string
}

export interface DeliveryApplyPortV1 {
  apply(request: DeliveryApplyRequestV1): Promise<DeliveryApplyReceiptV1>
  inspect(applyAttemptId: DeliveryApplyAttemptIdV1): Promise<DeliveryApplyReceiptV1>
}

export interface DeliveryApplyPortV2 {
  apply(request: DeliveryApplyRequestV2): Promise<DeliveryApplyReceiptV2>
  inspect(applyAttemptId: DeliveryApplyAttemptIdV1): Promise<DeliveryApplyReceiptV2>
}

export interface DeliveryGitSnapshotV1 {
  readonly headRevision: string
  readonly treeHash: string
  readonly porcelainStatus: readonly string[]
}

export interface DeliveryGitSnapshotReaderV1 {
  read(repositoryRoot: string): Promise<DeliveryGitSnapshotV1>
}

type PrivateApplyStatusV1 = 'STARTED' | 'SUCCEEDED' | 'FAILED_ROLLED_BACK' | 'OUTCOME_UNKNOWN'

interface PrivateRollbackFileV1 {
  readonly operation: 'MODIFY' | 'CREATE'
  readonly relativePath: string
  readonly realPath: string
  readonly beforeBytesBase64?: string
}

interface PrivateApplyAttemptV1 {
  readonly applyAttemptId: DeliveryApplyAttemptIdV1
  readonly requestDigest: Sha256Digest
  readonly projectRoot: string
  readonly changeSet: DeliveryChangeSetV1
  readonly plannedFiles: readonly PrivateRollbackFileV1[]
  readonly writtenRelativePaths: readonly string[]
  readonly status: PrivateApplyStatusV1
  readonly receipt?: DeliveryApplyReceiptV1
}

export interface DeliveryApplyAttemptRegistryV1 {
  get(applyAttemptId: DeliveryApplyAttemptIdV1): PrivateApplyAttemptV1 | undefined
  put(attempt: PrivateApplyAttemptV1): void
  update(attempt: PrivateApplyAttemptV1): void
  close?(): void
}

export class InMemoryDeliveryApplyAttemptRegistryV1 implements DeliveryApplyAttemptRegistryV1 {
  private readonly attempts = new Map<DeliveryApplyAttemptIdV1, PrivateApplyAttemptV1>()

  get(applyAttemptId: DeliveryApplyAttemptIdV1): PrivateApplyAttemptV1 | undefined {
    return this.attempts.get(applyAttemptId)
  }

  put(attempt: PrivateApplyAttemptV1): void {
    const existing = this.attempts.get(attempt.applyAttemptId)
    if (existing && existing.requestDigest !== attempt.requestDigest) {
      throw new ChangeApplyErrorV1('APPLY_ATTEMPT_CONFLICT')
    }
    this.attempts.set(attempt.applyAttemptId, attempt)
  }

  update(attempt: PrivateApplyAttemptV1): void {
    const existing = this.attempts.get(attempt.applyAttemptId)
    if (!existing || existing.requestDigest !== attempt.requestDigest) {
      throw new ChangeApplyErrorV1('APPLY_ATTEMPT_CONFLICT')
    }
    this.attempts.set(attempt.applyAttemptId, attempt)
  }
}

interface DeliveryApplyAttemptRowV1 {
  apply_attempt_id: string
  request_digest: string
  project_root: string
  change_set_json: string
  planned_files_json: string
  written_relative_paths_json: string
  status: string
  receipt_json: string | null
}

export interface SqliteDeliveryApplyAttemptRegistryOptionsV1 {
  readonly dbPath: string
}

export class SqliteDeliveryApplyAttemptRegistryV1 implements DeliveryApplyAttemptRegistryV1 {
  private readonly db: DatabaseSync

  constructor(options: SqliteDeliveryApplyAttemptRegistryOptionsV1) {
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec('pragma foreign_keys = on')
    this.db.exec('pragma journal_mode = WAL')
    this.db.exec('pragma busy_timeout = 5000')
    this.db.exec(`
      create table if not exists delivery_apply_attempts (
        apply_attempt_id text primary key,
        request_digest text not null,
        project_root text not null,
        change_set_json text not null,
        planned_files_json text not null,
        written_relative_paths_json text not null,
        status text not null,
        receipt_json text,
        updated_at text not null
      )
    `)
  }

  close(): void {
    this.db.close()
  }

  get(applyAttemptId: DeliveryApplyAttemptIdV1): PrivateApplyAttemptV1 | undefined {
    const row = this.db
      .prepare('select apply_attempt_id, request_digest, project_root, change_set_json, planned_files_json, written_relative_paths_json, status, receipt_json from delivery_apply_attempts where apply_attempt_id = ?')
      .get(applyAttemptId) as DeliveryApplyAttemptRowV1 | undefined
    return row ? rowToAttempt(row) : undefined
  }

  put(attempt: PrivateApplyAttemptV1): void {
    const existing = this.get(attempt.applyAttemptId)
    if (existing) {
      if (existing.requestDigest !== attempt.requestDigest) throw new ChangeApplyErrorV1('APPLY_ATTEMPT_CONFLICT')
      return
    }
    this.db
      .prepare(
        'insert into delivery_apply_attempts (apply_attempt_id, request_digest, project_root, change_set_json, planned_files_json, written_relative_paths_json, status, receipt_json, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(...attemptSqlValues(attempt), new Date().toISOString())
  }

  update(attempt: PrivateApplyAttemptV1): void {
    const existing = this.get(attempt.applyAttemptId)
    if (!existing || existing.requestDigest !== attempt.requestDigest) {
      throw new ChangeApplyErrorV1('APPLY_ATTEMPT_CONFLICT')
    }
    this.db
      .prepare(
        'update delivery_apply_attempts set request_digest = ?, project_root = ?, change_set_json = ?, planned_files_json = ?, written_relative_paths_json = ?, status = ?, receipt_json = ?, updated_at = ? where apply_attempt_id = ?',
      )
      .run(...attemptSqlValues(attempt).slice(1), new Date().toISOString(), attempt.applyAttemptId)
  }
}

type PrivateApplyStatusV2 = 'STARTED' | 'SUCCEEDED' | 'FAILED_ROLLED_BACK' | 'OUTCOME_UNKNOWN'

interface PrivateRollbackFileV2 {
  readonly operation: 'MODIFY' | 'CREATE' | 'DELETE'
  readonly relativePath: string
  readonly realPath: string
  readonly beforeBytesBase64?: string
}

interface PrivateApplyAttemptV2 {
  readonly applyAttemptId: DeliveryApplyAttemptIdV1
  readonly requestDigest: Sha256Digest
  readonly projectRoot: string
  readonly changeSet: DeliveryChangeSetV2
  readonly plannedFiles: readonly PrivateRollbackFileV2[]
  readonly writtenRelativePaths: readonly string[]
  readonly status: PrivateApplyStatusV2
  readonly receipt?: DeliveryApplyReceiptV2
}

export interface DeliveryApplyAttemptRegistryV2 {
  get(applyAttemptId: DeliveryApplyAttemptIdV1): PrivateApplyAttemptV2 | undefined
  put(attempt: PrivateApplyAttemptV2): void
  update(attempt: PrivateApplyAttemptV2): void
}

function asV2ApplyRegistry(registry: DeliveryApplyAttemptRegistryV1): DeliveryApplyAttemptRegistryV2 {
  return {
    get: (applyAttemptId) => {
      const attempt = registry.get(applyAttemptId)
      if (attempt) assertApplyAttemptVersion(attempt, 2)
      return attempt as unknown as PrivateApplyAttemptV2 | undefined
    },
    put: (attempt) => registry.put(attempt as unknown as PrivateApplyAttemptV1),
    update: (attempt) => registry.update(attempt as unknown as PrivateApplyAttemptV1),
  }
}

export class ChangeApplyErrorV1 extends Error {
  constructor(readonly reasonCode: DeliveryApplySafeCodeV1) {
    super(reasonCode)
    this.name = 'ChangeApplyErrorV1'
  }
}

export interface MainProcessChangeApplyPortOptionsV1 {
  readonly projectResolver: ProjectWorkspaceResolverV1
  readonly registry?: DeliveryApplyAttemptRegistryV1
  readonly gitSnapshotReader?: DeliveryGitSnapshotReaderV1
}

export interface MainProcessChangeApplyPortOptionsV2 {
  readonly projectResolver: ProjectWorkspaceResolverV1
  /** Reuses the existing V1 registry/table; rows carry a versioned V2 JSON payload. */
  readonly registry?: DeliveryApplyAttemptRegistryV1
  readonly gitSnapshotReader?: DeliveryGitSnapshotReaderV1
}

export class MainProcessChangeApplyPortV1 implements DeliveryApplyPortV1 {
  private readonly registry: DeliveryApplyAttemptRegistryV1
  private readonly gitSnapshotReader: DeliveryGitSnapshotReaderV1

  constructor(private readonly options: MainProcessChangeApplyPortOptionsV1) {
    this.registry = options.registry ?? new InMemoryDeliveryApplyAttemptRegistryV1()
    this.gitSnapshotReader = options.gitSnapshotReader ?? nodeGitSnapshotReaderV1
  }

  async apply(request: DeliveryApplyRequestV1): Promise<DeliveryApplyReceiptV1> {
    const requestDigest = digestJson({
      applyAttemptId: request.applyAttemptId,
      approval: request.approval,
      changeSetDigest: request.changeSet.digest,
      fileContents: request.fileContents.map((file) => ({
        relativePath: normalizeRelativePath(file.relativePath),
        contentArtifactId: file.contentArtifactId,
        contentDigest: file.contentDigest,
      })).sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    })
    const existing = this.registry.get(request.applyAttemptId)
    if (existing) {
      assertApplyAttemptVersion(existing, 1)
      if (existing.requestDigest !== requestDigest) throw new ChangeApplyErrorV1('APPLY_ATTEMPT_CONFLICT')
      return this.inspect(request.applyAttemptId)
    }

    let projectRoot = ''
    let plannedFiles: readonly PrivateRollbackFileV1[] = []
    try {
      this.assertApproved(request)
      projectRoot = await this.options.projectResolver.resolveProjectRoot(deliveryTarget(request.changeSet).projectId)
      await this.assertTargetBaseline(projectRoot, request.changeSet)
      const prepared = await prepareFiles(projectRoot, deliveryFiles(request.changeSet), request.fileContents)
      plannedFiles = prepared.plannedFiles
      const started: PrivateApplyAttemptV1 = {
        applyAttemptId: request.applyAttemptId,
        requestDigest,
        projectRoot,
        changeSet: request.changeSet,
        plannedFiles,
        writtenRelativePaths: [],
        status: 'STARTED',
      }
      this.registry.put(started)
      return await this.writeAll(started, prepared.writes, request.faultInjection)
    } catch (error) {
      if (isPreStartChangeApplyErrorV1(error)) throw error
      const receipt = await this.rollbackAsReceipt({
        applyAttemptId: request.applyAttemptId,
        requestDigest,
        projectRoot,
        changeSet: request.changeSet,
        plannedFiles,
        writtenRelativePaths: plannedFiles.map((file) => file.relativePath),
        status: 'STARTED',
      }, safeCode(error, 'TARGET_WRITE_FAILED'), request.faultInjection)
      try {
        this.registry.put({
          applyAttemptId: request.applyAttemptId,
          requestDigest,
          projectRoot,
          changeSet: request.changeSet,
          plannedFiles,
          writtenRelativePaths: receipt.changedRelativePaths,
          status: receipt.verdict,
          receipt,
        })
      } catch {
        this.registry.update({
          applyAttemptId: request.applyAttemptId,
          requestDigest,
          projectRoot,
          changeSet: request.changeSet,
          plannedFiles,
          writtenRelativePaths: receipt.changedRelativePaths,
          status: receipt.verdict,
          receipt,
        })
      }
      return receipt
    }
  }

  async inspect(applyAttemptId: DeliveryApplyAttemptIdV1): Promise<DeliveryApplyReceiptV1> {
    const attempt = this.registry.get(applyAttemptId)
    if (!attempt) throw new ChangeApplyErrorV1('APPLY_ATTEMPT_NOT_FOUND')
    assertApplyAttemptVersion(attempt, 1)
    return inspectApplyAttempt(attempt, {
      inspect: inspectApplyFileState,
      succeeded: (value) => succeededReceipt(value, currentTargetFingerprint(deliveryTarget(value.changeSet))),
      failed: failedReceipt,
      update: (value) => this.registry.update(value),
      rollback: (value, reason) => this.rollbackAsReceipt(value, reason),
    })
  }

  private assertApproved(request: DeliveryApplyRequestV1): void {
    const { digest: _digest, ...changeSetForDigest } = request.changeSet
    assertApprovedChangeSet(request.approval, request.changeSet, deliveryChangeSetDigestV1(changeSetForDigest))
  }

  private async assertTargetBaseline(projectRoot: string, changeSet: DeliveryChangeSetV1): Promise<void> {
    await assertTargetBaseline(this.gitSnapshotReader, projectRoot, deliveryTarget(changeSet))
  }

  private async writeAll(
    attempt: PrivateApplyAttemptV1,
    writes: readonly PreparedWriteV1[],
    faultInjection?: DeliveryApplyFaultInjectionV1,
  ): Promise<DeliveryApplyReceiptV1> {
    return writeApplyTransaction(attempt, writes, faultInjection, {
      write: async (write) => writeFile(write.realPath, write.nextBytes, write.operation === 'CREATE' ? { flag: 'wx' } : undefined),
      allDesired: (value) => allDesiredFilesPresent(value.projectRoot, deliveryFiles(value.changeSet)),
      succeeded: (value) => succeededReceipt(value, currentTargetFingerprint(deliveryTarget(value.changeSet))),
      update: (value) => this.registry.update(value),
      rollback: (value, reason, fault) => this.rollbackAsReceipt(value, reason, fault),
    })
  }

  private async rollbackAsReceipt(
    attempt: PrivateApplyAttemptV1,
    reason: DeliveryApplySafeCodeV1,
    faultInjection?: DeliveryApplyFaultInjectionV1,
  ): Promise<DeliveryApplyReceiptV1> {
    return rollbackApplyTransaction(attempt, reason, faultInjection, rollback, failedReceipt, (value) => this.registry.update(value))
  }
}

/**
 * Explicit Apply seam for the versioned DELETE/CREATE file effects. It shares
 * Main path/baseline validation and the existing SQLite attempt table while
 * leaving the V1 port's accepted operation set untouched.
 */
export class MainProcessChangeApplyPortV2 implements DeliveryApplyPortV2 {
  private readonly registry: DeliveryApplyAttemptRegistryV2
  private readonly gitSnapshotReader: DeliveryGitSnapshotReaderV1

  constructor(private readonly options: MainProcessChangeApplyPortOptionsV2) {
    this.registry = asV2ApplyRegistry(options.registry ?? new InMemoryDeliveryApplyAttemptRegistryV1())
    this.gitSnapshotReader = options.gitSnapshotReader ?? nodeGitSnapshotReaderV1
  }

  async apply(request: DeliveryApplyRequestV2): Promise<DeliveryApplyReceiptV2> {
    const requestDigest = digestJson({
      applyAttemptId: request.applyAttemptId,
      approval: request.approval,
      changeSetDigest: request.changeSet.digest,
      fileContents: request.fileContents.map((file) => ({
        relativePath: normalizeRelativePath(file.relativePath),
        contentArtifactId: file.contentArtifactId,
        contentDigest: file.contentDigest,
      })).sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    })
    const existing = this.registry.get(request.applyAttemptId)
    if (existing) {
      assertApplyAttemptVersion(existing, 2)
      if (existing.requestDigest !== requestDigest) throw new ChangeApplyErrorV1('APPLY_ATTEMPT_CONFLICT')
      return this.inspect(request.applyAttemptId)
    }

    let projectRoot = ''
    let plannedFiles: readonly PrivateRollbackFileV2[] = []
    try {
      this.assertApproved(request)
      projectRoot = await this.options.projectResolver.resolveProjectRoot(request.changeSet.target.projectId)
      await this.assertTargetBaseline(projectRoot, request.changeSet)
      const prepared = await prepareFilesV2(projectRoot, request.changeSet.fileChanges, request.fileContents)
      plannedFiles = prepared.plannedFiles
      const started: PrivateApplyAttemptV2 = {
        applyAttemptId: request.applyAttemptId,
        requestDigest,
        projectRoot,
        changeSet: request.changeSet,
        plannedFiles,
        writtenRelativePaths: [],
        status: 'STARTED',
      }
      this.registry.put(started)
      return await this.writeAllV2(started, prepared.writes, request.faultInjection)
    } catch (error) {
      if (isPreStartChangeApplyErrorV2(error)) throw error
      const receipt = await this.rollbackAsReceiptV2({
        applyAttemptId: request.applyAttemptId,
        requestDigest,
        projectRoot,
        changeSet: request.changeSet,
        plannedFiles,
        writtenRelativePaths: [],
        status: 'STARTED',
      }, safeCode(error, 'TARGET_WRITE_FAILED'), request.faultInjection)
      try {
        this.registry.put({
          applyAttemptId: request.applyAttemptId,
          requestDigest,
          projectRoot,
          changeSet: request.changeSet,
          plannedFiles,
          writtenRelativePaths: receipt.changedRelativePaths,
          status: receipt.verdict,
          receipt,
        })
      } catch {
        this.registry.update({
          applyAttemptId: request.applyAttemptId,
          requestDigest,
          projectRoot,
          changeSet: request.changeSet,
          plannedFiles,
          writtenRelativePaths: receipt.changedRelativePaths,
          status: receipt.verdict,
          receipt,
        })
      }
      return receipt
    }
  }

  async inspect(applyAttemptId: DeliveryApplyAttemptIdV1): Promise<DeliveryApplyReceiptV2> {
    const attempt = this.registry.get(applyAttemptId)
    if (!attempt) throw new ChangeApplyErrorV1('APPLY_ATTEMPT_NOT_FOUND')
    assertApplyAttemptVersion(attempt, 2)
    return inspectApplyAttempt(attempt, {
      inspect: inspectApplyFileStateV2,
      succeeded: (value) => succeededReceiptV2(value, currentTargetFingerprint(value.changeSet.target)),
      failed: failedReceiptV2,
      update: (value) => this.registry.update(value),
      rollback: (value, reason) => this.rollbackAsReceiptV2(value, reason),
    })
  }

  private assertApproved(request: DeliveryApplyRequestV2): void {
    const { digest: _digest, ...changeSetForDigest } = request.changeSet
    assertApprovedChangeSet(request.approval, request.changeSet, deliveryChangeSetDigestV2(changeSetForDigest))
  }

  private async assertTargetBaseline(projectRoot: string, changeSet: DeliveryChangeSetV2): Promise<void> {
    await assertTargetBaseline(this.gitSnapshotReader, projectRoot, changeSet.target)
  }

  private async writeAllV2(
    attempt: PrivateApplyAttemptV2,
    writes: readonly PreparedWriteV2[],
    faultInjection?: DeliveryApplyFaultInjectionV1,
  ): Promise<DeliveryApplyReceiptV2> {
    return writeApplyTransaction(attempt, writes, faultInjection, {
      write: async (write) => {
        await assertWritePreconditionV2(write)
        if (write.operation === 'DELETE') {
          await unlink(write.realPath)
        } else if (write.operation === 'CREATE') {
          if (!write.nextBytes) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
          await writeFile(write.realPath, write.nextBytes, { flag: 'wx' })
        } else {
          if (!write.nextBytes) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
          await writeFile(write.realPath, write.nextBytes)
        }
      },
      allDesired: (value) => allDesiredFilesPresentV2(value.projectRoot, value.changeSet.fileChanges),
      succeeded: (value) => succeededReceiptV2(value, currentTargetFingerprint(value.changeSet.target)),
      update: (value) => this.registry.update(value),
      rollback: (value, reason, fault) => this.rollbackAsReceiptV2(value, reason, fault),
    })
  }

  private async rollbackAsReceiptV2(
    attempt: PrivateApplyAttemptV2,
    reason: DeliveryApplySafeCodeV1,
    faultInjection?: DeliveryApplyFaultInjectionV1,
  ): Promise<DeliveryApplyReceiptV2> {
    return rollbackApplyTransaction(attempt, reason, faultInjection, rollbackV2, failedReceiptV2, (value) => this.registry.update(value))
  }
}

type ApplyInspection = {
  readonly kind: 'ALL_DESIRED' | 'SAFE_MIXED' | 'HAS_UNKNOWN'
  readonly desiredRelativePaths: readonly string[]
}

type ApplyAttemptShape<R> = {
  readonly writtenRelativePaths: readonly string[]
  readonly status: PrivateApplyStatusV1
  readonly receipt?: R
}

async function inspectApplyAttempt<A extends ApplyAttemptShape<R>, R>(
  attempt: A,
  operations: {
    readonly inspect: (attempt: A) => Promise<ApplyInspection>
    readonly succeeded: (attempt: A) => R
    readonly failed: (attempt: A, verdict: 'FAILED_ROLLED_BACK' | 'OUTCOME_UNKNOWN', safeCode: DeliveryApplySafeCodeV1) => R
    readonly update: (attempt: A) => void
    readonly rollback: (attempt: A, reason: DeliveryApplySafeCodeV1) => Promise<R>
  },
): Promise<R> {
  if (attempt.receipt && (attempt.receipt as { verdict?: string }).verdict !== 'OUTCOME_UNKNOWN') return attempt.receipt
  const inspection = await operations.inspect(attempt)
  if (inspection.kind === 'ALL_DESIRED') {
    const receipt = operations.succeeded(attempt)
    operations.update({ ...attempt, status: 'SUCCEEDED', receipt })
    return receipt
  }
  if (inspection.kind === 'HAS_UNKNOWN') {
    const receipt = operations.failed(attempt, 'OUTCOME_UNKNOWN', 'ROLLBACK_INCOMPLETE')
    operations.update({ ...attempt, status: 'OUTCOME_UNKNOWN', receipt })
    return receipt
  }
  return operations.rollback({
    ...attempt,
    writtenRelativePaths: mergeRelativePaths(attempt.writtenRelativePaths, inspection.desiredRelativePaths),
  }, 'TARGET_WRITE_FAILED')
}

async function writeApplyTransaction<
  A extends ApplyAttemptShape<R>,
  R,
  W extends { readonly relativePath: string },
>(
  attempt: A,
  writes: readonly W[],
  faultInjection: DeliveryApplyFaultInjectionV1 | undefined,
  operations: {
    readonly write: (write: W) => Promise<unknown>
    readonly allDesired: (attempt: A) => Promise<boolean>
    readonly succeeded: (attempt: A) => R
    readonly update: (attempt: A) => void
    readonly rollback: (attempt: A, reason: DeliveryApplySafeCodeV1, fault?: DeliveryApplyFaultInjectionV1) => Promise<R>
  },
): Promise<R> {
  const writtenRelativePaths: string[] = []
  try {
    for (const write of writes) {
      await operations.write(write)
      writtenRelativePaths.push(write.relativePath)
      operations.update({ ...attempt, writtenRelativePaths: [...writtenRelativePaths] })
      if (faultInjection?.failAfterWrites === writtenRelativePaths.length) {
        throw new ChangeApplyErrorV1('TARGET_WRITE_FAILED')
      }
    }
    const completed = { ...attempt, writtenRelativePaths }
    if (!(await operations.allDesired(completed))) throw new ChangeApplyErrorV1('TARGET_WRITE_FAILED')
    const receipt = operations.succeeded(completed)
    operations.update({ ...completed, status: 'SUCCEEDED', receipt })
    return receipt
  } catch (error) {
    return operations.rollback(
      { ...attempt, writtenRelativePaths },
      safeCode(error, 'TARGET_WRITE_FAILED'),
      faultInjection,
    )
  }
}

async function rollbackApplyTransaction<A extends ApplyAttemptShape<R>, R>(
  attempt: A,
  reason: DeliveryApplySafeCodeV1,
  faultInjection: DeliveryApplyFaultInjectionV1 | undefined,
  rollbackFiles: (attempt: A, fault?: DeliveryApplyFaultInjectionV1) => Promise<boolean>,
  failed: (attempt: A, verdict: 'FAILED_ROLLED_BACK' | 'OUTCOME_UNKNOWN', safeCode: DeliveryApplySafeCodeV1) => R,
  update: (attempt: A) => void,
): Promise<R> {
  const rollbackOk = await rollbackFiles(attempt, faultInjection)
  const verdict = rollbackOk ? 'FAILED_ROLLED_BACK' : 'OUTCOME_UNKNOWN'
  const receipt = failed(attempt, verdict, rollbackOk ? reason : 'ROLLBACK_INCOMPLETE')
  update({ ...attempt, status: verdict, receipt })
  return receipt
}

function assertApprovedChangeSet(
  approval: { readonly deliveryChangeSetId: string; readonly version: number; readonly digest: Sha256Digest },
  changeSet: { readonly deliveryChangeSetId: string; readonly version: number; readonly digest: Sha256Digest },
  expectedDigest: Sha256Digest,
): void {
  if (
    approval.deliveryChangeSetId !== changeSet.deliveryChangeSetId ||
    approval.version !== changeSet.version ||
    approval.digest !== changeSet.digest
  ) {
    throw new ChangeApplyErrorV1('APPROVAL_SUBJECT_MISMATCH')
  }
  if (expectedDigest !== changeSet.digest) throw new ChangeApplyErrorV1('DELIVERY_CHANGESET_DIGEST_MISMATCH')
}

function assertApplyAttemptVersion(
  attempt: { readonly changeSet?: { readonly version?: unknown } },
  expectedVersion: 1 | 2,
): void {
  if (attempt.changeSet?.version !== expectedVersion) {
    throw new ChangeApplyErrorV1('APPLY_ATTEMPT_CONFLICT')
  }
}

async function assertTargetBaseline(
  reader: DeliveryGitSnapshotReaderV1,
  projectRoot: string,
  target: DeliveryTargetV1,
): Promise<void> {
  const snapshot = await reader.read(projectRoot)
  if (snapshot.porcelainStatus.length > 0) throw new ChangeApplyErrorV1('TARGET_STATUS_DIRTY')
  if (
    snapshot.headRevision !== target.baseRevision ||
    snapshot.treeHash !== target.baselineTreeHash ||
    currentTargetFingerprint(target) !== target.initialTargetFingerprint
  ) {
    throw new ChangeApplyErrorV1('TARGET_BASELINE_DRIFT')
  }
}

interface PreparedWriteV2 {
  readonly operation: 'MODIFY' | 'CREATE' | 'DELETE'
  readonly relativePath: string
  readonly realPath: string
  readonly nextBytes?: Buffer
  readonly beforeBytesBase64?: string
}

async function prepareFilesV2(
  projectRoot: string,
  files: readonly DeliveryFileChangeSummaryV2[],
  fileContents: readonly DeliveryApplyFileContentV2[],
): Promise<{ plannedFiles: readonly PrivateRollbackFileV2[]; writes: readonly PreparedWriteV2[] }> {
  if (!Array.isArray(files) || files.length === 0) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  const contentByPath = normalizedFileContentMapV2(fileContents)
  const seen = new Set<string>()
  const plannedFiles: PrivateRollbackFileV2[] = []
  const writes: PreparedWriteV2[] = []
  let contentFileCount = 0
  for (const file of files) {
    if (file.operation !== 'MODIFY' && file.operation !== 'CREATE' && file.operation !== 'DELETE') {
      throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
    }
    const relativePath = normalizeRelativePath(file.relativePath)
    const key = pathKey(relativePath)
    if (seen.has(key)) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
    seen.add(key)
    const target = await resolveDeliveryPath(projectRoot, relativePath)
    if (file.operation === 'DELETE') {
      if (file.baselineDigest === null || file.contentDigest !== null || contentByPath.has(key)) {
        throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
      }
      const before = await readStableFile(target.realPath)
      if (before.contentDigest !== file.baselineDigest) throw new ChangeApplyErrorV1('TARGET_FILE_DRIFT')
      plannedFiles.push({ operation: 'DELETE', relativePath, realPath: target.realPath, beforeBytesBase64: before.bytes.toString('base64') })
      writes.push({ operation: 'DELETE', relativePath, realPath: target.realPath, beforeBytesBase64: before.bytes.toString('base64') })
      continue
    }

    const privateContent = contentByPath.get(key)
    if (
      !privateContent ||
      privateContent.relativePath !== relativePath ||
      privateContent.contentDigest !== file.contentDigest ||
      privateContent.contentArtifactId !== file.contentArtifactId
    ) {
      throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
    }
    const nextBytes = Buffer.from(privateContent.content)
    if (digestBytes(nextBytes) !== file.contentDigest) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
    contentFileCount += 1
    if (file.operation === 'MODIFY') {
      if (file.baselineDigest === null) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
      const before = await readStableFile(target.realPath)
      if (before.contentDigest !== file.baselineDigest) throw new ChangeApplyErrorV1('TARGET_FILE_DRIFT')
      plannedFiles.push({ operation: 'MODIFY', relativePath, realPath: target.realPath, beforeBytesBase64: before.bytes.toString('base64') })
      writes.push({
        operation: 'MODIFY',
        relativePath,
        realPath: target.realPath,
        nextBytes,
        beforeBytesBase64: before.bytes.toString('base64'),
      })
    } else {
      if (file.baselineDigest !== null) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
      await assertMissing(target.realPath)
      plannedFiles.push({ operation: 'CREATE', relativePath, realPath: target.realPath })
      writes.push({ operation: 'CREATE', relativePath, realPath: target.realPath, nextBytes })
    }
  }
  if (contentByPath.size !== contentFileCount) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  return { plannedFiles, writes }
}

function normalizedFileContentMapV2(fileContents: readonly DeliveryApplyFileContentV2[]): Map<string, DeliveryApplyFileContentV2> {
  if (!Array.isArray(fileContents)) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  const contentByPath = new Map<string, DeliveryApplyFileContentV2>()
  for (const file of fileContents) {
    const relativePath = normalizeRelativePath(file.relativePath)
    const key = pathKey(relativePath)
    if (contentByPath.has(key)) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
    contentByPath.set(key, { ...file, relativePath })
  }
  return contentByPath
}

async function assertWritePreconditionV2(write: PreparedWriteV2): Promise<void> {
  if (write.operation === 'CREATE') {
    await assertMissing(write.realPath)
    return
  }
  const current = await readStableFile(write.realPath)
  if (current.bytes.toString('base64') !== write.beforeBytesBase64) throw new ChangeApplyErrorV1('TARGET_FILE_DRIFT')
}

async function rollbackV2(attempt: PrivateApplyAttemptV2, faultInjection?: DeliveryApplyFaultInjectionV1): Promise<boolean> {
  let ok = true
  const written = new Set(attempt.writtenRelativePaths.map(pathKey))
  for (const file of [...attempt.plannedFiles].reverse()) {
    if (!written.has(pathKey(file.relativePath))) continue
    try {
      if (file.operation === 'CREATE') {
        if (!(await fileMatchesDesiredV2(attempt, file))) {
          ok = false
          continue
        }
        await unlink(file.realPath)
      } else {
        const state = await plannedFileStateV2(attempt, file)
        if (state === 'BEFORE') continue
        if (state !== 'DESIRED') {
          ok = false
          continue
        }
        await writeFile(file.realPath, Buffer.from(file.beforeBytesBase64 ?? '', 'base64'))
      }
      if (faultInjection?.corruptRollbackForRelativePath === file.relativePath) {
        await writeFile(file.realPath, Buffer.from('rollback-corrupted-by-test', 'utf8'))
      }
    } catch {
      ok = false
    }
  }
  for (const file of attempt.plannedFiles) {
    if (!written.has(pathKey(file.relativePath))) continue
    try {
      if (file.operation === 'CREATE') {
        await access(file.realPath, constants.F_OK)
        ok = false
      } else {
        const restored = await readStableFile(file.realPath)
        if (restored.bytes.toString('base64') !== file.beforeBytesBase64) ok = false
      }
    } catch {
      if (file.operation !== 'CREATE') ok = false
    }
  }
  return ok
}

async function allDesiredFilesPresentV2(projectRoot: string, files: readonly DeliveryFileChangeSummaryV2[]): Promise<boolean> {
  for (const file of files) {
    const target = await resolveDeliveryPath(projectRoot, normalizeRelativePath(file.relativePath))
    try {
      if (file.operation === 'DELETE') {
        await assertMissing(target.realPath)
      } else {
        const current = await readStableFile(target.realPath)
        if (current.contentDigest !== file.contentDigest) return false
      }
    } catch {
      return false
    }
  }
  return true
}

interface ApplyFileInspectionV2 {
  readonly kind: 'ALL_DESIRED' | 'SAFE_MIXED' | 'HAS_UNKNOWN'
  readonly desiredRelativePaths: readonly string[]
}

async function inspectApplyFileStateV2(attempt: PrivateApplyAttemptV2): Promise<ApplyFileInspectionV2> {
  let allDesired = true
  const desiredRelativePaths: string[] = []
  for (const file of attempt.plannedFiles) {
    const state = await plannedFileStateV2(attempt, file)
    if (state === 'UNKNOWN') return { kind: 'HAS_UNKNOWN', desiredRelativePaths: [] }
    if (state === 'DESIRED') desiredRelativePaths.push(file.relativePath)
    if (state !== 'DESIRED') allDesired = false
  }
  return { kind: allDesired ? 'ALL_DESIRED' : 'SAFE_MIXED', desiredRelativePaths }
}

async function plannedFileStateV2(
  attempt: PrivateApplyAttemptV2,
  file: PrivateRollbackFileV2,
): Promise<'BEFORE' | 'DESIRED' | 'UNKNOWN'> {
  try {
    const current = await readStableFile(file.realPath)
    if (file.operation === 'DELETE' && current.bytes.toString('base64') === file.beforeBytesBase64) return 'BEFORE'
    if (current.contentDigest === desiredDigestForV2(attempt, file.relativePath)) return 'DESIRED'
    if (file.operation === 'MODIFY' && current.bytes.toString('base64') === file.beforeBytesBase64) return 'BEFORE'
    return 'UNKNOWN'
  } catch (error) {
    if (
      (file.operation === 'CREATE' || file.operation === 'DELETE') &&
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return file.operation === 'DELETE' ? 'DESIRED' : 'BEFORE'
    }
    return 'UNKNOWN'
  }
}

async function fileMatchesDesiredV2(attempt: PrivateApplyAttemptV2, file: PrivateRollbackFileV2): Promise<boolean> {
  if (file.operation === 'DELETE') {
    try {
      await lstat(file.realPath)
      return false
    } catch (error) {
      return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
    }
  }
  try {
    const current = await readStableFile(file.realPath)
    return current.contentDigest === desiredDigestForV2(attempt, file.relativePath)
  } catch {
    return false
  }
}

function desiredDigestForV2(attempt: PrivateApplyAttemptV2, relativePath: string): Sha256Digest {
  const file = attempt.changeSet.fileChanges.find((candidate) => pathKey(normalizeRelativePath(candidate.relativePath)) === pathKey(relativePath))
  if (!file || file.contentDigest === null) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  return file.contentDigest
}

function succeededReceiptV2(attempt: PrivateApplyAttemptV2, targetFingerprint: Sha256Digest): DeliveryApplyReceiptV2 {
  const withoutDigest = {
    applyAttemptId: attempt.applyAttemptId,
    deliveryChangeSetId: attempt.changeSet.deliveryChangeSetId,
    verdict: 'SUCCEEDED' as const,
    changedRelativePaths: attempt.changeSet.fileChanges.map((file) => normalizeRelativePath(file.relativePath)).sort(),
    targetFingerprint,
  }
  return { ...withoutDigest, receiptDigest: deliveryApplyReceiptDigestV2(withoutDigest) }
}

function failedReceiptV2(
  attempt: PrivateApplyAttemptV2,
  verdict: 'FAILED_ROLLED_BACK' | 'OUTCOME_UNKNOWN',
  safeCode: DeliveryApplySafeCodeV1,
): DeliveryApplyReceiptV2 {
  const withoutDigest = {
    applyAttemptId: attempt.applyAttemptId,
    deliveryChangeSetId: attempt.changeSet.deliveryChangeSetId,
    verdict,
    changedRelativePaths: [...attempt.writtenRelativePaths].sort(),
    safeCode,
  }
  return { ...withoutDigest, receiptDigest: deliveryApplyReceiptDigestV2(withoutDigest) }
}

interface PreparedWriteV1 {
  readonly operation: 'MODIFY' | 'CREATE'
  readonly relativePath: string
  readonly realPath: string
  readonly nextBytes: Buffer
}

async function prepareFiles(
  projectRoot: string,
  files: readonly DeliveryFileChangeSummaryV1[],
  fileContents: readonly DeliveryApplyFileContentV1[],
): Promise<{ plannedFiles: readonly PrivateRollbackFileV1[]; writes: readonly PreparedWriteV1[] }> {
  if (!Array.isArray(files) || files.length === 0) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  const contentByPath = normalizedFileContentMap(fileContents)
  const seen = new Set<string>()
  const plannedFiles: PrivateRollbackFileV1[] = []
  const writes: PreparedWriteV1[] = []
  for (const file of files) {
    if (file.operation !== 'MODIFY' && file.operation !== 'CREATE') throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
    const relativePath = normalizeRelativePath(file.relativePath)
    const key = pathKey(relativePath)
    if (seen.has(key)) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
    seen.add(key)
    const privateContent = contentByPath.get(key)
    if (
      !privateContent ||
      privateContent.relativePath !== relativePath ||
      privateContent.contentDigest !== file.contentDigest ||
      privateContent.contentArtifactId !== file.contentArtifactId
    ) {
      throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
    }
    const nextBytes = Buffer.from(privateContent.content)
    if (digestBytes(nextBytes) !== file.contentDigest) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
    const target = await resolveDeliveryPath(projectRoot, relativePath)
    if (file.operation === 'MODIFY') {
      const before = await readStableFile(target.realPath)
      if (before.contentDigest !== file.baselineDigest) throw new ChangeApplyErrorV1('TARGET_FILE_DRIFT')
      plannedFiles.push({
        operation: 'MODIFY',
        relativePath,
        realPath: target.realPath,
        beforeBytesBase64: before.bytes.toString('base64'),
      })
    } else {
      if (file.baselineDigest !== null) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
      await assertMissing(target.realPath)
      plannedFiles.push({ operation: 'CREATE', relativePath, realPath: target.realPath })
    }
    writes.push({ operation: file.operation, relativePath, realPath: target.realPath, nextBytes })
  }
  if (contentByPath.size !== seen.size) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  return { plannedFiles, writes }
}

function normalizedFileContentMap(fileContents: readonly DeliveryApplyFileContentV1[]): Map<string, DeliveryApplyFileContentV1> {
  if (!Array.isArray(fileContents) || fileContents.length === 0) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  const contentByPath = new Map<string, DeliveryApplyFileContentV1>()
  for (const file of fileContents) {
    const relativePath = normalizeRelativePath(file.relativePath)
    const key = pathKey(relativePath)
    if (contentByPath.has(key)) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
    contentByPath.set(key, {
      relativePath,
      contentArtifactId: file.contentArtifactId,
      content: file.content,
      contentDigest: file.contentDigest,
    })
  }
  return contentByPath
}

async function rollback(attempt: PrivateApplyAttemptV1, faultInjection?: DeliveryApplyFaultInjectionV1): Promise<boolean> {
  let ok = true
  const written = new Set(attempt.writtenRelativePaths.map(pathKey))
  for (const file of [...attempt.plannedFiles].reverse()) {
    if (!written.has(pathKey(file.relativePath))) continue
    try {
      if (file.operation === 'CREATE') {
        if (!(await fileMatchesDesired(attempt, file))) {
          ok = false
          continue
        }
        await unlink(file.realPath)
      } else {
        const state = await plannedFileState(attempt, file)
        if (state === 'BEFORE') continue
        if (state !== 'DESIRED') {
          ok = false
          continue
        }
        await writeFile(file.realPath, Buffer.from(file.beforeBytesBase64 ?? '', 'base64'))
      }
      if (faultInjection?.corruptRollbackForRelativePath === file.relativePath) {
        await writeFile(file.realPath, Buffer.from('rollback-corrupted-by-test', 'utf8'))
      }
    } catch {
      ok = false
    }
  }
  for (const file of attempt.plannedFiles) {
    if (!written.has(pathKey(file.relativePath))) continue
    try {
      if (file.operation === 'CREATE') {
        await access(file.realPath, constants.F_OK)
        ok = false
      } else {
        const restored = await readStableFile(file.realPath)
        if (restored.bytes.toString('base64') !== file.beforeBytesBase64) ok = false
      }
    } catch (error) {
      if (file.operation !== 'CREATE') ok = false
    }
  }
  return ok
}

async function allDesiredFilesPresent(projectRoot: string, files: readonly DeliveryFileChangeSummaryV1[]): Promise<boolean> {
  for (const file of files) {
    const relativePath = normalizeRelativePath(file.relativePath)
    const target = await resolveDeliveryPath(projectRoot, relativePath)
    try {
      const current = await readStableFile(target.realPath)
      if (current.contentDigest !== file.contentDigest) return false
    } catch {
      return false
    }
  }
  return true
}

interface ApplyFileInspectionV1 {
  readonly kind: 'ALL_DESIRED' | 'SAFE_MIXED' | 'HAS_UNKNOWN'
  readonly desiredRelativePaths: readonly string[]
}

async function inspectApplyFileState(attempt: PrivateApplyAttemptV1): Promise<ApplyFileInspectionV1> {
  let allDesired = true
  const desiredRelativePaths: string[] = []
  for (const file of attempt.plannedFiles) {
    const state = await plannedFileState(attempt, file)
    if (state === 'UNKNOWN') return { kind: 'HAS_UNKNOWN', desiredRelativePaths: [] }
    if (state === 'DESIRED') desiredRelativePaths.push(file.relativePath)
    if (state !== 'DESIRED') allDesired = false
  }
  return { kind: allDesired ? 'ALL_DESIRED' : 'SAFE_MIXED', desiredRelativePaths }
}

async function plannedFileState(
  attempt: PrivateApplyAttemptV1,
  file: PrivateRollbackFileV1,
): Promise<'BEFORE' | 'DESIRED' | 'UNKNOWN'> {
  try {
    const current = await readStableFile(file.realPath)
    if (current.contentDigest === desiredDigestFor(attempt, file.relativePath)) return 'DESIRED'
    if (file.operation === 'MODIFY' && current.bytes.toString('base64') === file.beforeBytesBase64) return 'BEFORE'
    return 'UNKNOWN'
  } catch (error) {
    if (
      file.operation === 'CREATE' &&
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return 'BEFORE'
    }
    return 'UNKNOWN'
  }
}

async function fileMatchesDesired(attempt: PrivateApplyAttemptV1, file: PrivateRollbackFileV1): Promise<boolean> {
  try {
    const current = await readStableFile(file.realPath)
    return current.contentDigest === desiredDigestFor(attempt, file.relativePath)
  } catch {
    return false
  }
}

function desiredDigestFor(attempt: PrivateApplyAttemptV1, relativePath: string): Sha256Digest {
  const file = deliveryFiles(attempt.changeSet).find((candidate) => pathKey(normalizeRelativePath(candidate.relativePath)) === pathKey(relativePath))
  if (!file) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  return file.contentDigest
}

async function resolveDeliveryPath(projectRoot: string, relativePath: string): Promise<{ realPath: string }> {
  const root = await realpath(projectRoot)
  const lexical = resolve(root, relativePath.replace(/\//g, sep))
  if (!isInside(root, lexical)) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  const parent = await realpath(dirname(lexical))
  if (!isInside(root, parent) || pathKey(parent) !== pathKey(dirname(lexical))) {
    throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  }
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
    throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  }
  const normalized = value.replace(/[\\]+/g, '/')
  const parts = normalized.split('/')
  if (parts.includes('..') || parts.includes('.') || parts.includes('') || parts.some((part) => part.toLowerCase() === '.git')) {
    throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  }
  const parsed = posix.normalize(normalized)
  if (parsed === '.' || parsed.startsWith('../')) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  return parsed
}

async function readStableFile(realPath: string): Promise<{ bytes: Buffer; contentDigest: Sha256Digest }> {
  const before = await readFileIdentity(realPath)
  const bytes = await readFile(realPath)
  const after = await readFileIdentity(realPath)
  const contentDigest = digestBytes(bytes)
  if (before.identityDigest !== after.identityDigest || before.contentDigest !== contentDigest || after.contentDigest !== contentDigest) {
    throw new ChangeApplyErrorV1('TARGET_FILE_DRIFT')
  }
  return { bytes, contentDigest }
}

async function readFileIdentity(realPath: string): Promise<{ contentDigest: Sha256Digest; identityDigest: Sha256Digest }> {
  const info = await lstat(realPath, { bigint: true })
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) throw new ChangeApplyErrorV1('TARGET_FILE_DRIFT')
  const contentDigest = await digestFile(realPath)
  return {
    contentDigest,
    identityDigest: digestJson({ dev: info.dev.toString(), ino: info.ino.toString(), size: info.size.toString(), contentDigest }),
  }
}

async function assertMissing(realPath: string): Promise<void> {
  try {
    await lstat(realPath)
    throw new ChangeApplyErrorV1('TARGET_FILE_DRIFT')
  } catch (error) {
    if (error instanceof ChangeApplyErrorV1) throw error
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') return
    throw new ChangeApplyErrorV1('TARGET_FILE_DRIFT')
  }
}

function succeededReceipt(attempt: PrivateApplyAttemptV1, targetFingerprint: Sha256Digest): DeliveryApplyReceiptV1 {
  const withoutDigest = {
    applyAttemptId: attempt.applyAttemptId,
    deliveryChangeSetId: attempt.changeSet.deliveryChangeSetId,
    verdict: 'SUCCEEDED' as const,
    changedRelativePaths: deliveryFiles(attempt.changeSet).map((file) => normalizeRelativePath(file.relativePath)).sort(),
    targetFingerprint,
  }
  return { ...withoutDigest, receiptDigest: deliveryApplyReceiptDigestV1(withoutDigest) }
}

function deliveryTarget(changeSet: DeliveryChangeSetV1): DeliveryTargetV1 {
  if (!changeSet.target) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  return changeSet.target
}

function deliveryFiles(changeSet: DeliveryChangeSetV1): readonly DeliveryFileChangeSummaryV1[] {
  if (!changeSet.fileChanges || changeSet.fileChanges.length === 0) throw new ChangeApplyErrorV1('DELIVERY_FILE_INVALID')
  return changeSet.fileChanges
}

function currentTargetFingerprint(target: DeliveryTargetV1): Sha256Digest {
  return deliveryTargetFingerprintV1({
    projectId: target.projectId,
    baseRevision: target.baseRevision,
    baselineTreeHash: target.baselineTreeHash,
  })
}

function failedReceipt(
  attempt: PrivateApplyAttemptV1,
  verdict: 'FAILED_ROLLED_BACK' | 'OUTCOME_UNKNOWN',
  safeCode: DeliveryApplySafeCodeV1,
): DeliveryApplyReceiptV1 {
  const withoutDigest = {
    applyAttemptId: attempt.applyAttemptId,
    deliveryChangeSetId: attempt.changeSet.deliveryChangeSetId,
    verdict,
    changedRelativePaths: [...attempt.writtenRelativePaths].sort(),
    safeCode,
  }
  return { ...withoutDigest, receiptDigest: deliveryApplyReceiptDigestV1(withoutDigest) }
}

export function isPreStartChangeApplyErrorV1(error: unknown): error is ChangeApplyErrorV1 {
  return error instanceof ChangeApplyErrorV1 && [
    'APPROVAL_SUBJECT_MISMATCH',
    'DELIVERY_CHANGESET_DIGEST_MISMATCH',
    'DELIVERY_FILE_INVALID',
    'TARGET_BASELINE_DRIFT',
    'TARGET_STATUS_DIRTY',
    'TARGET_FILE_DRIFT',
  ].includes(error.reasonCode)
}

export function isPreStartChangeApplyErrorV2(error: unknown): error is ChangeApplyErrorV1 {
  return error instanceof ChangeApplyErrorV1 && [
    'APPROVAL_SUBJECT_MISMATCH',
    'DELIVERY_CHANGESET_DIGEST_MISMATCH',
    'DELIVERY_FILE_INVALID',
    'TARGET_BASELINE_DRIFT',
    'TARGET_STATUS_DIRTY',
    'TARGET_FILE_DRIFT',
  ].includes(error.reasonCode)
}

function safeCode(error: unknown, fallback: DeliveryApplySafeCodeV1): DeliveryApplySafeCodeV1 {
  return error instanceof ChangeApplyErrorV1 ? error.reasonCode : fallback
}

function isInside(rootPath: string, candidate: string): boolean {
  const child = relative(rootPath, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function mergeRelativePaths(left: readonly string[], right: readonly string[]): readonly string[] {
  const merged = new Map<string, string>()
  for (const value of [...left, ...right]) merged.set(pathKey(value), value)
  return [...merged.values()]
}

function digestBytes(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as Sha256Digest
}

function digestJson(value: unknown): Sha256Digest {
  return digestBytes(Buffer.from(JSON.stringify(value), 'utf8'))
}

function rowToAttempt(row: DeliveryApplyAttemptRowV1): PrivateApplyAttemptV1 {
  return {
    applyAttemptId: row.apply_attempt_id as DeliveryApplyAttemptIdV1,
    requestDigest: row.request_digest as Sha256Digest,
    projectRoot: row.project_root,
    changeSet: JSON.parse(row.change_set_json) as DeliveryChangeSetV1,
    plannedFiles: JSON.parse(row.planned_files_json) as PrivateRollbackFileV1[],
    writtenRelativePaths: JSON.parse(row.written_relative_paths_json) as string[],
    status: row.status as PrivateApplyStatusV1,
    ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) as DeliveryApplyReceiptV1 } : {}),
  }
}

function attemptSqlValues(attempt: PrivateApplyAttemptV1): [
  DeliveryApplyAttemptIdV1,
  Sha256Digest,
  string,
  string,
  string,
  string,
  PrivateApplyStatusV1,
  string | null,
] {
  return [
    attempt.applyAttemptId,
    attempt.requestDigest,
    attempt.projectRoot,
    JSON.stringify(attempt.changeSet),
    JSON.stringify(attempt.plannedFiles),
    JSON.stringify(attempt.writtenRelativePaths),
    attempt.status,
    attempt.receipt ? JSON.stringify(attempt.receipt) : null,
  ]
}

async function digestFile(realPath: string): Promise<Sha256Digest> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(realPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise())
  })
  return `sha256:${hash.digest('hex')}` as Sha256Digest
}

const nodeGitSnapshotReaderV1: DeliveryGitSnapshotReaderV1 = {
  async read(repositoryRoot: string): Promise<DeliveryGitSnapshotV1> {
    const [headRevision, treeHash, status] = await Promise.all([
      git(repositoryRoot, ['rev-parse', '--verify', 'HEAD']),
      git(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{tree}']),
      git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
    ])
    return {
      headRevision: exactGitOid(headRevision),
      treeHash: exactGitOid(treeHash),
      porcelainStatus: status.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean),
    }
  },
}

function exactGitOid(output: string): string {
  const oid = output.trim()
  if (!/^[0-9a-f]{40}$/i.test(oid)) throw new ChangeApplyErrorV1('TARGET_BASELINE_DRIFT')
  return oid
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new ChangeApplyErrorV1('TARGET_BASELINE_DRIFT'))
        return
      }
      resolvePromise(stdout ?? '')
    })
  })
}
