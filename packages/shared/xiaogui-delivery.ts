import { createHash } from 'node:crypto'

import type { FlowId, TaskRunId } from './xiaogui-collaboration-hub'
import type {
  ArtifactId,
  IsoDateTime,
  Sha256Digest,
  TaskChangeSetId,
} from './xiaogui-task-verification'

export type DeliveryBatchId = string & { readonly __brand: 'DeliveryBatchId' }
export type DeliveryBatchIdV1 = DeliveryBatchId
export type DeliverySelectionDraftId = string & { readonly __brand: 'DeliverySelectionDraftId' }
export type DeliverySelectionDraftIdV1 = DeliverySelectionDraftId
export type DeliveryChangeSetId = string & { readonly __brand: 'DeliveryChangeSetId' }
export type DeliveryChangeSetIdV1 = DeliveryChangeSetId
export type DeliveryVerificationAttemptId = string & { readonly __brand: 'DeliveryVerificationAttemptId' }
export type DeliveryVerificationAttemptIdV1 = DeliveryVerificationAttemptId
export type DeliveryGateId = string & { readonly __brand: 'DeliveryGateId' }
export type DeliveryApplyAttemptId = string & { readonly __brand: 'DeliveryApplyAttemptId' }
export type DeliveryApplyAttemptIdV1 = DeliveryApplyAttemptId

export type DeliveryBatchStateV1 =
  | 'COMPOSING'
  | 'VERIFYING'
  | 'READY_FOR_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'APPLYING'
  | 'APPLIED'
  | 'OUTCOME_UNKNOWN'

export type DeliveryVerificationOutboxStateV1 =
  | 'READY'
  | 'CLAIMED'
  | 'DONE'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN'
export type DeliveryApplyOutboxStateV1 = DeliveryVerificationOutboxStateV1

export interface DeliveryTargetV1 {
  readonly projectId: string
  readonly baseRevision: string
  readonly baselineTreeHash: string
  readonly initialTargetFingerprint: Sha256Digest
}

export interface DeliveryTaskChangeSetRefV1 {
  readonly taskRunId: TaskRunId
  readonly taskChangeSetId: TaskChangeSetId
  readonly digest: Sha256Digest
  readonly patchArtifactId: ArtifactId
  readonly dependsOn?: readonly TaskChangeSetId[]
}

export interface DeliverySelectionDraftV1 {
  readonly kind: 'DELIVERY_SELECTION_DRAFT'
  readonly version: 1
  readonly draftId: DeliverySelectionDraftId
  readonly batchId: DeliveryBatchId
  readonly flowId: FlowId
  readonly selectedTaskRunIds: readonly TaskRunId[]
  readonly resolvedTaskChangeSets: readonly DeliveryTaskChangeSetRefV1[]
  readonly dependencyTaskRunIds: readonly TaskRunId[]
  readonly targetFingerprint: Sha256Digest
  readonly createdAt: IsoDateTime
  readonly digest: Sha256Digest
}

export interface DeliveryFileChangeSummaryV1 {
  readonly operation: 'MODIFY' | 'CREATE'
  readonly relativePath: string
  readonly baselineDigest: Sha256Digest | null
  readonly contentDigest: Sha256Digest
  /** Reference to main-process-private bytes. The bytes never enter this DTO. */
  readonly contentArtifactId: ArtifactId
  readonly sourceTaskChangeSetIds: readonly TaskChangeSetId[]
}

/** Compatibility name for the public, byte-free file summary. */
export type DeliveryFileChangeV1 = DeliveryFileChangeSummaryV1

export interface DeliveryChangeSetV1 {
  readonly kind: 'DELIVERY_CHANGESET'
  readonly version: 1
  readonly deliveryChangeSetId: DeliveryChangeSetId
  readonly batchId: DeliveryBatchId
  readonly selectionDraftId: DeliverySelectionDraftId
  readonly flowId: FlowId
  readonly selectionDigest: Sha256Digest
  readonly taskChangeSetIds: readonly TaskChangeSetId[]
  readonly taskChangeSets: readonly DeliveryTaskChangeSetRefV1[]
  readonly dependencyOrder: readonly TaskChangeSetId[]
  readonly fileChanges: readonly DeliveryFileChangeSummaryV1[]
  readonly target: DeliveryTargetV1
  readonly integrationTreeHash: Sha256Digest
  readonly evidenceArtifactIds: readonly ArtifactId[]
  readonly qaConfigVersion: string
  readonly createdAt: IsoDateTime
  readonly digest: Sha256Digest
}

