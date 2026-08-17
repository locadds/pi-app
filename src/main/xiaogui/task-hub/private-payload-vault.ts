import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import type {
  M2ChangeSetCandidateInputV1,
  PromptEnvelopeRefV1,
  RuntimeCandidateFileRefV1,
  RuntimeCandidateFileSnapshotV1,
  RuntimeDigestV1,
  RuntimeMessageEnvelopeRefV1,
  RuntimeMessageEnvelopeV1,
  RuntimePromptEnvelopeV1,
  RuntimeRefIdV1,
  RuntimeTextStreamRefV1,
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'

export const RUNTIME_PROMPT_MEDIA_TYPE = 'application/vnd.xiaogui.runtime-prompt+json' as const
export const RUNTIME_MESSAGE_MEDIA_TYPE = 'application/vnd.xiaogui.runtime-message+json' as const
export const PRIVATE_RUNTIME_PAYLOAD_MAX_BYTES = 1024 * 1024

export type PrivateRuntimePayloadMediaTypeV1 = typeof RUNTIME_PROMPT_MEDIA_TYPE | typeof RUNTIME_MESSAGE_MEDIA_TYPE

export type AttemptBoundPromptEnvelopeRefV1 = PromptEnvelopeRefV1 & { readonly attemptId: string }
export type AttemptBoundMessageEnvelopeRefV1 = RuntimeMessageEnvelopeRefV1 & { readonly attemptId: string }

export type RuntimePayloadVaultReasonCodeV1 =
  | 'PAYLOAD_REF_INVALID'
  | 'PAYLOAD_TOO_LARGE'
  | 'PAYLOAD_REF_CONFLICT'
  | 'PAYLOAD_EMPTY'
  | 'PAYLOAD_REF_MISSING'
  | 'PAYLOAD_REF_AMBIGUOUS'
  | 'PAYLOAD_ATTEMPT_MISMATCH'
  | 'PAYLOAD_MEDIA_TYPE_MISMATCH'
  | 'PAYLOAD_DIGEST_MISMATCH'
  | 'RUNTIME_TEXT_STREAM_UNSUPPORTED'
  | 'RUNTIME_CANDIDATE_FILE_UNSUPPORTED'
  | 'M2_CHANGESET_CANDIDATE_UNSUPPORTED'

export class RuntimePayloadVaultError extends Error {
  constructor(readonly reasonCode: RuntimePayloadVaultReasonCodeV1) {
    super(reasonCode)
    this.name = 'RuntimePayloadVaultError'
  }
}

export interface PrivateRuntimePayloadVaultOptionsV1 {
  dbPath: string
  now?: () => string
}

export interface PutRuntimePromptPayloadInputV1 {
  attemptId: string
  payloadBytes: Uint8Array | Buffer | string
  refId?: string
}

export interface PutRuntimeMessagePayloadInputV1 {
  attemptId: string
  payloadBytes: Uint8Array | Buffer | string
  refId?: string
}

interface PayloadRow {
  ref_id: string
  attempt_id: string
  media_type: PrivateRuntimePayloadMediaTypeV1
  digest: string
  payload: Uint8Array
}

export class PrivateRuntimePayloadVaultV1 implements TrustedRuntimePayloadResolverV1 {
  private readonly db: DatabaseSync
  private readonly now: () => string

  constructor(options: PrivateRuntimePayloadVaultOptionsV1) {
    this.db = new DatabaseSync(options.dbPath)
    this.now = options.now ?? (() => new Date().toISOString())
    this.db.exec('pragma foreign_keys = on')
    this.db.exec('pragma journal_mode = WAL')
    this.db.exec('pragma busy_timeout = 5000')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  putPrompt(input: PutRuntimePromptPayloadInputV1): AttemptBoundPromptEnvelopeRefV1 {
    return this.put(input.attemptId, RUNTIME_PROMPT_MEDIA_TYPE, input.payloadBytes, input.refId) as AttemptBoundPromptEnvelopeRefV1
  }

  putMessage(input: PutRuntimeMessagePayloadInputV1): AttemptBoundMessageEnvelopeRefV1 {
    return this.put(input.attemptId, RUNTIME_MESSAGE_MEDIA_TYPE, input.payloadBytes, input.refId) as AttemptBoundMessageEnvelopeRefV1
  }

  promptRefForAttempt(attemptId: string): AttemptBoundPromptEnvelopeRefV1 {
    return this.refForAttempt(attemptId, RUNTIME_PROMPT_MEDIA_TYPE) as AttemptBoundPromptEnvelopeRefV1
  }

  messageRefForAttempt(attemptId: string): AttemptBoundMessageEnvelopeRefV1 {
    return this.refForAttempt(attemptId, RUNTIME_MESSAGE_MEDIA_TYPE) as AttemptBoundMessageEnvelopeRefV1
  }

  async resolvePrompt(ref: PromptEnvelopeRefV1): Promise<RuntimePromptEnvelopeV1> {
    const boundRef = assertAttemptBoundPromptRef(ref)
    const row = this.resolve(boundRef, RUNTIME_PROMPT_MEDIA_TYPE)
    return {
      promptEnvelopeRef: boundRef,
      redactedPreviewDigest: digestBytes(Buffer.from(row.payload)),
      payloadBytes: Buffer.from(row.payload),
    }
  }

  async resolveMessage(ref: RuntimeMessageEnvelopeRefV1): Promise<RuntimeMessageEnvelopeV1> {
    const boundRef = assertAttemptBoundMessageRef(ref)
    const row = this.resolve(boundRef, RUNTIME_MESSAGE_MEDIA_TYPE)
    return {
      messageEnvelopeRef: boundRef,
      redactedPreviewDigest: digestBytes(Buffer.from(row.payload)),
      payloadBytes: Buffer.from(row.payload),
    }
  }

  async *resolveTextStream(_ref: RuntimeTextStreamRefV1): AsyncIterable<Uint8Array> {
    throw new RuntimePayloadVaultError('RUNTIME_TEXT_STREAM_UNSUPPORTED')
  }

  async resolveCandidateFile(_ref: RuntimeCandidateFileRefV1): Promise<RuntimeCandidateFileSnapshotV1> {
    throw new RuntimePayloadVaultError('RUNTIME_CANDIDATE_FILE_UNSUPPORTED')
  }

  async toM2ChangeSetCandidate(
    _input: M2ChangeSetCandidateInputV1,
  ): Promise<{ changeSetCandidateId: string; digest: RuntimeDigestV1 | string }> {
    throw new RuntimePayloadVaultError('M2_CHANGESET_CANDIDATE_UNSUPPORTED')
  }

  private put(
    attemptId: string,
    mediaType: PrivateRuntimePayloadMediaTypeV1,
    payloadBytes: Uint8Array | Buffer | string,
    refId?: string,
  ): AttemptBoundPromptEnvelopeRefV1 | AttemptBoundMessageEnvelopeRefV1 {
    const cleanAttemptId = cleanNonEmpty(attemptId)
    if (!cleanAttemptId) throw new RuntimePayloadVaultError('PAYLOAD_REF_INVALID')
    const bytes = Buffer.isBuffer(payloadBytes) ? payloadBytes : Buffer.from(payloadBytes)
    if (bytes.length === 0) throw new RuntimePayloadVaultError('PAYLOAD_EMPTY')
    if (bytes.length > PRIVATE_RUNTIME_PAYLOAD_MAX_BYTES) throw new RuntimePayloadVaultError('PAYLOAD_TOO_LARGE')
    const cleanRefId = cleanRuntimeRefId(refId ?? runtimePayloadRefId(mediaType, cleanAttemptId, bytes))
    if (!cleanRefId) throw new RuntimePayloadVaultError('PAYLOAD_REF_INVALID')
    const digest = digestBytes(bytes)
    try {
      this.db.exec('begin immediate')
      const existing = this.row(cleanRefId)
      if (existing) {
        if (
          existing.attempt_id !== cleanAttemptId ||
          existing.media_type !== mediaType ||
          existing.digest !== digest ||
          digestBytes(Buffer.from(existing.payload)) !== digest
        ) {
          throw new RuntimePayloadVaultError('PAYLOAD_REF_CONFLICT')
        }
        this.db.exec('commit')
        return refFor(mediaType, cleanRefId, digest, cleanAttemptId)
      }
      this.db
        .prepare('insert into private_runtime_payloads (ref_id, attempt_id, media_type, digest, payload, created_at) values (?, ?, ?, ?, ?, ?)')
        .run(cleanRefId, cleanAttemptId, mediaType, digest, bytes, this.now())
      this.db.exec('commit')
      return refFor(mediaType, cleanRefId, digest, cleanAttemptId)
    } catch (error) {
      rollbackQuietly(this.db)
      if (error instanceof RuntimePayloadVaultError) throw error
      if (isSqliteConstraintError(error)) {
        const existing = this.row(cleanRefId)
        if (existing?.attempt_id === cleanAttemptId && existing.media_type === mediaType && existing.digest === digest) {
          return refFor(mediaType, cleanRefId, digest, cleanAttemptId)
        }
        throw new RuntimePayloadVaultError('PAYLOAD_REF_CONFLICT')
      }
      throw error
    }
  }

  private resolve(
    ref: AttemptBoundPromptEnvelopeRefV1 | AttemptBoundMessageEnvelopeRefV1,
    expectedMediaType: PrivateRuntimePayloadMediaTypeV1,
  ): PayloadRow {
    const cleanRefId = cleanNonEmpty(ref.refId)
    const cleanAttemptId = cleanNonEmpty(ref.attemptId)
    if (!cleanRefId || !cleanAttemptId || !cleanNonEmpty(ref.digest)) throw new RuntimePayloadVaultError('PAYLOAD_REF_INVALID')
    const row = this.row(cleanRefId)
    if (!row) throw new RuntimePayloadVaultError('PAYLOAD_REF_MISSING')
    if (row.attempt_id !== cleanAttemptId) throw new RuntimePayloadVaultError('PAYLOAD_ATTEMPT_MISMATCH')
    if (row.media_type !== expectedMediaType || ref.mediaType !== expectedMediaType) {
      throw new RuntimePayloadVaultError('PAYLOAD_MEDIA_TYPE_MISMATCH')
    }
    if (row.digest !== ref.digest || digestBytes(Buffer.from(row.payload)) !== ref.digest) {
      throw new RuntimePayloadVaultError('PAYLOAD_DIGEST_MISMATCH')
    }
    return row
  }

  private refForAttempt(attemptId: string, mediaType: PrivateRuntimePayloadMediaTypeV1): AttemptBoundPromptEnvelopeRefV1 | AttemptBoundMessageEnvelopeRefV1 {
    const cleanAttemptId = cleanNonEmpty(attemptId)
    if (!cleanAttemptId) throw new RuntimePayloadVaultError('PAYLOAD_REF_INVALID')
    const rows = this.db
      .prepare('select ref_id, attempt_id, media_type, digest, payload from private_runtime_payloads where attempt_id = ? and media_type = ? order by created_at asc, ref_id asc')
      .all(cleanAttemptId, mediaType) as unknown as PayloadRow[]
    if (rows.length === 0) throw new RuntimePayloadVaultError('PAYLOAD_REF_MISSING')
    if (rows.length > 1) throw new RuntimePayloadVaultError('PAYLOAD_REF_AMBIGUOUS')
    return refFor(mediaType, rows[0]!.ref_id, rows[0]!.digest, cleanAttemptId)
  }

  private row(refId: string): PayloadRow | null {
    const row = this.db
      .prepare('select ref_id, attempt_id, media_type, digest, payload from private_runtime_payloads where ref_id = ?')
      .get(refId) as PayloadRow | undefined
    return row ?? null
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists private_runtime_payloads (
        ref_id text primary key,
        attempt_id text not null,
        media_type text not null check (media_type in ('application/vnd.xiaogui.runtime-prompt+json', 'application/vnd.xiaogui.runtime-message+json')),
        digest text not null,
        payload blob not null,
        created_at text not null
      );
      create index if not exists private_runtime_payloads_attempt
        on private_runtime_payloads(attempt_id, media_type);
    `)
  }
}

export function digestBytes(bytes: Uint8Array | Buffer | string): RuntimeDigestV1 | string {
  return `sha256:${createHash('sha256').update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).digest('hex')}`
}

function runtimePayloadRefId(
  mediaType: PrivateRuntimePayloadMediaTypeV1,
  attemptId: string,
  payloadBytes: Uint8Array | Buffer | string,
): RuntimeRefIdV1 | string {
  const role = mediaType === RUNTIME_PROMPT_MEDIA_TYPE ? 'prompt' : 'message'
  return `xhbrp_${role}_${digestBytes(`${attemptId}:${digestBytes(payloadBytes)}`).replace('sha256:', '').slice(0, 32)}`
}

function refFor(
  mediaType: PrivateRuntimePayloadMediaTypeV1,
  refId: string,
  digest: string,
  attemptId: string,
): AttemptBoundPromptEnvelopeRefV1 | AttemptBoundMessageEnvelopeRefV1 {
  return { refId, digest, mediaType, attemptId }
}

function assertAttemptBoundPromptRef(ref: PromptEnvelopeRefV1): AttemptBoundPromptEnvelopeRefV1 {
  if (ref.mediaType !== RUNTIME_PROMPT_MEDIA_TYPE || !cleanNonEmpty(ref.refId) || !cleanNonEmpty(ref.digest)) {
    throw new RuntimePayloadVaultError('PAYLOAD_REF_INVALID')
  }
  const attemptId = cleanNonEmpty((ref as { attemptId?: unknown }).attemptId)
  if (!attemptId) throw new RuntimePayloadVaultError('PAYLOAD_ATTEMPT_MISMATCH')
  return { ...ref, attemptId }
}

function assertAttemptBoundMessageRef(ref: RuntimeMessageEnvelopeRefV1): AttemptBoundMessageEnvelopeRefV1 {
  if (ref.mediaType !== RUNTIME_MESSAGE_MEDIA_TYPE || !cleanNonEmpty(ref.refId) || !cleanNonEmpty(ref.digest)) {
    throw new RuntimePayloadVaultError('PAYLOAD_REF_INVALID')
  }
  const attemptId = cleanNonEmpty((ref as { attemptId?: unknown }).attemptId)
  if (!attemptId) throw new RuntimePayloadVaultError('PAYLOAD_ATTEMPT_MISMATCH')
  return { ...ref, attemptId }
}

function cleanNonEmpty(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() ? value : ''
}

function cleanRuntimeRefId(value: unknown): string {
  if (!cleanNonEmpty(value)) return ''
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value as string) ? (value as string) : ''
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('rollback')
  } catch {
    // No active transaction or rollback failed; callers receive a stable vault error.
  }
}

function isSqliteConstraintError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')
}
