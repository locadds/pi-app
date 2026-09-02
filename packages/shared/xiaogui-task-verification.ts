import { createHash } from 'node:crypto'

import type { AttemptId, FlowId, PlanRevisionId, TaskRunId } from './xiaogui-collaboration-hub'

export type ArtifactId = string & { readonly __brand: 'ArtifactId' }
export type TaskChangeSetCandidateId = string & { readonly __brand: 'TaskChangeSetCandidateId' }
export type VerificationAttemptId = string & { readonly __brand: 'VerificationAttemptId' }
export type EvidenceBundleId = string & { readonly __brand: 'EvidenceBundleId' }
export type QaResultId = string & { readonly __brand: 'QaResultId' }
export type TaskChangeSetId = string & { readonly __brand: 'TaskChangeSetId' }
export type Sha256Digest = string & { readonly __brand: 'Sha256Digest' }
export type IsoDateTime = string & { readonly __brand: 'IsoDateTime' }

export interface TaskArtifactRefV1 {
  artifactId: ArtifactId
  digest: Sha256Digest
  kind: 'PATCH' | 'QA_EVIDENCE' | 'QA_DIAGNOSTIC'
}

export interface TaskVerificationCheckSummaryV1 {
  checkId: string
  verdict: 'PASS' | 'FAIL'
  summary: string
}

export interface ChangeSetCandidateV1 {
  kind: 'TASK_CANDIDATE'
  candidateId: TaskChangeSetCandidateId
  flowId: FlowId
  taskRunId: TaskRunId
  attemptId: AttemptId
  inputTreeHash: Sha256Digest
  resultTreeHash: Sha256Digest
  patchArtifactId: ArtifactId
  candidateDigest: Sha256Digest
  proposedChangeSetDigest: Sha256Digest
  createdAt: IsoDateTime
}

export interface TaskChangeSetDigestFieldsV1 {
  inputTreeHash: Sha256Digest
  resultTreeHash: Sha256Digest
  ancestorTaskChangeSetIds: readonly TaskChangeSetId[]
  patchArtifactId: ArtifactId
}

export interface TaskVerificationRequestV1 {
  scope: 'TASK'
  verificationAttemptId: VerificationAttemptId
  verificationRequestId: string
  flowId: FlowId
  taskRunId: TaskRunId
  attemptId: AttemptId
  candidateId: TaskChangeSetCandidateId
  requestDigest: Sha256Digest
  changeSetDigest: Sha256Digest
  preparedTreeHash: Sha256Digest
  qaConfigVersion: string
  acceptanceCriteria: readonly string[]
}

export interface TaskQaCheckBaseV1 {
  checkId: string
  summary: string
  artifactIds: readonly ArtifactId[]
}

export type TaskQaPassedCheckV1 = TaskQaCheckBaseV1 & { verdict: 'PASS' }
export type TaskQaFailedCheckV1 = TaskQaCheckBaseV1 & { verdict: 'FAIL' }
export type TaskQaCheckV1 = TaskQaPassedCheckV1 | TaskQaFailedCheckV1
export type TaskQaFailedFirstChecksV1 = readonly [TaskQaFailedCheckV1, ...TaskQaCheckV1[]]

