import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  deliveryChangeSetDigestV1,
  deliveryTargetFingerprintV1,
  type DeliveryApplyAttemptId,
  type DeliveryApplyReceiptV1,
  type DeliveryApplySafeCodeV1,
  type DeliveryBatchId,
  type DeliveryBatchProjectionV1,
  type DeliveryChangeSetId,
  type DeliveryChangeSetV1,
  type DeliveryGateId,
  type DeliverySelectionDraftV1,
} from '@shared/xiaogui-delivery'
import type { HubAddressV1, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import {
  taskChangeSetDigestV1,
  verificationReceiptDigestV1,
  type ArtifactId,
  type Sha256Digest,
  type TaskChangeSetId,
  type TaskChangeSetV1,
} from '@shared/xiaogui-task-verification'

import { XiaoguiDeliveryWorkflowV1 } from './delivery-workflow'
import type { CollaborationHubSqliteStoreV1 } from './sqlite-store'
import { ChangeApplyErrorV1, type DeliveryApplyPortV1 } from './change-apply'
import type { TaskVerificationExecutionPortV1, TaskVerificationExecutionResultV1 } from './verification-port'
import type { DeliveryBaselineRecoveryPortV1 } from './delivery-baseline-recovery'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as HubAddressV1

describe('XiaoguiDeliveryWorkflowV1', () => {
  it('composes two verified tasks, runs delivery verification, and opens review without applying', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaogui-delivery-workflow-'))
    const repo = join(root, 'repo')
    await git(root, ['init', 'repo'])
    await writeFile(join(repo, 'a.txt'), 'old-a')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'])
    const baseRevision = (await git(repo, ['rev-parse', '--verify', 'HEAD'])).trim()
    const baselineTreeHash = (await git(repo, ['rev-parse', '--verify', 'HEAD^{tree}'])).trim()
    const targetFingerprint = deliveryTargetFingerprintV1({ projectId: ADDRESS.projectId, baseRevision, baselineTreeHash })
    const store = new FakeDeliveryStore(targetFingerprint)
    const applyPort = recordingApplyPort()
    const workflow = workflowFor(store, repo, join(root, 'managed'), applyPort, baseRevision, baselineTreeHash)

    const outcome = await workflow.selectTasks(ADDRESS, {
      requestId: 'select-1',
      flowId: 'flow-1' as never,
      taskRunIds: ['task-a', 'task-b'] as never,
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.ok ? outcome.value.state : null).toBe('READY_FOR_REVIEW')
    expect(store.trace).toEqual([
      'create-selection',
      'begin-verification',
      'claim-verification',
      'complete-verification:PASS',
    ])
    expect(applyPort.applies).toHaveLength(0)
    await rm(root, { recursive: true, force: true })
  })

  it('returns a review batch without calling apply', async () => {
    const store = new FakeDeliveryStore('sha256:target' as Sha256Digest)
    store.projection = { ...store.projection, state: 'READY_FOR_REVIEW', gate: store.gate }
    const applyPort = recordingApplyPort()
    const workflow = workflowFor(store, 'repo', 'managed', applyPort)

    const outcome = await workflow.returnBatch(ADDRESS, {
      requestId: 'return-1',
      gateId: store.gate.gateId,
      subject: store.gate.subject,
    })

    expect(outcome.ok).toBe(true)
    expect(store.trace).toEqual(['decide:REJECT'])
    expect(applyPort.applies).toHaveLength(0)
  })

  it('records OUTCOME_UNKNOWN when reconcile cannot inspect an apply attempt', async () => {
    const store = new FakeDeliveryStore('sha256:target' as Sha256Digest)
    store.installAppliedChangeSet()
    store.projection = {
      ...store.projection,
      state: 'APPLYING',
      applyAttempt: {
        applyAttemptId: 'apply-1' as DeliveryApplyAttemptId,
        batchId: store.batchId,
        deliveryChangeSetId: store.deliveryChangeSetId,
        requestDigest: 'sha256:req' as Sha256Digest,
        targetFingerprintBefore: 'sha256:target' as Sha256Digest,
        state: 'STARTED',
        startedAt: '2026-08-18T00:00:00.000Z' as never,
      },
    }
    const applyPort = recordingApplyPort({ inspectThrows: true })
    const workflow = workflowFor(store, 'repo', 'managed', applyPort)

    const outcome = await workflow.reconcileApply(ADDRESS, {
      requestId: 'reconcile-1',
      batchId: store.batchId,
      applyAttemptId: 'apply-1' as DeliveryApplyAttemptId,
    })

    expect(outcome.ok).toBe(true)
    expect(store.trace).toContain('complete-apply:OUTCOME_UNKNOWN')
  })

  it('resumes a claimed apply during reconcile when the started registry record is missing', async () => {
    const store = new FakeDeliveryStore('sha256:target' as Sha256Digest)
    store.installAppliedChangeSet()
    store.projection = {
      ...store.projection,
      state: 'APPLYING',
      applyAttempt: {
        applyAttemptId: 'apply-1' as DeliveryApplyAttemptId,
        batchId: store.batchId,
        deliveryChangeSetId: store.deliveryChangeSetId,
        requestDigest: 'sha256:req' as Sha256Digest,
        targetFingerprintBefore: 'sha256:target' as Sha256Digest,
        state: 'STARTED',
        startedAt: '2026-08-18T00:00:00.000Z' as never,
      },
    }
    const applyPort = recordingApplyPort({ inspectErrorCode: 'APPLY_ATTEMPT_NOT_FOUND' })
    const workflow = workflowFor(store, 'repo', 'managed', applyPort)

    const outcome = await workflow.reconcileApply(ADDRESS, {
      requestId: 'reconcile-resume',
      batchId: store.batchId,
      applyAttemptId: 'apply-1' as DeliveryApplyAttemptId,
    })

    expect(outcome.ok).toBe(true)
    expect(applyPort.applies).toHaveLength(1)
    expect(store.trace).toContain('complete-apply:SUCCEEDED')
  })

  it('recovers READY and CLAIMED delivery verification outboxes to terminal UNKNOWN when the port throws', async () => {
    const store = new FakeDeliveryStore('sha256:target' as Sha256Digest)
    store.installPendingVerificationOutboxes()
    const workflow = workflowFor(
      store,
      'repo',
      'managed',
      recordingApplyPort(),
      undefined,
      undefined,
      throwingVerificationPort(),
    )

    await workflow.recover()

    expect(store.trace).toContain('claim-verification')
    expect(store.trace.filter((item) => item === 'complete-verification:OUTCOME_UNKNOWN')).toHaveLength(2)
  })

  it('resumes claimed apply recovery when the started registry record is missing', async () => {
    const store = new FakeDeliveryStore('sha256:target' as Sha256Digest)
    store.installPendingApplyOutbox('CLAIMED')
    const applyPort = recordingApplyPort({ inspectErrorCode: 'APPLY_ATTEMPT_NOT_FOUND' })
    const workflow = workflowFor(store, 'repo', 'managed', applyPort)

    await workflow.recover()

    expect(applyPort.applies).toHaveLength(1)
    expect(store.trace).toContain('complete-apply:SUCCEEDED')
  })

  it('records pre-write baseline drift as a deterministic failed receipt instead of outcome unknown', async () => {
    const store = new FakeDeliveryStore('sha256:target' as Sha256Digest)
    store.installPendingApplyOutbox('READY')
    const applyPort = recordingApplyPort({ applyErrorCode: 'TARGET_BASELINE_DRIFT' })
    const workflow = workflowFor(store, 'repo', 'managed', applyPort)

    await workflow.recover()

    expect(applyPort.applies).toHaveLength(1)
    expect(store.trace).toContain('complete-apply:FAILED')
    expect(store.completedApplyReceipts).toEqual([
      expect.objectContaining({
        verdict: 'FAILED_ROLLED_BACK',
        safeCode: 'TARGET_BASELINE_DRIFT',
        changedRelativePaths: [],
      }),
    ])
  })

  it('prepares one recovered delivery batch and replays the same batch after cleanup-before-seal', async () => {
    const store = new FakeDeliveryStore('sha256:target' as Sha256Digest)
    store.installFailedBaselineDriftApplyPackage()
    const recoveryPort = recordingBaselineRecoveryPort(store.trace)
    const workflow = workflowFor(
      store,
      'repo',
      'managed',
      recordingApplyPort(),
      undefined,
      undefined,
      recordingPassVerificationPort(store.trace),
      recoveryPort,
    )

    const first = await workflow.prepareRecovery(ADDRESS, {
      requestId: 'recovery-1',
      batchId: store.batchId,
      failedApplyAttemptId: 'apply-1' as DeliveryApplyAttemptId,
    })
    const second = await workflow.prepareRecovery(ADDRESS, {
      requestId: 'recovery-2',
      batchId: store.batchId,
      failedApplyAttemptId: 'apply-1' as DeliveryApplyAttemptId,
    })

    expect(first).toMatchObject({ ok: true, value: { batchId: 'xhbd_batch_fixed', recoverySourceBatchId: store.batchId } })
    expect(second).toMatchObject({ ok: true, value: { batchId: 'xhbd_batch_fixed', recoverySourceBatchId: store.batchId } })
    expect(store.trace.filter((item) => item === 'recover-baseline')).toHaveLength(1)
    expect(store.trace.indexOf('cleanup-recovery')).toBeGreaterThan(store.trace.indexOf('verify-recovery'))
    expect(store.trace.indexOf('cleanup-recovery')).toBeLessThan(store.trace.indexOf('recheck-target'))
    expect(store.trace.indexOf('recheck-target')).toBeLessThan(store.trace.indexOf('seal-recovery'))
  })

  it('waits for in-flight work before closing the store and rejects new calls while closing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaogui-delivery-close-'))
    const repo = join(root, 'repo')
    await git(root, ['init', 'repo'])
    await writeFile(join(repo, 'a.txt'), 'old-a')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'])
    const baseRevision = (await git(repo, ['rev-parse', '--verify', 'HEAD'])).trim()
    const baselineTreeHash = (await git(repo, ['rev-parse', '--verify', 'HEAD^{tree}'])).trim()
    const targetFingerprint = deliveryTargetFingerprintV1({ projectId: ADDRESS.projectId, baseRevision, baselineTreeHash })
    const store = new FakeDeliveryStore(targetFingerprint)
    const verification = deferredPassVerificationPort()
    const workflow = workflowFor(
      store,
      repo,
      join(root, 'managed'),
      recordingApplyPort(),
      baseRevision,
      baselineTreeHash,
      verification.port,
    )

    const select = workflow.selectTasks(ADDRESS, {
      requestId: 'select-close',
      flowId: 'flow-1' as never,
      taskRunIds: ['task-a', 'task-b'] as never,
    })
    await waitForTrace(store, 'claim-verification')

    const close = workflow.close()
    expect(store.trace).not.toContain('close')
    await expect(workflow.returnBatch(ADDRESS, {
      requestId: 'return-after-close',
      gateId: store.gate.gateId,
      subject: store.gate.subject,
    })).resolves.toMatchObject({ ok: false })

    verification.resolve()
    await expect(select).resolves.toMatchObject({ ok: true })
    await close
    expect(store.trace.at(-1)).toBe('close')

    await rm(root, { recursive: true, force: true })
  })

  it('waits for startup recovery before closing the store', async () => {
    const store = new FakeDeliveryStore('sha256:target' as Sha256Digest)
    store.installPendingVerificationOutboxes()
    const verification = deferredPassVerificationPort()
    const workflow = workflowFor(
      store,
      'repo',
      'managed',
      recordingApplyPort(),
      undefined,
      undefined,
      verification.port,
    )

    const recovery = workflow.recover()
    await waitForTrace(store, 'claim-verification')
    const close = workflow.close()
    expect(store.trace).not.toContain('close')

    verification.resolve()
    await recovery
    await close

    expect(store.trace).toContain('complete-verification:PASS')
    expect(store.trace.at(-1)).toBe('close')
  })
})

