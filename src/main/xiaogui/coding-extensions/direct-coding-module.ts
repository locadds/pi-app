import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  promises as fs,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { CodingPermissionModeV1 } from '@shared/xiaogui-coding-permission'
import {
  XIAOGUI_DIRECT_CODING_SUBJECT_V2,
  hasUnsafeDirectCodingCommandTextV1,
  type DirectCodingAuthorizationSubjectV2,
  type DirectCodingBeginResultV4,
  type DirectCodingCallStateV2,
  type DirectCodingCheckpointConfirmOutcomeV2,
  type DirectCodingCheckpointErrorCodeV2,
  type DirectCodingCheckpointListOutcomeV2,
  type DirectCodingCheckpointPreviewOutcomeV2,
  type DirectCodingFileCheckpointV2,
  type DirectCodingOperationV2,
  type DirectCodingPermissionOriginV3,
  type DirectCodingPreflightResultV4,
  type DirectCodingSettleResultV2,
} from '@shared/xiaogui-direct-coding'

import type { DirectCodingAuthorizationPortV2 } from './coding-authorization-module'
import { readProjectRootIdentityV2 } from '../../project-root-identity'

const DIGEST = /^sha256:[0-9a-f]{64}$/
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,255}$/i
const PREVIEW_TTL_MS = 5 * 60_000
const CHECKPOINT_MAX_BYTES = 16 * 1024 * 1024

export interface DirectCodingPreflightInputV4 {
  readonly subject: DirectCodingAuthorizationSubjectV2
  readonly rootPath: string
  readonly sourceSessionId: string
  readonly toolCallId: string
  readonly requestDigest: string
  readonly operation: DirectCodingOperationV2
  readonly path?: string
  readonly commandText?: string
  readonly commandDigest?: string
  readonly mode: CodingPermissionModeV1
  readonly origin: DirectCodingPermissionOriginV3
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
  root_identity_digest: string | null
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
  root_identity_digest: string | null
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

interface PathMetadataV2 {
  readonly rootPath: string
  readonly relativePath: string
  readonly absolutePath: string
  readonly rootRealPath: string
  readonly rootIdentityDigest: string
  readonly existed: boolean
  readonly size: number
  readonly entityDigest: string | null
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
        root_identity_digest text,
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
        root_identity_digest text,
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
    ensureColumn(this.db, 'xiaogui_direct_coding_calls_v2', 'root_identity_digest', 'text')
    ensureColumn(this.db, 'xiaogui_direct_coding_checkpoints_v2', 'root_identity_digest', 'text')
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

