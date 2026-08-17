import { createHash } from 'node:crypto'

import type { AttemptId, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import {
  deliveryTargetFingerprintV1,
  deliveryVerificationRequestDigestV1,
  deliveryVerificationReceiptDigestV1,
  type DeliveryBatchId,
  type DeliveryChangeSetV1,
  type DeliveryTargetV1,
  type DeliveryVerificationAttemptId,
  type DeliveryVerificationRequestV1,
  type DeliveryVerificationReceiptV1,
} from '@shared/xiaogui-delivery'
import {
  verificationRequestDigestV1,
  type ArtifactId,
  type Sha256Digest,
  type TaskChangeSetCandidateId,
  type TaskVerificationRequestV1,
} from '@shared/xiaogui-task-verification'

import type {
  TaskArtifactWriteV1,
  TaskVerificationExecutionPortV1,
} from './verification-port'

export interface DeliveryVerificationInputV1 {
  readonly verificationAttemptId: DeliveryVerificationAttemptId
  readonly deliveryChangeSet: DeliveryChangeSetV1
  readonly worktreeRoot: string
  readonly trustedToolchainRoot: string
}

export interface DeliveryVerificationResultV1 {
  readonly receipt: DeliveryVerificationReceiptV1
  readonly artifacts: readonly TaskArtifactWriteV1[]
}

export class DeliveryVerificationServiceV1 {
  constructor(private readonly verificationPort: TaskVerificationExecutionPortV1) {}

  async verify(input: DeliveryVerificationInputV1): Promise<DeliveryVerificationResultV1> {
    const ids = deliveryVerificationIds(input.deliveryChangeSet.digest)
    const request = Object.freeze(taskVerificationRequest(input, ids))
    const scopeArtifact = deliveryScopeArtifact(ids.scopeEvidenceArtifactId, input.deliveryChangeSet)
    try {
      const result = await this.verificationPort.verify(request, {
        worktreeRoot: input.worktreeRoot,
        trustedToolchainRoot: input.trustedToolchainRoot,
        scopeEvidenceArtifactId: ids.scopeEvidenceArtifactId,
        inspectionArtifactId: ids.inspectionArtifactId,
      })
      return {
        receipt: mapReceipt(input, request, result.receipt, result.artifacts),
        artifacts: result.receipt.verdict === 'OUTCOME_UNKNOWN' ? result.artifacts : [scopeArtifact, ...result.artifacts],
      }
    } catch {
      const diagnostic = deliveryDiagnosticArtifact(ids.inspectionArtifactId, 'DELIVERY_VERIFICATION_PORT_REJECTED')
      const receiptWithoutDigest = {
        scope: 'DELIVERY' as const,
        verificationAttemptId: input.verificationAttemptId,
        batchId: deliveryBatchId(input.deliveryChangeSet),
        flowId: input.deliveryChangeSet.flowId,
        selectionDigest: deliverySelectionDigest(input.deliveryChangeSet),
        deliveryChangeSetId: input.deliveryChangeSet.deliveryChangeSetId,
        deliveryChangeSetDigest: input.deliveryChangeSet.digest,
        requestDigest: request.requestDigest,
        qaConfigVersion: deliveryQaConfigVersion(input.deliveryChangeSet),
        verdict: 'OUTCOME_UNKNOWN' as const,
        checks: [] as const,
        evidenceArtifactIds: [] as const,
        diagnosticArtifactIds: [diagnostic.artifactId],
        reason: 'DELIVERY_VERIFICATION_PORT_REJECTED',
      }
      return {
        receipt: { ...receiptWithoutDigest, receiptDigest: deliveryVerificationReceiptDigestV1(receiptWithoutDigest) },
        artifacts: [diagnostic],
      }
    }
  }
}

function taskVerificationRequest(
  input: DeliveryVerificationInputV1,
  ids: ReturnType<typeof deliveryVerificationIds>,
): TaskVerificationRequestV1 {
  const deliveryRequestWithoutDigest = {
    scope: 'DELIVERY' as const,
    verificationAttemptId: input.verificationAttemptId,
    verificationRequestId: ids.verificationRequestId,
    batchId: deliveryBatchId(input.deliveryChangeSet),
    flowId: input.deliveryChangeSet.flowId,
    selectionDigest: deliverySelectionDigest(input.deliveryChangeSet),
    targetFingerprint: deliveryTargetFingerprintV1(deliveryTarget(input.deliveryChangeSet)),
    deliveryChangeSetDigest: input.deliveryChangeSet.digest,
    qaConfigVersion: deliveryQaConfigVersion(input.deliveryChangeSet),
  } satisfies Omit<DeliveryVerificationRequestV1, 'requestDigest'>
  const deliveryRequest: DeliveryVerificationRequestV1 = {
    ...deliveryRequestWithoutDigest,
    requestDigest: deliveryVerificationRequestDigestV1(deliveryRequestWithoutDigest),
  }
  const requestWithoutDigest = {
    scope: 'TASK' as const,
    verificationAttemptId: input.verificationAttemptId as unknown as TaskVerificationRequestV1['verificationAttemptId'],
    verificationRequestId: ids.verificationRequestId,
    flowId: input.deliveryChangeSet.flowId,
    taskRunId: input.deliveryChangeSet.deliveryChangeSetId as unknown as TaskRunId,
    attemptId: deliveryBatchId(input.deliveryChangeSet) as unknown as AttemptId,
    candidateId: input.deliveryChangeSet.deliveryChangeSetId as unknown as TaskChangeSetCandidateId,
    changeSetDigest: input.deliveryChangeSet.digest,
    preparedTreeHash: deliveryIntegrationTreeHash(input.deliveryChangeSet),
    qaConfigVersion: deliveryQaConfigVersion(input.deliveryChangeSet),
    acceptanceCriteria: ['delivery.scope', 'typescript.web', 'typescript.node', deliveryRequest.requestDigest],
  }
  return {
    ...requestWithoutDigest,
    requestDigest: verificationRequestDigestV1(requestWithoutDigest),
  }
}

function mapReceipt(
  input: DeliveryVerificationInputV1,
  request: TaskVerificationRequestV1,
  taskReceipt: Awaited<ReturnType<TaskVerificationExecutionPortV1['verify']>>['receipt'],
  artifacts: readonly TaskArtifactWriteV1[],
): DeliveryVerificationReceiptV1 {
  const baseReceipt = {
    scope: 'DELIVERY' as const,
    verificationAttemptId: input.verificationAttemptId,
    batchId: deliveryBatchId(input.deliveryChangeSet),
    flowId: input.deliveryChangeSet.flowId,
    selectionDigest: deliverySelectionDigest(input.deliveryChangeSet),
    deliveryChangeSetId: input.deliveryChangeSet.deliveryChangeSetId,
    deliveryChangeSetDigest: input.deliveryChangeSet.digest,
    requestDigest: request.requestDigest,
    qaConfigVersion: deliveryQaConfigVersion(input.deliveryChangeSet),
    diagnosticArtifactIds: taskReceipt.diagnosticArtifactIds,
  }
  if (taskReceipt.verdict === 'OUTCOME_UNKNOWN') {
    const receiptWithoutDigest = {
      ...baseReceipt,
      verdict: 'OUTCOME_UNKNOWN' as const,
      checks: [] as const,
      evidenceArtifactIds: [] as const,
      reason: taskReceipt.reason,
    }
    return { ...receiptWithoutDigest, receiptDigest: deliveryVerificationReceiptDigestV1(receiptWithoutDigest) } as DeliveryVerificationReceiptV1
  }
  const checks = taskReceipt.checks.map((check) => ({
    checkId: check.checkId,
    verdict: check.verdict,
    summary: check.summary,
  }))
  const evidenceArtifactIds = taskReceipt.evidenceArtifactIds
  const receiptWithoutDigest = {
    ...baseReceipt,
    verdict: taskReceipt.verdict,
    checks,
    evidenceArtifactIds,
    ...(taskReceipt.verdict === 'FAIL' ? { reason: taskReceipt.reason } : {}),
  }
  if (!receiptWithoutDigest.diagnosticArtifactIds.every((artifactId) => artifacts.some((artifact) => artifact.artifactId === artifactId))) {
    const degraded = {
      ...baseReceipt,
      verdict: 'OUTCOME_UNKNOWN' as const,
      checks: [] as const,
      evidenceArtifactIds: [] as const,
      reason: 'DELIVERY_VERIFICATION_ARTIFACT_MISMATCH',
    }
    return { ...degraded, receiptDigest: deliveryVerificationReceiptDigestV1(degraded) } as DeliveryVerificationReceiptV1
  }
  return {
    ...receiptWithoutDigest,
    receiptDigest: deliveryVerificationReceiptDigestV1(receiptWithoutDigest),
  } as DeliveryVerificationReceiptV1
}

function deliveryVerificationIds(seed: string): {
  readonly verificationRequestId: string
  readonly scopeEvidenceArtifactId: ArtifactId
  readonly inspectionArtifactId: ArtifactId
} {
  const hex = createHash('sha256').update(seed).digest('hex')
  return {
    verificationRequestId: `xhbdvr_${hex.slice(0, 48)}`,
    scopeEvidenceArtifactId: `xhbdart_scope_${hex.slice(0, 32)}` as ArtifactId,
    inspectionArtifactId: `xhbdart_inspect_${hex.slice(0, 32)}` as ArtifactId,
  }
}

function deliveryScopeArtifact(artifactId: ArtifactId, changeSet: DeliveryChangeSetV1): TaskArtifactWriteV1 {
  const content = Buffer.from(JSON.stringify({
    version: 'delivery-scope-evidence.v1',
    deliveryChangeSetId: changeSet.deliveryChangeSetId,
    deliveryChangeSetDigest: changeSet.digest,
    files: deliveryFileChanges(changeSet).map((file) => ({
      operation: file.operation,
      relativePath: file.relativePath,
      baselineDigest: file.baselineDigest,
      contentDigest: file.contentDigest,
      sourceTaskChangeSetIds: file.sourceTaskChangeSetIds,
    })),
  }), 'utf8')
  return {
    artifactId,
    contentDigest: digestBytes(content),
    kind: 'VERIFICATION_EVIDENCE',
    mediaType: 'application/vnd.xiaogui.delivery-scope-evidence+json',
    content,
  }
}

function deliveryBatchId(changeSet: DeliveryChangeSetV1): DeliveryBatchId {
  if (!changeSet.batchId) throw new Error('DELIVERY_BATCH_ID_REQUIRED')
  return changeSet.batchId
}

function deliverySelectionDigest(changeSet: DeliveryChangeSetV1): Sha256Digest {
  if (!changeSet.selectionDigest) throw new Error('DELIVERY_SELECTION_DIGEST_REQUIRED')
  return changeSet.selectionDigest
}

function deliveryTarget(changeSet: DeliveryChangeSetV1): DeliveryTargetV1 {
  if (!changeSet.target) throw new Error('DELIVERY_TARGET_REQUIRED')
  return changeSet.target
}

function deliveryIntegrationTreeHash(changeSet: DeliveryChangeSetV1): Sha256Digest {
  if (!changeSet.integrationTreeHash) throw new Error('DELIVERY_INTEGRATION_TREE_REQUIRED')
  return changeSet.integrationTreeHash
}

function deliveryQaConfigVersion(changeSet: DeliveryChangeSetV1): string {
  if (!changeSet.qaConfigVersion) throw new Error('DELIVERY_QA_CONFIG_REQUIRED')
  return changeSet.qaConfigVersion
}

function deliveryFileChanges(changeSet: DeliveryChangeSetV1) {
  return changeSet.fileChanges ?? []
}

function deliveryDiagnosticArtifact(artifactId: ArtifactId, safeCode: string): TaskArtifactWriteV1 {
  const content = Buffer.from(JSON.stringify({
    version: 'delivery-verification-diagnostic.v1',
    outcome: 'OUTCOME_UNKNOWN',
    safeCode,
  }), 'utf8')
  return {
    artifactId,
    contentDigest: digestBytes(content),
    kind: 'VERIFICATION_DIAGNOSTIC',
    mediaType: 'application/vnd.xiaogui.qa-diagnostic+json',
    content,
  }
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}
