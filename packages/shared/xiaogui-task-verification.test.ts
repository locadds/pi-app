import { describe, expect, it } from 'vitest'

import type { AttemptId, FlowId, PlanRevisionId, TaskRunId } from './xiaogui-collaboration-hub'
import {
  taskCandidateDigestV1,
  taskChangeSetDigestV1,
  taskEvidenceBundleDigestV1,
  taskQaResultDigestV1,
  verificationReceiptDigestV1,
  verificationRequestDigestV1,
  type ArtifactId,
  type ChangeSetCandidateV1,
  type EvidenceBundleId,
  type IsoDateTime,
  type QaResultId,
  type Sha256Digest,
  type TaskArtifactRefV1,
  type TaskChangeSetCandidateId,
  type TaskChangeSetId,
  type TaskChangeSetV1,
  type TaskEvidenceBundleV1,
  type TaskPassedQaResultV1,
  type TaskVerificationReceiptV1,
  type TaskVerificationRequestV1,
  type VerificationAttemptId,
} from './xiaogui-task-verification'

const flowId = 'xhbf_flow' as FlowId
const taskRunId = 'xhbtr_task' as TaskRunId
const attemptId = 'xhba_attempt' as AttemptId
const candidateId = 'xhbc_candidate' as TaskChangeSetCandidateId
const verificationAttemptId = 'xhbv_attempt' as VerificationAttemptId
const patchArtifactId = 'xhbar_patch' as ArtifactId
const evidenceArtifactId = 'xhbar_evidence' as ArtifactId
const inputTreeHash = 'sha256:input' as Sha256Digest
const resultTreeHash = 'sha256:result' as Sha256Digest
const createdAt = '2026-08-17T00:00:00.000Z' as IsoDateTime