class FakeDeliveryStore {
  readonly batchId = 'batch-1' as DeliveryBatchId
  readonly deliveryChangeSetId = 'delivery-cs-1' as DeliveryChangeSetId
  readonly gate = {
    gateId: 'gate-1' as DeliveryGateId,
    batchId: 'batch-1' as DeliveryBatchId,
    subject: {
      deliveryChangeSetId: 'delivery-cs-1' as DeliveryChangeSetId,
      version: 1 as const,
      digest: 'sha256:pending' as Sha256Digest,
    },
    state: 'OPEN' as const,
    createdAt: '2026-08-18T00:00:00.000Z' as never,
  }
  readonly trace: string[] = []
  readonly completedApplyReceipts: DeliveryApplyReceiptV1[] = []
  readonly taskChangeSets: TaskChangeSetV1[]
  readonly artifacts = new Map<string, { artifactId: ArtifactId; kind: string; mediaType: string; contentDigest: Sha256Digest; content: Uint8Array }>()
  pendingVerificationOutboxes: Array<{
    address: HubAddressV1
    outbox: {
      verificationAttemptId: string
      requestDigest: Sha256Digest
      requestJson: string
      status: 'READY' | 'CLAIMED'
    }
  }> = []
  pendingApplyOutboxes: Array<{
    address: HubAddressV1
    outbox: {
      applyAttemptId: DeliveryApplyAttemptId
      requestDigest: Sha256Digest
      requestJson: string
      status: 'READY' | 'CLAIMED'
    }
  }> = []
  projection: DeliveryBatchProjectionV1
  private sealedChangeSet: DeliveryChangeSetV1 | null = null
  private recoveredProjection: DeliveryBatchProjectionV1 | null = null
  private applyPackageAttemptState: 'STARTED' | 'FAILED' | 'FAILED_ROLLED_BACK' = 'STARTED'
  private applyPackageSafeCode: DeliveryApplySafeCodeV1 | undefined
  private applyPackageChangedRelativePaths: readonly string[] = []

