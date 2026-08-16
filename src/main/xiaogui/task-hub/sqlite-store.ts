import { DatabaseSync } from 'node:sqlite'

import type {
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
  WorkspaceReceiptId,
} from '@shared/xiaogui-collaboration-hub'
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
  status: string
  workspace_receipt_id: WorkspaceReceiptId | null
  runtime_session_id: string | null
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
  now: string
}

export interface AgentReportRecordM2BV1 extends AgentDispatchRecordM2BV1 {
  runtimeSessionId: string
  receipt: PerformReceiptV1
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
      attempts: attempts.map((attempt) => ({
        attemptId: attempt.attempt_id,
        taskRunId: attempt.task_run_id,
        status: attempt.status as AttemptProjectionM2BV1['status'],
        ...(attempt.runtime_session_id ? { runtimeSessionId: attempt.runtime_session_id } : {}),
        ...(attempt.workspace_receipt_id ? { workspaceReceiptId: attempt.workspace_receipt_id } : {}),
      })),
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

  attempt(attemptId: AttemptId): AttemptRecord | null {
    const row = this.db
      .prepare('select attempt_id, task_run_id, status, workspace_receipt_id, runtime_session_id from attempts where attempt_id = ?')
      .get(attemptId) as AttemptRecord | undefined
    return row ?? null
  }

  hasActiveExternalAttempt(): boolean {
    const row = this.db
      .prepare(
        "select count(*) as count from attempts where status in ('STARTING', 'RUNNING', 'INTERRUPT_REQUESTED', 'OUTCOME_UNKNOWN')",
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
      this.db
        .prepare("update task_runs set status = 'RUNNING', unavailable_reason = 'M2B1_SCHEDULED' where task_run_id = ?")
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
      this.writeEvent(address, version, 'system.schedule', {
        phase: 'task_run.transition',
        flowId: record.flowId,
        taskRunId: record.taskRunId,
        from: 'READY',
        to: 'RUNNING',
      }, record.now)
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
          'insert into workspace_receipts (workspace_receipt_id, attempt_id, status, receipt_digest, failure_json, created_at) values (?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.workspaceReceipt.workspaceReceiptId,
          record.attemptId,
          record.workspaceReceipt.status,
          record.workspaceReceipt.receiptDigest,
          record.workspaceReceipt.status === 'FAILED' ? JSON.stringify(record.workspaceReceipt.failure) : null,
          record.now,
        )
      this.db.prepare('update attempts set status = ?, workspace_receipt_id = ?, updated_at = ? where attempt_id = ?').run(
        nextAttemptStatus,
        record.workspaceReceipt.workspaceReceiptId,
        record.now,
        record.attemptId,
      )
      if (record.workspaceReceipt.status !== 'PREPARED') {
        this.db.prepare("update task_runs set status = 'FAILED' where task_run_id = ?").run(record.taskRunId)
      }
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
          'insert into agent_dispatch_outbox (outbox_id, attempt_id, request_id, status, payload_digest, created_at, claimed_at, completed_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(`xhbo_${record.requestId}`, record.attemptId, record.requestId, 'READY', record.payloadDigest, record.now, null, null)
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
        .run(record.runtimeSessionId, record.attemptId, `fake-worktree-${record.attemptId}`, `sha256:${record.attemptId}`, record.now)
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
      'workspace_receipts',
      'agent_dispatch_outbox',
      'runtime_session_bindings',
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
        created_at text not null,
        updated_at text not null
      );
      create table if not exists workspace_receipts (
        workspace_receipt_id text primary key,
        attempt_id text not null references attempts(attempt_id),
        status text not null,
        receipt_digest text not null,
        failure_json text,
        created_at text not null
      );
      create table if not exists agent_dispatch_outbox (
        outbox_id text primary key,
        attempt_id text not null references attempts(attempt_id),
        request_id text not null,
        status text not null,
        payload_digest text not null,
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
      insert or ignore into schema_migrations (version, applied_at) values (2, datetime('now'));
    `)
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
      .prepare('select attempt_id, task_run_id, status, workspace_receipt_id, runtime_session_id from attempts where flow_id = ? order by rowid asc')
      .all(flowId) as unknown as AttemptRecord[]
  }

  private bumpProjectionVersion(address: HubAddressV1, version: number): void {
    const projection = this.readProjection(address)
    if (!projection) return
    this.writeProjection(address, { ...projection, sessionVersion: version })
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
