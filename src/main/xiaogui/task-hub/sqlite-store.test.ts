import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  HubCommandRequestV1,
  InitialPlanDraftInputV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import {
  deliveryApplyReceiptDigestV1,
  deliveryChangeSetDigestV1,
  deliverySelectionDigestV1,
  deliveryTargetFingerprintV1,
  deliveryVerificationReceiptDigestV1,
  deliveryVerificationRequestDigestV1,
  type DeliveryApplyReceiptV1,
  type DeliveryApplyAttemptId,
  type DeliveryApplySafeCodeV1,
  type DeliveryBatchId,
  type DeliveryChangeSetV1,
  type DeliveryChangeSetId,
  type DeliveryGateId,
  type DeliveryRecoveryLineageV1,
  type DeliverySelectionDraftId,
  type DeliverySelectionDraftV1,
  type DeliveryVerificationAttemptId,
  type DeliveryVerificationReceiptV1,
  type DeliveryVerificationRequestV1,
} from '@shared/xiaogui-delivery'
import {
  taskCandidateDigestV1,
  taskChangeSetDigestV1,
  taskEvidenceBundleDigestV1,
  taskQaResultDigestV1,
  verificationReceiptDigestV1,
  verificationRequestDigestV1,
} from '@shared/xiaogui-task-verification'
import type {
  ArtifactId,
  ChangeSetCandidateV1,
  EvidenceBundleId,
  IsoDateTime,
  QaResultId,
  Sha256Digest,
  TaskChangeSetCandidateId,
  TaskChangeSetId,
  TaskChangeSetV1,
  TaskEvidenceBundleV1,
  TaskPassedQaResultV1,
  TaskVerificationPassedReceiptV1,
  TaskVerificationReceiptV1,
  TaskVerificationRequestV1,
  VerificationAttemptId,
  VerificationAttemptV1,
} from '@shared/xiaogui-task-verification'
import type { SessionAddressV1, SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { createCollaborationHubApplicationV1 } from './application'
import {
  CollaborationHubSqliteStoreV1,
  type BeginTaskVerificationRecordV1,
  type CompleteTaskVerificationRecordV1,
  type SealRecoveredDeliveryCandidateRecordV1,
  type ScheduleRecordM2BV1,
  type TaskArtifactWriteV1,
} from './sqlite-store'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

const roots: string[] = []
const TEST_TEMP_ROOT = 'E:\\CodexTemp\\m4f-c-store'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDb(name = 'hub.sqlite') {
  await mkdir(TEST_TEMP_ROOT, { recursive: true })
  const root = await mkdtemp(join(TEST_TEMP_ROOT, 'xiaogui-hub-m2b-store-'))
  roots.push(root)
  return join(root, name)
}

function lookup(mode: SessionMode): SessionScopeLookupV1 {
  return {
    lookup: async (address: SessionAddressV1) => ({
      kind: 'FOUND' as const,
      scope: { ...address, sessionMode: mode },
    }),
  }
}

function draft(): InitialPlanDraftInputV1 {
  return {
    objective: '验证 SQLite v2 迁移',
    tasks: [
      { taskKey: 'a', title: '无依赖任务' },
      { taskKey: 'b', title: '依赖任务', dependsOn: ['a'] },
    ],
  }
}

async function activePlan(dbPath: string) {
  let id = 0
  const app = createCollaborationHubApplicationV1({
    lookup: lookup('CODING'),
    storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
    now: () => '2026-08-17T00:00:00.000Z',
    idFactory: (prefix) => `${prefix}_${++id}`,
  })
  const start = await app.execute({
    contractVersion: 'm2a.v1',
    address: ADDRESS,
    trustedActor: { kind: 'main-process-user' },
    requestId: 'req-start',
    intent: { type: 'flow.start.with_draft', draft: draft() },
  })
  if (!start.ok || !start.value.flowId || !start.value.revisionId) throw new Error('start failed')
  const before = await app.observe(ADDRESS)
  if (!before.ok || !before.value.activeRevision) throw new Error('missing draft')
  const approve: HubCommandRequestV1 = {
    contractVersion: 'm2a.v1',
    address: ADDRESS as HubAddressV1,
    trustedActor: { kind: 'main-process-user' },
    requestId: 'req-approve',
    expectedSessionVersion: before.value.sessionVersion,
    intent: {
      type: 'plan.revision.submit',
      flowId: start.value.flowId,
      baseRevisionId: start.value.revisionId,
      draft: before.value.activeRevision.draft,
    },
  }
  const approved = await app.execute(approve)
  if (!approved.ok) throw new Error('approve failed')
  return { app, flowId: start.value.flowId }
}

function baselineRecord(suffix: string) {
  const baselineId = `baseline-${suffix}`
  const baseRevision = `${suffix.repeat(40).slice(0, 40)}`
  const baselineTreeHash = `sha256:baseline-tree-${suffix}`
  const initialTargetFingerprint = `sha256:initial-target-${suffix}`
  const baselineDigest = `sha256:baseline-digest-${suffix}`
  const baselineBindingDigest = `sha256:baseline-binding-${suffix}`
  return { baselineId, baseRevision, baselineTreeHash, initialTargetFingerprint, baselineDigest, baselineBindingDigest }
}

function flowBaselineRow(dbPath: string, flowId: FlowId) {
  const db = new DatabaseSync(dbPath)
  try {
    return db
      .prepare('select flow_id, baseline_id, base_revision, baseline_tree_hash, initial_target_fingerprint, baseline_digest, baseline_binding_digest, created_at from flow_execution_baselines where flow_id = ?')
      .get(flowId) as Record<string, unknown> | undefined
  } finally {
    db.close()
  }
}

function privateM2B2Tables() {
  return [
    'attempt_workspace_prepared',
    'attempt_workspace_leases',
    'attempt_file_manifests',
    'scope_expansion_requests',
    'create_batches',
    'private_runtime_payloads',
  ]
}

function scheduleRecord(input: {
  flowId: FlowId
  taskRunId: TaskRunId
  attemptId: AttemptId
  suffix: string
  projection: NonNullable<ReturnType<CollaborationHubSqliteStoreV1['readProjection']>>
}): ScheduleRecordM2BV1 {
  const baseline = baselineRecord(input.suffix)
  return {
    flowId: input.flowId,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    attemptDigest: `sha256:${input.suffix}-attempt`,
    compositionDigest: `sha256:${input.suffix}-composition`,
    ...baseline,
    ...m2cScheduleFields(input.flowId, input.taskRunId, input.attemptId, baseline),
    workspacePrepareRequestDigest: `sha256:${input.suffix}-workspace-prepare`,
    projection: input.projection,
    receipt: {
      requestId: `sys-schedule-${input.suffix}`,
      intentType: 'system.schedule' as const,
      sessionVersion: 0,
      flowId: input.flowId,
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
    },
    now: '2026-08-17T00:00:00.000Z',
  }
}

function m2cScheduleFields(
  flowId: FlowId,
  taskRunId: TaskRunId,
  attemptId: AttemptId,
  baseline: ReturnType<typeof baselineRecord>,
) {
  const selection = {
    adapterId: 'test-runtime',
    runtimeKind: 'OTHER' as const,
    protocol: 'SDK' as const,
    capabilityDigest: 'sha256:test-capability',
    approvalStatus: 'APPROVED_FOR_PRODUCTION' as const,
    diagnosticOnly: false as const,
    stream: 'POLL' as const,
    interrupt: 'BEST_EFFORT' as const,
    inspect: 'RECONCILE' as const,
  }
  const authorizationScope = {
    version: 1 as const,
    pathTokens: [] as Sha256Digest[],
    scopeDigest: asDigest('sha256:empty-scope'),
  }
  return {
    flowBaselineBindingDigest: baseline.baselineBindingDigest,
    taskBaselineId: baseline.baselineId,
    taskBaseRevision: baseline.baseRevision,
    taskBaselineTreeHash: baseline.baselineTreeHash,
    taskInitialTargetFingerprint: baseline.initialTargetFingerprint,
    taskBaselineDigest: baseline.baselineDigest,
    taskBaselineDerivationDigest: `sha256:derivation-${attemptId}`,
    ancestorTaskChangeSetIds: [] as string[],
    executionWave: {
      version: 1 as const,
      waveId: `xhbwave_${attemptId}` as never,
      flowId,
      maxParallelism: 2,
      activeAttemptIds: [] as AttemptId[],
      scheduled: [{ taskRunId, attemptId }],
      dependencyStates: [],
      createdAt: '2026-08-17T00:00:00.000Z',
    },
    runtimeBinding: {
      version: 1 as const,
      attemptId,
      taskRunId,
      executionInputDigest: asDigest(`sha256:input-${attemptId}`),
      authorizationScopeDigest: authorizationScope.scopeDigest,
      selection,
      selectionDigest: asDigest(`sha256:selection-${attemptId}`),
      bindingDigest: asDigest(`sha256:binding-${attemptId}`),
      boundAt: '2026-08-17T00:00:00.000Z',
    },
    authorizationScope,
  }
}

function asDigest(value: string): Sha256Digest {
  return value as Sha256Digest
}

function contentDigest(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function setAttemptRunning(dbPath: string, attemptId: AttemptId, taskRunId: TaskRunId, runtimeSessionId: string): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare("update attempts set status = 'RUNNING', runtime_session_id = ? where attempt_id = ?").run(
      runtimeSessionId,
      attemptId,
    )
    db.prepare("update task_runs set status = 'RUNNING' where task_run_id = ?").run(taskRunId)
  } finally {
    db.close()
  }
}

function setAttemptOutcomeUnknown(
  dbPath: string,
  attemptId: AttemptId,
  taskRunId: TaskRunId,
  runtimeSessionId: string,
  receiptDigest: string,
): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare("update attempts set status = 'OUTCOME_UNKNOWN', runtime_session_id = ?, outcome_receipt_digest = ? where attempt_id = ?").run(
      runtimeSessionId,
      receiptDigest,
      attemptId,
    )
    db.prepare("update task_runs set status = 'OUTCOME_UNKNOWN' where task_run_id = ?").run(taskRunId)
  } finally {
    db.close()
  }
}

