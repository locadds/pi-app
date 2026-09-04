import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { CodingPermissionModeV1 } from '@shared/xiaogui-coding-permission'
import {
  XIAOGUI_DIRECT_CODING_SUBJECT_V2,
  type DirectCodingAuthorizationSubjectV2,
  type DirectCodingBeginResultV2,
  type DirectCodingCallStateV2,
  type DirectCodingCheckpointConfirmOutcomeV2,
  type DirectCodingCheckpointErrorCodeV2,
  type DirectCodingCheckpointListOutcomeV2,
  type DirectCodingCheckpointPreviewOutcomeV2,
  type DirectCodingFileCheckpointV2,
  type DirectCodingOperationV2,
  type DirectCodingPreflightResultV2,
  type DirectCodingSettleResultV2,
} from '@shared/xiaogui-direct-coding'

import type { DirectCodingAuthorizationPortV2 } from './coding-authorization-module'

const DIGEST = /^sha256:[0-9a-f]{64}$/
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,255}$/i
const PREVIEW_TTL_MS = 5 * 60_000

export interface DirectCodingPreflightInputV2 {
  readonly subject: DirectCodingAuthorizationSubjectV2
  readonly rootPath: string
  readonly sourceSessionId: string
  readonly toolCallId: string
  readonly requestDigest: string
  readonly operation: DirectCodingOperationV2
  readonly relativePath?: string
  readonly commandPreview?: string
  readonly commandDigest?: string
  readonly mode: CodingPermissionModeV1
}

export interface DirectCodingLifecycleInputV2 {
  readonly subject: DirectCodingAuthorizationSubjectV2
  readonly rootPath: string
  readonly sourceSessionId: string
  readonly toolCallId: string
  readonly requestDigest: string
}

export interface DirectCodingSettleInputV2 extends DirectCodingLifecycleInputV2 {
  readonly isError: boolean
  readonly exitCode?: number | null
}

interface CallRowV2 {
  project_id: string
  session_key: string
  source_session_id: string
  tool_call_id: string
  request_digest: string
  operation: DirectCodingOperationV2
  root_path: string
  root_real_path: string
  relative_path: string | null
  state: DirectCodingCallStateV2
  initial_digest: string | null
  checkpoint_token: string | null
  reason_code: string
}

interface CheckpointRowV2 {
  checkpoint_token: string
  project_id: string
  session_key: string
  tool_call_id: string
  root_path: string
  root_real_path: string
  relative_path: string
  existed_before: number
  before_blob: Uint8Array | null
  before_digest: string
  after_digest: string | null
  status: DirectCodingFileCheckpointV2['status']
  created_at: string
}

interface PathSnapshotV2 {
  readonly relativePath: string
  readonly absolutePath: string
  readonly rootRealPath: string
  readonly existed: boolean
  readonly bytes: Buffer | null
  readonly digest: string
}

export interface DirectCodingModuleOptionsV2 {
  readonly dbPath: string
  readonly authorization: DirectCodingAuthorizationPortV2
  readonly now?: () => string
  readonly token?: (prefix: 'xdcp' | 'xdpv') => string
}

/**
 * Deep Module for ordinary CODING authorization, file checkpoints and
 * idempotent tool lifecycle. TaskHub V1 reaches none of these tables or APIs.
 */
export class DirectCodingModuleV2 {
  private readonly db: DatabaseSync
  private readonly now: () => string
  private readonly token: (prefix: 'xdcp' | 'xdpv') => string

