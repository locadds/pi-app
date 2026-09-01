import { isAbsolute, posix, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

const PROJECT_ID_PATTERN = /^xgp1_[a-f0-9]{64}$/i
const SESSION_KEY_PATTERN = /^xgs1_[a-f0-9]{64}$/i
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

export type CheckpointSessionBindingRegistryErrorCodeV1 =
  | 'CHECKPOINT_SESSION_REGISTRY_DB_PATH_REQUIRED'
  | 'CHECKPOINT_SESSION_REGISTRY_OPEN_FAILED'
  | 'CHECKPOINT_SESSION_REGISTRY_ADDRESS_INVALID'
  | 'CHECKPOINT_SESSION_REGISTRY_SESSION_ID_INVALID'
  | 'CHECKPOINT_SESSION_REGISTRY_SESSION_FILE_INVALID'
  | 'CHECKPOINT_SESSION_REGISTRY_ATTEMPT_ID_INVALID'
  | 'CHECKPOINT_SESSION_REGISTRY_ADDRESS_CONFLICT'
  | 'CHECKPOINT_SESSION_REGISTRY_ADDRESS_NOT_FOUND'
  | 'CHECKPOINT_SESSION_REGISTRY_ATTEMPT_CONFLICT'
  | 'CHECKPOINT_SESSION_REGISTRY_STATE_CORRUPT'
  | 'CHECKPOINT_SESSION_REGISTRY_READ_FAILED'
  | 'CHECKPOINT_SESSION_REGISTRY_WRITE_FAILED'
  | 'CHECKPOINT_SESSION_REGISTRY_CLOSED'

/** Stable Main-only error. The message never includes a session id or path. */
export class CheckpointSessionBindingRegistryErrorV1 extends Error {
  constructor(readonly code: CheckpointSessionBindingRegistryErrorCodeV1) {
    super(code)
    this.name = 'CheckpointSessionBindingRegistryErrorV1'
  }
}

export interface CheckpointSessionAddressRecordV1 {
  readonly address: SessionAddressV1
  readonly sourceSessionId: string
  /** Main-process-private. This value must never cross public IPC or receipts. */
  readonly sessionFile: string
}

export interface CheckpointAttemptSessionBindingV1 extends CheckpointSessionAddressRecordV1 {
  readonly attemptId: string
}

export interface CheckpointSessionBindingRegistryOptionsV1 {
  /** Main-process-private SQLite path. */
  readonly dbPath: string
  readonly now?: () => string
}

interface AddressRowV1 {
  readonly project_id: string
  readonly session_key: string
  readonly source_session_id: string
  readonly session_file: string
  readonly session_file_key: string
}

interface AttemptRowV1 extends AddressRowV1 {
  readonly attempt_id: string
}

/**
 * Private bridge from an opaque SessionAddress to the Pi session file used by
 * checkpoint capture. Neither the address records nor Attempt bindings have a
 * public projection.
 */
export class CheckpointSessionBindingRegistryV1 {
  private readonly db: DatabaseSync
  private readonly now: () => string
  private closed = false

  constructor(options: CheckpointSessionBindingRegistryOptionsV1) {
    if (!options?.dbPath) {
      throw new CheckpointSessionBindingRegistryErrorV1(
        'CHECKPOINT_SESSION_REGISTRY_DB_PATH_REQUIRED',
      )
    }
    this.now = options.now ?? (() => new Date().toISOString())
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(options.dbPath)
      database.exec('pragma busy_timeout = 5000')
      database.exec('pragma foreign_keys = on')
      database.exec(`
        create table if not exists xiaogui_coding_pi_session_address_v1 (
          project_id text not null,
          session_key text not null,
          source_session_id text not null unique,
          session_file text not null,
          session_file_key text not null unique,
          updated_at text not null,
          primary key (project_id, session_key)
        );
        create table if not exists xiaogui_coding_pi_attempt_address_binding_v1 (
          attempt_id text primary key,
        project_id text not null,
        session_key text not null,
        bound_at text not null,
        foreign key (project_id, session_key)
            references xiaogui_coding_pi_session_address_v1(project_id, session_key)
        );
      `)
    } catch {
      try {
        database?.close()
      } catch {
        // The caller receives only a stable redacted open error.
      }
      throw new CheckpointSessionBindingRegistryErrorV1(
        'CHECKPOINT_SESSION_REGISTRY_OPEN_FAILED',
      )
    }
    this.db = database
  }

  recordAddress(input: CheckpointSessionAddressRecordV1): void {
    this.assertOpen()
    const address = canonicalAddress(input?.address)
    const sourceSessionId = safeId(
      input?.sourceSessionId,
      'CHECKPOINT_SESSION_REGISTRY_SESSION_ID_INVALID',
    )
    const sessionFile = privateAbsolutePath(input?.sessionFile)
    const sessionFileKey = privatePathKey(sessionFile)
    const updatedAt = timestamp(this.now())

    try {
      this.db.exec('begin immediate')
      const existing = this.readAddressRow(address)
      if (existing) {
        if (
          existing.source_session_id !== sourceSessionId
          || existing.session_file_key !== sessionFileKey
        ) {
          conflict('CHECKPOINT_SESSION_REGISTRY_ADDRESS_CONFLICT')
        }
        this.db.exec('commit')
        return
      }

      const privateOwner = this.db.prepare(`
        select project_id, session_key, source_session_id, session_file, session_file_key
        from xiaogui_coding_pi_session_address_v1
        where source_session_id = ? or session_file_key = ?
        limit 1
      `).get(sourceSessionId, sessionFileKey) as unknown as AddressRowV1 | undefined
      if (privateOwner) conflict('CHECKPOINT_SESSION_REGISTRY_ADDRESS_CONFLICT')

      this.db.prepare(`
        insert into xiaogui_coding_pi_session_address_v1
          (project_id, session_key, source_session_id, session_file, session_file_key, updated_at)
        values (?, ?, ?, ?, ?, ?)
      `).run(
        address.projectId,
        address.sessionKey,
        sourceSessionId,
        sessionFile,
        sessionFileKey,
        updatedAt,
      )
      this.db.exec('commit')
    } catch (error) {
      rollbackQuietly(this.db)
      if (error instanceof CheckpointSessionBindingRegistryErrorV1) throw error
      throw new CheckpointSessionBindingRegistryErrorV1(
        'CHECKPOINT_SESSION_REGISTRY_WRITE_FAILED',
      )
    }
  }

  bindAttempt(attemptIdInput: string, addressInput: SessionAddressV1): CheckpointAttemptSessionBindingV1 {
    this.assertOpen()
    const attemptId = safeId(
      attemptIdInput,
      'CHECKPOINT_SESSION_REGISTRY_ATTEMPT_ID_INVALID',
    )
    const address = canonicalAddress(addressInput)
    const boundAt = timestamp(this.now())

    try {
      this.db.exec('begin immediate')
      const source = this.readAddressRow(address)
      if (!source) conflict('CHECKPOINT_SESSION_REGISTRY_ADDRESS_NOT_FOUND')

      const existingAttempt = this.readAttemptRow(attemptId)
      if (existingAttempt) {
        if (
          existingAttempt.project_id !== address.projectId
          || existingAttempt.session_key !== address.sessionKey
        ) {
          conflict('CHECKPOINT_SESSION_REGISTRY_ATTEMPT_CONFLICT')
        }
        this.db.exec('commit')
        return bindingFromRow(existingAttempt)
      }

      this.db.prepare(`
        insert into xiaogui_coding_pi_attempt_address_binding_v1
          (attempt_id, project_id, session_key, bound_at)
        values (?, ?, ?, ?)
      `).run(attemptId, address.projectId, address.sessionKey, boundAt)
      this.db.exec('commit')
      return {
        attemptId,
        address,
        sourceSessionId: source.source_session_id,
        sessionFile: source.session_file,
      }
    } catch (error) {
      rollbackQuietly(this.db)
      if (error instanceof CheckpointSessionBindingRegistryErrorV1) throw error
      throw new CheckpointSessionBindingRegistryErrorV1(
        'CHECKPOINT_SESSION_REGISTRY_WRITE_FAILED',
      )
    }
  }

  /**
   * Main-process-only reverse lookup used to revive the Pi Worker that owns an
   * opaque CODING address. The private session file must never be projected to
   * Renderer or copied into a public receipt.
   */
  readAddressBinding(addressInput: SessionAddressV1): CheckpointSessionAddressRecordV1 | null {
    this.assertOpen()
    const address = canonicalAddress(addressInput)
    try {
      const row = this.readAddressRow(address)
      return row ? addressRecordFromRow(row) : null
    } catch (error) {
      if (error instanceof CheckpointSessionBindingRegistryErrorV1) throw error
      throw new CheckpointSessionBindingRegistryErrorV1(
        'CHECKPOINT_SESSION_REGISTRY_READ_FAILED',
      )
    }
  }

  readAttemptBinding(attemptIdInput: string): CheckpointAttemptSessionBindingV1 | null {
    this.assertOpen()
    const attemptId = safeId(
      attemptIdInput,
      'CHECKPOINT_SESSION_REGISTRY_ATTEMPT_ID_INVALID',
    )
    try {
      const row = this.readAttemptRow(attemptId)
      return row ? bindingFromRow(row) : null
    } catch (error) {
      if (error instanceof CheckpointSessionBindingRegistryErrorV1) throw error
      throw new CheckpointSessionBindingRegistryErrorV1(
        'CHECKPOINT_SESSION_REGISTRY_READ_FAILED',
      )
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private readAddressRow(address: SessionAddressV1): AddressRowV1 | undefined {
    return this.db.prepare(`
      select project_id, session_key, source_session_id, session_file, session_file_key
      from xiaogui_coding_pi_session_address_v1
      where project_id = ? and session_key = ?
      limit 1
    `).get(address.projectId, address.sessionKey) as unknown as AddressRowV1 | undefined
  }

  private readAttemptRow(attemptId: string): AttemptRowV1 | undefined {
    const row = this.db.prepare(`
      select b.attempt_id, b.project_id, b.session_key,
             a.source_session_id, a.session_file, a.session_file_key
      from xiaogui_coding_pi_attempt_address_binding_v1 b
      left join xiaogui_coding_pi_session_address_v1 a
        on a.project_id = b.project_id and a.session_key = b.session_key
      where b.attempt_id = ?
      limit 1
    `).get(attemptId) as unknown as AttemptRowV1 | undefined
    if (row && (!row.source_session_id || !row.session_file || !row.session_file_key)) {
      throw new CheckpointSessionBindingRegistryErrorV1(
        'CHECKPOINT_SESSION_REGISTRY_STATE_CORRUPT',
      )
    }
    return row
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new CheckpointSessionBindingRegistryErrorV1(
        'CHECKPOINT_SESSION_REGISTRY_CLOSED',
      )
    }
  }
}

function bindingFromRow(row: AttemptRowV1): CheckpointAttemptSessionBindingV1 {
  return {
    attemptId: row.attempt_id,
    address: {
      projectId: row.project_id as SessionAddressV1['projectId'],
      sessionKey: row.session_key as SessionAddressV1['sessionKey'],
    },
    sourceSessionId: row.source_session_id,
    sessionFile: row.session_file,
  }
}

function addressRecordFromRow(row: AddressRowV1): CheckpointSessionAddressRecordV1 {
  return {
    address: {
      projectId: row.project_id as SessionAddressV1['projectId'],
      sessionKey: row.session_key as SessionAddressV1['sessionKey'],
    },
    sourceSessionId: row.source_session_id,
    sessionFile: row.session_file,
  }
}

function canonicalAddress(value: SessionAddressV1): SessionAddressV1 {
  if (
    !value
    || !PROJECT_ID_PATTERN.test(value.projectId)
    || !SESSION_KEY_PATTERN.test(value.sessionKey)
  ) {
    throw new CheckpointSessionBindingRegistryErrorV1(
      'CHECKPOINT_SESSION_REGISTRY_ADDRESS_INVALID',
    )
  }
  return { projectId: value.projectId, sessionKey: value.sessionKey }
}

function safeId<T extends string>(
  value: unknown,
  code: CheckpointSessionBindingRegistryErrorCodeV1,
): T {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    throw new CheckpointSessionBindingRegistryErrorV1(code)
  }
  return value as T
}

