import { describe, expect, it } from 'vitest'

import type {
  AgentFailureSignalV1,
  AttemptId,
  AttemptProjectionM2BV1,
  FlowId,
  M2ADisabledIntentTypeV1,
  M2BSystemIntentV1,
  SystemAgentOutcomeRecordIntentM2BV1,
  TaskRunId,
} from './xiaogui-collaboration-hub'
import type {
  ArtifactId,
  ChangeSetCandidateV1,
  EvidenceBundleId,
  IsoDateTime,
  QaResultId,
  Sha256Digest,
  TaskChangeSetCandidateId,
  TaskChangeSetId,
  VerificationAttemptId,
} from './xiaogui-task-verification'

const flowId = 'xhbf_flow' as FlowId
const taskRunId = 'xhbtr_task' as TaskRunId
const attemptId = 'xhba_attempt' as AttemptId
const failure = { kind: 'AGENT_FAILURE', failureClass: 'RUNTIME', safeCode: 'RUNTIME_FAILED', receiptDigest: 'sha256:failed' } as const
const candidateAuditFailure = {
  kind: 'AGENT_FAILURE',
  failureClass: 'PROTOCOL',
  safeCode: 'CANDIDATE_AUDIT_FAILED',
  receiptDigest: 'sha256:candidate-audit-failed',
} as const satisfies AgentFailureSignalV1

describe('xiaogui collaboration hub shared contract', () => {
  it('closes M2B system agent outcome DTOs by outcome kind', () => {
    const failed = {
      type: 'system.agent.outcome.record',
      flowId,
      taskRunId,
      attemptId,
      runtimeSessionId: 'runtime-1',
      outcome: 'FAILED',
      receiptDigest: 'sha256:failed',
      failure,
    } satisfies SystemAgentOutcomeRecordIntentM2BV1
    expect(failed.failure.safeCode).toBe('RUNTIME_FAILED')

    // @ts-expect-error FAILED must include a closed AgentFailureSignal.
    const missingSignal: SystemAgentOutcomeRecordIntentM2BV1 = {
      type: 'system.agent.outcome.record',
      flowId,
      taskRunId,
      attemptId,
      runtimeSessionId: 'runtime-1',
      outcome: 'FAILED',
      receiptDigest: 'sha256:failed',
    }
    expect(missingSignal.outcome).toBe('FAILED')

    // @ts-expect-error OUTCOME_UNKNOWN must not carry a failure signal.
    const unknownWithSignal: SystemAgentOutcomeRecordIntentM2BV1 = {
      type: 'system.agent.outcome.record',
      flowId,
      taskRunId,
      attemptId,
      runtimeSessionId: 'runtime-1',
      outcome: 'OUTCOME_UNKNOWN',
      receiptDigest: 'sha256:unknown',
      failure,
    }
    expect(unknownWithSignal.outcome).toBe('OUTCOME_UNKNOWN')

    const auditFailed = {
      type: 'system.agent.outcome.record',
      flowId,
      taskRunId,
      attemptId,
      runtimeSessionId: 'runtime-1',
      outcome: 'FAILED',
      receiptDigest: candidateAuditFailure.receiptDigest,
      failure: candidateAuditFailure,
    } satisfies SystemAgentOutcomeRecordIntentM2BV1
    expect(auditFailed.failure).toEqual(candidateAuditFailure)

    const candidate: ChangeSetCandidateV1 = {
      kind: 'TASK_CANDIDATE',
      candidateId: 'candidate-1' as TaskChangeSetCandidateId,
      flowId,
      taskRunId,
      attemptId,
      inputTreeHash: 'sha256:input' as Sha256Digest,
      resultTreeHash: 'sha256:result' as Sha256Digest,
      patchArtifactId: 'artifact-patch' as ArtifactId,
      candidateDigest: 'sha256:candidate' as Sha256Digest,
      proposedChangeSetDigest: 'sha256:changeset' as Sha256Digest,
      createdAt: '2026-08-17T00:00:00.000Z' as IsoDateTime,
    }
    const succeeded = {
      type: 'system.agent.outcome.record',
      flowId,
      taskRunId,
      attemptId,
      runtimeSessionId: 'runtime-1',
      outcome: 'SUCCEEDED',
      receiptDigest: 'sha256:runtime-receipt',
      runtimeCandidateDigest: 'sha256:runtime-candidate' as Sha256Digest,
      candidate,
    } satisfies SystemAgentOutcomeRecordIntentM2BV1
    expect(succeeded.candidate.candidateDigest).not.toBe(succeeded.runtimeCandidateDigest)
  })

  it('keeps verification writer names disabled instead of executable while exposing an opaque read summary', () => {
    const disabledComplete: M2ADisabledIntentTypeV1 = 'system.verification.complete'
    const disabledReconcile: M2ADisabledIntentTypeV1 = 'system.verification.reconcile'
    expect([disabledComplete, disabledReconcile]).toEqual([
      'system.verification.complete',
      'system.verification.reconcile',
    ])

    type ExecutableSystemIntentType = M2BSystemIntentV1['type']
    // @ts-expect-error Verification completion is coordinated internally, not exposed as an M2B system command payload.
    const completeWriter: ExecutableSystemIntentType = 'system.verification.complete'
    // @ts-expect-error Verification reconciliation is coordinated internally, not exposed as an M2B system command payload.
    const reconcileWriter: ExecutableSystemIntentType = 'system.verification.reconcile'
    expect([completeWriter, reconcileWriter]).toEqual([
      'system.verification.complete',
      'system.verification.reconcile',
    ])

    const verificationAttemptId = 'verify-attempt-1' as VerificationAttemptId
    const projection = {
      attemptId,
      taskRunId,
      status: 'SUCCEEDED',
      verificationSummary: {
        scope: 'TASK',
        verificationAttemptId,
        candidateId: 'candidate-1' as TaskChangeSetCandidateId,
        changeSetDigest: 'sha256:changeset' as Sha256Digest,
        qaConfigVersion: 'task-fixed.v1',
        diagnosticArtifacts: [],
        state: 'SUCCEEDED',
        verdict: 'PASS',
        checks: [],
        evidenceBundleId: 'evidence-1' as EvidenceBundleId,
        qaResultId: 'qa-1' as QaResultId,
        taskChangeSetId: 'changeset-1' as TaskChangeSetId,
        evidenceArtifacts: [],
      },
    } satisfies AttemptProjectionM2BV1
    expect(projection.verificationSummary.taskChangeSetId).toBe('changeset-1')

    expect(projection.verificationSummary).not.toHaveProperty('stdout')
  })
})