  constructor(private readonly options: DirectCodingModuleOptionsV2) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.token = options.token ?? ((prefix) => `${prefix}_${randomUUID()}`)
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec(`
      create table if not exists xiaogui_direct_coding_calls_v2 (
        project_id text not null,
        session_key text not null,
        source_session_id text not null,
        tool_call_id text not null,
        request_digest text not null,
        operation text not null,
        root_path text not null,
        root_real_path text not null,
        relative_path text,
        state text not null,
        initial_digest text,
        checkpoint_token text,
        command_digest text,
        exit_code integer,
        is_error integer,
        reason_code text not null,
        created_at text not null,
        updated_at text not null,
        primary key (session_key, tool_call_id)
      );
      create table if not exists xiaogui_direct_coding_checkpoints_v2 (
        checkpoint_token text primary key,
        project_id text not null,
        session_key text not null,
        tool_call_id text not null,
        root_path text not null,
        root_real_path text not null,
        relative_path text not null,
        existed_before integer not null,
        before_blob blob,
        before_digest text not null,
        after_digest text,
        status text not null,
        created_at text not null
      );
      create table if not exists xiaogui_direct_coding_previews_v2 (
        preview_token text primary key,
        checkpoint_token text not null,
        preview_digest text not null,
        expires_at text not null
      );
      create index if not exists xiaogui_direct_coding_checkpoints_session_v2
        on xiaogui_direct_coding_checkpoints_v2 (session_key, created_at);
    `)
    const updatedAt = this.now()
    this.db.prepare(`
      update xiaogui_direct_coding_calls_v2
      set state = 'OUTCOME_UNKNOWN', reason_code = 'PROCESS_INTERRUPTED', updated_at = ?
      where state in ('ALLOWED', 'EXECUTING')
    `).run(updatedAt)
    this.db.prepare(`
      update xiaogui_direct_coding_checkpoints_v2
      set status = 'OUTCOME_UNKNOWN'
      where checkpoint_token in (
        select checkpoint_token from xiaogui_direct_coding_calls_v2
        where state = 'OUTCOME_UNKNOWN' and checkpoint_token is not null
      )
    `).run()
    this.db.prepare(`
      update xiaogui_direct_coding_calls_v2
      set state = 'SETTLED', reason_code = 'PERMISSION_FLOW_INTERRUPTED', updated_at = ?
      where state = 'PENDING'
    `).run(updatedAt)
  }

  async preflight(input: DirectCodingPreflightInputV2): Promise<DirectCodingPreflightResultV2> {
    assertLifecycleInput(input)
    const existing = this.readCall(input.subject.address.sessionKey, input.toolCallId)
    if (existing) return this.duplicatePreflight(existing, input.requestDigest)

    let snapshot: PathSnapshotV2 | null = null
    try {
      snapshot = input.operation === 'BASH' || input.operation === 'DATA_EGRESS'
        ? null
        : inspectProjectPath(input.rootPath, requiredRelativePath(input), input.operation)
    } catch (error) {
      return denied(input, pathErrorCode(error))
    }

    const rootRealPath = snapshot?.rootRealPath ?? canonicalRoot(input.rootPath)
    const createdAt = this.now()
    this.db.prepare(`
      insert into xiaogui_direct_coding_calls_v2 (
        project_id, session_key, source_session_id, tool_call_id, request_digest,
        operation, root_path, root_real_path, relative_path, state,
        initial_digest, checkpoint_token, command_digest, exit_code, is_error,
        reason_code, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, null, ?, null, null, 'PENDING', ?, ?)
    `).run(
      input.subject.address.projectId,
      input.subject.address.sessionKey,
      input.sourceSessionId,
      input.toolCallId,
      input.requestDigest,
      input.operation,
      resolve(input.rootPath),
      rootRealPath,
      snapshot?.relativePath ?? null,
      snapshot?.digest ?? null,
      input.commandDigest ?? null,
      createdAt,
      createdAt,
    )

    const authorization = await this.options.authorization.decideDirect({
      subject: input.subject,
      requestDigest: input.requestDigest,
      operation: input.operation,
      mode: input.mode,
      existingFile: snapshot?.existed ?? false,
      ...(snapshot ? { relativePath: snapshot.relativePath } : {}),
      ...(input.commandPreview !== undefined ? { commandPreview: input.commandPreview } : {}),
    })
    if (authorization.decision !== 'ALLOW_ONCE') {
      this.setCallState(input.subject.address.sessionKey, input.toolCallId, 'SETTLED', 'USER_OR_POLICY_DENIED')
      return denied(input, 'USER_OR_POLICY_DENIED', 'SETTLED')
    }

    let checkpointToken: string | null = null
    if (snapshot && (input.operation === 'EDIT' || input.operation === 'WRITE')) {
      try {
        const current = inspectProjectPath(input.rootPath, snapshot.relativePath, input.operation)
        if (current.digest !== snapshot.digest || current.existed !== snapshot.existed) {
          this.setCallState(input.subject.address.sessionKey, input.toolCallId, 'OUTCOME_UNKNOWN', 'PATH_CHANGED_AFTER_AUTHORIZATION')
          return denied(input, 'PATH_CHANGED_AFTER_AUTHORIZATION', 'OUTCOME_UNKNOWN')
        }
        checkpointToken = this.token('xdcp')
        assertToken(checkpointToken)
        this.db.prepare(`
          insert into xiaogui_direct_coding_checkpoints_v2 (
            checkpoint_token, project_id, session_key, tool_call_id, root_path,
            root_real_path, relative_path, existed_before, before_blob,
            before_digest, after_digest, status, created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 'AVAILABLE', ?)
        `).run(
          checkpointToken,
          input.subject.address.projectId,
          input.subject.address.sessionKey,
          input.toolCallId,
          resolve(input.rootPath),
          current.rootRealPath,
          current.relativePath,
          current.existed ? 1 : 0,
          current.bytes,
          current.digest,
          this.now(),
        )
      } catch (error) {
        this.setCallState(input.subject.address.sessionKey, input.toolCallId, 'SETTLED', pathErrorCode(error))
        return denied(input, pathErrorCode(error), 'SETTLED')
      }
    }
    this.db.prepare(`
      update xiaogui_direct_coding_calls_v2
      set state = 'ALLOWED', checkpoint_token = ?, reason_code = 'ALLOWED', updated_at = ?
      where session_key = ? and tool_call_id = ? and state = 'PENDING'
    `).run(checkpointToken, this.now(), input.subject.address.sessionKey, input.toolCallId)
    return {
      kind: 'XIAOGUI_DIRECT_CODING_PREFLIGHT',
      subject: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
      decision: 'ALLOW',
      state: 'ALLOWED',
      requestDigest: input.requestDigest,
      reasonCode: authorization.reasonCode,
    }
  }

  begin(input: DirectCodingLifecycleInputV2): DirectCodingBeginResultV2 {
    assertLifecycleInput(input)
    const row = this.readCall(input.subject.address.sessionKey, input.toolCallId)
    if (!sameCall(row, input)) return beginDenied(input, row ? 'IDEMPOTENCY_KEY_CONFLICT' : 'CALL_NOT_FOUND')
    if (row.state !== 'ALLOWED') return beginDenied(input, row.state === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'DUPLICATE_EXECUTION')
    try {
      assertRootIdentity(row.root_path, row.root_real_path, input.rootPath)
      if (row.relative_path) {
        const current = inspectProjectPath(row.root_path, row.relative_path, row.operation)
        if (current.digest !== row.initial_digest) throw new Error('PATH_CHANGED_AFTER_AUTHORIZATION')
      }
    } catch (error) {
      this.markUnknown(row, pathErrorCode(error))
      return beginDenied(input, pathErrorCode(error))
    }
    const result = this.db.prepare(`
      update xiaogui_direct_coding_calls_v2
      set state = 'EXECUTING', reason_code = 'EXECUTING', updated_at = ?
      where session_key = ? and tool_call_id = ? and state = 'ALLOWED'
    `).run(this.now(), row.session_key, row.tool_call_id)
    if (Number(result.changes) !== 1) return beginDenied(input, 'DUPLICATE_EXECUTION')
    return {
      kind: 'XIAOGUI_DIRECT_CODING_BEGIN',
      subject: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
      decision: 'ALLOW',
      state: 'EXECUTING',
      requestDigest: input.requestDigest,
      reasonCode: 'EXECUTION_STARTED',
    }
  }

  settle(input: DirectCodingSettleInputV2): DirectCodingSettleResultV2 {
    assertLifecycleInput(input)
    const row = this.readCall(input.subject.address.sessionKey, input.toolCallId)
    if (!sameCall(row, input) || row.state === 'OUTCOME_UNKNOWN') return unknownSettle(input)
    if (row.state === 'SETTLED') {
      return {
        kind: 'XIAOGUI_DIRECT_CODING_SETTLED',
        subject: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
        state: 'SETTLED',
        requestDigest: input.requestDigest,
      }
    }
    if (row.state !== 'EXECUTING') {
      if (row.state === 'ALLOWED') this.markUnknown(row, 'EXECUTION_START_NOT_CONFIRMED')
      return unknownSettle(input)
    }
    try {
      assertRootIdentity(row.root_path, row.root_real_path, input.rootPath)
      if (row.checkpoint_token && row.relative_path) {
        const after = inspectProjectPath(row.root_path, row.relative_path, 'READ', { allowMissing: true })
        this.db.prepare(`
          update xiaogui_direct_coding_checkpoints_v2
          set after_digest = ?, status = 'AVAILABLE'
          where checkpoint_token = ?
        `).run(after.digest, row.checkpoint_token)
      }
      this.db.prepare(`
        update xiaogui_direct_coding_calls_v2
        set state = 'SETTLED', exit_code = ?, is_error = ?, reason_code = ?, updated_at = ?
        where session_key = ? and tool_call_id = ? and state = 'EXECUTING'
      `).run(
        input.exitCode ?? null,
        input.isError ? 1 : 0,
        input.isError ? 'TOOL_ERROR_SETTLED' : 'TOOL_SETTLED',
        this.now(),
        row.session_key,
        row.tool_call_id,
      )
      return {
        kind: 'XIAOGUI_DIRECT_CODING_SETTLED',
        subject: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
        state: 'SETTLED',
        requestDigest: input.requestDigest,
      }
    } catch {
      this.markUnknown(row, 'SETTLEMENT_FAILED')
      return unknownSettle(input)
    }
  }

  list(subject: DirectCodingAuthorizationSubjectV2): DirectCodingCheckpointListOutcomeV2 {
    assertSubject(subject)
    const rows = this.db.prepare(`
      select * from xiaogui_direct_coding_checkpoints_v2
      where project_id = ? and session_key = ?
        and (status <> 'AVAILABLE' or after_digest is not null)
      order by created_at asc
    `).all(subject.address.projectId, subject.address.sessionKey) as unknown as CheckpointRowV2[]
    const bound = rows.filter((row) => {
      try {
        assertRootIdentity(row.root_path, row.root_real_path, row.root_path)
        return true
      } catch {
        return false
      }
    })
    return success({ checkpoints: Object.freeze(bound.map(publicCheckpoint)) })
  }

  prepareRestore(
    subject: DirectCodingAuthorizationSubjectV2,
    currentRootPath: string,
    checkpointToken: string,
  ): DirectCodingCheckpointPreviewOutcomeV2 {
    assertSubject(subject)
    assertToken(checkpointToken)
    const row = this.readCheckpoint(checkpointToken)
    if (!row || row.project_id !== subject.address.projectId || row.session_key !== subject.address.sessionKey) {
      return failure('CHECKPOINT_NOT_FOUND')
    }
    if (row.status === 'OUTCOME_UNKNOWN') return failure('OUTCOME_UNKNOWN')
    if (row.status !== 'AVAILABLE' || !row.after_digest) return failure('CHECKPOINT_CONFLICT')
    try {
      assertRootIdentity(row.root_path, row.root_real_path, currentRootPath)
    } catch {
      return failure('CHECKPOINT_CONFLICT')
    }
    try {
      const current = inspectProjectPath(currentRootPath, row.relative_path, 'READ', { allowMissing: true })
      if (current.digest !== row.after_digest) return failure('CHECKPOINT_CONFLICT')
    } catch {
      return failure('CHECKPOINT_CONFLICT')
    }
    const previewToken = this.token('xdpv')
    assertToken(previewToken)
    const expiresAt = new Date(Date.parse(this.now()) + PREVIEW_TTL_MS).toISOString()
    const previewDigest = hashJson({
      domain: 'xiaogui.direct-coding.restore-preview.v2',
      checkpointToken,
      previewToken,
      relativePath: row.relative_path,
      beforeDigest: row.before_digest,
      afterDigest: row.after_digest,
      expiresAt,
    })
    this.db.prepare(`
      insert into xiaogui_direct_coding_previews_v2
        (preview_token, checkpoint_token, preview_digest, expires_at)
      values (?, ?, ?, ?)
    `).run(previewToken, checkpointToken, previewDigest, expiresAt)
    return success({
      preview: Object.freeze({
        schemaVersion: 2,
        checkpointToken,
        previewToken,
        previewDigest,
        relativePath: row.relative_path,
        action: row.existed_before === 1 ? 'RESTORE_PREVIOUS_BYTES' : 'REMOVE_CREATED_FILE',
        conversationEffect: 'UNCHANGED',
        expiresAt,
      }),
    })
  }

  confirmRestore(
    subject: DirectCodingAuthorizationSubjectV2,
    currentRootPath: string,
    input: { readonly checkpointToken: string; readonly previewToken: string; readonly previewDigest: string },
  ): DirectCodingCheckpointConfirmOutcomeV2 {
    assertSubject(subject)
    assertToken(input.checkpointToken)
    assertToken(input.previewToken)
    if (!DIGEST.test(input.previewDigest)) return failure('INVALID_REQUEST')
    const preview = this.db.prepare(`
      select checkpoint_token, preview_digest, expires_at
      from xiaogui_direct_coding_previews_v2 where preview_token = ? limit 1
    `).get(input.previewToken) as unknown as {
      checkpoint_token: string
      preview_digest: string
      expires_at: string
    } | undefined
    if (
      !preview ||
      preview.checkpoint_token !== input.checkpointToken ||
      preview.preview_digest !== input.previewDigest ||
      Date.parse(preview.expires_at) <= Date.parse(this.now())
    ) return failure('PREVIEW_STALE')
    const row = this.readCheckpoint(input.checkpointToken)
    if (!row || row.project_id !== subject.address.projectId || row.session_key !== subject.address.sessionKey) {
      return failure('CHECKPOINT_NOT_FOUND')
    }
    if (row.status === 'OUTCOME_UNKNOWN') return failure('OUTCOME_UNKNOWN')
    if (row.status !== 'AVAILABLE' || !row.after_digest) return failure('CHECKPOINT_CONFLICT')
    try {
      assertRootIdentity(row.root_path, row.root_real_path, currentRootPath)
    } catch {
      return failure('CHECKPOINT_CONFLICT')
    }
    try {
      const current = inspectProjectPath(currentRootPath, row.relative_path, 'READ', { allowMissing: true })
      if (current.digest !== row.after_digest) return failure('CHECKPOINT_CONFLICT')
      if (current.existed && statSync(current.absolutePath).nlink > 1) return failure('CHECKPOINT_CONFLICT')
      if (row.existed_before === 1) {
        if (!row.before_blob) return failure('RESTORE_FAILED')
        const beforeBytes = Buffer.from(row.before_blob)
        if (hashBytes(beforeBytes) !== row.before_digest) return failure('RESTORE_FAILED')
        mkdirSync(dirname(current.absolutePath), { recursive: true })
        replaceFileBytesAtomically(current.absolutePath, beforeBytes)
      } else if (existsSync(current.absolutePath)) {
        rmSync(current.absolutePath, { force: true })
      }
      const restored = inspectProjectPath(currentRootPath, row.relative_path, 'READ', {
        allowMissing: row.existed_before !== 1,
      })
      if (restored.digest !== row.before_digest) return failure('RESTORE_FAILED')
      this.db.prepare(`
        update xiaogui_direct_coding_checkpoints_v2 set status = 'RESTORED'
        where checkpoint_token = ? and status = 'AVAILABLE'
      `).run(input.checkpointToken)
      this.db.prepare('delete from xiaogui_direct_coding_previews_v2 where checkpoint_token = ?')
        .run(input.checkpointToken)
      return success({ checkpoint: publicCheckpoint({ ...row, status: 'RESTORED' }) })
    } catch {
      return failure('RESTORE_FAILED')
    }
  }

  close(): void {
    this.db.close()
  }

  private readCall(sessionKey: string, toolCallId: string): CallRowV2 | undefined {
    return this.db.prepare(`
      select project_id, session_key, source_session_id, tool_call_id,
        request_digest, operation, root_path, root_real_path, relative_path,
        state, initial_digest, checkpoint_token, reason_code
      from xiaogui_direct_coding_calls_v2
      where session_key = ? and tool_call_id = ? limit 1
    `).get(sessionKey, toolCallId) as unknown as CallRowV2 | undefined
  }

  private readCheckpoint(checkpointToken: string): CheckpointRowV2 | undefined {
    return this.db.prepare(`
      select checkpoint_token, project_id, session_key, tool_call_id, root_path,
        root_real_path, relative_path, existed_before, before_blob, before_digest,
        after_digest, status, created_at
      from xiaogui_direct_coding_checkpoints_v2 where checkpoint_token = ? limit 1
    `).get(checkpointToken) as unknown as CheckpointRowV2 | undefined
  }

  private duplicatePreflight(row: CallRowV2, requestDigest: string): DirectCodingPreflightResultV2 {
    const sameDigest = row.request_digest === requestDigest
    return {
      kind: 'XIAOGUI_DIRECT_CODING_PREFLIGHT',
      subject: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
      decision: 'DENY',
      state: sameDigest ? row.state : 'OUTCOME_UNKNOWN',
      requestDigest,
      reasonCode: sameDigest ? 'DUPLICATE_REQUEST_NOT_REPLAYED' : 'IDEMPOTENCY_KEY_CONFLICT',
    }
  }

  private setCallState(sessionKey: string, toolCallId: string, state: DirectCodingCallStateV2, reason: string): void {
    this.db.prepare(`
      update xiaogui_direct_coding_calls_v2 set state = ?, reason_code = ?, updated_at = ?
      where session_key = ? and tool_call_id = ?
    `).run(state, reason, this.now(), sessionKey, toolCallId)
  }

  private markUnknown(row: CallRowV2, reason: string): void {
    this.setCallState(row.session_key, row.tool_call_id, 'OUTCOME_UNKNOWN', reason)
    if (row.checkpoint_token) {
      this.db.prepare(`
        update xiaogui_direct_coding_checkpoints_v2 set status = 'OUTCOME_UNKNOWN'
        where checkpoint_token = ?
      `).run(row.checkpoint_token)
    }
  }
}

