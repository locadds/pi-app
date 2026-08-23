import { randomUUID } from 'node:crypto'
import type { ExecutionBaselineProviderV1 } from './application'
import type { ProjectWorkspaceResolverV1 } from './attempt-workspace'
import {
  DeliveryComposerV1,
  type DeliveryComposerTaskInputV1,
  type DeliveryComposedFileArtifactV1,
} from './delivery-composer'
import {
  cleanupDeliveryIntegrationWorktreeRootV1,
  MainProcessDeliveryIntegrationWorktreePortV1,
} from './delivery-integration-worktree'
import { DeliveryVerificationServiceV1 } from './delivery-verification'
import {
  isPreStartChangeApplyErrorV1,
  type DeliveryApplyFileContentV1,
  type DeliveryApplyPortV1,
} from './change-apply'
import type { TaskVerificationExecutionPortV1 } from './verification-port'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'
import {
  deliveryApplyReceiptDigestV1,
  deliveryApplyRequestDigestV1,
  deliveryChangeSetDigestV1,
  deliveryGateDecisionDigestV1,
  deliverySelectionDigestV1,
  deliveryTargetFingerprintV1,
  deliveryVerificationReceiptDigestV1,
  deliveryVerificationRequestDigestV1,
  type DeliveryApplyAttemptId,
  type DeliveryApplyReceiptV1,
  type DeliveryApprovalSubjectV1,
  type DeliveryBatchId,
  type DeliveryBatchProjectionV1,
  type DeliveryChangeSetId,
  type DeliveryChangeSetV1,
  type DeliveryGateId,
  type DeliveryRecoveryLineageV1,
  type DeliverySelectionDraftId,
  type DeliveryTargetV1,
  type DeliveryVerificationAttemptId,
  type DeliveryVerificationRequestV1,
} from '@shared/xiaogui-delivery'
import type {
  XiaoguiDeliveryApproveGateRequestV1,
  XiaoguiDeliveryCoordinatorPortV1,
  XiaoguiDeliveryOutcomeV1,
  XiaoguiDeliveryReconcileApplyRequestV1,
  XiaoguiDeliveryPrepareRecoveryRequestV1,
  XiaoguiDeliveryReturnBatchRequestV1,
  XiaoguiDeliveryRetryApplyRequestV1,
  XiaoguiDeliverySelectTasksRequestV1,
} from '@shared/xiaogui-delivery-ipc'
import type { FlowId, HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import type { ArtifactId, Sha256Digest, TaskChangeSetId } from '@shared/xiaogui-task-verification'
import {
  MainProcessDeliveryBaselineRecoveryPortV1,
  type DeliveryBaselineRecoveryPortV1,
} from './delivery-baseline-recovery'

const DELIVERY_QA_CONFIG_VERSION_V1 = 'xiaogui.coding.delivery.v1'
const DELIVERY_OUTBOX_OWNER_V1 = 'xiaogui-main-process-delivery'
const DELIVERY_TARGET_INTEGRITY_FAILURES = new Set([
  'TARGET_BASELINE_DRIFT',
])

interface PrivateDeliveryVerificationRecoveryV1 {
  readonly verificationRequestDigest?: Sha256Digest
  readonly deliveryChangeSet: DeliveryChangeSetV1
  readonly privateIntegrationContext: {
    readonly worktreeRoot: string
    readonly trustedToolchainRoot: string
  }
  readonly fileArtifacts: readonly DeliveryComposedFileArtifactV1[]
}

export interface XiaoguiDeliveryWorkflowOptionsV1 {
  readonly storeFactory: () => CollaborationHubSqliteStoreV1
  readonly baselineProvider: ExecutionBaselineProviderV1
  readonly projectResolver: ProjectWorkspaceResolverV1
  readonly deliveryManagedRoot: string
  readonly verificationPort: TaskVerificationExecutionPortV1
  readonly applyPort: DeliveryApplyPortV1
  readonly baselineRecoveryPort?: DeliveryBaselineRecoveryPortV1
  readonly now?: () => string
  readonly idFactory?: (prefix: string) => string
}

export class XiaoguiDeliveryWorkflowV1 implements XiaoguiDeliveryCoordinatorPortV1 {
  private readonly store: CollaborationHubSqliteStoreV1
  private readonly verificationService: DeliveryVerificationServiceV1
  private readonly inFlight = new Map<string, Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>>>()
  private readonly integrationRoots = new Map<string, string>()
  private closing = false
  private closed = false
  private recoveryPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined

  constructor(private readonly options: XiaoguiDeliveryWorkflowOptionsV1) {
    this.store = options.storeFactory()
    this.verificationService = new DeliveryVerificationServiceV1(options.verificationPort)
  }

  selectTasks(
    address: HubAddressV1,
    request: XiaoguiDeliverySelectTasksRequestV1,
  ): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
    return this.singleFlight(`select:${address.projectId}:${address.sessionKey}:${request.requestId}`, async () => {
      try {
        const target = await this.captureDeliveryTarget(address, request.flowId)
        const batchId = this.id('xhbd_batch') as DeliveryBatchId
        const draftId = this.id('xhbd_draft') as never
        const now = this.now()
        const selection = this.store.createDeliverySelection(address, {
          batchId,
          draftId,
          flowId: request.flowId,
          selectedTaskRunIds: request.taskRunIds,
          targetFingerprint: target.initialTargetFingerprint,
          now,
        })
        const projection = this.store.readDeliveryProjection(selection.batchId)
        if (selection.replayed && projection?.state !== 'COMPOSING') return this.okProjection(selection.batchId)
        const draft = this.store.readDeliverySelectionDraft(selection.batchId)
        if (!draft) return fail('DELIVERY_NOT_FOUND')

        const composer = new DeliveryComposerV1(new MainProcessDeliveryIntegrationWorktreePortV1({
          projectResolver: this.options.projectResolver,
          managedRoot: this.options.deliveryManagedRoot,
          target,
          batchId: selection.batchId,
        }))
        const taskInputs = this.deliveryTaskInputs(draft.resolvedTaskChangeSets.map((item) => item.taskChangeSetId))
        const deliveryChangeSetId = this.id('xhbdcs') as DeliveryChangeSetId
        const composed = await composer.compose({
          flowId: request.flowId,
          deliveryBatchId: selection.batchId,
          selectionDraftId: draft.draftId,
          deliveryChangeSetId,
          taskInputs,
          dependencyOrder: draft.resolvedTaskChangeSets.map((item) => item.taskChangeSetId),
          selectionDigest: draft.digest,
          target,
          qaConfigVersion: DELIVERY_QA_CONFIG_VERSION_V1,
          createdAt: now as never,
        })
        if (!composed.ok) {
          this.store.rejectComposingDelivery(address, selection.batchId, composed.reasonCode, this.now())
          return fail('ILLEGAL_TRANSITION')
        }
        this.integrationRoots.set(composed.privateIntegrationContext.worktreeRoot, composed.privateIntegrationContext.trustedToolchainRoot)

        const verificationAttemptId = this.id('xhbdva') as DeliveryVerificationAttemptId
        const verificationRequest = deliveryVerificationRequest(verificationAttemptId, composed.changeSet)
        this.store.beginDeliveryVerification(address, {
          verificationAttemptId,
          verificationRequestJson: JSON.stringify({
            ...verificationRequest,
            privateRecovery: serializeVerificationRecovery({
              verificationRequestDigest: verificationRequest.requestDigest,
              deliveryChangeSet: composed.changeSet,
              privateIntegrationContext: composed.privateIntegrationContext,
              fileArtifacts: composed.artifacts,
            }),
          }),
          now: this.now(),
        })
        const claim = this.store.claimDeliveryVerificationOutbox({
          verificationAttemptId,
          ownerId: DELIVERY_OUTBOX_OWNER_V1,
          claimDigest: digestForClaim('delivery.verify', verificationAttemptId, verificationRequest.requestDigest),
          now: this.now(),
        })
        if (!claim) return fail('ILLEGAL_TRANSITION')
        await this.completeRecoveredVerification(address, verificationAttemptId, verificationRequest.requestDigest, {
          deliveryChangeSet: composed.changeSet,
          privateIntegrationContext: composed.privateIntegrationContext,
          fileArtifacts: composed.artifacts,
        })
        return this.okProjection(selection.batchId)
      } catch (error) {
        return mapDeliveryError(error)
      }
    })
  }

  approveGate(address: HubAddressV1, request: XiaoguiDeliveryApproveGateRequestV1): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
    return this.singleFlight(`approve:${address.projectId}:${address.sessionKey}:${request.requestId}`, async () => {
      try {
        const gate = this.store.readDeliveryGate(request.gateId)
        if (!gate) return fail('DELIVERY_NOT_FOUND')
        const decision = this.store.decideDeliveryGate(address, {
          gateId: request.gateId,
          batchId: gate.batchId,
          deliveryChangeSetId: request.subject.deliveryChangeSetId,
          version: request.subject.version,
          digest: request.subject.digest,
          decision: 'APPROVE',
          decisionDigest: deliveryGateDecisionDigestV1({
            gateId: request.gateId,
            batchId: gate.batchId,
            deliveryChangeSetId: request.subject.deliveryChangeSetId,
            version: request.subject.version,
            digest: request.subject.digest,
            decision: 'APPROVE',
          }),
          now: this.now(),
        })
        const afterDecision = this.store.readDeliveryProjection(gate.batchId)
        if (decision.replayed && afterDecision?.applyAttempt) return this.okProjection(gate.batchId)
        const receipt = await this.applyApproved(address, gate.batchId, request.subject, this.id('xhbdap') as DeliveryApplyAttemptId)
        if (receipt.verdict === 'SUCCEEDED') return this.okProjection(gate.batchId)
        return this.okProjection(gate.batchId)
      } catch (error) {
        return mapDeliveryError(error)
      }
    })
  }

  returnBatch(address: HubAddressV1, request: XiaoguiDeliveryReturnBatchRequestV1): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
    return this.singleFlight(`return:${address.projectId}:${address.sessionKey}:${request.requestId}`, async () => {
      try {
        const gate = this.store.readDeliveryGate(request.gateId)
        if (!gate) return fail('DELIVERY_NOT_FOUND')
        this.store.decideDeliveryGate(address, {
          gateId: request.gateId,
          batchId: gate.batchId,
          deliveryChangeSetId: request.subject.deliveryChangeSetId,
          version: request.subject.version,
          digest: request.subject.digest,
          decision: 'REJECT',
          decisionDigest: deliveryGateDecisionDigestV1({
            gateId: request.gateId,
            batchId: gate.batchId,
            deliveryChangeSetId: request.subject.deliveryChangeSetId,
            version: request.subject.version,
            digest: request.subject.digest,
            decision: 'REJECT',
          }),
          now: this.now(),
        })
        return this.okProjection(gate.batchId)
      } catch (error) {
        return mapDeliveryError(error)
      }
    })
  }

  reconcileApply(address: HubAddressV1, request: XiaoguiDeliveryReconcileApplyRequestV1): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
    return this.singleFlight(`reconcile:${address.projectId}:${address.sessionKey}:${request.requestId}`, async () => {
      try {
        const projection = this.store.readDeliveryProjection(request.batchId)
        const applyAttemptId = request.applyAttemptId ?? projection?.applyAttempt?.applyAttemptId
        if (!applyAttemptId) return fail('DELIVERY_NOT_FOUND')
        const packageRecord = this.store.readDeliveryApplyPackage(applyAttemptId)
        if (!packageRecord) return fail('DELIVERY_NOT_FOUND')
        const receipt = await this.inspectOrResumeClaimedApply(
          applyAttemptId,
          packageRecord.changeSet,
          approvalSubject(packageRecord.changeSet),
        )
        this.store.completeDeliveryApply(address, {
          applyAttemptId,
          outcome: applyOutcome(receipt),
          receipt,
          now: this.now(),
        })
        return this.okProjection(packageRecord.applyAttempt.batchId)
      } catch (error) {
        return mapDeliveryError(error)
      }
    })
  }

  retryApply(address: HubAddressV1, request: XiaoguiDeliveryRetryApplyRequestV1): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
    return this.singleFlight(`retry:${address.projectId}:${address.sessionKey}:${request.requestId}`, async () => {
      try {
        const failed = this.store.readDeliveryApplyAttempt(request.failedApplyAttemptId)
        if (!failed || failed.batchId !== request.batchId || (failed.state !== 'FAILED' && failed.state !== 'OUTCOME_UNKNOWN')) {
          return fail('ILLEGAL_TRANSITION')
        }
        const changeSet = this.store.readDeliveryChangeSetForBatch(request.batchId)
        if (!changeSet) return fail('DELIVERY_NOT_FOUND')
        await this.applyApproved(address, request.batchId, {
          deliveryChangeSetId: changeSet.deliveryChangeSetId,
          version: changeSet.version,
          digest: changeSet.digest,
        }, this.id('xhbdap') as DeliveryApplyAttemptId)
        return this.okProjection(request.batchId)
      } catch (error) {
        return mapDeliveryError(error)
      }
    })
  }

  prepareRecovery(address: HubAddressV1, request: XiaoguiDeliveryPrepareRecoveryRequestV1): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
    return this.singleFlight(`prepare-recovery:${address.projectId}:${address.sessionKey}:${request.batchId}`, async () => {
      let cleanupContext: { worktreeRoot: string; trustedToolchainRoot: string } | undefined
      try {
        const existing = this.store.readRecoveredDeliveryProjection(address, request.batchId)
        if (existing) return { ok: true, value: existing }
        const packageRecord = this.store.readDeliveryApplyPackage(request.failedApplyAttemptId)
        if (!packageRecord || packageRecord.applyAttempt.batchId !== request.batchId) return fail('DELIVERY_NOT_FOUND')
        if (
          packageRecord.applyAttempt.state !== 'FAILED' &&
          packageRecord.applyAttempt.state !== 'FAILED_ROLLED_BACK'
        ) {
          return fail('ILLEGAL_TRANSITION')
        }
        if (
          !DELIVERY_TARGET_INTEGRITY_FAILURES.has(packageRecord.applyAttempt.safeCode ?? '') ||
          (packageRecord.applyAttempt.changedRelativePaths ?? []).length !== 0
        ) {
          return fail('ILLEGAL_TRANSITION')
        }
        const sourceDraft = this.store.readDeliverySelectionDraft(request.batchId)
        if (!sourceDraft) return fail('DELIVERY_NOT_FOUND')
        const currentTarget = await this.captureDeliveryTarget(address, packageRecord.changeSet.flowId)
        const recoveryPort = this.baselineRecoveryPort()
        const recovered = await recoveryPort.recover({
          sourceBatchId: request.batchId,
          sourceChangeSet: packageRecord.changeSet,
          currentTarget,
          desiredFiles: packageRecord.fileArtifacts.map((artifact) => ({
            relativePath: packageRecord.changeSet.fileChanges.find((file) => file.contentArtifactId === artifact.artifactId)?.relativePath ?? '',
            contentArtifactId: artifact.artifactId,
            contentDigest: artifact.contentDigest,
            content: artifact.content,
          })),
        })
        cleanupContext = recovered.privateIntegrationContext
        const now = this.now()
        const batchId = this.id('xhbd_batch') as DeliveryBatchId
        const draftId = this.id('xhbd_draft') as DeliverySelectionDraftId
        const recoveredDraftBase = {
          ...sourceDraft,
          draftId,
          batchId,
          targetFingerprint: recovered.evidenceMaterial.currentTargetFingerprint,
          createdAt: now as never,
        }
        const selectionDigest = deliverySelectionDigestV1(recoveredDraftBase)
        const recoveryLineage: DeliveryRecoveryLineageV1 = {
          sourceBatchId: request.batchId,
          sourceDeliveryChangeSetId: recovered.evidenceMaterial.sourceDeliveryChangeSetId,
          sourceDeliveryChangeSetDigest: recovered.evidenceMaterial.sourceDeliveryChangeSetDigest,
          sourceTargetFingerprint: recovered.evidenceMaterial.sourceTargetFingerprint,
          currentTargetFingerprint: recovered.evidenceMaterial.currentTargetFingerprint,
        }
        const fileArtifacts = recovered.files.map((file): DeliveryComposedFileArtifactV1 => ({
          artifactId: this.id('xhbdart_recovery_file') as ArtifactId,
          contentDigest: file.contentDigest,
          kind: 'DELIVERY_FILE_CONTENT',
          mediaType: 'application/vnd.xiaogui.delivery-file-content',
          content: file.content,
        }))
        const fileChanges = recovered.files.map((file, index) => ({
          operation: file.operation,
          relativePath: file.relativePath,
          baselineDigest: file.baselineDigest,
          contentDigest: file.contentDigest,
          contentArtifactId: fileArtifacts[index].artifactId,
          sourceTaskChangeSetIds: file.sourceTaskChangeSetIds,
        }))
        const changeSetWithoutDigest = {
          kind: 'DELIVERY_CHANGESET' as const,
          version: 1 as const,
          deliveryChangeSetId: this.id('xhbdcs') as DeliveryChangeSetId,
          batchId,
          selectionDraftId: draftId,
          flowId: packageRecord.changeSet.flowId,
          selectionDigest,
          taskChangeSetIds: packageRecord.changeSet.taskChangeSetIds,
          taskChangeSets: packageRecord.changeSet.taskChangeSets,
          dependencyOrder: packageRecord.changeSet.dependencyOrder,
          fileChanges,
          target: recovered.currentTarget,
          integrationTreeHash: recovered.integrationTreeHash,
          recoveryLineage,
          evidenceArtifactIds: [] as readonly ArtifactId[],
          qaConfigVersion: packageRecord.changeSet.qaConfigVersion,
          createdAt: now as never,
        }
        const changeSet = { ...changeSetWithoutDigest, digest: deliveryChangeSetDigestV1(changeSetWithoutDigest) }
        const verificationAttemptId = this.id('xhbdva') as DeliveryVerificationAttemptId
        const verificationRequest = deliveryVerificationRequest(verificationAttemptId, changeSet)
        const verification = await this.verificationService.verify({
          verificationAttemptId,
          verificationRequestDigest: verificationRequest.requestDigest,
          deliveryChangeSet: changeSet,
          worktreeRoot: recovered.privateIntegrationContext.worktreeRoot,
          trustedToolchainRoot: recovered.privateIntegrationContext.trustedToolchainRoot,
        })
        if (verification.receipt.verdict !== 'PASS') return fail('ILLEGAL_TRANSITION')
        const passedChangeSet = {
          ...changeSet,
          evidenceArtifactIds: verification.receipt.evidenceArtifactIds,
          digest: deliveryChangeSetDigestWithEvidence(changeSet, verification.receipt.evidenceArtifactIds),
        }
        const finalReceipt = retargetDeliveryReceipt(verification.receipt, passedChangeSet)
        await recoveryPort.cleanup(cleanupContext)
        cleanupContext = undefined
        await recoveryPort.recheckTarget(recovered.currentTarget)
        const sealed = this.store.sealRecoveredDeliveryCandidate(address, {
          sourceBatchId: request.batchId,
          sourceFailedApplyAttemptId: request.failedApplyAttemptId,
          batchId,
          draftId,
          verificationAttemptId,
          verificationRequestJson: JSON.stringify(verificationRequest),
          receipt: finalReceipt,
          deliveryChangeSet: passedChangeSet,
          deliveryFileArtifacts: fileArtifacts.map(toDeliveryFileArtifact),
          evidenceArtifacts: verification.artifacts.filter((artifact) => artifact.kind === 'VERIFICATION_EVIDENCE'),
          diagnosticArtifacts: verification.artifacts.filter((artifact) => artifact.kind === 'VERIFICATION_DIAGNOSTIC'),
          gateId: this.id('xhbdg') as DeliveryGateId,
          recoveryLineage,
          now,
        })
        return this.okProjection(sealed.batchId)
      } catch (error) {
        return mapDeliveryError(error)
      } finally {
        if (cleanupContext) {
          try {
            await this.baselineRecoveryPort().cleanup(cleanupContext)
          } catch {
            // Cleanup is deterministic on the next prepare request; the user-facing
            // recovery outcome remains the sealed candidate or the safe error above.
          }
        }
      }
    })
  }

  recover(): Promise<void> {
    if (this.closing || this.closed) return Promise.resolve()
    if (this.recoveryPromise) return this.recoveryPromise
    const recoveryPromise = this.recoverInternal().finally(() => {
      if (this.recoveryPromise === recoveryPromise) this.recoveryPromise = undefined
    })
    this.recoveryPromise = recoveryPromise
    return recoveryPromise
  }

  private async recoverInternal(): Promise<void> {
    if (this.closing || this.closed) return
    for (const pending of this.store.pendingDeliveryVerificationOutboxes()) {
      try {
        if (this.closing || this.closed) break
        const outbox = pending.outbox
        const recovery = parseVerificationRecovery(outbox.requestJson)
        if (!recovery) continue
        if (outbox.status === 'READY') {
          const claim = this.store.claimDeliveryVerificationOutbox({
            verificationAttemptId: outbox.verificationAttemptId,
            ownerId: DELIVERY_OUTBOX_OWNER_V1,
            claimDigest: digestForClaim('delivery.verify.recover', outbox.verificationAttemptId, outbox.requestDigest),
            now: this.now(),
          })
          if (!claim) continue
        }
        if (this.closing || this.closed) continue
        await this.completeRecoveredVerification(pending.address, outbox.verificationAttemptId, outbox.requestDigest, recovery)
      } catch {
        // Explicit user retry/reconcile remains possible; recovery must not throw during startup.
      }
    }
    for (const pending of this.store.pendingDeliveryApplyOutboxes()) {
      try {
        if (this.closing || this.closed) break
        const outbox = pending.outbox
        const packageRecord = this.store.readDeliveryApplyPackage(outbox.applyAttemptId)
        if (!packageRecord) continue
        const approval = approvalSubject(packageRecord.changeSet)
        if (outbox.status === 'READY') {
          const claim = this.store.claimDeliveryApplyOutbox({
            applyAttemptId: outbox.applyAttemptId,
            ownerId: DELIVERY_OUTBOX_OWNER_V1,
            claimDigest: digestForClaim('delivery.apply.recover', outbox.applyAttemptId, outbox.requestDigest),
            now: this.now(),
          })
          if (!claim) continue
        }
        if (this.closing || this.closed) continue
        const receipt = outbox.status === 'READY'
          ? await this.runClaimedApply(packageRecord.changeSet, approval, outbox.applyAttemptId)
          : await this.inspectOrResumeClaimedApply(outbox.applyAttemptId, packageRecord.changeSet, approval)
        this.store.completeDeliveryApply(pending.address, {
          applyAttemptId: outbox.applyAttemptId,
          outcome: applyOutcome(receipt),
          receipt,
          now: this.now(),
        })
      } catch {
        // Recovery is best-effort; explicit user reconcile keeps the batch blocked.
      }
    }
  }

  private async completeRecoveredVerification(
    address: HubAddressV1,
    verificationAttemptId: DeliveryVerificationAttemptId,
    verificationRequestDigest: Sha256Digest,
    recovery: PrivateDeliveryVerificationRecoveryV1,
  ): Promise<void> {
    const verification = await this.verificationService.verify({
      verificationAttemptId,
      verificationRequestDigest: recovery.verificationRequestDigest ?? verificationRequestDigest,
      deliveryChangeSet: recovery.deliveryChangeSet,
      worktreeRoot: recovery.privateIntegrationContext.worktreeRoot,
      trustedToolchainRoot: recovery.privateIntegrationContext.trustedToolchainRoot,
    })
    const passedChangeSet = verification.receipt.verdict === 'PASS'
      ? {
          ...recovery.deliveryChangeSet,
          evidenceArtifactIds: verification.receipt.evidenceArtifactIds,
          digest: deliveryChangeSetDigestWithEvidence(recovery.deliveryChangeSet, verification.receipt.evidenceArtifactIds),
        }
      : undefined
    const finalReceipt = passedChangeSet
      ? retargetDeliveryReceipt(verification.receipt, passedChangeSet)
      : verification.receipt
    this.store.completeDeliveryVerification(address, {
      receipt: finalReceipt,
      ...(passedChangeSet
        ? {
            deliveryChangeSet: passedChangeSet,
            deliveryFileArtifacts: recovery.fileArtifacts.map(toDeliveryFileArtifact),
            gateId: this.id('xhbdg') as DeliveryGateId,
          }
        : {}),
      evidenceArtifacts: verification.artifacts.filter((artifact) => artifact.kind === 'VERIFICATION_EVIDENCE'),
      diagnosticArtifacts: verification.artifacts.filter((artifact) => artifact.kind === 'VERIFICATION_DIAGNOSTIC'),
      now: this.now(),
    })
    await this.cleanupIntegrationRoot(recovery.privateIntegrationContext)
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = Promise.allSettled([
      ...this.inFlight.values(),
      ...(this.recoveryPromise ? [this.recoveryPromise] : []),
    ]).then(() => {
      if (this.closed) return
      this.closed = true
      this.store.close()
    })
    return this.closePromise
  }

  private async cleanupIntegrationRoot(context: PrivateDeliveryVerificationRecoveryV1['privateIntegrationContext']): Promise<void> {
    try {
      await cleanupDeliveryIntegrationWorktreeRootV1(context.trustedToolchainRoot, context.worktreeRoot)
    } finally {
      this.integrationRoots.delete(context.worktreeRoot)
    }
  }

  private async applyApproved(
    address: HubAddressV1,
    batchId: DeliveryBatchId,
    approval: DeliveryApprovalSubjectV1,
    applyAttemptId: DeliveryApplyAttemptId,
  ): Promise<DeliveryApplyReceiptV1> {
    const changeSet = this.store.readDeliveryChangeSet(approval.deliveryChangeSetId)
    if (!changeSet) throw new Error('DELIVERY_CHANGESET_NOT_FOUND')
    const requestDigest = deliveryApplyRequestDigestV1({
      applyAttemptId,
      deliveryChangeSetId: changeSet.deliveryChangeSetId,
      deliveryChangeSetDigest: changeSet.digest,
      approval,
      targetFingerprint: changeSet.target.initialTargetFingerprint,
    })
    this.store.beginDeliveryApply(address, {
      applyAttemptId,
      batchId,
      deliveryChangeSetId: changeSet.deliveryChangeSetId,
      requestDigest,
      requestJson: JSON.stringify({ scope: 'DELIVERY_APPLY', applyAttemptId, deliveryChangeSetId: changeSet.deliveryChangeSetId, requestDigest }),
      targetFingerprintBefore: changeSet.target.initialTargetFingerprint,
      now: this.now(),
    })
    const claim = this.store.claimDeliveryApplyOutbox({
      applyAttemptId,
      ownerId: DELIVERY_OUTBOX_OWNER_V1,
      claimDigest: digestForClaim('delivery.apply', applyAttemptId, requestDigest),
      now: this.now(),
    })
    if (!claim) throw new Error('DELIVERY_APPLY_OUTBOX_NOT_CLAIMED')
    const receipt = await this.runClaimedApply(changeSet, approval, applyAttemptId)
    this.store.completeDeliveryApply(address, {
      applyAttemptId,
      outcome: applyOutcome(receipt),
      receipt,
      now: this.now(),
    })
    return receipt
  }

  private async runClaimedApply(
    changeSet: DeliveryChangeSetV1,
    approval: DeliveryApprovalSubjectV1,
    applyAttemptId: DeliveryApplyAttemptId,
  ): Promise<DeliveryApplyReceiptV1> {
    const packageRecord = this.store.readDeliveryApplyPackage(applyAttemptId)
    const fileContents = packageRecord
      ? packageRecord.fileArtifacts.map((artifact): DeliveryApplyFileContentV1 => ({
          relativePath: changeSet.fileChanges.find((file) => file.contentArtifactId === artifact.artifactId)?.relativePath ?? '',
          contentArtifactId: artifact.artifactId,
          contentDigest: artifact.contentDigest,
          content: artifact.content,
        }))
      : []
    try {
      return await this.options.applyPort.apply({ applyAttemptId, approval, changeSet, fileContents })
    } catch (error) {
      if (isPreStartChangeApplyErrorV1(error)) {
        return failedRolledBackApplyReceipt(applyAttemptId, changeSet.deliveryChangeSetId, error.reasonCode)
      }
      return unknownApplyReceipt(applyAttemptId, changeSet.deliveryChangeSetId, 'TARGET_WRITE_FAILED')
    }
  }

  private async inspectOrResumeClaimedApply(
    applyAttemptId: DeliveryApplyAttemptId,
    changeSet: DeliveryChangeSetV1,
    approval: DeliveryApprovalSubjectV1,
  ): Promise<DeliveryApplyReceiptV1> {
    try {
      return await this.options.applyPort.inspect(applyAttemptId)
    } catch (error) {
      if (isApplyAttemptNotFound(error)) {
        return this.runClaimedApply(changeSet, approval, applyAttemptId)
      }
      return unknownApplyReceipt(applyAttemptId, changeSet.deliveryChangeSetId, 'APPLY_ATTEMPT_NOT_FOUND')
    }
  }

  private deliveryTaskInputs(taskChangeSetIds: readonly TaskChangeSetId[]): readonly DeliveryComposerTaskInputV1[] {
    return taskChangeSetIds.map((taskChangeSetId) => {
      const changeSet = this.store.readTaskChangeSet(taskChangeSetId)
      if (!changeSet) throw new Error('TASK_CHANGESET_NOT_FOUND')
      const artifact = this.store.readArtifact(changeSet.patchArtifactId)
      if (!artifact || artifact.kind !== 'PATCH') throw new Error('PATCH_ARTIFACT_NOT_FOUND')
      return {
        changeSet,
        patchArtifact: {
          artifactId: artifact.artifactId,
          digest: artifact.contentDigest,
          bytes: artifact.content,
        },
      }
    })
  }

  private async captureDeliveryTarget(address: HubAddressV1, flowId: FlowId): Promise<DeliveryTargetV1> {
    const baseline = await this.options.baselineProvider.capture({ address, flowId, planRevisionId: null })
    if (!baseline.baseRevision) throw new Error('DELIVERY_BASELINE_UNAVAILABLE')
    const target = {
      projectId: address.projectId,
      baseRevision: baseline.baseRevision,
      baselineTreeHash: baseline.baselineTreeHash,
    }
    return {
      ...target,
      initialTargetFingerprint: deliveryTargetFingerprintV1(target),
    }
  }

  private okProjection(batchId: DeliveryBatchId): XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1> {
    const projection = this.store.readDeliveryProjection(batchId)
    return projection ? { ok: true, value: projection } : fail('DELIVERY_NOT_FOUND')
  }

  private singleFlight(
    key: string,
    run: () => Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>>,
  ): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
    const existing = this.inFlight.get(key)
    if (existing) return existing
    if (this.closing || this.closed) return Promise.resolve(fail('INTERNAL'))
    const task = run().finally(() => {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key)
    })
    this.inFlight.set(key, task)
    return task
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  private id(prefix: string): string {
    return this.options.idFactory?.(prefix) ?? `${prefix}_${randomUUID()}`
  }

  private baselineRecoveryPort(): DeliveryBaselineRecoveryPortV1 {
    return this.options.baselineRecoveryPort ?? new MainProcessDeliveryBaselineRecoveryPortV1({
      projectResolver: this.options.projectResolver,
      managedRoot: this.options.deliveryManagedRoot,
    })
  }
}

