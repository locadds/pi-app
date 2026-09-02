import { createHash } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { CodingCheckpointV1 } from '@shared/xiaogui-coding-extension-pack'
import {
  XIAOGUI_CODING_CHECKPOINT_SESSION_IMPACT_V1,
} from '@shared/xiaogui-coding-checkpoint-control'

import type {
  AttemptCheckpointBindingV1,
  AttemptWorkspaceCheckpointSnapshotV1,
  CodingCheckpointPersistedStateV1,
  CodingCheckpointRestorePreviewV1,
  CodingCheckpointRestoreSagaV1,
  PiSessionCheckpointSnapshotV1,
} from './checkpoint-module'

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i
const MAX_STATE_ITEMS = 10_000
const MAX_STATE_JSON_BYTES = 32 * 1024 * 1024
const MAX_PUBLIC_PREVIEW_PATHS = 100
const MAX_PUBLIC_PREVIEW_PATH_LENGTH = 1_024

const ATTEMPT_STATES = new Set(['IDLE', 'BUSY', 'UNAVAILABLE', 'OUTCOME_UNKNOWN'])
const ATTEMPT_AUTHORITY_STATUSES = new Set(['READY', 'SUCCEEDED', 'OTHER'])
const CHECKPOINT_STATUSES = new Set(['AVAILABLE', 'RESTORED', 'INVALIDATED'])
const SAGA_PHASES = new Set([
  'PREPARING',
  'ROLLBACK_CAPTURED',
  'WORKTREE_RESTORE_STARTED',
  'WORKTREE_RESTORED',
  'SESSION_RESTORE_STARTED',
  'SESSION_RESTORED',
  'COMPLETED',
  'FAILED_NO_CHANGE',
  'FAILED_ROLLED_BACK',
  'OUTCOME_UNKNOWN',
])

type PrivateCheckpointRecordV1 = CodingCheckpointPersistedStateV1['checkpoints'][number]
type PrivateRestorePreviewRecordV1 = CodingCheckpointPersistedStateV1['previews'][number]

export type CodingCheckpointStateStoreErrorCodeV1 =
  | 'CHECKPOINT_STATE_DB_PATH_REQUIRED'
  | 'CHECKPOINT_STATE_CORRUPT'
  | 'CHECKPOINT_STATE_VERSION_UNSUPPORTED'
  | 'CHECKPOINT_STATE_READ_FAILED'
  | 'CHECKPOINT_STATE_WRITE_FAILED'
  | 'CHECKPOINT_STATE_STORE_CLOSED'

/** Stable, redacted main-process error. It never includes private state or paths. */
export class CodingCheckpointStateStoreError extends Error {
  constructor(readonly code: CodingCheckpointStateStoreErrorCodeV1) {
    super(code)
    this.name = 'CodingCheckpointStateStoreError'
  }
}

export interface CodingCheckpointStateStoreOptionsV1 {
  /** Main-process-private SQLite path. Never project this value through IPC. */
  readonly dbPath: string
  readonly now?: () => string
}

interface StateRowV1 {
  readonly schema_version: number | bigint
  readonly state_json: string
  readonly state_digest: string
}

/**
 * Main-process-only singleton store for checkpoint restart state.
 *
 * The JSON contains opaque snapshot refs and therefore must never be logged or
 * returned through public IPC. Public consumers use checkpoint digests only.
 */
export class CodingCheckpointStateStoreV1 {
  private readonly db: DatabaseSync
  private readonly now: () => string
  private closed = false

  constructor(options: CodingCheckpointStateStoreOptionsV1) {
    if (!options?.dbPath) {
      throw new CodingCheckpointStateStoreError('CHECKPOINT_STATE_DB_PATH_REQUIRED')
    }
    this.now = options.now ?? (() => new Date().toISOString())
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec('pragma journal_mode = WAL')
    this.db.exec('pragma busy_timeout = 5000')
    this.db.exec(`
      create table if not exists xiaogui_coding_checkpoint_state_v1 (
        singleton_id integer primary key check (singleton_id = 1),
        schema_version integer not null,
        state_json text not null,
        state_digest text not null,
        updated_at text not null
      );
    `)
  }

