import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  FlowId,
  HubCommandRequestV1,
  HubAddressV1,
  InitialPlanDraftInputV1,
  M2ADisabledIntentTypeV1,
  PlanRevisionId,
  UserIntentRequestV1,
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
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-hub-m2a-'))
  roots.push(root)
  return join(root, name)
}

function lookup(mode: SessionMode): SessionScopeLookupV1 {
  return {
    lookup: vi.fn(async (address: SessionAddressV1) => ({
      kind: 'FOUND' as const,
      scope: { ...address, sessionMode: mode },
    })),
  }
}

function unresolved(kind: 'NOT_FOUND' | 'PROJECT_MISMATCH'): SessionScopeLookupV1 {
  return { lookup: vi.fn(async () => ({ kind })) }
}

function draft(): InitialPlanDraftInputV1 {
  return {
    objective: '完成小规协作中枢后端最小闭环',
    tasks: [
      { taskKey: 'scope', title: '复用 M1 会话作用域' },
      { taskKey: 'journal', title: '写入 SQLite Journal', dependsOn: ['scope'] },
      { taskKey: 'projection', title: '生成只读任务投影', dependsOn: ['journal'] },
    ],
  }
}

function appFor(dbPath: string, mode: SessionMode = 'WORK', ids = ['xhbf_flow', 'xhbr_rev']) {
  let index = 0
  return createCollaborationHubApplicationV1({
    lookup: lookup(mode),
    storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
    now: () => '2026-08-16T00:00:00.000Z',
    idFactory: (prefix) => ids[index++] ?? `${prefix}_${index}`,
  })
}

async function start(app: ReturnType<typeof appFor>, requestId = 'req-start') {
  return execute(app, {
    requestId,
    intent: { type: 'flow.start.with_draft', draft: draft() },
  })
}

function execute(app: ReturnType<typeof appFor>, request: Omit<HubCommandRequestV1, 'contractVersion' | 'address' | 'trustedActor'>) {
  return app.execute({
    ...request,
    contractVersion: 'm2a.v1',
    address: ADDRESS,
    trustedActor: { kind: 'main-process-user' },
  })
}