export type TaskVerificationFailureSourceV1 =
  | {
      source: 'QA_CHECKS_FAILED'
      failureClass: 'TEST_FAILURE'
      disposition: 'REQUIRE_HUMAN_GATE'
      retryOrdinal: 0
      safeCode: 'QA_CHECK_FAILED'
    }
  | {
      source: 'VERIFICATION_LOGIC_FAILURE'
      failureClass: 'LOGIC_FAILURE'
      disposition: 'REQUIRE_HUMAN_GATE'
      retryOrdinal: 0
      safeCode: 'INVALID_AGENT_RESULT' | 'UNSATISFIED_ACCEPTANCE_CRITERIA' | 'EXECUTION_LOGIC_ERROR'
    }
  | {
      source: 'VERIFICATION_POLICY_DENIED'
      failureClass: 'POLICY_DENIED'
      disposition: 'REQUIRE_HUMAN_GATE'
      retryOrdinal: 0
      safeCode: 'POLICY_DENIED' | 'EXECUTOR_NOT_ALLOWED'
    }
  | {
      source: 'VERIFICATION_TRANSIENT_INFRASTRUCTURE'
      failureClass: 'TRANSIENT_INFRASTRUCTURE'
      disposition: 'AUTO_RETRY'
      retryOrdinal: 1 | 2
      safeCode: 'VERIFICATION_TEMPORARILY_UNAVAILABLE'
    }
  | {
      source: 'VERIFICATION_TRANSIENT_BUDGET_EXCEEDED'
      failureClass: 'TRANSIENT_INFRASTRUCTURE'
      disposition: 'REQUIRE_HUMAN_GATE'
      retryOrdinal: number
      safeCode: 'VERIFICATION_TEMPORARILY_UNAVAILABLE'
    }
  | {
      source: 'VERIFICATION_PERMANENT_INFRASTRUCTURE'
      failureClass: 'PERMANENT_INFRASTRUCTURE'
      disposition: 'REQUIRE_HUMAN_GATE'
      retryOrdinal: 0
      safeCode: 'WORKSPACE_INTERNAL_ERROR'
    }

interface TaskVerificationReceiptBaseV1 {
  scope: 'TASK'
  verificationAttemptId: VerificationAttemptId
  verificationRequestId: string
  flowId: FlowId
  taskRunId: TaskRunId
  attemptId: AttemptId
  candidateId: TaskChangeSetCandidateId
  requestDigest: Sha256Digest
  changeSetDigest: Sha256Digest
  qaConfigVersion: string
  diagnosticArtifactIds: readonly ArtifactId[]
  receiptDigest: Sha256Digest
}

export type TaskVerificationPassedReceiptV1 = TaskVerificationReceiptBaseV1 & {
  verdict: 'PASS'
  checks: readonly TaskQaPassedCheckV1[]
  evidenceArtifactIds: readonly ArtifactId[]
  failure?: never
  reason?: never
}

export type TaskVerificationFailedReceiptV1 = TaskVerificationReceiptBaseV1 & {
  verdict: 'FAIL'
  checks: TaskQaFailedFirstChecksV1
  evidenceArtifactIds: readonly ArtifactId[]
  failure: TaskVerificationFailureSourceV1
  reason: string
}

export type TaskVerificationUnknownReceiptV1 = TaskVerificationReceiptBaseV1 & {
  verdict: 'OUTCOME_UNKNOWN'
  checks?: never
  evidenceArtifactIds?: never
  failure?: never
  reason: string
}

export type TaskVerificationReceiptV1 =
  | TaskVerificationPassedReceiptV1
  | TaskVerificationFailedReceiptV1
  | TaskVerificationUnknownReceiptV1

export type TaskVerificationReceiptDigestInputV1 = TaskVerificationReceiptV1 extends infer Receipt
  ? Receipt extends TaskVerificationReceiptV1
    ? Omit<Receipt, 'receiptDigest'>
    : never
  : never

interface VerificationAttemptBaseV1 {
  scope: 'TASK'
  verificationAttemptId: VerificationAttemptId
  verificationRequestId: string
  flowId: FlowId
  taskRunId: TaskRunId
  attemptId: AttemptId
  candidateId: TaskChangeSetCandidateId
  requestDigest: Sha256Digest
  startedAt: IsoDateTime
}

export type VerificationAttemptV1 =
  | (VerificationAttemptBaseV1 & { state: 'STARTED'; finishedAt?: never; outcomeReceiptDigest?: never })
  | (VerificationAttemptBaseV1 & {
      state: 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN'
      finishedAt: IsoDateTime
      outcomeReceiptDigest: Sha256Digest
    })