async function startedTaskVerification(dbPath: string, suffix: string) {
  const { app, flowId } = await activePlan(dbPath)
  app.close()
  const store = new CollaborationHubSqliteStoreV1(dbPath)
  const projection = store.readProjection(ADDRESS)
  const taskRun = store.taskRuns(flowId as FlowId)[0]
  const activeFlow = store.activeFlow(ADDRESS)
  if (!projection || !taskRun || !activeFlow?.active_revision_id) throw new Error('missing active plan')
  const attemptId = `xhba_${suffix}` as AttemptId
  store.writeSchedule(
    ADDRESS,
    { requestId: `sys-schedule-${suffix}`, commandType: 'system.schedule', payloadHash: `sha256:schedule-${suffix}` },
    scheduleRecord({
      flowId: flowId as FlowId,
      taskRunId: taskRun.task_run_id,
      attemptId,
      suffix,
      projection,
    }),
  )
  const runtimeSessionId = `runtime-${suffix}`
  setAttemptRunning(dbPath, attemptId, taskRun.task_run_id, runtimeSessionId)

  const patchContent = Buffer.from(`patch-${suffix}`)
  const patchArtifact: TaskArtifactWriteV1 = {
    artifactId: `xhbart_patch_${suffix}` as ArtifactId,
    contentDigest: contentDigest(patchContent),
    kind: 'PATCH',
    mediaType: 'application/vnd.xiaogui.task-patch+json',
    content: patchContent,
  }
  const candidateWithoutDigest = {
    kind: 'TASK_CANDIDATE' as const,
    candidateId: `xhbcandidate_${suffix}` as TaskChangeSetCandidateId,
    flowId: flowId as FlowId,
    taskRunId: taskRun.task_run_id,
    attemptId,
    inputTreeHash: asDigest(`sha256:input-${suffix}`),
    resultTreeHash: asDigest(`sha256:result-${suffix}`),
    patchArtifactId: patchArtifact.artifactId,
    proposedChangeSetDigest: taskChangeSetDigestV1({
      inputTreeHash: asDigest(`sha256:input-${suffix}`),
      resultTreeHash: asDigest(`sha256:result-${suffix}`),
      ancestorTaskChangeSetIds: [] as readonly TaskChangeSetId[],
      patchArtifactId: patchArtifact.artifactId,
    }),
    createdAt: '2026-08-17T00:00:02.000Z' as IsoDateTime,
  }
  const candidate: ChangeSetCandidateV1 = {
    ...candidateWithoutDigest,
    candidateDigest: taskCandidateDigestV1(candidateWithoutDigest),
  }
  const verificationAttemptId = `xhbverify_${suffix}` as VerificationAttemptId
  const requestWithoutDigest = {
    scope: 'TASK' as const,
    verificationAttemptId,
    verificationRequestId: `verify-request-${suffix}`,
    flowId: flowId as FlowId,
    taskRunId: taskRun.task_run_id,
    attemptId,
    candidateId: candidate.candidateId,
    changeSetDigest: candidate.proposedChangeSetDigest,
    preparedTreeHash: candidate.resultTreeHash,
    qaConfigVersion: 'task-typescript-v1',
    acceptanceCriteria: ['类型检查通过'] as readonly string[],
  }
  const verificationRequest: TaskVerificationRequestV1 = {
    ...requestWithoutDigest,
    requestDigest: verificationRequestDigestV1(requestWithoutDigest),
  }
  const verificationAttempt: Extract<VerificationAttemptV1, { state: 'STARTED' }> = {
    scope: 'TASK',
    verificationAttemptId,
    verificationRequestId: verificationRequest.verificationRequestId,
    flowId: flowId as FlowId,
    taskRunId: taskRun.task_run_id,
    attemptId,
    candidateId: candidate.candidateId,
    requestDigest: verificationRequest.requestDigest,
    state: 'STARTED',
    startedAt: '2026-08-17T00:00:02.000Z' as IsoDateTime,
  }
  const beginRecord: BeginTaskVerificationRecordV1 = {
    patchArtifact,
    candidate,
    ancestorTaskChangeSetIds: [],
    succeededAudit: {
      runtimeSessionId,
      attemptId,
      receiptDigest: `sha256:runtime-succeeded-${suffix}`,
      candidateDigest: `sha256:runtime-candidate-${suffix}`,
    },
    verificationAttempt,
    verificationRequestJson: JSON.stringify(verificationRequest),
    now: '2026-08-17T00:00:02.000Z',
  }
  return {
    store,
    flowId: flowId as FlowId,
    planRevisionId: activeFlow.active_revision_id,
    taskRunId: taskRun.task_run_id,
    attemptId,
    candidate,
    verificationRequest,
    beginRecord,
  }
}

async function unknownDeliveryApply(dbPath: string, suffix: string) {
  const { app, flowId } = await activePlan(dbPath)
  app.close()
  const store = new CollaborationHubSqliteStoreV1(dbPath)
  const taskRun = store.taskRuns(flowId as FlowId)[0]
  store.close()
  if (!taskRun) throw new Error('missing delivery task run')

  const batchId = `xhbd_${suffix}` as DeliveryBatchId
  const draftId = `xhbds_${suffix}` as DeliverySelectionDraftId
  const deliveryChangeSetId = `xhbdcs_${suffix}` as DeliveryChangeSetId
  const applyAttemptId = `xhbdap_${suffix}` as DeliveryApplyAttemptId
  const selectionDigest = asDigest(`sha256:delivery-selection-${suffix}`)
  const requestDigest = asDigest(`sha256:delivery-apply-request-${suffix}`)
  const unknownReceiptDigest = asDigest(`sha256:delivery-apply-unknown-${suffix}`)
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma foreign_keys = on; begin immediate')
    db.prepare(
      'insert into delivery_batches (batch_id, project_id, session_key, flow_id, selection_draft_id, state, selection_digest, target_fingerprint, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      batchId,
      ADDRESS.projectId,
      ADDRESS.sessionKey,
      flowId,
      draftId,
      'OUTCOME_UNKNOWN',
      selectionDigest,
      `sha256:delivery-target-${suffix}`,
      '2026-08-18T00:00:00.000Z',
      '2026-08-18T00:00:01.000Z',
    )
    db.prepare(
      'insert into delivery_selection_drafts (draft_id, batch_id, flow_id, selected_task_run_ids_json, resolved_task_change_set_ids_json, dependency_task_run_ids_json, selection_digest, draft_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      draftId,
      batchId,
      flowId,
      JSON.stringify([taskRun.task_run_id]),
      '[]',
      '[]',
      selectionDigest,
      '{}',
      '2026-08-18T00:00:00.000Z',
    )
    db.prepare(
      'insert into delivery_change_sets (delivery_change_set_id, batch_id, flow_id, version, selection_digest, task_change_set_ids_json, evidence_artifact_ids_json, qa_config_version, digest, change_set_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      deliveryChangeSetId,
      batchId,
      flowId,
      1,
      selectionDigest,
      '[]',
      '[]',
      'delivery-test-v1',
      `sha256:delivery-change-set-${suffix}`,
      '{}',
      '2026-08-18T00:00:00.000Z',
    )
    db.prepare(
      'insert into delivery_apply_attempts (apply_attempt_id, batch_id, delivery_change_set_id, request_digest, target_fingerprint_before, state, receipt_digest, target_fingerprint_after, started_at, finished_at) values (?, ?, ?, ?, ?, ?, ?, null, ?, ?)',
    ).run(
      applyAttemptId,
      batchId,
      deliveryChangeSetId,
      requestDigest,
      `sha256:delivery-target-${suffix}`,
      'OUTCOME_UNKNOWN',
      unknownReceiptDigest,
      '2026-08-18T00:00:00.000Z',
      '2026-08-18T00:00:01.000Z',
    )
    db.prepare(
      'insert into delivery_apply_outbox (outbox_id, apply_attempt_id, request_digest, request_json, status, completed_at, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `xhbdapo_${applyAttemptId}`,
      applyAttemptId,
      requestDigest,
      '{}',
      'OUTCOME_UNKNOWN',
      '2026-08-18T00:00:01.000Z',
      '2026-08-18T00:00:00.000Z',
    )
    db.prepare("update task_runs set status = 'APPLYING' where task_run_id = ?").run(taskRun.task_run_id)
    db.exec('commit')
  } catch (error) {
    db.exec('rollback')
    throw error
  } finally {
    db.close()
  }
  return { flowId: flowId as FlowId, taskRunId: taskRun.task_run_id, batchId, deliveryChangeSetId, applyAttemptId }
}

