import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  FlowId,
  HubAddressV1,
  HubCommandRequestV1,
  InitialPlanDraftInputV1,
} from '@shared/xiaogui-collaboration-hub'
import type { SessionAddressV1, SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { createCollaborationHubApplicationV1 } from './application'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'

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
    })
    store.close()

    const reopened = new CollaborationHubSqliteStoreV1(dbPath)
    reopened.close()

    const db = new DatabaseSync(dbPath)
    expect(db.prepare('select version from schema_migrations order by version').all()).toEqual([{ version: 1 }, { version: 2 }])
    expect(db.prepare("select name from sqlite_master where type = 'table' and name in ('attempts', 'flow_execution_baselines', 'composition_attempts', 'workspace_prepare_outbox', 'workspace_receipts', 'agent_dispatch_outbox', 'runtime_session_bindings', 'agent_failures', 'agent_succeeded_audits', 'agent_reconcile_results') order by name").all()).toEqual([
      { name: 'agent_dispatch_outbox' },
      { name: 'agent_failures' },
      { name: 'agent_reconcile_results' },
      { name: 'agent_succeeded_audits' },
      { name: 'attempts' },
      { name: 'composition_attempts' },
      { name: 'flow_execution_baselines' },
      { name: 'runtime_session_bindings' },
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
})