  constructor(targetFingerprint: Sha256Digest) {
    this.taskChangeSets = [
      taskChangeSet('a', [], 'task-a' as never),
      taskChangeSet('b', ['xhbcs_a' as TaskChangeSetId], 'task-b' as never),
    ]
    this.artifacts.set('patch-a', patchArtifact('a.txt', 'MODIFY', 'old-a', 'new-a'))
    this.artifacts.set('patch-b', patchArtifact('nested/b.txt', 'CREATE', null, 'new-b'))
    this.projection = {
      batchId: this.batchId,
      flowId: 'flow-1' as never,
      state: 'COMPOSING',
      selectionDigest: 'sha256:selection' as Sha256Digest,
      selectedTaskRunIds: ['task-a', 'task-b'] as never,
      taskChangeSetIds: this.taskChangeSets.map((item) => item.taskChangeSetId),
      targetFingerprint,
    }
  }

  createDeliverySelection(): { batchId: DeliveryBatchId; selectionDigest: Sha256Digest; replayed: boolean } {
    this.trace.push('create-selection')
    return { batchId: this.batchId, selectionDigest: this.projection.selectionDigest, replayed: false }
  }

  readDeliveryProjection(batchId?: DeliveryBatchId): DeliveryBatchProjectionV1 {
    if (batchId && this.recoveredProjection?.batchId === batchId) return this.recoveredProjection
    return this.projection
  }

