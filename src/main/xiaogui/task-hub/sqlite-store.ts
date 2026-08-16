import { DatabaseSync } from 'node:sqlite'

import type {
  FlowId,
  HubAddressV1,
  HubEventEnvelopeV1,
  HubReadEventsRequestV1,
  PerformReceiptV1,
  PlanRevisionId,
  SessionCollaborationProjectionV1,
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
    return row ? (JSON.parse(row.projection_json) as SessionCollaborationProjectionV1) : null
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

  tableCounts(): Record<string, number> {
    const tables = ['journal_events', 'idempotency_keys', 'session_projection', 'flows', 'plan_revisions', 'task_specs', 'task_runs']
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
      create unique index if not exists flows_one_active_per_session
        on flows(project_id, session_key)
        where status != 'CANCELLED';
      insert or ignore into schema_migrations (version, applied_at) values (1, datetime('now'));
    `)
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