function deliveryVerificationRequest(
  verificationAttemptId: DeliveryVerificationAttemptId,
  changeSet: DeliveryChangeSetV1,
): DeliveryVerificationRequestV1 {
  const withoutDigest = {
    scope: 'DELIVERY' as const,
    verificationAttemptId,
    verificationRequestId: `xhbdvr_${randomUUID()}`,
    batchId: changeSet.batchId,
    flowId: changeSet.flowId,
    selectionDigest: changeSet.selectionDigest,
    targetFingerprint: changeSet.target.initialTargetFingerprint,
    deliveryChangeSetDigest: changeSet.digest,
    qaConfigVersion: changeSet.qaConfigVersion,
  }
  return { ...withoutDigest, requestDigest: deliveryVerificationRequestDigestV1(withoutDigest) }
}

function deliveryChangeSetDigestWithEvidence(
  changeSet: DeliveryChangeSetV1,
  evidenceArtifactIds: readonly ArtifactId[],
): Sha256Digest {
  const { digest: _oldDigest, ...base } = changeSet
  const withoutDigest = { ...base, evidenceArtifactIds }
  return deliveryChangeSetDigestV1(withoutDigest)
}

function retargetDeliveryReceipt(
  receipt: import('@shared/xiaogui-delivery').DeliveryVerificationReceiptV1,
  changeSet: DeliveryChangeSetV1,
): import('@shared/xiaogui-delivery').DeliveryVerificationReceiptV1 {
  const withoutDigest = {
    ...receipt,
    deliveryChangeSetDigest: changeSet.digest,
    evidenceArtifactIds: receipt.verdict === 'PASS' ? receipt.evidenceArtifactIds : [],
  }
  return { ...withoutDigest, receiptDigest: deliveryVerificationReceiptDigestV1(withoutDigest) } as import('@shared/xiaogui-delivery').DeliveryVerificationReceiptV1
}