  readRecoveredDeliveryProjection(): DeliveryBatchProjectionV1 | null {
    this.trace.push('read-recovered')
    return this.recoveredProjection
  }

  readDeliverySelectionDraft(): DeliverySelectionDraftV1 {
    return {
      kind: 'DELIVERY_SELECTION_DRAFT',
      version: 1,
      draftId: 'draft-1' as never,
      batchId: this.batchId,
      flowId: 'flow-1' as never,
      selectedTaskRunIds: ['task-a', 'task-b'] as never,
      resolvedTaskChangeSets: this.taskChangeSets.map((item) => ({
        taskRunId: item.taskRunId,
        taskChangeSetId: item.taskChangeSetId,
        digest: item.digest,
        patchArtifactId: item.patchArtifactId,
        dependsOn: item.ancestorTaskChangeSetIds,
      })),
      dependencyTaskRunIds: ['task-a', 'task-b'] as never,
      targetFingerprint: this.projection.targetFingerprint,
      createdAt: '2026-08-18T00:00:00.000Z' as never,
      digest: this.projection.selectionDigest,
    }
  }

  readTaskChangeSet(id: TaskChangeSetId): TaskChangeSetV1 | null {
    return this.taskChangeSets.find((item) => item.taskChangeSetId === id) ?? null
  }

  readArtifact(id: ArtifactId) {
    return this.artifacts.get(id)
  }

  beginDeliveryVerification(): void {
    this.trace.push('begin-verification')
    this.projection = { ...this.projection, state: 'VERIFYING' }
  }