describe('xiaogui TASK verification shared contract', () => {
  it('builds one canonical TASK change digest without Evidence or QA identities', () => {
    const fields = {
      inputTreeHash,
      resultTreeHash,
      ancestorTaskChangeSetIds: [] as readonly TaskChangeSetId[],
      patchArtifactId,
    }
    const first = taskChangeSetDigestV1(fields)
    const second = taskChangeSetDigestV1(fields)

    expect(first).toBe(second)
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)

    const candidateWithoutDigest = {
      kind: 'TASK_CANDIDATE',
      candidateId,
      flowId,
      taskRunId,
      attemptId,
      inputTreeHash,
      resultTreeHash,
      patchArtifactId,
      proposedChangeSetDigest: first,
      createdAt,
    } satisfies Omit<ChangeSetCandidateV1, 'candidateDigest'>
    const candidate: ChangeSetCandidateV1 = {
      ...candidateWithoutDigest,
      candidateDigest: taskCandidateDigestV1(candidateWithoutDigest),
    }
    const sealed = {
      kind: 'TASK',
      taskChangeSetId: 'xhbtcs_1' as TaskChangeSetId,
      version: 1,
      flowId,
      planRevisionId: 'xhbpr_1' as PlanRevisionId,
      taskRunId,
      attemptId,
      verificationAttemptId,
      candidateId,
      inputTreeHash,
      resultTreeHash,
      ancestorTaskChangeSetIds: [],
      patchArtifactId,
      evidenceBundleId: 'xhbe_1' as EvidenceBundleId,
      qaResultId: 'xhbqa_1' as QaResultId,
      qaConfigVersion: 'task-fixed.v1',
      digest: first,
      createdAt,
    } satisfies TaskChangeSetV1

    expect(candidate.proposedChangeSetDigest).toBe(sealed.digest)
  })

  it('hashes fixed verification envelopes and immutable PASS objects', () => {
    const changeSetDigest = taskChangeSetDigestV1({
      inputTreeHash,
      resultTreeHash,
      ancestorTaskChangeSetIds: [],
      patchArtifactId,
    })
    const requestWithoutDigest = {
      scope: 'TASK',
      verificationAttemptId,
      verificationRequestId: 'verify-request-1',
      flowId,
      taskRunId,
      attemptId,
      candidateId,
      changeSetDigest,
      preparedTreeHash: resultTreeHash,
      qaConfigVersion: 'task-fixed.v1',
      acceptanceCriteria: ['typecheck'],
    } satisfies Omit<TaskVerificationRequestV1, 'requestDigest'>
    const request: TaskVerificationRequestV1 = {
      ...requestWithoutDigest,
      requestDigest: verificationRequestDigestV1(requestWithoutDigest),
    }
    const receiptWithoutDigest = {
      scope: 'TASK',
      verificationAttemptId,
      verificationRequestId: request.verificationRequestId,
      flowId,
      taskRunId,
      attemptId,
      candidateId,
      requestDigest: request.requestDigest,
      changeSetDigest,
      qaConfigVersion: request.qaConfigVersion,
      diagnosticArtifactIds: [],
      verdict: 'PASS',
      checks: [{ checkId: 'typecheck', summary: 'passed', artifactIds: [evidenceArtifactId], verdict: 'PASS' }],
      evidenceArtifactIds: [evidenceArtifactId],
    } as const
    const receipt: TaskVerificationReceiptV1 = {
      ...receiptWithoutDigest,
      receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest),
    }
    const bundleWithoutDigest = {
      scope: 'TASK',
      evidenceBundleId: 'xhbe_1' as EvidenceBundleId,
      verificationAttemptId,
      flowId,
      taskRunId,
      attemptId,
      changeSetDigest,
      qaConfigVersion: request.qaConfigVersion,
      artifactIds: [evidenceArtifactId],
    } satisfies Omit<TaskEvidenceBundleV1, 'bundleDigest'>
    const bundle: TaskEvidenceBundleV1 = {
      ...bundleWithoutDigest,
      bundleDigest: taskEvidenceBundleDigestV1(bundleWithoutDigest),
    }
    const qaWithoutDigest = {
      scope: 'TASK',
      qaResultId: 'xhbqa_1' as QaResultId,
      verificationAttemptId,
      flowId,
      taskRunId,
      attemptId,
      candidateId,
      changeSetDigest,
      qaConfigVersion: request.qaConfigVersion,
      verdict: 'PASS',
      checks: receipt.checks,
    } satisfies Omit<TaskPassedQaResultV1, 'resultDigest'>
    const qa: TaskPassedQaResultV1 = {
      ...qaWithoutDigest,
      resultDigest: taskQaResultDigestV1(qaWithoutDigest),
    }

    expect(receipt.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(bundle.bundleDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(qa.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('keeps artifact references opaque and closes verification receipt verdicts', () => {
    const artifact = {
      artifactId: evidenceArtifactId,
      digest: 'sha256:evidence' as Sha256Digest,
      kind: 'QA_EVIDENCE',
    } satisfies TaskArtifactRefV1
    expect(artifact.kind).toBe('QA_EVIDENCE')

    // @ts-expect-error Shared artifact references never expose a filesystem path.
    const artifactWithPath: TaskArtifactRefV1 = { ...artifact, path: 'C:\\secret' }
    expect(artifactWithPath.artifactId).toBe(evidenceArtifactId)

    // @ts-expect-error OUTCOME_UNKNOWN must not carry checks or evidence artifacts.
    const unknownWithChecks: TaskVerificationReceiptV1 = {
      scope: 'TASK',
      verificationAttemptId,
      verificationRequestId: 'verify-request-1',
      flowId,
      taskRunId,
      attemptId,
      candidateId,
      requestDigest: 'sha256:request' as Sha256Digest,
      changeSetDigest: 'sha256:changeset' as Sha256Digest,
      qaConfigVersion: 'task-fixed.v1',
      diagnosticArtifactIds: [],
      receiptDigest: 'sha256:receipt' as Sha256Digest,
      verdict: 'OUTCOME_UNKNOWN',
      reason: 'inspect-required',
      checks: [],
    }
    expect(unknownWithChecks.verdict).toBe('OUTCOME_UNKNOWN')
  })
})
