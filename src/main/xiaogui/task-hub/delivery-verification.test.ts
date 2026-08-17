import { describe, expect, it } from 'vitest'

import type { AttemptId, FlowId, PlanRevisionId, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import {
  deliveryChangeSetDigestV1,
  type DeliveryBatchId,
  type DeliveryChangeSetId,
  type DeliverySelectionDraftId,
  type DeliveryVerificationAttemptId,
} from '@shared/xiaogui-delivery'
import {
  verificationReceiptDigestV1,
  type ArtifactId,
  type EvidenceBundleId,
  type IsoDateTime,
  type QaResultId,
  type Sha256Digest,
  type TaskChangeSetCandidateId,
  type TaskChangeSetId,
  type VerificationAttemptId,
} from '@shared/xiaogui-task-verification'

import { DeliveryVerificationServiceV1 } from './delivery-verification'
import {
  ScriptedTaskVerificationPortV1,
  type TaskVerificationScriptV1,
} from './verification-port'

const FLOW_ID = 'xhbf_flow' as FlowId
const BATCH_ID = 'xhbd_batch' as DeliveryBatchId
const DRAFT_ID = 'xhbd_draft' as DeliverySelectionDraftId
const CHANGESET_ID = 'xhbdcs_delivery' as DeliveryChangeSetId
const VERIFICATION_ATTEMPT_ID = 'xhbdva_delivery' as DeliveryVerificationAttemptId
const TASK_CHANGESET_ID = 'xhbcs_task' as TaskChangeSetId
const CREATED_AT = '2026-08-17T12:00:00.000Z' as IsoDateTime
const DIGEST = `sha256:${'1'.repeat(64)}` as Sha256Digest
const TREE = `sha256:${'2'.repeat(64)}` as Sha256Digest
const FINGERPRINT = `sha256:${'3'.repeat(64)}` as Sha256Digest
const WORKTREE_ROOT = process.platform === 'win32' ? 'D:\\private\\delivery-worktree' : '/tmp/delivery-worktree'
const TOOLCHAIN_ROOT = process.platform === 'win32' ? 'D:\\private\\toolchain' : '/tmp/toolchain'

describe('DeliveryVerificationServiceV1', () => {
  it('maps a fixed TypeScript verification PASS to a delivery receipt with scope evidence', async () => {
    const service = new DeliveryVerificationServiceV1(new ScriptedTaskVerificationPortV1(passScript))

    const result = await service.verify({
      verificationAttemptId: VERIFICATION_ATTEMPT_ID,
      deliveryChangeSet: deliveryChangeSet(),
      worktreeRoot: WORKTREE_ROOT,
      trustedToolchainRoot: TOOLCHAIN_ROOT,
    })

    expect(result.receipt).toMatchObject({
      scope: 'DELIVERY',
      verificationAttemptId: VERIFICATION_ATTEMPT_ID,
      deliveryChangeSetId: CHANGESET_ID,
      verdict: 'PASS',
    })
    expect(result.receipt.checks!.map((check) => check.checkId)).toEqual(['delivery.scope', 'typescript.web'])
    expect(result.artifacts.some((artifact) => artifact.mediaType === 'application/vnd.xiaogui.delivery-scope-evidence+json')).toBe(true)
    expect(JSON.stringify(result.receipt)).not.toContain(WORKTREE_ROOT)
  })

  it('maps fixed verification FAIL without opening an apply path', async () => {
    const service = new DeliveryVerificationServiceV1(new ScriptedTaskVerificationPortV1(failScript))

    const result = await service.verify({
      verificationAttemptId: VERIFICATION_ATTEMPT_ID,
      deliveryChangeSet: deliveryChangeSet(),
      worktreeRoot: WORKTREE_ROOT,
      trustedToolchainRoot: TOOLCHAIN_ROOT,
    })

    expect(result.receipt).toMatchObject({
      verdict: 'FAIL',
      reason: 'FIXED_TYPECHECK_FAILED',
    })
    expect(result.receipt.checks![0]).toMatchObject({ checkId: 'typescript.node', verdict: 'FAIL' })
  })

  it('degrades thrown verification ports to OUTCOME_UNKNOWN with diagnostic evidence', async () => {
    const service = new DeliveryVerificationServiceV1(new ScriptedTaskVerificationPortV1(async () => {
      throw new Error('boom')
    }))

    const result = await service.verify({
      verificationAttemptId: VERIFICATION_ATTEMPT_ID,
      deliveryChangeSet: deliveryChangeSet(),
      worktreeRoot: WORKTREE_ROOT,
      trustedToolchainRoot: TOOLCHAIN_ROOT,
    })

    expect(result.receipt).toMatchObject({
      verdict: 'OUTCOME_UNKNOWN',
      reason: 'SCRIPTED_VERIFICATION_ERROR',
    })
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].kind).toBe('VERIFICATION_DIAGNOSTIC')
  })
})