  claimDeliveryVerificationOutbox() {
    this.trace.push('claim-verification')
    return { status: 'CLAIMED' }
  }

  pendingDeliveryVerificationOutboxes() {
    return this.pendingVerificationOutboxes
  }

  completeDeliveryVerification(_address: HubAddressV1, record: { receipt: { verdict: string }; deliveryChangeSet?: DeliveryChangeSetV1 }): void {
    this.trace.push(`complete-verification:${record.receipt.verdict}`)
    if (record.deliveryChangeSet) {
      this.sealedChangeSet = record.deliveryChangeSet
      this.gate.subject = {
        deliveryChangeSetId: record.deliveryChangeSet.deliveryChangeSetId,
        version: 1,
        digest: record.deliveryChangeSet.digest,
      }
      this.projection = {
        ...this.projection,
        state: 'READY_FOR_REVIEW',
        deliveryChangeSetId: record.deliveryChangeSet.deliveryChangeSetId,
        deliveryChangeSetDigest: record.deliveryChangeSet.digest,
        gate: this.gate,
      }
    }
  }

  readDeliveryGate() {
    return this.gate
  }

  decideDeliveryGate(_address: HubAddressV1, record: { decision: 'APPROVE' | 'REJECT' }): void {
    this.trace.push(`decide:${record.decision}`)
    this.projection = { ...this.projection, state: record.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' }
  }

  readDeliveryChangeSet(): DeliveryChangeSetV1 | null {
    return this.sealedChangeSet
  }

  readDeliveryChangeSetForBatch(): DeliveryChangeSetV1 | null {
    return this.sealedChangeSet
  }

  beginDeliveryApply(): void {
    this.trace.push('begin-apply')
  }

  claimDeliveryApplyOutbox() {
    this.trace.push('claim-apply')
    return { status: 'CLAIMED' }
  }

  readDeliveryApplyPackage(applyAttemptId: DeliveryApplyAttemptId) {
    if (!this.sealedChangeSet) this.installAppliedChangeSet()
    return {
      applyAttempt: {
        applyAttemptId,
        batchId: this.batchId,
        deliveryChangeSetId: this.deliveryChangeSetId,
        requestDigest: 'sha256:req' as Sha256Digest,
        targetFingerprintBefore: 'sha256:target' as Sha256Digest,
        state: this.applyPackageAttemptState,
        ...(this.applyPackageSafeCode ? { safeCode: this.applyPackageSafeCode } : {}),
        changedRelativePaths: this.applyPackageChangedRelativePaths,
        startedAt: '2026-08-18T00:00:00.000Z' as never,
      },
      changeSet: this.sealedChangeSet!,
      fileArtifacts: [],
    }
  }

  readDeliveryApplyAttempt() {
    return {
      applyAttemptId: 'apply-1' as DeliveryApplyAttemptId,
      batchId: this.batchId,
      deliveryChangeSetId: this.deliveryChangeSetId,
      requestDigest: 'sha256:req' as Sha256Digest,
      targetFingerprintBefore: 'sha256:target' as Sha256Digest,
      state: 'FAILED' as const,
      startedAt: '2026-08-18T00:00:00.000Z' as never,
    }
  }

  completeDeliveryApply(_address: HubAddressV1, record: { outcome: string; receipt: DeliveryApplyReceiptV1 }): void {
    this.trace.push(`complete-apply:${record.outcome}`)
    this.completedApplyReceipts.push(record.receipt)
    this.projection = {
      ...this.projection,
      state: record.outcome === 'SUCCEEDED' ? 'APPLIED' : record.outcome === 'FAILED' ? 'APPROVED' : 'OUTCOME_UNKNOWN',
    }
  }

  pendingDeliveryApplyOutboxes() {
    return this.pendingApplyOutboxes
  }

  sealRecoveredDeliveryCandidate(_address: HubAddressV1, record: {
    sourceBatchId: DeliveryBatchId
    batchId: DeliveryBatchId
    deliveryChangeSet: DeliveryChangeSetV1
  }): { batchId: DeliveryBatchId; replayed: boolean } {
    this.trace.push('seal-recovery')
    this.recoveredProjection = {
      ...this.projection,
      batchId: record.batchId,
      state: 'READY_FOR_REVIEW',
      recoverySourceBatchId: record.sourceBatchId,
      recoveryLineage: record.deliveryChangeSet.recoveryLineage,
      deliveryChangeSetId: record.deliveryChangeSet.deliveryChangeSetId,
      deliveryChangeSetDigest: record.deliveryChangeSet.digest,
    }
    return { batchId: record.batchId, replayed: false }
  }

  close(): void {
    this.trace.push('close')
  }

  installAppliedChangeSet(): void {
    this.sealedChangeSet = this.deliveryChangeSet()
  }

  installPendingVerificationOutboxes(): void {
    const changeSet = this.deliveryChangeSet()
    const privateRecovery = {
      deliveryChangeSet: changeSet,
      privateIntegrationContext: {
        worktreeRoot: 'D:/missing-delivery-worktree',
        trustedToolchainRoot: 'D:/missing-repo',
      },
      fileArtifacts: [],
    }
    const requestJson = JSON.stringify({ privateRecovery })
    this.pendingVerificationOutboxes = [
      {
        address: ADDRESS,
        outbox: {
          verificationAttemptId: 'verify-ready',
          requestDigest: 'sha256:req-ready' as Sha256Digest,
          requestJson,
          status: 'READY',
        },
      },
      {
        address: ADDRESS,
        outbox: {
          verificationAttemptId: 'verify-claimed',
          requestDigest: 'sha256:req-claimed' as Sha256Digest,
          requestJson,
          status: 'CLAIMED',
        },
      },
    ]
  }

  installPendingApplyOutbox(status: 'READY' | 'CLAIMED'): void {
    this.installAppliedChangeSet()
    this.pendingApplyOutboxes = [{
      address: ADDRESS,
      outbox: {
        applyAttemptId: 'apply-1' as DeliveryApplyAttemptId,
        requestDigest: 'sha256:req' as Sha256Digest,
        requestJson: '{}',
        status,
      },
    }]
  }

  installFailedBaselineDriftApplyPackage(): void {
    this.installAppliedChangeSet()
    this.applyPackageAttemptState = 'FAILED'
    this.applyPackageSafeCode = 'TARGET_BASELINE_DRIFT'
    this.applyPackageChangedRelativePaths = []
    this.projection = {
      ...this.projection,
      state: 'APPROVED',
      applyAttempt: {
        applyAttemptId: 'apply-1' as DeliveryApplyAttemptId,
        batchId: this.batchId,
        deliveryChangeSetId: this.deliveryChangeSetId,
        requestDigest: 'sha256:req' as Sha256Digest,
        targetFingerprintBefore: this.projection.targetFingerprint,
        state: 'FAILED',
        safeCode: 'TARGET_BASELINE_DRIFT',
        changedRelativePaths: [],
        startedAt: '2026-08-18T00:00:00.000Z' as never,
        finishedAt: '2026-08-18T00:00:01.000Z' as never,
      },
    }
  }

  private deliveryChangeSet() {
    const target = {
      projectId: ADDRESS.projectId,
      baseRevision: 'a'.repeat(40),
      baselineTreeHash: 'b'.repeat(40),
      initialTargetFingerprint: 'sha256:target' as Sha256Digest,
    }
    const withoutDigest = {
      kind: 'DELIVERY_CHANGESET' as const,
      version: 1 as const,
      deliveryChangeSetId: this.deliveryChangeSetId,
      batchId: this.batchId,
      selectionDraftId: 'draft-1' as never,
      flowId: 'flow-1' as never,
      selectionDigest: this.projection.selectionDigest,
      taskChangeSetIds: this.taskChangeSets.map((item) => item.taskChangeSetId),
      taskChangeSets: [],
      dependencyOrder: this.taskChangeSets.map((item) => item.taskChangeSetId),
      fileChanges: [],
      target,
      integrationTreeHash: 'sha256:tree' as Sha256Digest,
      evidenceArtifactIds: [] as ArtifactId[],
      qaConfigVersion: 'xiaogui.coding.delivery.v1',
      createdAt: '2026-08-18T00:00:00.000Z' as never,
    }
    return { ...withoutDigest, digest: deliveryChangeSetDigestV1(withoutDigest) }
  }
}

function workflowFor(
  store: FakeDeliveryStore,
  repo: string,
  managedRoot: string,
  applyPort: DeliveryApplyPortV1 & { applies: unknown[] },
  baseRevision = 'a'.repeat(40),
  baselineTreeHash = 'b'.repeat(40),
  verificationPort: TaskVerificationExecutionPortV1 = passVerificationPort(),
  baselineRecoveryPort?: DeliveryBaselineRecoveryPortV1,
): XiaoguiDeliveryWorkflowV1 {
  return new XiaoguiDeliveryWorkflowV1({
    storeFactory: () => store as unknown as CollaborationHubSqliteStoreV1,
    baselineProvider: {
      capture: async () => ({
        baselineId: 'baseline-1',
        baseRevision,
        baselineTreeHash,
        initialTargetFingerprint: 'unused',
        baselineDigest: 'unused',
      }),
    },
    projectResolver: { resolveProjectRoot: () => repo },
    deliveryManagedRoot: managedRoot,
    verificationPort,
    applyPort,
    baselineRecoveryPort,
    now: () => '2026-08-18T00:00:00.000Z',
    idFactory: (prefix) => `${prefix}_fixed`,
  })
}

function throwingVerificationPort(): TaskVerificationExecutionPortV1 {
  return {
    verify: async () => {
      throw new Error('verification failed')
    },
  }
}

function deferredPassVerificationPort(): {
  port: TaskVerificationExecutionPortV1
  resolve: () => void
} {
  let release: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    port: {
      verify: async (request, context) => {
        await ready
        return passVerificationResult(request, context.scopeEvidenceArtifactId)
      },
    },
    resolve: () => release?.(),
  }
}