async function baselineDriftRecoveryFixture(
  dbPath: string,
  suffix: string,
  input: { safeCode?: DeliveryApplySafeCodeV1; changedRelativePaths?: readonly string[] } = {},
) {
  const { app, flowId } = await activePlan(dbPath)
  app.close()
  const store = new CollaborationHubSqliteStoreV1(dbPath)
  const taskRun = store.taskRuns(flowId as FlowId)[0]
  store.close()
  if (!taskRun) throw new Error('missing recovery task run')

  const sourceBatchId = `xhbd_source_${suffix}` as DeliveryBatchId
  const sourceDraftId = `xhbds_source_${suffix}` as DeliverySelectionDraftId
  const sourceDeliveryChangeSetId = `xhbdcs_source_${suffix}` as DeliveryChangeSetId
  const sourceApplyAttemptId = `xhbdap_source_${suffix}` as DeliveryApplyAttemptId
  const recoveredBatchId = `xhbd_recovered_${suffix}` as DeliveryBatchId
  const recoveredDraftId = `xhbds_recovered_${suffix}` as DeliverySelectionDraftId
  const recoveredDeliveryChangeSetId = `xhbdcs_recovered_${suffix}` as DeliveryChangeSetId
  const recoveredVerificationAttemptId = `xhbdv_recovered_${suffix}` as DeliveryVerificationAttemptId
  const gateId = `xhbdg_recovered_${suffix}` as DeliveryGateId
  const now = '2026-08-24T00:00:00.000Z'
  const sourceTargetBase = {
    projectId: ADDRESS.projectId,
    baseRevision: 'a'.repeat(40),
    baselineTreeHash: 'b'.repeat(40),
  }
  const currentTargetBase = {
    projectId: ADDRESS.projectId,
    baseRevision: 'c'.repeat(40),
    baselineTreeHash: 'd'.repeat(40),
  }
  const sourceTargetFingerprint = deliveryTargetFingerprintV1(sourceTargetBase)
  const currentTargetFingerprint = deliveryTargetFingerprintV1(currentTargetBase)
  const sourceTarget = {
    ...sourceTargetBase,
    initialTargetFingerprint: sourceTargetFingerprint,
  }
  const currentTarget = {
    ...currentTargetBase,
    initialTargetFingerprint: currentTargetFingerprint,
  }
  const fileContent = Buffer.from(`recovered file ${suffix}`)
  const deliveryFileArtifact = {
    artifactId: `artifact-recovery-file-${suffix}` as ArtifactId,
    kind: 'DELIVERY_FILE_CONTENT' as const,
    mediaType: 'application/vnd.xiaogui.delivery-file-content' as const,
    content: fileContent,
    contentDigest: contentDigest(fileContent) as Sha256Digest,
  }
  const sourceDraftBase: Omit<DeliverySelectionDraftV1, 'digest'> = {
    kind: 'DELIVERY_SELECTION_DRAFT',
    version: 1,
    draftId: sourceDraftId,
    batchId: sourceBatchId,
    flowId: flowId as FlowId,
    selectedTaskRunIds: [taskRun.task_run_id],
    resolvedTaskChangeSets: [],
    dependencyTaskRunIds: [taskRun.task_run_id],
    targetFingerprint: sourceTargetFingerprint,
    createdAt: now as never,
  }
  const sourceDraft: DeliverySelectionDraftV1 = {
    ...sourceDraftBase,
    digest: deliverySelectionDigestV1(sourceDraftBase),
  }
  const recoveredDraftBase: Omit<DeliverySelectionDraftV1, 'digest'> = {
    ...sourceDraft,
    draftId: recoveredDraftId,
    batchId: recoveredBatchId,
    targetFingerprint: currentTargetFingerprint,
    createdAt: now as never,
  }
  const recoveredSelectionDigest = deliverySelectionDigestV1(recoveredDraftBase)
  const sourceChangeSetBase = {
    kind: 'DELIVERY_CHANGESET' as const,
    version: 1 as const,
    deliveryChangeSetId: sourceDeliveryChangeSetId,
    batchId: sourceBatchId,
    selectionDraftId: sourceDraftId,
    flowId: flowId as FlowId,
    selectionDigest: sourceDraft.digest,
    taskChangeSetIds: [] as readonly TaskChangeSetId[],
    taskChangeSets: [],
    dependencyOrder: [] as readonly TaskChangeSetId[],
    fileChanges: [
      {
        operation: 'MODIFY' as const,
        relativePath: 'src/recovered-feature.ts',
        baselineDigest: contentDigest(Buffer.from('source file')) as Sha256Digest,
        contentDigest: deliveryFileArtifact.contentDigest,
        contentArtifactId: deliveryFileArtifact.artifactId,
        sourceTaskChangeSetIds: [] as readonly TaskChangeSetId[],
      },
    ],
    target: sourceTarget,
    integrationTreeHash: asDigest(`sha256:delivery-source-tree-${suffix}`),
    evidenceArtifactIds: [] as readonly ArtifactId[],
    qaConfigVersion: 'delivery-test-v1',
    createdAt: now as never,
  }
  const sourceChangeSet: DeliveryChangeSetV1 = {
    ...sourceChangeSetBase,
    digest: deliveryChangeSetDigestV1(sourceChangeSetBase),
  }
  const failedReceiptBase = {
    applyAttemptId: sourceApplyAttemptId,
    deliveryChangeSetId: sourceDeliveryChangeSetId,
    verdict: 'FAILED_ROLLED_BACK' as const,
    changedRelativePaths: input.changedRelativePaths ?? [],
    safeCode: input.safeCode ?? 'TARGET_BASELINE_DRIFT',
  }
  const failedReceipt: DeliveryApplyReceiptV1 = {
    ...failedReceiptBase,
    receiptDigest: deliveryApplyReceiptDigestV1(failedReceiptBase),
  } as DeliveryApplyReceiptV1
  const recoveryLineage: DeliveryRecoveryLineageV1 = {
    sourceBatchId,
    sourceDeliveryChangeSetId,
    sourceDeliveryChangeSetDigest: sourceChangeSet.digest,
    sourceTargetFingerprint,
    currentTargetFingerprint,
  }
  const recoveredChangeSetBase = {
    ...sourceChangeSetBase,
    deliveryChangeSetId: recoveredDeliveryChangeSetId,
    batchId: recoveredBatchId,
    selectionDraftId: recoveredDraftId,
    selectionDigest: recoveredSelectionDigest,
    target: currentTarget,
    integrationTreeHash: asDigest(`sha256:delivery-recovered-tree-${suffix}`),
    recoveryLineage,
    evidenceArtifactIds: [`artifact-recovery-evidence-${suffix}` as ArtifactId],
    createdAt: now as never,
  }
  const recoveredChangeSet: DeliveryChangeSetV1 = {
    ...recoveredChangeSetBase,
    digest: deliveryChangeSetDigestV1(recoveredChangeSetBase),
  }
  const preEvidenceChangeSetBase = {
    ...recoveredChangeSetBase,
    evidenceArtifactIds: [] as readonly ArtifactId[],
  }
  const preEvidenceChangeSetDigest = deliveryChangeSetDigestV1(preEvidenceChangeSetBase)
  const verificationRequestBase = {
    scope: 'DELIVERY' as const,
    verificationAttemptId: recoveredVerificationAttemptId,
    verificationRequestId: `delivery-recovery-request-${suffix}`,
    batchId: recoveredBatchId,
    flowId: flowId as FlowId,
    selectionDigest: recoveredSelectionDigest,
    targetFingerprint: currentTargetFingerprint,
    deliveryChangeSetDigest: preEvidenceChangeSetDigest,
    qaConfigVersion: 'delivery-test-v1',
  }
  const verificationRequest: DeliveryVerificationRequestV1 = {
    ...verificationRequestBase,
    requestDigest: deliveryVerificationRequestDigestV1(verificationRequestBase),
  }
  const receiptBase = {
    scope: 'DELIVERY' as const,
    verificationAttemptId: recoveredVerificationAttemptId,
    batchId: recoveredBatchId,
    flowId: flowId as FlowId,
    selectionDigest: recoveredSelectionDigest,
    deliveryChangeSetId: recoveredDeliveryChangeSetId,
    deliveryChangeSetDigest: recoveredChangeSet.digest,
    requestDigest: verificationRequest.requestDigest,
    qaConfigVersion: 'delivery-test-v1',
    diagnosticArtifactIds: [] as readonly ArtifactId[],
    verdict: 'PASS' as const,
    checks: [{ checkId: 'recovery-smoke', verdict: 'PASS' as const, summary: 'recovered candidate is bounded' }],
    evidenceArtifactIds: [`artifact-recovery-evidence-${suffix}` as ArtifactId],
  }
  const receipt: DeliveryVerificationReceiptV1 = {
    ...receiptBase,
    receiptDigest: deliveryVerificationReceiptDigestV1(receiptBase),
  }
  const evidenceArtifacts: readonly TaskArtifactWriteV1[] = [{
    artifactId: `artifact-recovery-evidence-${suffix}` as ArtifactId,
    kind: 'VERIFICATION_EVIDENCE',
    mediaType: 'application/json',
    content: Buffer.from(`{"suffix":"${suffix}"}`),
    contentDigest: contentDigest(Buffer.from(`{"suffix":"${suffix}"}`)) as Sha256Digest,
  }]

  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma foreign_keys = on; begin immediate')
    db.prepare(
      'insert into delivery_batches (batch_id, project_id, session_key, flow_id, selection_draft_id, state, selection_digest, target_fingerprint, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      sourceBatchId,
      ADDRESS.projectId,
      ADDRESS.sessionKey,
      flowId,
      sourceDraftId,
      'APPROVED',
      sourceDraft.digest,
      sourceTargetFingerprint,
      now,
      now,
    )
    db.prepare(
      'insert into delivery_selection_drafts (draft_id, batch_id, flow_id, selected_task_run_ids_json, resolved_task_change_set_ids_json, dependency_task_run_ids_json, selection_digest, draft_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      sourceDraftId,
      sourceBatchId,
      flowId,
      JSON.stringify(sourceDraft.selectedTaskRunIds),
      '[]',
      JSON.stringify(sourceDraft.dependencyTaskRunIds),
      sourceDraft.digest,
      JSON.stringify(sourceDraft),
      now,
    )
    db.prepare(
      'insert into delivery_change_sets (delivery_change_set_id, batch_id, flow_id, version, selection_digest, task_change_set_ids_json, evidence_artifact_ids_json, qa_config_version, digest, change_set_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      sourceDeliveryChangeSetId,
      sourceBatchId,
      flowId,
      1,
      sourceDraft.digest,
      '[]',
      '[]',
      'delivery-test-v1',
      sourceChangeSet.digest,
      JSON.stringify(sourceChangeSet),
      now,
    )
    db.prepare(
      'insert into delivery_apply_attempts (apply_attempt_id, batch_id, delivery_change_set_id, request_digest, target_fingerprint_before, state, receipt_digest, safe_code, changed_relative_paths_json, receipt_json, target_fingerprint_after, started_at, finished_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)',
    ).run(
      sourceApplyAttemptId,
      sourceBatchId,
      sourceDeliveryChangeSetId,
      asDigest(`sha256:delivery-apply-request-${suffix}`),
      sourceTargetFingerprint,
      'FAILED',
      failedReceipt.receiptDigest,
      failedReceipt.verdict === 'FAILED_ROLLED_BACK' ? failedReceipt.safeCode : null,
      JSON.stringify(failedReceipt.changedRelativePaths),
      JSON.stringify(failedReceipt),
      now,
      now,
    )
    db.prepare(
      'insert into delivery_apply_outbox (outbox_id, apply_attempt_id, request_digest, request_json, status, completed_at, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `xhbdapo_${sourceApplyAttemptId}`,
      sourceApplyAttemptId,
      asDigest(`sha256:delivery-apply-request-${suffix}`),
      '{}',
      'FAILED',
      now,
      now,
    )
    db.prepare("update task_runs set status = 'DELIVERY_PENDING' where task_run_id = ?").run(taskRun.task_run_id)
    db.exec('commit')
  } catch (error) {
    db.exec('rollback')
    throw error
  } finally {
    db.close()
  }

  return {
    sourceBatchId,
    sourceApplyAttemptId,
    recoveredBatchId,
    recoveredDeliveryChangeSetId,
    recoveredVerificationAttemptId,
    gateId,
    preEvidenceChangeSetDigest,
    record: {
      sourceBatchId,
      sourceFailedApplyAttemptId: sourceApplyAttemptId,
      batchId: recoveredBatchId,
      draftId: recoveredDraftId,
      verificationAttemptId: recoveredVerificationAttemptId,
      verificationRequestJson: JSON.stringify(verificationRequest),
      receipt,
      deliveryChangeSet: recoveredChangeSet,
      deliveryFileArtifacts: [deliveryFileArtifact],
      evidenceArtifacts,
      diagnosticArtifacts: [],
      gateId,
      recoveryLineage,
      now,
    },
  }
}

function deliveryChangeSetDigestWithEvidence(
  changeSet: DeliveryChangeSetV1,
  evidenceArtifactIds: readonly ArtifactId[],
): Sha256Digest {
  const { digest: _oldDigest, ...base } = changeSet
  return deliveryChangeSetDigestV1({ ...base, evidenceArtifactIds })
}

function deliveryChangeSetWithEvidence(
  changeSet: DeliveryChangeSetV1,
  evidenceArtifactIds: readonly ArtifactId[],
): DeliveryChangeSetV1 {
  const { digest: _oldDigest, ...base } = changeSet
  const withoutDigest = { ...base, evidenceArtifactIds }
  return { ...withoutDigest, digest: deliveryChangeSetDigestV1(withoutDigest) }
}

function deliveryRecoveryRequestWithDigest(
  value: Omit<DeliveryVerificationRequestV1, 'requestDigest'>,
): DeliveryVerificationRequestV1 {
  return { ...value, requestDigest: deliveryVerificationRequestDigestV1(value) }
}

function deliveryRecoveryReceiptWithDigest(
  value: Omit<DeliveryVerificationReceiptV1, 'receiptDigest'>,
): DeliveryVerificationReceiptV1 {
  return { ...value, receiptDigest: deliveryVerificationReceiptDigestV1(value) } as DeliveryVerificationReceiptV1
}

function mutateRecoveryRecordTargetFingerprint(
  record: SealRecoveredDeliveryCandidateRecordV1,
): SealRecoveredDeliveryCandidateRecordV1 {
  const driftedFingerprint = asDigest(`sha256:${'9'.repeat(64)}`)
  const deliveryChangeSet = deliveryChangeSetWithEvidence({
    ...record.deliveryChangeSet,
    target: {
      ...record.deliveryChangeSet.target,
      initialTargetFingerprint: driftedFingerprint,
    },
  }, record.deliveryChangeSet.evidenceArtifactIds)
  const originalRequest = JSON.parse(record.verificationRequestJson) as DeliveryVerificationRequestV1
  const { requestDigest: _oldRequestDigest, ...requestBase } = originalRequest
  const verificationRequest = deliveryRecoveryRequestWithDigest({
    ...requestBase,
    targetFingerprint: driftedFingerprint,
    deliveryChangeSetDigest: deliveryChangeSetDigestWithEvidence(deliveryChangeSet, []),
  })
  const { receiptDigest: _oldReceiptDigest, ...receiptBase } = record.receipt
  const receipt = deliveryRecoveryReceiptWithDigest({
    ...receiptBase,
    requestDigest: verificationRequest.requestDigest,
    deliveryChangeSetDigest: deliveryChangeSet.digest,
  })
  return {
    ...record,
    verificationRequestJson: JSON.stringify(verificationRequest),
    receipt,
    deliveryChangeSet,
    recoveryLineage: {
      ...record.recoveryLineage,
      currentTargetFingerprint: driftedFingerprint,
    },
  }
}