function toDeliveryFileArtifact(artifact: DeliveryComposedFileArtifactV1) {
  return {
    artifactId: artifact.artifactId,
    contentDigest: artifact.contentDigest,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    content: artifact.content,
  }
}

function serializeVerificationRecovery(input: PrivateDeliveryVerificationRecoveryV1) {
  return {
    verificationRequestDigest: input.verificationRequestDigest,
    deliveryChangeSet: input.deliveryChangeSet,
    privateIntegrationContext: input.privateIntegrationContext,
    fileArtifacts: input.fileArtifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      contentDigest: artifact.contentDigest,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      contentBase64: Buffer.from(artifact.content).toString('base64'),
    })),
  }
}

function parseVerificationRecovery(requestJson: string): PrivateDeliveryVerificationRecoveryV1 | null {
  try {
    const parsed = JSON.parse(requestJson) as {
      requestDigest?: Sha256Digest
      privateRecovery?: {
        verificationRequestDigest?: Sha256Digest
        deliveryChangeSet?: DeliveryChangeSetV1
        privateIntegrationContext?: PrivateDeliveryVerificationRecoveryV1['privateIntegrationContext']
        fileArtifacts?: Array<{
          artifactId: ArtifactId
          contentDigest: Sha256Digest
          kind: 'DELIVERY_FILE_CONTENT'
          mediaType: 'application/vnd.xiaogui.delivery-file-content'
          contentBase64: string
        }>
      }
    }
    const recovery = parsed.privateRecovery
    if (!recovery?.deliveryChangeSet || !recovery.privateIntegrationContext || !Array.isArray(recovery.fileArtifacts)) return null
    return {
      ...(typeof recovery.verificationRequestDigest === 'string'
        ? { verificationRequestDigest: recovery.verificationRequestDigest }
        : typeof parsed.requestDigest === 'string'
          ? { verificationRequestDigest: parsed.requestDigest }
          : {}),
      deliveryChangeSet: recovery.deliveryChangeSet,
      privateIntegrationContext: recovery.privateIntegrationContext,
      fileArtifacts: recovery.fileArtifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        contentDigest: artifact.contentDigest,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        content: Buffer.from(artifact.contentBase64, 'base64'),
      })),
    }
  } catch {
    return null
  }
}