function passVerificationPort(): TaskVerificationExecutionPortV1 {
  return {
    verify: async (request, context) => passVerificationResult(request, context.scopeEvidenceArtifactId),
  }
}

function recordingPassVerificationPort(trace: string[]): TaskVerificationExecutionPortV1 {
  return {
    verify: async (request, context) => {
      trace.push('verify-recovery')
      return passVerificationResult(request, context.scopeEvidenceArtifactId)
    },
  }
}

function recordingBaselineRecoveryPort(trace: string[]): DeliveryBaselineRecoveryPortV1 {
  return {
    recover: async (input) => {
      trace.push('recover-baseline')
      const currentTargetFingerprint = deliveryTargetFingerprintV1(input.currentTarget)
      return {
        files: [],
        currentTarget: input.currentTarget,
        integrationTreeHash: digest('recovered-tree'),
        privateIntegrationContext: {
          worktreeRoot: 'E:/CodexTemp/pi-app-m4f/recovery-worktree',
          trustedToolchainRoot: 'repo',
        },
        evidenceMaterial: {
          kind: 'DELIVERY_BASELINE_RECOVERY_EVIDENCE_V1',
          version: 1,
          sourceBatchId: input.sourceBatchId,
          sourceDeliveryChangeSetId: input.sourceChangeSet.deliveryChangeSetId,
          sourceDeliveryChangeSetDigest: input.sourceChangeSet.digest,
          sourceTargetFingerprint: input.sourceChangeSet.target.initialTargetFingerprint,
          currentTargetFingerprint,
          recoveredFileSetDigest: digest('recovered-files'),
          recoveredFileCount: 0,
          directReplacementCount: 0,
          threeWayMergeCount: 0,
          createCount: 0,
        },
      }
    },
    cleanup: async () => {
      trace.push('cleanup-recovery')
    },
    recheckTarget: async () => {
      trace.push('recheck-target')
    },
  }
}