  async preflight(input: DirectCodingPreflightInputV4): Promise<DirectCodingPreflightResultV4> {
    assertLifecycleInput(input)
    const existing = this.readCall(input.subject.address.sessionKey, input.toolCallId)
    if (existing) return this.duplicatePreflight(existing, input.requestDigest)

    let metadata: PathMetadataV2 | null = null
    try {
      metadata = input.operation === 'BASH' || input.operation === 'DATA_EGRESS'
        ? null
        : await inspectProjectPathMetadata(input.rootPath, requiredPath(input), input.operation)
      if (input.operation === 'BASH') assertCommand(input.commandText, input.commandDigest)
    } catch (error) {
      return denied(input, pathErrorCode(error))
    }

    const rootIdentity = readProjectRootIdentityV2(input.rootPath)
    const rootRealPath = metadata?.rootRealPath ?? rootIdentity.canonicalRoot
    const rootIdentityDigest = metadata?.rootIdentityDigest ?? rootIdentity.digest
    const createdAt = this.now()
    this.db.prepare(`
      insert into xiaogui_direct_coding_calls_v2 (
        project_id, session_key, source_session_id, tool_call_id, request_digest,
        operation, root_path, root_real_path, root_identity_digest, relative_path, state,
        initial_digest, checkpoint_token, command_digest, exit_code, is_error,
        reason_code, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, null, ?, null, null, 'PENDING', ?, ?)
    `).run(
      input.subject.address.projectId,
      input.subject.address.sessionKey,
      input.sourceSessionId,
      input.toolCallId,
      input.requestDigest,
      input.operation,
      resolve(input.rootPath),
      rootRealPath,
      rootIdentityDigest,
      metadata?.relativePath ?? null,
      null,
      input.commandDigest ?? null,
      createdAt,
      createdAt,
    )

    const authorization = await this.options.authorization.decideDirect({
      subject: input.subject,
      requestDigest: input.requestDigest,
      operation: input.operation,
      mode: input.mode,
      existingFile: metadata?.existed ?? false,
      ...(metadata ? { relativePath: metadata.relativePath } : {}),
      ...(input.commandText !== undefined ? { commandText: input.commandText } : {}),
      origin: input.origin,
    })
    if (authorization.decision !== 'ALLOW_ONCE') {
      this.setCallState(input.subject.address.sessionKey, input.toolCallId, 'SETTLED', 'USER_OR_POLICY_DENIED')
      return denied(input, 'USER_OR_POLICY_DENIED', 'SETTLED')
    }

    let checkpointToken: string | null = null
    if (metadata && (input.operation === 'EDIT' || input.operation === 'WRITE')) {
      try {
        const current = await captureCheckpointSnapshot(metadata, input.operation)
        checkpointToken = this.token('xdcp')
        assertToken(checkpointToken)
        this.db.prepare(`
          insert into xiaogui_direct_coding_checkpoints_v2 (
            checkpoint_token, project_id, session_key, tool_call_id, root_path,
            root_real_path, root_identity_digest, relative_path, existed_before, before_blob,
            before_digest, after_digest, status, created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 'AVAILABLE', ?)
        `).run(
          checkpointToken,
          input.subject.address.projectId,
          input.subject.address.sessionKey,
          input.toolCallId,
          resolve(input.rootPath),
          current.rootRealPath,
          rootIdentityDigest,
          current.relativePath,
          current.existed ? 1 : 0,
          current.bytes,
          current.digest,
          this.now(),
        )
        this.db.prepare(`
          update xiaogui_direct_coding_calls_v2
          set initial_digest = ? where session_key = ? and tool_call_id = ?
        `).run(current.digest, input.subject.address.sessionKey, input.toolCallId)
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
      ...(metadata ? { authorizedRelativePath: metadata.relativePath } : {}),
    }
  }

  async begin(input: DirectCodingLifecycleInputV2): Promise<DirectCodingBeginResultV4> {
    assertLifecycleInput(input)
    const row = this.readCall(input.subject.address.sessionKey, input.toolCallId)
    if (!sameCall(row, input)) return beginDenied(input, row ? 'IDEMPOTENCY_KEY_CONFLICT' : 'CALL_NOT_FOUND')
    if (row.state !== 'ALLOWED') return beginDenied(input, row.state === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'DUPLICATE_EXECUTION')
    try {
      assertRootIdentity(row.root_path, row.root_real_path, row.root_identity_digest, input.rootPath)
      if (row.relative_path) {
        const current = await inspectProjectPathMetadata(row.root_path, row.relative_path, row.operation)
        if (row.operation === 'EDIT' || row.operation === 'WRITE') {
          const digest = await digestPath(current)
          if (digest !== row.initial_digest) throw new Error('PATH_CHANGED_AFTER_AUTHORIZATION')
        }
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
      ...(row.relative_path ? { authorizedRelativePath: row.relative_path } : {}),
    }
  }

  async settle(input: DirectCodingSettleInputV2): Promise<DirectCodingSettleResultV2> {
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
      assertRootIdentity(row.root_path, row.root_real_path, row.root_identity_digest, input.rootPath)
      if (row.checkpoint_token && row.relative_path) {
        const after = await inspectProjectPathMetadata(row.root_path, row.relative_path, 'READ', { allowMissing: true })
        const afterDigest = await digestPath(after)
        this.db.prepare(`
          update xiaogui_direct_coding_checkpoints_v2
          set after_digest = ?, status = 'AVAILABLE'
          where checkpoint_token = ?
        `).run(afterDigest, row.checkpoint_token)
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
        assertRootIdentity(row.root_path, row.root_real_path, row.root_identity_digest, row.root_path)
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
      assertRootIdentity(row.root_path, row.root_real_path, row.root_identity_digest, currentRootPath)
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
      assertRootIdentity(row.root_path, row.root_real_path, row.root_identity_digest, currentRootPath)
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
        request_digest, operation, root_path, root_real_path, root_identity_digest, relative_path,
        state, initial_digest, checkpoint_token, reason_code
      from xiaogui_direct_coding_calls_v2
      where session_key = ? and tool_call_id = ? limit 1
    `).get(sessionKey, toolCallId) as unknown as CallRowV2 | undefined
  }

  private readCheckpoint(checkpointToken: string): CheckpointRowV2 | undefined {
    return this.db.prepare(`
      select checkpoint_token, project_id, session_key, tool_call_id, root_path,
        root_real_path, root_identity_digest, relative_path, existed_before, before_blob, before_digest,
        after_digest, status, created_at
      from xiaogui_direct_coding_checkpoints_v2 where checkpoint_token = ? limit 1
    `).get(checkpointToken) as unknown as CheckpointRowV2 | undefined
  }

  private duplicatePreflight(row: CallRowV2, requestDigest: string): DirectCodingPreflightResultV4 {
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
  const rootAbsolute = resolve(rootPath)
  const { relativePath, absolutePath } = resolveProjectTarget(rootAbsolute, rawRelativePath)
  const rootRealPath = canonicalRoot(rootAbsolute)

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
    if (stats.size > CHECKPOINT_MAX_BYTES) throw new Error('CHECKPOINT_FILE_TOO_LARGE')
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

async function inspectProjectPathMetadata(
  rootPath: string,
  rawPath: string,
  operation: DirectCodingOperationV2,
  options: { readonly allowMissing?: boolean } = {},
): Promise<PathMetadataV2> {
  const rootAbsolute = resolve(rootPath)
  const rootIdentity = readProjectRootIdentityV2(rootAbsolute)
  const { relativePath, absolutePath } = resolveProjectTarget(rootAbsolute, rawPath)
  const segments = relativePath.split('/')
  let cursor = rootAbsolute
  for (const segment of segments) {
    cursor = resolve(cursor, segment)
    let info
    try {
      info = await fs.lstat(cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
    if (info.isSymbolicLink()) throw new Error('PATH_LINK_REJECTED')
    const real = await fs.realpath(cursor)
    if (!inside(rootIdentity.canonicalRoot, pathKey(real))) throw new Error('PATH_LINK_REJECTED')
  }

  let info
  try {
    info = await fs.lstat(absolutePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (info) {
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('PATH_TYPE_REJECTED')
    const real = await fs.realpath(absolutePath)
    if (!inside(rootIdentity.canonicalRoot, pathKey(real))) throw new Error('PATH_LINK_REJECTED')
    const stats = await fs.stat(absolutePath, { bigint: true })
    if ((operation === 'EDIT' || operation === 'WRITE') && stats.nlink > 1n) {
      throw new Error('PATH_HARDLINK_REJECTED')
    }
    const size = Number(stats.size)
    if (!Number.isSafeInteger(size)) throw new Error('CHECKPOINT_FILE_TOO_LARGE')
    return {
      rootPath: rootAbsolute,
      relativePath,
      absolutePath,
      rootRealPath: rootIdentity.canonicalRoot,
      rootIdentityDigest: rootIdentity.digest,
      existed: true,
      size,
      entityDigest: fileEntityDigest(stats),
    }
  }
  if (operation === 'EDIT' || (operation === 'READ' && !options.allowMissing)) {
    throw new Error('PATH_NOT_FOUND')
  }
  let parent = dirname(absolutePath)
  while (true) {
    try {
      const parentInfo = await fs.lstat(parent)
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error('PATH_LINK_REJECTED')
      const parentReal = await fs.realpath(parent)
      if (!inside(rootIdentity.canonicalRoot, pathKey(parentReal))) throw new Error('PATH_LINK_REJECTED')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const next = dirname(parent)
      if (next === parent) throw new Error('PATH_PARENT_INVALID')
      parent = next
    }
  }
  return {
    rootPath: rootAbsolute,
    relativePath,
    absolutePath,
    rootRealPath: rootIdentity.canonicalRoot,
    rootIdentityDigest: rootIdentity.digest,
    existed: false,
    size: 0,
    entityDigest: null,
  }
}

async function captureCheckpointSnapshot(
  expected: PathMetadataV2,
  operation: DirectCodingOperationV2,
): Promise<PathSnapshotV2> {
  const before = await inspectProjectPathMetadata(expected.rootPath, expected.relativePath, operation)
  if (
    before.rootIdentityDigest !== expected.rootIdentityDigest ||
    before.existed !== expected.existed ||
    before.entityDigest !== expected.entityDigest ||
    before.size !== expected.size
  ) {
    throw new Error('PATH_CHANGED_AFTER_AUTHORIZATION')
  }
  if (!before.existed) {
    return {
      relativePath: before.relativePath,
      absolutePath: before.absolutePath,
      rootRealPath: before.rootRealPath,
      existed: false,
      bytes: null,
      digest: missingDigest(),
    }
  }
  if (before.size > CHECKPOINT_MAX_BYTES) throw new Error('CHECKPOINT_FILE_TOO_LARGE')
  let bytes: Buffer
  try {
    bytes = await fs.readFile(before.absolutePath)
  } catch {
    throw new Error('CHECKPOINT_CAPTURE_FAILED')
  }
  const after = await inspectProjectPathMetadata(expected.rootPath, expected.relativePath, operation)
  if (!after.existed || before.entityDigest !== after.entityDigest || bytes.byteLength !== after.size) {
    throw new Error('PATH_CHANGED_AFTER_AUTHORIZATION')
  }
  return {
    relativePath: before.relativePath,
    absolutePath: before.absolutePath,
    rootRealPath: before.rootRealPath,
    existed: true,
    bytes,
    digest: hashBytes(bytes),
  }
}

async function digestPath(metadata: PathMetadataV2): Promise<string> {
  if (!metadata.existed) return missingDigest()
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(metadata.absolutePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', rejectPromise)
    stream.once('end', resolvePromise)
  })
  const after = await inspectProjectPathMetadata(
    metadata.rootPath,
    metadata.relativePath,
    'READ',
  ).catch(() => null)
  if (!after || !after.existed || after.entityDigest !== metadata.entityDigest) {
    throw new Error('PATH_CHANGED_AFTER_AUTHORIZATION')
  }
  return `sha256:${hash.digest('hex')}`
}

function resolveProjectTarget(rootPath: string, value: string): {
  readonly relativePath: string
  readonly absolutePath: string
} {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\0')
  ) throw new Error('PATH_INVALID')
  const rootAbsolute = resolve(rootPath)
  const absolutePath = isAbsolute(value) || /^[a-z]:[\\/]/i.test(value)
    ? resolve(value)
    : resolve(rootAbsolute, value)
  if (!inside(rootAbsolute, absolutePath)) throw new Error('PATH_OUTSIDE_PROJECT')
  const relativePath = relative(rootAbsolute, absolutePath).replace(/\\/g, '/')
  const segments = relativePath.split('/')
  if (!relativePath || segments.some((segment) => !segment || segment === '..' || segment.toLowerCase() === '.git')) {
    throw new Error('PATH_INVALID')
  }
  return { relativePath: segments.join('/'), absolutePath }
}

function canonicalRoot(rootPath: string): string {
  const absolute = resolve(rootPath)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error('PROJECT_ROOT_MISSING')
  const info = lstatSync(absolute)
  if (info.isSymbolicLink()) throw new Error('PROJECT_ROOT_LINK_REJECTED')
  return realpathSync.native(absolute)
}

function assertRootIdentity(
  storedRoot: string,
  storedReal: string,
  storedIdentityDigest: string | null,
  suppliedRoot: string,
): void {
  const current = readProjectRootIdentityV2(suppliedRoot)
  if (
    !storedIdentityDigest ||
    resolve(storedRoot) !== resolve(suppliedRoot) ||
    current.canonicalRoot !== pathKey(storedReal) ||
    current.digest !== storedIdentityDigest
  ) {
    throw new Error('PROJECT_IDENTITY_CHANGED')
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function requiredPath(input: DirectCodingPreflightInputV4): string {
  if (!input.path) throw new Error('PATH_REQUIRED')
  return input.path
}

function assertCommand(commandText: string | undefined, commandDigest: string | undefined): void {
  if (typeof commandText !== 'string' || !commandText.trim()) throw new Error('COMMAND_INVALID')
  if (Buffer.byteLength(commandText, 'utf8') > 64 * 1024) throw new Error('COMMAND_TOO_LARGE')
  if (hasUnsafeDirectCodingCommandTextV1(commandText)) {
    throw new Error('COMMAND_CONTROL_REJECTED')
  }
  if (!commandDigest || hashBytes(Buffer.from(commandText, 'utf8')) !== commandDigest) {
    throw new Error('COMMAND_DIGEST_MISMATCH')
  }
}

function fileEntityDigest(stats: {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeMs: bigint
  readonly mtimeNs?: bigint
}): string {
  const mtimeNs = stats.mtimeNs ?? stats.mtimeMs * 1_000_000n
  return hashJson({
    dev: stats.dev.toString(10),
    ino: stats.ino.toString(10),
    size: stats.size.toString(10),
    mtimeNs: mtimeNs.toString(10),
  })
}

function pathKey(value: string): string {
  const normalized = resolve(value).replace(/\\/g, '/').replace(/\/$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const rows = db.prepare(`pragma table_info(${table})`).all() as unknown as Array<{ name: string }>
  if (!rows.some((row) => row.name === column)) {
    db.exec(`alter table ${table} add column ${column} ${type}`)
  }
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
  input: Pick<DirectCodingPreflightInputV4, 'requestDigest'>,
  reasonCode: string,
  state: DirectCodingCallStateV2 = 'SETTLED',
): DirectCodingPreflightResultV4 {
  return {
    kind: 'XIAOGUI_DIRECT_CODING_PREFLIGHT',
    subject: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
    decision: 'DENY',
    state,
    requestDigest: input.requestDigest,
    reasonCode,
  }
}

function beginDenied(input: DirectCodingLifecycleInputV2, reasonCode: string): DirectCodingBeginResultV4 {
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