function mutateRecoveryRecordEvidenceId(
  record: SealRecoveredDeliveryCandidateRecordV1,
): SealRecoveredDeliveryCandidateRecordV1 {
  const { receiptDigest: _oldReceiptDigest, ...receiptBase } = record.receipt
  return {
    ...record,
    receipt: deliveryRecoveryReceiptWithDigest({
      ...receiptBase,
      evidenceArtifactIds: [`artifact-recovery-evidence-drifted` as ArtifactId],
    }),
  }
}

function mutateReplayRequestJson(
  record: SealRecoveredDeliveryCandidateRecordV1,
): SealRecoveredDeliveryCandidateRecordV1 {
  const originalRequest = JSON.parse(record.verificationRequestJson) as DeliveryVerificationRequestV1
  const { requestDigest: _oldRequestDigest, ...requestBase } = originalRequest
  const verificationRequest = deliveryRecoveryRequestWithDigest({
    ...requestBase,
    verificationRequestId: `${originalRequest.verificationRequestId}-tampered`,
  })
  return {
    ...record,
    verificationRequestJson: JSON.stringify(verificationRequest),
  }
}

function expectRecoverySealRejectsWithoutWrites(
  store: CollaborationHubSqliteStoreV1,
  dbPath: string,
  fixture: Awaited<ReturnType<typeof baselineDriftRecoveryFixture>>,
  record: SealRecoveredDeliveryCandidateRecordV1,
  expectedError: string,
): void {
  const counts = store.tableCounts()
  const version = store.currentVersion(ADDRESS)
  expect(() => store.sealRecoveredDeliveryCandidate(ADDRESS, record)).toThrow(expectedError)
  expect(store.tableCounts()).toEqual(counts)
  expect(store.currentVersion(ADDRESS)).toBe(version)
  expect(deliveryBatchState(dbPath, fixture.sourceBatchId)).toBe('APPROVED')
  expect(deliveryBatchState(dbPath, fixture.recoveredBatchId)).toBeNull()
  expect(recoveryBatchCount(dbPath, fixture.sourceBatchId)).toBe(0)
}

function deliveryBatchState(dbPath: string, batchId: DeliveryBatchId): string | null {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare('select state from delivery_batches where batch_id = ?').get(batchId) as
      | { state: string }
      | undefined
    return row?.state ?? null
  } finally {
    db.close()
  }
}

function recoveryBatchCount(dbPath: string, sourceBatchId: DeliveryBatchId): number {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db
      .prepare('select count(*) as count from delivery_batches where recovery_source_batch_id = ?')
      .get(sourceBatchId) as { count: number }
    return row.count
  } finally {
    db.close()
  }
}

function insertEquivalentBaselineDriftAttempt(
  dbPath: string,
  sourceAttemptId: DeliveryApplyAttemptId,
  nextAttemptId: DeliveryApplyAttemptId,
): void {
  const db = new DatabaseSync(dbPath)
  try {
    const source = db.prepare(
      'select batch_id, delivery_change_set_id, target_fingerprint_before, receipt_json, started_at, finished_at from delivery_apply_attempts where apply_attempt_id = ?',
    ).get(sourceAttemptId) as {
      batch_id: DeliveryBatchId
      delivery_change_set_id: DeliveryChangeSetId
      target_fingerprint_before: Sha256Digest
      receipt_json: string
      started_at: string
      finished_at: string
    }
    const sourceReceipt = JSON.parse(source.receipt_json) as DeliveryApplyReceiptV1
    const { receiptDigest: _sourceReceiptDigest, ...receiptBase } = sourceReceipt
    const nextReceiptBase = { ...receiptBase, applyAttemptId: nextAttemptId }
    const nextReceipt = {
      ...nextReceiptBase,
      receiptDigest: deliveryApplyReceiptDigestV1(nextReceiptBase),
    } as DeliveryApplyReceiptV1
    const requestDigest = asDigest(`sha256:alternate-recovery-request-${nextAttemptId}`)
    db.prepare(
      'insert into delivery_apply_attempts (apply_attempt_id, batch_id, delivery_change_set_id, request_digest, target_fingerprint_before, state, receipt_digest, safe_code, changed_relative_paths_json, receipt_json, target_fingerprint_after, started_at, finished_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)',
    ).run(
      nextAttemptId,
      source.batch_id,
      source.delivery_change_set_id,
      requestDigest,
      source.target_fingerprint_before,
      'FAILED',
      nextReceipt.receiptDigest,
      nextReceipt.verdict === 'FAILED_ROLLED_BACK' ? nextReceipt.safeCode : null,
      JSON.stringify(nextReceipt.changedRelativePaths),
      JSON.stringify(nextReceipt),
      source.started_at,
      source.finished_at,
    )
    db.prepare(
      'insert into delivery_apply_outbox (outbox_id, apply_attempt_id, request_digest, request_json, status, completed_at, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `xhbdapo_${nextAttemptId}`,
      nextAttemptId,
      requestDigest,
      '{}',
      'FAILED',
      source.finished_at,
      source.started_at,
    )
  } finally {
    db.close()
  }
}

function recoverySourceApplyAttemptId(dbPath: string, recoveredBatchId: DeliveryBatchId): string | null {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare(
      'select recovery_source_apply_attempt_id from delivery_batches where batch_id = ?',
    ).get(recoveredBatchId) as { recovery_source_apply_attempt_id: string | null } | undefined
    return row?.recovery_source_apply_attempt_id ?? null
  } finally {
    db.close()
  }
}

function passedCompletion(input: Awaited<ReturnType<typeof startedTaskVerification>>): CompleteTaskVerificationRecordV1 {
  const suffix = input.attemptId.replace('xhba_', '')
  const evidenceContent = Buffer.from(`evidence-${suffix}`)
  const evidenceArtifact: TaskArtifactWriteV1 = {
    artifactId: `xhbart_evidence_${suffix}` as ArtifactId,
    contentDigest: contentDigest(evidenceContent),
    kind: 'VERIFICATION_EVIDENCE',
    mediaType: 'application/vnd.xiaogui.qa-evidence+json',
    content: evidenceContent,
  }
  const checks = [
    {
      checkId: 'typecheck',
      summary: '固定类型检查通过',
      artifactIds: [evidenceArtifact.artifactId] as readonly ArtifactId[],
      verdict: 'PASS' as const,
    },
  ] as const
  const receiptWithoutDigest = {
    scope: 'TASK' as const,
    verificationAttemptId: input.verificationRequest.verificationAttemptId,
    verificationRequestId: input.verificationRequest.verificationRequestId,
    flowId: input.flowId,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    candidateId: input.candidate.candidateId,
    requestDigest: input.verificationRequest.requestDigest,
    changeSetDigest: input.candidate.proposedChangeSetDigest,
    qaConfigVersion: input.verificationRequest.qaConfigVersion,
    diagnosticArtifactIds: [] as readonly ArtifactId[],
    verdict: 'PASS' as const,
    checks,
    evidenceArtifactIds: [evidenceArtifact.artifactId] as readonly ArtifactId[],
  }
  const receipt: TaskVerificationPassedReceiptV1 = {
    ...receiptWithoutDigest,
    receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest),
  }
  const evidenceWithoutDigest = {
    scope: 'TASK' as const,
    evidenceBundleId: `xhbevidence_${suffix}` as EvidenceBundleId,
    verificationAttemptId: input.verificationRequest.verificationAttemptId,
    flowId: input.flowId,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    changeSetDigest: input.candidate.proposedChangeSetDigest,
    qaConfigVersion: input.verificationRequest.qaConfigVersion,
    artifactIds: [evidenceArtifact.artifactId] as readonly ArtifactId[],
  }
  const evidenceBundle: TaskEvidenceBundleV1 = {
    ...evidenceWithoutDigest,
    bundleDigest: taskEvidenceBundleDigestV1(evidenceWithoutDigest),
  }
  const qaWithoutDigest = {
    scope: 'TASK' as const,
    qaResultId: `xhbqa_${suffix}` as QaResultId,
    verificationAttemptId: input.verificationRequest.verificationAttemptId,
    flowId: input.flowId,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    candidateId: input.candidate.candidateId,
    changeSetDigest: input.candidate.proposedChangeSetDigest,
    qaConfigVersion: input.verificationRequest.qaConfigVersion,
    verdict: 'PASS' as const,
    checks,
  }
  const qaResult: TaskPassedQaResultV1 = {
    ...qaWithoutDigest,
    resultDigest: taskQaResultDigestV1(qaWithoutDigest),
  }
  const taskChangeSet: TaskChangeSetV1 = {
    kind: 'TASK',
    taskChangeSetId: `xhbchangeset_${suffix}` as TaskChangeSetId,
    version: 1,
    flowId: input.flowId,
    planRevisionId: input.planRevisionId,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    verificationAttemptId: input.verificationRequest.verificationAttemptId,
    candidateId: input.candidate.candidateId,
    inputTreeHash: input.candidate.inputTreeHash,
    resultTreeHash: input.candidate.resultTreeHash,
    ancestorTaskChangeSetIds: [],
    patchArtifactId: input.candidate.patchArtifactId,
    evidenceBundleId: evidenceBundle.evidenceBundleId,
    qaResultId: qaResult.qaResultId,
    qaConfigVersion: input.verificationRequest.qaConfigVersion,
    digest: input.candidate.proposedChangeSetDigest,
    createdAt: '2026-08-17T00:00:03.000Z' as IsoDateTime,
  }
  return {
    receipt,
    evidenceBundle,
    qaResult,
    taskChangeSet,
    evidenceArtifacts: [evidenceArtifact],
    now: '2026-08-17T00:00:03.000Z',
  }
}

