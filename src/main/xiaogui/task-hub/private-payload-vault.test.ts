import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import {
  type AttemptBoundPromptEnvelopeRefV1,
  PRIVATE_RUNTIME_PAYLOAD_MAX_BYTES,
  PrivateRuntimePayloadVaultV1,
  RuntimePayloadVaultError,
  digestBytes,
} from './private-payload-vault'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

async function vaultPath() {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-runtime-payload-vault-'))
  roots.push(root)
  return join(root, 'payloads.sqlite')
}

describe('PrivateRuntimePayloadVaultV1', () => {
  it('persists prompt and message payloads and resolves them only through attempt-bound refs', async () => {
    const dbPath = await vaultPath()
    const first = new PrivateRuntimePayloadVaultV1({ dbPath, now: () => '2026-08-17T00:00:00.000Z' })
    const promptRef = first.putPrompt({ attemptId: 'xhba_1', payloadBytes: '{"task":"edit"}' })
    const messageRef = first.putMessage({ attemptId: 'xhba_1', payloadBytes: 'guidance' })
    first.close()

    const reopened = new PrivateRuntimePayloadVaultV1({ dbPath })
    expect(reopened.promptRefForAttempt('xhba_1')).toEqual(promptRef)
    await expect(reopened.resolvePrompt(promptRef)).resolves.toMatchObject({
      promptEnvelopeRef: promptRef,
      redactedPreviewDigest: digestBytes('{"task":"edit"}'),
    })
    await expect(reopened.resolveMessage(messageRef)).resolves.toMatchObject({
      messageEnvelopeRef: messageRef,
      redactedPreviewDigest: digestBytes('guidance'),
    })
    await expect(reopened.resolvePrompt({ ...promptRef, attemptId: 'xhba_other' } as AttemptBoundPromptEnvelopeRefV1)).rejects.toMatchObject({
      reasonCode: 'PAYLOAD_ATTEMPT_MISMATCH',
    })
    reopened.close()
  })

  it('keeps same ref idempotent and fails closed on ref, digest, media-type and size drift', async () => {
    const vault = new PrivateRuntimePayloadVaultV1({ dbPath: await vaultPath() })
    const ref = vault.putPrompt({ attemptId: 'xhba_1', refId: 'xhbprompt_fixed', payloadBytes: 'same' })
    expect(vault.putPrompt({ attemptId: 'xhba_1', refId: 'xhbprompt_fixed', payloadBytes: 'same' })).toEqual(ref)
    expect(() => vault.putPrompt({ attemptId: 'xhba_1', refId: 'xhbprompt_fixed', payloadBytes: 'different' })).toThrow(
      new RuntimePayloadVaultError('PAYLOAD_REF_CONFLICT'),
    )
    await expect(vault.resolvePrompt({ ...ref, digest: digestBytes('drift') })).rejects.toMatchObject({
      reasonCode: 'PAYLOAD_DIGEST_MISMATCH',
    })
    await expect(vault.resolveMessage({ ...ref, mediaType: 'application/vnd.xiaogui.runtime-message+json' })).rejects.toMatchObject({
      reasonCode: 'PAYLOAD_MEDIA_TYPE_MISMATCH',
    })
    expect(() => vault.putMessage({ attemptId: 'xhba_1', payloadBytes: Buffer.alloc(PRIVATE_RUNTIME_PAYLOAD_MAX_BYTES + 1) })).toThrow(
      new RuntimePayloadVaultError('PAYLOAD_TOO_LARGE'),
    )
    expect(vault.putMessage({ attemptId: 'xhba_1', refId: 'xhbmessage_max', payloadBytes: Buffer.alloc(PRIVATE_RUNTIME_PAYLOAD_MAX_BYTES) })).toMatchObject({
      refId: 'xhbmessage_max',
    })
    expect(() => vault.putMessage({ attemptId: 'xhba_1', payloadBytes: '' })).toThrow(new RuntimePayloadVaultError('PAYLOAD_EMPTY'))
    expect(() => vault.putPrompt({ attemptId: 'xhba_1', refId: '../bad', payloadBytes: 'bad ref' })).toThrow(
      new RuntimePayloadVaultError('PAYLOAD_REF_INVALID'),
    )
    await expect(vault.resolvePrompt({ ...ref, refId: 'xhbprompt_missing' })).rejects.toMatchObject({
      reasonCode: 'PAYLOAD_REF_MISSING',
    })
    vault.putPrompt({ attemptId: 'xhba_1', refId: 'xhbprompt_second', payloadBytes: 'second' })
    expect(() => vault.promptRefForAttempt('xhba_1')).toThrow(new RuntimePayloadVaultError('PAYLOAD_REF_AMBIGUOUS'))
    vault.close()
  })

  it('classifies same-ref writes across vault instances as idempotent or stable conflicts', async () => {
    const dbPath = await vaultPath()
    const first = new PrivateRuntimePayloadVaultV1({ dbPath, now: () => '2026-08-17T00:00:00.000Z' })
    const second = new PrivateRuntimePayloadVaultV1({ dbPath, now: () => '2026-08-17T00:00:01.000Z' })
    const ref = first.putPrompt({ attemptId: 'xhba_1', refId: 'xhbprompt_shared', payloadBytes: 'same' })
    expect(second.putPrompt({ attemptId: 'xhba_1', refId: 'xhbprompt_shared', payloadBytes: 'same' })).toEqual(ref)
    expect(() => second.putPrompt({ attemptId: 'xhba_1', refId: 'xhbprompt_shared', payloadBytes: 'different' })).toThrow(
      new RuntimePayloadVaultError('PAYLOAD_REF_CONFLICT'),
    )
    expect(() => second.putPrompt({ attemptId: 'xhba_2', refId: 'xhbprompt_shared', payloadBytes: 'same' })).toThrow(
      new RuntimePayloadVaultError('PAYLOAD_REF_CONFLICT'),
    )
    expect(() => second.putMessage({ attemptId: 'xhba_1', refId: 'xhbprompt_shared', payloadBytes: 'same' })).toThrow(
      new RuntimePayloadVaultError('PAYLOAD_REF_CONFLICT'),
    )
    await Promise.all([
      Promise.resolve().then(() => first.putMessage({ attemptId: 'xhba_1', refId: 'xhbmessage_shared', payloadBytes: 'same-message' })),
      Promise.resolve().then(() => second.putMessage({ attemptId: 'xhba_1', refId: 'xhbmessage_shared', payloadBytes: 'same-message' })),
    ]).then(([left, right]) => expect(left).toEqual(right))
    first.close()
    second.close()
  })

  it('fails closed when stored media, digest, or payload bytes are tampered', async () => {
    const dbPath = await vaultPath()
    const vault = new PrivateRuntimePayloadVaultV1({ dbPath })
    const mediaRef = vault.putPrompt({ attemptId: 'xhba_tamper_media', refId: 'xhbprompt_tamper_media', payloadBytes: 'media' })
    const digestRef = vault.putPrompt({ attemptId: 'xhba_tamper_digest', refId: 'xhbprompt_tamper_digest', payloadBytes: 'digest' })
    const payloadRef = vault.putPrompt({ attemptId: 'xhba_tamper_payload', refId: 'xhbprompt_tamper_payload', payloadBytes: 'payload' })
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('update private_runtime_payloads set media_type = ? where ref_id = ?').run('application/vnd.xiaogui.runtime-message+json', mediaRef.refId)
      db.prepare('update private_runtime_payloads set digest = ? where ref_id = ?').run(digestBytes('drift'), digestRef.refId)
      db.prepare('update private_runtime_payloads set payload = ? where ref_id = ?').run(Buffer.from('drift'), payloadRef.refId)
    } finally {
      db.close()
    }
    await expect(vault.resolvePrompt(mediaRef)).rejects.toMatchObject({ reasonCode: 'PAYLOAD_MEDIA_TYPE_MISMATCH' })
    await expect(vault.resolvePrompt(digestRef)).rejects.toMatchObject({ reasonCode: 'PAYLOAD_DIGEST_MISMATCH' })
    await expect(vault.resolvePrompt(payloadRef)).rejects.toMatchObject({ reasonCode: 'PAYLOAD_DIGEST_MISMATCH' })
    vault.close()
  })

  it('fails closed before returning prompt or message refs when stored payload bytes are tampered', async () => {
    const dbPath = await vaultPath()
    const vault = new PrivateRuntimePayloadVaultV1({ dbPath })
    const promptRef = vault.putPrompt({ attemptId: 'xhba_tamper_prompt_ref', payloadBytes: 'prompt' })
    const messageRef = vault.putMessage({ attemptId: 'xhba_tamper_message_ref', payloadBytes: 'message' })
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('update private_runtime_payloads set payload = ? where ref_id = ?').run(Buffer.from('tampered-prompt'), promptRef.refId)
      db.prepare('update private_runtime_payloads set payload = ? where ref_id = ?').run(Buffer.from('tampered-message'), messageRef.refId)
    } finally {
      db.close()
    }
    try {
      expect(() => vault.promptRefForAttempt('xhba_tamper_prompt_ref')).toThrow(
        new RuntimePayloadVaultError('PAYLOAD_DIGEST_MISMATCH'),
      )
      expect(() => vault.messageRefForAttempt('xhba_tamper_message_ref')).toThrow(
        new RuntimePayloadVaultError('PAYLOAD_DIGEST_MISMATCH'),
      )
    } finally {
      vault.close()
    }
  })

  it('does not treat a same-ref put as idempotent after stored payload bytes are tampered', async () => {
    const dbPath = await vaultPath()
    const vault = new PrivateRuntimePayloadVaultV1({ dbPath })
    const ref = vault.putPrompt({ attemptId: 'xhba_tamper_put', refId: 'xhbprompt_tamper_put', payloadBytes: 'original' })
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('update private_runtime_payloads set payload = ? where ref_id = ?').run(Buffer.from('tampered'), ref.refId)
    } finally {
      db.close()
    }
    expect(() => vault.putPrompt({ attemptId: 'xhba_tamper_put', refId: 'xhbprompt_tamper_put', payloadBytes: 'original' })).toThrow(
      new RuntimePayloadVaultError('PAYLOAD_REF_CONFLICT'),
    )
    vault.close()
  })

  it('preserves non-conflict SQLite failures instead of classifying them as ref conflicts', async () => {
    const dbPath = await vaultPath()
    const vault = new PrivateRuntimePayloadVaultV1({ dbPath })
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('drop table private_runtime_payloads')
    } finally {
      db.close()
    }
    let thrown: unknown
    try {
      vault.putPrompt({ attemptId: 'xhba_1', refId: 'xhbprompt_broken_store', payloadBytes: 'payload' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(RuntimePayloadVaultError)
    expect((thrown as { code?: unknown }).code).toBe('ERR_SQLITE_ERROR')
    vault.close()
  })

  it('does not pretend unsupported candidate or changeset resolution succeeded', async () => {
    const vault = new PrivateRuntimePayloadVaultV1({ dbPath: await vaultPath() })
    await expect(vault.resolveCandidateFile({ refId: 'candidate', digest: 'sha256:candidate', purpose: 'TASK_CHANGESET_CANDIDATE' })).rejects.toMatchObject({
      reasonCode: 'RUNTIME_CANDIDATE_FILE_UNSUPPORTED',
    })
    await expect(vault.toM2ChangeSetCandidate({ candidateDigest: 'sha256:candidate', candidateFileRefs: [], evidenceDigest: 'sha256:evidence' })).rejects.toMatchObject({
      reasonCode: 'M2_CHANGESET_CANDIDATE_UNSUPPORTED',
    })
    vault.close()
  })
})