function privateAbsolutePath(value: unknown): string {
  if (typeof value !== 'string') invalidSessionFile()
  const path = value.trim()
  if (
    !path
    || path.length > 32_768
    || /[\u0000-\u001f\u007f]/.test(path)
    || (!isAbsolute(path) && !posix.isAbsolute(path) && !win32.isAbsolute(path))
  ) invalidSessionFile()
  return path
}

function privatePathKey(path: string): string {
  let key = path.replace(/\\/g, '/')
  if (key.startsWith('//')) key = `//${key.slice(2).replace(/\/+/g, '/')}`
  else key = key.replace(/\/+/g, '/')
  return win32.isAbsolute(path) ? key.toLowerCase() : key
}

function timestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new CheckpointSessionBindingRegistryErrorV1(
      'CHECKPOINT_SESSION_REGISTRY_WRITE_FAILED',
    )
  }
  return value
}

function invalidSessionFile(): never {
  throw new CheckpointSessionBindingRegistryErrorV1(
    'CHECKPOINT_SESSION_REGISTRY_SESSION_FILE_INVALID',
  )
}

function conflict(code: CheckpointSessionBindingRegistryErrorCodeV1): never {
  throw new CheckpointSessionBindingRegistryErrorV1(code)
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('rollback')
  } catch {
    // No active transaction. The caller receives only a stable redacted code.
  }
}