describe('M2B sqlite store migration', () => {
  it('creates v1 and v2 migrations idempotently with additive execution tables', async () => {
    const dbPath = await tempDb()
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toEqual({
      journal_events: 0,
      idempotency_keys: 0,
      session_projection: 0,
      flows: 0,
      plan_revisions: 0,
      task_specs: 0,
      task_runs: 0,
      attempts: 0,
      execution_waves: 0,
      attempt_runtime_bindings: 0,
      attempt_authorization_scopes: 0,
      task_execution_baselines: 0,
      derived_execution_baselines: 0,
      derived_execution_baseline_reservations: 0,
      flow_execution_baselines: 0,
      composition_attempts: 0,
      workspace_prepare_outbox: 0,
      workspace_receipts: 0,
      agent_dispatch_outbox: 0,
      runtime_session_bindings: 0,
      agent_failures: 0,
      agent_succeeded_audits: 0,
      agent_reconcile_results: 0,
      artifacts: 0,
      change_set_candidates: 0,
      verification_attempts: 0,
      verification_outbox: 0,
      verification_receipts: 0,
      task_evidence_bundles: 0,
      task_qa_results: 0,
      task_change_sets: 0,
      delivery_batches: 0,
      delivery_selection_drafts: 0,
      delivery_verification_attempts: 0,
      delivery_verification_outbox: 0,
      delivery_verification_receipts: 0,
      delivery_change_sets: 0,
      delivery_human_gates: 0,
      delivery_apply_attempts: 0,
      delivery_apply_outbox: 0,
      attempt_workspace_prepared: 0,
      attempt_workspace_leases: 0,
      attempt_file_manifests: 0,
      scope_expansion_requests: 0,
      create_batches: 0,
      private_runtime_payloads: 0,
    })
    store.close()

    const reopened = new CollaborationHubSqliteStoreV1(dbPath)
    reopened.close()

    const db = new DatabaseSync(dbPath)
    expect(db.prepare('select version from schema_migrations order by version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
    ])
    expect(db.prepare("select name from sqlite_master where type = 'table' and name in ('attempts', 'execution_waves', 'attempt_runtime_bindings', 'attempt_authorization_scopes', 'task_execution_baselines', 'derived_execution_baselines', 'derived_execution_baseline_reservations', 'flow_execution_baselines', 'composition_attempts', 'workspace_prepare_outbox', 'workspace_receipts', 'agent_dispatch_outbox', 'runtime_session_bindings', 'agent_failures', 'agent_succeeded_audits', 'agent_reconcile_results', 'attempt_workspace_prepared', 'attempt_workspace_leases', 'attempt_file_manifests', 'scope_expansion_requests', 'create_batches', 'private_runtime_payloads', 'artifacts', 'change_set_candidates', 'verification_attempts', 'verification_outbox', 'verification_receipts', 'task_evidence_bundles', 'task_qa_results', 'task_change_sets', 'delivery_batches', 'delivery_selection_drafts', 'delivery_verification_attempts', 'delivery_verification_outbox', 'delivery_verification_receipts', 'delivery_change_sets', 'delivery_human_gates', 'delivery_apply_attempts', 'delivery_apply_outbox') order by name").all()).toEqual([
      { name: 'agent_dispatch_outbox' },
      { name: 'agent_failures' },
      { name: 'agent_reconcile_results' },
      { name: 'agent_succeeded_audits' },
      { name: 'artifacts' },
      { name: 'attempt_authorization_scopes' },
      { name: 'attempt_file_manifests' },
      { name: 'attempt_runtime_bindings' },
      { name: 'attempt_workspace_leases' },
      { name: 'attempt_workspace_prepared' },
      { name: 'attempts' },
      { name: 'change_set_candidates' },
      { name: 'composition_attempts' },
      { name: 'create_batches' },
      { name: 'delivery_apply_attempts' },
      { name: 'delivery_apply_outbox' },
      { name: 'delivery_batches' },
      { name: 'delivery_change_sets' },
      { name: 'delivery_human_gates' },
      { name: 'delivery_selection_drafts' },
      { name: 'delivery_verification_attempts' },
      { name: 'delivery_verification_outbox' },
      { name: 'delivery_verification_receipts' },
      { name: 'derived_execution_baseline_reservations' },
      { name: 'derived_execution_baselines' },
      { name: 'execution_waves' },
      { name: 'flow_execution_baselines' },
      { name: 'private_runtime_payloads' },
      { name: 'runtime_session_bindings' },
      { name: 'scope_expansion_requests' },
      { name: 'task_change_sets' },
      { name: 'task_evidence_bundles' },
      { name: 'task_execution_baselines' },
      { name: 'task_qa_results' },
      { name: 'verification_attempts' },
      { name: 'verification_outbox' },
      { name: 'verification_receipts' },
      { name: 'workspace_prepare_outbox' },
      { name: 'workspace_receipts' },
    ])
    db.close()
  })

  it('arbitrates a derived baseline reservation across stores and atomically publishes the cache', async () => {
    const dbPath = await tempDb('derived-reservation.sqlite')
    const first = new CollaborationHubSqliteStoreV1(dbPath)
    const second = new CollaborationHubSqliteStoreV1(dbPath)
    const base = {
      derivation_input_digest: 'sha256:derived-reservation',
      project_id: ADDRESS.projectId,
      flow_id: 'xhbf_reserved',
      task_run_id: 'xhbtr_reserved',
    }
    const firstReservation = {
      ...base,
      owner_token: 'owner-first',
      lease_expires_at: '2026-08-27T00:05:00.000Z',
      now: '2026-08-27T00:00:00.000Z',
    }
    const secondReservation = {
      ...base,
      owner_token: 'owner-second',
      lease_expires_at: '2026-08-27T00:05:01.000Z',
      now: '2026-08-27T00:00:01.000Z',
    }

    try {
      expect(first.reserveDerivedExecutionBaseline(firstReservation)).toEqual({ kind: 'ACQUIRED' })
      expect(second.reserveDerivedExecutionBaseline(secondReservation)).toEqual({ kind: 'WAITING' })
      first.releaseDerivedExecutionBaselineReservation(base.derivation_input_digest, firstReservation.owner_token)
      expect(second.reserveDerivedExecutionBaseline(secondReservation)).toEqual({ kind: 'ACQUIRED' })

      const cache = {
        ...base,
        baseline_json: '{"version":1}',
        created_at: '2026-08-27T00:00:02.000Z',
      }
      second.writeDerivedExecutionBaseline(cache, secondReservation.owner_token)
      expect(first.reserveDerivedExecutionBaseline({
        ...secondReservation,
        owner_token: 'owner-third',
      })).toEqual({ kind: 'CACHED', cache })
      expect(first.tableCounts().derived_execution_baseline_reservations).toBe(0)
    } finally {
      first.close()
      second.close()
    }
  })

  it('does not silently turn legacy PENDING_DISABLED task runs into attempts', async () => {
    const dbPath = await tempDb()
    const { app } = await activePlan(dbPath)
    const m2a = await app.observe(ADDRESS)
    const m2b = await app.observeM2B(ADDRESS)

    expect(m2a).toMatchObject({
      ok: true,
      value: { taskRuns: expect.arrayContaining([expect.objectContaining({ status: 'PENDING_DISABLED' })]) },
    })
    expect(m2b).toMatchObject({
      ok: true,
      value: {
        taskRuns: expect.arrayContaining([expect.objectContaining({ status: 'BLOCKED' })]),
        attempts: [],
      },
    })
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({
      attempts: 0,
      flow_execution_baselines: 0,
      composition_attempts: 0,
      workspace_prepare_outbox: 0,
      workspace_receipts: 0,
      agent_dispatch_outbox: 0,
      runtime_session_bindings: 0,
      agent_failures: 0,
      agent_succeeded_audits: 0,
      agent_reconcile_results: 0,
      artifacts: 0,
      change_set_candidates: 0,
      verification_attempts: 0,
      verification_outbox: 0,
      verification_receipts: 0,
      task_evidence_bundles: 0,
      task_qa_results: 0,
      task_change_sets: 0,
      attempt_workspace_prepared: 0,
      attempt_workspace_leases: 0,
      attempt_file_manifests: 0,
      scope_expansion_requests: 0,
      create_batches: 0,
      private_runtime_payloads: 0,
    })
    store.close()
    app.close()
  })

  it('allows a new flow after CANCELLED while a running flow remains unique', async () => {
    const dbPath = await tempDb()
    const { app, flowId } = await activePlan(dbPath)
    await expect(
      app.execute({
        contractVersion: 'm2a.v1',
        address: ADDRESS,
        trustedActor: { kind: 'main-process-user' },
        requestId: 'req-second',
        intent: { type: 'flow.start.with_draft', draft: draft() },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'ACTIVE_FLOW_EXISTS' } })
    const beforeCancel = await app.observe(ADDRESS)
    await app.execute({
      contractVersion: 'm2a.v1',
      address: ADDRESS,
      trustedActor: { kind: 'main-process-user' },
      requestId: 'req-cancel',
      expectedSessionVersion: beforeCancel.ok ? beforeCancel.value.sessionVersion : 0,
      intent: { type: 'flow.cancel', flowId: flowId as FlowId, reason: 'test' },
    })
    await expect(
      app.execute({
        contractVersion: 'm2a.v1',
        address: ADDRESS,
        trustedActor: { kind: 'main-process-user' },
        requestId: 'req-third',
        intent: { type: 'flow.start.with_draft', draft: draft() },
      }),
    ).resolves.toMatchObject({ ok: true })
    app.close()
    expect(existsSync(dbPath)).toBe(true)
  })

  it('rejects direct writeSchedule baseline drift at the SQLite write boundary without overwriting the existing row', async () => {
    const dbPath = await tempDb()
    const { app, flowId } = await activePlan(dbPath)
    app.close()
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    const projection = store.readProjection(ADDRESS)
    const taskRun = store.taskRuns(flowId as FlowId)[0]
    if (!projection || !taskRun) throw new Error('missing active plan')
    const firstBaseline = baselineRecord('1')
    store.writeSchedule(
      ADDRESS,
      { requestId: 'sys-schedule-first', commandType: 'system.schedule', payloadHash: 'sha256:first-payload' },
      {
        flowId: flowId as FlowId,
        taskRunId: taskRun.task_run_id,
        attemptId: 'xhba_first' as AttemptId,
        attemptDigest: 'sha256:first-attempt',
        compositionDigest: 'sha256:first-composition',
        ...firstBaseline,
        ...m2cScheduleFields(flowId as FlowId, taskRun.task_run_id, 'xhba_first' as AttemptId, firstBaseline),
        workspacePrepareRequestDigest: 'sha256:first-workspace-prepare',
        projection,
        receipt: {
          requestId: 'sys-schedule-first',
          intentType: 'system.schedule',
          sessionVersion: 0,
          flowId: flowId as FlowId,
          taskRunId: taskRun.task_run_id,
          attemptId: 'xhba_first' as AttemptId,
        },
        now: '2026-08-17T00:00:00.000Z',
      },
    )
    const oldRow = flowBaselineRow(dbPath, flowId as FlowId)
    const beforeCounts = store.tableCounts()
    expect(() =>
      store.writeSchedule(
        ADDRESS,
        { requestId: 'sys-schedule-drift', commandType: 'system.schedule', payloadHash: 'sha256:drift-payload' },
        {
          flowId: flowId as FlowId,
          taskRunId: taskRun.task_run_id as TaskRunId,
          attemptId: 'xhba_drift' as AttemptId,
          attemptDigest: 'sha256:drift-attempt',
          compositionDigest: 'sha256:drift-composition',
          ...baselineRecord('2'),
          ...m2cScheduleFields(flowId as FlowId, taskRun.task_run_id as TaskRunId, 'xhba_drift' as AttemptId, baselineRecord('2')),
          workspacePrepareRequestDigest: 'sha256:drift-workspace-prepare',
          projection,
          receipt: {
            requestId: 'sys-schedule-drift',
            intentType: 'system.schedule',
            sessionVersion: 0,
            flowId: flowId as FlowId,
            taskRunId: taskRun.task_run_id,
            attemptId: 'xhba_drift' as AttemptId,
          },
          now: '2026-08-17T00:00:01.000Z',
        },
      ),
    ).toThrow('BASELINE_CONFLICT')
    expect(store.tableCounts()).toEqual(beforeCounts)
    store.close()
    expect(flowBaselineRow(dbPath, flowId as FlowId)).toEqual(oldRow)
  })

  it('upgrades legacy v2 tables to schema v3 with private M2B2 tables and claim columns', async () => {
    const dbPath = await tempDb()
    const db = new DatabaseSync(dbPath)
    db.exec(`
      create table schema_migrations (version integer primary key, applied_at text not null);
      insert into schema_migrations (version, applied_at) values (1, 'legacy'), (2, 'legacy');
      create table flow_execution_baselines (
        flow_id text primary key,
        baseline_id text not null,
        baseline_tree_hash text not null,
        initial_target_fingerprint text not null,
        baseline_digest text not null,
        baseline_binding_digest text not null,
        created_at text not null
      );
      create table workspace_prepare_outbox (
        outbox_id text primary key,
        attempt_id text not null,
        request_digest text not null,
        status text not null,
        created_at text not null,
        completed_at text,
        unique(attempt_id)
      );
    `)
    db.close()

    const store = new CollaborationHubSqliteStoreV1(dbPath)
    store.close()

    const migrated = new DatabaseSync(dbPath)
    try {
      expect(migrated.prepare('select version from schema_migrations order by version').all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
        { version: 12 },
      ])
      expect(migrated.prepare('pragma table_info(flow_execution_baselines)').all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'base_revision' })]),
      )
      expect(migrated.prepare('pragma table_info(workspace_prepare_outbox)').all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'claim_owner_id' }),
          expect.objectContaining({ name: 'claim_digest' }),
          expect.objectContaining({ name: 'claimed_at' }),
        ]),
      )
      expect(migrated.prepare('pragma table_info(delivery_batches)').all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'recovery_source_batch_id' }),
          expect.objectContaining({ name: 'recovery_source_apply_attempt_id' }),
        ]),
      )
      expect(
        migrated
          .prepare(`select name from sqlite_master where type = 'table' and name in (${privateM2B2Tables().map(() => '?').join(',')}) order by name`)
          .all(...privateM2B2Tables()),
      ).toEqual([
        { name: 'attempt_file_manifests' },
        { name: 'attempt_workspace_leases' },
        { name: 'attempt_workspace_prepared' },
        { name: 'create_batches' },
        { name: 'private_runtime_payloads' },
        { name: 'scope_expansion_requests' },
      ])
      expect(migrated.prepare("select name from sqlite_master where type = 'index' and name = 'attempt_workspace_leases_conflict_digest'").get()).toEqual({
        name: 'attempt_workspace_leases_conflict_digest',
      })
    } finally {
      migrated.close()
    }
  })

  it('roundtrips baseRevision and claims workspace prepare outbox by SQLite CAS', async () => {
    const dbPath = await tempDb()
    const { app, flowId } = await activePlan(dbPath)
    app.close()
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    const projection = store.readProjection(ADDRESS)
    const taskRun = store.taskRuns(flowId as FlowId)[0]
    if (!projection || !taskRun) throw new Error('missing active plan')

    const record = scheduleRecord({
      flowId: flowId as FlowId,
      taskRunId: taskRun.task_run_id,
      attemptId: 'xhba_claim' as AttemptId,
      suffix: 'a',
      projection,
    })
    store.writeSchedule(
      ADDRESS,
      { requestId: 'sys-schedule-claim', commandType: 'system.schedule', payloadHash: 'sha256:claim-payload' },
      record,
    )
    expect(store.flowExecutionBaseline(flowId as FlowId)).toMatchObject({
      base_revision: record.baseRevision,
      baseline_tree_hash: record.baselineTreeHash,
    })

    const firstClaim = store.claimWorkspacePrepareOutbox({
      attemptId: 'xhba_claim' as AttemptId,
      ownerId: 'owner-a',
      claimDigest: 'sha256:claim-a',
      now: '2026-08-17T00:00:01.000Z',
    })
    expect(firstClaim).toMatchObject({
      attemptId: 'xhba_claim',
      status: 'CLAIMED',
      claimOwnerId: 'owner-a',
      claimDigest: 'sha256:claim-a',
      claimedAt: '2026-08-17T00:00:01.000Z',
    })
    expect(
      store.claimWorkspacePrepareOutbox({
        attemptId: 'xhba_claim' as AttemptId,
        ownerId: 'owner-a',
        claimDigest: 'sha256:claim-a',
        now: '2026-08-17T00:00:02.000Z',
      }),
    ).toEqual(firstClaim)
    expect(
      store.claimWorkspacePrepareOutbox({
        attemptId: 'xhba_claim' as AttemptId,
        ownerId: 'owner-b',
        claimDigest: 'sha256:claim-b',
        now: '2026-08-17T00:00:03.000Z',
      }),
    ).toBeNull()
    store.close()
  })

  it('does not claim DONE or FAILED workspace prepare rows', async () => {
    const dbPath = await tempDb()
    const { app, flowId } = await activePlan(dbPath)
    app.close()
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    const projection = store.readProjection(ADDRESS)
    const taskRun = store.taskRuns(flowId as FlowId)[0]
    if (!projection || !taskRun) throw new Error('missing active plan')
    store.writeSchedule(
      ADDRESS,
      { requestId: 'sys-schedule-done', commandType: 'system.schedule', payloadHash: 'sha256:done-payload' },
      scheduleRecord({
        flowId: flowId as FlowId,
        taskRunId: taskRun.task_run_id,
        attemptId: 'xhba_done' as AttemptId,
        suffix: 'd',
        projection,
      }),
    )
    store.writeWorkspacePrepared(
      ADDRESS,
      { requestId: 'sys-workspace-done', commandType: 'system.workspace.prepare.result.record', payloadHash: 'sha256:done-receipt' },
      {
        flowId: flowId as FlowId,
        taskRunId: taskRun.task_run_id,
        attemptId: 'xhba_done' as AttemptId,
        receipt: {
          requestId: 'sys-workspace-done',
          intentType: 'system.workspace.prepare.result.record',
          sessionVersion: 0,
          flowId: flowId as FlowId,
          taskRunId: taskRun.task_run_id,
          attemptId: 'xhba_done' as AttemptId,
        },
        workspaceReceipt: {
          status: 'PREPARED',
          workspaceReceiptId: 'xhbw_done' as never,
          receiptDigest: 'sha256:done-workspace-receipt',
          compositionAttemptId: 'xhbc_xhba_done',
          attemptId: 'xhba_done' as AttemptId,
          requestDigest: 'sha256:d-workspace-prepare',
          baselineBindingDigest: 'sha256:baseline-binding-d',
          compositionDigest: 'sha256:d-composition',
        },
        now: '2026-08-17T00:00:01.000Z',
      },
    )
    expect(store.workspacePrepareOutboxStatus('xhba_done' as AttemptId)).toBe('DONE')
    expect(
      store.claimWorkspacePrepareOutbox({
        attemptId: 'xhba_done' as AttemptId,
        ownerId: 'owner-late',
        claimDigest: 'sha256:late',
        now: '2026-08-17T00:00:02.000Z',
      }),
    ).toBeNull()
    store.close()
  })
})