  load(): CodingCheckpointPersistedStateV1 | undefined {
    this.assertOpen()
    let row: StateRowV1 | undefined
    try {
      row = this.db.prepare(`
        select schema_version, state_json, state_digest
        from xiaogui_coding_checkpoint_state_v1
        where singleton_id = 1
      `).get() as StateRowV1 | undefined
    } catch {
      throw new CodingCheckpointStateStoreError('CHECKPOINT_STATE_READ_FAILED')
    }
    if (!row) return undefined
    if (Number(row.schema_version) !== 1) {
      throw new CodingCheckpointStateStoreError('CHECKPOINT_STATE_VERSION_UNSUPPORTED')
    }
    if (
      typeof row.state_json !== 'string'
      || Buffer.byteLength(row.state_json, 'utf8') > MAX_STATE_JSON_BYTES
      || !DIGEST_PATTERN.test(row.state_digest)
      || stateDigest(row.state_json) !== row.state_digest
    ) {
      throw new CodingCheckpointStateStoreError('CHECKPOINT_STATE_CORRUPT')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(row.state_json)
    } catch {
      throw new CodingCheckpointStateStoreError('CHECKPOINT_STATE_CORRUPT')
    }
    return canonicalState(parsed)
  }

  save(state: CodingCheckpointPersistedStateV1): void {
    this.assertOpen()
    const canonical = canonicalState(state)
    const stateJson = JSON.stringify(canonical)
    if (Buffer.byteLength(stateJson, 'utf8') > MAX_STATE_JSON_BYTES) {
      throw new CodingCheckpointStateStoreError('CHECKPOINT_STATE_CORRUPT')
    }
    const updatedAt = canonicalTimestamp(this.now())

    try {
      this.db.exec('begin immediate')
      this.db.prepare(`
        insert into xiaogui_coding_checkpoint_state_v1
          (singleton_id, schema_version, state_json, state_digest, updated_at)
        values (1, 1, ?, ?, ?)
        on conflict(singleton_id) do update set
          schema_version = excluded.schema_version,
          state_json = excluded.state_json,
          state_digest = excluded.state_digest,
          updated_at = excluded.updated_at
      `).run(stateJson, stateDigest(stateJson), updatedAt)
      this.db.exec('commit')
    } catch (error) {
      rollbackQuietly(this.db)
      if (error instanceof CodingCheckpointStateStoreError) throw error
      throw new CodingCheckpointStateStoreError('CHECKPOINT_STATE_WRITE_FAILED')
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new CodingCheckpointStateStoreError('CHECKPOINT_STATE_STORE_CLOSED')
  }
}

function canonicalState(value: unknown): CodingCheckpointPersistedStateV1 {
  const input = record(value)
  if (input.schemaVersion !== 1) {
    if (typeof input.schemaVersion === 'number') {
      throw new CodingCheckpointStateStoreError('CHECKPOINT_STATE_VERSION_UNSUPPORTED')
    }
    corrupt()
  }

  const checkpointInputs = stateArray(input.checkpoints)
  const previewInputs = stateArray(input.previews)
  const sagaInputs = stateArray(input.sagas)
  const checkpoints = checkpointInputs.map(canonicalCheckpointRecord)
  const checkpointById = uniqueMap(checkpoints, (entry) => entry.checkpoint.checkpointId)
  const previews = previewInputs.map((entry) => canonicalPreviewRecord(entry, checkpointById))
  uniqueMap(previews, (entry) => entry.preview.previewId)
  const sagas = sagaInputs.map((entry) => canonicalSaga(entry, checkpointById))
  uniqueMap(sagas, (entry) => entry.restoreId)

  return { schemaVersion: 1, checkpoints, previews, sagas }
}

function canonicalCheckpointRecord(value: unknown): PrivateCheckpointRecordV1 {
  const input = record(value)
  schemaOne(input.schemaVersion)
  const checkpoint = canonicalCheckpoint(input.checkpoint)
  const binding = canonicalBinding(input.binding)
  const sessionTarget = canonicalSessionSnapshot(input.sessionTarget)
  const workspaceTarget = canonicalWorkspaceSnapshot(input.workspaceTarget)

  if (
    checkpoint.attemptId !== binding.attemptId
    || sessionTarget.attemptId !== binding.attemptId
    || sessionTarget.sessionId !== binding.sessionId
    || workspaceTarget.attemptId !== binding.attemptId
    || workspaceTarget.worktreeBindingDigest !== binding.worktreeBindingDigest
    || checkpoint.sessionCheckpointDigest !== sessionTarget.snapshotDigest
    || checkpoint.worktreeBaselineDigest !== workspaceTarget.baselineDigest
    || checkpoint.changeSummaryDigest !== workspaceTarget.changeSummaryDigest
  ) corrupt()

  return { schemaVersion: 1, checkpoint, binding, sessionTarget, workspaceTarget }
}

function canonicalPreviewRecord(
  value: unknown,
  checkpointById: ReadonlyMap<string, PrivateCheckpointRecordV1>,
): PrivateRestorePreviewRecordV1 {
  const input = record(value)
  schemaOne(input.schemaVersion)
  const preview = canonicalPreview(input.preview)
  const binding = canonicalBinding(input.binding)
  const checkpoint = checkpointById.get(preview.checkpointId)
  if (
    !checkpoint
    || preview.attemptId !== binding.attemptId
    || checkpoint.checkpoint.attemptId !== preview.attemptId
    || !sameBinding(checkpoint.binding, binding)
  ) corrupt()

  return {
    schemaVersion: 1,
    preview,
    binding,
    currentSessionDigest: digestValue(input.currentSessionDigest),
    currentWorkspaceDigest: digestValue(input.currentWorkspaceDigest),
    currentBaselineDigest: digestValue(input.currentBaselineDigest),
    currentChangeSummaryDigest: digestValue(input.currentChangeSummaryDigest),
    workspacePreviewChangeSummaryDigest: digestValue(input.workspacePreviewChangeSummaryDigest),
    changedRelativePathsDigest: digestValue(input.changedRelativePathsDigest),
  }
}

function canonicalSaga(
  value: unknown,
  checkpointById: ReadonlyMap<string, PrivateCheckpointRecordV1>,
): CodingCheckpointRestoreSagaV1 {
  const input = record(value)
  schemaOne(input.schemaVersion)
  const restoreId = safeId(input.restoreId)
  const attemptId = safeId(input.attemptId)
  const checkpointId = safeId(input.checkpointId)
  const binding = canonicalBinding(input.binding)
  const checkpoint = checkpointById.get(checkpointId)
  if (!checkpoint || attemptId !== binding.attemptId || !sameBinding(checkpoint.binding, binding)) corrupt()
  const phase = enumValue(input.phase, SAGA_PHASES) as CodingCheckpointRestoreSagaV1['phase']
  const rollbackSession = input.rollbackSession === undefined
    ? undefined
    : canonicalSessionSnapshot(input.rollbackSession)
  const rollbackWorkspace = input.rollbackWorkspace === undefined
    ? undefined
    : canonicalWorkspaceSnapshot(input.rollbackWorkspace)
  if (
    rollbackSession
    && (rollbackSession.attemptId !== attemptId || rollbackSession.sessionId !== binding.sessionId)
  ) corrupt()
  if (
    rollbackWorkspace
    && (
      rollbackWorkspace.attemptId !== attemptId
      || rollbackWorkspace.worktreeBindingDigest !== binding.worktreeBindingDigest
    )
  ) corrupt()

  return {
    schemaVersion: 1,
    restoreId,
    attemptId,
    checkpointId,
    binding,
    phase,
    ...(rollbackSession ? { rollbackSession } : {}),
    ...(rollbackWorkspace ? { rollbackWorkspace } : {}),
    updatedAt: nonNegativeInteger(input.updatedAt),
  }
}

function canonicalCheckpoint(value: unknown): CodingCheckpointV1 {
  const input = record(value)
  schemaOne(input.schemaVersion)
  return {
    schemaVersion: 1,
    checkpointId: safeId(input.checkpointId),
    attemptId: safeId(input.attemptId),
    sessionCheckpointDigest: digestValue(input.sessionCheckpointDigest),
    worktreeBaselineDigest: digestValue(input.worktreeBaselineDigest),
    changeSummaryDigest: digestValue(input.changeSummaryDigest),
    status: enumValue(input.status, CHECKPOINT_STATUSES) as CodingCheckpointV1['status'],
  }
}

function canonicalBinding(value: unknown): AttemptCheckpointBindingV1 {
  const input = record(value)
  return {
    attemptId: safeId(input.attemptId),
    sessionId: safeId(input.sessionId),
    worktreeBindingDigest: digestValue(input.worktreeBindingDigest),
    state: enumValue(input.state, ATTEMPT_STATES) as AttemptCheckpointBindingV1['state'],
    authorityStatus: enumValue(
      input.authorityStatus,
      ATTEMPT_AUTHORITY_STATUSES,
    ) as AttemptCheckpointBindingV1['authorityStatus'],
  }
}

function canonicalSessionSnapshot(value: unknown): PiSessionCheckpointSnapshotV1 {
  const input = record(value)
  return {
    attemptId: safeId(input.attemptId),
    sessionId: safeId(input.sessionId),
    snapshotRef: privateSnapshotRef(input.snapshotRef),
    snapshotDigest: digestValue(input.snapshotDigest),
  }
}

function canonicalWorkspaceSnapshot(value: unknown): AttemptWorkspaceCheckpointSnapshotV1 {
  const input = record(value)
  return {
    attemptId: safeId(input.attemptId),
    worktreeBindingDigest: digestValue(input.worktreeBindingDigest),
    snapshotRef: privateSnapshotRef(input.snapshotRef),
    snapshotDigest: digestValue(input.snapshotDigest),
    baselineDigest: digestValue(input.baselineDigest),
    changeSummaryDigest: digestValue(input.changeSummaryDigest),
  }
}

function canonicalPreview(value: unknown): CodingCheckpointRestorePreviewV1 {
  const input = record(value)
  schemaOne(input.schemaVersion)
  const changedRelativePaths = canonicalPreviewPaths(input.changedRelativePaths)
  const changeCount = nonNegativeInteger(input.changeCount)
  const truncated = booleanValue(input.truncated)
  if (
    changeCount < changedRelativePaths.length
    || truncated !== (changeCount > changedRelativePaths.length)
  ) corrupt()
  return {
    schemaVersion: 1,
    previewId: safeId(input.previewId),
    checkpointId: safeId(input.checkpointId),
    attemptId: safeId(input.attemptId),
    changedRelativePaths,
    changeCount,
    truncated,
    sessionImpact: exactString(
      input.sessionImpact,
      XIAOGUI_CODING_CHECKPOINT_SESSION_IMPACT_V1,
    ),
    previewDigest: digestValue(input.previewDigest),
    expiresAt: nonNegativeInteger(input.expiresAt),
  }
}

function canonicalPreviewPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_PUBLIC_PREVIEW_PATHS) corrupt()
  const paths: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (
      typeof item !== 'string'
      || item.length === 0
      || item.length > MAX_PUBLIC_PREVIEW_PATH_LENGTH
      || item.includes('\\')
      || item.includes(':')
      || item.includes('\0')
      || isAbsolute(item)
      || win32.isAbsolute(item)
    ) corrupt()
    const segments = item.split('/')
    if (
      segments.some((segment) => !segment || segment === '.' || segment === '..')
      || segments[0]?.toLowerCase() === '.git'
      || seen.has(item)
    ) corrupt()
    seen.add(item)
    paths.push(item)
  }
  return paths
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) corrupt()
  return value as Record<string, unknown>
}

function stateArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_STATE_ITEMS) corrupt()
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) corrupt()
  }
  return value
}

function uniqueMap<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    const itemKey = key(item)
    if (result.has(itemKey)) corrupt()
    result.set(itemKey, item)
  }
  return result
}

function schemaOne(value: unknown): void {
  if (value !== 1) corrupt()
}

function safeId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) corrupt()
  return value
}

function digestValue(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) corrupt()
  return value
}

function privateSnapshotRef(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 2_048
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
    || isAbsolute(value)
    || win32.isAbsolute(value)
    || value.toLowerCase().startsWith('file:')
  ) corrupt()
  return value
}

function enumValue(value: unknown, allowed: ReadonlySet<string>): string {
  if (typeof value !== 'string' || !allowed.has(value)) corrupt()
  return value
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) corrupt()
  return value
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') corrupt()
  return value
}

function exactString<T extends string>(value: unknown, expected: T): T {
  if (value !== expected) corrupt()
  return expected
}

function sameBinding(left: AttemptCheckpointBindingV1, right: AttemptCheckpointBindingV1): boolean {
  return left.attemptId === right.attemptId
    && left.sessionId === right.sessionId
    && left.worktreeBindingDigest === right.worktreeBindingDigest
    && left.state === right.state
    && left.authorityStatus === right.authorityStatus
}

function canonicalTimestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new CodingCheckpointStateStoreError('CHECKPOINT_STATE_WRITE_FAILED')
  }
  return value
}

function stateDigest(stateJson: string): string {
  return `sha256:${createHash('sha256').update(stateJson, 'utf8').digest('hex')}`
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('rollback')
  } catch {
    // No active transaction. The caller receives only a stable redacted error.
  }
}

function corrupt(): never {
  throw new CodingCheckpointStateStoreError('CHECKPOINT_STATE_CORRUPT')
}
