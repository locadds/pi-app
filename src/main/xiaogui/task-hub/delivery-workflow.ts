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
import type { DeliveryApplyFileContentV1, DeliveryApplyPortV1 } from './change-apply'
import type { TaskVerificationExecutionPortV1 } from './verification-port'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'
import {
  deliveryApplyReceiptDigestV1,
  deliveryApplyRequestDigestV1,
  deliveryChangeSetDigestV1,
  deliveryGateDecisionDigestV1,
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
  type DeliveryTargetV1,
  type DeliveryVerificationAttemptId,
  type DeliveryVerificationRequestV1,
} from '@shared/xiaogui-delivery'
import type {
  XiaoguiDeliveryApproveGateRequestV1,
  XiaoguiDeliveryCoordinatorPortV1,
  XiaoguiDeliveryOutcomeV1,
  XiaoguiDeliveryReconcileApplyRequestV1,
  XiaoguiDeliveryReturnBatchRequestV1,
  XiaoguiDeliveryRetryApplyRequestV1,
  XiaoguiDeliverySelectTasksRequestV1,
} from '@shared/xiaogui-delivery-ipc'
import type { FlowId, HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import type { ArtifactId, Sha256Digest, TaskChangeSetId } from '@shared/xiaogui-task-verification'

const DELIVERY_QA_CONFIG_VERSION_V1 = 'xiaogui.coding.delivery.v1'
const DELIVERY_OUTBOX_OWNER_V1 = 'xiaogui-main-process-delivery'

interface PrivateDeliveryVerificationRecoveryV1 {
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
        await this.completeRecoveredVerification(address, verificationAttemptId, {
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
        const receipt = await this.inspectOrUnknown(applyAttemptId, packageRecord.changeSet.deliveryChangeSetId)
        this.store.completeDeliveryApply(address, {
          applyAttemptId,
          outcome: applyOutcome(receipt),
          receiptDigest: receipt.receiptDigest,
          ...('targetFingerprint' in receipt ? { targetFingerprintAfter: receipt.targetFingerprint } : {}),
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
        if (!failed || failed.batchId !== request.batchId || failed.state !== 'FAILED') return fail('ILLEGAL_TRANSITION')
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

  async recover(): Promise<void> {
    if (this.closing || this.closed) return
    for (const pending of this.store.pendingDeliveryVerificationOutboxes()) {
      try {
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
        await this.completeRecoveredVerification(pending.address, outbox.verificationAttemptId, recovery)
      } catch {
        // Explicit user retry/reconcile remains possible; recovery must not throw during startup.
      }
    }
    for (const pending of this.store.pendingDeliveryApplyOutboxes()) {
      try {
        const outbox = pending.outbox
        const packageRecord = this.store.readDeliveryApplyPackage(outbox.applyAttemptId)
        if (!packageRecord) continue
        const approval = {
              deliveryChangeSetId: packageRecord.changeSet.deliveryChangeSetId,
              version: packageRecord.changeSet.version,
              digest: packageRecord.changeSet.digest,
            } as DeliveryApprovalSubjectV1
        if (outbox.status === 'READY') {
          const claim = this.store.claimDeliveryApplyOutbox({
            applyAttemptId: outbox.applyAttemptId,
            ownerId: DELIVERY_OUTBOX_OWNER_V1,
            claimDigest: digestForClaim('delivery.apply.recover', outbox.applyAttemptId, outbox.requestDigest),
            now: this.now(),
          })
          if (!claim) continue
        }
        const receipt = outbox.status === 'READY'
          ? await this.runClaimedApply(packageRecord.changeSet, approval, outbox.applyAttemptId)
          : await this.inspectOrUnknown(outbox.applyAttemptId, packageRecord.changeSet.deliveryChangeSetId)
        this.store.completeDeliveryApply(pending.address, {
          applyAttemptId: outbox.applyAttemptId,
          outcome: applyOutcome(receipt),
          receiptDigest: receipt.receiptDigest,
          ...('targetFingerprint' in receipt ? { targetFingerprintAfter: receipt.targetFingerprint } : {}),
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
    recovery: PrivateDeliveryVerificationRecoveryV1,
  ): Promise<void> {
    const verification = await this.verificationService.verify({
      verificationAttemptId,
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
    this.closePromise = Promise.allSettled([...this.inFlight.values()]).then(() => {
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
      receiptDigest: receipt.receiptDigest,
      ...('targetFingerprint' in receipt ? { targetFingerprintAfter: receipt.targetFingerprint } : {}),
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
    } catch {
      return unknownApplyReceipt(applyAttemptId, changeSet.deliveryChangeSetId, 'TARGET_WRITE_FAILED')
    }
  }

  private async inspectOrUnknown(
    applyAttemptId: DeliveryApplyAttemptId,
    deliveryChangeSetId: DeliveryChangeSetId,
  ): Promise<DeliveryApplyReceiptV1> {
    try {
      return await this.options.applyPort.inspect(applyAttemptId)
    } catch {
      return unknownApplyReceipt(applyAttemptId, deliveryChangeSetId, 'APPLY_ATTEMPT_NOT_FOUND')
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
      privateRecovery?: {
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
