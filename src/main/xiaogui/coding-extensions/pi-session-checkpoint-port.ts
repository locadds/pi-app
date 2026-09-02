import { randomBytes } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  PiSessionCheckpointPort,
  PiSessionCheckpointSnapshotV1,
} from './checkpoint-module'

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
const SNAPSHOT_REF_PATTERN = /^xgscp_[a-f0-9]{64}$/
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i

export interface PiSessionCheckpointWorkerGatewayV1 {
  inspectPiSessionCheckpoint(input: {
    readonly sessionFile: string
    readonly expectedSessionId: string
  }): Promise<{
    readonly sessionId: string
    readonly snapshotDigest: string
  }>
  capturePiSessionCheckpoint(input: {
    readonly sessionFile: string
    readonly expectedSessionId: string
    readonly snapshotRef: string
  }): Promise<{
    readonly sessionId: string
    readonly snapshotRef: string
    readonly snapshotDigest: string
  }>
  restorePiSessionCheckpoint(input: {
    readonly sessionFile: string
    readonly expectedSessionId: string
    readonly snapshotRef: string
    readonly expectedDigest: string
  }): Promise<{
    readonly sessionId: string
    readonly restoredSnapshotDigest: string
  }>
}

export interface PiSessionCheckpointPortOptionsV1 {
  readonly dbPath: string
  readonly worker: PiSessionCheckpointWorkerGatewayV1
  readonly snapshotRefFactory?: () => string
  readonly now?: () => string
}

export interface PiSessionAttemptBindingInputV1 {
  readonly attemptId: string
  readonly sessionId: string
  /** Main-process-private. This value must never cross public IPC. */
  readonly sessionFile: string
}

interface BindingRowV1 {
  readonly attempt_id: string
  readonly session_id: string
  readonly session_file: string
}

interface SnapshotRowV1 {
  readonly snapshot_ref: string
  readonly attempt_id: string
  readonly session_id: string
  readonly snapshot_digest: string
}

/**
 * Main-only Pi Session checkpoint Adapter.
 *
 * It persists the sensitive Attempt -> session-file binding and opaque snapshot
 * references in SQLite. Public checkpoint projections receive only ids and digests.
 */
export class PiSessionCheckpointPortV1 implements PiSessionCheckpointPort {
  private readonly db: DatabaseSync
  private readonly worker: PiSessionCheckpointWorkerGatewayV1
  private readonly snapshotRefFactory: () => string
  private readonly now: () => string

  constructor(options: PiSessionCheckpointPortOptionsV1) {
    if (!options?.dbPath) throw new Error('PI_SESSION_CHECKPOINT_DB_PATH_REQUIRED')
    this.worker = options.worker
    this.snapshotRefFactory = options.snapshotRefFactory
      ?? (() => `xgscp_${randomBytes(32).toString('hex')}`)
    this.now = options.now ?? (() => new Date().toISOString())
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec(`
      create table if not exists xiaogui_coding_pi_session_binding_v1 (
        attempt_id text primary key,
        session_id text not null,
        session_file text not null,
        updated_at text not null
      );
      create table if not exists xiaogui_coding_pi_session_snapshot_v1 (
        snapshot_ref text primary key,
        attempt_id text not null,
        session_id text not null,
        snapshot_digest text not null,
        created_at text not null
      );
    `)
  }

  bindAttempt(input: PiSessionAttemptBindingInputV1): void {
    assertSafeId(input?.attemptId, 'PI_SESSION_CHECKPOINT_ATTEMPT_ID_INVALID')
    assertSafeId(input?.sessionId, 'PI_SESSION_CHECKPOINT_SESSION_ID_INVALID')
    const sessionFile = privateAbsolutePath(input?.sessionFile)
    const existing = this.readBinding(input.attemptId)
    if (existing) {
      if (existing.session_id !== input.sessionId || existing.session_file !== sessionFile) {
        throw new Error('PI_SESSION_CHECKPOINT_BINDING_CONFLICT')
      }
      return
    }
    this.db.prepare(`
      insert into xiaogui_coding_pi_session_binding_v1
        (attempt_id, session_id, session_file, updated_at)
      values (?, ?, ?, ?)
    `).run(input.attemptId, input.sessionId, sessionFile, validTimestamp(this.now()))
  }

  async inspect(input: {
    attemptId: string
    sessionId: string
  }): Promise<Omit<PiSessionCheckpointSnapshotV1, 'snapshotRef'>> {
    const binding = this.requireBinding(input)
    const inspected = await this.worker.inspectPiSessionCheckpoint({
      sessionFile: binding.session_file,
      expectedSessionId: binding.session_id,
    })
    assertWorkerSession(inspected.sessionId, binding)
    assertDigest(inspected.snapshotDigest)
    return {
      attemptId: binding.attempt_id,
      sessionId: binding.session_id,
      snapshotDigest: inspected.snapshotDigest,
    }
  }