describe('M4C task verification persistence', () => {
  it('begins idempotently, claims by CAS, and atomically seals a passed TASK verification', async () => {
    const dbPath = await tempDb('verification-pass.sqlite')
    const fixture = await startedTaskVerification(dbPath, 'pass')
    const first = fixture.store.beginTaskVerification(ADDRESS, fixture.beginRecord)
    expect(first).toEqual({
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      outboxId: `xhbvo_${fixture.verificationRequest.verificationAttemptId}`,
      replayed: false,
    })
    expect(fixture.store.attempt(fixture.attemptId)?.status).toBe('VERIFYING')
    expect(fixture.store.taskRun(fixture.taskRunId)?.status).toBe('VERIFYING')
    expect(fixture.store.readProjectionM2B(ADDRESS)?.attempts[0]?.verificationSummary).toMatchObject({
      state: 'STARTED',
      candidateId: fixture.candidate.candidateId,
      changeSetDigest: fixture.candidate.proposedChangeSetDigest,
    })
    expect(fixture.store.tableCounts()).toMatchObject({
      artifacts: 1,
      change_set_candidates: 1,
      agent_succeeded_audits: 1,
      verification_attempts: 1,
      verification_outbox: 1,
      verification_receipts: 0,
      task_evidence_bundles: 0,
      task_qa_results: 0,
      task_change_sets: 0,
    })
    const beforeReplayVersion = fixture.store.currentVersion(ADDRESS)
    expect(fixture.store.beginTaskVerification(ADDRESS, fixture.beginRecord)).toMatchObject({ replayed: true })
    expect(fixture.store.currentVersion(ADDRESS)).toBe(beforeReplayVersion)

    const claimed = fixture.store.claimVerificationOutbox({
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      ownerId: 'verification-worker-1',
      claimDigest: 'sha256:verification-claim-pass',
      now: '2026-08-17T00:00:02.500Z',
    })
    expect(claimed).toMatchObject({
      status: 'CLAIMED',
      claimOwnerId: 'verification-worker-1',
      claimDigest: 'sha256:verification-claim-pass',
    })
    expect(
      fixture.store.claimVerificationOutbox({
        verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
        ownerId: 'verification-worker-2',
        claimDigest: 'sha256:verification-claim-conflict',
        now: '2026-08-17T00:00:02.600Z',
      }),
    ).toBeNull()

    const completion = passedCompletion(fixture)
    expect(fixture.store.completeTaskVerification(ADDRESS, completion)).toEqual({
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      verdict: 'PASS',
      replayed: false,
    })
    expect(fixture.store.attempt(fixture.attemptId)?.status).toBe('SUCCEEDED')
    expect(fixture.store.taskRun(fixture.taskRunId)?.status).toBe('VERIFIED')
    expect(fixture.store.readProjectionM2B(ADDRESS)?.attempts[0]?.verificationSummary).toMatchObject({
      state: 'SUCCEEDED',
      verdict: 'PASS',
      taskChangeSetId: completion.taskChangeSet?.taskChangeSetId,
      checks: [{ checkId: 'typecheck', verdict: 'PASS', summary: '固定类型检查通过' }],
      evidenceArtifacts: [
        expect.objectContaining({ kind: 'QA_EVIDENCE', artifactId: completion.evidenceArtifacts?.[0]?.artifactId }),
      ],
    })
    expect(fixture.store.readVerificationOutbox(fixture.verificationRequest.verificationAttemptId)).toMatchObject({
      status: 'DONE',
      completedAt: completion.now,
    })
    expect(fixture.store.tableCounts()).toMatchObject({
      artifacts: 2,
      change_set_candidates: 1,
      verification_attempts: 1,
      verification_outbox: 1,
      verification_receipts: 1,
      task_evidence_bundles: 1,
      task_qa_results: 1,
      task_change_sets: 1,
    })
    const sealedCounts = fixture.store.tableCounts()
    const sealedVersion = fixture.store.currentVersion(ADDRESS)
    expect(
      fixture.store.completeTaskVerification(ADDRESS, {
        receipt: completion.receipt,
        now: '2026-08-17T00:00:04.000Z',
      }),
    ).toMatchObject({ replayed: true })
    expect(fixture.store.tableCounts()).toEqual(sealedCounts)
    expect(fixture.store.currentVersion(ADDRESS)).toBe(sealedVersion)
    fixture.store.close()
  })

  it('atomically starts verification from a reconciled SUCCEEDED runtime outcome', async () => {
    const dbPath = await tempDb('verification-reconcile.sqlite')
    const fixture = await startedTaskVerification(dbPath, 'reconcile')
    setAttemptOutcomeUnknown(
      dbPath,
      fixture.attemptId,
      fixture.taskRunId,
      'runtime-reconcile',
      'sha256:unknown-before-reconcile',
    )
    const record: BeginTaskVerificationRecordV1 = {
      ...fixture.beginRecord,
      reconcileStart: {
        idempotency: {
          requestId: 'sys-agent-reconcile-success',
          commandType: 'system.agent.reconcile',
          payloadHash: 'sha256:reconcile-payload',
        },
        receipt: {
          requestId: 'sys-agent-reconcile-success',
          intentType: 'system.agent.reconcile',
          sessionVersion: 0,
          attemptId: fixture.attemptId,
        },
        runtimeSessionId: 'runtime-reconcile',
        expectedReceiptDigest: 'sha256:unknown-before-reconcile',
        receiptDigest: fixture.beginRecord.succeededAudit.receiptDigest,
      },
    }

    const result = fixture.store.beginTaskVerification(ADDRESS, record)
    expect(result).toMatchObject({ replayed: false })
    expect(fixture.store.attempt(fixture.attemptId)?.status).toBe('VERIFYING')
    expect(fixture.store.taskRun(fixture.taskRunId)?.status).toBe('VERIFYING')
    expect(fixture.store.idempotency(ADDRESS, 'sys-agent-reconcile-success')).toMatchObject({
      command_type: 'system.agent.reconcile',
      payload_hash: 'sha256:reconcile-payload',
    })
    expect(fixture.store.tableCounts()).toMatchObject({
      agent_reconcile_results: 1,
      agent_succeeded_audits: 1,
      change_set_candidates: 1,
      verification_attempts: 1,
      verification_outbox: 1,
    })
    const version = fixture.store.currentVersion(ADDRESS)
    const counts = fixture.store.tableCounts()
    expect(fixture.store.beginTaskVerification(ADDRESS, record)).toMatchObject({ replayed: true })
    expect(fixture.store.currentVersion(ADDRESS)).toBe(version)
    expect(fixture.store.tableCounts()).toEqual(counts)
    expect(() =>
      fixture.store.beginTaskVerification(ADDRESS, {
        ...record,
        reconcileStart: {
          ...record.reconcileStart!,
          idempotency: {
            ...record.reconcileStart!.idempotency,
            payloadHash: 'sha256:different-reconcile-payload',
          },
        },
      }),
    ).toThrow('TASK_VERIFICATION_IDEMPOTENCY_CONFLICT')
    expect(fixture.store.currentVersion(ADDRESS)).toBe(version)
    expect(fixture.store.tableCounts()).toEqual(counts)
    fixture.store.close()
  })

  it('lists only READY or CLAIMED STARTED verification outboxes for restart recovery', async () => {
    const dbPath = await tempDb('verification-pending.sqlite')
    const fixture = await startedTaskVerification(dbPath, 'pending')
    fixture.store.beginTaskVerification(ADDRESS, fixture.beginRecord)

    expect(fixture.store.pendingTaskVerifications()).toEqual([
      {
        address: ADDRESS,
        outbox: expect.objectContaining({
          verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
          status: 'READY',
        }),
      },
    ])

    fixture.store.claimVerificationOutbox({
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      ownerId: 'verification-recovery-worker',
      claimDigest: 'sha256:verification-recovery-claim',
      now: '2026-08-17T00:00:02.500Z',
    })
    expect(fixture.store.pendingTaskVerifications()).toEqual([
      {
        address: ADDRESS,
        outbox: expect.objectContaining({
          verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
          status: 'CLAIMED',
          claimOwnerId: 'verification-recovery-worker',
        }),
      },
    ])

    const receiptWithoutDigest = {
      scope: 'TASK' as const,
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      verificationRequestId: fixture.verificationRequest.verificationRequestId,
      flowId: fixture.flowId,
      taskRunId: fixture.taskRunId,
      attemptId: fixture.attemptId,
      candidateId: fixture.candidate.candidateId,
      requestDigest: fixture.verificationRequest.requestDigest,
      changeSetDigest: fixture.candidate.proposedChangeSetDigest,
      qaConfigVersion: fixture.verificationRequest.qaConfigVersion,
      diagnosticArtifactIds: [] as readonly ArtifactId[],
      verdict: 'OUTCOME_UNKNOWN' as const,
      reason: '重启后无法证明固定验证进程结果',
    }
    fixture.store.completeTaskVerification(ADDRESS, {
      receipt: {
        ...receiptWithoutDigest,
        receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest),
      },
      now: '2026-08-17T00:00:03.000Z',
    })
    expect(fixture.store.pendingTaskVerifications()).toEqual([])
    fixture.store.close()
  })

  it('exposes the same authoritative ancestor order used by verification begin', async () => {
    const dbPath = await tempDb('verification-lineage.sqlite')
    const fixture = await startedTaskVerification(dbPath, 'lineage')
    expect(
      fixture.store.taskChangeSetAncestorIds(ADDRESS, fixture.flowId, fixture.taskRunId),
    ).toEqual([])

    fixture.store.beginTaskVerification(ADDRESS, fixture.beginRecord)
    fixture.store.claimVerificationOutbox({
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      ownerId: 'verification-lineage-worker',
      claimDigest: 'sha256:verification-lineage-claim',
      now: '2026-08-17T00:00:02.500Z',
    })
    const completion = passedCompletion(fixture)
    fixture.store.completeTaskVerification(ADDRESS, completion)

    const successor = fixture.store.taskRuns(fixture.flowId).find((taskRun) => taskRun.task_key === 'b')
    if (!successor || !completion.taskChangeSet) throw new Error('missing successor lineage')
    expect(
      fixture.store.taskChangeSetAncestorIds(ADDRESS, fixture.flowId, successor.task_run_id),
    ).toEqual([completion.taskChangeSet.taskChangeSetId])
    expect(() =>
      fixture.store.taskChangeSetAncestorIds(
        { ...ADDRESS, sessionKey: `xgs1_${'9'.repeat(64)}` } as HubAddressV1,
        fixture.flowId,
        successor.task_run_id,
      ),
    ).toThrow('TASK_VERIFICATION_SCOPE_MISMATCH')
    fixture.store.close()
  })

  it('rolls back every seal write when a receipt binding drifts', async () => {
    const dbPath = await tempDb('verification-mismatch.sqlite')
    const fixture = await startedTaskVerification(dbPath, 'mismatch')
    fixture.store.beginTaskVerification(ADDRESS, fixture.beginRecord)
    fixture.store.claimVerificationOutbox({
      verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
      ownerId: 'verification-worker-mismatch',
      claimDigest: 'sha256:verification-claim-mismatch',
      now: '2026-08-17T00:00:02.500Z',
    })
    const completion = passedCompletion(fixture)
    const receiptWithoutDigest = {
      ...completion.receipt,
      qaConfigVersion: 'drifted-qa-config',
    }
    const { receiptDigest: _ignored, ...canonicalReceipt } = receiptWithoutDigest
    const drifted: CompleteTaskVerificationRecordV1 = {
      ...completion,
      receipt: {
        ...canonicalReceipt,
        receiptDigest: verificationReceiptDigestV1(canonicalReceipt),
      } as TaskVerificationReceiptV1,
    }
    const beforeCounts = fixture.store.tableCounts()
    const beforeVersion = fixture.store.currentVersion(ADDRESS)
    expect(() => fixture.store.completeTaskVerification(ADDRESS, drifted)).toThrow('TASK_VERIFICATION_BINDING_MISMATCH')
    expect(fixture.store.tableCounts()).toEqual(beforeCounts)
    expect(fixture.store.currentVersion(ADDRESS)).toBe(beforeVersion)
    expect(fixture.store.attempt(fixture.attemptId)?.status).toBe('VERIFYING')
    expect(fixture.store.taskRun(fixture.taskRunId)?.status).toBe('VERIFYING')
    fixture.store.close()
  })

  it.each(['FAIL', 'OUTCOME_UNKNOWN'] as const)(
    'persists %s diagnostics without sealing evidence, QA, or a TASK ChangeSet',
    async (verdict) => {
      const dbPath = await tempDb(`verification-${verdict.toLowerCase()}.sqlite`)
      const fixture = await startedTaskVerification(dbPath, verdict.toLowerCase())
      fixture.store.beginTaskVerification(ADDRESS, fixture.beginRecord)
      fixture.store.claimVerificationOutbox({
        verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
        ownerId: `verification-worker-${verdict.toLowerCase()}`,
        claimDigest: `sha256:verification-claim-${verdict.toLowerCase()}`,
        now: '2026-08-17T00:00:02.500Z',
      })
      const receiptWithoutDigest =
        verdict === 'FAIL'
          ? {
              scope: 'TASK' as const,
              verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
              verificationRequestId: fixture.verificationRequest.verificationRequestId,
              flowId: fixture.flowId,
              taskRunId: fixture.taskRunId,
              attemptId: fixture.attemptId,
              candidateId: fixture.candidate.candidateId,
              requestDigest: fixture.verificationRequest.requestDigest,
              changeSetDigest: fixture.candidate.proposedChangeSetDigest,
              qaConfigVersion: fixture.verificationRequest.qaConfigVersion,
              diagnosticArtifactIds: [] as readonly ArtifactId[],
              verdict: 'FAIL' as const,
              checks: [
                {
                  checkId: 'typecheck',
                  summary: '固定类型检查失败',
                  artifactIds: [] as readonly ArtifactId[],
                  verdict: 'FAIL' as const,
                },
              ] as const,
              evidenceArtifactIds: [] as readonly ArtifactId[],
              failure: {
                source: 'QA_CHECKS_FAILED' as const,
                failureClass: 'TEST_FAILURE' as const,
                disposition: 'REQUIRE_HUMAN_GATE' as const,
                retryOrdinal: 0 as const,
                safeCode: 'QA_CHECK_FAILED' as const,
              },
              reason: '固定检查未通过',
            }
          : {
              scope: 'TASK' as const,
              verificationAttemptId: fixture.verificationRequest.verificationAttemptId,
              verificationRequestId: fixture.verificationRequest.verificationRequestId,
              flowId: fixture.flowId,
              taskRunId: fixture.taskRunId,
              attemptId: fixture.attemptId,
              candidateId: fixture.candidate.candidateId,
              requestDigest: fixture.verificationRequest.requestDigest,
              changeSetDigest: fixture.candidate.proposedChangeSetDigest,
              qaConfigVersion: fixture.verificationRequest.qaConfigVersion,
              diagnosticArtifactIds: [] as readonly ArtifactId[],
              verdict: 'OUTCOME_UNKNOWN' as const,
              reason: '验证进程结果不可证明',
            }
      const receipt = {
        ...receiptWithoutDigest,
        receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest),
      } as TaskVerificationReceiptV1
      fixture.store.completeTaskVerification(ADDRESS, {
        receipt,
        now: '2026-08-17T00:00:03.000Z',
      })
      const expectedState = verdict === 'FAIL' ? 'FAILED' : 'OUTCOME_UNKNOWN'
      expect(fixture.store.attempt(fixture.attemptId)?.status).toBe(expectedState)
      expect(fixture.store.taskRun(fixture.taskRunId)?.status).toBe(expectedState)
      expect(fixture.store.tableCounts()).toMatchObject({
        verification_receipts: 1,
        task_evidence_bundles: 0,
        task_qa_results: 0,
        task_change_sets: 0,
      })
      fixture.store.close()
    },
  )
})