export interface DeliveryVerificationRequestV1 {
  readonly scope: 'DELIVERY'
  readonly verificationAttemptId: DeliveryVerificationAttemptId
  readonly verificationRequestId: string
  readonly batchId: DeliveryBatchId
  readonly flowId: FlowId
  readonly selectionDigest: Sha256Digest
  readonly targetFingerprint: Sha256Digest
  readonly deliveryChangeSetDigest: Sha256Digest
  readonly qaConfigVersion: string
  readonly requestDigest: Sha256Digest
}

export interface DeliveryVerificationCheckSummaryV1 {
  readonly checkId: string
  readonly verdict: 'PASS' | 'FAIL'
  readonly summary: string
}

interface DeliveryVerificationReceiptBaseV1 {
  readonly scope: 'DELIVERY'
  readonly verificationAttemptId: DeliveryVerificationAttemptId
  readonly batchId: DeliveryBatchId
  readonly flowId: FlowId
  readonly selectionDigest: Sha256Digest
  readonly deliveryChangeSetId: DeliveryChangeSetId
  readonly deliveryChangeSetDigest: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly qaConfigVersion: string
  readonly diagnosticArtifactIds: readonly ArtifactId[]
  readonly receiptDigest: Sha256Digest
}

export type DeliveryVerificationReceiptV1 =
  | (DeliveryVerificationReceiptBaseV1 & {
      readonly verdict: 'PASS'
      readonly checks: readonly DeliveryVerificationCheckSummaryV1[]
      readonly evidenceArtifactIds: readonly ArtifactId[]
      readonly reason?: never
    })
  | (DeliveryVerificationReceiptBaseV1 & {
      readonly verdict: 'FAIL'
      readonly checks: readonly [DeliveryVerificationCheckSummaryV1, ...DeliveryVerificationCheckSummaryV1[]]
      readonly evidenceArtifactIds: readonly ArtifactId[]
      readonly reason: string
    })
  | (DeliveryVerificationReceiptBaseV1 & {
      readonly verdict: 'OUTCOME_UNKNOWN'
      readonly checks: readonly []
      readonly evidenceArtifactIds: readonly []
      readonly reason: string
    })

export interface DeliveryGateSubjectV1 {
  readonly deliveryChangeSetId: DeliveryChangeSetId
  readonly version: 1
  readonly digest: Sha256Digest
}

export type DeliveryApprovalSubjectV1 = DeliveryGateSubjectV1

export interface DeliveryHumanGateV1 {
  readonly gateId: DeliveryGateId
  readonly batchId: DeliveryBatchId
  readonly subject: DeliveryGateSubjectV1
  readonly state: 'OPEN' | 'APPROVED' | 'REJECTED'
  readonly decisionDigest?: Sha256Digest
  readonly decidedAt?: IsoDateTime
  readonly createdAt: IsoDateTime
}

export interface DeliveryApplyAttemptV1 {
  readonly applyAttemptId: DeliveryApplyAttemptId
  readonly batchId: DeliveryBatchId
  readonly deliveryChangeSetId: DeliveryChangeSetId
  readonly requestDigest: Sha256Digest
  readonly targetFingerprintBefore: Sha256Digest
  readonly state: 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'FAILED_ROLLED_BACK' | 'OUTCOME_UNKNOWN'
  readonly receiptDigest?: Sha256Digest
  readonly targetFingerprintAfter?: Sha256Digest
  readonly startedAt: IsoDateTime
  readonly finishedAt?: IsoDateTime
}

export interface DeliveryBatchProjectionV1 {
  readonly batchId: DeliveryBatchId
  readonly flowId: FlowId
  readonly state: DeliveryBatchStateV1
  readonly selectionDigest: Sha256Digest
  readonly selectedTaskRunIds: readonly TaskRunId[]
  readonly taskChangeSetIds: readonly TaskChangeSetId[]
  readonly targetFingerprint: Sha256Digest
  readonly deliveryChangeSetId?: DeliveryChangeSetId
  readonly deliveryChangeSetDigest?: Sha256Digest
  readonly fileChangeSummaries?: readonly DeliveryFileChangeSummaryV1[]
  readonly evidenceArtifactIds?: readonly ArtifactId[]
  readonly qaConfigVersion?: string
  readonly gate?: DeliveryHumanGateV1
  readonly applyAttempt?: DeliveryApplyAttemptV1
}

