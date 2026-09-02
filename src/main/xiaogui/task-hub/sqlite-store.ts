import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import {
  deliveryApplyReceiptDigestV1,
  deliveryChangeSetDigestV1,
  deliveryGateDecisionDigestV1,
  deliverySelectionDigestV1,
  deliveryTargetFingerprintV1,
  deliveryVerificationReceiptDigestV1,
  deliveryVerificationRequestDigestV1,
} from '@shared/xiaogui-delivery'
import type {
  DeliveryApplyAttemptId,
  DeliveryApplyAttemptV1,
  DeliveryApplyOutboxStateV1,
  DeliveryApplyReceiptV1,
  DeliveryApplySafeCodeV1,
  DeliveryBatchId,
  DeliveryBatchProjectionV1,
  DeliveryBatchStateV1,
  DeliveryChangeSetId,
  DeliveryChangeSetV1,
  DeliveryGateId,
  DeliveryHumanGateV1,
  DeliveryRecoveryLineageV1,
  DeliverySelectionDraftId,
  DeliverySelectionDraftV1,
  DeliveryTaskChangeSetRefV1,
  DeliveryVerificationAttemptId,
  DeliveryVerificationOutboxStateV1,
  DeliveryVerificationReceiptV1,
  DeliveryVerificationRequestV1,
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
  AgentFailureSignalV1,
  AgentSucceededAuditV1,
  AttemptId,
  AttemptProjectionM2BV1,
  AttemptRuntimeBindingV1,
  ExecutionWaveV1,
  FlowId,
  HubAddressV1,
  HubEventEnvelopeV1,
  HubReadEventsRequestV1,
  PerformReceiptV1,
  PlanRevisionId,
  SessionCollaborationProjectionV1,
  SessionCollaborationProjectionM2BV1,
  TaskRunId,
  TaskRunProjectionM2BV1,
  TaskFileAuthorizationScopeV1,
  WorkspacePreparedReceiptM2BV1,
  WorkspaceReceiptBindingM2BV1,
  WorkspaceReceiptId,
} from '@shared/xiaogui-collaboration-hub'
import type { RuntimeAdapterSelectionV1 } from '@shared/xiaogui-agent-runtime'
import type {
  ArtifactId,
  ChangeSetCandidateV1,
  EvidenceBundleId,
  QaResultId,
  Sha256Digest,
  TaskChangeSetCandidateId,
  TaskChangeSetDigestFieldsV1,
  TaskChangeSetId,
  TaskChangeSetV1,
  TaskEvidenceBundleV1,
  TaskPassedQaResultV1,
  TaskArtifactRefV1,
  TaskVerificationSummaryV1,
  VerificationAttemptId,
  TaskVerificationReceiptV1,
  TaskVerificationRequestV1,
  VerificationAttemptV1,
} from '@shared/xiaogui-task-verification'
import type { CanonicalPlanDraftV1 } from './digest'
import {
  ACTIVE_ATTEMPT_STATUSES_V1,
  type SchedulerAttemptV1,
  type SchedulerTaskV1,
} from './execution-wave-scheduler'

interface FlowRecord {
  flow_id: FlowId
  status: string
  active_revision_id: PlanRevisionId | null
  objective: string
}

interface RevisionRecord {
  revision_id: PlanRevisionId
  status: string
  digest: string
  draft_json: string
}

interface IdempotencyRecord {
  command_type: string
  payload_hash: string
  receipt_json: string
}

interface TaskRunRecord {
  task_run_id: TaskRunId
  task_spec_id: string
  flow_id: FlowId
  task_key: string
  status: string
  unavailable_reason: string
  depends_json: string
}

interface AttemptRecord {
  attempt_id: AttemptId
  task_run_id: TaskRunId
  flow_id: FlowId
  status: string
  attempt_digest: string
  workspace_receipt_id: WorkspaceReceiptId | null
  runtime_session_id: string | null
  outcome_receipt_digest: string | null
}

interface WorkspaceReceiptRecord {
  workspace_receipt_id: WorkspaceReceiptId
  attempt_id: AttemptId
  status: string
  receipt_digest: string
}

interface CompositionAttemptRecord extends WorkspaceReceiptBindingM2BV1 {
  compositionAttemptId: string
}

interface AgentDispatchOutboxRecord {
  outbox_id: string
  attempt_id: AttemptId
  request_id: string
  status: string
  payload_digest: string
  runtime_request_digest: string | null
  runtime_request_json: string | null
  selection_digest: string | null
}

interface FlowExecutionBaselineRecord {
  flow_id: FlowId
  baseline_id: string
  base_revision: string | null
  baseline_tree_hash: string
  initial_target_fingerprint: string
  baseline_digest: string
  baseline_binding_digest: string
}

export interface TaskExecutionBaselineRecordV1 extends FlowExecutionBaselineRecord {
  attempt_id: AttemptId
  task_run_id: TaskRunId
  ancestor_task_change_set_ids_json: string
  derivation_digest: string
}

export interface DerivedExecutionBaselineCacheRecordV1 {
  readonly derivation_input_digest: string
  readonly project_id: string
  readonly flow_id: string
  readonly task_run_id: string
  readonly baseline_json: string
  readonly created_at: string
}

export interface DerivedExecutionBaselineReservationRecordV1 {
  readonly derivation_input_digest: string
  readonly project_id: string
  readonly flow_id: string
  readonly task_run_id: string
  readonly owner_token: string
  readonly lease_expires_at: string
  readonly now: string
}

export type DerivedExecutionBaselineReservationResultV1 =
  | { readonly kind: 'ACQUIRED' }
  | { readonly kind: 'WAITING' }
  | { readonly kind: 'CACHED'; readonly cache: DerivedExecutionBaselineCacheRecordV1 }

interface VerificationAttemptRecord {
  verification_attempt_id: string
  verification_request_id: string
  flow_id: FlowId
  task_run_id: TaskRunId
  attempt_id: AttemptId
  candidate_id: string
  request_digest: string
  change_set_digest: string
  qa_config_version: string
  state: string
  started_at: string
  finished_at: string | null
  outcome_receipt_digest: string | null
}

interface VerificationOutboxRow {
  outbox_id: string
  verification_attempt_id: string
  request_digest: string
  request_json: string
  status: string
  claim_owner_id: string | null
  claim_digest: string | null
  claimed_at: string | null
  completed_at: string | null
  created_at: string
}

interface DeliveryBatchRow {
  batch_id: DeliveryBatchId
  project_id: string
  session_key: string
  flow_id: FlowId
  selection_draft_id: DeliverySelectionDraftId
  state: DeliveryBatchStateV1
  selection_digest: Sha256Digest
  target_fingerprint: Sha256Digest
  recovery_source_batch_id: DeliveryBatchId | null
  recovery_source_apply_attempt_id: DeliveryApplyAttemptId | null
  created_at: string
  updated_at: string
}

interface DeliverySelectionDraftRow {
  draft_id: DeliverySelectionDraftId
  batch_id: DeliveryBatchId
  flow_id: FlowId
  selected_task_run_ids_json: string
  resolved_task_change_set_ids_json: string
  dependency_task_run_ids_json: string
  selection_digest: Sha256Digest
  draft_json: string
  created_at: string
}

interface DeliveryVerificationAttemptRow {
  delivery_verification_attempt_id: DeliveryVerificationAttemptId
  verification_request_id: string
  batch_id: DeliveryBatchId
  flow_id: FlowId
  request_digest: Sha256Digest
  selection_digest: Sha256Digest
  qa_config_version: string
  state: string
  started_at: string
  finished_at: string | null
  outcome_receipt_digest: string | null
}

interface DeliveryVerificationOutboxRow {
  outbox_id: string
  delivery_verification_attempt_id: DeliveryVerificationAttemptId
  request_digest: Sha256Digest
  request_json: string
  status: DeliveryVerificationOutboxStateV1
  claim_owner_id: string | null
  claim_digest: string | null
  claimed_at: string | null
  completed_at: string | null
  created_at: string
}

interface DeliveryChangeSetRow {
  delivery_change_set_id: DeliveryChangeSetId
  batch_id: DeliveryBatchId
  flow_id: FlowId
  version: 1
  digest: Sha256Digest
  change_set_json: string
  created_at: string
}

interface DeliveryGateRow {
  gate_id: DeliveryGateId
  batch_id: DeliveryBatchId
  delivery_change_set_id: DeliveryChangeSetId
  subject_version: 1
  subject_digest: Sha256Digest
  state: string
  decision_digest: Sha256Digest | null
  decided_at: string | null
  gate_json: string
  created_at: string
}

interface DeliveryApplyAttemptRow {
  apply_attempt_id: DeliveryApplyAttemptId
  batch_id: DeliveryBatchId
  delivery_change_set_id: DeliveryChangeSetId
  request_digest: Sha256Digest
  target_fingerprint_before: Sha256Digest
  state: DeliveryApplyAttemptV1['state']
  receipt_digest: Sha256Digest | null
  safe_code: DeliveryApplySafeCodeV1 | null
  changed_relative_paths_json: string | null
  receipt_json: string | null
  target_fingerprint_after: Sha256Digest | null
  started_at: string
  finished_at: string | null
}

interface DeliveryApplyOutboxRow {
  outbox_id: string
  apply_attempt_id: DeliveryApplyAttemptId
  request_digest: Sha256Digest
  request_json: string
  status: DeliveryApplyOutboxStateV1
  claim_owner_id: string | null
  claim_digest: string | null
  claimed_at: string | null
  completed_at: string | null
  created_at: string
}

export interface WorkspacePrepareOutboxClaimRecordM2B2V1 {
  outboxId: string
  attemptId: AttemptId
  requestDigest: string
  status: 'CLAIMED'
  claimOwnerId: string
  claimDigest: string
  claimedAt: string
}

type ReadableProjectionV1 = Omit<SessionCollaborationProjectionV1, 'activeRevision'> & {
  activeRevision:
    | (Omit<NonNullable<SessionCollaborationProjectionV1['activeRevision']>, 'draft'> & {
        draft?: CanonicalPlanDraftV1
      })
    | null
}

export interface StartDraftRecordV1 {
  flowId: FlowId
  revisionId: PlanRevisionId
  draft: CanonicalPlanDraftV1
  digest: string
  projection: SessionCollaborationProjectionV1
  receipt: PerformReceiptV1
  eventType: string
  now: string
}

export interface SubmitRevisionRecordV1 {
  flowId: FlowId
  revisionId: PlanRevisionId
  draft: CanonicalPlanDraftV1
  projection: SessionCollaborationProjectionV1
  receipt: PerformReceiptV1
  now: string
}

export interface CancelFlowRecordV1 {
  flowId: FlowId
  projection: SessionCollaborationProjectionV1
  receipt: PerformReceiptV1
  reason: string
  now: string
}

export interface ScheduleRecordM2BV1 {
  flowId: FlowId
  expectedSessionVersion?: number
  taskRunId: TaskRunId
  attemptId: AttemptId
  attemptDigest: string
  compositionDigest: string
  baselineBindingDigest: string
  flowBaselineBindingDigest: string
  baselineId: string
  baseRevision?: string
  baselineTreeHash: string
  initialTargetFingerprint: string
  baselineDigest: string
  taskBaselineId: string
  taskBaseRevision?: string
  taskBaselineTreeHash: string
  taskInitialTargetFingerprint: string
  taskBaselineDigest: string
  taskBaselineDerivationDigest: string
  ancestorTaskChangeSetIds: readonly string[]
  executionWave: ExecutionWaveV1
  runtimeBinding: AttemptRuntimeBindingV1
  authorizationScope: TaskFileAuthorizationScopeV1
  workspacePrepareRequestDigest: string
  projection: SessionCollaborationProjectionV1
  receipt: PerformReceiptV1
  now: string
}

export interface WorkspacePreparedRecordM2BV1 {
  flowId: FlowId
  taskRunId: TaskRunId
  attemptId: AttemptId
  receipt: PerformReceiptV1
  workspaceReceipt: WorkspacePreparedReceiptM2BV1
  now: string
}

export interface AgentDispatchRecordM2BV1 {
  attemptId: AttemptId
  taskRunId: TaskRunId
  requestId: string
  payloadDigest: string
  runtimeRequestJson: string
  runtimeRequestDigest: string
  selectionDigest: string
  now: string
}

export interface AgentReportRecordM2BV1 extends AgentDispatchRecordM2BV1 {
  runtimeSessionId: string
  reportDigest: string
  receipt: PerformReceiptV1
}

export interface AgentOutcomeRecordM2BV1 {
  attemptId: AttemptId
  taskRunId: TaskRunId
  runtimeSessionId: string
  outcome: 'FAILED' | 'INTERRUPTED' | 'OUTCOME_UNKNOWN'
  receiptDigest: string
  failure?: AgentFailureSignalV1
  succeededAudit?: AgentSucceededAuditV1
  receipt: PerformReceiptV1
  now: string
}

/** Internal TaskHub authority record for an unprovable verified checkpoint restore. */
export interface CheckpointRestoreOutcomeUnknownRecordV1 {
  readonly flowId: FlowId
  readonly taskRunId: TaskRunId
  readonly attemptId: AttemptId
  readonly reasonCode: string
  readonly receiptDigest: string
  readonly now: string
}

export interface AgentReconcileRecordM2BV1 {
  attemptId: AttemptId
  runtimeSessionId: string
  expectedReceiptDigest?: string
  outcome: 'FAILED' | 'INTERRUPTED' | 'OUTCOME_UNKNOWN'
  receiptDigest: string
  failure?: AgentFailureSignalV1
  succeededAudit?: AgentSucceededAuditV1
  receipt: PerformReceiptV1
  now: string
}

export interface TaskArtifactWriteV1 {
  artifactId: ArtifactId
  contentDigest: string
  kind: 'PATCH' | 'VERIFICATION_EVIDENCE' | 'VERIFICATION_DIAGNOSTIC' | 'DELIVERY_FILE_CONTENT'
  mediaType: string
  content: Uint8Array
}

export interface BeginTaskVerificationRecordV1 {
  patchArtifact: TaskArtifactWriteV1
  candidate: ChangeSetCandidateV1
  ancestorTaskChangeSetIds: readonly TaskChangeSetId[]
  succeededAudit: AgentSucceededAuditV1
  reconcileStart?: {
    idempotency: IdempotencyInput
    receipt: PerformReceiptV1
    runtimeSessionId: string
    expectedReceiptDigest?: string
    receiptDigest: string
  }
  verificationAttempt: Extract<VerificationAttemptV1, { scope: 'TASK' }>
  verificationRequestJson: string
  now: string
}

export interface TaskVerificationBeginResultV1 {
  verificationAttemptId: string
  outboxId: string
  replayed: boolean
}

export interface VerificationOutboxRecordV1 {
  outboxId: string
  verificationAttemptId: string
  requestDigest: string
  requestJson: string
  status: 'READY' | 'CLAIMED' | 'DONE' | 'FAILED' | 'OUTCOME_UNKNOWN'
  claimOwnerId?: string
  claimDigest?: string
  claimedAt?: string
  completedAt?: string
  createdAt: string
}

export interface PendingTaskVerificationRecordV1 {
  address: HubAddressV1
  outbox: VerificationOutboxRecordV1
}

export interface CompleteTaskVerificationRecordV1 {
  receipt: TaskVerificationReceiptV1
  evidenceBundle?: TaskEvidenceBundleV1
  qaResult?: TaskPassedQaResultV1
  taskChangeSet?: TaskChangeSetV1
  evidenceArtifacts?: readonly TaskArtifactWriteV1[]
  diagnosticArtifacts?: readonly TaskArtifactWriteV1[]
  now: string
}

export interface TaskVerificationCompletionResultV1 {
  verificationAttemptId: string
  verdict: TaskVerificationReceiptV1['verdict']
  replayed: boolean
}

export interface CreateDeliverySelectionRecordV1 {
  batchId: DeliveryBatchId
  draftId: DeliverySelectionDraftId
  flowId: FlowId
  selectedTaskRunIds: readonly TaskRunId[]
  targetFingerprint: Sha256Digest
  now: string
}

export interface CreateDeliverySelectionResultV1 {
  batchId: DeliveryBatchId
  selectionDigest: Sha256Digest
  replayed: boolean
}

export interface BeginDeliveryVerificationRecordV1 {
  verificationAttemptId: DeliveryVerificationAttemptId
  verificationRequestJson: string
  now: string
}

export interface DeliveryVerificationBeginResultV1 {
  verificationAttemptId: DeliveryVerificationAttemptId
  outboxId: string
  replayed: boolean
}

export interface DeliveryVerificationOutboxRecordV1 {
  outboxId: string
  verificationAttemptId: DeliveryVerificationAttemptId
  requestDigest: Sha256Digest
  requestJson: string
  status: DeliveryVerificationOutboxStateV1
  claimOwnerId?: string
  claimDigest?: string
  claimedAt?: string
  completedAt?: string
  createdAt: string
}

export interface CompleteDeliveryVerificationRecordV1 {
  receipt: DeliveryVerificationReceiptV1
  deliveryChangeSet?: DeliveryChangeSetV1
  deliveryFileArtifacts?: readonly DeliveryFileArtifactWriteV1[]
  evidenceArtifacts?: readonly TaskArtifactWriteV1[]
  diagnosticArtifacts?: readonly TaskArtifactWriteV1[]
  gateId?: DeliveryGateId
  now: string
}

export interface DeliveryVerificationCompletionResultV1 {
  verificationAttemptId: DeliveryVerificationAttemptId
  verdict: DeliveryVerificationReceiptV1['verdict']
  replayed: boolean
}

export interface DecideDeliveryGateRecordV1 {
  gateId: DeliveryGateId
  batchId: DeliveryBatchId
  deliveryChangeSetId: DeliveryChangeSetId
  version: 1
  digest: Sha256Digest
  decision: 'APPROVE' | 'REJECT'
  decisionDigest: Sha256Digest
  now: string
}

export interface DeliveryGateDecisionResultV1 {
  gateId: DeliveryGateId
  state: 'APPROVED' | 'REJECTED'
  replayed: boolean
}

export interface BeginDeliveryApplyRecordV1 {
  applyAttemptId: DeliveryApplyAttemptId
  batchId: DeliveryBatchId
  deliveryChangeSetId: DeliveryChangeSetId
  requestDigest: Sha256Digest
  requestJson: string
  targetFingerprintBefore: Sha256Digest
  now: string
}

export interface DeliveryApplyBeginResultV1 {
  applyAttemptId: DeliveryApplyAttemptId
  outboxId: string
  replayed: boolean
}

export interface CompleteDeliveryApplyRecordV1 {
  applyAttemptId: DeliveryApplyAttemptId
  outcome: 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN'
  receipt: DeliveryApplyReceiptV1
  now: string
}

export interface DeliveryApplyCompletionResultV1 {
  applyAttemptId: DeliveryApplyAttemptId
  outcome: CompleteDeliveryApplyRecordV1['outcome']
  replayed: boolean
}

export interface SealRecoveredDeliveryCandidateRecordV1 {
  sourceBatchId: DeliveryBatchId
  sourceFailedApplyAttemptId: DeliveryApplyAttemptId
  batchId: DeliveryBatchId
  draftId: DeliverySelectionDraftId
  verificationAttemptId: DeliveryVerificationAttemptId
  verificationRequestJson: string
  receipt: DeliveryVerificationReceiptV1
  deliveryChangeSet: DeliveryChangeSetV1
  deliveryFileArtifacts: readonly DeliveryFileArtifactWriteV1[]
  evidenceArtifacts?: readonly TaskArtifactWriteV1[]
  diagnosticArtifacts?: readonly TaskArtifactWriteV1[]
  gateId: DeliveryGateId
  recoveryLineage: DeliveryRecoveryLineageV1
  now: string
}

export interface SealRecoveredDeliveryCandidateResultV1 {
  batchId: DeliveryBatchId
  replayed: boolean
}

export interface DeliveryArtifactContentRecordV1 {
  artifactId: ArtifactId
  kind: string
  mediaType: string
  contentDigest: Sha256Digest
  content: Uint8Array
}

export interface DeliveryFileArtifactWriteV1 {
  artifactId: ArtifactId
  contentDigest: Sha256Digest
  kind: 'DELIVERY_FILE_CONTENT'
  mediaType: 'application/vnd.xiaogui.delivery-file-content'
  content: Uint8Array
}

export interface DeliveryApplyOutboxRecordV1 {
  outboxId: string
  applyAttemptId: DeliveryApplyAttemptId
  requestDigest: Sha256Digest
  requestJson: string
  status: DeliveryApplyOutboxStateV1
  claimOwnerId?: string
  claimDigest?: string
  claimedAt?: string
  completedAt?: string
  createdAt: string
}

export interface DeliveryApplyPackageRecordV1 {
  applyAttempt: DeliveryApplyAttemptV1
  changeSet: DeliveryChangeSetV1
  fileArtifacts: readonly DeliveryArtifactContentRecordV1[]
}

export interface PendingDeliveryApplyOutboxRecordV1 {
  address: HubAddressV1
  outbox: DeliveryApplyOutboxRecordV1
}

export interface PendingDeliveryVerificationOutboxRecordV1 {
  address: HubAddressV1
  outbox: DeliveryVerificationOutboxRecordV1
}

export class CollaborationHubSqliteStoreV1 {
  private readonly db: DatabaseSync