const passScript: TaskVerificationScriptV1 = (request, context) => {
  const diagnostic = artifact(context.inspectionArtifactId, 'VERIFICATION_DIAGNOSTIC')
  const evidence = artifact('xhart_delivery_pass' as ArtifactId, 'VERIFICATION_EVIDENCE')
  const receiptWithoutDigest = {
    scope: 'TASK' as const,
    verificationAttemptId: request.verificationAttemptId,
    verificationRequestId: request.verificationRequestId,
    flowId: request.flowId,
    taskRunId: request.taskRunId,
    attemptId: request.attemptId,
    candidateId: request.candidateId,
    requestDigest: request.requestDigest,
    changeSetDigest: request.changeSetDigest,
    qaConfigVersion: request.qaConfigVersion,
    diagnosticArtifactIds: [diagnostic.artifactId],
    verdict: 'PASS' as const,
    checks: [
      { checkId: 'delivery.scope', summary: '交付范围通过', artifactIds: [context.scopeEvidenceArtifactId], verdict: 'PASS' as const },
      { checkId: 'typescript.web', summary: '界面 TypeScript 检查通过', artifactIds: [evidence.artifactId], verdict: 'PASS' as const },
    ],
    evidenceArtifactIds: [context.scopeEvidenceArtifactId, evidence.artifactId],
  }
  return {
    receipt: { ...receiptWithoutDigest, receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest) },
    artifacts: [diagnostic, evidence],
  }
}

const failScript: TaskVerificationScriptV1 = (request, context) => {
  const diagnostic = artifact(context.inspectionArtifactId, 'VERIFICATION_DIAGNOSTIC')
  const evidence = artifact('xhart_delivery_fail' as ArtifactId, 'VERIFICATION_EVIDENCE')
  const receiptWithoutDigest = {
    scope: 'TASK' as const,
    verificationAttemptId: request.verificationAttemptId,
    verificationRequestId: request.verificationRequestId,
    flowId: request.flowId,
    taskRunId: request.taskRunId,
    attemptId: request.attemptId,
    candidateId: request.candidateId,
    requestDigest: request.requestDigest,
    changeSetDigest: request.changeSetDigest,
    qaConfigVersion: request.qaConfigVersion,
    diagnosticArtifactIds: [diagnostic.artifactId],
    verdict: 'FAIL' as const,
    checks: [
      { checkId: 'typescript.node', summary: '主进程 TypeScript 检查未通过', artifactIds: [evidence.artifactId], verdict: 'FAIL' as const },
    ] as const,
    evidenceArtifactIds: [context.scopeEvidenceArtifactId, evidence.artifactId],
    failure: {
      source: 'QA_CHECKS_FAILED' as const,
      failureClass: 'TEST_FAILURE' as const,
      disposition: 'REQUIRE_HUMAN_GATE' as const,
      retryOrdinal: 0 as const,
      safeCode: 'QA_CHECK_FAILED' as const,
    },
    reason: 'FIXED_TYPECHECK_FAILED',
  }
  return {
    receipt: { ...receiptWithoutDigest, receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest) },
    artifacts: [diagnostic, evidence],
  }
}

function deliveryChangeSet() {
  const withoutDigest = {
    kind: 'DELIVERY_CHANGESET' as const,
    version: 1 as const,
    deliveryChangeSetId: CHANGESET_ID,
    batchId: BATCH_ID,
    selectionDraftId: DRAFT_ID,
    flowId: FLOW_ID,
    selectionDigest: DIGEST,
    taskChangeSetIds: [TASK_CHANGESET_ID],
    taskChangeSets: [{
      taskChangeSetId: TASK_CHANGESET_ID,
      taskRunId: 'xhbr_task' as TaskRunId,
      digest: DIGEST,
      patchArtifactId: 'xhart_patch' as ArtifactId,
      dependsOn: [],
    }],
    dependencyOrder: [TASK_CHANGESET_ID],
    fileChanges: [{
      operation: 'MODIFY' as const,
      relativePath: 'src/feature.ts',
      baselineDigest: DIGEST,
      contentDigest: TREE,
      contentArtifactId: 'xhart_patch' as ArtifactId,
      sourceTaskChangeSetIds: [TASK_CHANGESET_ID],
    }],
    target: {
      projectId: 'xgp_project',
      baseRevision: '1'.repeat(40),
      baselineTreeHash: '2'.repeat(40),
      initialTargetFingerprint: FINGERPRINT,
    },
    integrationTreeHash: FINGERPRINT,
    evidenceArtifactIds: ['xhart_delivery_scope' as ArtifactId],
    qaConfigVersion: 'xiaogui.coding.delivery.v1',
    createdAt: CREATED_AT,
  }
  return {
    ...withoutDigest,
    digest: deliveryChangeSetDigestV1(withoutDigest),
  }
}

function artifact(artifactId: ArtifactId, kind: 'VERIFICATION_EVIDENCE' | 'VERIFICATION_DIAGNOSTIC') {
  const content = Buffer.from(JSON.stringify({ artifactId, kind }))
  return {
    artifactId,
    contentDigest: `sha256:${'9'.repeat(64)}` as Sha256Digest,
    kind,
    mediaType: kind === 'VERIFICATION_EVIDENCE'
      ? 'application/vnd.xiaogui.qa-evidence+json'
      : 'application/vnd.xiaogui.qa-diagnostic+json',
    content,
  }
}