  async capture(input: {
    attemptId: string
    sessionId: string
  }): Promise<PiSessionCheckpointSnapshotV1> {
    const binding = this.requireBinding(input)
    const snapshotRef = this.snapshotRefFactory()
    assertSnapshotRef(snapshotRef)
    if (this.readSnapshot(snapshotRef)) throw new Error('PI_SESSION_CHECKPOINT_REF_CONFLICT')
    const captured = await this.worker.capturePiSessionCheckpoint({
      sessionFile: binding.session_file,
      expectedSessionId: binding.session_id,
      snapshotRef,
    })
    assertWorkerSession(captured.sessionId, binding)
    if (captured.snapshotRef !== snapshotRef) throw new Error('PI_SESSION_CHECKPOINT_REF_MISMATCH')
    assertDigest(captured.snapshotDigest)
    this.db.prepare(`
      insert into xiaogui_coding_pi_session_snapshot_v1
        (snapshot_ref, attempt_id, session_id, snapshot_digest, created_at)
      values (?, ?, ?, ?, ?)
    `).run(
      snapshotRef,
      binding.attempt_id,
      binding.session_id,
      captured.snapshotDigest,
      validTimestamp(this.now()),
    )
    return {
      attemptId: binding.attempt_id,
      sessionId: binding.session_id,
      snapshotRef,
      snapshotDigest: captured.snapshotDigest,
    }
  }

  async restore(input: {
    attemptId: string
    sessionId: string
    snapshotRef: string
    expectedDigest: string
  }): Promise<{
    attemptId: string
    sessionId: string
    restoredSnapshotDigest: string
  }> {
    const binding = this.requireBinding(input)
    assertSnapshotRef(input.snapshotRef)
    assertDigest(input.expectedDigest)
    const snapshot = this.readSnapshot(input.snapshotRef)
    if (!snapshot) throw new Error('PI_SESSION_CHECKPOINT_NOT_FOUND')
    if (
      snapshot.attempt_id !== binding.attempt_id
      || snapshot.session_id !== binding.session_id
      || snapshot.snapshot_digest !== input.expectedDigest
    ) throw new Error('PI_SESSION_CHECKPOINT_BINDING_MISMATCH')
    const restored = await this.worker.restorePiSessionCheckpoint({
      sessionFile: binding.session_file,
      expectedSessionId: binding.session_id,
      snapshotRef: input.snapshotRef,
      expectedDigest: input.expectedDigest,
    })
    assertWorkerSession(restored.sessionId, binding)
    if (restored.restoredSnapshotDigest !== input.expectedDigest) {
      throw new Error('PI_SESSION_CHECKPOINT_RESTORE_UNPROVEN')
    }
    return {
      attemptId: binding.attempt_id,
      sessionId: binding.session_id,
      restoredSnapshotDigest: restored.restoredSnapshotDigest,
    }
  }

  close(): void {
    this.db.close()
  }

  private requireBinding(input: { attemptId: string; sessionId: string }): BindingRowV1 {
    assertSafeId(input?.attemptId, 'PI_SESSION_CHECKPOINT_ATTEMPT_ID_INVALID')
    assertSafeId(input?.sessionId, 'PI_SESSION_CHECKPOINT_SESSION_ID_INVALID')
    const binding = this.readBinding(input.attemptId)
    if (!binding) throw new Error('PI_SESSION_CHECKPOINT_BINDING_NOT_FOUND')
    if (binding.session_id !== input.sessionId) throw new Error('PI_SESSION_CHECKPOINT_BINDING_MISMATCH')
    return binding
  }

  private readBinding(attemptId: string): BindingRowV1 | undefined {
    return this.db.prepare(`
      select attempt_id, session_id, session_file
      from xiaogui_coding_pi_session_binding_v1
      where attempt_id = ? limit 1
    `).get(attemptId) as unknown as BindingRowV1 | undefined
  }

  private readSnapshot(snapshotRef: string): SnapshotRowV1 | undefined {
    return this.db.prepare(`
      select snapshot_ref, attempt_id, session_id, snapshot_digest
      from xiaogui_coding_pi_session_snapshot_v1
      where snapshot_ref = ? limit 1
    `).get(snapshotRef) as unknown as SnapshotRowV1 | undefined
  }
}

function assertWorkerSession(sessionId: string, binding: BindingRowV1): void {
  if (sessionId !== binding.session_id) throw new Error('PI_SESSION_CHECKPOINT_BINDING_MISMATCH')
}

function assertSafeId(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) throw new Error(code)
}

function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error('PI_SESSION_CHECKPOINT_DIGEST_INVALID')
  }
}

function assertSnapshotRef(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SNAPSHOT_REF_PATTERN.test(value)) {
    throw new Error('PI_SESSION_CHECKPOINT_REF_INVALID')
  }
}

function privateAbsolutePath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('PI_SESSION_CHECKPOINT_SESSION_FILE_INVALID')
  const path = value.trim()
  if (!path || (!isAbsolute(path) && !win32.isAbsolute(path))) {
    throw new Error('PI_SESSION_CHECKPOINT_SESSION_FILE_INVALID')
  }
  return path
}

function validTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error('PI_SESSION_CHECKPOINT_TIMESTAMP_INVALID')
  return value
}