function applyOutcome(receipt: DeliveryApplyReceiptV1): 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN' {
  if (receipt.verdict === 'SUCCEEDED') return 'SUCCEEDED'
  if (receipt.verdict === 'FAILED_ROLLED_BACK') return 'FAILED'
  return 'OUTCOME_UNKNOWN'
}

function approvalSubject(changeSet: DeliveryChangeSetV1): DeliveryApprovalSubjectV1 {
  return {
    deliveryChangeSetId: changeSet.deliveryChangeSetId,
    version: changeSet.version,
    digest: changeSet.digest,
  }
}

function isApplyAttemptNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const values = [
    'reasonCode' in error ? (error as { reasonCode?: unknown }).reasonCode : undefined,
    'code' in error ? (error as { code?: unknown }).code : undefined,
    error instanceof Error ? error.message : undefined,
  ]
  return values.some((value) => value === 'APPLY_ATTEMPT_NOT_FOUND')
}

function unknownApplyReceipt(
  applyAttemptId: DeliveryApplyAttemptId,
  deliveryChangeSetId: DeliveryChangeSetId,
  safeCode: 'TARGET_WRITE_FAILED' | 'APPLY_ATTEMPT_NOT_FOUND',
): DeliveryApplyReceiptV1 {
  const withoutDigest = {
    applyAttemptId,
    deliveryChangeSetId,
    verdict: 'OUTCOME_UNKNOWN' as const,
    changedRelativePaths: [] as readonly string[],
    safeCode,
  }
  return { ...withoutDigest, receiptDigest: deliveryApplyReceiptDigestV1(withoutDigest) }
}