export type DeliveryReviewProjectionV1 = DeliveryBatchProjectionV1

export type DeliveryApplySafeCodeV1 =
  | 'APPROVAL_SUBJECT_MISMATCH'
  | 'DELIVERY_CHANGESET_DIGEST_MISMATCH'
  | 'DELIVERY_FILE_INVALID'
  | 'TARGET_BASELINE_DRIFT'
  | 'TARGET_STATUS_DIRTY'
  | 'TARGET_FILE_DRIFT'
  | 'TARGET_WRITE_FAILED'
  | 'ROLLBACK_INCOMPLETE'
  | 'APPLY_ATTEMPT_CONFLICT'
  | 'APPLY_ATTEMPT_NOT_FOUND'

interface DeliveryApplyReceiptBaseV1 {
  readonly applyAttemptId: DeliveryApplyAttemptId
  readonly deliveryChangeSetId: DeliveryChangeSetId
  readonly changedRelativePaths: readonly string[]
  readonly receiptDigest: Sha256Digest
}

export type DeliveryApplyReceiptV1 =
  | (DeliveryApplyReceiptBaseV1 & {
      readonly verdict: 'SUCCEEDED'
      readonly targetFingerprint: Sha256Digest
      readonly safeCode?: never
    })
  | (DeliveryApplyReceiptBaseV1 & {
      readonly verdict: 'FAILED_ROLLED_BACK'
      readonly safeCode: DeliveryApplySafeCodeV1
      readonly targetFingerprint?: never
    })
  | (DeliveryApplyReceiptBaseV1 & {
      readonly verdict: 'OUTCOME_UNKNOWN'
      readonly safeCode: DeliveryApplySafeCodeV1
      readonly targetFingerprint?: never
    })

export function deliverySelectionDraftDigestV1(
  value: Omit<DeliverySelectionDraftV1, 'digest'> | DeliverySelectionDraftV1,
): Sha256Digest {
  return digest({
    domain: 'XIAOGUI_DELIVERY_SELECTION_DRAFT_V1',
    kind: value.kind,
    version: value.version,
    draftId: value.draftId,
    batchId: value.batchId,
    flowId: value.flowId,
    selectedTaskRunIds: value.selectedTaskRunIds,
    resolvedTaskChangeSets: value.resolvedTaskChangeSets,
    dependencyTaskRunIds: value.dependencyTaskRunIds,
    targetFingerprint: value.targetFingerprint,
    createdAt: value.createdAt,
  })
}

export const deliverySelectionDigestV1 = deliverySelectionDraftDigestV1

export function deliveryChangeSetDigestV1(
  value: Omit<DeliveryChangeSetV1, 'digest'> | DeliveryChangeSetV1,
): Sha256Digest {
  return digest({
    domain: 'XIAOGUI_DELIVERY_CHANGESET_V1',
    kind: value.kind,
    version: value.version,
    deliveryChangeSetId: value.deliveryChangeSetId,
    batchId: value.batchId,
    selectionDraftId: value.selectionDraftId,
    flowId: value.flowId,
    selectionDigest: value.selectionDigest,
    taskChangeSetIds: value.taskChangeSetIds,
    taskChangeSets: value.taskChangeSets,
    dependencyOrder: value.dependencyOrder,
    fileChanges: value.fileChanges,
    target: value.target,
    integrationTreeHash: value.integrationTreeHash,
    evidenceArtifactIds: value.evidenceArtifactIds,
    qaConfigVersion: value.qaConfigVersion,
    createdAt: value.createdAt,
  })
}

export function deliveryVerificationRequestDigestV1(
  value: Omit<DeliveryVerificationRequestV1, 'requestDigest'> | DeliveryVerificationRequestV1,
): Sha256Digest {
  return digest({
    domain: 'XIAOGUI_DELIVERY_VERIFICATION_REQUEST_V1',
    scope: value.scope,
    verificationAttemptId: value.verificationAttemptId,
    verificationRequestId: value.verificationRequestId,
    batchId: value.batchId,
    flowId: value.flowId,
    selectionDigest: value.selectionDigest,
    targetFingerprint: value.targetFingerprint,
    deliveryChangeSetDigest: value.deliveryChangeSetDigest,
    qaConfigVersion: value.qaConfigVersion,
  })
}