  constructor(private readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('pragma foreign_keys = on')
    this.db.exec('pragma journal_mode = WAL')
    this.db.exec('pragma busy_timeout = 5000')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  readProjection(address: HubAddressV1): SessionCollaborationProjectionV1 | null {
    const row = this.db
      .prepare('select projection_json from session_projection where project_id = ? and session_key = ?')
      .get(address.projectId, address.sessionKey) as { projection_json: string } | undefined
    if (!row) return null

    const projection = JSON.parse(row.projection_json) as ReadableProjectionV1
    const activeRevision = projection.activeRevision
    if (!activeRevision || activeRevision.draft !== undefined) {
      return projection as SessionCollaborationProjectionV1
    }

    // M2A 在 M3A 补洞前写入的 projection 不含 draft；权威草稿已存在
    // plan_revisions.draft_json。只在读取时补齐，不写回、不迁移 schema。
    const revision = this.revision(activeRevision.revisionId)
    if (!revision || revision.digest !== activeRevision.digest) {
      throw new Error('active revision projection is inconsistent with its revision record')
    }
    return {
      ...projection,
      activeRevision: {
        ...activeRevision,
        draft: JSON.parse(revision.draft_json) as CanonicalPlanDraftV1,
      },
    }
  }

  readProjectionM2B(address: HubAddressV1): SessionCollaborationProjectionM2BV1 | null {
    const base = this.readProjection(address)
    if (!base) return null
    const runs = this.taskRunsForFlow(base.activeFlow?.flowId ?? null)
    const attempts = this.attemptsForFlow(base.activeFlow?.flowId ?? null)
    const taskRuns: TaskRunProjectionM2BV1[] = base.taskRuns.map((run) => {
      const row = runs.find((item) => item.task_run_id === run.taskRunId)
      const attempt = attempts.find((item) => item.task_run_id === run.taskRunId)
      return {
        taskRunId: run.taskRunId,
        taskSpecId: run.taskSpecId,
        taskKey: run.taskKey,
        status: toM2BTaskRunStatus(row?.status ?? run.status),
        ...(attempt ? { attemptId: attempt.attempt_id } : {}),
      }
    })
    return {
      ...base,
      version: 'm2b.v1',
      taskRuns,
      attempts: attempts.map((attempt) => {
        const verificationSummary = this.verificationSummaryForAttempt(attempt.attempt_id)
        const runtimeBinding = this.attemptRuntimeBinding(attempt.attempt_id)
        return {
          attemptId: attempt.attempt_id,
          taskRunId: attempt.task_run_id,
          status: attempt.status as AttemptProjectionM2BV1['status'],
          ...(attempt.workspace_receipt_id ? { workspaceReceiptId: attempt.workspace_receipt_id } : {}),
          ...(verificationSummary ? { verificationSummary } : {}),
          ...(runtimeBinding ? { runtimeBinding } : {}),
        }
      }),
      ...(base.activeFlow
        ? { lastExecutionWave: this.lastExecutionWave(base.activeFlow.flowId) ?? undefined }
        : {}),
      availableActions: base.availableActions,
    }
  }

  readEvents(address: HubAddressV1, request: HubReadEventsRequestV1 = {}): HubEventEnvelopeV1[] {
    const after = request.afterSessionSequence ?? 0
    const limit = Math.max(1, Math.min(request.limit ?? 100, 500))
    return this.db
      .prepare(
        'select event_id as eventId, version as sessionVersion, session_sequence as sessionSequence, event_type as eventType, created_at as createdAt from journal_events where project_id = ? and session_key = ? and session_sequence > ? order by session_sequence asc limit ?',
      )
      .all(address.projectId, address.sessionKey, after, limit) as unknown as HubEventEnvelopeV1[]
  }

  currentVersion(address: HubAddressV1): number {
    return this.readProjection(address)?.sessionVersion ?? 0
  }

  activeFlow(address: HubAddressV1): FlowRecord | null {
    const row = this.db
      .prepare(
        "select flow_id, status, active_revision_id, objective from flows where project_id = ? and session_key = ? and status != 'CANCELLED' order by rowid desc limit 1",
      )
      .get(address.projectId, address.sessionKey) as FlowRecord | undefined
    return row ?? null
  }

  revision(revisionId: PlanRevisionId): RevisionRecord | null {
    const row = this.db
      .prepare('select revision_id, status, digest, draft_json from plan_revisions where revision_id = ?')
      .get(revisionId) as RevisionRecord | undefined
    return row ?? null
  }

  taskRun(taskRunId: TaskRunId): TaskRunRecord | null {
    const row = this.db
      .prepare(
        'select tr.task_run_id, tr.task_spec_id, tr.flow_id, tr.task_key, tr.status, tr.unavailable_reason, ts.depends_json from task_runs tr join task_specs ts on ts.task_spec_id = tr.task_spec_id where tr.task_run_id = ?',
      )
      .get(taskRunId) as TaskRunRecord | undefined
    return row ?? null
  }

  taskRuns(flowId: FlowId): TaskRunRecord[] {
    return this.taskRunsForFlow(flowId)
  }

  schedulerTasks(flowId: FlowId): SchedulerTaskV1[] {
    return this.db
      .prepare(`
        select tr.task_run_id as taskRunId, tr.task_key as taskKey, tr.status,
               ts.depends_json as dependsJson, tcs.task_change_set_id as taskChangeSetId
          from task_runs tr
          join task_specs ts on ts.task_spec_id = tr.task_spec_id
          left join task_change_sets tcs on tcs.task_run_id = tr.task_run_id
         where tr.flow_id = ?
         order by tr.rowid
      `)
      .all(flowId)
      .map((row) => {
        const value = row as unknown as {
          taskRunId: TaskRunId
          taskKey: string
          status: string
          dependsJson: string
          taskChangeSetId: string | null
        }
        return {
          taskRunId: value.taskRunId,
          taskKey: value.taskKey,
          status: value.status,
          dependsOn: JSON.parse(value.dependsJson) as string[],
          ...(value.taskChangeSetId ? { taskChangeSetId: value.taskChangeSetId } : {}),
        }
      })
  }

  schedulerAttempts(projectId: string): SchedulerAttemptV1[] {
    return this.db
      .prepare(`
        select a.attempt_id as attemptId, a.task_run_id as taskRunId, a.status,
               coalesce(s.path_tokens_json, '[]') as pathTokensJson
          from attempts a
          join flows f on f.flow_id = a.flow_id
          left join attempt_authorization_scopes s on s.attempt_id = a.attempt_id
         where a.project_id = ?
           and ${activeSchedulerAttemptSql('a', 'f.status')}
         order by a.rowid
      `)
      .all(projectId)
      .map((row) => {
        const value = row as unknown as {
          attemptId: AttemptId
          taskRunId: TaskRunId
          status: string
          pathTokensJson: string
        }
        return {
          attemptId: value.attemptId,
          taskRunId: value.taskRunId,
          status: value.status,
          authorizationPathTokens: JSON.parse(value.pathTokensJson) as string[],
        }
      })
  }

  taskChangeSetAncestorIds(
    address: HubAddressV1,
    flowId: FlowId,
    taskRunId: TaskRunId,
  ): readonly TaskChangeSetId[] {
    const scope = this.db
      .prepare(
        'select f.project_id, f.session_key from flows f join task_runs tr on tr.flow_id = f.flow_id where f.flow_id = ? and tr.task_run_id = ?',
      )
      .get(flowId, taskRunId) as { project_id: string; session_key: string } | undefined
    if (!scope || scope.project_id !== address.projectId || scope.session_key !== address.sessionKey) {
      throw verificationStoreError('TASK_VERIFICATION_SCOPE_MISMATCH')
    }
    return taskChangeSetAncestorIdsForTask(this.db, flowId, taskRunId)
  }

  createDeliverySelection(
    address: HubAddressV1,
    record: CreateDeliverySelectionRecordV1,
  ): CreateDeliverySelectionResultV1 {
    return this.transaction(() => {
      const active = this.activeDeliveryBatch(address, record.flowId)
      if (active) {
        const existingDraft = this.readDeliverySelectionDraft(active.batch_id)
        if (existingDraft && sameStringArray(existingDraft.selectedTaskRunIds, record.selectedTaskRunIds)) {
          return { batchId: active.batch_id, selectionDigest: active.selection_digest, replayed: true }
        }
        throw deliveryStoreError('DELIVERY_ACTIVE_BATCH_EXISTS')
      }
      const draft = this.buildDeliverySelectionDraft(record)
      const flow = this.db
        .prepare('select project_id, session_key, status from flows where flow_id = ?')
        .get(record.flowId) as { project_id: string; session_key: string; status: string } | undefined
      if (
        !flow ||
        flow.project_id !== address.projectId ||
        flow.session_key !== address.sessionKey ||
        flow.status !== 'PLAN_ACTIVE'
      ) {
        throw deliveryStoreError('DELIVERY_FLOW_NOT_ACTIVE')
      }

      this.db
        .prepare(
          'insert into delivery_batches (batch_id, project_id, session_key, flow_id, selection_draft_id, state, selection_digest, target_fingerprint, recovery_source_batch_id, recovery_source_apply_attempt_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?)',
        )
        .run(
          record.batchId,
          address.projectId,
          address.sessionKey,
          record.flowId,
          record.draftId,
          'COMPOSING',
          draft.digest,
          record.targetFingerprint,
          record.now,
          record.now,
        )
      this.db
        .prepare(
          'insert into delivery_selection_drafts (draft_id, batch_id, flow_id, selected_task_run_ids_json, resolved_task_change_set_ids_json, dependency_task_run_ids_json, selection_digest, draft_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.draftId,
          record.batchId,
          draft.flowId,
          JSON.stringify(draft.selectedTaskRunIds ?? []),
          JSON.stringify((draft.resolvedTaskChangeSets ?? []).map((item) => item.taskChangeSetId)),
          JSON.stringify(draft.dependencyTaskRunIds ?? []),
          draft.digest,
          JSON.stringify(draft),
          draft.createdAt,
        )
      for (const taskRunId of draft.selectedTaskRunIds ?? []) {
        const updated = this.db
          .prepare("update task_runs set status = 'DELIVERY_PENDING' where task_run_id = ? and status = 'VERIFIED'")
          .run(taskRunId)
        if (updated.changes !== 1) throw deliveryStoreError('DELIVERY_TASK_STATUS_CONFLICT')
      }
      const version = this.currentVersion(address) + 1
      this.writeEvent(address, version, 'delivery.selection.submit', {
        phase: 'delivery.selection.created',
        flowId: record.flowId,
        batchId: record.batchId,
        selectionDigest: draft.digest,
        taskRunIds: draft.selectedTaskRunIds,
      }, record.now)
      this.bumpProjectionVersion(address, version)
      return { batchId: record.batchId, selectionDigest: draft.digest, replayed: false }
    })
  }

  readActiveDelivery(address: HubAddressV1, flowId: FlowId): DeliveryBatchProjectionV1 | null {
    const batch = this.activeDeliveryBatch(address, flowId)
    return batch ? this.deliveryProjection(batch.batch_id) : null
  }

  readDeliveryProjection(batchId: DeliveryBatchId): DeliveryBatchProjectionV1 | null {
    return this.deliveryProjection(batchId)
  }

  readRecoveredDeliveryProjection(
    address: HubAddressV1,
    sourceBatchId: DeliveryBatchId,
    sourceFailedApplyAttemptId: DeliveryApplyAttemptId,
  ): DeliveryBatchProjectionV1 | null {
    const row = this.db
      .prepare(
        'select batch_id, recovery_source_apply_attempt_id from delivery_batches where project_id = ? and session_key = ? and recovery_source_batch_id = ?',
      )
      .get(address.projectId, address.sessionKey, sourceBatchId) as
      | { batch_id: DeliveryBatchId; recovery_source_apply_attempt_id: DeliveryApplyAttemptId | null }
      | undefined
    if (row && row.recovery_source_apply_attempt_id !== sourceFailedApplyAttemptId) {
      throw deliveryStoreError('DELIVERY_RECOVERY_IDEMPOTENCY_CONFLICT')
    }
    return row ? this.deliveryProjection(row.batch_id) : null
  }

  verifiedTaskChangeSetsForFlow(flowId: FlowId): readonly DeliveryTaskChangeSetRefV1[] {
    return this.db
      .prepare(
        'select task_run_id as taskRunId, task_change_set_id as taskChangeSetId, digest, patch_artifact_id as patchArtifactId from task_change_sets where flow_id = ? order by rowid asc',
      )
      .all(flowId) as unknown as DeliveryTaskChangeSetRefV1[]
  }

  readArtifactContent(artifactId: ArtifactId): Uint8Array | null {
    const row = this.db.prepare('select content from artifacts where artifact_id = ?').get(artifactId) as
      | { content: Uint8Array }
      | undefined
    return row?.content ?? null
  }

  readArtifact(artifactId: ArtifactId): DeliveryArtifactContentRecordV1 | null {
    const row = this.db
      .prepare('select artifact_id, kind, media_type, content_digest, content from artifacts where artifact_id = ?')
      .get(artifactId) as
      | {
          artifact_id: ArtifactId
          kind: string
          media_type: string
          content_digest: Sha256Digest
          content: Uint8Array
        }
      | undefined
    return row
      ? {
          artifactId: row.artifact_id,
          kind: row.kind,
          mediaType: row.media_type,
          contentDigest: row.content_digest,
          content: row.content,
        }
      : null
  }

  readDeliverySelectionDraft(batchId: DeliveryBatchId): DeliverySelectionDraftV1 | null {
    const row = this.db
      .prepare('select draft_json from delivery_selection_drafts where batch_id = ?')
      .get(batchId) as { draft_json: string } | undefined
    return row ? JSON.parse(row.draft_json) as DeliverySelectionDraftV1 : null
  }

  readTaskChangeSet(taskChangeSetId: TaskChangeSetId): TaskChangeSetV1 | null {
    const row = this.db
      .prepare('select change_set_json from task_change_sets where task_change_set_id = ?')
      .get(taskChangeSetId) as { change_set_json: string } | undefined
    return row ? JSON.parse(row.change_set_json) as TaskChangeSetV1 : null
  }

  readDeliveryChangeSet(deliveryChangeSetId: DeliveryChangeSetId): DeliveryChangeSetV1 | null {
    const row = this.deliveryChangeSet(deliveryChangeSetId)
    return row ? JSON.parse(row.change_set_json) as DeliveryChangeSetV1 : null
  }

  readDeliveryChangeSetForBatch(batchId: DeliveryBatchId): DeliveryChangeSetV1 | null {
    const row = this.db
      .prepare('select change_set_json from delivery_change_sets where batch_id = ? order by rowid desc limit 1')
      .get(batchId) as { change_set_json: string } | undefined
    return row ? JSON.parse(row.change_set_json) as DeliveryChangeSetV1 : null
  }

  readDeliveryGate(gateId: DeliveryGateId): DeliveryHumanGateV1 | null {
    const row = this.deliveryGate(gateId)
    return row ? toDeliveryHumanGate(row) : null
  }

  rejectComposingDelivery(address: HubAddressV1, batchId: DeliveryBatchId, reasonCode: string, now: string): void {
    this.transaction(() => {
      const batch = this.deliveryBatch(batchId)
      if (!batch || batch.project_id !== address.projectId || batch.session_key !== address.sessionKey) {
        throw deliveryStoreError('DELIVERY_SCOPE_MISMATCH')
      }
      const updated = this.db
        .prepare("update delivery_batches set state = 'REJECTED', updated_at = ? where batch_id = ? and state = 'COMPOSING'")
        .run(now, batchId)
      if (updated.changes !== 1) throw deliveryStoreError('DELIVERY_ILLEGAL_TRANSITION')
      this.restoreDeliveryTasks(batchId, 'VERIFIED')
      const version = this.currentVersion(address) + 1
      this.writeEvent(address, version, 'delivery.composition.rejected', {
        phase: 'delivery_composition.rejected',
        batchId,
        reasonCode,
      }, now)
      this.bumpProjectionVersion(address, version)
    })
  }

  writeDeliveryFileArtifacts(artifacts: readonly DeliveryFileArtifactWriteV1[], now: string): void {
    this.transaction(() => {
      for (const artifact of artifacts) {
        assertArtifactIdAvailable(this.db, artifact)
        insertArtifact(this.db, artifact, now)
      }
    })
  }

  beginDeliveryVerification(
    address: HubAddressV1,
    record: BeginDeliveryVerificationRecordV1,
  ): DeliveryVerificationBeginResultV1 {
    return this.transaction(() => {
      const request = parseDeliveryVerificationRequest(record.verificationRequestJson)
      if (request.verificationAttemptId !== record.verificationAttemptId) {
        throw deliveryStoreError('DELIVERY_VERIFICATION_BINDING_MISMATCH')
      }
      const requestBatchId = request.batchId as DeliveryBatchId
      const batch = this.deliveryBatch(requestBatchId)
      if (!batch || batch.project_id !== address.projectId || batch.session_key !== address.sessionKey) {
        throw deliveryStoreError('DELIVERY_SCOPE_MISMATCH')
      }
      if (
        request.flowId !== batch.flow_id ||
        request.selectionDigest !== batch.selection_digest ||
        request.targetFingerprint !== batch.target_fingerprint ||
        deliveryVerificationRequestDigestV1(request) !== request.requestDigest
      ) {
        throw deliveryStoreError('DELIVERY_VERIFICATION_BINDING_MISMATCH')
      }
      const existing = this.deliveryVerificationAttempt(record.verificationAttemptId)
      if (existing) {
        if (
          existing.batch_id === requestBatchId &&
          existing.request_digest === request.requestDigest &&
          existing.state === 'STARTED'
        ) {
          return {
            verificationAttemptId: existing.delivery_verification_attempt_id,
            outboxId: `xhbdvo_${existing.delivery_verification_attempt_id}`,
            replayed: true,
          }
        }
        throw deliveryStoreError('DELIVERY_VERIFICATION_IDEMPOTENCY_CONFLICT')
      }
      if (batch.state !== 'COMPOSING') throw deliveryStoreError('DELIVERY_ILLEGAL_TRANSITION')
      this.db
        .prepare(
          'insert into delivery_verification_attempts (delivery_verification_attempt_id, verification_request_id, batch_id, flow_id, request_digest, selection_digest, qa_config_version, state, started_at, finished_at, outcome_receipt_digest) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, null)',
        )
        .run(
          record.verificationAttemptId,
          request.verificationRequestId,
          requestBatchId,
          request.flowId,
          request.requestDigest,
          request.selectionDigest,
          request.qaConfigVersion,
          'STARTED',
          record.now,
        )
      const outboxId = `xhbdvo_${record.verificationAttemptId}`
      this.db
        .prepare(
          'insert into delivery_verification_outbox (outbox_id, delivery_verification_attempt_id, request_digest, request_json, status, created_at) values (?, ?, ?, ?, ?, ?)',
        )
        .run(outboxId, record.verificationAttemptId, request.requestDigest, record.verificationRequestJson, 'READY', record.now)
      this.db
        .prepare("update delivery_batches set state = 'VERIFYING', updated_at = ? where batch_id = ? and state = 'COMPOSING'")
        .run(record.now, requestBatchId)
      const version = this.currentVersion(address) + 1
      this.writeEvent(address, version, 'system.delivery.verification.begin', {
        phase: 'delivery_verification.started',
        batchId: requestBatchId,
        verificationAttemptId: record.verificationAttemptId,
      }, record.now)
      this.bumpProjectionVersion(address, version)
      return { verificationAttemptId: record.verificationAttemptId, outboxId, replayed: false }
    })
  }

  readDeliveryVerificationOutbox(
    verificationAttemptId: DeliveryVerificationAttemptId,
  ): DeliveryVerificationOutboxRecordV1 | null {
    const row = this.db
      .prepare(
        'select outbox_id, delivery_verification_attempt_id, request_digest, request_json, status, claim_owner_id, claim_digest, claimed_at, completed_at, created_at from delivery_verification_outbox where delivery_verification_attempt_id = ?',
      )
      .get(verificationAttemptId) as DeliveryVerificationOutboxRow | undefined
    return row ? toDeliveryVerificationOutboxRecord(row) : null
  }

  claimDeliveryVerificationOutbox(input: {
    verificationAttemptId: DeliveryVerificationAttemptId
    ownerId: string
    claimDigest: string
    now: string
  }): DeliveryVerificationOutboxRecordV1 | null {
    return this.transaction(() => {
      this.db
        .prepare(
          "update delivery_verification_outbox set status = 'CLAIMED', claim_owner_id = ?, claim_digest = ?, claimed_at = ? where delivery_verification_attempt_id = ? and status = 'READY'",
        )
        .run(input.ownerId, input.claimDigest, input.now, input.verificationAttemptId)
      const row = this.db
        .prepare(
          'select outbox_id, delivery_verification_attempt_id, request_digest, request_json, status, claim_owner_id, claim_digest, claimed_at, completed_at, created_at from delivery_verification_outbox where delivery_verification_attempt_id = ?',
        )
        .get(input.verificationAttemptId) as DeliveryVerificationOutboxRow | undefined
      if (
        !row ||
        row.status !== 'CLAIMED' ||
        row.claim_owner_id !== input.ownerId ||
        row.claim_digest !== input.claimDigest
      ) {
        return null
      }
      return toDeliveryVerificationOutboxRecord(row)
    })
  }

  pendingDeliveryVerificationOutboxes(): readonly PendingDeliveryVerificationOutboxRecordV1[] {
    return this.db
      .prepare(
        "select db.project_id, db.session_key, dvo.outbox_id, dvo.delivery_verification_attempt_id, dvo.request_digest, dvo.request_json, dvo.status, dvo.claim_owner_id, dvo.claim_digest, dvo.claimed_at, dvo.completed_at, dvo.created_at from delivery_verification_outbox dvo join delivery_verification_attempts dva on dva.delivery_verification_attempt_id = dvo.delivery_verification_attempt_id join delivery_batches db on db.batch_id = dva.batch_id where dvo.status in ('READY', 'CLAIMED') order by dvo.rowid asc",
      )
      .all()
      .map((row) => {
        const typed = row as unknown as DeliveryVerificationOutboxRow & { project_id: string; session_key: string }
        return {
          address: { projectId: typed.project_id, sessionKey: typed.session_key } as HubAddressV1,
          outbox: toDeliveryVerificationOutboxRecord(typed),
        }
      })
  }

  completeDeliveryVerification(
    address: HubAddressV1,
    record: CompleteDeliveryVerificationRecordV1,
  ): DeliveryVerificationCompletionResultV1 {
    return this.transaction(() => {
      validateDeliveryVerificationReceipt(record.receipt)
      const attempt = this.deliveryVerificationAttempt(record.receipt.verificationAttemptId)
      if (!attempt) throw deliveryStoreError('DELIVERY_VERIFICATION_NOT_FOUND')
      const batch = this.deliveryBatch(attempt.batch_id)
      if (!batch || batch.project_id !== address.projectId || batch.session_key !== address.sessionKey) {
        throw deliveryStoreError('DELIVERY_SCOPE_MISMATCH')
      }
      if (
        record.receipt.batchId !== batch.batch_id ||
        record.receipt.flowId !== batch.flow_id ||
        record.receipt.requestDigest !== attempt.request_digest ||
        record.receipt.selectionDigest !== attempt.selection_digest ||
        record.receipt.qaConfigVersion !== attempt.qa_config_version
      ) {
        throw deliveryStoreError('DELIVERY_VERIFICATION_BINDING_MISMATCH')
      }
      const existing = this.db
        .prepare('select receipt_json from delivery_verification_receipts where receipt_digest = ?')
        .get(record.receipt.receiptDigest) as { receipt_json: string } | undefined
      if (attempt.state !== 'STARTED') {
        if (
          attempt.outcome_receipt_digest === record.receipt.receiptDigest &&
          existing?.receipt_json === JSON.stringify(record.receipt) &&
          deliveryVerificationStateForVerdict(record.receipt.verdict) === attempt.state
        ) {
          return {
            verificationAttemptId: attempt.delivery_verification_attempt_id,
            verdict: record.receipt.verdict,
            replayed: true,
          }
        }
        throw deliveryStoreError('DELIVERY_VERIFICATION_IDEMPOTENCY_CONFLICT')
      }
      if (existing) throw deliveryStoreError('DELIVERY_VERIFICATION_IDEMPOTENCY_CONFLICT')
      const outbox = this.readDeliveryVerificationOutbox(attempt.delivery_verification_attempt_id)
      if (!outbox || outbox.status !== 'CLAIMED' || outbox.requestDigest !== attempt.request_digest) {
        throw deliveryStoreError('DELIVERY_VERIFICATION_OUTBOX_NOT_CLAIMED')
      }
      for (const artifact of [...(record.evidenceArtifacts ?? []), ...(record.diagnosticArtifacts ?? [])]) {
        assertArtifactIdAvailable(this.db, artifact)
        insertArtifact(this.db, artifact, record.now)
      }
      this.db
        .prepare(
          'insert into delivery_verification_receipts (receipt_digest, delivery_verification_attempt_id, request_digest, verdict, receipt_json, diagnostic_artifact_ids_json, created_at) values (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.receipt.receiptDigest,
          attempt.delivery_verification_attempt_id,
          attempt.request_digest,
          record.receipt.verdict,
          JSON.stringify(record.receipt),
          JSON.stringify(record.receipt.diagnosticArtifactIds),
          record.now,
        )
      if (record.receipt.verdict === 'PASS') {
        if (!record.deliveryChangeSet || !record.gateId) throw deliveryStoreError('DELIVERY_CHANGESET_REQUIRED')
        validateDeliveryChangeSet(batch, record.receipt, record.deliveryChangeSet)
        for (const artifact of record.deliveryFileArtifacts ?? []) {
          if (artifact.kind !== 'DELIVERY_FILE_CONTENT') throw deliveryStoreError('DELIVERY_ARTIFACT_INVALID')
          assertArtifactIdAvailable(this.db, artifact)
          insertArtifact(this.db, artifact, record.now)
        }
        this.insertDeliveryChangeSet(record.deliveryChangeSet)
        const gate: DeliveryHumanGateV1 = {
          gateId: record.gateId,
          batchId: batch.batch_id,
          subject: {
            deliveryChangeSetId: record.deliveryChangeSet.deliveryChangeSetId,
            version: 1,
            digest: record.deliveryChangeSet.digest,
          },
          state: 'OPEN',
          createdAt: record.now as never,
        }
        this.db
          .prepare(
            'insert into delivery_human_gates (gate_id, batch_id, delivery_change_set_id, subject_version, subject_digest, state, decision_digest, decided_at, gate_json, created_at) values (?, ?, ?, ?, ?, ?, null, null, ?, ?)',
          )
          .run(
            gate.gateId,
            gate.batchId,
            gate.subject.deliveryChangeSetId,
            gate.subject.version,
            gate.subject.digest,
            gate.state,
            JSON.stringify(gate),
            record.now,
          )
        this.finishDeliveryVerificationRows(attempt, 'SUCCEEDED', 'DONE', 'READY_FOR_REVIEW', record.receipt.receiptDigest, record.now)
      } else {
        if (record.deliveryChangeSet || record.gateId || record.deliveryFileArtifacts?.length) {
          throw deliveryStoreError('DELIVERY_UNSEALED_OBJECTS_FORBIDDEN')
        }
        const nextBatchState = record.receipt.verdict === 'FAIL' ? 'REJECTED' : 'OUTCOME_UNKNOWN'
        const nextOutboxState = record.receipt.verdict === 'FAIL' ? 'FAILED' : 'OUTCOME_UNKNOWN'
        this.finishDeliveryVerificationRows(
          attempt,
          nextBatchState === 'REJECTED' ? 'FAILED' : 'OUTCOME_UNKNOWN',
          nextOutboxState,
          nextBatchState,
          record.receipt.receiptDigest,
          record.now,
        )
        if (nextBatchState === 'REJECTED') this.restoreDeliveryTasks(batch.batch_id, 'VERIFIED')
      }
      const version = this.currentVersion(address) + 1
      this.writeEvent(address, version, 'system.delivery.verification.complete', {
        phase: 'delivery_verification.completed',
        batchId: batch.batch_id,
        verificationAttemptId: attempt.delivery_verification_attempt_id,
        verdict: record.receipt.verdict,
      }, record.now)
      this.bumpProjectionVersion(address, version)
      return {
        verificationAttemptId: attempt.delivery_verification_attempt_id,
        verdict: record.receipt.verdict,
        replayed: false,
      }
    })
  }

  decideDeliveryGate(address: HubAddressV1, record: DecideDeliveryGateRecordV1): DeliveryGateDecisionResultV1 {
    return this.transaction(() => {
      const expectedDigest = deliveryGateDecisionDigestV1(record)
      if (expectedDigest !== record.decisionDigest) throw deliveryStoreError('DELIVERY_GATE_DECISION_DIGEST_MISMATCH')
      const gateRow = this.deliveryGate(record.gateId)
      if (!gateRow || gateRow.batch_id !== record.batchId) throw deliveryStoreError('DELIVERY_GATE_NOT_FOUND')
      const batch = this.deliveryBatch(gateRow.batch_id)
      if (!batch || batch.project_id !== address.projectId || batch.session_key !== address.sessionKey) {
        throw deliveryStoreError('DELIVERY_SCOPE_MISMATCH')
      }
      if (
        gateRow.delivery_change_set_id !== record.deliveryChangeSetId ||
        gateRow.subject_version !== record.version ||
        gateRow.subject_digest !== record.digest
      ) {
        throw deliveryStoreError('DELIVERY_GATE_SUBJECT_STALE')
      }
      const nextState = record.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'
      if (gateRow.state !== 'OPEN') {
        if (gateRow.state === nextState && gateRow.decision_digest === record.decisionDigest) {
          return { gateId: record.gateId, state: nextState, replayed: true }
        }
        throw deliveryStoreError('DELIVERY_GATE_ALREADY_DECIDED')
      }
      this.db
        .prepare(
          'update delivery_human_gates set state = ?, decision_digest = ?, decided_at = ?, gate_json = ? where gate_id = ? and state = ?',
        )
        .run(
          nextState,
          record.decisionDigest,
          record.now,
          JSON.stringify(toDeliveryHumanGate({ ...gateRow, state: nextState, decision_digest: record.decisionDigest, decided_at: record.now })),
          record.gateId,
          'OPEN',
        )
      this.db
        .prepare('update delivery_batches set state = ?, updated_at = ? where batch_id = ? and state = ?')
        .run(nextState, record.now, record.batchId, 'READY_FOR_REVIEW')
      if (record.decision === 'REJECT') this.restoreDeliveryTasks(record.batchId, 'VERIFIED')
      const version = this.currentVersion(address) + 1
      this.writeEvent(address, version, 'gate.decide', {
        phase: 'delivery_gate.decided',
        batchId: record.batchId,
        gateId: record.gateId,
        decision: record.decision,
      }, record.now)
      this.bumpProjectionVersion(address, version)
      return { gateId: record.gateId, state: nextState, replayed: false }
    })
  }

  beginDeliveryApply(address: HubAddressV1, record: BeginDeliveryApplyRecordV1): DeliveryApplyBeginResultV1 {
    return this.transaction(() => {
      const batch = this.deliveryBatch(record.batchId)
      if (!batch || batch.project_id !== address.projectId || batch.session_key !== address.sessionKey) {
        throw deliveryStoreError('DELIVERY_SCOPE_MISMATCH')
      }
      const changeSet = this.deliveryChangeSet(record.deliveryChangeSetId)
      if (!changeSet || changeSet.batch_id !== record.batchId) throw deliveryStoreError('DELIVERY_CHANGESET_NOT_FOUND')
      const existing = this.deliveryApplyAttempt(record.applyAttemptId)
      if (existing) {
        if (
          existing.batch_id === record.batchId &&
          existing.delivery_change_set_id === record.deliveryChangeSetId &&
          existing.request_digest === record.requestDigest &&
          existing.state === 'STARTED'
        ) {
          return { applyAttemptId: existing.apply_attempt_id, outboxId: `xhbdapo_${existing.apply_attempt_id}`, replayed: true }
        }
        throw deliveryStoreError('DELIVERY_APPLY_IDEMPOTENCY_CONFLICT')
      }
      if (batch.state !== 'APPROVED') throw deliveryStoreError('DELIVERY_ILLEGAL_TRANSITION')
      this.db
        .prepare(
          'insert into delivery_apply_attempts (apply_attempt_id, batch_id, delivery_change_set_id, request_digest, target_fingerprint_before, state, receipt_digest, target_fingerprint_after, started_at, finished_at) values (?, ?, ?, ?, ?, ?, null, null, ?, null)',
        )
        .run(
          record.applyAttemptId,
          record.batchId,
          record.deliveryChangeSetId,
          record.requestDigest,
          record.targetFingerprintBefore,
          'STARTED',
          record.now,
        )
      this.db
        .prepare(
          'insert into delivery_apply_outbox (outbox_id, apply_attempt_id, request_digest, request_json, status, created_at) values (?, ?, ?, ?, ?, ?)',
        )
        .run(`xhbdapo_${record.applyAttemptId}`, record.applyAttemptId, record.requestDigest, record.requestJson, 'READY', record.now)
      this.db.prepare("update delivery_batches set state = 'APPLYING', updated_at = ? where batch_id = ?").run(record.now, record.batchId)
      this.restoreDeliveryTasks(record.batchId, 'APPLYING')
      const version = this.currentVersion(address) + 1
      this.writeEvent(address, version, 'delivery.apply.begin', {
        phase: 'delivery_apply.started',
        batchId: record.batchId,
        applyAttemptId: record.applyAttemptId,
      }, record.now)
      this.bumpProjectionVersion(address, version)
      return { applyAttemptId: record.applyAttemptId, outboxId: `xhbdapo_${record.applyAttemptId}`, replayed: false }
    })
  }

  readDeliveryApplyOutbox(applyAttemptId: DeliveryApplyAttemptId): DeliveryApplyOutboxRecordV1 | null {
    const row = this.db
      .prepare(
        'select outbox_id, apply_attempt_id, request_digest, request_json, status, claim_owner_id, claim_digest, claimed_at, completed_at, created_at from delivery_apply_outbox where apply_attempt_id = ?',
      )
      .get(applyAttemptId) as DeliveryApplyOutboxRow | undefined
    return row ? toDeliveryApplyOutboxRecord(row) : null
  }

  claimDeliveryApplyOutbox(input: {
    applyAttemptId: DeliveryApplyAttemptId
    ownerId: string
    claimDigest: string
    now: string
  }): DeliveryApplyOutboxRecordV1 | null {
    return this.transaction(() => {
      this.db
        .prepare(
          "update delivery_apply_outbox set status = 'CLAIMED', claim_owner_id = ?, claim_digest = ?, claimed_at = ? where apply_attempt_id = ? and status = 'READY'",
        )
        .run(input.ownerId, input.claimDigest, input.now, input.applyAttemptId)
      const row = this.db
        .prepare(
          'select outbox_id, apply_attempt_id, request_digest, request_json, status, claim_owner_id, claim_digest, claimed_at, completed_at, created_at from delivery_apply_outbox where apply_attempt_id = ?',
        )
        .get(input.applyAttemptId) as DeliveryApplyOutboxRow | undefined
      if (
        !row ||
        row.status !== 'CLAIMED' ||
        row.claim_owner_id !== input.ownerId ||
        row.claim_digest !== input.claimDigest
      ) {
        return null
      }
      return toDeliveryApplyOutboxRecord(row)
    })
  }

  readDeliveryApplyAttempt(applyAttemptId: DeliveryApplyAttemptId): DeliveryApplyAttemptV1 | null {
    const row = this.deliveryApplyAttempt(applyAttemptId)
    return row ? toDeliveryApplyAttempt(row) : null
  }

  readDeliveryApplyPackage(applyAttemptId: DeliveryApplyAttemptId): DeliveryApplyPackageRecordV1 | null {
    const attempt = this.deliveryApplyAttempt(applyAttemptId)
    if (!attempt) return null
    const changeSet = this.readDeliveryChangeSet(attempt.delivery_change_set_id)
    if (!changeSet) throw deliveryStoreError('DELIVERY_CHANGESET_NOT_FOUND')
    const fileArtifacts = changeSet.fileChanges.map((file) => {
      const artifact = this.readArtifact(file.contentArtifactId)
      if (!artifact || artifact.kind !== 'DELIVERY_FILE_CONTENT' || artifact.contentDigest !== file.contentDigest) {
        throw deliveryStoreError('DELIVERY_ARTIFACT_NOT_FOUND')
      }
      return artifact
    })
    return { applyAttempt: toDeliveryApplyAttempt(attempt), changeSet, fileArtifacts }
  }

  pendingDeliveryApplyOutboxes(): readonly PendingDeliveryApplyOutboxRecordV1[] {
    return this.db
      .prepare(
        "select db.project_id, db.session_key, dao.outbox_id, dao.apply_attempt_id, dao.request_digest, dao.request_json, dao.status, dao.claim_owner_id, dao.claim_digest, dao.claimed_at, dao.completed_at, dao.created_at from delivery_apply_outbox dao join delivery_apply_attempts daa on daa.apply_attempt_id = dao.apply_attempt_id join delivery_batches db on db.batch_id = daa.batch_id where dao.status in ('READY', 'CLAIMED') order by dao.rowid asc",
      )
      .all()
      .map((row) => {
        const typed = row as unknown as DeliveryApplyOutboxRow & { project_id: string; session_key: string }
        return {
          address: { projectId: typed.project_id, sessionKey: typed.session_key } as HubAddressV1,
          outbox: toDeliveryApplyOutboxRecord(typed),
        }
      })
  }

  completeDeliveryApply(address: HubAddressV1, record: CompleteDeliveryApplyRecordV1): DeliveryApplyCompletionResultV1 {
    return this.transaction(() => {
      const attempt = this.deliveryApplyAttempt(record.applyAttemptId)
      if (!attempt) throw deliveryStoreError('DELIVERY_APPLY_NOT_FOUND')
      validateDeliveryApplyReceipt(record.receipt, attempt, record.outcome)
      const batch = this.deliveryBatch(attempt.batch_id)
      if (!batch || batch.project_id !== address.projectId || batch.session_key !== address.sessionKey) {
        throw deliveryStoreError('DELIVERY_SCOPE_MISMATCH')
      }
      const reconcilesUnknown =
        attempt.state === 'OUTCOME_UNKNOWN' && (record.outcome === 'SUCCEEDED' || record.outcome === 'FAILED')
      if (attempt.state !== 'STARTED' && !reconcilesUnknown) {
        if (attempt.state === record.outcome && attempt.receipt_digest === record.receipt.receiptDigest) {
          return { applyAttemptId: record.applyAttemptId, outcome: record.outcome, replayed: true }
        }
        throw deliveryStoreError('DELIVERY_APPLY_IDEMPOTENCY_CONFLICT')
      }
      const previousAttemptState = attempt.state
      const previousBatchState = previousAttemptState === 'STARTED' ? 'APPLYING' : 'OUTCOME_UNKNOWN'
      const previousOutboxState = previousAttemptState === 'STARTED' ? 'CLAIMED' : 'OUTCOME_UNKNOWN'
      const nextBatchState =
        record.outcome === 'SUCCEEDED' ? 'APPLIED' : record.outcome === 'FAILED' ? 'APPROVED' : 'OUTCOME_UNKNOWN'
      const nextTaskState =
        record.outcome === 'SUCCEEDED' ? 'DONE' : record.outcome === 'FAILED' ? 'DELIVERY_PENDING' : 'APPLYING'
      const outboxState = record.outcome === 'SUCCEEDED' ? 'DONE' : record.outcome === 'FAILED' ? 'FAILED' : 'OUTCOME_UNKNOWN'
      const safeCode = record.receipt.verdict === 'SUCCEEDED' ? null : record.receipt.safeCode
      const targetFingerprintAfter = record.receipt.verdict === 'SUCCEEDED' ? record.receipt.targetFingerprint : null
      const attemptUpdated = this.db
        .prepare(
          'update delivery_apply_attempts set state = ?, receipt_digest = ?, safe_code = ?, changed_relative_paths_json = ?, receipt_json = ?, target_fingerprint_after = ?, finished_at = ? where apply_attempt_id = ? and state = ?',
        )
        .run(
          record.outcome,
          record.receipt.receiptDigest,
          safeCode,
          JSON.stringify(record.receipt.changedRelativePaths),
          JSON.stringify(record.receipt),
          targetFingerprintAfter,
          record.now,
          record.applyAttemptId,
          previousAttemptState,
        )
      const outboxUpdated = this.db
        .prepare('update delivery_apply_outbox set status = ?, completed_at = ? where apply_attempt_id = ? and status = ?')
        .run(outboxState, record.now, record.applyAttemptId, previousOutboxState)
      const batchUpdated = this.db.prepare('update delivery_batches set state = ?, updated_at = ? where batch_id = ? and state = ?').run(
        nextBatchState,
        record.now,
        attempt.batch_id,
        previousBatchState,
      )
      if (attemptUpdated.changes !== 1 || outboxUpdated.changes !== 1 || batchUpdated.changes !== 1) {
        throw deliveryStoreError('DELIVERY_ILLEGAL_TRANSITION')
      }
      this.restoreDeliveryTasks(attempt.batch_id, nextTaskState)
      const version = this.currentVersion(address) + 1
      this.writeEvent(address, version, 'delivery.apply.complete', {
        phase: 'delivery_apply.completed',
        batchId: attempt.batch_id,
        applyAttemptId: record.applyAttemptId,
        outcome: record.outcome,
        receiptDigest: record.receipt.receiptDigest,
        ...(safeCode ? { safeCode } : {}),
      }, record.now)
      this.bumpProjectionVersion(address, version)
      return { applyAttemptId: record.applyAttemptId, outcome: record.outcome, replayed: false }
    })
  }

  sealRecoveredDeliveryCandidate(
    address: HubAddressV1,
    record: SealRecoveredDeliveryCandidateRecordV1,
  ): SealRecoveredDeliveryCandidateResultV1 {
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          'select batch_id, project_id, session_key, flow_id, selection_draft_id, state, selection_digest, target_fingerprint, recovery_source_batch_id, recovery_source_apply_attempt_id, created_at, updated_at from delivery_batches where project_id = ? and session_key = ? and recovery_source_batch_id = ?',
        )
        .get(address.projectId, address.sessionKey, record.sourceBatchId) as DeliveryBatchRow | undefined
      if (existing) {
        assertRecoveredDeliveryCandidateReplay(this.db, address, existing, record)
        return { batchId: existing.batch_id, replayed: true }
      }

      const sourceBatch = this.deliveryBatch(record.sourceBatchId)
      if (!sourceBatch || sourceBatch.project_id !== address.projectId || sourceBatch.session_key !== address.sessionKey) {
        throw deliveryStoreError('DELIVERY_SCOPE_MISMATCH')
      }
      if (sourceBatch.state !== 'APPROVED') throw deliveryStoreError('DELIVERY_ILLEGAL_TRANSITION')

      const sourceAttempt = this.deliveryApplyAttempt(record.sourceFailedApplyAttemptId)
      if (!sourceAttempt || sourceAttempt.batch_id !== record.sourceBatchId) {
        throw deliveryStoreError('DELIVERY_APPLY_NOT_FOUND')
      }
      const failedReceipt = persistedDeliveryApplyReceipt(sourceAttempt)
      if (
        (sourceAttempt.state !== 'FAILED' && sourceAttempt.state !== 'FAILED_ROLLED_BACK') ||
        failedReceipt?.verdict !== 'FAILED_ROLLED_BACK' ||
        failedReceipt.safeCode !== 'TARGET_BASELINE_DRIFT' ||
        failedReceipt.changedRelativePaths.length !== 0
      ) {
        throw deliveryStoreError('DELIVERY_ILLEGAL_TRANSITION')
      }
      const sourceChangeSetRow = this.deliveryChangeSet(sourceAttempt.delivery_change_set_id)
      const sourceChangeSet = sourceChangeSetRow
        ? JSON.parse(sourceChangeSetRow.change_set_json) as DeliveryChangeSetV1
        : null
      const sourceTargetFingerprint = sourceChangeSet ? deliveryTargetFingerprintV1(sourceChangeSet.target) : null
      if (
        !sourceChangeSetRow ||
        !sourceChangeSet ||
        sourceChangeSetRow.delivery_change_set_id !== sourceChangeSet.deliveryChangeSetId ||
        sourceChangeSetRow.batch_id !== sourceBatch.batch_id ||
        sourceChangeSetRow.flow_id !== sourceBatch.flow_id ||
        sourceChangeSetRow.version !== 1 ||
        sourceChangeSet.batchId !== sourceBatch.batch_id ||
        sourceChangeSet.flowId !== sourceBatch.flow_id ||
        sourceChangeSet.selectionDraftId !== sourceBatch.selection_draft_id ||
        sourceChangeSet.selectionDigest !== sourceBatch.selection_digest ||
        sourceChangeSetRow.digest !== sourceChangeSet.digest ||
        deliveryChangeSetDigestWithEvidence(sourceChangeSet, sourceChangeSet.evidenceArtifactIds) !== sourceChangeSet.digest ||
        record.recoveryLineage.sourceDeliveryChangeSetId !== sourceChangeSet.deliveryChangeSetId ||
        record.recoveryLineage.sourceDeliveryChangeSetDigest !== sourceChangeSet.digest ||
        sourceChangeSet.target.projectId !== address.projectId ||
        sourceChangeSet.target.initialTargetFingerprint !== sourceTargetFingerprint ||
        record.recoveryLineage.sourceTargetFingerprint !== sourceTargetFingerprint ||
        sourceBatch.target_fingerprint !== sourceTargetFingerprint ||
        sourceAttempt.target_fingerprint_before !== sourceTargetFingerprint
      ) {
        throw deliveryStoreError('DELIVERY_CHANGESET_BINDING_MISMATCH')
      }

      const request = parseDeliveryVerificationRequest(record.verificationRequestJson)
      validateDeliveryVerificationReceipt(record.receipt)
      const requestChangeSetDigest = deliveryChangeSetDigestWithEvidence(record.deliveryChangeSet, [])
      const finalTargetFingerprint = deliveryTargetFingerprintV1(record.deliveryChangeSet.target)
      if (
        request.verificationAttemptId !== record.verificationAttemptId ||
        request.batchId !== record.batchId ||
        request.flowId !== sourceBatch.flow_id ||
        request.requestDigest !== record.receipt.requestDigest ||
        request.deliveryChangeSetDigest !== requestChangeSetDigest ||
        request.selectionDigest !== record.receipt.selectionDigest ||
        request.selectionDigest !== record.deliveryChangeSet.selectionDigest ||
        request.targetFingerprint !== record.recoveryLineage.currentTargetFingerprint ||
        request.qaConfigVersion !== record.receipt.qaConfigVersion ||
        request.qaConfigVersion !== record.deliveryChangeSet.qaConfigVersion ||
        record.receipt.batchId !== record.batchId ||
        record.receipt.flowId !== sourceBatch.flow_id ||
        record.receipt.verificationAttemptId !== record.verificationAttemptId ||
        record.receipt.deliveryChangeSetId !== record.deliveryChangeSet.deliveryChangeSetId ||
        record.receipt.deliveryChangeSetDigest !== record.deliveryChangeSet.digest ||
        record.receipt.selectionDigest !== record.deliveryChangeSet.selectionDigest ||
        record.receipt.qaConfigVersion !== record.deliveryChangeSet.qaConfigVersion
      ) {
        throw deliveryStoreError('DELIVERY_VERIFICATION_BINDING_MISMATCH')
      }
      if (record.receipt.verdict !== 'PASS') throw deliveryStoreError('DELIVERY_VERIFICATION_BINDING_MISMATCH')
      if (
        !record.deliveryChangeSet.recoveryLineage ||
        !sameRecoveryLineage(record.deliveryChangeSet.recoveryLineage, record.recoveryLineage) ||
        record.deliveryChangeSet.target.projectId !== address.projectId ||
        record.deliveryChangeSet.target.initialTargetFingerprint !== finalTargetFingerprint ||
        record.deliveryChangeSet.target.initialTargetFingerprint !== record.recoveryLineage.currentTargetFingerprint
      ) {
        throw deliveryStoreError('DELIVERY_CHANGESET_BINDING_MISMATCH')
      }
      if (record.recoveryLineage.sourceBatchId !== record.sourceBatchId) {
        throw deliveryStoreError('DELIVERY_CHANGESET_BINDING_MISMATCH')
      }

      const sourceDraftRow = this.db
        .prepare(
          'select draft_id, batch_id, flow_id, selected_task_run_ids_json, resolved_task_change_set_ids_json, dependency_task_run_ids_json, selection_digest, draft_json, created_at from delivery_selection_drafts where batch_id = ?',
        )
        .get(record.sourceBatchId) as DeliverySelectionDraftRow | undefined
      if (!sourceDraftRow) throw deliveryStoreError('DELIVERY_SELECTION_NOT_FOUND')
      const sourceDraft = JSON.parse(sourceDraftRow.draft_json) as DeliverySelectionDraftV1
      const recoveredDraftBase = {
        ...sourceDraft,
        draftId: record.draftId,
        batchId: record.batchId,
        targetFingerprint: record.recoveryLineage.currentTargetFingerprint,
        createdAt: record.now as never,
      }
      const recoveredDraft = {
        ...recoveredDraftBase,
        digest: deliverySelectionDigestV1(recoveredDraftBase),
      }
      if (
        record.deliveryChangeSet.batchId !== record.batchId ||
        record.deliveryChangeSet.flowId !== sourceBatch.flow_id ||
        record.deliveryChangeSet.selectionDraftId !== record.draftId ||
        record.deliveryChangeSet.selectionDigest !== recoveredDraft.digest
      ) {
        throw deliveryStoreError('DELIVERY_CHANGESET_BINDING_MISMATCH')
      }

      const recoveredBatch: DeliveryBatchRow = {
        batch_id: record.batchId,
        project_id: sourceBatch.project_id,
        session_key: sourceBatch.session_key,
        flow_id: sourceBatch.flow_id,
        selection_draft_id: record.draftId,
        state: 'READY_FOR_REVIEW',
        selection_digest: recoveredDraft.digest,
        target_fingerprint: record.recoveryLineage.currentTargetFingerprint,
        recovery_source_batch_id: record.sourceBatchId,
        recovery_source_apply_attempt_id: record.sourceFailedApplyAttemptId,
        created_at: record.now,
        updated_at: record.now,
      }
      validateDeliveryChangeSet(recoveredBatch, record.receipt, record.deliveryChangeSet)
      assertDeliveryFileArtifactsMatch(record.deliveryChangeSet, record.deliveryFileArtifacts)
      assertDeliveryRecoveryArtifactsMatch(record)

      const superseded = this.db
        .prepare("update delivery_batches set state = 'SUPERSEDED', updated_at = ? where batch_id = ? and state = 'APPROVED'")
        .run(record.now, record.sourceBatchId)
      if (superseded.changes !== 1) throw deliveryStoreError('DELIVERY_ILLEGAL_TRANSITION')
      this.db
        .prepare(
          'insert into delivery_batches (batch_id, project_id, session_key, flow_id, selection_draft_id, state, selection_digest, target_fingerprint, recovery_source_batch_id, recovery_source_apply_attempt_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.batchId,
          sourceBatch.project_id,
          sourceBatch.session_key,
          sourceBatch.flow_id,
          record.draftId,
          'READY_FOR_REVIEW',
          recoveredDraft.digest,
          record.recoveryLineage.currentTargetFingerprint,
          record.sourceBatchId,
          record.sourceFailedApplyAttemptId,
          record.now,
          record.now,
        )
      this.db
        .prepare(
          'insert into delivery_selection_drafts (draft_id, batch_id, flow_id, selected_task_run_ids_json, resolved_task_change_set_ids_json, dependency_task_run_ids_json, selection_digest, draft_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.draftId,
          record.batchId,
          sourceDraft.flowId,
          JSON.stringify(recoveredDraft.selectedTaskRunIds ?? []),
          JSON.stringify((recoveredDraft.resolvedTaskChangeSets ?? []).map((item) => item.taskChangeSetId)),
          JSON.stringify(recoveredDraft.dependencyTaskRunIds ?? []),
          recoveredDraft.digest,
          JSON.stringify(recoveredDraft),
          record.now,
        )
      this.db
        .prepare(
          'insert into delivery_verification_attempts (delivery_verification_attempt_id, verification_request_id, batch_id, flow_id, request_digest, selection_digest, qa_config_version, state, started_at, finished_at, outcome_receipt_digest) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.verificationAttemptId,
          request.verificationRequestId,
          record.batchId,
          sourceBatch.flow_id,
          request.requestDigest,
          recoveredDraft.digest,
          request.qaConfigVersion,
          'SUCCEEDED',
          record.now,
          record.now,
          record.receipt.receiptDigest,
        )
      this.db
        .prepare(
          'insert into delivery_verification_outbox (outbox_id, delivery_verification_attempt_id, request_digest, request_json, status, claim_owner_id, claim_digest, claimed_at, completed_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          `xhbdvo_${record.verificationAttemptId}`,
          record.verificationAttemptId,
          request.requestDigest,
          record.verificationRequestJson,
          'DONE',
          'xiaogui-main-process-delivery',
          `delivery.recovery.prepare:${record.verificationAttemptId}:${request.requestDigest}`,
          record.now,
          record.now,
          record.now,
        )
      for (const artifact of [...record.deliveryFileArtifacts, ...(record.evidenceArtifacts ?? []), ...(record.diagnosticArtifacts ?? [])]) {
        assertArtifactIdAvailable(this.db, artifact)
        insertArtifact(this.db, artifact, record.now)
      }
      this.db
        .prepare(
          'insert into delivery_verification_receipts (receipt_digest, delivery_verification_attempt_id, request_digest, verdict, receipt_json, diagnostic_artifact_ids_json, created_at) values (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.receipt.receiptDigest,
          record.verificationAttemptId,
          request.requestDigest,
          record.receipt.verdict,
          JSON.stringify(record.receipt),
          JSON.stringify(record.receipt.diagnosticArtifactIds),
          record.now,
        )
      this.insertDeliveryChangeSet(record.deliveryChangeSet)
      const gate: DeliveryHumanGateV1 = {
        gateId: record.gateId,
        batchId: record.batchId,
        subject: {
          deliveryChangeSetId: record.deliveryChangeSet.deliveryChangeSetId,
          version: 1,
          digest: record.deliveryChangeSet.digest,
        },
        state: 'OPEN',
        createdAt: record.now as never,
      }
      this.db
        .prepare(
          'insert into delivery_human_gates (gate_id, batch_id, delivery_change_set_id, subject_version, subject_digest, state, decision_digest, decided_at, gate_json, created_at) values (?, ?, ?, ?, ?, ?, null, null, ?, ?)',
        )
        .run(
          gate.gateId,
          gate.batchId,
          gate.subject.deliveryChangeSetId,
          gate.subject.version,
          gate.subject.digest,
          gate.state,
          JSON.stringify(gate),
          record.now,
        )
      const version = this.currentVersion(address) + 1
      this.writeEvent(address, version, 'apply.recovery.prepare', {
        phase: 'delivery_recovery.prepared',
        sourceBatchId: record.sourceBatchId,
        batchId: record.batchId,
        failedApplyAttemptId: record.sourceFailedApplyAttemptId,
        deliveryChangeSetId: record.deliveryChangeSet.deliveryChangeSetId,
      }, record.now)
      this.bumpProjectionVersion(address, version)
      return { batchId: record.batchId, replayed: false }
    })
  }

  attempt(attemptId: AttemptId): AttemptRecord | null {
    const row = this.db
      .prepare('select attempt_id, task_run_id, flow_id, status, attempt_digest, workspace_receipt_id, runtime_session_id, outcome_receipt_digest from attempts where attempt_id = ?')
      .get(attemptId) as AttemptRecord | undefined
    return row ?? null
  }

  compositionAttempt(attemptId: AttemptId): CompositionAttemptRecord | null {
    const row = this.db
      .prepare(
        'select composition_attempt_id as compositionAttemptId, attempt_id as attemptId, request_digest as requestDigest, baseline_binding_digest as baselineBindingDigest, composition_digest as compositionDigest from composition_attempts where attempt_id = ? and attempt_kind = ?',
      )
      .get(attemptId, 'INITIAL') as CompositionAttemptRecord | undefined
    return row ?? null
  }

  agentDispatchOutbox(attemptId: AttemptId): AgentDispatchOutboxRecord | null {
    const row = this.db
      .prepare('select outbox_id, attempt_id, request_id, status, payload_digest, runtime_request_digest, runtime_request_json, selection_digest from agent_dispatch_outbox where attempt_id = ? order by rowid desc limit 1')
      .get(attemptId) as AgentDispatchOutboxRecord | undefined
    return row ?? null
  }

  flowExecutionBaseline(flowId: FlowId): FlowExecutionBaselineRecord | null {
    const row = this.db
      .prepare('select flow_id, baseline_id, base_revision, baseline_tree_hash, initial_target_fingerprint, baseline_digest, baseline_binding_digest from flow_execution_baselines where flow_id = ?')
      .get(flowId) as FlowExecutionBaselineRecord | undefined
    return row ?? null
  }

  taskExecutionBaseline(attemptId: AttemptId): TaskExecutionBaselineRecordV1 | null {
    const row = this.db
      .prepare(`
        select attempt_id, task_run_id, flow_id, baseline_id, base_revision,
               baseline_tree_hash, initial_target_fingerprint, baseline_digest,
               baseline_binding_digest, ancestor_task_change_set_ids_json,
               derivation_digest
          from task_execution_baselines
         where attempt_id = ?
      `)
      .get(attemptId) as TaskExecutionBaselineRecordV1 | undefined
    return row ?? null
  }

  derivedExecutionBaseline(derivationInputDigest: string): DerivedExecutionBaselineCacheRecordV1 | null {
    const row = this.db
      .prepare(`
        select derivation_input_digest, project_id, flow_id, task_run_id,
               baseline_json, created_at
          from derived_execution_baselines
         where derivation_input_digest = ?
      `)
      .get(derivationInputDigest) as DerivedExecutionBaselineCacheRecordV1 | undefined
    return row ?? null
  }

  reserveDerivedExecutionBaseline(
    record: DerivedExecutionBaselineReservationRecordV1,
  ): DerivedExecutionBaselineReservationResultV1 {
    return this.transaction(() => {
      const cached = this.derivedExecutionBaseline(record.derivation_input_digest)
      if (cached) {
        assertDerivedBaselineScope(cached, record)
        return { kind: 'CACHED', cache: cached }
      }
      this.db.prepare(`
        insert or ignore into derived_execution_baseline_reservations (
          derivation_input_digest, project_id, flow_id, task_run_id,
          owner_token, lease_expires_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.derivation_input_digest,
        record.project_id,
        record.flow_id,
        record.task_run_id,
        record.owner_token,
        record.lease_expires_at,
        record.now,
        record.now,
      )
      const existing = this.db.prepare(`
        select derivation_input_digest, project_id, flow_id, task_run_id,
               owner_token, lease_expires_at
          from derived_execution_baseline_reservations
         where derivation_input_digest = ?
      `).get(record.derivation_input_digest) as {
        derivation_input_digest: string
        project_id: string
        flow_id: string
        task_run_id: string
        owner_token: string
        lease_expires_at: string
      } | undefined
      if (!existing) throw derivedBaselineConflict()
      assertDerivedBaselineScope(existing, record)
      if (existing.owner_token === record.owner_token) return { kind: 'ACQUIRED' }
      if (existing.lease_expires_at <= record.now) {
        const taken = this.db.prepare(`
          update derived_execution_baseline_reservations
             set owner_token = ?, lease_expires_at = ?, updated_at = ?
           where derivation_input_digest = ? and owner_token = ? and lease_expires_at = ?
        `).run(
          record.owner_token,
          record.lease_expires_at,
          record.now,
          record.derivation_input_digest,
          existing.owner_token,
          existing.lease_expires_at,
        )
        if (taken.changes === 1) return { kind: 'ACQUIRED' }
      }
      return { kind: 'WAITING' }
    })
  }

  releaseDerivedExecutionBaselineReservation(derivationInputDigest: string, ownerToken: string): void {
    this.transaction(() => {
      this.db.prepare(
        'delete from derived_execution_baseline_reservations where derivation_input_digest = ? and owner_token = ?',
      ).run(derivationInputDigest, ownerToken)
    })
  }

  writeDerivedExecutionBaseline(record: DerivedExecutionBaselineCacheRecordV1, ownerToken?: string): void {
    this.transaction(() => {
      if (ownerToken) {
        const reservation = this.db.prepare(`
          select derivation_input_digest, project_id, flow_id, task_run_id, owner_token
            from derived_execution_baseline_reservations
           where derivation_input_digest = ?
        `).get(record.derivation_input_digest) as {
          derivation_input_digest: string
          project_id: string
          flow_id: string
          task_run_id: string
          owner_token: string
        } | undefined
        if (!reservation || reservation.owner_token !== ownerToken) throw derivedBaselineConflict()
        assertDerivedBaselineScope(reservation, record)
      }
      this.db.prepare(`
        insert or ignore into derived_execution_baselines (
          derivation_input_digest, project_id, flow_id, task_run_id,
          baseline_json, created_at
        ) values (?, ?, ?, ?, ?, ?)
      `).run(
        record.derivation_input_digest,
        record.project_id,
        record.flow_id,
        record.task_run_id,
        record.baseline_json,
        record.created_at,
      )
      const persisted = this.derivedExecutionBaseline(record.derivation_input_digest)
      if (
        !persisted ||
        persisted.project_id !== record.project_id ||
        persisted.flow_id !== record.flow_id ||
        persisted.task_run_id !== record.task_run_id ||
        persisted.baseline_json !== record.baseline_json
      ) {
        throw derivedBaselineConflict()
      }
      if (ownerToken) {
        const released = this.db.prepare(
          'delete from derived_execution_baseline_reservations where derivation_input_digest = ? and owner_token = ?',
        ).run(record.derivation_input_digest, ownerToken)
        if (released.changes !== 1) throw derivedBaselineConflict()
      }
    })
  }

  attemptRuntimeBinding(attemptId: AttemptId): AttemptRuntimeBindingV1 | null {
    const row = this.db
      .prepare('select binding_json from attempt_runtime_bindings where attempt_id = ?')
      .get(attemptId) as { binding_json: string } | undefined
    return row ? JSON.parse(row.binding_json) as AttemptRuntimeBindingV1 : null
  }

  lastExecutionWave(flowId: FlowId): ExecutionWaveV1 | null {
    const row = this.db
      .prepare('select wave_json from execution_waves where flow_id = ? order by rowid desc limit 1')
      .get(flowId) as { wave_json: string } | undefined
    return row ? JSON.parse(row.wave_json) as ExecutionWaveV1 : null
  }

  workspaceReceiptForAttempt(attemptId: AttemptId): WorkspaceReceiptRecord | null {
    const row = this.db
      .prepare('select workspace_receipt_id, attempt_id, status, receipt_digest from workspace_receipts where attempt_id = ? order by rowid desc limit 1')
      .get(attemptId) as WorkspaceReceiptRecord | undefined
    return row ?? null
  }

  workspacePrepareOutboxStatus(attemptId: AttemptId): string | null {
    const row = this.db
      .prepare('select status from workspace_prepare_outbox where attempt_id = ?')
      .get(attemptId) as { status: string } | undefined
    return row?.status ?? null
  }

  claimWorkspacePrepareOutbox(input: {
    attemptId: AttemptId
    ownerId: string
    claimDigest: string
    now: string
  }): WorkspacePrepareOutboxClaimRecordM2B2V1 | null {
    return this.transaction(() => {
      this.db
        .prepare(
          "update workspace_prepare_outbox set status = 'CLAIMED', claim_owner_id = ?, claim_digest = ?, claimed_at = ? where attempt_id = ? and status = 'READY'",
        )
        .run(input.ownerId, input.claimDigest, input.now, input.attemptId)
      const row = this.db
        .prepare(
          'select outbox_id, attempt_id, request_digest, status, claim_owner_id, claim_digest, claimed_at from workspace_prepare_outbox where attempt_id = ?',
        )
        .get(input.attemptId) as
        | {
            outbox_id: string
            attempt_id: AttemptId
            request_digest: string
            status: string
            claim_owner_id: string | null
            claim_digest: string | null
            claimed_at: string | null
          }
        | undefined
      if (
        !row ||
        row.status !== 'CLAIMED' ||
        row.claim_owner_id !== input.ownerId ||
        row.claim_digest !== input.claimDigest ||
        !row.claimed_at
      ) {
        return null
      }
      return {
        outboxId: row.outbox_id,
        attemptId: row.attempt_id,
        requestDigest: row.request_digest,
        status: 'CLAIMED',
        claimOwnerId: row.claim_owner_id,
        claimDigest: row.claim_digest,
        claimedAt: row.claimed_at,
      }
    })
  }

  readVerificationOutbox(verificationAttemptId: string): VerificationOutboxRecordV1 | null {
    const row = this.db
      .prepare(
        'select outbox_id, verification_attempt_id, request_digest, request_json, status, claim_owner_id, claim_digest, claimed_at, completed_at, created_at from verification_outbox where verification_attempt_id = ?',
      )
      .get(verificationAttemptId) as VerificationOutboxRow | undefined
    return row ? toVerificationOutboxRecord(row) : null
  }

  pendingTaskVerifications(): readonly PendingTaskVerificationRecordV1[] {
    const rows = this.db
      .prepare(
        `select a.project_id, a.session_key,
                vo.outbox_id, vo.verification_attempt_id, vo.request_digest, vo.request_json,
                vo.status, vo.claim_owner_id, vo.claim_digest, vo.claimed_at, vo.completed_at, vo.created_at
           from verification_attempts va
           join verification_outbox vo on vo.verification_attempt_id = va.verification_attempt_id
           join attempts a on a.attempt_id = va.attempt_id
          where va.state = 'STARTED' and vo.status in ('READY', 'CLAIMED')
          order by va.started_at asc, va.verification_attempt_id asc`,
      )
      .all() as unknown as Array<VerificationOutboxRow & { project_id: string; session_key: string }>
    return rows.map((row) => ({
      address: { projectId: row.project_id, sessionKey: row.session_key } as HubAddressV1,
      outbox: toVerificationOutboxRecord(row),
    }))
  }

  claimVerificationOutbox(input: {
    verificationAttemptId: string
    ownerId: string
    claimDigest: string
    now: string
  }): VerificationOutboxRecordV1 | null {
    return this.transaction(() => {
      this.db
        .prepare(
          "update verification_outbox set status = 'CLAIMED', claim_owner_id = ?, claim_digest = ?, claimed_at = ? where verification_attempt_id = ? and status = 'READY'",
        )
        .run(input.ownerId, input.claimDigest, input.now, input.verificationAttemptId)
      const row = this.db
        .prepare(
          'select outbox_id, verification_attempt_id, request_digest, request_json, status, claim_owner_id, claim_digest, claimed_at, completed_at, created_at from verification_outbox where verification_attempt_id = ?',
        )
        .get(input.verificationAttemptId) as VerificationOutboxRow | undefined
      if (
        !row ||
        row.status !== 'CLAIMED' ||
        row.claim_owner_id !== input.ownerId ||
        row.claim_digest !== input.claimDigest ||
        !row.claimed_at
      ) {
        return null
      }
      return toVerificationOutboxRecord(row)
    })
  }

  hasActiveExternalAttempt(): boolean {
    const row = this.db
      .prepare(
        `select count(*) as count
         from attempts a
         join flows f on f.flow_id = a.flow_id
         where ${activeSchedulerAttemptSql('a', 'f.status')}`,
      )
      .get() as { count: number }
    return row.count > 0
  }

  idempotency(address: HubAddressV1, requestId: string): IdempotencyRecord | null {
    const row = this.db
      .prepare('select command_type, payload_hash, receipt_json from idempotency_keys where scope_key = ? and request_id = ?')
      .get(scopeKey(address), requestId) as IdempotencyRecord | undefined
    return row ?? null
  }

  writeStart(address: HubAddressV1, idempotency: IdempotencyInput, record: StartDraftRecordV1): void {
    this.transaction(() => {
      const version = this.currentVersion(address) + 1
      const projection = { ...record.projection, sessionVersion: version }
      const receipt = { ...record.receipt, sessionVersion: version }
      this.db
        .prepare(
          'insert into flows (flow_id, project_id, session_key, status, active_revision_id, objective, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.flowId,
          address.projectId,
          address.sessionKey,
          'AWAITING_PLAN_APPROVAL',
          record.revisionId,
          record.draft.objective,
          record.now,
          record.now,
        )
      this.db
        .prepare(
          'insert into plan_revisions (revision_id, flow_id, ordinal, status, digest, draft_json, created_at, submitted_at) values (?, ?, ?, ?, ?, ?, ?, null)',
        )
        .run(record.revisionId, record.flowId, 1, 'DRAFT', record.digest, JSON.stringify(record.draft), record.now)
      this.writeEvent(address, version, record.eventType, { flowId: record.flowId, revisionId: record.revisionId }, record.now)
      this.writeProjection(address, projection)
      this.writeIdempotency(address, idempotency, receipt)
    })
  }

  writeSubmit(address: HubAddressV1, idempotency: IdempotencyInput, record: SubmitRevisionRecordV1): void {
    this.transaction(() => {
      const version = this.currentVersion(address) + 1
      const projection = { ...record.projection, sessionVersion: version }
      const receipt = { ...record.receipt, sessionVersion: version }
      this.db.prepare("update plan_revisions set status = 'ACTIVE', submitted_at = ? where revision_id = ?").run(
        record.now,
        record.revisionId,
      )
      this.db.prepare("update flows set status = 'PLAN_ACTIVE', updated_at = ? where flow_id = ?").run(record.now, record.flowId)
      const insertSpec = this.db.prepare(
        'insert into task_specs (task_spec_id, flow_id, task_key, title, summary, depends_json, unavailable_reason) values (?, ?, ?, ?, ?, ?, ?)',
      )
      const insertRun = this.db.prepare(
        'insert into task_runs (task_run_id, task_spec_id, flow_id, task_key, status, unavailable_reason) values (?, ?, ?, ?, ?, ?)',
      )
      for (const spec of projection.taskSpecs) {
        insertSpec.run(
          spec.taskSpecId,
          record.flowId,
          spec.taskKey,
          spec.title,
          spec.summary ?? null,
          JSON.stringify(spec.dependsOn),
          spec.unavailableReason,
        )
        const run = projection.taskRuns.find((item) => item.taskSpecId === spec.taskSpecId)
        if (run) {
          insertRun.run(run.taskRunId, spec.taskSpecId, record.flowId, spec.taskKey, run.status, run.unavailableReason)
        }
      }
      this.writeEvent(address, version, 'plan.revision.activated', { flowId: record.flowId, revisionId: record.revisionId }, record.now)
      this.writeProjection(address, projection)
      this.writeIdempotency(address, idempotency, receipt)
    })
  }

  writeCancel(address: HubAddressV1, idempotency: IdempotencyInput, record: CancelFlowRecordV1): void {
    this.transaction(() => {
      const version = this.currentVersion(address) + 1
      const projection = { ...record.projection, sessionVersion: version }
      const receipt = { ...record.receipt, sessionVersion: version }
      this.db.prepare("update flows set status = 'CANCELLED', updated_at = ? where flow_id = ?").run(record.now, record.flowId)
      this.writeEvent(address, version, 'flow.cancelled', { flowId: record.flowId, reason: record.reason }, record.now)
      this.writeProjection(address, projection)
      this.writeIdempotency(address, idempotency, receipt)
    })
  }

  writeSchedule(address: HubAddressV1, idempotency: IdempotencyInput, record: ScheduleRecordM2BV1): PerformReceiptV1 {
    return this.transaction(() => {
      // Every derived-baseline owner/waiter converges here. Replay, optimistic
      // version, flow authority, capacity, and authorization scope are checked
      // under the same BEGIN IMMEDIATE lock before any execution binding write.
      const replay = this.checkIdempotencyForWrite(address, idempotency)
      if (replay) return replay
      const currentProjection = this.readProjection(address)
      const currentVersion = currentProjection?.sessionVersion ?? 0
      if (record.expectedSessionVersion !== undefined && record.expectedSessionVersion !== currentVersion) {
        throw Object.assign(new Error('STALE_SESSION_VERSION'), { code: 'STALE_SESSION_VERSION' })
      }
      if (
        !currentProjection?.activeFlow ||
        currentProjection.activeFlow.flowId !== record.flowId ||
        currentProjection.activeFlow.status !== 'PLAN_ACTIVE'
      ) {
        throw Object.assign(new Error('FLOW_SCHEDULE_CONFLICT'), { code: 'FLOW_SCHEDULE_CONFLICT' })
      }
      const currentFlow = this.db.prepare(`
        select status
          from flows
         where flow_id = ? and project_id = ? and session_key = ?
      `).get(record.flowId, address.projectId, address.sessionKey) as { status: string } | undefined
      if (currentFlow?.status !== 'PLAN_ACTIVE') {
        throw Object.assign(new Error('FLOW_SCHEDULE_CONFLICT'), { code: 'FLOW_SCHEDULE_CONFLICT' })
      }
      const activeCount = (this.db.prepare(`
        select count(*) as count
          from attempts a
          join flows f on f.flow_id = a.flow_id
         where a.project_id = ?
           and ${activeSchedulerAttemptSql('a', 'f.status')}
      `).get(address.projectId) as { count: number }).count
      if (activeCount >= record.executionWave.maxParallelism) {
        throw Object.assign(new Error('ATTEMPT_CAPACITY_CONFLICT'), { code: 'ATTEMPT_CAPACITY_CONFLICT' })
      }
      const requestedTokens = new Set<string>(record.authorizationScope.pathTokens)
      const activeScopes = this.db.prepare(`
        select s.path_tokens_json
          from attempts a
         join flows f on f.flow_id = a.flow_id
          join attempt_authorization_scopes s on s.attempt_id = a.attempt_id
         where a.project_id = ?
           and ${activeSchedulerAttemptSql('a', 'f.status')}
      `).all(address.projectId) as unknown as Array<{ path_tokens_json: string }>
      if (activeScopes.some((scope) =>
        (JSON.parse(scope.path_tokens_json) as string[]).some((token) => requestedTokens.has(token)),
      )) {
        throw Object.assign(new Error('ATTEMPT_SCOPE_CONFLICT'), { code: 'ATTEMPT_SCOPE_CONFLICT' })
      }
      const version = currentVersion + 1
      const projection = { ...currentProjection, sessionVersion: version }
      const receipt = { ...record.receipt, sessionVersion: version }
      const insertBaseline = this.db.prepare(
        'insert or ignore into flow_execution_baselines (flow_id, baseline_id, base_revision, baseline_tree_hash, initial_target_fingerprint, baseline_digest, baseline_binding_digest, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      insertBaseline.run(
        record.flowId,
        record.baselineId,
        record.baseRevision ?? null,
        record.baselineTreeHash,
        record.initialTargetFingerprint,
        record.baselineDigest,
        record.flowBaselineBindingDigest,
        record.now,
      )
      const persistedBaseline = this.flowExecutionBaseline(record.flowId)
      if (!persistedBaseline || !flowBaselineMatchesScheduleRecord(persistedBaseline, record)) {
        throw Object.assign(new Error('BASELINE_CONFLICT'), { code: 'BASELINE_CONFLICT' })
      }
      const taskUpdated = this.db
        .prepare("update task_runs set status = 'READY', unavailable_reason = 'M2B1_SCHEDULED' where task_run_id = ? and status = 'PENDING_DISABLED'")
        .run(record.taskRunId)
      if (taskUpdated.changes !== 1) {
        throw Object.assign(new Error('TASK_SCHEDULE_CONFLICT'), { code: 'TASK_SCHEDULE_CONFLICT' })
      }
      this.db
        .prepare(
          'insert into attempts (attempt_id, project_id, session_key, flow_id, task_run_id, status, attempt_digest, workspace_receipt_id, runtime_session_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, null, null, ?, ?)',
        )
        .run(
          record.attemptId,
          address.projectId,
          address.sessionKey,
          record.flowId,
          record.taskRunId,
          'WORKSPACE_PREPARING',
          record.attemptDigest,
          record.now,
          record.now,
        )
      this.db.prepare(`
        insert into task_execution_baselines (
          attempt_id, task_run_id, flow_id, baseline_id, base_revision,
          baseline_tree_hash, initial_target_fingerprint, baseline_digest,
          baseline_binding_digest, ancestor_task_change_set_ids_json,
          derivation_digest, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.attemptId,
        record.taskRunId,
        record.flowId,
        record.taskBaselineId,
        record.taskBaseRevision ?? null,
        record.taskBaselineTreeHash,
        record.taskInitialTargetFingerprint,
        record.taskBaselineDigest,
        record.baselineBindingDigest,
        JSON.stringify(record.ancestorTaskChangeSetIds),
        record.taskBaselineDerivationDigest,
        record.now,
      )
      this.db.prepare(`
        insert into attempt_runtime_bindings (
          attempt_id, selection_digest, selection_json, binding_json, created_at
        ) values (?, ?, ?, ?, ?)
      `).run(
        record.attemptId,
        record.runtimeBinding.selectionDigest,
        JSON.stringify(record.runtimeBinding.selection),
        JSON.stringify(record.runtimeBinding),
        record.now,
      )
      this.db.prepare(`
        insert into attempt_authorization_scopes (
          attempt_id, scope_digest, path_tokens_json, created_at
        ) values (?, ?, ?, ?)
      `).run(
        record.attemptId,
        record.authorizationScope.scopeDigest,
        JSON.stringify(record.authorizationScope.pathTokens),
        record.now,
      )
      this.db.prepare(`
        insert into execution_waves (wave_id, flow_id, wave_json, created_at)
        values (?, ?, ?, ?)
      `).run(
        record.executionWave.waveId,
        record.flowId,
        JSON.stringify(record.executionWave),
        record.now,
      )
      this.writeEvent(address, version, 'system.schedule', {
        phase: 'task_run.transition',
        flowId: record.flowId,
        taskRunId: record.taskRunId,
        from: 'BLOCKED',
        to: 'DEPENDENCY_ELIGIBLE',
      }, record.now)
      this.writeEvent(address, version, 'system.schedule', {
        phase: 'task_run.transition',
        flowId: record.flowId,
        taskRunId: record.taskRunId,
        from: 'DEPENDENCY_ELIGIBLE',
        to: 'READY',
      }, record.now)
      this.db
        .prepare(
          'insert into composition_attempts (composition_attempt_id, attempt_id, attempt_kind, composition_digest, baseline_binding_digest, request_digest, created_at) values (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          `xhbc_${record.attemptId}`,
          record.attemptId,
          'INITIAL',
          record.compositionDigest,
          record.baselineBindingDigest,
          record.workspacePrepareRequestDigest,
          record.now,
        )
      this.db
        .prepare(
          'insert into workspace_prepare_outbox (outbox_id, attempt_id, request_digest, status, created_at, completed_at, claim_owner_id, claim_digest, claimed_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(`xhbwpo_${record.attemptId}`, record.attemptId, record.workspacePrepareRequestDigest, 'READY', record.now, null, null, null, null)
      this.writeEvent(address, version, 'system.schedule', {
        phase: 'attempt.created',
        flowId: record.flowId,
        taskRunId: record.taskRunId,
        attemptId: record.attemptId,
        status: 'CREATED',
      }, record.now)
      this.writeEvent(address, version, 'system.schedule', {
        phase: 'attempt.transition',
        flowId: record.flowId,
        taskRunId: record.taskRunId,
        attemptId: record.attemptId,
        from: 'CREATED',
        to: 'WORKSPACE_PREPARING',
      }, record.now)
      this.writeEvent(address, version, 'system.schedule', {
        phase: 'workspace_prepare.outbox_persisted',
        flowId: record.flowId,
        taskRunId: record.taskRunId,
        attemptId: record.attemptId,
        outboxId: `xhbwpo_${record.attemptId}`,
        requestDigest: record.workspacePrepareRequestDigest,
      }, record.now)
      this.writeProjection(address, projection)
      this.writeIdempotency(address, idempotency, receipt)
      return receipt
    })
  }

  writeWorkspacePrepared(address: HubAddressV1, idempotency: IdempotencyInput, record: WorkspacePreparedRecordM2BV1): void {
    this.transaction(() => {
      const version = this.currentVersion(address) + 1
      const nextAttemptStatus = record.workspaceReceipt.status === 'PREPARED' ? 'READY' : 'FAILED'
      const receipt = { ...record.receipt, sessionVersion: version }
      this.db
        .prepare(
          'insert into workspace_receipts (workspace_receipt_id, attempt_id, status, receipt_digest, conflict_digest, failure_json, created_at) values (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.workspaceReceipt.workspaceReceiptId,
          record.attemptId,
          record.workspaceReceipt.status,
          record.workspaceReceipt.receiptDigest,
          record.workspaceReceipt.status === 'CONFLICT' ? record.workspaceReceipt.conflictDigest : null,
          record.workspaceReceipt.status === 'FAILED' ? JSON.stringify(record.workspaceReceipt.failure) : null,
          record.now,
        )
      this.db.prepare('update workspace_prepare_outbox set status = ?, completed_at = ? where attempt_id = ?').run(
        record.workspaceReceipt.status === 'PREPARED' ? 'DONE' : 'FAILED',
        record.now,
        record.attemptId,
      )
      this.db.prepare('update attempts set status = ?, workspace_receipt_id = ?, updated_at = ? where attempt_id = ?').run(
        nextAttemptStatus,
        record.workspaceReceipt.workspaceReceiptId,
        record.now,
        record.attemptId,
      )
      this.db.prepare('update task_runs set status = ? where task_run_id = ?').run(record.workspaceReceipt.status === 'PREPARED' ? 'READY' : 'FAILED', record.taskRunId)
      this.writeEvent(address, version, 'system.workspace.prepare.result.record', {
        phase: 'attempt.transition',
        flowId: record.flowId,
        taskRunId: record.taskRunId,
        attemptId: record.attemptId,
        from: 'WORKSPACE_PREPARING',
        to: nextAttemptStatus,
        receipt: record.workspaceReceipt,
      }, record.now)
      this.bumpProjectionVersion(address, version)
      this.writeIdempotency(address, idempotency, receipt)
    })
  }

  writeAgentDispatchStart(address: HubAddressV1, record: AgentDispatchRecordM2BV1): void {
    this.transaction(() => {
      const version = this.currentVersion(address) + 1
      this.db
        .prepare(
          'insert or ignore into agent_dispatch_outbox (outbox_id, attempt_id, request_id, status, payload_digest, runtime_request_digest, runtime_request_json, selection_digest, created_at, claimed_at, completed_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          `xhbo_${record.requestId}`,
          record.attemptId,
          record.requestId,
          'READY',
          record.payloadDigest,
          record.runtimeRequestDigest,
          record.runtimeRequestJson,
          record.selectionDigest,
          record.now,
          null,
          null,
        )
      this.db.prepare("update attempts set status = 'STARTING', updated_at = ? where attempt_id = ?").run(
        record.now,
        record.attemptId,
      )
      this.db.prepare("update task_runs set status = 'RUNNING' where task_run_id = ?").run(record.taskRunId)
      this.writeEvent(address, version, 'system.agent.report.record', {
        phase: 'dispatch.outbox_persisted',
        taskRunId: record.taskRunId,
        attemptId: record.attemptId,
        outboxId: `xhbo_${record.requestId}`,
      }, record.now)
      this.writeEvent(address, version, 'system.agent.report.record', {
        phase: 'attempt.transition',
        taskRunId: record.taskRunId,
        attemptId: record.attemptId,
        from: 'READY',
        to: 'STARTING',
      }, record.now)
      this.bumpProjectionVersion(address, version)
    })
  }

  writeAgentReport(address: HubAddressV1, idempotency: IdempotencyInput, record: AgentReportRecordM2BV1): void {
    this.transaction(() => {
      const version = this.currentVersion(address) + 1
      const receipt = { ...record.receipt, sessionVersion: version }
      this.db
        .prepare(
          'insert into runtime_session_bindings (runtime_session_id, attempt_id, attempt_worktree_id, binding_digest, created_at) values (?, ?, ?, ?, ?)',
        )
        .run(record.runtimeSessionId, record.attemptId, `xhbwt_${record.attemptId}`, record.reportDigest, record.now)
      this.db.prepare("update agent_dispatch_outbox set status = 'DONE', claimed_at = coalesce(claimed_at, ?), completed_at = ? where outbox_id = ?").run(
        record.now,
        record.now,
        `xhbo_${record.requestId}`,
      )
      this.db.prepare("update attempts set status = 'RUNNING', runtime_session_id = ?, updated_at = ? where attempt_id = ?").run(
        record.runtimeSessionId,
        record.now,
        record.attemptId,
      )
      this.writeEvent(address, version, 'system.agent.report.record', {
        phase: 'attempt.transition',
        taskRunId: record.taskRunId,
        attemptId: record.attemptId,
        from: 'STARTING',
        to: 'RUNNING',
        runtimeSessionId: record.runtimeSessionId,
      }, record.now)
      this.bumpProjectionVersion(address, version)
      this.writeIdempotency(address, idempotency, receipt)
    })
  }

  beginTaskVerification(
    address: HubAddressV1,
    record: BeginTaskVerificationRecordV1,
  ): TaskVerificationBeginResultV1 {
    return this.transaction(() => {
      const request = parseTaskVerificationRequest(record.verificationRequestJson)
      const attempt = this.db
        .prepare(
          'select attempt_id, project_id, session_key, flow_id, task_run_id, status, runtime_session_id, outcome_receipt_digest from attempts where attempt_id = ?',
        )
        .get(record.candidate.attemptId) as
        | {
            attempt_id: AttemptId
            project_id: string
            session_key: string
            flow_id: FlowId
            task_run_id: TaskRunId
            status: string
            runtime_session_id: string | null
            outcome_receipt_digest: string | null
          }
        | undefined
      const taskRun = this.taskRun(record.candidate.taskRunId)
      if (
        !attempt ||
        !taskRun ||
        attempt.project_id !== address.projectId ||
        attempt.session_key !== address.sessionKey ||
        attempt.flow_id !== record.candidate.flowId ||
        attempt.task_run_id !== record.candidate.taskRunId ||
        taskRun.flow_id !== record.candidate.flowId
      ) {
        throw verificationStoreError('TASK_VERIFICATION_SCOPE_MISMATCH')
      }
      validateTaskVerificationBegin(this.db, record, request)
      if (
        record.succeededAudit.attemptId !== attempt.attempt_id ||
        record.succeededAudit.runtimeSessionId !== attempt.runtime_session_id
      ) {
        throw verificationStoreError('TASK_VERIFICATION_AGENT_BINDING_MISMATCH')
      }

      const persisted = this.verificationAttemptForAttempt(record.candidate.attemptId)
      if (persisted) {
        assertBeginReplay(this.db, address, persisted, record, request)
        return {
          verificationAttemptId: persisted.verification_attempt_id,
          outboxId: `xhbvo_${persisted.verification_attempt_id}`,
          replayed: true,
        }
      }
      const sourceStatus = record.reconcileStart ? 'OUTCOME_UNKNOWN' : 'RUNNING'
      if (attempt.status !== sourceStatus || taskRun.status !== sourceStatus) {
        throw verificationStoreError('TASK_VERIFICATION_ILLEGAL_TRANSITION')
      }
      if (record.reconcileStart) {
        const persistedUnknownDigest = attempt.outcome_receipt_digest ?? undefined
        if (
          record.reconcileStart.runtimeSessionId !== attempt.runtime_session_id ||
          record.reconcileStart.receiptDigest !== record.succeededAudit.receiptDigest ||
          record.reconcileStart.expectedReceiptDigest !== persistedUnknownDigest
        ) {
          throw verificationStoreError('TASK_VERIFICATION_RECONCILE_BINDING_MISMATCH')
        }
      }

      assertArtifactIdAvailable(this.db, record.patchArtifact)
      assertCandidateIdAvailable(this.db, record.candidate)
      assertVerificationAttemptIdAvailable(this.db, record.verificationAttempt.verificationAttemptId)

      insertArtifact(this.db, record.patchArtifact, record.now)
      this.db
        .prepare(
          'insert into change_set_candidates (candidate_id, flow_id, task_run_id, attempt_id, input_tree_hash, result_tree_hash, patch_artifact_id, candidate_digest, proposed_change_set_digest, candidate_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.candidate.candidateId,
          record.candidate.flowId,
          record.candidate.taskRunId,
          record.candidate.attemptId,
          record.candidate.inputTreeHash,
          record.candidate.resultTreeHash,
          record.candidate.patchArtifactId,
          record.candidate.candidateDigest,
          record.candidate.proposedChangeSetDigest,
          JSON.stringify(record.candidate),
          record.candidate.createdAt,
        )
      this.writeSucceededAudit(record.verificationAttempt.verificationRequestId, record.succeededAudit, record.now)
      this.db
        .prepare(
          'insert into verification_attempts (verification_attempt_id, verification_request_id, flow_id, task_run_id, attempt_id, candidate_id, request_digest, change_set_digest, qa_config_version, state, started_at, finished_at, outcome_receipt_digest) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null)',
        )
        .run(
          record.verificationAttempt.verificationAttemptId,
          record.verificationAttempt.verificationRequestId,
          record.verificationAttempt.flowId,
          record.verificationAttempt.taskRunId,
          record.verificationAttempt.attemptId,
          record.verificationAttempt.candidateId,
          record.verificationAttempt.requestDigest,
          request.changeSetDigest,
          request.qaConfigVersion,
          'STARTED',
          record.verificationAttempt.startedAt,
        )
      const outboxId = `xhbvo_${record.verificationAttempt.verificationAttemptId}`
      this.db
        .prepare(
          'insert into verification_outbox (outbox_id, verification_attempt_id, request_digest, request_json, status, claim_owner_id, claim_digest, claimed_at, completed_at, created_at) values (?, ?, ?, ?, ?, null, null, null, null, ?)',
        )
        .run(
          outboxId,
          record.verificationAttempt.verificationAttemptId,
          record.verificationAttempt.requestDigest,
          record.verificationRequestJson,
          'READY',
          record.now,
        )
      const attemptUpdated = this.db
        .prepare(
          "update attempts set status = 'VERIFYING', outcome_receipt_digest = ?, updated_at = ? where attempt_id = ? and status = ?",
        )
        .run(record.succeededAudit.receiptDigest, record.now, record.candidate.attemptId, sourceStatus)
      const taskUpdated = this.db
        .prepare("update task_runs set status = 'VERIFYING' where task_run_id = ? and status = ?")
        .run(record.candidate.taskRunId, sourceStatus)
      if (attemptUpdated.changes !== 1 || taskUpdated.changes !== 1) {
        throw verificationStoreError('TASK_VERIFICATION_ILLEGAL_TRANSITION')
      }

      const version = this.currentVersion(address) + 1
      if (record.reconcileStart) {
        this.db
          .prepare(
            'insert into agent_reconcile_results (reconcile_id, attempt_id, runtime_session_id, outcome, receipt_digest, expected_receipt_digest, failure_json, created_at) values (?, ?, ?, ?, ?, ?, null, ?)',
          )
          .run(
            `xhbrecon_${record.reconcileStart.receipt.requestId}`,
            record.candidate.attemptId,
            record.reconcileStart.runtimeSessionId,
            'SUCCEEDED',
            record.reconcileStart.receiptDigest,
            record.reconcileStart.expectedReceiptDigest ?? null,
            record.now,
          )
        this.writeEvent(
          address,
          version,
          'system.agent.reconcile',
          {
            phase: 'outcome_unknown.reconciled',
            attemptId: record.candidate.attemptId,
            runtimeSessionId: record.reconcileStart.runtimeSessionId,
            expectedReceiptDigest: record.reconcileStart.expectedReceiptDigest,
            outcome: 'SUCCEEDED',
            receiptDigest: record.reconcileStart.receiptDigest,
          },
          record.now,
        )
        this.writeEvent(
          address,
          version,
          'system.agent.outcome.record',
          {
            phase: 'task_verification.started',
            flowId: record.candidate.flowId,
            taskRunId: record.candidate.taskRunId,
            attemptId: record.candidate.attemptId,
            candidateId: record.candidate.candidateId,
            verificationAttemptId: record.verificationAttempt.verificationAttemptId,
            outboxId,
          },
          record.now,
        )
        this.writeIdempotency(address, record.reconcileStart.idempotency, {
          ...record.reconcileStart.receipt,
          sessionVersion: version,
        })
      } else {
        this.writeEvent(
          address,
          version,
          'system.agent.outcome.record',
          {
            phase: 'task_verification.started',
            flowId: record.candidate.flowId,
            taskRunId: record.candidate.taskRunId,
            attemptId: record.candidate.attemptId,
            candidateId: record.candidate.candidateId,
            verificationAttemptId: record.verificationAttempt.verificationAttemptId,
            outboxId,
          },
          record.now,
        )
      }
      this.bumpProjectionVersion(address, version)
      return {
        verificationAttemptId: record.verificationAttempt.verificationAttemptId,
        outboxId,
        replayed: false,
      }
    })
  }

  completeTaskVerification(
    address: HubAddressV1,
    record: CompleteTaskVerificationRecordV1,
  ): TaskVerificationCompletionResultV1 {
    return this.transaction(() => {
      validateVerificationReceiptDigest(record.receipt)
      const persisted = this.db
        .prepare(
          'select verification_attempt_id, verification_request_id, flow_id, task_run_id, attempt_id, candidate_id, request_digest, change_set_digest, qa_config_version, state, started_at, finished_at, outcome_receipt_digest from verification_attempts where verification_attempt_id = ?',
        )
        .get(record.receipt.verificationAttemptId) as VerificationAttemptRecord | undefined
      if (!persisted) throw verificationStoreError('TASK_VERIFICATION_NOT_FOUND')

      const scope = this.db
        .prepare('select project_id, session_key from attempts where attempt_id = ?')
        .get(persisted.attempt_id) as { project_id: string; session_key: string } | undefined
      if (!scope || scope.project_id !== address.projectId || scope.session_key !== address.sessionKey) {
        throw verificationStoreError('TASK_VERIFICATION_SCOPE_MISMATCH')
      }
      validateVerificationReceiptBinding(persisted, record.receipt)

      const existingReceipt = this.db
        .prepare('select receipt_json from verification_receipts where receipt_digest = ?')
        .get(record.receipt.receiptDigest) as { receipt_json: string } | undefined
      if (persisted.state !== 'STARTED') {
        if (
          persisted.outcome_receipt_digest === record.receipt.receiptDigest &&
          existingReceipt?.receipt_json === JSON.stringify(record.receipt) &&
          verificationStateForVerdict(record.receipt.verdict) === persisted.state
        ) {
          return {
            verificationAttemptId: persisted.verification_attempt_id,
            verdict: record.receipt.verdict,
            replayed: true,
          }
        }
        throw verificationStoreError('TASK_VERIFICATION_IDEMPOTENCY_CONFLICT')
      }
      if (existingReceipt) throw verificationStoreError('TASK_VERIFICATION_IDEMPOTENCY_CONFLICT')
      validateCompletionArtifacts(record)

      const outbox = this.readVerificationOutbox(persisted.verification_attempt_id)
      if (
        !outbox ||
        outbox.status !== 'CLAIMED' ||
        outbox.requestDigest !== persisted.request_digest
      ) {
        throw verificationStoreError('TASK_VERIFICATION_OUTBOX_NOT_CLAIMED')
      }
      const request = parseTaskVerificationRequest(outbox.requestJson)
      if (
        verificationRequestDigestV1(request) !== persisted.request_digest ||
        request.changeSetDigest !== persisted.change_set_digest ||
        request.qaConfigVersion !== persisted.qa_config_version
      ) {
        throw verificationStoreError('TASK_VERIFICATION_REQUEST_BINDING_MISMATCH')
      }

      const candidateRow = this.db
        .prepare('select candidate_json from change_set_candidates where candidate_id = ?')
        .get(persisted.candidate_id) as { candidate_json: string } | undefined
      if (!candidateRow) throw verificationStoreError('TASK_VERIFICATION_CANDIDATE_NOT_FOUND')
      const candidate = JSON.parse(candidateRow.candidate_json) as ChangeSetCandidateV1
      if (
        taskCandidateDigestV1(candidate) !== candidate.candidateDigest ||
        taskChangeSetDigestV1(taskChangeSetDigestFieldsForCandidate(this.db, candidate)) !== persisted.change_set_digest
      ) {
        throw verificationStoreError('TASK_VERIFICATION_CANDIDATE_DIGEST_MISMATCH')
      }

      const artifacts = [...(record.evidenceArtifacts ?? []), ...(record.diagnosticArtifacts ?? [])]
      for (const artifact of artifacts) {
        assertArtifactIdAvailable(this.db, artifact)
        insertArtifact(this.db, artifact, record.now)
      }
      this.db
        .prepare(
          'insert into verification_receipts (receipt_digest, verification_attempt_id, request_digest, verdict, receipt_json, failure_json, diagnostic_artifact_ids_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.receipt.receiptDigest,
          record.receipt.verificationAttemptId,
          record.receipt.requestDigest,
          record.receipt.verdict,
          JSON.stringify(record.receipt),
          record.receipt.verdict === 'FAIL' ? JSON.stringify(record.receipt.failure) : null,
          JSON.stringify(record.receipt.diagnosticArtifactIds),
          record.now,
        )

      if (record.receipt.verdict === 'PASS') {
        sealPassedTaskVerification(this.db, persisted, candidate, record)
      } else if (record.receipt.verdict === 'FAIL') {
        finishUnsealedTaskVerification(this.db, persisted, 'FAILED', record.receipt.receiptDigest, record.now)
      } else if (record.receipt.verdict === 'OUTCOME_UNKNOWN') {
        finishUnsealedTaskVerification(this.db, persisted, 'OUTCOME_UNKNOWN', record.receipt.receiptDigest, record.now)
      } else {
        throw verificationStoreError('TASK_VERIFICATION_VERDICT_UNSUPPORTED')
      }

      const outboxStatus =
        record.receipt.verdict === 'PASS'
          ? 'DONE'
          : record.receipt.verdict === 'FAIL'
            ? 'FAILED'
            : 'OUTCOME_UNKNOWN'
      const outboxUpdated = this.db
        .prepare(
          'update verification_outbox set status = ?, completed_at = ? where verification_attempt_id = ? and status = ?',
        )
        .run(outboxStatus, record.now, persisted.verification_attempt_id, 'CLAIMED')
      if (outboxUpdated.changes !== 1) throw verificationStoreError('TASK_VERIFICATION_OUTBOX_CONFLICT')

      const version = this.currentVersion(address) + 1
      this.writeEvent(
        address,
        version,
        'system.verification.complete',
        {
          phase: 'task_verification.completed',
          flowId: persisted.flow_id,
          taskRunId: persisted.task_run_id,
          attemptId: persisted.attempt_id,
          verificationAttemptId: persisted.verification_attempt_id,
          verdict: record.receipt.verdict,
          receiptDigest: record.receipt.receiptDigest,
        },
        record.now,
      )
      this.bumpProjectionVersion(address, version)
      return {
        verificationAttemptId: persisted.verification_attempt_id,
        verdict: record.receipt.verdict,
        replayed: false,
      }
    })
  }

  writeAgentOutcome(address: HubAddressV1, idempotency: IdempotencyInput, record: AgentOutcomeRecordM2BV1): void {
    this.transaction(() => {
      const version = this.currentVersion(address) + 1
      const receipt = { ...record.receipt, sessionVersion: version }
      const nextTaskStatus = record.outcome === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'FAILED'
      this.db.prepare('update attempts set status = ?, runtime_session_id = ?, outcome_receipt_digest = ?, updated_at = ? where attempt_id = ?').run(
        record.outcome,
        record.runtimeSessionId,
        record.receiptDigest,
        record.now,
        record.attemptId,
      )
      this.db.prepare('update task_runs set status = ? where task_run_id = ?').run(nextTaskStatus, record.taskRunId)
      if (record.failure) {
        this.db
          .prepare(
            'insert into agent_failures (failure_id, attempt_id, runtime_session_id, failure_json, receipt_digest, created_at) values (?, ?, ?, ?, ?, ?)',
          )
          .run(`xhbfail_${record.receipt.requestId}`, record.attemptId, record.runtimeSessionId, JSON.stringify(record.failure), record.receiptDigest, record.now)
      }
      if (record.succeededAudit) {
        this.writeSucceededAudit(record.receipt.requestId, record.succeededAudit, record.now)
      }
      this.writeEvent(address, version, 'system.agent.outcome.record', {
        phase: 'attempt.transition',
        taskRunId: record.taskRunId,
        attemptId: record.attemptId,
        runtimeSessionId: record.runtimeSessionId,
        to: record.outcome,
        receiptDigest: record.receiptDigest,
        ...(record.failure ? { failure: record.failure } : {}),
        ...(record.succeededAudit ? { succeededAudit: record.succeededAudit } : {}),
      }, record.now)
      this.bumpProjectionVersion(address, version)
      this.writeIdempotency(address, idempotency, receipt)
    })
  }

  /**
   * Invalidates a previously verified Attempt only when both authoritative
   * rows still match the exact SUCCEEDED/VERIFIED source state. Sealed evidence
   * remains immutable, while delivery is blocked by the Task transition.
   */
  markVerifiedCheckpointOutcomeUnknown(
    address: HubAddressV1,
    record: CheckpointRestoreOutcomeUnknownRecordV1,
  ): 'UPDATED' | 'REPLAYED' {
    return this.transaction(() => {
      const row = this.db.prepare(`
        select a.status as attempt_status, a.flow_id, a.task_run_id,
               tr.status as task_status, f.project_id, f.session_key
          from attempts a
          join task_runs tr on tr.task_run_id = a.task_run_id
          join flows f on f.flow_id = a.flow_id
         where a.attempt_id = ?
         limit 1
      `).get(record.attemptId) as {
        attempt_status: string
        flow_id: string
        task_run_id: string
        task_status: string
        project_id: string
        session_key: string
      } | undefined
      if (
        !row
        || row.project_id !== address.projectId
        || row.session_key !== address.sessionKey
        || row.flow_id !== record.flowId
        || row.task_run_id !== record.taskRunId
      ) throw new Error('CHECKPOINT_RESTORE_SCOPE_MISMATCH')
      if (row.attempt_status === 'OUTCOME_UNKNOWN' && row.task_status === 'OUTCOME_UNKNOWN') {
        return 'REPLAYED'
      }
      if (row.attempt_status !== 'SUCCEEDED' || row.task_status !== 'VERIFIED') {
        throw new Error('CHECKPOINT_RESTORE_OUTCOME_TRANSITION_REJECTED')
      }

      const attemptUpdated = this.db.prepare(`
        update attempts
           set status = 'OUTCOME_UNKNOWN', outcome_receipt_digest = ?, updated_at = ?
         where attempt_id = ? and status = 'SUCCEEDED'
      `).run(record.receiptDigest, record.now, record.attemptId)
      const taskUpdated = this.db.prepare(`
        update task_runs
           set status = 'OUTCOME_UNKNOWN'
         where task_run_id = ? and status = 'VERIFIED'
      `).run(record.taskRunId)
      if (attemptUpdated.changes !== 1 || taskUpdated.changes !== 1) {
        throw new Error('CHECKPOINT_RESTORE_OUTCOME_TRANSITION_CONFLICT')
      }

      const version = this.currentVersion(address) + 1
      this.writeEvent(address, version, 'system.agent.outcome.record', {
        phase: 'checkpoint.restore.outcome_unknown',
        flowId: record.flowId,
        taskRunId: record.taskRunId,
        attemptId: record.attemptId,
        reasonCode: record.reasonCode,
        receiptDigest: record.receiptDigest,
      }, record.now)
      this.bumpProjectionVersion(address, version)
      return 'UPDATED'
    })
  }

  writeAgentReconcile(address: HubAddressV1, idempotency: IdempotencyInput, record: AgentReconcileRecordM2BV1): void {
    this.transaction(() => {
      const version = this.currentVersion(address) + 1
      const receipt = { ...record.receipt, sessionVersion: version }
      const taskRun = this.db
        .prepare('select task_run_id from attempts where attempt_id = ?')
        .get(record.attemptId) as { task_run_id: TaskRunId } | undefined
      const nextTaskStatus = record.outcome === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'FAILED'
      this.db.prepare('update attempts set status = ?, outcome_receipt_digest = ?, updated_at = ? where attempt_id = ?').run(record.outcome, record.receiptDigest, record.now, record.attemptId)
      if (taskRun) this.db.prepare('update task_runs set status = ? where task_run_id = ?').run(nextTaskStatus, taskRun.task_run_id)
      this.db
        .prepare(
          'insert into agent_reconcile_results (reconcile_id, attempt_id, runtime_session_id, outcome, receipt_digest, expected_receipt_digest, failure_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          `xhbrecon_${record.receipt.requestId}`,
          record.attemptId,
          record.runtimeSessionId,
          record.outcome,
          record.receiptDigest,
          record.expectedReceiptDigest ?? null,
          record.failure ? JSON.stringify(record.failure) : null,
          record.now,
        )
      if (record.failure) {
        this.db
          .prepare(
            'insert into agent_failures (failure_id, attempt_id, runtime_session_id, failure_json, receipt_digest, created_at) values (?, ?, ?, ?, ?, ?)',
          )
          .run(`xhbfail_${record.receipt.requestId}`, record.attemptId, record.runtimeSessionId, JSON.stringify(record.failure), record.receiptDigest, record.now)
      }
      if (record.succeededAudit) {
        this.writeSucceededAudit(record.receipt.requestId, record.succeededAudit, record.now)
      }
      this.writeEvent(address, version, 'system.agent.reconcile', {
        phase: 'outcome_unknown.reconciled',
        attemptId: record.attemptId,
        runtimeSessionId: record.runtimeSessionId,
        expectedReceiptDigest: record.expectedReceiptDigest,
        outcome: record.outcome,
        receiptDigest: record.receiptDigest,
        ...(record.failure ? { failure: record.failure } : {}),
        ...(record.succeededAudit ? { succeededAudit: record.succeededAudit } : {}),
      }, record.now)
      this.bumpProjectionVersion(address, version)
      this.writeIdempotency(address, idempotency, receipt)
    })
  }

  tableCounts(): Record<string, number> {
    const tables = [
      'journal_events',
      'idempotency_keys',
      'session_projection',
      'flows',
      'plan_revisions',
      'task_specs',
      'task_runs',
      'attempts',
      'execution_waves',
      'attempt_runtime_bindings',
      'attempt_authorization_scopes',
      'task_execution_baselines',
      'derived_execution_baselines',
      'derived_execution_baseline_reservations',
      'flow_execution_baselines',
      'composition_attempts',
      'workspace_prepare_outbox',
      'workspace_receipts',
      'attempt_workspace_prepared',
      'attempt_workspace_leases',
      'attempt_file_manifests',
      'scope_expansion_requests',
      'create_batches',
      'private_runtime_payloads',
      'agent_dispatch_outbox',
      'runtime_session_bindings',
      'agent_failures',
      'agent_succeeded_audits',
      'agent_reconcile_results',
      'artifacts',
      'change_set_candidates',
      'verification_attempts',
      'verification_outbox',
      'verification_receipts',
      'task_evidence_bundles',
      'task_qa_results',
      'task_change_sets',
      'delivery_batches',
      'delivery_selection_drafts',
      'delivery_verification_attempts',
      'delivery_verification_outbox',
      'delivery_verification_receipts',
      'delivery_change_sets',
      'delivery_human_gates',
      'delivery_apply_attempts',
      'delivery_apply_outbox',
    ]
    return Object.fromEntries(
      tables.map((table) => {
        const row = this.db.prepare(`select count(*) as count from ${table}`).get() as { count: number }
        return [table, row.count]
      }),
    )
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists journal_events (
        event_id integer primary key autoincrement,
        project_id text not null,
        session_key text not null,
        session_sequence integer not null,
        version integer not null,
        event_type text not null,
        event_json text not null,
        created_at text not null
      );
      create table if not exists idempotency_keys (
        scope_key text not null,
        request_id text not null,
        command_type text not null,
        payload_hash text not null,
        receipt_json text not null,
        primary key (scope_key, request_id)
      );
      create table if not exists session_projection (
        project_id text not null,
        session_key text not null,
        version integer not null,
        projection_json text not null,
        primary key (project_id, session_key)
      );
      create table if not exists flows (
        flow_id text primary key,
        project_id text not null,
        session_key text not null,
        status text not null,
        active_revision_id text,
        objective text not null,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists plan_revisions (
        revision_id text primary key,
        flow_id text not null references flows(flow_id),
        ordinal integer not null,
        status text not null,
        digest text not null,
        draft_json text not null,
        created_at text not null,
        submitted_at text
      );
      create table if not exists task_specs (
        task_spec_id text primary key,
        flow_id text not null references flows(flow_id),
        task_key text not null,
        title text not null,
        summary text,
        depends_json text not null,
        unavailable_reason text not null
      );
      create table if not exists task_runs (
        task_run_id text primary key,
        task_spec_id text not null references task_specs(task_spec_id),
        flow_id text not null references flows(flow_id),
        task_key text not null,
        status text not null,
        unavailable_reason text not null
      );
      create table if not exists schema_migrations (
        version integer primary key,
        applied_at text not null
      );
      insert or ignore into schema_migrations (version, applied_at) values (1, datetime('now'));
    `)
    this.db.exec(`
      drop index if exists flows_one_active_per_session;
      create unique index if not exists flows_one_active_per_session
        on flows(project_id, session_key)
        where status not in ('CANCELLED');
      create table if not exists attempts (
        attempt_id text primary key,
        project_id text not null,
        session_key text not null,
        flow_id text not null references flows(flow_id),
        task_run_id text not null references task_runs(task_run_id),
        status text not null,
        attempt_digest text not null,
        workspace_receipt_id text,
        runtime_session_id text,
        outcome_receipt_digest text,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists flow_execution_baselines (
        flow_id text primary key references flows(flow_id),
        baseline_id text not null,
        baseline_tree_hash text not null,
        initial_target_fingerprint text not null,
        baseline_digest text not null,
        baseline_binding_digest text not null,
        created_at text not null
      );
      create table if not exists composition_attempts (
        composition_attempt_id text primary key,
        attempt_id text not null references attempts(attempt_id),
        attempt_kind text not null,
        composition_digest text not null,
        baseline_binding_digest text not null,
        request_digest text not null,
        created_at text not null,
        unique(attempt_id, attempt_kind)
      );
      create table if not exists workspace_prepare_outbox (
        outbox_id text primary key,
        attempt_id text not null references attempts(attempt_id),
        request_digest text not null,
        status text not null,
        created_at text not null,
        completed_at text,
        unique(attempt_id)
      );
      create table if not exists workspace_receipts (
        workspace_receipt_id text primary key,
        attempt_id text not null references attempts(attempt_id),
        status text not null,
        receipt_digest text not null,
        conflict_digest text,
        failure_json text,
        created_at text not null
      );
      create table if not exists agent_dispatch_outbox (
        outbox_id text primary key,
        attempt_id text not null references attempts(attempt_id),
        request_id text not null,
        status text not null,
        payload_digest text not null,
        runtime_request_digest text,
        runtime_request_json text,
        selection_digest text,
        created_at text not null,
        claimed_at text,
        completed_at text
      );
      create table if not exists runtime_session_bindings (
        runtime_session_id text primary key,
        attempt_id text not null references attempts(attempt_id),
        attempt_worktree_id text not null,
        binding_digest text not null,
        created_at text not null
      );
      create table if not exists agent_failures (
        failure_id text primary key,
        attempt_id text not null references attempts(attempt_id),
        runtime_session_id text not null,
        failure_json text not null,
        receipt_digest text not null,
        created_at text not null
      );
      create table if not exists agent_succeeded_audits (
        audit_id text primary key,
        attempt_id text not null references attempts(attempt_id),
        runtime_session_id text not null,
        receipt_digest text not null,
        candidate_digest text not null,
        created_at text not null
      );
      create table if not exists agent_reconcile_results (
        reconcile_id text primary key,
        attempt_id text not null references attempts(attempt_id),
        runtime_session_id text not null,
        outcome text not null,
        receipt_digest text not null,
        expected_receipt_digest text,
        failure_json text,
        created_at text not null
      );
      insert or ignore into schema_migrations (version, applied_at) values (2, datetime('now'));
    `)
    this.addColumnIfMissing('workspace_receipts', 'conflict_digest', 'text')
    this.addColumnIfMissing('attempts', 'outcome_receipt_digest', 'text')
    this.addColumnIfMissing('agent_dispatch_outbox', 'runtime_request_digest', 'text')
    this.addColumnIfMissing('agent_dispatch_outbox', 'runtime_request_json', 'text')
    this.addColumnIfMissing('agent_dispatch_outbox', 'selection_digest', 'text')
    this.transaction(() => {
      this.db.exec(`
        create table if not exists attempt_workspace_prepared (
          attempt_id text primary key,
          request_json text not null,
          result_json text not null
        );
        create table if not exists attempt_workspace_leases (
          attempt_id text primary key,
          request_conflict_digest text not null,
          lease_json text not null
        );
        create table if not exists attempt_file_manifests (
          attempt_id text primary key,
          version integer not null,
          manifest_digest text not null,
          manifest_json text not null
        );
        create table if not exists scope_expansion_requests (
          request_id text primary key,
          attempt_id text not null,
          state text not null,
          request_json text not null
        );
        create table if not exists create_batches (
          batch_id text primary key,
          attempt_id text not null,
          owner_id text not null,
          state text not null,
          batch_json text not null
        );
        create table if not exists private_runtime_payloads (
          ref_id text primary key,
          attempt_id text not null,
          media_type text not null check (media_type in ('application/vnd.xiaogui.runtime-prompt+json', 'application/vnd.xiaogui.runtime-message+json')),
          digest text not null,
          payload blob not null,
          created_at text not null
        );
      `)
      this.addColumnIfMissing('flow_execution_baselines', 'base_revision', 'text')
      this.addColumnIfMissing('workspace_prepare_outbox', 'claim_owner_id', 'text')
      this.addColumnIfMissing('workspace_prepare_outbox', 'claim_digest', 'text')
      this.addColumnIfMissing('workspace_prepare_outbox', 'claimed_at', 'text')
      this.db.exec(`
        create index if not exists attempt_file_manifests_attempt_version
          on attempt_file_manifests(attempt_id, version);
        create index if not exists attempt_workspace_leases_conflict_digest
          on attempt_workspace_leases(request_conflict_digest);
        create index if not exists scope_expansion_requests_attempt_state
          on scope_expansion_requests(attempt_id, state);
        create index if not exists create_batches_state_attempt
          on create_batches(state, attempt_id);
        create index if not exists private_runtime_payloads_attempt_media
          on private_runtime_payloads(attempt_id, media_type);
        create index if not exists workspace_prepare_outbox_status_attempt
          on workspace_prepare_outbox(status, attempt_id);
        create index if not exists workspace_prepare_outbox_claim
          on workspace_prepare_outbox(claim_owner_id, claim_digest)
          where status = 'CLAIMED';
        insert or ignore into schema_migrations (version, applied_at) values (3, datetime('now'));
      `)
    })
    this.transaction(() => {
      this.db.exec(`
        create table if not exists artifacts (
          artifact_id text primary key,
          kind text not null,
          media_type text not null,
          content_digest text not null,
          content blob not null,
          created_at text not null
        );
        create table if not exists change_set_candidates (
          candidate_id text primary key,
          flow_id text not null references flows(flow_id),
          task_run_id text not null references task_runs(task_run_id),
          attempt_id text not null references attempts(attempt_id),
          input_tree_hash text not null,
          result_tree_hash text not null,
          patch_artifact_id text not null references artifacts(artifact_id),
          candidate_digest text not null,
          proposed_change_set_digest text not null,
          candidate_json text not null,
          created_at text not null,
          unique(attempt_id),
          unique(candidate_digest)
        );
        create table if not exists verification_attempts (
          verification_attempt_id text primary key,
          verification_request_id text not null unique,
          flow_id text not null references flows(flow_id),
          task_run_id text not null references task_runs(task_run_id),
          attempt_id text not null references attempts(attempt_id),
          candidate_id text not null references change_set_candidates(candidate_id),
          request_digest text not null,
          change_set_digest text not null,
          qa_config_version text not null,
          state text not null,
          started_at text not null,
          finished_at text,
          outcome_receipt_digest text,
          unique(attempt_id)
        );
        create table if not exists verification_outbox (
          outbox_id text primary key,
          verification_attempt_id text not null references verification_attempts(verification_attempt_id),
          request_digest text not null,
          request_json text not null,
          status text not null,
          claim_owner_id text,
          claim_digest text,
          claimed_at text,
          completed_at text,
          created_at text not null,
          unique(verification_attempt_id)
        );
        create table if not exists verification_receipts (
          receipt_digest text primary key,
          verification_attempt_id text not null references verification_attempts(verification_attempt_id),
          request_digest text not null,
          verdict text not null,
          receipt_json text not null,
          failure_json text,
          diagnostic_artifact_ids_json text not null,
          created_at text not null,
          unique(verification_attempt_id, request_digest, receipt_digest)
        );
        create table if not exists task_evidence_bundles (
          evidence_bundle_id text primary key,
          verification_attempt_id text not null references verification_attempts(verification_attempt_id),
          flow_id text not null references flows(flow_id),
          task_run_id text not null references task_runs(task_run_id),
          attempt_id text not null references attempts(attempt_id),
          change_set_digest text not null,
          qa_config_version text not null,
          artifact_ids_json text not null,
          bundle_digest text not null,
          bundle_json text not null,
          created_at text not null,
          unique(verification_attempt_id),
          unique(bundle_digest)
        );
        create table if not exists task_qa_results (
          qa_result_id text primary key,
          verification_attempt_id text not null references verification_attempts(verification_attempt_id),
          flow_id text not null references flows(flow_id),
          task_run_id text not null references task_runs(task_run_id),
          attempt_id text not null references attempts(attempt_id),
          candidate_id text not null references change_set_candidates(candidate_id),
          change_set_digest text not null,
          qa_config_version text not null,
          verdict text not null,
          checks_json text not null,
          result_digest text not null,
          result_json text not null,
          created_at text not null,
          unique(verification_attempt_id),
          unique(result_digest)
        );
        create table if not exists task_change_sets (
          task_change_set_id text primary key,
          version integer not null,
          flow_id text not null references flows(flow_id),
          plan_revision_id text not null references plan_revisions(revision_id),
          task_run_id text not null references task_runs(task_run_id),
          attempt_id text not null references attempts(attempt_id),
          verification_attempt_id text not null references verification_attempts(verification_attempt_id),
          candidate_id text not null references change_set_candidates(candidate_id),
          input_tree_hash text not null,
          result_tree_hash text not null,
          ancestor_task_change_set_ids_json text not null,
          patch_artifact_id text not null references artifacts(artifact_id),
          evidence_bundle_id text not null references task_evidence_bundles(evidence_bundle_id),
          qa_result_id text not null references task_qa_results(qa_result_id),
          qa_config_version text not null,
          digest text not null,
          change_set_json text not null,
          created_at text not null,
          unique(task_run_id),
          unique(attempt_id),
          unique(verification_attempt_id),
          unique(candidate_id)
        );
        create index if not exists verification_outbox_status_attempt
          on verification_outbox(status, verification_attempt_id);
        create index if not exists verification_receipts_attempt_created
          on verification_receipts(verification_attempt_id, created_at);
        insert or ignore into schema_migrations (version, applied_at) values (4, datetime('now'));
      `)
    })
    this.transaction(() => {
      this.db.exec(`
        create table if not exists delivery_batches (
          batch_id text primary key,
          project_id text not null,
          session_key text not null,
          flow_id text not null references flows(flow_id),
          selection_draft_id text not null,
          state text not null,
          selection_digest text not null,
          target_fingerprint text not null,
          recovery_source_batch_id text,
          recovery_source_apply_attempt_id text,
          created_at text not null,
          updated_at text not null,
          unique(selection_digest)
        );
        create table if not exists delivery_selection_drafts (
          draft_id text primary key,
          batch_id text not null references delivery_batches(batch_id),
          flow_id text not null references flows(flow_id),
          selected_task_run_ids_json text not null,
          resolved_task_change_set_ids_json text not null,
          dependency_task_run_ids_json text not null,
          selection_digest text not null,
          draft_json text not null,
          created_at text not null,
          unique(batch_id),
          unique(selection_digest)
        );
        create table if not exists delivery_verification_attempts (
          delivery_verification_attempt_id text primary key,
          verification_request_id text not null unique,
          batch_id text not null references delivery_batches(batch_id),
          flow_id text not null references flows(flow_id),
          request_digest text not null,
          selection_digest text not null,
          qa_config_version text not null,
          state text not null,
          started_at text not null,
          finished_at text,
          outcome_receipt_digest text,
          unique(batch_id)
        );
        create table if not exists delivery_verification_outbox (
          outbox_id text primary key,
          delivery_verification_attempt_id text not null references delivery_verification_attempts(delivery_verification_attempt_id),
          request_digest text not null,
          request_json text not null,
          status text not null,
          claim_owner_id text,
          claim_digest text,
          claimed_at text,
          completed_at text,
          created_at text not null,
          unique(delivery_verification_attempt_id)
        );
        create table if not exists delivery_verification_receipts (
          receipt_digest text primary key,
          delivery_verification_attempt_id text not null references delivery_verification_attempts(delivery_verification_attempt_id),
          request_digest text not null,
          verdict text not null,
          receipt_json text not null,
          diagnostic_artifact_ids_json text not null,
          created_at text not null,
          unique(delivery_verification_attempt_id, request_digest, receipt_digest)
        );
        create table if not exists delivery_change_sets (
          delivery_change_set_id text primary key,
          batch_id text not null references delivery_batches(batch_id),
          flow_id text not null references flows(flow_id),
          version integer not null,
          selection_digest text not null,
          task_change_set_ids_json text not null,
          evidence_artifact_ids_json text not null,
          qa_config_version text not null,
          digest text not null,
          change_set_json text not null,
          created_at text not null,
          unique(batch_id),
          unique(digest)
        );
        create table if not exists delivery_human_gates (
          gate_id text primary key,
          batch_id text not null references delivery_batches(batch_id),
          delivery_change_set_id text not null references delivery_change_sets(delivery_change_set_id),
          subject_version integer not null,
          subject_digest text not null,
          state text not null,
          decision_digest text,
          decided_at text,
          gate_json text not null,
          created_at text not null,
          unique(batch_id)
        );
        create table if not exists delivery_apply_attempts (
          apply_attempt_id text primary key,
          batch_id text not null references delivery_batches(batch_id),
          delivery_change_set_id text not null references delivery_change_sets(delivery_change_set_id),
          request_digest text not null,
          target_fingerprint_before text not null,
          state text not null,
          receipt_digest text,
          target_fingerprint_after text,
          started_at text not null,
          finished_at text,
          unique(request_digest)
        );
        create table if not exists delivery_apply_outbox (
          outbox_id text primary key,
          apply_attempt_id text not null references delivery_apply_attempts(apply_attempt_id),
          request_digest text not null,
          request_json text not null,
          status text not null,
          claim_owner_id text,
          claim_digest text,
          claimed_at text,
          completed_at text,
          created_at text not null,
          unique(apply_attempt_id)
        );
        create unique index if not exists delivery_one_active_batch_per_flow
          on delivery_batches(flow_id)
          where state in ('COMPOSING', 'VERIFYING', 'READY_FOR_REVIEW', 'APPROVED', 'APPLYING', 'OUTCOME_UNKNOWN');
        create unique index if not exists delivery_one_recovery_per_source_batch
          on delivery_batches(recovery_source_batch_id)
          where recovery_source_batch_id is not null;
        create index if not exists delivery_verification_outbox_status
          on delivery_verification_outbox(status, delivery_verification_attempt_id);
        create index if not exists delivery_apply_outbox_status
          on delivery_apply_outbox(status, apply_attempt_id);
        insert or ignore into schema_migrations (version, applied_at) values (5, datetime('now'));
      `)
    })
    this.transaction(() => {
      this.db.exec(`
        drop index if exists attempts_one_active_external;
        drop trigger if exists attempts_one_active_external_insert;
        drop trigger if exists attempts_one_active_external_update;
        create trigger attempts_one_active_external_insert
          before insert on attempts
          when ${activeSchedulerAttemptSql('new', "coalesce((select status from flows where flow_id = new.flow_id), '')")}
            and exists (
              select 1
              from attempts existing
              join flows existing_flow on existing_flow.flow_id = existing.flow_id
              where existing.project_id = new.project_id
                and existing.session_key = new.session_key
                and ${activeSchedulerAttemptSql('existing', 'existing_flow.status')}
            )
          begin
            select raise(abort, 'ATTEMPT_ACTIVE_CONFLICT');
          end;
        create trigger attempts_one_active_external_update
          before update of project_id, session_key, flow_id, status on attempts
          when ${activeSchedulerAttemptSql('new', "coalesce((select status from flows where flow_id = new.flow_id), '')")}
            and exists (
              select 1
              from attempts existing
              join flows existing_flow on existing_flow.flow_id = existing.flow_id
              where existing.attempt_id <> old.attempt_id
                and existing.project_id = new.project_id
                and existing.session_key = new.session_key
                and ${activeSchedulerAttemptSql('existing', 'existing_flow.status')}
            )
          begin
            select raise(abort, 'ATTEMPT_ACTIVE_CONFLICT');
          end;
        insert or ignore into schema_migrations (version, applied_at) values (6, datetime('now'));
      `)
    })
    this.transaction(() => {
      this.addColumnIfMissing('delivery_apply_attempts', 'safe_code', 'text')
      this.addColumnIfMissing('delivery_apply_attempts', 'changed_relative_paths_json', 'text')
      this.addColumnIfMissing('delivery_apply_attempts', 'receipt_json', 'text')
      this.db.exec(`
        insert or ignore into schema_migrations (version, applied_at) values (7, datetime('now'));
      `)
    })
    this.transaction(() => {
      this.addColumnIfMissing('delivery_batches', 'recovery_source_batch_id', 'text')
      this.db.exec(`
        create unique index if not exists delivery_one_recovery_per_source_batch
          on delivery_batches(recovery_source_batch_id)
          where recovery_source_batch_id is not null;
        insert or ignore into schema_migrations (version, applied_at) values (8, datetime('now'));
      `)
    })
    this.transaction(() => {
      this.addColumnIfMissing('delivery_batches', 'recovery_source_apply_attempt_id', 'text')
      this.db.exec(`
        insert or ignore into schema_migrations (version, applied_at) values (9, datetime('now'));
      `)
    })
    this.transaction(() => {
      this.db.exec(`
        create table if not exists execution_waves (
          wave_id text primary key,
          flow_id text not null references flows(flow_id),
          wave_json text not null,
          created_at text not null
        );
        create table if not exists attempt_runtime_bindings (
          attempt_id text primary key references attempts(attempt_id),
          selection_digest text not null,
          selection_json text not null,
          binding_json text not null,
          created_at text not null
        );
        create table if not exists attempt_authorization_scopes (
          attempt_id text primary key references attempts(attempt_id),
          scope_digest text not null,
          path_tokens_json text not null,
          created_at text not null
        );
        create table if not exists task_execution_baselines (
          attempt_id text primary key references attempts(attempt_id),
          task_run_id text not null references task_runs(task_run_id),
          flow_id text not null references flows(flow_id),
          baseline_id text not null,
          base_revision text,
          baseline_tree_hash text not null,
          initial_target_fingerprint text not null,
          baseline_digest text not null,
          baseline_binding_digest text not null,
          ancestor_task_change_set_ids_json text not null,
          derivation_digest text not null,
          created_at text not null
        );
        create index if not exists execution_waves_flow_created
          on execution_waves(flow_id, created_at);
        drop index if exists attempts_one_active_external;
        drop trigger if exists attempts_one_active_external_insert;
        drop trigger if exists attempts_one_active_external_update;
        drop trigger if exists attempts_project_parallel_limit_insert;
        drop trigger if exists attempts_project_parallel_limit_update;
        create trigger attempts_project_parallel_limit_insert
          before insert on attempts
          when ${activeSchedulerAttemptSql('new', "coalesce((select status from flows where flow_id = new.flow_id), '')")}
            and 2 <= (
              select count(*)
                from attempts existing
                join flows existing_flow on existing_flow.flow_id = existing.flow_id
               where existing.project_id = new.project_id
                 and ${activeSchedulerAttemptSql('existing', 'existing_flow.status')}
            )
          begin
            select raise(abort, 'ATTEMPT_PROJECT_CAPACITY_CONFLICT');
          end;
        create trigger attempts_project_parallel_limit_update
          before update of project_id, flow_id, status on attempts
          when ${activeSchedulerAttemptSql('new', "coalesce((select status from flows where flow_id = new.flow_id), '')")}
            and 2 <= (
              select count(*)
                from attempts existing
                join flows existing_flow on existing_flow.flow_id = existing.flow_id
               where existing.attempt_id <> old.attempt_id
                 and existing.project_id = new.project_id
                 and ${activeSchedulerAttemptSql('existing', 'existing_flow.status')}
            )
          begin
            select raise(abort, 'ATTEMPT_PROJECT_CAPACITY_CONFLICT');
          end;
        insert or ignore into schema_migrations (version, applied_at) values (10, datetime('now'));
      `)
    })
    this.transaction(() => {
      this.db.exec(`
        create table if not exists derived_execution_baselines (
          derivation_input_digest text primary key,
          project_id text not null,
          flow_id text not null,
          task_run_id text not null,
          baseline_json text not null,
          created_at text not null
        );
        create index if not exists derived_execution_baselines_task
          on derived_execution_baselines(project_id, flow_id, task_run_id);
        insert or ignore into schema_migrations (version, applied_at) values (11, datetime('now'));
      `)
    })
    this.transaction(() => {
      this.db.exec(`
        create table if not exists derived_execution_baseline_reservations (
          derivation_input_digest text primary key,
          project_id text not null,
          flow_id text not null,
          task_run_id text not null,
          owner_token text not null,
          lease_expires_at text not null,
          created_at text not null,
          updated_at text not null
        );
        create index if not exists derived_execution_baseline_reservations_lease
          on derived_execution_baseline_reservations(lease_expires_at);
        insert or ignore into schema_migrations (version, applied_at) values (12, datetime('now'));
      `)
    })
  }

  private taskRunsForFlow(flowId: FlowId | null): TaskRunRecord[] {
    if (!flowId) return []
    return this.db
      .prepare(
        'select tr.task_run_id, tr.task_spec_id, tr.flow_id, tr.task_key, tr.status, tr.unavailable_reason, ts.depends_json from task_runs tr join task_specs ts on ts.task_spec_id = tr.task_spec_id where tr.flow_id = ? order by tr.rowid asc',
      )
      .all(flowId) as unknown as TaskRunRecord[]
  }

  private attemptsForFlow(flowId: FlowId | null): AttemptRecord[] {
    if (!flowId) return []
    return this.db
      .prepare('select attempt_id, task_run_id, flow_id, status, attempt_digest, workspace_receipt_id, runtime_session_id, outcome_receipt_digest from attempts where flow_id = ? order by rowid asc')
      .all(flowId) as unknown as AttemptRecord[]
  }

  private verificationAttemptForAttempt(attemptId: AttemptId): VerificationAttemptRecord | null {
    const row = this.db
      .prepare(
        'select verification_attempt_id, verification_request_id, flow_id, task_run_id, attempt_id, candidate_id, request_digest, change_set_digest, qa_config_version, state, started_at, finished_at, outcome_receipt_digest from verification_attempts where attempt_id = ?',
      )
      .get(attemptId) as VerificationAttemptRecord | undefined
    return row ?? null
  }

  private verificationSummaryForAttempt(attemptId: AttemptId): TaskVerificationSummaryV1 | null {
    const attempt = this.verificationAttemptForAttempt(attemptId)
    if (!attempt) return null
    const receiptRow = attempt.outcome_receipt_digest
      ? (this.db
          .prepare('select receipt_json from verification_receipts where receipt_digest = ?')
          .get(attempt.outcome_receipt_digest) as { receipt_json: string } | undefined)
      : undefined
    const receipt = receiptRow ? (JSON.parse(receiptRow.receipt_json) as TaskVerificationReceiptV1) : null
    const diagnosticArtifacts = receipt ? readArtifactRefs(this.db, receipt.diagnosticArtifactIds) : []
    const base = {
      scope: 'TASK' as const,
      verificationAttemptId: attempt.verification_attempt_id as VerificationAttemptId,
      candidateId: attempt.candidate_id as TaskChangeSetCandidateId,
      changeSetDigest: attempt.change_set_digest as Sha256Digest,
      qaConfigVersion: attempt.qa_config_version,
      diagnosticArtifacts,
    }
    if (attempt.state === 'STARTED') return { ...base, state: 'STARTED' }
    if (attempt.state === 'OUTCOME_UNKNOWN') {
      if (!receipt || receipt.verdict !== 'OUTCOME_UNKNOWN') {
        throw verificationStoreError('TASK_VERIFICATION_PROJECTION_INCONSISTENT')
      }
      return { ...base, state: 'OUTCOME_UNKNOWN', verdict: 'OUTCOME_UNKNOWN' }
    }
    if (attempt.state === 'FAILED') {
      if (!receipt || receipt.verdict !== 'FAIL') {
        throw verificationStoreError('TASK_VERIFICATION_PROJECTION_INCONSISTENT')
      }
      return {
        ...base,
        state: 'FAILED',
        verdict: 'FAIL',
        checks: receipt.checks.map(({ checkId, verdict, summary }) => ({ checkId, verdict, summary })),
        failure: receipt.failure,
      }
    }
    if (attempt.state === 'SUCCEEDED') {
      if (!receipt || receipt.verdict !== 'PASS') {
        throw verificationStoreError('TASK_VERIFICATION_PROJECTION_INCONSISTENT')
      }
      const sealed = this.db
        .prepare(
          'select evidence_bundle_id, qa_result_id, task_change_set_id from task_change_sets where verification_attempt_id = ?',
        )
        .get(attempt.verification_attempt_id) as
        | { evidence_bundle_id: string; qa_result_id: string; task_change_set_id: string }
        | undefined
      if (!sealed) throw verificationStoreError('TASK_VERIFICATION_PROJECTION_INCONSISTENT')
      return {
        ...base,
        state: 'SUCCEEDED',
        verdict: 'PASS',
        checks: receipt.checks.map(({ checkId, verdict, summary }) => ({ checkId, verdict, summary })),
        evidenceBundleId: sealed.evidence_bundle_id as EvidenceBundleId,
        qaResultId: sealed.qa_result_id as QaResultId,
        taskChangeSetId: sealed.task_change_set_id as TaskChangeSetId,
        evidenceArtifacts: readArtifactRefs(this.db, receipt.evidenceArtifactIds),
      }
    }
    throw verificationStoreError('TASK_VERIFICATION_PROJECTION_INCONSISTENT')
  }

  private activeDeliveryBatch(address: HubAddressV1, flowId: FlowId): DeliveryBatchRow | null {
    const row = this.db
      .prepare(
        "select batch_id, project_id, session_key, flow_id, selection_draft_id, state, selection_digest, target_fingerprint, recovery_source_batch_id, recovery_source_apply_attempt_id, created_at, updated_at from delivery_batches where project_id = ? and session_key = ? and flow_id = ? and state in ('COMPOSING', 'VERIFYING', 'READY_FOR_REVIEW', 'APPROVED', 'APPLYING', 'OUTCOME_UNKNOWN') order by rowid desc limit 1",
      )
      .get(address.projectId, address.sessionKey, flowId) as DeliveryBatchRow | undefined
    return row ?? null
  }

  private deliveryBatch(batchId: DeliveryBatchId): DeliveryBatchRow | null {
    const row = this.db
      .prepare(
        'select batch_id, project_id, session_key, flow_id, selection_draft_id, state, selection_digest, target_fingerprint, recovery_source_batch_id, recovery_source_apply_attempt_id, created_at, updated_at from delivery_batches where batch_id = ?',
      )
      .get(batchId) as DeliveryBatchRow | undefined
    return row ?? null
  }

  private deliveryVerificationAttempt(
    verificationAttemptId: DeliveryVerificationAttemptId,
  ): DeliveryVerificationAttemptRow | null {
    const row = this.db
      .prepare(
        'select delivery_verification_attempt_id, verification_request_id, batch_id, flow_id, request_digest, selection_digest, qa_config_version, state, started_at, finished_at, outcome_receipt_digest from delivery_verification_attempts where delivery_verification_attempt_id = ?',
      )
      .get(verificationAttemptId) as DeliveryVerificationAttemptRow | undefined
    return row ?? null
  }

  private deliveryChangeSet(changeSetId: DeliveryChangeSetId): DeliveryChangeSetRow | null {
    const row = this.db
      .prepare(
        'select delivery_change_set_id, batch_id, flow_id, version, digest, change_set_json, created_at from delivery_change_sets where delivery_change_set_id = ?',
      )
      .get(changeSetId) as DeliveryChangeSetRow | undefined
    return row ?? null
  }

  private deliveryGate(gateId: DeliveryGateId): DeliveryGateRow | null {
    const row = this.db
      .prepare(
        'select gate_id, batch_id, delivery_change_set_id, subject_version, subject_digest, state, decision_digest, decided_at, gate_json, created_at from delivery_human_gates where gate_id = ?',
      )
      .get(gateId) as DeliveryGateRow | undefined
    return row ?? null
  }

  private deliveryApplyAttempt(applyAttemptId: DeliveryApplyAttemptId): DeliveryApplyAttemptRow | null {
    const row = this.db
      .prepare(
        'select apply_attempt_id, batch_id, delivery_change_set_id, request_digest, target_fingerprint_before, state, receipt_digest, safe_code, changed_relative_paths_json, receipt_json, target_fingerprint_after, started_at, finished_at from delivery_apply_attempts where apply_attempt_id = ?',
      )
      .get(applyAttemptId) as DeliveryApplyAttemptRow | undefined
    return row ?? null
  }

  private buildDeliverySelectionDraft(record: CreateDeliverySelectionRecordV1): DeliverySelectionDraftV1 {
    if (record.selectedTaskRunIds.length === 0) throw deliveryStoreError('DELIVERY_SELECTION_EMPTY')
    const selected = new Set(record.selectedTaskRunIds)
    if (selected.size !== record.selectedTaskRunIds.length) throw deliveryStoreError('DELIVERY_SELECTION_DUPLICATE')
    const allRuns = this.taskRunsForFlow(record.flowId)
    const byId = new Map(allRuns.map((run) => [run.task_run_id, run]))
    const dependencyTaskRunIds: TaskRunId[] = []
    for (const taskRunId of record.selectedTaskRunIds) {
      const taskRun = byId.get(taskRunId)
      if (!taskRun || taskRun.status !== 'VERIFIED') throw deliveryStoreError('DELIVERY_TASK_NOT_VERIFIED')
      for (const dependencyKey of JSON.parse(taskRun.depends_json) as string[]) {
        const dependency = allRuns.find((run) => run.task_key === dependencyKey)
        if (!dependency) throw deliveryStoreError('DELIVERY_DEPENDENCY_NOT_FOUND')
        if (!selected.has(dependency.task_run_id)) throw deliveryStoreError('DELIVERY_DEPENDENCY_CLOSURE_INCOMPLETE')
      }
    }
    for (const run of allRuns) {
      if (selected.has(run.task_run_id)) dependencyTaskRunIds.push(run.task_run_id)
    }
    const refs = dependencyTaskRunIds.map((taskRunId) => {
      const row = this.db
        .prepare('select task_run_id, task_change_set_id, digest, patch_artifact_id from task_change_sets where task_run_id = ?')
        .get(taskRunId) as
        | {
            task_run_id: TaskRunId
            task_change_set_id: TaskChangeSetId
            digest: Sha256Digest
            patch_artifact_id: ArtifactId
          }
        | undefined
      if (!row) throw deliveryStoreError('DELIVERY_TASK_CHANGESET_NOT_FOUND')
      return {
        taskRunId: row.task_run_id,
        taskChangeSetId: row.task_change_set_id,
        digest: row.digest,
        patchArtifactId: row.patch_artifact_id,
      }
    })
    const draftWithoutDigest = {
      kind: 'DELIVERY_SELECTION_DRAFT' as const,
      version: 1 as const,
      draftId: record.draftId,
      batchId: record.batchId,
      selectionDraftId: record.draftId,
      deliveryBatchId: record.batchId,
      flowId: record.flowId,
      selectedTaskRunIds: dependencyTaskRunIds,
      resolvedTaskChangeSets: refs,
      dependencyTaskRunIds,
      taskChangeSetIds: refs.map((item) => item.taskChangeSetId),
      dependencyOrder: refs.map((item) => item.taskChangeSetId),
      baselineTreeHash: record.targetFingerprint,
      targetFingerprint: record.targetFingerprint,
      createdAt: record.now as never,
    }
    return { ...draftWithoutDigest, digest: deliverySelectionDigestV1(draftWithoutDigest) }
  }

  private deliveryProjection(batchId: DeliveryBatchId): DeliveryBatchProjectionV1 | null {
    const batch = this.deliveryBatch(batchId)
    if (!batch) return null
    const draftRow = this.db
      .prepare(
        'select draft_id, batch_id, flow_id, selected_task_run_ids_json, resolved_task_change_set_ids_json, dependency_task_run_ids_json, selection_digest, draft_json, created_at from delivery_selection_drafts where batch_id = ?',
      )
      .get(batchId) as DeliverySelectionDraftRow | undefined
    if (!draftRow) throw deliveryStoreError('DELIVERY_PROJECTION_INCONSISTENT')
    const selectedTaskRunIds = JSON.parse(draftRow.selected_task_run_ids_json) as TaskRunId[]
    const taskChangeSetIds = JSON.parse(draftRow.resolved_task_change_set_ids_json) as TaskChangeSetId[]
    const changeSetRow = this.db
      .prepare(
        'select delivery_change_set_id, batch_id, flow_id, version, digest, change_set_json, created_at from delivery_change_sets where batch_id = ?',
      )
      .get(batchId) as DeliveryChangeSetRow | undefined
    const gateRow = this.db
      .prepare(
        'select gate_id, batch_id, delivery_change_set_id, subject_version, subject_digest, state, decision_digest, decided_at, gate_json, created_at from delivery_human_gates where batch_id = ?',
      )
      .get(batchId) as DeliveryGateRow | undefined
    const applyRow = this.db
      .prepare(
        'select apply_attempt_id, batch_id, delivery_change_set_id, request_digest, target_fingerprint_before, state, receipt_digest, safe_code, changed_relative_paths_json, receipt_json, target_fingerprint_after, started_at, finished_at from delivery_apply_attempts where batch_id = ? order by rowid desc limit 1',
      )
      .get(batchId) as DeliveryApplyAttemptRow | undefined
    const changeSet = changeSetRow ? (JSON.parse(changeSetRow.change_set_json) as DeliveryChangeSetV1) : null
    return {
      batchId: batch.batch_id,
      flowId: batch.flow_id,
      state: batch.state,
      selectionDigest: batch.selection_digest,
      selectedTaskRunIds,
      taskChangeSetIds,
      targetFingerprint: batch.target_fingerprint,
      ...(batch.recovery_source_batch_id ? { recoverySourceBatchId: batch.recovery_source_batch_id } : {}),
      ...(changeSetRow
        ? {
            deliveryChangeSetId: changeSetRow.delivery_change_set_id,
            deliveryChangeSetDigest: changeSetRow.digest,
            ...(changeSet?.recoveryLineage ? { recoveryLineage: changeSet.recoveryLineage } : {}),
            fileChangeSummaries: changeSet?.fileChanges ?? [],
            evidenceArtifactIds: changeSet?.evidenceArtifactIds ?? [],
            ...(changeSet?.qaConfigVersion ? { qaConfigVersion: changeSet.qaConfigVersion } : {}),
          }
        : {}),
      ...(gateRow ? { gate: toDeliveryHumanGate(gateRow) } : {}),
      ...(applyRow ? { applyAttempt: toDeliveryApplyAttempt(applyRow) } : {}),
    }
  }

  private insertDeliveryChangeSet(changeSet: DeliveryChangeSetV1): void {
    const batchId = changeSet.batchId
    if (!batchId) throw deliveryStoreError('DELIVERY_CHANGESET_BINDING_MISMATCH')
    if (!changeSet.selectionDigest) throw deliveryStoreError('DELIVERY_CHANGESET_BINDING_MISMATCH')
    if (!changeSet.qaConfigVersion) throw deliveryStoreError('DELIVERY_CHANGESET_BINDING_MISMATCH')
    if (!changeSet.taskChangeSetIds || !changeSet.evidenceArtifactIds) {
      throw deliveryStoreError('DELIVERY_CHANGESET_BINDING_MISMATCH')
    }
    this.db
      .prepare(
        'insert into delivery_change_sets (delivery_change_set_id, batch_id, flow_id, version, selection_digest, task_change_set_ids_json, evidence_artifact_ids_json, qa_config_version, digest, change_set_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        String(changeSet.deliveryChangeSetId),
        String(batchId),
        String(changeSet.flowId),
        changeSet.version,
        String(changeSet.selectionDigest),
        JSON.stringify(changeSet.taskChangeSetIds),
        JSON.stringify(changeSet.evidenceArtifactIds),
        changeSet.qaConfigVersion,
        String(changeSet.digest),
        JSON.stringify(changeSet),
        String(changeSet.createdAt),
      )
  }

  private finishDeliveryVerificationRows(
    attempt: DeliveryVerificationAttemptRow,
    verificationState: 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN',
    outboxState: DeliveryVerificationOutboxStateV1,
    batchState: DeliveryBatchStateV1,
    receiptDigest: Sha256Digest,
    now: string,
  ): void {
    const attemptUpdated = this.db
      .prepare(
        'update delivery_verification_attempts set state = ?, finished_at = ?, outcome_receipt_digest = ? where delivery_verification_attempt_id = ? and state = ?',
      )
      .run(verificationState, now, receiptDigest, attempt.delivery_verification_attempt_id, 'STARTED')
    const outboxUpdated = this.db
      .prepare(
        'update delivery_verification_outbox set status = ?, completed_at = ? where delivery_verification_attempt_id = ? and status = ?',
      )
      .run(outboxState, now, attempt.delivery_verification_attempt_id, 'CLAIMED')
    const batchUpdated = this.db
      .prepare('update delivery_batches set state = ?, updated_at = ? where batch_id = ? and state = ?')
      .run(batchState, now, attempt.batch_id, 'VERIFYING')
    if (attemptUpdated.changes !== 1 || outboxUpdated.changes !== 1 || batchUpdated.changes !== 1) {
      throw deliveryStoreError('DELIVERY_ILLEGAL_TRANSITION')
    }
  }

  private restoreDeliveryTasks(batchId: DeliveryBatchId, status: string): void {
    const draft = this.db
      .prepare('select selected_task_run_ids_json from delivery_selection_drafts where batch_id = ?')
      .get(batchId) as { selected_task_run_ids_json: string } | undefined
    if (!draft) throw deliveryStoreError('DELIVERY_SELECTION_NOT_FOUND')
    const taskRunIds = JSON.parse(draft.selected_task_run_ids_json) as TaskRunId[]
    for (const taskRunId of taskRunIds) {
      this.db.prepare('update task_runs set status = ? where task_run_id = ?').run(status, taskRunId)
    }
  }

  private bumpProjectionVersion(address: HubAddressV1, version: number): void {
    const projection = this.readProjection(address)
    if (!projection) return
    this.writeProjection(address, { ...projection, sessionVersion: version })
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>
    if (columns.some((item) => item.name === column)) return
    this.db.exec(`alter table ${table} add column ${column} ${definition}`)
  }

  private writeSucceededAudit(requestId: string, audit: AgentSucceededAuditV1, now: string): void {
    this.db
      .prepare(
        'insert into agent_succeeded_audits (audit_id, attempt_id, runtime_session_id, receipt_digest, candidate_digest, created_at) values (?, ?, ?, ?, ?, ?)',
      )
      .run(`xhbsucc_${requestId}`, audit.attemptId, audit.runtimeSessionId, audit.receiptDigest, audit.candidateDigest, now)
  }

  private writeEvent(address: HubAddressV1, version: number, eventType: string, event: unknown, now: string): void {
    const sequenceRow = this.db
      .prepare('select coalesce(max(session_sequence), 0) + 1 as next from journal_events where project_id = ? and session_key = ?')
      .get(address.projectId, address.sessionKey) as { next: number }
    this.db
      .prepare(
        'insert into journal_events (project_id, session_key, session_sequence, version, event_type, event_json, created_at) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(address.projectId, address.sessionKey, sequenceRow.next, version, eventType, JSON.stringify(event), now)
  }

  private writeProjection(address: HubAddressV1, projection: SessionCollaborationProjectionV1): void {
    this.db
      .prepare(
        'insert into session_projection (project_id, session_key, version, projection_json) values (?, ?, ?, ?) on conflict(project_id, session_key) do update set version = excluded.version, projection_json = excluded.projection_json',
      )
      .run(address.projectId, address.sessionKey, projection.sessionVersion, JSON.stringify(projection))
  }

  private writeIdempotency(address: HubAddressV1, idempotency: IdempotencyInput, receipt: PerformReceiptV1): void {
    this.db
      .prepare(
        'insert into idempotency_keys (scope_key, request_id, command_type, payload_hash, receipt_json) values (?, ?, ?, ?, ?)',
      )
      .run(scopeKey(address), idempotency.requestId, idempotency.commandType, idempotency.payloadHash, JSON.stringify(receipt))
  }

  private checkIdempotencyForWrite(address: HubAddressV1, idempotency: IdempotencyInput): PerformReceiptV1 | null {
    const existing = this.idempotency(address, idempotency.requestId)
    if (!existing) return null
    if (existing.command_type !== idempotency.commandType || existing.payload_hash !== idempotency.payloadHash) {
      throw Object.assign(new Error('IDEMPOTENCY_CONFLICT'), { code: 'IDEMPOTENCY_CONFLICT' })
    }
    return JSON.parse(existing.receipt_json) as PerformReceiptV1
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('begin immediate')
    try {
      const result = fn()
      this.db.exec('commit')
      return result
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }
}

export interface IdempotencyInput {
  requestId: string
  commandType: string
  payloadHash: string
}

function scopeKey(address: HubAddressV1): string {
  return `${address.projectId}:${address.sessionKey}`
}

function assertDerivedBaselineScope(
  persisted: {
    readonly derivation_input_digest: string
    readonly project_id: string
    readonly flow_id: string
    readonly task_run_id: string
  },
  requested: {
    readonly derivation_input_digest: string
    readonly project_id: string
    readonly flow_id: string
    readonly task_run_id: string
  },
): void {
  if (
    persisted.derivation_input_digest !== requested.derivation_input_digest ||
    persisted.project_id !== requested.project_id ||
    persisted.flow_id !== requested.flow_id ||
    persisted.task_run_id !== requested.task_run_id
  ) {
    throw derivedBaselineConflict()
  }
}

function derivedBaselineConflict(): Error & { code: string } {
  return Object.assign(new Error('DERIVED_BASELINE_IDEMPOTENCY_CONFLICT'), {
    code: 'DERIVED_BASELINE_IDEMPOTENCY_CONFLICT',
  })
}

const ACTIVE_ATTEMPT_STATUSES_SQL_V1 = [...ACTIVE_ATTEMPT_STATUSES_V1]
  .map((status) => `'${status}'`)
  .join(', ')

/**
 * Authoritative scheduler occupancy predicate. An OUTCOME_UNKNOWN attempt
 * remains active until its owning flow is cancelled; only then does it stop
 * consuming project capacity and authorization-path range.
 */
function activeSchedulerAttemptSql(attemptAlias: string, flowStatusExpression: string): string {
  return `${attemptAlias}.status in (${ACTIVE_ATTEMPT_STATUSES_SQL_V1}) and not (` +
    `${attemptAlias}.status = 'OUTCOME_UNKNOWN' and ${flowStatusExpression} = 'CANCELLED')`
}

function toVerificationOutboxRecord(row: VerificationOutboxRow): VerificationOutboxRecordV1 {
  return {
    outboxId: row.outbox_id,
    verificationAttemptId: row.verification_attempt_id,
    requestDigest: row.request_digest,
    requestJson: row.request_json,
    status: row.status as VerificationOutboxRecordV1['status'],
    ...(row.claim_owner_id ? { claimOwnerId: row.claim_owner_id } : {}),
    ...(row.claim_digest ? { claimDigest: row.claim_digest } : {}),
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    createdAt: row.created_at,
  }
}

function toDeliveryVerificationOutboxRecord(row: DeliveryVerificationOutboxRow): DeliveryVerificationOutboxRecordV1 {
  return {
    outboxId: row.outbox_id,
    verificationAttemptId: row.delivery_verification_attempt_id,
    requestDigest: row.request_digest,
    requestJson: row.request_json,
    status: row.status,
    ...(row.claim_owner_id ? { claimOwnerId: row.claim_owner_id } : {}),
    ...(row.claim_digest ? { claimDigest: row.claim_digest } : {}),
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    createdAt: row.created_at,
  }
}

function toDeliveryApplyOutboxRecord(row: DeliveryApplyOutboxRow): DeliveryApplyOutboxRecordV1 {
  return {
    outboxId: row.outbox_id,
    applyAttemptId: row.apply_attempt_id,
    requestDigest: row.request_digest,
    requestJson: row.request_json,
    status: row.status,
    ...(row.claim_owner_id ? { claimOwnerId: row.claim_owner_id } : {}),
    ...(row.claim_digest ? { claimDigest: row.claim_digest } : {}),
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    createdAt: row.created_at,
  }
}

function toDeliveryHumanGate(row: DeliveryGateRow): DeliveryHumanGateV1 {
  return {
    gateId: row.gate_id,
    batchId: row.batch_id,
    subject: {
      deliveryChangeSetId: row.delivery_change_set_id,
      version: row.subject_version,
      digest: row.subject_digest,
    },
    state: row.state as DeliveryHumanGateV1['state'],
    ...(row.decision_digest ? { decisionDigest: row.decision_digest } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at as never } : {}),
    createdAt: row.created_at as never,
  }
}

function toDeliveryApplyAttempt(row: DeliveryApplyAttemptRow): DeliveryApplyAttemptV1 {
  const receipt = persistedDeliveryApplyReceipt(row)
  return {
    applyAttemptId: row.apply_attempt_id,
    batchId: row.batch_id,
    deliveryChangeSetId: row.delivery_change_set_id,
    requestDigest: row.request_digest,
    targetFingerprintBefore: row.target_fingerprint_before,
    state: row.state,
    ...(row.receipt_digest ? { receiptDigest: row.receipt_digest } : {}),
    ...(receipt && receipt.verdict !== 'SUCCEEDED' ? { safeCode: receipt.safeCode } : {}),
    ...(receipt ? { changedRelativePaths: receipt.changedRelativePaths } : {}),
    ...(row.target_fingerprint_after ? { targetFingerprintAfter: row.target_fingerprint_after } : {}),
    startedAt: row.started_at as never,
    ...(row.finished_at ? { finishedAt: row.finished_at as never } : {}),
  }
}

const DELIVERY_APPLY_SAFE_CODES_V1 = new Set<DeliveryApplySafeCodeV1>([
  'APPROVAL_SUBJECT_MISMATCH',
  'DELIVERY_CHANGESET_DIGEST_MISMATCH',
  'DELIVERY_FILE_INVALID',
  'TARGET_BASELINE_DRIFT',
  'TARGET_STATUS_DIRTY',
  'TARGET_FILE_DRIFT',
  'TARGET_WRITE_FAILED',
  'ROLLBACK_INCOMPLETE',
  'APPLY_ATTEMPT_CONFLICT',
  'APPLY_ATTEMPT_NOT_FOUND',
])

function validateDeliveryApplyReceipt(
  receipt: DeliveryApplyReceiptV1,
  attempt: Pick<DeliveryApplyAttemptRow, 'apply_attempt_id' | 'delivery_change_set_id'>,
  expectedOutcome: CompleteDeliveryApplyRecordV1['outcome'],
): void {
  if (
    !receipt ||
    receipt.applyAttemptId !== attempt.apply_attempt_id ||
    receipt.deliveryChangeSetId !== attempt.delivery_change_set_id
  ) {
    throw deliveryStoreError('DELIVERY_APPLY_RECEIPT_BINDING_MISMATCH')
  }
  if (
    !Array.isArray(receipt.changedRelativePaths) ||
    receipt.changedRelativePaths.some((relativePath) => typeof relativePath !== 'string')
  ) {
    throw deliveryStoreError('DELIVERY_APPLY_RECEIPT_SHAPE_INVALID')
  }
  if (deliveryApplyReceiptDigestV1(receipt) !== receipt.receiptDigest) {
    throw deliveryStoreError('DELIVERY_APPLY_RECEIPT_DIGEST_MISMATCH')
  }
  const actualOutcome = deliveryApplyOutcome(receipt)
  if (actualOutcome !== expectedOutcome) throw deliveryStoreError('DELIVERY_APPLY_RECEIPT_OUTCOME_MISMATCH')
  if (receipt.verdict === 'SUCCEEDED') {
    if (typeof receipt.targetFingerprint !== 'string') {
      throw deliveryStoreError('DELIVERY_APPLY_RECEIPT_SHAPE_INVALID')
    }
    return
  }
  if (!DELIVERY_APPLY_SAFE_CODES_V1.has(receipt.safeCode)) {
    throw deliveryStoreError('DELIVERY_APPLY_RECEIPT_SHAPE_INVALID')
  }
}

function persistedDeliveryApplyReceipt(row: DeliveryApplyAttemptRow): DeliveryApplyReceiptV1 | null {
  const hasPersistedFacts =
    row.safe_code !== null || row.changed_relative_paths_json !== null || row.receipt_json !== null
  if (!hasPersistedFacts) return null
  if (!row.receipt_digest || row.changed_relative_paths_json === null || row.receipt_json === null) {
    throw deliveryStoreError('DELIVERY_APPLY_RECEIPT_PERSISTENCE_INCONSISTENT')
  }
  let receipt: DeliveryApplyReceiptV1
  let changedRelativePaths: unknown
  try {
    receipt = JSON.parse(row.receipt_json) as DeliveryApplyReceiptV1
    changedRelativePaths = JSON.parse(row.changed_relative_paths_json)
  } catch {
    throw deliveryStoreError('DELIVERY_APPLY_RECEIPT_PERSISTENCE_INCONSISTENT')
  }
  const expectedOutcome = deliveryApplyOutcomeFromAttemptState(row.state)
  validateDeliveryApplyReceipt(receipt, row, expectedOutcome)
  const receiptSafeCode = receipt.verdict === 'SUCCEEDED' ? null : receipt.safeCode
  const receiptTargetFingerprint = receipt.verdict === 'SUCCEEDED' ? receipt.targetFingerprint : null
  if (
    receipt.receiptDigest !== row.receipt_digest ||
    JSON.stringify(changedRelativePaths) !== JSON.stringify(receipt.changedRelativePaths) ||
    row.safe_code !== receiptSafeCode ||
    row.target_fingerprint_after !== receiptTargetFingerprint
  ) {
    throw deliveryStoreError('DELIVERY_APPLY_RECEIPT_PERSISTENCE_INCONSISTENT')
  }
  return receipt
}

function deliveryApplyOutcome(receipt: DeliveryApplyReceiptV1): CompleteDeliveryApplyRecordV1['outcome'] {
  if (receipt.verdict === 'SUCCEEDED') return 'SUCCEEDED'
  if (receipt.verdict === 'FAILED_ROLLED_BACK') return 'FAILED'
  if (receipt.verdict === 'OUTCOME_UNKNOWN') return 'OUTCOME_UNKNOWN'
  throw deliveryStoreError('DELIVERY_APPLY_RECEIPT_SHAPE_INVALID')
}

function deliveryApplyOutcomeFromAttemptState(
  state: DeliveryApplyAttemptV1['state'],
): CompleteDeliveryApplyRecordV1['outcome'] {
  if (state === 'SUCCEEDED') return 'SUCCEEDED'
  if (state === 'FAILED' || state === 'FAILED_ROLLED_BACK') return 'FAILED'
  if (state === 'OUTCOME_UNKNOWN') return 'OUTCOME_UNKNOWN'
  throw deliveryStoreError('DELIVERY_APPLY_RECEIPT_PERSISTENCE_INCONSISTENT')
}

function parseDeliveryVerificationRequest(raw: string): DeliveryVerificationRequestV1 {
  const request = JSON.parse(raw) as DeliveryVerificationRequestV1
  if (request.scope !== 'DELIVERY' || deliveryVerificationRequestDigestV1(request) !== request.requestDigest) {
    throw deliveryStoreError('DELIVERY_VERIFICATION_REQUEST_DIGEST_MISMATCH')
  }
  return request
}

function validateDeliveryVerificationReceipt(receipt: DeliveryVerificationReceiptV1): void {
  if (receipt.scope !== 'DELIVERY' || deliveryVerificationReceiptDigestV1(receipt) !== receipt.receiptDigest) {
    throw deliveryStoreError('DELIVERY_VERIFICATION_RECEIPT_DIGEST_MISMATCH')
  }
  if (receipt.verdict === 'PASS') {
    if ((receipt.checks ?? []).some((check) => check.verdict !== 'PASS') || (receipt.evidenceArtifactIds ?? []).length === 0) {
      throw deliveryStoreError('DELIVERY_VERIFICATION_RECEIPT_SHAPE_INVALID')
    }
  } else if (receipt.verdict === 'FAIL') {
    if ((receipt.checks ?? []).length === 0 || receipt.checks?.[0]?.verdict !== 'FAIL' || !receipt.reason) {
      throw deliveryStoreError('DELIVERY_VERIFICATION_RECEIPT_SHAPE_INVALID')
    }
  } else if (receipt.verdict === 'OUTCOME_UNKNOWN') {
    if (!receipt.reason || (receipt.checks ?? []).length !== 0 || (receipt.evidenceArtifactIds ?? []).length !== 0) {
      throw deliveryStoreError('DELIVERY_VERIFICATION_RECEIPT_SHAPE_INVALID')
    }
  }
}

function validateDeliveryChangeSet(
  batch: DeliveryBatchRow,
  receipt: DeliveryVerificationReceiptV1,
  changeSet: DeliveryChangeSetV1,
): void {
  if (
    changeSet.kind !== 'DELIVERY_CHANGESET' ||
    changeSet.version !== 1 ||
    changeSet.batchId !== batch.batch_id ||
    changeSet.flowId !== batch.flow_id ||
    changeSet.selectionDigest !== batch.selection_digest ||
    changeSet.deliveryChangeSetId !== receipt.deliveryChangeSetId ||
    changeSet.digest !== receipt.deliveryChangeSetDigest ||
    deliveryChangeSetDigestV1(changeSet) !== changeSet.digest ||
    !(changeSet.fileChanges ?? []).every((item) => item.operation === 'CREATE' || item.operation === 'MODIFY') ||
    (changeSet.fileChanges ?? []).some((item) => item.relativePath.includes('..') || /^[A-Za-z]:[\\/]|^\\\\|^file:\/\//.test(item.relativePath))
  ) {
    throw deliveryStoreError('DELIVERY_CHANGESET_BINDING_MISMATCH')
  }
}

function deliveryChangeSetDigestWithEvidence(
  changeSet: DeliveryChangeSetV1,
  evidenceArtifactIds: readonly ArtifactId[],
): Sha256Digest {
  const { digest: _oldDigest, ...base } = changeSet
  return deliveryChangeSetDigestV1({ ...base, evidenceArtifactIds })
}

function assertDeliveryRecoveryArtifactsMatch(record: SealRecoveredDeliveryCandidateRecordV1): void {
  const evidenceArtifacts = record.evidenceArtifacts ?? []
  const diagnosticArtifacts = record.diagnosticArtifacts ?? []
  if (
    !sameStringArray(record.deliveryChangeSet.evidenceArtifactIds, record.receipt.evidenceArtifactIds) ||
    !sameStringArray(evidenceArtifacts.map((artifact) => artifact.artifactId), record.receipt.evidenceArtifactIds) ||
    !sameStringArray(diagnosticArtifacts.map((artifact) => artifact.artifactId), record.receipt.diagnosticArtifactIds)
  ) {
    throw deliveryStoreError('DELIVERY_ARTIFACT_INVALID')
  }
  const allArtifactIds = [
    ...record.deliveryFileArtifacts.map((artifact) => artifact.artifactId),
    ...evidenceArtifacts.map((artifact) => artifact.artifactId),
    ...diagnosticArtifacts.map((artifact) => artifact.artifactId),
  ]
  if (new Set(allArtifactIds).size !== allArtifactIds.length) throw deliveryStoreError('DELIVERY_ARTIFACT_INVALID')
  for (const artifact of evidenceArtifacts) {
    if (artifact.kind !== 'VERIFICATION_EVIDENCE' || artifact.contentDigest !== digestBytes(artifact.content)) {
      throw deliveryStoreError('DELIVERY_ARTIFACT_INVALID')
    }
  }
  for (const artifact of diagnosticArtifacts) {
    if (artifact.kind !== 'VERIFICATION_DIAGNOSTIC' || artifact.contentDigest !== digestBytes(artifact.content)) {
      throw deliveryStoreError('DELIVERY_ARTIFACT_INVALID')
    }
  }
}

function assertRecoveredDeliveryCandidateReplay(
  db: DatabaseSync,
  address: HubAddressV1,
  existing: DeliveryBatchRow,
  record: SealRecoveredDeliveryCandidateRecordV1,
): void {
  const sourceBatch = db
    .prepare(
      'select batch_id, project_id, session_key, flow_id, selection_draft_id, state, selection_digest, target_fingerprint, recovery_source_batch_id, recovery_source_apply_attempt_id, created_at, updated_at from delivery_batches where batch_id = ?',
    )
    .get(record.sourceBatchId) as DeliveryBatchRow | undefined
  const sourceAttempt = db
    .prepare(
      'select apply_attempt_id, batch_id, delivery_change_set_id, request_digest, target_fingerprint_before, state, receipt_digest, safe_code, changed_relative_paths_json, receipt_json, target_fingerprint_after, started_at, finished_at from delivery_apply_attempts where apply_attempt_id = ?',
    )
    .get(record.sourceFailedApplyAttemptId) as DeliveryApplyAttemptRow | undefined
  const sourceChangeSetRow = sourceAttempt
    ? (db
        .prepare(
          'select delivery_change_set_id, batch_id, flow_id, version, digest, change_set_json, created_at from delivery_change_sets where delivery_change_set_id = ?',
        )
        .get(sourceAttempt.delivery_change_set_id) as DeliveryChangeSetRow | undefined)
    : undefined
  const sourceChangeSet = sourceChangeSetRow
    ? JSON.parse(sourceChangeSetRow.change_set_json) as DeliveryChangeSetV1
    : null
  const failedReceipt = sourceAttempt ? persistedDeliveryApplyReceipt(sourceAttempt) : null
  const sourceTargetFingerprint = sourceChangeSet ? deliveryTargetFingerprintV1(sourceChangeSet.target) : null
  const sourceDraft = db
    .prepare(
      'select draft_id, batch_id, flow_id, selected_task_run_ids_json, resolved_task_change_set_ids_json, dependency_task_run_ids_json, selection_digest, draft_json, created_at from delivery_selection_drafts where batch_id = ?',
    )
    .get(record.sourceBatchId) as DeliverySelectionDraftRow | undefined
  if (
    !sourceBatch ||
    sourceBatch.project_id !== address.projectId ||
    sourceBatch.session_key !== address.sessionKey ||
    sourceBatch.state !== 'SUPERSEDED' ||
    !sourceAttempt ||
    sourceAttempt.batch_id !== record.sourceBatchId ||
    (sourceAttempt.state !== 'FAILED' && sourceAttempt.state !== 'FAILED_ROLLED_BACK') ||
    failedReceipt?.verdict !== 'FAILED_ROLLED_BACK' ||
    failedReceipt.safeCode !== 'TARGET_BASELINE_DRIFT' ||
    failedReceipt.changedRelativePaths.length !== 0 ||
    !sourceChangeSetRow ||
    !sourceChangeSet ||
    sourceChangeSetRow.delivery_change_set_id !== sourceChangeSet.deliveryChangeSetId ||
    sourceChangeSetRow.batch_id !== sourceBatch.batch_id ||
    sourceChangeSetRow.flow_id !== sourceBatch.flow_id ||
    sourceChangeSetRow.version !== 1 ||
    sourceChangeSet.batchId !== sourceBatch.batch_id ||
    sourceChangeSet.flowId !== sourceBatch.flow_id ||
    sourceChangeSet.selectionDraftId !== sourceBatch.selection_draft_id ||
    sourceChangeSet.selectionDigest !== sourceBatch.selection_digest ||
    sourceChangeSetRow.digest !== sourceChangeSet.digest ||
    deliveryChangeSetDigestWithEvidence(sourceChangeSet, sourceChangeSet.evidenceArtifactIds) !== sourceChangeSet.digest ||
    sourceChangeSet.deliveryChangeSetId !== record.recoveryLineage.sourceDeliveryChangeSetId ||
    sourceChangeSet.digest !== record.recoveryLineage.sourceDeliveryChangeSetDigest ||
    sourceChangeSet.target.projectId !== address.projectId ||
    sourceChangeSet.target.initialTargetFingerprint !== sourceTargetFingerprint ||
    sourceBatch.target_fingerprint !== sourceTargetFingerprint ||
    sourceAttempt.target_fingerprint_before !== sourceTargetFingerprint ||
    record.recoveryLineage.sourceTargetFingerprint !== sourceTargetFingerprint ||
    record.recoveryLineage.sourceBatchId !== record.sourceBatchId ||
    !sourceDraft
  ) {
    throw deliveryStoreError('DELIVERY_RECOVERY_IDEMPOTENCY_CONFLICT')
  }

  const changeSetRow = db
    .prepare(
      'select delivery_change_set_id, batch_id, flow_id, version, selection_digest, task_change_set_ids_json, evidence_artifact_ids_json, qa_config_version, digest, change_set_json, created_at from delivery_change_sets where batch_id = ?',
    )
    .get(existing.batch_id) as
    | (DeliveryChangeSetRow & {
        selection_digest: Sha256Digest
        task_change_set_ids_json: string
        evidence_artifact_ids_json: string
        qa_config_version: string
      })
    | undefined
  const gate = db
    .prepare(
      'select gate_id, batch_id, delivery_change_set_id, subject_version, subject_digest, state, decision_digest, decided_at, gate_json, created_at from delivery_human_gates where batch_id = ?',
    )
    .get(existing.batch_id) as DeliveryGateRow | undefined
  const verification = db
    .prepare(
      'select delivery_verification_attempt_id, verification_request_id, batch_id, flow_id, request_digest, selection_digest, qa_config_version, state, started_at, finished_at, outcome_receipt_digest from delivery_verification_attempts where batch_id = ?',
    )
    .get(existing.batch_id) as DeliveryVerificationAttemptRow | undefined
  const outbox = verification
    ? (db
        .prepare(
          'select outbox_id, delivery_verification_attempt_id, request_digest, request_json, status, claim_owner_id, claim_digest, claimed_at, completed_at, created_at from delivery_verification_outbox where delivery_verification_attempt_id = ?',
        )
        .get(verification.delivery_verification_attempt_id) as DeliveryVerificationOutboxRow | undefined)
    : undefined
  const receiptRow = verification?.outcome_receipt_digest
    ? (db
        .prepare(
          'select receipt_digest, delivery_verification_attempt_id, request_digest, verdict, receipt_json, diagnostic_artifact_ids_json, created_at from delivery_verification_receipts where receipt_digest = ?',
        )
        .get(verification.outcome_receipt_digest) as
        | {
            receipt_digest: Sha256Digest
            delivery_verification_attempt_id: DeliveryVerificationAttemptId
            request_digest: Sha256Digest
            verdict: string
            receipt_json: string
            diagnostic_artifact_ids_json: string
            created_at: string
          }
        | undefined)
    : undefined
  const draft = db
    .prepare(
      'select draft_id, batch_id, flow_id, selected_task_run_ids_json, resolved_task_change_set_ids_json, dependency_task_run_ids_json, selection_digest, draft_json, created_at from delivery_selection_drafts where batch_id = ?',
    )
    .get(existing.batch_id) as DeliverySelectionDraftRow | undefined

  const request = parseDeliveryVerificationRequest(record.verificationRequestJson)
  validateDeliveryVerificationReceipt(record.receipt)
  const requestChangeSetDigest = deliveryChangeSetDigestWithEvidence(record.deliveryChangeSet, [])
  const finalTargetFingerprint = deliveryTargetFingerprintV1(record.deliveryChangeSet.target)
  const sourceDraftValue = JSON.parse(sourceDraft.draft_json) as DeliverySelectionDraftV1
  const expectedDraftBase = {
    ...sourceDraftValue,
    draftId: record.draftId,
    batchId: record.batchId,
    targetFingerprint: finalTargetFingerprint,
    createdAt: record.now as never,
  }
  const expectedDraft = { ...expectedDraftBase, digest: deliverySelectionDigestV1(expectedDraftBase) }
  const expectedGate: DeliveryHumanGateV1 = {
    gateId: record.gateId,
    batchId: record.batchId,
    subject: {
      deliveryChangeSetId: record.deliveryChangeSet.deliveryChangeSetId,
      version: 1,
      digest: record.deliveryChangeSet.digest,
    },
    state: 'OPEN',
    createdAt: record.now as never,
  }
  if (
    existing.batch_id !== record.batchId ||
    existing.project_id !== address.projectId ||
    existing.session_key !== address.sessionKey ||
    existing.flow_id !== sourceBatch.flow_id ||
    existing.selection_draft_id !== record.draftId ||
    existing.state !== 'READY_FOR_REVIEW' ||
    existing.selection_digest !== expectedDraft.digest ||
    existing.target_fingerprint !== finalTargetFingerprint ||
    existing.recovery_source_batch_id !== record.sourceBatchId ||
    existing.recovery_source_apply_attempt_id !== record.sourceFailedApplyAttemptId ||
    existing.created_at !== record.now ||
    existing.updated_at !== record.now ||
    request.verificationAttemptId !== record.verificationAttemptId ||
    request.batchId !== record.batchId ||
    request.flowId !== sourceBatch.flow_id ||
    request.requestDigest !== record.receipt.requestDigest ||
    request.deliveryChangeSetDigest !== requestChangeSetDigest ||
    request.selectionDigest !== record.receipt.selectionDigest ||
    request.selectionDigest !== record.deliveryChangeSet.selectionDigest ||
    request.targetFingerprint !== record.recoveryLineage.currentTargetFingerprint ||
    request.qaConfigVersion !== record.receipt.qaConfigVersion ||
    request.qaConfigVersion !== record.deliveryChangeSet.qaConfigVersion ||
    record.receipt.batchId !== record.batchId ||
    record.receipt.flowId !== sourceBatch.flow_id ||
    record.receipt.verificationAttemptId !== record.verificationAttemptId ||
    record.receipt.deliveryChangeSetId !== record.deliveryChangeSet.deliveryChangeSetId ||
    record.receipt.deliveryChangeSetDigest !== record.deliveryChangeSet.digest ||
    record.receipt.selectionDigest !== record.deliveryChangeSet.selectionDigest ||
    record.receipt.qaConfigVersion !== record.deliveryChangeSet.qaConfigVersion ||
    record.receipt.verdict !== 'PASS' ||
    record.deliveryChangeSet.selectionDraftId !== record.draftId ||
    !record.deliveryChangeSet.recoveryLineage ||
    !sameRecoveryLineage(record.deliveryChangeSet.recoveryLineage, record.recoveryLineage) ||
    !changeSetRow ||
    changeSetRow.delivery_change_set_id !== record.deliveryChangeSet.deliveryChangeSetId ||
    changeSetRow.batch_id !== record.batchId ||
    changeSetRow.flow_id !== sourceBatch.flow_id ||
    changeSetRow.version !== 1 ||
    changeSetRow.selection_digest !== record.deliveryChangeSet.selectionDigest ||
    changeSetRow.task_change_set_ids_json !== JSON.stringify(record.deliveryChangeSet.taskChangeSetIds) ||
    changeSetRow.qa_config_version !== record.deliveryChangeSet.qaConfigVersion ||
    changeSetRow.digest !== record.deliveryChangeSet.digest ||
    changeSetRow.change_set_json !== JSON.stringify(record.deliveryChangeSet) ||
    changeSetRow.evidence_artifact_ids_json !== JSON.stringify(record.deliveryChangeSet.evidenceArtifactIds) ||
    changeSetRow.created_at !== record.now ||
    !gate ||
    gate.gate_id !== record.gateId ||
    gate.batch_id !== record.batchId ||
    gate.delivery_change_set_id !== record.deliveryChangeSet.deliveryChangeSetId ||
    gate.subject_version !== 1 ||
    gate.subject_digest !== record.deliveryChangeSet.digest ||
    gate.state !== 'OPEN' ||
    gate.decision_digest !== null ||
    gate.decided_at !== null ||
    gate.gate_json !== JSON.stringify(expectedGate) ||
    gate.created_at !== record.now ||
    !verification ||
    verification.delivery_verification_attempt_id !== record.verificationAttemptId ||
    verification.verification_request_id !== request.verificationRequestId ||
    verification.batch_id !== record.batchId ||
    verification.flow_id !== sourceBatch.flow_id ||
    verification.request_digest !== request.requestDigest ||
    verification.selection_digest !== record.deliveryChangeSet.selectionDigest ||
    verification.qa_config_version !== request.qaConfigVersion ||
    verification.state !== 'SUCCEEDED' ||
    verification.outcome_receipt_digest !== record.receipt.receiptDigest ||
    verification.started_at !== record.now ||
    verification.finished_at !== record.now ||
    !outbox ||
    outbox.outbox_id !== `xhbdvo_${record.verificationAttemptId}` ||
    outbox.delivery_verification_attempt_id !== record.verificationAttemptId ||
    outbox.request_digest !== request.requestDigest ||
    outbox.request_json !== record.verificationRequestJson ||
    outbox.status !== 'DONE' ||
    outbox.claim_owner_id !== 'xiaogui-main-process-delivery' ||
    outbox.claim_digest !== `delivery.recovery.prepare:${record.verificationAttemptId}:${request.requestDigest}` ||
    outbox.claimed_at !== record.now ||
    outbox.completed_at !== record.now ||
    outbox.created_at !== record.now ||
    !receiptRow ||
    receiptRow.receipt_digest !== record.receipt.receiptDigest ||
    receiptRow.delivery_verification_attempt_id !== record.verificationAttemptId ||
    receiptRow.request_digest !== request.requestDigest ||
    receiptRow.verdict !== record.receipt.verdict ||
    receiptRow.receipt_json !== JSON.stringify(record.receipt) ||
    receiptRow.diagnostic_artifact_ids_json !== JSON.stringify(record.receipt.diagnosticArtifactIds) ||
    receiptRow.created_at !== record.now ||
    !draft ||
    draft.draft_id !== record.draftId ||
    draft.batch_id !== record.batchId ||
    draft.flow_id !== sourceBatch.flow_id ||
    draft.selection_digest !== record.deliveryChangeSet.selectionDigest ||
    draft.selected_task_run_ids_json !== JSON.stringify(expectedDraft.selectedTaskRunIds ?? []) ||
    draft.resolved_task_change_set_ids_json !== JSON.stringify(
      (expectedDraft.resolvedTaskChangeSets ?? []).map((item) => item.taskChangeSetId),
    ) ||
    draft.dependency_task_run_ids_json !== JSON.stringify(expectedDraft.dependencyTaskRunIds ?? []) ||
    draft.draft_json !== JSON.stringify(expectedDraft) ||
    draft.created_at !== record.now ||
    record.deliveryChangeSet.target.projectId !== address.projectId ||
    record.deliveryChangeSet.target.initialTargetFingerprint !== finalTargetFingerprint ||
    record.recoveryLineage.currentTargetFingerprint !== finalTargetFingerprint
  ) {
    throw deliveryStoreError('DELIVERY_RECOVERY_IDEMPOTENCY_CONFLICT')
  }
  validateDeliveryChangeSet({
    batch_id: existing.batch_id,
    project_id: address.projectId,
    session_key: address.sessionKey,
    flow_id: sourceBatch.flow_id,
    selection_draft_id: record.draftId,
    state: existing.state,
    selection_digest: record.deliveryChangeSet.selectionDigest,
    target_fingerprint: finalTargetFingerprint,
    recovery_source_batch_id: record.sourceBatchId,
    recovery_source_apply_attempt_id: record.sourceFailedApplyAttemptId,
    created_at: record.now,
    updated_at: record.now,
  }, record.receipt, record.deliveryChangeSet)
  assertDeliveryFileArtifactsMatch(record.deliveryChangeSet, record.deliveryFileArtifacts)
  assertDeliveryRecoveryArtifactsMatch(record)
  assertPersistedArtifactsMatch(db, [
    ...record.deliveryFileArtifacts,
    ...(record.evidenceArtifacts ?? []),
    ...(record.diagnosticArtifacts ?? []),
  ])
}

function sameRecoveryLineage(left: DeliveryRecoveryLineageV1, right: DeliveryRecoveryLineageV1): boolean {
  return (
    left.sourceBatchId === right.sourceBatchId &&
    left.sourceDeliveryChangeSetId === right.sourceDeliveryChangeSetId &&
    left.sourceDeliveryChangeSetDigest === right.sourceDeliveryChangeSetDigest &&
    left.sourceTargetFingerprint === right.sourceTargetFingerprint &&
    left.currentTargetFingerprint === right.currentTargetFingerprint
  )
}

function assertDeliveryFileArtifactsMatch(
  changeSet: DeliveryChangeSetV1,
  artifacts: readonly DeliveryFileArtifactWriteV1[],
): void {
  const files = changeSet.fileChanges ?? []
  if (files.length !== artifacts.length) throw deliveryStoreError('DELIVERY_ARTIFACT_INVALID')
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]))
  if (artifactsById.size !== artifacts.length) throw deliveryStoreError('DELIVERY_ARTIFACT_INVALID')
  for (const file of files) {
    const artifact = artifactsById.get(file.contentArtifactId)
    if (
      !artifact ||
      artifact.kind !== 'DELIVERY_FILE_CONTENT' ||
      artifact.contentDigest !== file.contentDigest ||
      artifact.contentDigest !== digestBytes(artifact.content)
    ) {
      throw deliveryStoreError('DELIVERY_ARTIFACT_INVALID')
    }
  }
}

function assertPersistedArtifactsMatch(db: DatabaseSync, artifacts: readonly TaskArtifactWriteV1[]): void {
  for (const artifact of artifacts) {
    const row = db
      .prepare('select kind, media_type, content_digest, content from artifacts where artifact_id = ?')
      .get(artifact.artifactId) as
      | { kind: string; media_type: string; content_digest: string; content: Uint8Array }
      | undefined
    if (!row || !artifactMatches(row, artifact)) throw deliveryStoreError('DELIVERY_ARTIFACT_INVALID')
  }
}

function deliveryVerificationStateForVerdict(verdict: DeliveryVerificationReceiptV1['verdict']): string {
  if (verdict === 'PASS') return 'SUCCEEDED'
  if (verdict === 'FAIL') return 'FAILED'
  return 'OUTCOME_UNKNOWN'
}

function parseTaskVerificationRequest(value: string): TaskVerificationRequestV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw verificationStoreError('TASK_VERIFICATION_REQUEST_INVALID')
  }
  if (
    !isRecord(parsed) ||
    parsed.scope !== 'TASK' ||
    typeof parsed.verificationAttemptId !== 'string' ||
    typeof parsed.verificationRequestId !== 'string' ||
    typeof parsed.flowId !== 'string' ||
    typeof parsed.taskRunId !== 'string' ||
    typeof parsed.attemptId !== 'string' ||
    typeof parsed.candidateId !== 'string' ||
    typeof parsed.requestDigest !== 'string' ||
    typeof parsed.changeSetDigest !== 'string' ||
    typeof parsed.preparedTreeHash !== 'string' ||
    typeof parsed.qaConfigVersion !== 'string' ||
    !Array.isArray(parsed.acceptanceCriteria) ||
    parsed.acceptanceCriteria.some((item) => typeof item !== 'string')
  ) {
    throw verificationStoreError('TASK_VERIFICATION_REQUEST_INVALID')
  }
  return parsed as unknown as TaskVerificationRequestV1
}

function validateTaskVerificationBegin(
  db: DatabaseSync,
  record: BeginTaskVerificationRecordV1,
  request: TaskVerificationRequestV1,
): void {
  const candidate = record.candidate
  const verificationAttempt = record.verificationAttempt
  if (record.patchArtifact.kind !== 'PATCH' || record.patchArtifact.artifactId !== candidate.patchArtifactId) {
    throw verificationStoreError('TASK_VERIFICATION_ARTIFACT_BINDING_MISMATCH')
  }
  assertArtifactDigest(record.patchArtifact)
  if (candidate.kind !== 'TASK_CANDIDATE' || taskCandidateDigestV1(candidate) !== candidate.candidateDigest) {
    throw verificationStoreError('TASK_VERIFICATION_CANDIDATE_DIGEST_MISMATCH')
  }
  const authoritativeDigestFields = taskChangeSetDigestFieldsForCandidate(db, candidate)
  if (
    !sameStringArray(record.ancestorTaskChangeSetIds, authoritativeDigestFields.ancestorTaskChangeSetIds) ||
    taskChangeSetDigestV1(authoritativeDigestFields) !== candidate.proposedChangeSetDigest
  ) {
    throw verificationStoreError('TASK_VERIFICATION_CHANGESET_DIGEST_MISMATCH')
  }
  if (
    verificationAttempt.scope !== 'TASK' ||
    verificationAttempt.state !== 'STARTED' ||
    verificationAttempt.flowId !== candidate.flowId ||
    verificationAttempt.taskRunId !== candidate.taskRunId ||
    verificationAttempt.attemptId !== candidate.attemptId ||
    verificationAttempt.candidateId !== candidate.candidateId ||
    request.verificationAttemptId !== verificationAttempt.verificationAttemptId ||
    request.verificationRequestId !== verificationAttempt.verificationRequestId ||
    request.flowId !== candidate.flowId ||
    request.taskRunId !== candidate.taskRunId ||
    request.attemptId !== candidate.attemptId ||
    request.candidateId !== candidate.candidateId ||
    request.changeSetDigest !== candidate.proposedChangeSetDigest ||
    request.preparedTreeHash !== candidate.resultTreeHash ||
    request.requestDigest !== verificationAttempt.requestDigest ||
    verificationRequestDigestV1(request) !== request.requestDigest
  ) {
    throw verificationStoreError('TASK_VERIFICATION_BINDING_MISMATCH')
  }
}

function taskChangeSetDigestFieldsForCandidate(
  db: DatabaseSync,
  candidate: ChangeSetCandidateV1,
): TaskChangeSetDigestFieldsV1 {
  return {
    inputTreeHash: candidate.inputTreeHash,
    resultTreeHash: candidate.resultTreeHash,
    ancestorTaskChangeSetIds: taskChangeSetAncestorIdsForTask(db, candidate.flowId, candidate.taskRunId),
    patchArtifactId: candidate.patchArtifactId,
  }
}

function taskChangeSetAncestorIdsForTask(
  db: DatabaseSync,
  flowId: FlowId,
  taskRunId: TaskRunId,
): readonly TaskChangeSetId[] {
  const specs = db
    .prepare('select task_key, depends_json from task_specs where flow_id = ?')
    .all(flowId) as unknown as Array<{ task_key: string; depends_json: string }>
  const dependencies = new Map(
    specs.map((spec) => {
      const parsed = JSON.parse(spec.depends_json) as unknown
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
        throw verificationStoreError('TASK_VERIFICATION_DEPENDENCY_BINDING_INVALID')
      }
      return [spec.task_key, [...parsed].sort()] as const
    }),
  )
  const current = db
    .prepare('select task_key from task_runs where task_run_id = ? and flow_id = ?')
    .get(taskRunId, flowId) as { task_key: string } | undefined
  if (!current || !dependencies.has(current.task_key)) {
    throw verificationStoreError('TASK_VERIFICATION_DEPENDENCY_BINDING_INVALID')
  }
  const changeSets = db
    .prepare(
      'select tr.task_key, tr.status, tcs.task_change_set_id from task_runs tr left join task_change_sets tcs on tcs.task_run_id = tr.task_run_id where tr.flow_id = ?',
    )
    .all(flowId) as unknown as Array<{
    task_key: string
    status: string
    task_change_set_id: string | null
  }>
  const changeSetByTask = new Map(changeSets.map((row) => [row.task_key, row] as const))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const ancestorTaskChangeSetIds: string[] = []

  const visit = (taskKey: string): void => {
    if (visited.has(taskKey)) return
    if (visiting.has(taskKey)) throw verificationStoreError('TASK_VERIFICATION_DEPENDENCY_BINDING_INVALID')
    const taskDependencies = dependencies.get(taskKey)
    if (!taskDependencies) throw verificationStoreError('TASK_VERIFICATION_DEPENDENCY_BINDING_INVALID')
    visiting.add(taskKey)
    for (const dependency of taskDependencies) visit(dependency)
    visiting.delete(taskKey)
    visited.add(taskKey)
    if (taskKey !== current.task_key) {
      const changeSet = changeSetByTask.get(taskKey)
      if (
        !changeSet ||
        !changeSet.task_change_set_id ||
        !['VERIFIED', 'DELIVERY_PENDING', 'APPLYING', 'DONE'].includes(changeSet.status)
      ) {
        throw verificationStoreError('TASK_VERIFICATION_DEPENDENCY_CHANGESET_MISSING')
      }
      ancestorTaskChangeSetIds.push(changeSet.task_change_set_id)
    }
  }
  for (const dependency of dependencies.get(current.task_key) ?? []) visit(dependency)
  return ancestorTaskChangeSetIds as unknown as readonly TaskChangeSetId[]
}

function assertBeginReplay(
  db: DatabaseSync,
  address: HubAddressV1,
  persisted: VerificationAttemptRecord,
  record: BeginTaskVerificationRecordV1,
  request: TaskVerificationRequestV1,
): void {
  const candidate = db
    .prepare(
      'select candidate_id, flow_id, task_run_id, attempt_id, patch_artifact_id, candidate_digest, proposed_change_set_digest from change_set_candidates where attempt_id = ?',
    )
    .get(record.candidate.attemptId) as
    | {
        candidate_id: string
        flow_id: string
        task_run_id: string
        attempt_id: string
        patch_artifact_id: string
        candidate_digest: string
        proposed_change_set_digest: string
      }
    | undefined
  const audit = db
    .prepare(
      'select attempt_id, runtime_session_id, receipt_digest, candidate_digest from agent_succeeded_audits where audit_id = ?',
    )
    .get(`xhbsucc_${record.verificationAttempt.verificationRequestId}`) as
    | { attempt_id: string; runtime_session_id: string; receipt_digest: string; candidate_digest: string }
    | undefined
  const outbox = db
    .prepare('select outbox_id, request_digest from verification_outbox where verification_attempt_id = ?')
    .get(persisted.verification_attempt_id) as { outbox_id: string; request_digest: string } | undefined
  const artifact = db
    .prepare('select kind, media_type, content_digest, content from artifacts where artifact_id = ?')
    .get(record.patchArtifact.artifactId) as
    | { kind: string; media_type: string; content_digest: string; content: Uint8Array }
    | undefined
  const reconcile = db
    .prepare(
      'select reconcile_id, runtime_session_id, outcome, receipt_digest, expected_receipt_digest from agent_reconcile_results where attempt_id = ?',
    )
    .get(record.candidate.attemptId) as
    | {
        reconcile_id: string
        runtime_session_id: string
        outcome: string
        receipt_digest: string
        expected_receipt_digest: string | null
      }
    | undefined
  const reconcileIdempotency = record.reconcileStart
    ? (db
        .prepare(
          'select command_type, payload_hash, receipt_json from idempotency_keys where scope_key = ? and request_id = ?',
        )
        .get(scopeKey(address), record.reconcileStart.idempotency.requestId) as IdempotencyRecord | undefined)
    : undefined
  let reconcileReceipt: PerformReceiptV1 | undefined
  try {
    reconcileReceipt = reconcileIdempotency
      ? (JSON.parse(reconcileIdempotency.receipt_json) as PerformReceiptV1)
      : undefined
  } catch {
    throw verificationStoreError('TASK_VERIFICATION_IDEMPOTENCY_CONFLICT')
  }
  const reconcileMatches = record.reconcileStart
    ? Boolean(
        reconcile &&
          reconcile.reconcile_id === `xhbrecon_${record.reconcileStart.receipt.requestId}` &&
          reconcile.runtime_session_id === record.reconcileStart.runtimeSessionId &&
          reconcile.outcome === 'SUCCEEDED' &&
          reconcile.receipt_digest === record.reconcileStart.receiptDigest &&
          (reconcile.expected_receipt_digest ?? undefined) === record.reconcileStart.expectedReceiptDigest &&
          reconcileIdempotency &&
          reconcileIdempotency.command_type === record.reconcileStart.idempotency.commandType &&
          reconcileIdempotency.payload_hash === record.reconcileStart.idempotency.payloadHash &&
          reconcileReceipt?.requestId === record.reconcileStart.receipt.requestId &&
          reconcileReceipt.intentType === record.reconcileStart.receipt.intentType &&
          reconcileReceipt.attemptId === record.reconcileStart.receipt.attemptId,
      )
    : !reconcile
  if (
    persisted.verification_attempt_id !== record.verificationAttempt.verificationAttemptId ||
    persisted.verification_request_id !== record.verificationAttempt.verificationRequestId ||
    persisted.flow_id !== record.candidate.flowId ||
    persisted.task_run_id !== record.candidate.taskRunId ||
    persisted.candidate_id !== record.candidate.candidateId ||
    persisted.request_digest !== request.requestDigest ||
    persisted.change_set_digest !== request.changeSetDigest ||
    persisted.qa_config_version !== request.qaConfigVersion ||
    !candidate ||
    candidate.candidate_id !== record.candidate.candidateId ||
    candidate.flow_id !== record.candidate.flowId ||
    candidate.task_run_id !== record.candidate.taskRunId ||
    candidate.attempt_id !== record.candidate.attemptId ||
    candidate.patch_artifact_id !== record.candidate.patchArtifactId ||
    candidate.candidate_digest !== record.candidate.candidateDigest ||
    candidate.proposed_change_set_digest !== record.candidate.proposedChangeSetDigest ||
    !audit ||
    audit.attempt_id !== record.succeededAudit.attemptId ||
    audit.runtime_session_id !== record.succeededAudit.runtimeSessionId ||
    audit.receipt_digest !== record.succeededAudit.receiptDigest ||
    audit.candidate_digest !== record.succeededAudit.candidateDigest ||
    !outbox ||
    outbox.outbox_id !== `xhbvo_${persisted.verification_attempt_id}` ||
    outbox.request_digest !== request.requestDigest ||
    !artifact ||
    !artifactMatches(artifact, record.patchArtifact) ||
    !reconcileMatches
  ) {
    throw verificationStoreError('TASK_VERIFICATION_IDEMPOTENCY_CONFLICT')
  }
}

function validateVerificationReceiptDigest(receipt: TaskVerificationReceiptV1): void {
  if (receipt.scope !== 'TASK' || verificationReceiptDigestV1(receipt) !== receipt.receiptDigest) {
    throw verificationStoreError('TASK_VERIFICATION_RECEIPT_DIGEST_MISMATCH')
  }
}

function validateVerificationReceiptBinding(
  persisted: VerificationAttemptRecord,
  receipt: TaskVerificationReceiptV1,
): void {
  if (
    receipt.scope !== 'TASK' ||
    receipt.verificationAttemptId !== persisted.verification_attempt_id ||
    receipt.verificationRequestId !== persisted.verification_request_id ||
    receipt.flowId !== persisted.flow_id ||
    receipt.taskRunId !== persisted.task_run_id ||
    receipt.attemptId !== persisted.attempt_id ||
    receipt.candidateId !== persisted.candidate_id ||
    receipt.requestDigest !== persisted.request_digest ||
    receipt.changeSetDigest !== persisted.change_set_digest ||
    receipt.qaConfigVersion !== persisted.qa_config_version
  ) {
    throw verificationStoreError('TASK_VERIFICATION_BINDING_MISMATCH')
  }
}

function validateCompletionArtifacts(record: CompleteTaskVerificationRecordV1): void {
  if (
    record.receipt.verdict === 'PASS' &&
    (!Array.isArray(record.receipt.checks) ||
      record.receipt.checks.some((check) => check.verdict !== 'PASS') ||
      'failure' in record.receipt ||
      'reason' in record.receipt)
  ) {
    throw verificationStoreError('TASK_VERIFICATION_RECEIPT_SHAPE_INVALID')
  }
  if (
    record.receipt.verdict === 'FAIL' &&
    (!Array.isArray(record.receipt.checks) ||
      record.receipt.checks.length === 0 ||
      record.receipt.checks[0]?.verdict !== 'FAIL' ||
      !isRecord(record.receipt.failure) ||
      typeof record.receipt.reason !== 'string' ||
      record.receipt.reason.length === 0)
  ) {
    throw verificationStoreError('TASK_VERIFICATION_RECEIPT_SHAPE_INVALID')
  }
  if (
    record.receipt.verdict === 'OUTCOME_UNKNOWN' &&
    ('checks' in record.receipt ||
      'evidenceArtifactIds' in record.receipt ||
      'failure' in record.receipt ||
      typeof record.receipt.reason !== 'string' ||
      record.receipt.reason.length === 0)
  ) {
    throw verificationStoreError('TASK_VERIFICATION_RECEIPT_SHAPE_INVALID')
  }
  const evidenceArtifacts = record.evidenceArtifacts ?? []
  const diagnosticArtifacts = record.diagnosticArtifacts ?? []
  const all = [...evidenceArtifacts, ...diagnosticArtifacts]
  const allIds = all.map((artifact) => artifact.artifactId)
  if (new Set(allIds).size !== allIds.length) {
    throw verificationStoreError('TASK_VERIFICATION_ARTIFACT_BINDING_MISMATCH')
  }
  for (const artifact of evidenceArtifacts) {
    if (artifact.kind !== 'VERIFICATION_EVIDENCE') {
      throw verificationStoreError('TASK_VERIFICATION_ARTIFACT_BINDING_MISMATCH')
    }
    assertArtifactDigest(artifact)
  }
  for (const artifact of diagnosticArtifacts) {
    if (artifact.kind !== 'VERIFICATION_DIAGNOSTIC') {
      throw verificationStoreError('TASK_VERIFICATION_ARTIFACT_BINDING_MISMATCH')
    }
    assertArtifactDigest(artifact)
  }
  if (!sameStringArray(diagnosticArtifacts.map((artifact) => artifact.artifactId), record.receipt.diagnosticArtifactIds)) {
    throw verificationStoreError('TASK_VERIFICATION_ARTIFACT_BINDING_MISMATCH')
  }

  if (record.receipt.verdict === 'PASS' || record.receipt.verdict === 'FAIL') {
    if (!sameStringArray(evidenceArtifacts.map((artifact) => artifact.artifactId), record.receipt.evidenceArtifactIds)) {
      throw verificationStoreError('TASK_VERIFICATION_ARTIFACT_BINDING_MISMATCH')
    }
    const allowedIds = new Set(allIds)
    if (record.receipt.checks.some((check) => check.artifactIds.some((artifactId) => !allowedIds.has(artifactId)))) {
      throw verificationStoreError('TASK_VERIFICATION_ARTIFACT_BINDING_MISMATCH')
    }
  } else if (evidenceArtifacts.length !== 0) {
    throw verificationStoreError('TASK_VERIFICATION_ARTIFACT_BINDING_MISMATCH')
  }

  if (record.receipt.verdict === 'PASS') {
    if (!record.evidenceBundle || !record.qaResult || !record.taskChangeSet) {
      throw verificationStoreError('TASK_VERIFICATION_PASS_OBJECTS_REQUIRED')
    }
  } else if (record.evidenceBundle || record.qaResult || record.taskChangeSet) {
    throw verificationStoreError('TASK_VERIFICATION_UNSEALED_OBJECTS_FORBIDDEN')
  }
}

function sealPassedTaskVerification(
  db: DatabaseSync,
  persisted: VerificationAttemptRecord,
  candidate: ChangeSetCandidateV1,
  record: CompleteTaskVerificationRecordV1,
): void {
  const receipt = record.receipt
  const evidence = record.evidenceBundle
  const qa = record.qaResult
  const changeSet = record.taskChangeSet
  if (receipt.verdict !== 'PASS' || !evidence || !qa || !changeSet) {
    throw verificationStoreError('TASK_VERIFICATION_PASS_OBJECTS_REQUIRED')
  }
  if (receipt.checks.some((check) => check.verdict !== 'PASS')) {
    throw verificationStoreError('TASK_VERIFICATION_PASS_CHECKS_INVALID')
  }
  if (
    evidence.scope !== 'TASK' ||
    evidence.verificationAttemptId !== persisted.verification_attempt_id ||
    evidence.flowId !== persisted.flow_id ||
    evidence.taskRunId !== persisted.task_run_id ||
    evidence.attemptId !== persisted.attempt_id ||
    evidence.changeSetDigest !== persisted.change_set_digest ||
    evidence.qaConfigVersion !== persisted.qa_config_version ||
    !sameStringArray(evidence.artifactIds, receipt.evidenceArtifactIds) ||
    taskEvidenceBundleDigestV1(evidence) !== evidence.bundleDigest
  ) {
    throw verificationStoreError('TASK_VERIFICATION_EVIDENCE_BINDING_MISMATCH')
  }
  if (
    qa.scope !== 'TASK' ||
    qa.verdict !== 'PASS' ||
    qa.verificationAttemptId !== persisted.verification_attempt_id ||
    qa.flowId !== persisted.flow_id ||
    qa.taskRunId !== persisted.task_run_id ||
    qa.attemptId !== persisted.attempt_id ||
    qa.candidateId !== persisted.candidate_id ||
    qa.changeSetDigest !== persisted.change_set_digest ||
    qa.qaConfigVersion !== persisted.qa_config_version ||
    JSON.stringify(qa.checks) !== JSON.stringify(receipt.checks) ||
    qa.checks.some((check) => check.verdict !== 'PASS') ||
    taskQaResultDigestV1(qa) !== qa.resultDigest
  ) {
    throw verificationStoreError('TASK_VERIFICATION_QA_BINDING_MISMATCH')
  }
  const flow = db
    .prepare('select active_revision_id from flows where flow_id = ?')
    .get(persisted.flow_id) as { active_revision_id: string | null } | undefined
  const authoritativeDigestFields = taskChangeSetDigestFieldsForCandidate(db, candidate)
  if (
    changeSet.kind !== 'TASK' ||
    changeSet.version !== 1 ||
    changeSet.flowId !== persisted.flow_id ||
    changeSet.planRevisionId !== flow?.active_revision_id ||
    changeSet.taskRunId !== persisted.task_run_id ||
    changeSet.attemptId !== persisted.attempt_id ||
    changeSet.verificationAttemptId !== persisted.verification_attempt_id ||
    changeSet.candidateId !== persisted.candidate_id ||
    changeSet.inputTreeHash !== candidate.inputTreeHash ||
    changeSet.resultTreeHash !== candidate.resultTreeHash ||
    changeSet.patchArtifactId !== candidate.patchArtifactId ||
    changeSet.evidenceBundleId !== evidence.evidenceBundleId ||
    changeSet.qaResultId !== qa.qaResultId ||
    changeSet.qaConfigVersion !== persisted.qa_config_version ||
    changeSet.digest !== persisted.change_set_digest ||
    taskChangeSetDigestV1(changeSet) !== changeSet.digest ||
    !sameStringArray(changeSet.ancestorTaskChangeSetIds, authoritativeDigestFields.ancestorTaskChangeSetIds) ||
    new Set(changeSet.ancestorTaskChangeSetIds).size !== changeSet.ancestorTaskChangeSetIds.length ||
    changeSet.ancestorTaskChangeSetIds.includes(changeSet.taskChangeSetId)
  ) {
    throw verificationStoreError('TASK_VERIFICATION_CHANGESET_BINDING_MISMATCH')
  }
  for (const ancestorId of changeSet.ancestorTaskChangeSetIds) {
    const ancestor = db
      .prepare('select flow_id from task_change_sets where task_change_set_id = ?')
      .get(ancestorId) as { flow_id: string } | undefined
    if (!ancestor || ancestor.flow_id !== persisted.flow_id) {
      throw verificationStoreError('TASK_VERIFICATION_CHANGESET_ANCESTOR_MISMATCH')
    }
  }

  db.prepare(
    'insert into task_evidence_bundles (evidence_bundle_id, verification_attempt_id, flow_id, task_run_id, attempt_id, change_set_digest, qa_config_version, artifact_ids_json, bundle_digest, bundle_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    evidence.evidenceBundleId,
    evidence.verificationAttemptId,
    evidence.flowId,
    evidence.taskRunId,
    evidence.attemptId,
    evidence.changeSetDigest,
    evidence.qaConfigVersion,
    JSON.stringify(evidence.artifactIds),
    evidence.bundleDigest,
    JSON.stringify(evidence),
    record.now,
  )
  db.prepare(
    'insert into task_qa_results (qa_result_id, verification_attempt_id, flow_id, task_run_id, attempt_id, candidate_id, change_set_digest, qa_config_version, verdict, checks_json, result_digest, result_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    qa.qaResultId,
    qa.verificationAttemptId,
    qa.flowId,
    qa.taskRunId,
    qa.attemptId,
    qa.candidateId,
    qa.changeSetDigest,
    qa.qaConfigVersion,
    qa.verdict,
    JSON.stringify(qa.checks),
    qa.resultDigest,
    JSON.stringify(qa),
    record.now,
  )
  db.prepare(
    'insert into task_change_sets (task_change_set_id, version, flow_id, plan_revision_id, task_run_id, attempt_id, verification_attempt_id, candidate_id, input_tree_hash, result_tree_hash, ancestor_task_change_set_ids_json, patch_artifact_id, evidence_bundle_id, qa_result_id, qa_config_version, digest, change_set_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    changeSet.taskChangeSetId,
    changeSet.version,
    changeSet.flowId,
    changeSet.planRevisionId,
    changeSet.taskRunId,
    changeSet.attemptId,
    changeSet.verificationAttemptId,
    changeSet.candidateId,
    changeSet.inputTreeHash,
    changeSet.resultTreeHash,
    JSON.stringify(changeSet.ancestorTaskChangeSetIds),
    changeSet.patchArtifactId,
    changeSet.evidenceBundleId,
    changeSet.qaResultId,
    changeSet.qaConfigVersion,
    changeSet.digest,
    JSON.stringify(changeSet),
    changeSet.createdAt,
  )
  finishTaskVerificationRows(db, persisted, 'SUCCEEDED', 'SUCCEEDED', 'VERIFIED', receipt.receiptDigest, record.now)
}

function finishUnsealedTaskVerification(
  db: DatabaseSync,
  persisted: VerificationAttemptRecord,
  state: 'FAILED' | 'OUTCOME_UNKNOWN',
  receiptDigest: string,
  now: string,
): void {
  finishTaskVerificationRows(db, persisted, state, state, state, receiptDigest, now)
}

function finishTaskVerificationRows(
  db: DatabaseSync,
  persisted: VerificationAttemptRecord,
  verificationState: 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN',
  attemptState: 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN',
  taskState: 'VERIFIED' | 'FAILED' | 'OUTCOME_UNKNOWN',
  receiptDigest: string,
  now: string,
): void {
  const verificationUpdated = db
    .prepare(
      "update verification_attempts set state = ?, finished_at = ?, outcome_receipt_digest = ? where verification_attempt_id = ? and state = 'STARTED'",
    )
    .run(verificationState, now, receiptDigest, persisted.verification_attempt_id)
  const attemptUpdated = db
    .prepare("update attempts set status = ?, updated_at = ? where attempt_id = ? and status = 'VERIFYING'")
    .run(attemptState, now, persisted.attempt_id)
  const taskUpdated = db
    .prepare("update task_runs set status = ? where task_run_id = ? and status = 'VERIFYING'")
    .run(taskState, persisted.task_run_id)
  if (verificationUpdated.changes !== 1 || attemptUpdated.changes !== 1 || taskUpdated.changes !== 1) {
    throw verificationStoreError('TASK_VERIFICATION_ILLEGAL_TRANSITION')
  }
}

function verificationStateForVerdict(verdict: TaskVerificationReceiptV1['verdict']): string {
  if (verdict === 'PASS') return 'SUCCEEDED'
  if (verdict === 'FAIL') return 'FAILED'
  if (verdict === 'OUTCOME_UNKNOWN') return 'OUTCOME_UNKNOWN'
  return 'CANCELLED'
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function readArtifactRefs(db: DatabaseSync, artifactIds: readonly ArtifactId[]): TaskArtifactRefV1[] {
  return artifactIds.map((artifactId) => {
    const row = db
      .prepare('select artifact_id, kind, content_digest from artifacts where artifact_id = ?')
      .get(artifactId) as { artifact_id: string; kind: string; content_digest: string } | undefined
    if (!row) throw verificationStoreError('TASK_VERIFICATION_PROJECTION_INCONSISTENT')
    const kind =
      row.kind === 'PATCH'
        ? 'PATCH'
        : row.kind === 'VERIFICATION_EVIDENCE'
          ? 'QA_EVIDENCE'
          : row.kind === 'VERIFICATION_DIAGNOSTIC'
            ? 'QA_DIAGNOSTIC'
            : null
    if (!kind) throw verificationStoreError('TASK_VERIFICATION_PROJECTION_INCONSISTENT')
    return {
      artifactId: row.artifact_id as ArtifactId,
      digest: row.content_digest as Sha256Digest,
      kind,
    }
  })
}

function assertArtifactDigest(artifact: TaskArtifactWriteV1): void {
  if (artifact.contentDigest !== digestBytes(artifact.content)) {
    throw verificationStoreError('TASK_VERIFICATION_ARTIFACT_DIGEST_MISMATCH')
  }
}

function assertArtifactIdAvailable(db: DatabaseSync, artifact: TaskArtifactWriteV1): void {
  const existing = db
    .prepare('select kind, media_type, content_digest, content from artifacts where artifact_id = ?')
    .get(artifact.artifactId) as
    | { kind: string; media_type: string; content_digest: string; content: Uint8Array }
    | undefined
  if (existing) throw verificationStoreError('TASK_VERIFICATION_IMMUTABLE_ID_CONFLICT')
}

function assertCandidateIdAvailable(db: DatabaseSync, candidate: ChangeSetCandidateV1): void {
  const existing = db.prepare('select 1 as value from change_set_candidates where candidate_id = ? or candidate_digest = ?').get(
    candidate.candidateId,
    candidate.candidateDigest,
  )
  if (existing) throw verificationStoreError('TASK_VERIFICATION_IMMUTABLE_ID_CONFLICT')
}

function assertVerificationAttemptIdAvailable(db: DatabaseSync, verificationAttemptId: string): void {
  const existing = db.prepare('select 1 as value from verification_attempts where verification_attempt_id = ?').get(
    verificationAttemptId,
  )
  if (existing) throw verificationStoreError('TASK_VERIFICATION_IMMUTABLE_ID_CONFLICT')
}

function insertArtifact(db: DatabaseSync, artifact: TaskArtifactWriteV1, now: string): void {
  assertArtifactDigest(artifact)
  db.prepare(
    'insert into artifacts (artifact_id, kind, media_type, content_digest, content, created_at) values (?, ?, ?, ?, ?, ?)',
  ).run(
    artifact.artifactId,
    artifact.kind,
    artifact.mediaType,
    artifact.contentDigest,
    Buffer.from(artifact.content),
    now,
  )
}

function artifactMatches(
  persisted: { kind: string; media_type: string; content_digest: string; content: Uint8Array },
  artifact: TaskArtifactWriteV1,
): boolean {
  return (
    persisted.kind === artifact.kind &&
    persisted.media_type === artifact.mediaType &&
    persisted.content_digest === artifact.contentDigest &&
    Buffer.from(persisted.content).equals(Buffer.from(artifact.content))
  )
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function verificationStoreError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

function deliveryStoreError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flowBaselineMatchesScheduleRecord(baseline: FlowExecutionBaselineRecord, record: ScheduleRecordM2BV1): boolean {
  return (
    baseline.flow_id === record.flowId &&
    baseline.baseline_id === record.baselineId &&
    (baseline.base_revision ?? null) === (record.baseRevision ?? null) &&
    baseline.baseline_tree_hash === record.baselineTreeHash &&
    baseline.initial_target_fingerprint === record.initialTargetFingerprint &&
    baseline.baseline_digest === record.baselineDigest &&
    baseline.baseline_binding_digest === record.flowBaselineBindingDigest
  )
}

function toM2BTaskRunStatus(status: string): TaskRunProjectionM2BV1['status'] {
  if (status === 'PENDING_DISABLED') return 'BLOCKED'
  if (
    [
      'BLOCKED',
      'DEPENDENCY_ELIGIBLE',
      'READY',
      'RUNNING',
      'VERIFYING',
      'FAILED',
      'VERIFIED',
      'DELIVERY_PENDING',
      'APPLYING',
      'CANCEL_REQUESTED',
      'DONE',
      'INTERRUPT_REQUESTED',
      'OUTCOME_UNKNOWN',
      'CANCELLED',
      'INVALIDATED',
      'SUPERSEDED',
    ].includes(status)
  ) {
    return status as TaskRunProjectionM2BV1['status']
  }
  return 'BLOCKED'
}