function passVerificationResult(
  request: Parameters<TaskVerificationExecutionPortV1['verify']>[0],
  evidenceArtifactId: ArtifactId,
): TaskVerificationExecutionResultV1 {
  const evidence = {
    artifactId: evidenceArtifactId,
    contentDigest: digest('evidence'),
    kind: 'VERIFICATION_EVIDENCE' as const,
    mediaType: 'application/vnd.xiaogui.qa-evidence+json',
    content: Buffer.from('evidence'),
  }
  const withoutDigest = {
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
    verdict: 'PASS' as const,
    checks: [{ checkId: 'delivery.scope', summary: 'ok', artifactIds: [evidenceArtifactId], verdict: 'PASS' as const }],
    evidenceArtifactIds: [evidenceArtifactId],
    diagnosticArtifactIds: [] as ArtifactId[],
  }
  return { receipt: { ...withoutDigest, receiptDigest: verificationReceiptDigestV1(withoutDigest) }, artifacts: [evidence] }
}

function recordingApplyPort(options: {
  inspectThrows?: boolean
  inspectErrorCode?: string
  applyErrorCode?: 'TARGET_BASELINE_DRIFT'
} = {}): DeliveryApplyPortV1 & { applies: unknown[] } {
  const applies: unknown[] = []
  return {
    applies,
    apply: async (request) => {
      applies.push(request)
      if (options.applyErrorCode) throw new ChangeApplyErrorV1(options.applyErrorCode)
      const withoutDigest = {
        applyAttemptId: request.applyAttemptId,
        deliveryChangeSetId: request.changeSet.deliveryChangeSetId,
        verdict: 'SUCCEEDED' as const,
        changedRelativePaths: [] as string[],
        targetFingerprint: request.changeSet.target.initialTargetFingerprint,
      }
      return { ...withoutDigest, receiptDigest: `sha256:${'c'.repeat(64)}` as Sha256Digest } satisfies DeliveryApplyReceiptV1
    },
    inspect: async (applyAttemptId) => {
      if (options.inspectErrorCode) {
        throw Object.assign(new Error(options.inspectErrorCode), { reasonCode: options.inspectErrorCode })
      }
      if (options.inspectThrows) throw new Error('missing')
      return {
        applyAttemptId,
        deliveryChangeSetId: 'delivery-cs-1' as DeliveryChangeSetId,
        verdict: 'SUCCEEDED',
        changedRelativePaths: [],
        targetFingerprint: 'sha256:target' as Sha256Digest,
        receiptDigest: `sha256:${'d'.repeat(64)}` as Sha256Digest,
      }
    },
  }
}