export interface TaskEvidenceBundleV1 {
  scope: 'TASK'
  evidenceBundleId: EvidenceBundleId
  verificationAttemptId: VerificationAttemptId
  flowId: FlowId
  taskRunId: TaskRunId
  attemptId: AttemptId
  changeSetDigest: Sha256Digest
  qaConfigVersion: string
  artifactIds: readonly ArtifactId[]
  bundleDigest: Sha256Digest
}

interface TaskQaResultBaseV1 {
  scope: 'TASK'
  qaResultId: QaResultId
  verificationAttemptId: VerificationAttemptId
  flowId: FlowId
  taskRunId: TaskRunId
  attemptId: AttemptId
  candidateId: TaskChangeSetCandidateId
  changeSetDigest: Sha256Digest
  qaConfigVersion: string
  resultDigest: Sha256Digest
}

export type TaskPassedQaResultV1 = TaskQaResultBaseV1 & {
  verdict: 'PASS'
  checks: readonly TaskQaPassedCheckV1[]
}

export type TaskFailedQaResultV1 = TaskQaResultBaseV1 & {
  verdict: 'FAIL'
  checks: TaskQaFailedFirstChecksV1
}

export type TaskQaResultV1 = TaskPassedQaResultV1 | TaskFailedQaResultV1
export type TaskQaResultDigestInputV1 = TaskQaResultV1 extends infer Result
  ? Result extends TaskQaResultV1
    ? Omit<Result, 'resultDigest'>
    : never
  : never

export interface TaskChangeSetV1 {
  kind: 'TASK'
  taskChangeSetId: TaskChangeSetId
  version: 1
  flowId: FlowId
  planRevisionId: PlanRevisionId
  taskRunId: TaskRunId
  attemptId: AttemptId
  verificationAttemptId: VerificationAttemptId
  candidateId: TaskChangeSetCandidateId
  inputTreeHash: Sha256Digest
  resultTreeHash: Sha256Digest
  ancestorTaskChangeSetIds: readonly TaskChangeSetId[]
  patchArtifactId: ArtifactId
  evidenceBundleId: EvidenceBundleId
  qaResultId: QaResultId
  qaConfigVersion: string
  digest: Sha256Digest
  createdAt: IsoDateTime
}

interface TaskVerificationSummaryBaseV1 {
  scope: 'TASK'
  verificationAttemptId: VerificationAttemptId
  candidateId: TaskChangeSetCandidateId
  changeSetDigest: Sha256Digest
  qaConfigVersion: string
  diagnosticArtifacts: readonly TaskArtifactRefV1[]
}

export type TaskVerificationSummaryV1 =
  | (TaskVerificationSummaryBaseV1 & { state: 'STARTED'; verdict?: never; checks?: never })
  | (TaskVerificationSummaryBaseV1 & {
      state: 'SUCCEEDED'
      verdict: 'PASS'
      checks: readonly TaskVerificationCheckSummaryV1[]
      evidenceBundleId: EvidenceBundleId
      qaResultId: QaResultId
      taskChangeSetId: TaskChangeSetId
      evidenceArtifacts: readonly TaskArtifactRefV1[]
    })
  | (TaskVerificationSummaryBaseV1 & {
      state: 'FAILED'
      verdict: 'FAIL'
      checks: readonly TaskVerificationCheckSummaryV1[]
      failure: TaskVerificationFailureSourceV1
    })
  | (TaskVerificationSummaryBaseV1 & {
      state: 'OUTCOME_UNKNOWN'
      verdict: 'OUTCOME_UNKNOWN'
      checks?: never
    })

