import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

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
  WorkspacePreparedReceiptM2BV1,
  WorkspaceReceiptBindingM2BV1,
  WorkspaceReceiptId,
} from '@shared/xiaogui-collaboration-hub'
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
  taskRunId: TaskRunId
  attemptId: AttemptId
  attemptDigest: string
  compositionDigest: string
  baselineBindingDigest: string
  baselineId: string
  baseRevision?: string
  baselineTreeHash: string
  initialTargetFingerprint: string
  baselineDigest: string
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
  kind: 'PATCH' | 'VERIFICATION_EVIDENCE' | 'VERIFICATION_DIAGNOSTIC'
  mediaType: string
  content: Uint8Array
}

export interface BeginTaskVerificationRecordV1 {
  patchArtifact: TaskArtifactWriteV1
  candidate: ChangeSetCandidateV1
  ancestorTaskChangeSetIds: readonly TaskChangeSetId[]
  succeededAudit: AgentSucceededAuditV1
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
        return {
          attemptId: attempt.attempt_id,
          taskRunId: attempt.task_run_id,
          status: attempt.status as AttemptProjectionM2BV1['status'],
          ...(attempt.runtime_session_id ? { runtimeSessionId: attempt.runtime_session_id } : {}),
          ...(attempt.workspace_receipt_id ? { workspaceReceiptId: attempt.workspace_receipt_id } : {}),
          ...(verificationSummary ? { verificationSummary } : {}),
        }
      }),
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
        "select count(*) as count from attempts where status in ('CREATED', 'WORKSPACE_PREPARING', 'READY', 'STARTING', 'RUNNING', 'VERIFYING', 'INTERRUPT_REQUESTED', 'OUTCOME_UNKNOWN')",
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

  writeSchedule(address: HubAddressV1, idempotency: IdempotencyInput, record: ScheduleRecordM2BV1): void {
    this.transaction(() => {
      const version = this.currentVersion(address) + 1
      const projection = { ...record.projection, sessionVersion: version }
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
        record.baselineBindingDigest,
        record.now,
      )
      const persistedBaseline = this.flowExecutionBaseline(record.flowId)
      if (!persistedBaseline || !flowBaselineMatchesScheduleRecord(persistedBaseline, record)) {
        throw Object.assign(new Error('BASELINE_CONFLICT'), { code: 'BASELINE_CONFLICT' })
      }
      this.db
        .prepare("update task_runs set status = 'READY', unavailable_reason = 'M2B1_SCHEDULED' where task_run_id = ?")
        .run(record.taskRunId)
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
          'select attempt_id, project_id, session_key, flow_id, task_run_id, status, runtime_session_id from attempts where attempt_id = ?',
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
        assertBeginReplay(this.db, persisted, record, request)
        return {
          verificationAttemptId: persisted.verification_attempt_id,
          outboxId: `xhbvo_${persisted.verification_attempt_id}`,
          replayed: true,
        }
      }
      if (attempt.status !== 'RUNNING' || taskRun.status !== 'RUNNING') {
        throw verificationStoreError('TASK_VERIFICATION_ILLEGAL_TRANSITION')
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
          "update attempts set status = 'VERIFYING', outcome_receipt_digest = ?, updated_at = ? where attempt_id = ? and status = 'RUNNING'",
        )
        .run(record.succeededAudit.receiptDigest, record.now, record.candidate.attemptId)
      const taskUpdated = this.db
        .prepare("update task_runs set status = 'VERIFYING' where task_run_id = ? and status = 'RUNNING'")
        .run(record.candidate.taskRunId)
      if (attemptUpdated.changes !== 1 || taskUpdated.changes !== 1) {
        throw verificationStoreError('TASK_VERIFICATION_ILLEGAL_TRANSITION')
      }

      const version = this.currentVersion(address) + 1
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
      create unique index if not exists attempts_one_active_external
        on attempts(project_id, session_key)
        where status in ('CREATED', 'WORKSPACE_PREPARING', 'READY', 'STARTING', 'RUNNING', 'INTERRUPT_REQUESTED', 'OUTCOME_UNKNOWN');
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
        drop index if exists attempts_one_active_external;
        create unique index attempts_one_active_external
          on attempts(project_id, session_key)
          where status in ('CREATED', 'WORKSPACE_PREPARING', 'READY', 'STARTING', 'RUNNING', 'VERIFYING', 'INTERRUPT_REQUESTED', 'OUTCOME_UNKNOWN');
        insert or ignore into schema_migrations (version, applied_at) values (4, datetime('now'));
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
    !artifactMatches(artifact, record.patchArtifact)
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
    baseline.baseline_binding_digest === record.baselineBindingDigest
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