function taskChangeSet(suffix: 'a' | 'b', ancestors: readonly TaskChangeSetId[], taskRunId: TaskRunId): TaskChangeSetV1 {
    const withoutDigest = {
      kind: 'TASK' as const,
      version: 1 as const,
    taskChangeSetId: `xhbcs_${suffix}` as TaskChangeSetId,
    flowId: 'flow-1' as never,
    planRevisionId: 'revision-1' as never,
    taskRunId,
    attemptId: `attempt-${suffix}` as never,
    verificationAttemptId: `verification-${suffix}` as never,
    candidateId: `candidate-${suffix}` as never,
    inputTreeHash: `sha256:${suffix.repeat(64)}` as Sha256Digest,
    resultTreeHash: `sha256:${suffix === 'a' ? '1'.repeat(64) : '2'.repeat(64)}` as Sha256Digest,
    ancestorTaskChangeSetIds: ancestors,
    patchArtifactId: `patch-${suffix}` as ArtifactId,
    evidenceBundleId: `bundle-${suffix}` as never,
    qaResultId: `qa-${suffix}` as never,
    qaConfigVersion: 'xiaogui.coding.task.v1',
    createdAt: '2026-08-18T00:00:00.000Z' as never,
  }
  return { ...withoutDigest, digest: taskChangeSetDigestV1(withoutDigest) }
}

function patchArtifact(relativePath: string, operation: 'MODIFY' | 'CREATE', oldValue: string | null, newValue: string) {
  const bytes = Buffer.from(JSON.stringify({
    kind: 'TASK_PATCH_V1',
    version: 1,
    files: [{
      operation,
      relativePath,
      baselineDigest: oldValue === null ? null : digest(oldValue),
      contentDigest: digest(newValue),
      contentBase64: Buffer.from(newValue).toString('base64'),
    }],
  }), 'utf8')
  return {
    artifactId: `patch-${relativePath.includes('a') ? 'a' : 'b'}` as ArtifactId,
    kind: 'PATCH',
    mediaType: 'application/vnd.xiaogui.task-patch+json',
    contentDigest: digestBytes(bytes),
    content: bytes,
  }
}

function digest(value: string): Sha256Digest {
  return digestBytes(Buffer.from(value))
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message))
        return
      }
      resolve(stdout)
    })
  })
}

async function waitForTrace(store: FakeDeliveryStore, item: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (store.trace.includes(item)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`trace not observed: ${item}`)
}