describe('M2A collaboration hub application', () => {
  it('observes empty WORK/CODING sessions with only manual draft start available', async () => {
    for (const mode of ['WORK', 'CODING'] as const) {
      const dbPath = await tempDb(`${mode}.sqlite`)
      const app = appFor(dbPath, mode)
      await expect(app.observe(ADDRESS)).resolves.toMatchObject({
        ok: true,
        value: { sessionMode: mode, sessionVersion: 0, activeFlow: null, history: [], availableActions: ['flow.start.with_draft'] },
      })
      app.close()
    }
  })

  it('keeps DESIGN reserved in memory and does not create a SQLite file', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath, 'DESIGN')

    await expect(app.observe(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { reserved: { code: 'DESIGN_RESERVED' }, availableActions: [] },
    })
    await expect(
      execute(app, { requestId: 'req-design', intent: { type: 'flow.start.with_draft', draft: draft() } }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'DESIGN_RESERVED' } })
    await expect(app.readEvents(ADDRESS)).resolves.toMatchObject({ ok: false, error: { code: 'DESIGN_RESERVED' } })
    expect(existsSync(dbPath)).toBe(false)
    app.close()
  })

  it('starts a valid Chinese DAG draft and increments sessionVersion exactly once', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath)

    const result = await start(app)
    expect(result).toMatchObject({ ok: true, value: { sessionVersion: 1, flowId: 'xhbf_flow', revisionId: 'xhbr_rev' } })
    await expect(app.observe(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: {
        sessionVersion: 1,
        activeFlow: { status: 'AWAITING_PLAN_APPROVAL' },
        activeRevision: { status: 'DRAFT' },
        availableActions: ['plan.revision.submit', 'flow.cancel'],
      },
    })
    await expect(app.readEvents(ADDRESS)).resolves.toMatchObject({ ok: true, value: [{ sessionVersion: 1 }] })
    app.close()
  })

  it.each([
    ['empty', { objective: 'x', tasks: [] }],
    ['duplicate', { objective: 'x', tasks: [{ taskKey: 'a', title: 'A' }, { taskKey: 'a', title: 'B' }] }],
    ['unknown dependency', { objective: 'x', tasks: [{ taskKey: 'a', title: 'A', dependsOn: ['missing'] }] }],
    [
      'cycle',
      {
        objective: 'x',
        tasks: [
          { taskKey: 'a', title: 'A', dependsOn: ['b'] },
          { taskKey: 'b', title: 'B', dependsOn: ['a'] },
        ],
      },
    ],
  ])('rejects invalid draft %s without domain writes', async (_name, badDraft) => {
    const dbPath = await tempDb()
    const app = appFor(dbPath)

    await expect(
      execute(app, { requestId: `req-${_name}`, intent: { type: 'flow.start.with_draft', draft: badDraft } }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'DRAFT_INVALID' } })
    app.close()

    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(Object.values(store.tableCounts())).toEqual([0, 0, 0, 0, 0, 0, 0])
    store.close()
  })

  it('replays identical idempotency and rejects conflicting payload without version growth', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath)
    const request: UserIntentRequestV1 = { requestId: 'req-same', intent: { type: 'flow.start.with_draft', draft: draft() } }

    const first = await execute(app, request)
    const replay = await execute(app, request)
    expect(replay).toEqual(first)
    const conflict = await execute(app, {
      requestId: 'req-same',
      intent: { type: 'flow.start.with_draft', draft: { objective: 'invalid conflict', tasks: [] } },
    })
    expect(conflict).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } })
    await expect(app.observe(ADDRESS)).resolves.toMatchObject({ ok: true, value: { sessionVersion: 1 } })
    await expect(app.readEvents(ADDRESS)).resolves.toMatchObject({ ok: true, value: [{ sessionVersion: 1 }] })
    app.close()
  })

  it('checks submit idempotency before validating a conflicting invalid draft', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath)
    const started = await start(app)
    if (!started.ok) throw new Error('expected start')
    const request: UserIntentRequestV1 = {
      requestId: 'req-submit-idempotent',
      expectedSessionVersion: 1,
      intent: {
        type: 'plan.revision.submit',
        flowId: started.value.flowId as FlowId,
        baseRevisionId: started.value.revisionId as PlanRevisionId,
        draft: draft(),
      },
    }

    await expect(execute(app, request)).resolves.toMatchObject({ ok: true, value: { sessionVersion: 2 } })
    await expect(
      execute(app, {
        requestId: request.requestId,
        expectedSessionVersion: request.expectedSessionVersion,
        intent: {
          type: 'plan.revision.submit',
          flowId: started.value.flowId as FlowId,
          baseRevisionId: started.value.revisionId as PlanRevisionId,
          draft: { objective: 'invalid conflict', tasks: [] },
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } })
    await expect(app.observe(ADDRESS)).resolves.toMatchObject({ ok: true, value: { sessionVersion: 2 } })
    await expect(app.readEvents(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: [{ sessionVersion: 1 }, { sessionVersion: 2 }],
    })
    app.close()
  })

  it('returns INTENT_DISABLED for every reserved later-slice intent without opening SQLite', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath)
    const disabled = [
      'flow.start',
      'agent.revision.proposal.record',
      'task.run.guide',
      'task.run.cancel',
      'attempt.interrupt',
      'delivery.selection.submit',
      'gate.decide',
      'apply.reconcile.request',
      'apply.retry.request',
      'correction.create',
      'system.schedule',
      'system.workspace.prepare.result.record',
      'system.agent.report.record',
      'system.agent.outcome.record',
      'system.agent.reconcile',
      'system.verification.complete',
      'system.verification.reconcile',
    ] as const satisfies readonly M2ADisabledIntentTypeV1[]

    for (const type of disabled) {
      await expect(execute(app, { requestId: `req-disabled-${type}`, intent: { type } })).resolves.toMatchObject({
        ok: false,
        error: { code: 'INTENT_DISABLED' },
      })
    }
    expect(existsSync(dbPath)).toBe(false)
    app.close()
  })

  it('rejects a second active flow without mutating the first flow', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath)
    await start(app, 'req-one')

    await expect(start(app, 'req-two')).resolves.toMatchObject({ ok: false, error: { code: 'ACTIVE_FLOW_EXISTS' } })
    await expect(app.observe(ADDRESS)).resolves.toMatchObject({ ok: true, value: { sessionVersion: 1, activeFlow: { flowId: 'xhbf_flow' } } })
    app.close()
  })

  it('submits matching revision digest, creates read-only task projections, and exposes no execution action', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath)
    const started = await start(app)
    if (!started.ok) throw new Error('expected start')

    const submitted = await execute(app, {
      requestId: 'req-submit',
      expectedSessionVersion: 1,
      intent: {
        type: 'plan.revision.submit',
        flowId: started.value.flowId as FlowId,
        baseRevisionId: started.value.revisionId as PlanRevisionId,
        draft: draft(),
      },
    })
    expect(submitted).toMatchObject({ ok: true, value: { sessionVersion: 2 } })
    await expect(app.observe(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: {
        sessionVersion: 2,
        activeFlow: { status: 'PLAN_ACTIVE' },
        activeRevision: { status: 'ACTIVE' },
        taskSpecs: expect.arrayContaining([expect.objectContaining({ unavailableReason: 'AGENT_DISABLED_M2A' })]),
        taskRuns: expect.arrayContaining([expect.objectContaining({ status: 'PENDING_DISABLED' })]),
        availableActions: ['flow.cancel'],
      },
    })
    app.close()
  })

  it('rejects revision base/version/digest conflicts with zero extra events', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath)
    const started = await start(app)
    if (!started.ok) throw new Error('expected start')

    await expect(
      execute(app, {
        requestId: 'req-bad-base',
        intent: {
          type: 'plan.revision.submit',
          flowId: started.value.flowId as FlowId,
          baseRevisionId: 'xhbr_missing' as PlanRevisionId,
          draft: draft(),
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'REVISION_NOT_FOUND' } })
    await expect(
      execute(app, {
        requestId: 'req-stale',
        expectedSessionVersion: 99,
        intent: {
          type: 'plan.revision.submit',
          flowId: started.value.flowId as FlowId,
          baseRevisionId: started.value.revisionId as PlanRevisionId,
          draft: draft(),
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'STALE_SESSION_VERSION' } })
    await expect(
      execute(app, {
        requestId: 'req-digest',
        intent: {
          type: 'plan.revision.submit',
          flowId: started.value.flowId as FlowId,
          baseRevisionId: started.value.revisionId as PlanRevisionId,
          draft: { ...draft(), objective: '修改后的目标' },
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } })
    await expect(app.readEvents(ADDRESS)).resolves.toMatchObject({ ok: true, value: [{ sessionVersion: 1 }] })
    await expect(app.observe(ADDRESS)).resolves.toMatchObject({ ok: true, value: { sessionVersion: 1 } })
    app.close()
  })

  it('cancels active flow into history without deleting journal', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath)
    const started = await start(app)
    if (!started.ok) throw new Error('expected start')

    await expect(
      execute(app, { requestId: 'req-cancel', intent: { type: 'flow.cancel', flowId: started.value.flowId!, reason: '人工取消 D:/secret token' } }),
    ).resolves.toMatchObject({ ok: true, value: { sessionVersion: 2 } })
    await expect(app.observe(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { activeFlow: null, history: [{ status: 'CANCELLED' }], availableActions: ['flow.start.with_draft'] },
    })
    await expect(app.readEvents(ADDRESS)).resolves.toMatchObject({ ok: true, value: [{ sessionVersion: 1 }, { sessionVersion: 2 }] })
    app.close()
  })

  it.each(['NOT_FOUND', 'PROJECT_MISMATCH'] as const)('maps lookup %s to sanitized scope mismatch before SQLite opens', async (kind) => {
    const dbPath = await tempDb()
    const app = createCollaborationHubApplicationV1({
      lookup: unresolved(kind),
      storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
    })

    const result = await app.observe(ADDRESS)
    expect(result).toMatchObject({ ok: false, error: { code: 'SESSION_SCOPE_MISMATCH' } })
    if (!result.ok) {
      expect(JSON.stringify(result.error)).not.toContain('D:')
      expect(JSON.stringify(result.error)).not.toContain('sqlite')
    }
    expect(existsSync(dbPath)).toBe(false)
    app.close()
  })

  it('recovers projection, journal, and idempotency after reopening SQLite', async () => {
    const dbPath = await tempDb()
    const first = appFor(dbPath)
    const started = await start(first, 'req-restart')
    first.close()

    const second = appFor(dbPath)
    await expect(second.observe(ADDRESS)).resolves.toMatchObject({ ok: true, value: { sessionVersion: 1, activeFlow: { flowId: 'xhbf_flow' } } })
    await expect(start(second, 'req-restart')).resolves.toEqual(started)
    await expect(second.readEvents(ADDRESS)).resolves.toMatchObject({ ok: true, value: [{ eventType: 'flow.started.with_draft' }] })
    second.close()
  })

  it('keeps public DTO and persisted event payload free from path-like field names and values', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath)
    await start(app)
    app.close()

    const publicDto = readFileSync(join(process.cwd(), 'packages/shared/xiaogui-collaboration-hub.ts'), 'utf8')
    expect(publicDto).not.toMatch(/\b(rootPath|sessionFile|workspacePath|localPath|prompt|sql|token)\b/i)
    const dbBytes = readFileSync(dbPath, 'utf8')
    expect(dbBytes).not.toContain('D:')
    expect(dbBytes).not.toContain('Users')
  })
})