export function deliveryVerificationReceiptDigestV1(
  value: Omit<DeliveryVerificationReceiptV1, 'receiptDigest'> | DeliveryVerificationReceiptV1,
): Sha256Digest {
  return digest({
    domain: 'XIAOGUI_DELIVERY_VERIFICATION_RECEIPT_V1',
    scope: value.scope,
    verificationAttemptId: value.verificationAttemptId,
    batchId: value.batchId,
    flowId: value.flowId,
    selectionDigest: value.selectionDigest,
    deliveryChangeSetId: value.deliveryChangeSetId,
    deliveryChangeSetDigest: value.deliveryChangeSetDigest,
    requestDigest: value.requestDigest,
    qaConfigVersion: value.qaConfigVersion,
    verdict: value.verdict,
    checks: 'checks' in value ? value.checks : null,
    evidenceArtifactIds: 'evidenceArtifactIds' in value ? value.evidenceArtifactIds : null,
    diagnosticArtifactIds: value.diagnosticArtifactIds,
    reason: 'reason' in value ? value.reason : null,
  })
}

export function deliveryGateSubjectDigestV1(subject: DeliveryGateSubjectV1): Sha256Digest {
  return digest({
    domain: 'XIAOGUI_DELIVERY_GATE_SUBJECT_V1',
    deliveryChangeSetId: subject.deliveryChangeSetId,
    version: subject.version,
    digest: subject.digest,
  })
}

export function deliveryGateDecisionDigestV1(input: {
  readonly gateId: DeliveryGateId
  readonly batchId: DeliveryBatchId
  readonly deliveryChangeSetId: DeliveryChangeSetId
  readonly version: 1
  readonly digest: Sha256Digest
  readonly decision: 'APPROVE' | 'REJECT'
}): Sha256Digest {
  return digest({
    domain: 'XIAOGUI_DELIVERY_GATE_DECISION_V1',
    gateId: input.gateId,
    batchId: input.batchId,
    deliveryChangeSetId: input.deliveryChangeSetId,
    version: input.version,
    digest: input.digest,
    decision: input.decision,
  })
}

export function deliveryTargetFingerprintV1(
  target: Pick<DeliveryTargetV1, 'projectId' | 'baseRevision' | 'baselineTreeHash'>,
): Sha256Digest {
  return digest({
    domain: 'XIAOGUI_DELIVERY_TARGET_V1',
    projectId: target.projectId,
    baseRevision: target.baseRevision,
    baselineTreeHash: target.baselineTreeHash,
  })
}

export function deliveryApplyRequestDigestV1(input: {
  readonly applyAttemptId: DeliveryApplyAttemptId
  readonly deliveryChangeSetId: DeliveryChangeSetId
  readonly deliveryChangeSetDigest: Sha256Digest
  readonly approval: DeliveryApprovalSubjectV1
  readonly targetFingerprint: Sha256Digest
}): Sha256Digest {
  return digest({ domain: 'XIAOGUI_DELIVERY_APPLY_REQUEST_V1', ...input })
}

export function deliveryApplyReceiptDigestV1(
  value: Omit<DeliveryApplyReceiptV1, 'receiptDigest'> | DeliveryApplyReceiptV1,
): Sha256Digest {
  return digest({
    domain: 'XIAOGUI_DELIVERY_APPLY_RECEIPT_V1',
    applyAttemptId: value.applyAttemptId,
    deliveryChangeSetId: value.deliveryChangeSetId,
    verdict: value.verdict,
    changedRelativePaths: value.changedRelativePaths,
    targetFingerprint: 'targetFingerprint' in value ? value.targetFingerprint : null,
    safeCode: 'safeCode' in value ? value.safeCode : null,
  })
}

export function deliveryGateSubjectV1(changeSet: DeliveryChangeSetV1): DeliveryGateSubjectV1 {
  return {
    deliveryChangeSetId: changeSet.deliveryChangeSetId,
    version: changeSet.version,
    digest: changeSet.digest,
  }
}

function digest(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}` as Sha256Digest
}