function failedRolledBackApplyReceipt(
  applyAttemptId: DeliveryApplyAttemptId,
  deliveryChangeSetId: DeliveryChangeSetId,
  safeCode: Extract<DeliveryApplyReceiptV1, { verdict: 'FAILED_ROLLED_BACK' }>['safeCode'],
): DeliveryApplyReceiptV1 {
  const withoutDigest = {
    applyAttemptId,
    deliveryChangeSetId,
    verdict: 'FAILED_ROLLED_BACK' as const,
    changedRelativePaths: [] as readonly string[],
    safeCode,
  }
  return { ...withoutDigest, receiptDigest: deliveryApplyReceiptDigestV1(withoutDigest) }
}

function digestForClaim(scope: string, id: string, digest: string): string {
  return `${scope}:${id}:${digest}`
}

function fail(code: 'DELIVERY_INPUT_INVALID' | 'STALE_DELIVERY_SUBJECT' | 'DELIVERY_NOT_FOUND' | 'ILLEGAL_TRANSITION' | 'INTERNAL'): XiaoguiDeliveryOutcomeV1<never> {
  return {
    ok: false,
    error: {
      code,
      messageKey: `xiaogui.delivery.${code.toLowerCase()}`,
      traceId: `xhbd_${randomUUID()}`,
    },
  }
}

function mapDeliveryError(error: unknown): XiaoguiDeliveryOutcomeV1<never> {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : error instanceof Error
      ? error.message
      : ''
  if (code.includes('STALE') || code.includes('SUBJECT')) return fail('STALE_DELIVERY_SUBJECT')
  if (code.includes('NOT_FOUND')) return fail('DELIVERY_NOT_FOUND')
  if (code.includes('ILLEGAL') || code.includes('CONFLICT') || code.includes('DRIFT')) return fail('ILLEGAL_TRANSITION')
  return fail('INTERNAL')
}

export function createXiaoguiDeliveryWorkflowV1(options: XiaoguiDeliveryWorkflowOptionsV1): XiaoguiDeliveryWorkflowV1 {
  return new XiaoguiDeliveryWorkflowV1(options)
}
