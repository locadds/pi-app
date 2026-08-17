import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
import type { SessionAddressV1, SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { createCollaborationHubApplicationV1 } from './application'
import { CollaborationHubSqliteStoreV1, type ScheduleRecordM2BV1 } from './sqlite-store'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDb(name = 'hub.sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-hub-m2b-store-'))
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
      flow_execution_baselines: 0,
      composition_attempts: 0,
      workspace_prepare_outbox: 0,
      workspace_receipts: 0,
      agent_dispatch_outbox: 0,
      runtime_session_bindings: 0,
      agent_failures: 0,
      agent_succeeded_audits: 0,
      agent_reconcile_results: 0,
      attempt_workspace_prepared: 0,
      attempt_file_manifests: 0,
      scope_expansion_requests: 0,
      create_batches: 0,
      private_runtime_payloads: 0,
    })
    store.close()

    const reopened = new CollaborationHubSqliteStoreV1(dbPath)
    reopened.close()

    const db = new DatabaseSync(dbPath)
    expect(db.prepare('select version from schema_migrations order by version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }])
    expect(db.prepare("select name from sqlite_master where type = 'table' and name in ('attempts', 'flow_execution_baselines', 'composition_attempts', 'workspace_prepare_outbox', 'workspace_receipts', 'agent_dispatch_outbox', 'runtime_session_bindings', 'agent_failures', 'agent_succeeded_audits', 'agent_reconcile_results', 'attempt_workspace_prepared', 'attempt_file_manifests', 'scope_expansion_requests', 'create_batches', 'private_runtime_payloads') order by name").all()).toEqual([
      { name: 'agent_dispatch_outbox' },
      { name: 'agent_failures' },
      { name: 'agent_reconcile_results' },
      { name: 'agent_succeeded_audits' },
      { name: 'attempt_file_manifests' },
      { name: 'attempt_workspace_prepared' },
      { name: 'attempts' },
      { name: 'composition_attempts' },
      { name: 'create_batches' },
      { name: 'flow_execution_baselines' },
      { name: 'private_runtime_payloads' },
      { name: 'runtime_session_bindings' },
      { name: 'scope_expansion_requests' },
      { name: 'workspace_prepare_outbox' },
      { name: 'workspace_receipts' },
    ])
    db.close()
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
      attempt_workspace_prepared: 0,
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
      expect(
        migrated
          .prepare(`select name from sqlite_master where type = 'table' and name in (${privateM2B2Tables().map(() => '?').join(',')}) order by name`)
          .all(...privateM2B2Tables()),
      ).toEqual([
        { name: 'attempt_file_manifests' },
        { name: 'attempt_workspace_prepared' },
        { name: 'create_batches' },
        { name: 'private_runtime_payloads' },
        { name: 'scope_expansion_requests' },
      ])
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