describe('M4D delivery apply recovery persistence', () => {
  it.each([
    { outcome: 'SUCCEEDED' as const, batchState: 'APPLIED', outboxState: 'DONE', taskState: 'DONE' },
    { outcome: 'FAILED' as const, batchState: 'APPROVED', outboxState: 'FAILED', taskState: 'DELIVERY_PENDING' },
  ])('atomically reconciles OUTCOME_UNKNOWN to $outcome and keeps the terminal result idempotent', async (expected) => {
    const dbPath = await tempDb(`delivery-apply-reconcile-${expected.outcome.toLowerCase()}.sqlite`)
    const fixture = await unknownDeliveryApply(dbPath, expected.outcome.toLowerCase())
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    const versionBefore = store.currentVersion(ADDRESS)
    const receiptWithoutDigest = expected.outcome === 'SUCCEEDED'
      ? {
          applyAttemptId: fixture.applyAttemptId,
          deliveryChangeSetId: fixture.deliveryChangeSetId,
          verdict: 'SUCCEEDED' as const,
          changedRelativePaths: ['a.txt'] as readonly string[],
          targetFingerprint: asDigest('sha256:delivery-target-after-success'),
        }
      : {
          applyAttemptId: fixture.applyAttemptId,
          deliveryChangeSetId: fixture.deliveryChangeSetId,
          verdict: 'FAILED_ROLLED_BACK' as const,
          changedRelativePaths: [] as readonly string[],
          safeCode: 'TARGET_BASELINE_DRIFT' as const,
        }
    const receipt: DeliveryApplyReceiptV1 = {
      ...receiptWithoutDigest,
      receiptDigest: deliveryApplyReceiptDigestV1(receiptWithoutDigest),
    }
    const record = {
      applyAttemptId: fixture.applyAttemptId,
      outcome: expected.outcome,
      receipt,
      now: '2026-08-18T00:00:02.000Z',
    }

    const unboundWithoutDigest = {
      ...receiptWithoutDigest,
      deliveryChangeSetId: 'xhbdcs_unbound' as DeliveryChangeSetId,
    }
    const unboundReceipt = {
      ...unboundWithoutDigest,
      receiptDigest: deliveryApplyReceiptDigestV1(unboundWithoutDigest),
    } as DeliveryApplyReceiptV1
    expect(() => store.completeDeliveryApply(ADDRESS, { ...record, receipt: unboundReceipt }))
      .toThrow('DELIVERY_APPLY_RECEIPT_BINDING_MISMATCH')
    expect(store.currentVersion(ADDRESS)).toBe(versionBefore)

    expect(store.completeDeliveryApply(ADDRESS, record)).toEqual({
      applyAttemptId: fixture.applyAttemptId,
      outcome: expected.outcome,
      replayed: false,
    })
    store.close()
    const reopened = new CollaborationHubSqliteStoreV1(dbPath)
    expect(reopened.readDeliveryApplyAttempt(fixture.applyAttemptId)).toMatchObject({
      state: expected.outcome,
      receiptDigest: receipt.receiptDigest,
      changedRelativePaths: receipt.changedRelativePaths,
      ...(receipt.verdict === 'FAILED_ROLLED_BACK' ? { safeCode: receipt.safeCode } : {}),
    })
    expect(reopened.readDeliveryApplyOutbox(fixture.applyAttemptId)?.status).toBe(expected.outboxState)
    expect(reopened.taskRun(fixture.taskRunId)?.status).toBe(expected.taskState)
    expect(deliveryBatchState(dbPath, fixture.batchId)).toBe(expected.batchState)
    expect(reopened.currentVersion(ADDRESS)).toBe(versionBefore + 1)

    const terminalVersion = reopened.currentVersion(ADDRESS)
    expect(reopened.completeDeliveryApply(ADDRESS, record)).toMatchObject({ replayed: true })
    expect(reopened.currentVersion(ADDRESS)).toBe(terminalVersion)
    const reverseWithoutDigest = expected.outcome === 'SUCCEEDED'
      ? {
          applyAttemptId: fixture.applyAttemptId,
          deliveryChangeSetId: fixture.deliveryChangeSetId,
          verdict: 'FAILED_ROLLED_BACK' as const,
          changedRelativePaths: [] as readonly string[],
          safeCode: 'TARGET_WRITE_FAILED' as const,
        }
      : {
          applyAttemptId: fixture.applyAttemptId,
          deliveryChangeSetId: fixture.deliveryChangeSetId,
          verdict: 'SUCCEEDED' as const,
          changedRelativePaths: ['a.txt'] as readonly string[],
          targetFingerprint: asDigest('sha256:delivery-target-after-reverse'),
        }
    const reverseReceipt: DeliveryApplyReceiptV1 = {
      ...reverseWithoutDigest,
      receiptDigest: deliveryApplyReceiptDigestV1(reverseWithoutDigest),
    }
    expect(() =>
      reopened.completeDeliveryApply(ADDRESS, {
        ...record,
        outcome: expected.outcome === 'SUCCEEDED' ? 'FAILED' : 'SUCCEEDED',
        receipt: reverseReceipt,
      }),
    ).toThrow('DELIVERY_APPLY_IDEMPOTENCY_CONFLICT')
    expect(reopened.currentVersion(ADDRESS)).toBe(terminalVersion)
    reopened.close()
  })
})

