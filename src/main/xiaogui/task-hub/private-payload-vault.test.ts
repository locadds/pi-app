import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
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
    expect(() => vault.putMessage({ attemptId: 'xhba_1', payloadBytes: '' })).toThrow(new RuntimePayloadVaultError('PAYLOAD_EMPTY'))
    vault.putPrompt({ attemptId: 'xhba_1', refId: 'xhbprompt_second', payloadBytes: 'second' })
    expect(() => vault.promptRefForAttempt('xhba_1')).toThrow(new RuntimePayloadVaultError('PAYLOAD_REF_AMBIGUOUS'))
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