export function taskChangeSetDigestV1(fields: TaskChangeSetDigestFieldsV1): Sha256Digest {
  return digest({
    kind: 'TASK_CHANGESET_V1',
    inputTreeHash: fields.inputTreeHash,
    resultTreeHash: fields.resultTreeHash,
    ancestorTaskChangeSetIds: fields.ancestorTaskChangeSetIds,
    patchArtifactId: fields.patchArtifactId,
  })
}

export function taskCandidateDigestV1(candidate: Omit<ChangeSetCandidateV1, 'candidateDigest'>): Sha256Digest {
  return digest({
    kind: candidate.kind,
    candidateId: candidate.candidateId,
    flowId: candidate.flowId,
    taskRunId: candidate.taskRunId,
    attemptId: candidate.attemptId,
    inputTreeHash: candidate.inputTreeHash,
    resultTreeHash: candidate.resultTreeHash,
    patchArtifactId: candidate.patchArtifactId,
    proposedChangeSetDigest: candidate.proposedChangeSetDigest,
    createdAt: candidate.createdAt,
  })
}

export function verificationRequestDigestV1(request: Omit<TaskVerificationRequestV1, 'requestDigest'>): Sha256Digest {
  return digest({
    scope: request.scope,
    verificationAttemptId: request.verificationAttemptId,
    verificationRequestId: request.verificationRequestId,
    flowId: request.flowId,
    taskRunId: request.taskRunId,
    attemptId: request.attemptId,
    candidateId: request.candidateId,
    changeSetDigest: request.changeSetDigest,
    preparedTreeHash: request.preparedTreeHash,
    qaConfigVersion: request.qaConfigVersion,
    acceptanceCriteria: request.acceptanceCriteria,
  })
}

export function verificationReceiptDigestV1(receipt: TaskVerificationReceiptDigestInputV1): Sha256Digest {
  return digest({
    scope: receipt.scope,
    verificationAttemptId: receipt.verificationAttemptId,
    verificationRequestId: receipt.verificationRequestId,
    flowId: receipt.flowId,
    taskRunId: receipt.taskRunId,
    attemptId: receipt.attemptId,
    candidateId: receipt.candidateId,
    requestDigest: receipt.requestDigest,
    changeSetDigest: receipt.changeSetDigest,
    qaConfigVersion: receipt.qaConfigVersion,
    diagnosticArtifactIds: receipt.diagnosticArtifactIds,
    verdict: receipt.verdict,
    ...(receipt.verdict === 'PASS'
      ? { checks: receipt.checks, evidenceArtifactIds: receipt.evidenceArtifactIds }
      : receipt.verdict === 'FAIL'
        ? {
            checks: receipt.checks,
            evidenceArtifactIds: receipt.evidenceArtifactIds,
            failure: receipt.failure,
            reason: receipt.reason,
          }
        : { reason: receipt.reason }),
  })
}

export function taskEvidenceBundleDigestV1(bundle: Omit<TaskEvidenceBundleV1, 'bundleDigest'>): Sha256Digest {
  return digest({
    scope: bundle.scope,
    evidenceBundleId: bundle.evidenceBundleId,
    verificationAttemptId: bundle.verificationAttemptId,
    flowId: bundle.flowId,
    taskRunId: bundle.taskRunId,
    attemptId: bundle.attemptId,
    changeSetDigest: bundle.changeSetDigest,
    qaConfigVersion: bundle.qaConfigVersion,
    artifactIds: bundle.artifactIds,
  })
}

export function taskQaResultDigestV1(result: TaskQaResultDigestInputV1): Sha256Digest {
  return digest({
    scope: result.scope,
    qaResultId: result.qaResultId,
    verificationAttemptId: result.verificationAttemptId,
    flowId: result.flowId,
    taskRunId: result.taskRunId,
    attemptId: result.attemptId,
    candidateId: result.candidateId,
    changeSetDigest: result.changeSetDigest,
    qaConfigVersion: result.qaConfigVersion,
    verdict: result.verdict,
    checks: result.checks,
  })
}

function digest(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}` as Sha256Digest
}