describe('M4F delivery baseline recovery seal', () => {
  it('atomically supersedes the failed approved batch, seals one recovered review batch, and replays after reopen', async () => {
    const dbPath = await tempDb('delivery-recovery-seal.sqlite')
    const fixture = await baselineDriftRecoveryFixture(dbPath, 'success')
    const alternateSourceAttemptId = 'xhbdap_source_success_alternate' as DeliveryApplyAttemptId
    insertEquivalentBaselineDriftAttempt(dbPath, fixture.sourceApplyAttemptId, alternateSourceAttemptId)
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    const verificationRequest = JSON.parse(fixture.record.verificationRequestJson) as DeliveryVerificationRequestV1
    expect(verificationRequest.deliveryChangeSetDigest).toBe(fixture.preEvidenceChangeSetDigest)
    expect(verificationRequest.deliveryChangeSetDigest).not.toBe(fixture.record.deliveryChangeSet.digest)
    expect(fixture.record.deliveryChangeSet.evidenceArtifactIds).toEqual(fixture.record.receipt.evidenceArtifactIds)
    expect(fixture.record.receipt.deliveryChangeSetDigest).toBe(fixture.record.deliveryChangeSet.digest)

    expect(store.sealRecoveredDeliveryCandidate(ADDRESS, fixture.record)).toEqual({
      batchId: fixture.recoveredBatchId,
      replayed: false,
    })
    store.close()

    const reopened = new CollaborationHubSqliteStoreV1(dbPath)
    expect(deliveryBatchState(dbPath, fixture.sourceBatchId)).toBe('SUPERSEDED')
    expect(deliveryBatchState(dbPath, fixture.recoveredBatchId)).toBe('READY_FOR_REVIEW')
    expect(recoveryBatchCount(dbPath, fixture.sourceBatchId)).toBe(1)
    expect(recoverySourceApplyAttemptId(dbPath, fixture.recoveredBatchId)).toBe(fixture.sourceApplyAttemptId)
    expect(reopened.readDeliveryProjection(fixture.recoveredBatchId)).toMatchObject({
      batchId: fixture.recoveredBatchId,
      state: 'READY_FOR_REVIEW',
      recoverySourceBatchId: fixture.sourceBatchId,
      deliveryChangeSetId: fixture.recoveredDeliveryChangeSetId,
      fileChangeSummaries: fixture.record.deliveryChangeSet.fileChanges,
      evidenceArtifactIds: fixture.record.receipt.evidenceArtifactIds,
      gate: expect.objectContaining({ state: 'OPEN' }),
    })
    expect(reopened.readArtifact(fixture.record.deliveryFileArtifacts[0]!.artifactId)).toMatchObject({
      kind: 'DELIVERY_FILE_CONTENT',
      contentDigest: fixture.record.deliveryFileArtifacts[0]!.contentDigest,
    })
    expect(reopened.readArtifact(fixture.record.evidenceArtifacts![0]!.artifactId)).toMatchObject({
      kind: 'VERIFICATION_EVIDENCE',
      contentDigest: fixture.record.evidenceArtifacts![0]!.contentDigest,
    })
    expect(reopened.readRecoveredDeliveryProjection(
      ADDRESS,
      fixture.sourceBatchId,
      fixture.sourceApplyAttemptId,
    )).toMatchObject({
      batchId: fixture.recoveredBatchId,
      state: 'READY_FOR_REVIEW',
    })
    expect(() => reopened.readRecoveredDeliveryProjection(
      ADDRESS,
      fixture.sourceBatchId,
      alternateSourceAttemptId,
    )).toThrow('DELIVERY_RECOVERY_IDEMPOTENCY_CONFLICT')
    const version = reopened.currentVersion(ADDRESS)
    expect(reopened.sealRecoveredDeliveryCandidate(ADDRESS, fixture.record)).toEqual({
      batchId: fixture.recoveredBatchId,
      replayed: true,
    })
    expect(reopened.currentVersion(ADDRESS)).toBe(version)
    expect(recoveryBatchCount(dbPath, fixture.sourceBatchId)).toBe(1)
    const alternateReplayVersion = reopened.currentVersion(ADDRESS)
    const alternateReplayCounts = reopened.tableCounts()
    expect(() =>
      reopened.sealRecoveredDeliveryCandidate(ADDRESS, {
        ...fixture.record,
        sourceFailedApplyAttemptId: alternateSourceAttemptId,
      }),
    ).toThrow('DELIVERY_RECOVERY_IDEMPOTENCY_CONFLICT')
    expect(reopened.currentVersion(ADDRESS)).toBe(alternateReplayVersion)
    expect(reopened.tableCounts()).toEqual(alternateReplayCounts)
    const tamperedReplayVersion = reopened.currentVersion(ADDRESS)
    const tamperedReplayCounts = reopened.tableCounts()
    expect(() =>
      reopened.sealRecoveredDeliveryCandidate(ADDRESS, mutateReplayRequestJson(fixture.record)),
    ).toThrow('DELIVERY_RECOVERY_IDEMPOTENCY_CONFLICT')
    expect(reopened.currentVersion(ADDRESS)).toBe(tamperedReplayVersion)
    expect(reopened.tableCounts()).toEqual(tamperedReplayCounts)
    expect(recoveryBatchCount(dbPath, fixture.sourceBatchId)).toBe(1)
    reopened.close()
  })

  it.each([
    {
      name: 'artifact ID mismatch',
      mutate: mutateRecoveryRecordEvidenceId,
      error: 'DELIVERY_ARTIFACT_INVALID',
    },
    {
      name: 'target fingerprint mismatch',
      mutate: mutateRecoveryRecordTargetFingerprint,
      error: 'DELIVERY_CHANGESET_BINDING_MISMATCH',
    },
  ])('rejects $name before any partial recovery writes', async ({ name, mutate, error }) => {
    const dbPath = await tempDb(`delivery-recovery-binding-${name.replace(/\s+/g, '-')}.sqlite`)
    const fixture = await baselineDriftRecoveryFixture(dbPath, name.replace(/\s+/g, '-'))
    const store = new CollaborationHubSqliteStoreV1(dbPath)

    expectRecoverySealRejectsWithoutWrites(store, dbPath, fixture, mutate(fixture.record), error)
    store.close()
  })

  it.each([
    { name: 'wrong safe code', safeCode: 'TARGET_STATUS_DIRTY' as const, changedRelativePaths: [] as readonly string[] },
    { name: 'non-empty changed paths', safeCode: 'TARGET_BASELINE_DRIFT' as const, changedRelativePaths: ['a.txt'] as readonly string[] },
  ])('rejects $name before any partial recovery writes', async (input) => {
    const dbPath = await tempDb(`delivery-recovery-reject-${input.name.replace(/\s+/g, '-')}.sqlite`)
    const fixture = await baselineDriftRecoveryFixture(dbPath, input.name.replace(/\s+/g, '-'), input)
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    const counts = store.tableCounts()
    const version = store.currentVersion(ADDRESS)

    expect(() => store.sealRecoveredDeliveryCandidate(ADDRESS, fixture.record)).toThrow('DELIVERY_ILLEGAL_TRANSITION')
    expect(store.tableCounts()).toEqual(counts)
    expect(store.currentVersion(ADDRESS)).toBe(version)
    expect(deliveryBatchState(dbPath, fixture.sourceBatchId)).toBe('APPROVED')
    expect(deliveryBatchState(dbPath, fixture.recoveredBatchId)).toBeNull()
    expect(recoveryBatchCount(dbPath, fixture.sourceBatchId)).toBe(0)
    store.close()
  })
})