export function inspectProjectPath(
  rootPath: string,
  rawRelativePath: string,
  operation: DirectCodingOperationV2,
  options: { readonly allowMissing?: boolean } = {},
): PathSnapshotV2 {
  const relativePath = normalizeRelativePath(rawRelativePath)
  const rootAbsolute = resolve(rootPath)
  const rootRealPath = canonicalRoot(rootAbsolute)
  const absolutePath = resolve(rootAbsolute, ...relativePath.split('/'))
  if (!inside(rootAbsolute, absolutePath)) throw new Error('PATH_OUTSIDE_PROJECT')

  const segments = relativePath.split('/')
  let cursor = rootAbsolute
  for (let index = 0; index < segments.length; index += 1) {
    cursor = resolve(cursor, segments[index])
    if (!existsSync(cursor)) break
    const info = lstatSync(cursor)
    if (info.isSymbolicLink()) throw new Error('PATH_LINK_REJECTED')
    const real = realpathSync.native(cursor)
    if (!inside(rootRealPath, real)) throw new Error('PATH_LINK_REJECTED')
  }

  const existed = existsSync(absolutePath)
  if (existed) {
    const info = lstatSync(absolutePath)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('PATH_TYPE_REJECTED')
    const real = realpathSync.native(absolutePath)
    if (!inside(rootRealPath, real)) throw new Error('PATH_LINK_REJECTED')
    const stats = statSync(absolutePath)
    if ((operation === 'EDIT' || operation === 'WRITE') && stats.nlink > 1) {
      throw new Error('PATH_HARDLINK_REJECTED')
    }
    const bytes = readFileSync(absolutePath)
    return { relativePath, absolutePath, rootRealPath, existed: true, bytes, digest: hashBytes(bytes) }
  }
  if (operation === 'EDIT' || (operation === 'READ' && !options.allowMissing)) {
    throw new Error('PATH_NOT_FOUND')
  }
  let parent = dirname(absolutePath)
  while (!existsSync(parent)) {
    const next = dirname(parent)
    if (next === parent) throw new Error('PATH_PARENT_INVALID')
    parent = next
  }
  const parentInfo = lstatSync(parent)
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error('PATH_LINK_REJECTED')
  const parentReal = realpathSync.native(parent)
  if (!inside(rootRealPath, parentReal)) throw new Error('PATH_LINK_REJECTED')
  return {
    relativePath,
    absolutePath,
    rootRealPath,
    existed: false,
    bytes: null,
    digest: missingDigest(),
  }
}

function normalizeRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\0') ||
    isAbsolute(value) ||
    /^[a-z]:/i.test(value)
  ) throw new Error('PATH_INVALID')
  const segments = value.replace(/\\/g, '/').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) {
    throw new Error('PATH_INVALID')
  }
  return segments.join('/')
}

function canonicalRoot(rootPath: string): string {
  const absolute = resolve(rootPath)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error('PROJECT_ROOT_MISSING')
  const info = lstatSync(absolute)
  if (info.isSymbolicLink()) throw new Error('PROJECT_ROOT_LINK_REJECTED')
  return realpathSync.native(absolute)
}

function assertRootIdentity(storedRoot: string, storedReal: string, suppliedRoot: string): void {
  if (resolve(storedRoot) !== resolve(suppliedRoot) || canonicalRoot(suppliedRoot) !== storedReal) {
    throw new Error('PROJECT_IDENTITY_CHANGED')
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function requiredRelativePath(input: DirectCodingPreflightInputV2): string {
  if (!input.relativePath) throw new Error('PATH_REQUIRED')
  return input.relativePath
}

function assertSubject(subject: DirectCodingAuthorizationSubjectV2): void {
  if (
    subject?.schemaVersion !== 2 ||
    subject.kind !== XIAOGUI_DIRECT_CODING_SUBJECT_V2 ||
    !/^xgp1_[0-9a-f]{64}$/.test(subject.address?.projectId) ||
    !/^xgs1_[0-9a-f]{64}$/.test(subject.address?.sessionKey)
  ) throw new Error('DIRECT_CODING_SUBJECT_INVALID')
}

function assertLifecycleInput(input: DirectCodingLifecycleInputV2): void {
  assertSubject(input.subject)
  if (!SAFE_ID.test(input.sourceSessionId) || !SAFE_ID.test(input.toolCallId) || !DIGEST.test(input.requestDigest)) {
    throw new Error('DIRECT_CODING_REQUEST_INVALID')
  }
}

function assertToken(value: string): void {
  if (!/^(?:xdcp|xdpv)_[a-z0-9-]{8,80}$/i.test(value)) throw new Error('DIRECT_CODING_TOKEN_INVALID')
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function missingDigest(): string {
  return hashBytes(Buffer.from('xiaogui.direct-coding.missing.v2'))
}

function replaceFileBytesAtomically(targetPath: string, bytes: Buffer): void {
  const temporaryPath = resolve(
    dirname(targetPath),
    `.xiaogui-direct-restore-${process.pid}-${randomUUID()}.tmp`,
  )
  try {
    writeFileSync(temporaryPath, bytes, { flag: 'wx' })
    renameSync(temporaryPath, targetPath)
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // Nothing to clean up, or cleanup itself is unavailable.
    }
    throw error
  }
}

function hashJson(value: unknown): string {
  return hashBytes(Buffer.from(JSON.stringify(value), 'utf8'))
}

function pathErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : 'PATH_REJECTED'
  return /^[A-Z0-9_]{3,80}$/.test(code) ? code : 'PATH_REJECTED'
}

function sameCall(row: CallRowV2 | undefined, input: DirectCodingLifecycleInputV2): row is CallRowV2 {
  return !!row &&
    row.project_id === input.subject.address.projectId &&
    row.session_key === input.subject.address.sessionKey &&
    row.source_session_id === input.sourceSessionId &&
    row.request_digest === input.requestDigest &&
    resolve(row.root_path) === resolve(input.rootPath)
}

function denied(
  input: Pick<DirectCodingPreflightInputV2, 'requestDigest'>,
  reasonCode: string,
  state: DirectCodingCallStateV2 = 'SETTLED',
): DirectCodingPreflightResultV2 {
  return {
    kind: 'XIAOGUI_DIRECT_CODING_PREFLIGHT',
    subject: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
    decision: 'DENY',
    state,
    requestDigest: input.requestDigest,
    reasonCode,
  }
}

function beginDenied(input: DirectCodingLifecycleInputV2, reasonCode: string): DirectCodingBeginResultV2 {
  return {
    kind: 'XIAOGUI_DIRECT_CODING_BEGIN',
    subject: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
    decision: 'DENY',
    state: 'OUTCOME_UNKNOWN',
    requestDigest: input.requestDigest,
    reasonCode,
  }
}

function unknownSettle(input: DirectCodingSettleInputV2): DirectCodingSettleResultV2 {
  return {
    kind: 'XIAOGUI_DIRECT_CODING_SETTLED',
    subject: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
    state: 'OUTCOME_UNKNOWN',
    requestDigest: input.requestDigest,
  }
}

function publicCheckpoint(row: CheckpointRowV2): DirectCodingFileCheckpointV2 {
  return Object.freeze({
    schemaVersion: 2,
    subject: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
    checkpointToken: row.checkpoint_token,
    toolCallId: row.tool_call_id,
    relativePath: row.relative_path,
    existedBefore: row.existed_before === 1,
    beforeDigest: row.before_digest,
    afterDigest: row.after_digest,
    status: row.status,
    createdAt: row.created_at,
  })
}

function success<T extends object>(value: T) {
  return {
    ok: true as const,
    value: {
      contractVersion: '2.0.0' as const,
      ...value,
    },
  }
}

function failure(code: DirectCodingCheckpointErrorCodeV2) {
  return {
    ok: false as const,
    error: { code, messageKey: `xiaogui.coding.direct.checkpoint.${code.toLowerCase()}` },
  }
}
