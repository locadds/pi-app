import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeCapabilityV1 } from '@shared/xiaogui-agent-runtime'
import type {
  AttemptId,
  FlowId,
  HubCommandRequestV1,
  HubAddressV1,
  HubSystemCommandRequestM2BV1,
  InitialPlanDraftInputV1,
  M2ADisabledIntentTypeV1,
  PlanRevisionId,
  SessionCollaborationProjectionM2BV1,
  TaskFileAuthorizationScopeV1,
  TaskRunId,
  UserIntentRequestV1,
  WorkspaceReceiptId,
} from '@shared/xiaogui-collaboration-hub'
import type { DeliveryBatchProjectionV1 } from '@shared/xiaogui-delivery'
import type { SessionAddressV1, SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { createAgentRuntimeHostV1 } from '../agent-runtime/runtime-host'
import { ScriptedAgentRuntimeAdapterV1 } from '../agent-runtime/scripted-adapter'
import { createCollaborationHubApplicationV1, type ExecutionWorkspaceBridgeV1, type RuntimePromptVaultV1 } from './application'
import { digestJson } from './digest'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

const approvedCapability = {
  adapterId: 'fake-approved',
  runtimeKind: 'OTHER',
  protocol: 'HEADLESS',
  capabilityDigest: 'sha256:fake-approved',
  approvalStatus: 'APPROVED_FOR_PRODUCTION',
  health: 'AVAILABLE',
  canCreateSession: true,
  canResumeSession: true,
  diagnosticOnly: false,
  stream: 'POLL',
  interrupt: 'BEST_EFFORT',
  inspect: 'RECONCILE',
  interactivePermission: 'HOST_MEDIATED',
} satisfies RuntimeCapabilityV1

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDb(name = 'hub.sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-hub-m2a-'))
  roots.push(root)
  return join(root, name)
}

function journalPayloads(dbPath: string, eventType: string): unknown[] {
  const db = new DatabaseSync(dbPath)
  try {
    return db
      .prepare('select event_json from journal_events where event_type = ? order by session_sequence asc')
      .all(eventType)
      .map((row) => JSON.parse((row as { event_json: string }).event_json) as unknown)
  } finally {
    db.close()
  }
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

function canonicalDraft(): InitialPlanDraftInputV1 {
  return {
    objective: '完成小规协作中枢后端最小闭环',
    tasks: [
      { taskKey: 'journal', title: '写入 SQLite Journal', dependsOn: ['scope'] },
      { taskKey: 'projection', title: '生成只读任务投影', dependsOn: ['journal'] },
      { taskKey: 'scope', title: '复用 M1 会话作用域', dependsOn: [] },
    ],
  }
}

function twoIndependentTasksDraft(): InitialPlanDraftInputV1 {
  return {
    objective: '验证同一 Flow baseline 不可变',
    tasks: [
      { taskKey: 'first', title: '第一项无依赖任务' },
      { taskKey: 'second', title: '第二项无依赖任务' },
    ],
  }
}

function parentChildDraft(): InitialPlanDraftInputV1 {
  return {
    objective: '验证父任务失败后的实时可执行性',
    tasks: [
      { taskKey: 'parent', title: '先执行父任务' },
      { taskKey: 'child', title: '依赖父任务', dependsOn: ['parent'] },
    ],
  }
}

function threeIndependentTasksDraft(): InitialPlanDraftInputV1 {
  return {
    objective: '验证项目并行上限与波次调度',
    tasks: [
      { taskKey: 'first', title: '第一项无依赖任务' },
      { taskKey: 'second', title: '第二项无依赖任务' },
      { taskKey: 'third', title: '第三项无依赖任务' },
    ],
  }
}

function authorizationScope(label: string): TaskFileAuthorizationScopeV1 {
  const pathTokens = [`sha256:${digestJson({ label, role: 'authorization-path' })}` as TaskFileAuthorizationScopeV1['pathTokens'][number]]
  const base = { version: 1 as const, pathTokens }
  return { ...base, scopeDigest: `sha256:${digestJson(base)}` as TaskFileAuthorizationScopeV1['scopeDigest'] }
}

function appFor(
  dbPath: string,
  mode: SessionMode = 'WORK',
  ids = ['xhbf_flow', 'xhbr_rev'],
  runtimeSessionId?: string,
  workspaceBridge?: ExecutionWorkspaceBridgeV1,
  clock: () => string = () => '2026-08-16T00:00:00.000Z',
) {
  let index = 0
  const baseline = scriptedBaseline()
  return createCollaborationHubApplicationV1({
    lookup: lookup(mode),
    storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
    ...(runtimeSessionId
      ? {
          agentRuntime: createAgentRuntimeHostV1(new ScriptedAgentRuntimeAdapterV1({ capabilities: [approvedCapability], createRuntimeSessionId: runtimeSessionId })),
          baselineProvider: { capture: async () => baseline },
          workspaceBridge: workspaceBridge ?? testWorkspaceBridge(baseline),
          runtimePromptVault: testPromptVault(),
        }
      : {}),
    now: clock,
    idFactory: (prefix) => ids[index++] ?? `${prefix}_${index}`,
  })
}

function appForBaselines(dbPath: string, baselines: ReturnType<typeof scriptedBaseline>[]) {
  let index = 0
  let baselineIndex = 0
  return createCollaborationHubApplicationV1({
    lookup: lookup('CODING'),
    storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
    agentRuntime: createAgentRuntimeHostV1(new ScriptedAgentRuntimeAdapterV1({ capabilities: [approvedCapability], createRuntimeSessionId: 'runtime-1' })),
    baselineProvider: {
      capture: async () => baselines[Math.min(baselineIndex++, baselines.length - 1)],
    },
    now: () => '2026-08-16T00:00:00.000Z',
    idFactory: (prefix) => `${prefix}_${++index}`,
  })
}

function scriptedBaseline(suffix = '1') {
  const base = {
    baselineId: `baseline-${suffix}`,
    baselineTreeHash: `sha256:baseline-tree-${suffix}`,
    initialTargetFingerprint: `sha256:initial-target-${suffix}`,
  }
  return { ...base, baselineDigest: digestJson(base) }
}

function testWorkspaceBridge(baseline: ReturnType<typeof scriptedBaseline>): ExecutionWorkspaceBridgeV1 {
  return {
    prepare: async () => {
      throw new Error('test bridge prepare is not used by manual workspace receipt tests')
    },
    runtimeWorkspace: (attemptId) => ({
      attemptWorktreeId: `xhbwt_test_${attemptId}`,
      worktreeRootDigest: digestJson({ attemptId, role: 'test-worktree-root' }),
      baseRevisionDigest: baseline.baselineTreeHash,
      targetProjectRootDigest: baseline.initialTargetFingerprint,
      writePolicy: 'ATTEMPT_WORKTREE_ONLY',
    }),
  }
}

function testPromptVault(): RuntimePromptVaultV1 {
  return {
    promptRefForAttempt: (attemptId) => ({
      refId: `xhbprompt_test_${attemptId}`,
      digest: digestJson({ attemptId, role: 'test-runtime-prompt' }),
      mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
    }),
  }
}

function flowBaselineRow(dbPath: string, flowId: FlowId) {
  const db = new DatabaseSync(dbPath)
  try {
    return db
      .prepare('select flow_id, baseline_id, baseline_tree_hash, initial_target_fingerprint, baseline_digest, baseline_binding_digest, created_at from flow_execution_baselines where flow_id = ?')
      .get(flowId) as Record<string, unknown> | undefined
  } finally {
    db.close()
  }
}

function workspaceBinding(dbPath: string, attemptId: AttemptId) {
  const store = new CollaborationHubSqliteStoreV1(dbPath)
  try {
    const binding = store.compositionAttempt(attemptId)
    if (!binding) throw new Error('missing composition attempt')
    return binding
  } finally {
    store.close()
  }
}

async function start(app: ReturnType<typeof appFor>, requestId = 'req-start', initialDraft = draft()) {
  return execute(app, {
    requestId,
    intent: { type: 'flow.start.with_draft', draft: initialDraft },
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

type TestSystemRequestV1 = Omit<HubSystemCommandRequestM2BV1, 'contractVersion' | 'address' | 'trustedActor' | 'intent'> & {
  intent: HubSystemCommandRequestM2BV1['intent'] | {
    type: 'system.schedule'
    flowId: FlowId
    authorizationScope?: TaskFileAuthorizationScopeV1
    executionInputDigest?: string
  }
}

function executeSystem(app: ReturnType<typeof appFor>, request: TestSystemRequestV1) {
  const intent = request.intent.type === 'system.schedule' && !request.intent.authorizationScope
    ? { ...request.intent, authorizationScope: authorizationScope('test-default-schedule-scope') }
    : request.intent
  return app.executeSystem({
    ...request,
    intent,
    contractVersion: 'm2b.v1',
    address: ADDRESS,
    trustedActor: { kind: 'main-process-system' },
  } as HubSystemCommandRequestM2BV1)
}

async function scheduleWorkspaceAttempt(app: ReturnType<typeof appFor>) {
  await start(app)
  const draftProjection = await app.observe(ADDRESS)
  if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
  await execute(app, {
    requestId: 'req-approve',
    expectedSessionVersion: draftProjection.value.sessionVersion,
    intent: {
      type: 'plan.revision.submit',
      flowId: draftProjection.value.activeFlow.flowId,
      baseRevisionId: draftProjection.value.activeRevision.revisionId,
      draft: draftProjection.value.activeRevision.draft,
    },
  })
  const before = await app.observeM2B(ADDRESS)
  await executeSystem(app, {
    requestId: 'sys-schedule-1',
    expectedSessionVersion: before.ok ? before.value.sessionVersion : 0,
    intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
  })
  const scheduled = await app.observeM2B(ADDRESS)
  if (!scheduled.ok || !scheduled.value.attempts[0]) throw new Error('expected scheduled workspace attempt')
  return {
    flowId: draftProjection.value.activeFlow.flowId,
    sessionVersion: scheduled.value.sessionVersion,
    attempt: scheduled.value.attempts[0],
  }
}

function claimWorkspacePreparation(dbPath: string, attemptId: AttemptId) {
  const store = new CollaborationHubSqliteStoreV1(dbPath)
  try {
    const claim = store.claimWorkspacePrepareOutbox({
      attemptId,
      ownerId: 'test-main-process',
      claimDigest: digestJson({ attemptId, role: 'test-workspace-claim' }),
      now: '2026-08-16T00:00:00.000Z',
    })
    if (!claim) throw new Error('expected workspace prepare claim')
  } finally {
    store.close()
  }
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

  it('projects authoritative delivery selection and review actions from the shared store', async () => {
    const taskRunId = 'xhbtr_verified' as TaskRunId
    const flowId = 'xhbf_delivery' as FlowId
    const projection = {
      kind: 'SESSION_COLLABORATION_PROJECTION',
      version: 'm2b.v1',
      address: ADDRESS,
      sessionVersion: 3,
      sessionMode: 'CODING',
      authoritativeMode: 'CODING',
      reserved: false,
      activeFlow: {
        flowId,
        status: 'PLAN_ACTIVE',
        activeRevisionId: 'xhbr_delivery' as PlanRevisionId,
        objective: '交付已验证任务',
      },
      activeRevision: null,
      taskSpecs: [],
      taskRuns: [{
        taskRunId,
        taskSpecId: 'xhbts_delivery' as never,
        taskKey: 'delivery',
        status: 'VERIFIED',
      }],
      attempts: [],
      history: [],
      availableActions: ['flow.cancel'],
    } satisfies SessionCollaborationProjectionM2BV1
    let activeDelivery: DeliveryBatchProjectionV1 | null = null
    const store = {
      readProjectionM2B: () => projection,
      readActiveDelivery: () => activeDelivery,
      schedulerTasks: () => [],
      schedulerAttempts: () => [],
      close: vi.fn(),
    } as unknown as CollaborationHubSqliteStoreV1
    const app = createCollaborationHubApplicationV1({
      lookup: lookup('CODING'),
      storeFactory: () => store,
    })

    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: {
        activeDelivery: null,
        availableActions: ['flow.cancel', 'delivery.selection.submit'],
      },
    })

    activeDelivery = {
      batchId: 'xhbd_delivery' as never,
      flowId,
      state: 'READY_FOR_REVIEW',
      selectionDigest: `sha256:${'1'.repeat(64)}` as never,
      selectedTaskRunIds: [taskRunId],
      taskChangeSetIds: ['xhbcs_delivery' as never],
      targetFingerprint: `sha256:${'2'.repeat(64)}` as never,
      gate: {
        gateId: 'xhbdg_delivery' as never,
        batchId: 'xhbd_delivery' as never,
        subject: {
          deliveryChangeSetId: 'xhbdcs_delivery' as never,
          version: 1,
          digest: `sha256:${'3'.repeat(64)}` as never,
        },
        state: 'OPEN',
        createdAt: '2026-08-23T00:00:00.000Z' as never,
      },
    }
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: {
        activeDelivery,
        availableActions: ['flow.cancel', 'delivery.gate.approve', 'delivery.gate.reject'],
      },
    })

    const approvedGate = { ...activeDelivery.gate!, state: 'APPROVED' as const }
    const failedApplyAttempt = {
      applyAttemptId: 'xhbdap_delivery' as never,
      batchId: activeDelivery.batchId,
      deliveryChangeSetId: activeDelivery.gate!.subject.deliveryChangeSetId,
      requestDigest: `sha256:${'4'.repeat(64)}` as never,
      targetFingerprintBefore: activeDelivery.targetFingerprint,
      state: 'FAILED' as const,
      changedRelativePaths: [] as readonly string[],
      startedAt: '2026-08-23T00:00:01.000Z' as never,
      finishedAt: '2026-08-23T00:00:02.000Z' as never,
    }
    activeDelivery = {
      ...activeDelivery,
      state: 'APPROVED',
      gate: approvedGate,
      applyAttempt: { ...failedApplyAttempt, safeCode: 'TARGET_BASELINE_DRIFT' },
    }
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { availableActions: ['flow.cancel', 'apply.recovery.prepare'] },
    })
    const failedApplyAttemptWithoutPaths: NonNullable<DeliveryBatchProjectionV1['applyAttempt']> = {
      applyAttemptId: failedApplyAttempt.applyAttemptId,
      batchId: failedApplyAttempt.batchId,
      deliveryChangeSetId: failedApplyAttempt.deliveryChangeSetId,
      requestDigest: failedApplyAttempt.requestDigest,
      targetFingerprintBefore: failedApplyAttempt.targetFingerprintBefore,
      state: failedApplyAttempt.state,
      safeCode: 'TARGET_BASELINE_DRIFT',
      startedAt: failedApplyAttempt.startedAt,
      finishedAt: failedApplyAttempt.finishedAt,
    }
    activeDelivery = {
      ...activeDelivery,
      applyAttempt: failedApplyAttemptWithoutPaths,
    }
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { availableActions: ['flow.cancel'] },
    })
    activeDelivery = {
      ...activeDelivery,
      applyAttempt: { ...failedApplyAttempt, safeCode: 'TARGET_BASELINE_DRIFT', changedRelativePaths: ['src/index.ts'] },
    }
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { availableActions: ['flow.cancel'] },
    })

    for (const safeCode of ['TARGET_STATUS_DIRTY', 'TARGET_FILE_DRIFT'] as const) {
      activeDelivery = {
        ...activeDelivery,
        applyAttempt: { ...failedApplyAttempt, safeCode },
      }
      await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
        ok: true,
        value: { availableActions: ['flow.cancel'] },
      })
    }

    activeDelivery = {
      ...activeDelivery,
      applyAttempt: { ...failedApplyAttempt, safeCode: 'TARGET_WRITE_FAILED' },
    }
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { availableActions: ['flow.cancel', 'apply.retry.request'] },
    })
    app.close()
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
    const observed = await app.observe(ADDRESS)
    expect(observed).toMatchObject({
      ok: true,
      value: {
        sessionVersion: 1,
        activeFlow: { status: 'AWAITING_PLAN_APPROVAL' },
        activeRevision: { status: 'DRAFT' },
        availableActions: ['plan.revision.submit', 'flow.cancel'],
      },
    })
    if (!observed.ok || !observed.value.activeRevision) throw new Error('expected active draft revision projection')
    expect(observed.value.activeRevision.draft).toEqual(canonicalDraft())
    expect(observed.value.activeRevision.digest).toBe(digestJson(canonicalDraft()))
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
      attempt_workspace_prepared: 0,
      attempt_workspace_leases: 0,
      attempt_file_manifests: 0,
      scope_expansion_requests: 0,
      create_batches: 0,
      private_runtime_payloads: 0,
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
    })
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
    const observed = await app.observe(ADDRESS)
    expect(observed).toMatchObject({
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
    if (!observed.ok || !observed.value.activeRevision) throw new Error('expected active plan revision projection')
    expect(observed.value.activeRevision.draft).toEqual(canonicalDraft())
    expect(observed.value.activeRevision.digest).toBe(digestJson(canonicalDraft()))
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
    const observed = await second.observe(ADDRESS)
    expect(observed).toMatchObject({ ok: true, value: { sessionVersion: 1, activeFlow: { flowId: 'xhbf_flow' } } })
    if (!observed.ok || !observed.value.activeRevision) throw new Error('expected reopened draft revision projection')
    expect(observed.value.activeRevision.draft).toEqual(canonicalDraft())
    expect(observed.value.activeRevision.digest).toBe(digestJson(canonicalDraft()))
    await expect(start(second, 'req-restart')).resolves.toEqual(started)
    await expect(second.readEvents(ADDRESS)).resolves.toMatchObject({ ok: true, value: [{ eventType: 'flow.started.with_draft' }] })
    second.close()
  })

  it('hydrates a pre-M3A projection draft from the existing revision record without migrating the database', async () => {
    const dbPath = await tempDb()
    const first = appFor(dbPath)
    await start(first, 'req-legacy-projection')
    first.close()

    const legacyDb = new DatabaseSync(dbPath)
    const row = legacyDb
      .prepare('select projection_json from session_projection where project_id = ? and session_key = ?')
      .get(ADDRESS.projectId, ADDRESS.sessionKey) as { projection_json: string }
    const legacyProjection = JSON.parse(row.projection_json) as {
      activeRevision: { draft?: InitialPlanDraftInputV1 } | null
    }
    if (!legacyProjection.activeRevision) throw new Error('expected legacy active revision')
    delete legacyProjection.activeRevision.draft
    legacyDb
      .prepare('update session_projection set projection_json = ? where project_id = ? and session_key = ?')
      .run(JSON.stringify(legacyProjection), ADDRESS.projectId, ADDRESS.sessionKey)
    legacyDb.close()

    const reopened = appFor(dbPath)
    const observed = await reopened.observe(ADDRESS)
    reopened.close()
    expect(observed).toMatchObject({ ok: true, value: { sessionVersion: 1 } })
    if (!observed.ok || !observed.value.activeRevision) throw new Error('expected hydrated legacy active revision')
    expect(observed.value.activeRevision.draft).toEqual(canonicalDraft())
    expect(observed.value.activeRevision.digest).toBe(digestJson(canonicalDraft()))

    const unchangedDb = new DatabaseSync(dbPath)
    const stored = unchangedDb
      .prepare('select projection_json from session_projection where project_id = ? and session_key = ?')
      .get(ADDRESS.projectId, ADDRESS.sessionKey) as { projection_json: string }
    const migration = unchangedDb.prepare('select max(version) as version from schema_migrations').get() as { version: number }
    unchangedDb.close()
    expect(JSON.parse(stored.projection_json).activeRevision).not.toHaveProperty('draft')
    expect(migration.version).toBe(12)
  })

  it('keeps public projection actions user-only and persisted event payload sanitized', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath)
    await start(app)
    const projection = await app.observeM2B(ADDRESS)
    expect(projection).toMatchObject({ ok: true, value: { availableActions: ['plan.revision.submit', 'flow.cancel'] } })
    const payloads = journalPayloads(dbPath, 'flow.started.with_draft')
    expect(JSON.stringify(payloads)).not.toMatch(/[A-Za-z]:[\\/]|\\\\|file:\/\/|token|secret|password/i)
    app.close()
    })
  })

  it('keeps m2a projection compatible while system.schedule creates M2 TaskRun and Attempt states explicitly', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath, 'CODING', ['xhbf_flow', 'xhbr_rev', 'xhbts_scope', 'xhbts_journal', 'xhbts_projection', 'xhbtr_scope', 'xhbtr_journal', 'xhbtr_projection', 'xhba_attempt'], 'runtime-1')
    await start(app)
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
    await execute(app, {
      requestId: 'req-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })

    const before = await app.observeM2B(ADDRESS)
    expect(before).toMatchObject({
      ok: true,
      value: {
        version: 'm2b.v1',
        taskRuns: expect.arrayContaining([expect.objectContaining({ taskKey: 'scope', status: 'BLOCKED' })]),
        attempts: [],
        executionReadiness: {
          version: 1,
          flowId: draftProjection.value.activeFlow.flowId,
          maxParallelism: 2,
          activeAttemptCount: 0,
          availableSlots: 2,
          readyTaskRunIds: ['xhbtr_projection'],
          dependencyStates: expect.arrayContaining([
            expect.objectContaining({ taskRunId: 'xhbtr_projection', state: 'READY' }),
          ]),
          capturedAt: '2026-08-16T00:00:00.000Z',
        },
      },
    })

    const scheduled = await executeSystem(app, {
      requestId: 'sys-schedule-1',
      expectedSessionVersion: before.ok ? before.value.sessionVersion : 0,
      intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
    })
    expect(scheduled).toMatchObject({
      ok: true,
      value: { intentType: 'system.schedule', taskRunId: 'xhbtr_projection', attemptId: 'xhba_attempt' },
    })

    await expect(app.observe(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: {
        version: 'm2a.v1',
        taskRuns: expect.arrayContaining([expect.objectContaining({ taskKey: 'scope', status: 'PENDING_DISABLED' })]),
      },
    })
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: {
        version: 'm2b.v1',
        taskRuns: expect.arrayContaining([expect.objectContaining({ taskKey: 'scope', status: 'READY', attemptId: 'xhba_attempt' })]),
        attempts: [expect.objectContaining({ attemptId: 'xhba_attempt', status: 'WORKSPACE_PREPARING' })],
        executionReadiness: {
          version: 1,
          flowId: draftProjection.value.activeFlow.flowId,
          maxParallelism: 2,
          activeAttemptCount: 1,
          availableSlots: 1,
          readyTaskRunIds: [],
          dependencyStates: expect.arrayContaining([
            expect.objectContaining({ taskRunId: 'xhbtr_projection', state: 'IN_FLIGHT' }),
          ]),
          capturedAt: '2026-08-16T00:00:00.000Z',
        },
      },
    })
    const events = await app.readEvents(ADDRESS, { afterSessionSequence: 0, limit: 10 })
    expect(events).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ eventType: 'system.schedule' })]) })
    expect(journalPayloads(dbPath, 'system.schedule')).toMatchObject([
      { phase: 'task_run.transition', from: 'BLOCKED', to: 'DEPENDENCY_ELIGIBLE' },
      { phase: 'task_run.transition', from: 'DEPENDENCY_ELIGIBLE', to: 'READY' },
      { phase: 'attempt.created', status: 'CREATED' },
      { phase: 'attempt.transition', from: 'CREATED', to: 'WORKSPACE_PREPARING' },
      { phase: 'workspace_prepare.outbox_persisted', attemptId: 'xhba_attempt' },
    ])
    app.close()
  })

  it('fails system.schedule preflight before any M2B execution write when no runtime is available', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath, 'CODING', ['xhbf_flow', 'xhbr_rev', 'xhbts_scope', 'xhbts_journal', 'xhbts_projection', 'xhbtr_scope', 'xhbtr_journal', 'xhbtr_projection'])
    await start(app)
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
    await execute(app, {
      requestId: 'req-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    const approved = await app.observeM2B(ADDRESS)
    await expect(
      executeSystem(app, {
        requestId: 'sys-schedule-no-runtime',
        expectedSessionVersion: approved.ok ? approved.value.sessionVersion : 0,
        intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'AGENT_UNAVAILABLE' } })
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({ ok: true, value: { sessionVersion: approved.ok ? approved.value.sessionVersion : 0, attempts: [] } })
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({ attempts: 0, flow_execution_baselines: 0, composition_attempts: 0, workspace_prepare_outbox: 0, agent_dispatch_outbox: 0, runtime_session_bindings: 0 })
    store.close()
    app.close()
  })

  it('observes readiness without creating attempts or waves and is stable except for capturedAt', async () => {
    const dbPath = await tempDb('readiness-observe-only.sqlite')
    let now = '2026-08-16T00:00:00.000Z'
    const app = appFor(
      dbPath,
      'CODING',
      ['xhbf_readonly', 'xhbr_readonly', 'xhbts_readonly_scope', 'xhbts_readonly_journal', 'xhbts_readonly_projection', 'xhbtr_readonly_scope', 'xhbtr_readonly_journal', 'xhbtr_readonly_projection'],
      'runtime-readonly',
      undefined,
      () => now,
    )
    await start(app, 'req-readiness-readonly')
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) {
      throw new Error('expected draft flow')
    }
    await execute(app, {
      requestId: 'req-readiness-readonly-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    const storeBefore = new CollaborationHubSqliteStoreV1(dbPath)
    const beforeCounts = storeBefore.tableCounts()
    storeBefore.close()

    now = '2026-08-16T00:00:01.000Z'
    const first = await app.observeM2B(ADDRESS)
    now = '2026-08-16T00:00:02.000Z'
    const second = await app.observeM2B(ADDRESS)
    if (!first.ok || !second.ok || !first.value.executionReadiness || !second.value.executionReadiness) {
      throw new Error('expected execution readiness')
    }
    const { capturedAt: firstCapturedAt, ...firstStable } = first.value.executionReadiness
    const { capturedAt: secondCapturedAt, ...secondStable } = second.value.executionReadiness

    expect(firstCapturedAt).toBe('2026-08-16T00:00:01.000Z')
    expect(secondCapturedAt).toBe('2026-08-16T00:00:02.000Z')
    expect(secondStable).toEqual(firstStable)
    expect(first.value.lastExecutionWave).toBeUndefined()
    expect(second.value.lastExecutionWave).toBeUndefined()
    const storeAfter = new CollaborationHubSqliteStoreV1(dbPath)
    try {
      expect(storeAfter.tableCounts()).toEqual(beforeCounts)
      expect(storeAfter.tableCounts()).toMatchObject({ attempts: 0, execution_waves: 0 })
    } finally {
      storeAfter.close()
      app.close()
    }
  })

  it('recomputes a child as blocked after its parent fails instead of replaying the historical wave state', async () => {
    const dbPath = await tempDb('readiness-parent-failed.sqlite')
    const baseline = scriptedBaseline()
    const app = appFor(
      dbPath,
      'CODING',
      ['xhbf_readiness_failed', 'xhbr_readiness_failed', 'xhbts_readiness_parent', 'xhbts_readiness_child', 'xhbtr_readiness_parent', 'xhbtr_readiness_child', 'xhba_readiness_parent'],
      'runtime-readiness-failed',
      testWorkspaceBridge(baseline),
    )
    await start(app, 'req-readiness-failed-start', parentChildDraft())
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) {
      throw new Error('expected draft flow')
    }
    await execute(app, {
      requestId: 'req-readiness-failed-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    const beforeSchedule = await app.observeM2B(ADDRESS)
    if (!beforeSchedule.ok || !beforeSchedule.value.executionReadiness) throw new Error('expected readiness')
    const parentRun = beforeSchedule.value.taskRuns.find((run) => run.taskKey === 'parent')
    const childRun = beforeSchedule.value.taskRuns.find((run) => run.taskKey === 'child')
    if (!parentRun || !childRun) throw new Error('expected parent and child task runs')
    expect(beforeSchedule.value.executionReadiness.dependencyStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskRunId: parentRun.taskRunId, state: 'READY' }),
      expect.objectContaining({ taskRunId: childRun.taskRunId, state: 'WAITING_FOR_DEPENDENCIES' }),
    ]))

    const scheduled = await executeSystem(app, {
      requestId: 'sys-readiness-failed-schedule',
      expectedSessionVersion: beforeSchedule.value.sessionVersion,
      intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
    })
    if (!scheduled.ok || !scheduled.value.attemptId || !scheduled.value.taskRunId) throw new Error('expected parent attempt')
    const afterSchedule = await app.observeM2B(ADDRESS)
    if (!afterSchedule.ok) throw new Error('expected scheduled projection')
    const binding = workspaceBinding(dbPath, scheduled.value.attemptId)
    claimWorkspacePreparation(dbPath, scheduled.value.attemptId)
    await executeSystem(app, {
      requestId: 'sys-readiness-parent-workspace-failed',
      expectedSessionVersion: afterSchedule.value.sessionVersion,
      intent: {
        type: 'system.workspace.prepare.result.record',
        flowId: draftProjection.value.activeFlow.flowId,
        taskRunId: scheduled.value.taskRunId,
        attemptId: scheduled.value.attemptId,
        receipt: {
          status: 'FAILED',
          workspaceReceiptId: 'xhbw_readiness_parent_failed' as WorkspaceReceiptId,
          receiptDigest: 'sha256:readiness-parent-failed',
          failure: { kind: 'WORKTREE_CREATE_FAILED', failureDigest: 'sha256:readiness-parent-failed' },
          ...binding,
        },
      },
    })

    const afterFailure = await app.observeM2B(ADDRESS)
    if (!afterFailure.ok || !afterFailure.value.executionReadiness || !afterFailure.value.lastExecutionWave) {
      throw new Error('expected current readiness and historical wave')
    }
    expect(afterFailure.value.lastExecutionWave.dependencyStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskRunId: childRun.taskRunId, state: 'WAITING_FOR_DEPENDENCIES' }),
    ]))
    expect(afterFailure.value.executionReadiness).toMatchObject({
      activeAttemptCount: 0,
      availableSlots: 2,
      readyTaskRunIds: [],
      dependencyStates: expect.arrayContaining([
        expect.objectContaining({ taskRunId: parentRun.taskRunId, state: 'TERMINAL' }),
        expect.objectContaining({ taskRunId: childRun.taskRunId, state: 'BLOCKED_BY_FAILED_DEPENDENCY' }),
      ]),
    })
    app.close()
  })

  it('rejects missing or empty system.schedule authorization scopes before any M2B execution write', async () => {
    const dbPath = await tempDb()
    const app = appFor(
      dbPath,
      'CODING',
      ['xhbf_flow', 'xhbr_rev', 'xhbts_scope', 'xhbts_journal', 'xhbts_projection', 'xhbtr_scope', 'xhbtr_journal', 'xhbtr_projection'],
      'runtime-1',
    )
    await start(app)
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
    await execute(app, {
      requestId: 'req-approve-scope-required',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    const approved = await app.observeM2B(ADDRESS)
    if (!approved.ok) throw new Error('expected approved projection')
    await expect(app.executeSystem({
      contractVersion: 'm2b.v1',
      address: ADDRESS,
      trustedActor: { kind: 'main-process-system' },
      requestId: 'sys-schedule-missing-scope',
      expectedSessionVersion: approved.value.sessionVersion,
      intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId } as Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.schedule' }>,
    })).resolves.toMatchObject({ ok: false, error: { code: 'ILLEGAL_TRANSITION' } })
    await expect(app.executeSystem({
      contractVersion: 'm2b.v1',
      address: ADDRESS,
      trustedActor: { kind: 'main-process-system' },
      requestId: 'sys-schedule-empty-scope',
      expectedSessionVersion: approved.value.sessionVersion,
      intent: {
        type: 'system.schedule',
        flowId: draftProjection.value.activeFlow.flowId,
        authorizationScope: {
          version: 1,
          pathTokens: [],
          scopeDigest: `sha256:${'0'.repeat(64)}` as TaskFileAuthorizationScopeV1['scopeDigest'],
        },
      },
    })).resolves.toMatchObject({ ok: false, error: { code: 'ILLEGAL_TRANSITION' } })
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({ attempts: 0, flow_execution_baselines: 0, composition_attempts: 0 })
    store.close()
    app.close()
  })

  it('maps runtime preflight throws to AGENT_UNAVAILABLE with zero M2B execution writes', async () => {
    const dbPath = await tempDb()
    let index = 0
    const app = createCollaborationHubApplicationV1({
      lookup: lookup('CODING'),
      storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
      agentRuntime: {
        discover: async () => {
          throw new Error('discover failed')
        },
      } as never,
      baselineProvider: { capture: async () => scriptedBaseline() },
      idFactory: (prefix) => ['xhbf_flow', 'xhbr_rev', 'xhbts_scope', 'xhbts_journal', 'xhbts_projection', 'xhbtr_scope', 'xhbtr_journal', 'xhbtr_projection'][index++] ?? `${prefix}_${index}`,
    })
    await start(app)
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
    await execute(app, {
      requestId: 'req-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    const approved = await app.observeM2B(ADDRESS)
    await expect(
      executeSystem(app, {
        requestId: 'sys-schedule-throw',
        expectedSessionVersion: approved.ok ? approved.value.sessionVersion : 0,
        intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'AGENT_UNAVAILABLE' } })
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({ attempts: 0, flow_execution_baselines: 0, workspace_prepare_outbox: 0 })
    store.close()
    app.close()
  })

  it('replays a successful system.schedule after runtime becomes unavailable', async () => {
    const dbPath = await tempDb()
    const ids = ['xhbf_flow', 'xhbr_rev', 'xhbts_scope', 'xhbts_journal', 'xhbts_projection', 'xhbtr_scope', 'xhbtr_journal', 'xhbtr_projection', 'xhba_attempt']
    const app = appFor(dbPath, 'CODING', ids, 'runtime-1')
    await start(app)
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
    await execute(app, {
      requestId: 'req-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    const approved = await app.observeM2B(ADDRESS)
    const scheduleRequest = {
      requestId: 'sys-schedule-replay',
      expectedSessionVersion: approved.ok ? approved.value.sessionVersion : 0,
      intent: { type: 'system.schedule' as const, flowId: draftProjection.value.activeFlow.flowId },
    }
    const first = await executeSystem(app, scheduleRequest)
    app.close()

    const unavailable = appFor(dbPath, 'CODING')
    await expect(executeSystem(unavailable, scheduleRequest)).resolves.toEqual(first)
    await expect(
      executeSystem(unavailable, {
        ...scheduleRequest,
        intent: { type: 'system.schedule', flowId: 'xhbf_other' as FlowId },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } })
    unavailable.close()
  })

  it('atomically replays the same schedule across two applications sharing one SQLite database', async () => {
    const dbPath = await tempDb('schedule-cross-application.sqlite')
    const setup = appFor(dbPath, 'CODING', [
      'xhbf_atomic_flow',
      'xhbr_atomic_rev',
      'xhbts_atomic_scope',
      'xhbts_atomic_journal',
      'xhbts_atomic_projection',
      'xhbtr_atomic_scope',
      'xhbtr_atomic_journal',
      'xhbtr_atomic_projection',
    ])
    await start(setup, 'req-atomic-start')
    const draftProjection = await setup.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) {
      throw new Error('expected draft flow')
    }
    await execute(setup, {
      requestId: 'req-atomic-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    setup.close()

    const firstApp = appFor(dbPath, 'CODING', ['xhba_atomic_first'], 'runtime-atomic-first')
    const secondApp = appFor(dbPath, 'CODING', ['xhba_atomic_second'], 'runtime-atomic-second')
    const request = {
      requestId: 'sys-schedule-atomic',
      intent: {
        type: 'system.schedule' as const,
        flowId: draftProjection.value.activeFlow.flowId,
        authorizationScope: authorizationScope('src/atomic.ts'),
        executionInputDigest: `sha256:${'a'.repeat(64)}` as never,
      },
    }

    try {
      const [first, second] = await Promise.all([
        executeSystem(firstApp, request),
        executeSystem(secondApp, request),
      ])

      expect(first).toEqual(second)
      expect(first).toMatchObject({ ok: true, value: { requestId: request.requestId } })
      const store = new CollaborationHubSqliteStoreV1(dbPath)
      try {
        expect(store.tableCounts()).toMatchObject({ attempts: 1, execution_waves: 1, composition_attempts: 1 })
      } finally {
        store.close()
      }
      await expect(executeSystem(secondApp, {
        ...request,
        intent: {
          ...request.intent,
          authorizationScope: authorizationScope('src/different.ts'),
        },
      })).resolves.toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } })
    } finally {
      firstApp.close()
      secondApp.close()
    }
  })

  it('reuses an immutable flow baseline when scheduling a later task with the same provider facts', async () => {
    const dbPath = await tempDb()
    const baseline = scriptedBaseline()
    const app = appForBaselines(dbPath, [baseline, baseline])
    await start(app, 'req-start', twoIndependentTasksDraft())
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
    await execute(app, {
      requestId: 'req-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })

    const approved = await app.observeM2B(ADDRESS)
    await executeSystem(app, {
      requestId: 'sys-schedule-first',
      expectedSessionVersion: approved.ok ? approved.value.sessionVersion : 0,
      intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
    })
    const firstScheduled = await app.observeM2B(ADDRESS)
    if (!firstScheduled.ok || !firstScheduled.value.attempts[0]) throw new Error('missing first attempt')
    const firstAttempt = firstScheduled.value.attempts[0]
    const firstBaselineRow = flowBaselineRow(dbPath, draftProjection.value.activeFlow.flowId)
    const firstBinding = workspaceBinding(dbPath, firstAttempt.attemptId)
    await executeSystem(app, {
      requestId: 'sys-workspace-first-failed',
      expectedSessionVersion: firstScheduled.value.sessionVersion,
      intent: {
        type: 'system.workspace.prepare.result.record',
        flowId: draftProjection.value.activeFlow.flowId,
        taskRunId: firstAttempt.taskRunId,
        attemptId: firstAttempt.attemptId,
        receipt: {
          status: 'FAILED',
          workspaceReceiptId: 'xhbw_first_failed' as WorkspaceReceiptId,
          receiptDigest: 'sha256:first-workspace-failed',
          failure: { kind: 'WORKTREE_CREATE_FAILED', failureDigest: 'sha256:first-worktree-failed' },
          ...firstBinding,
        },
      },
    })

    const afterFailure = await app.observeM2B(ADDRESS)
    await executeSystem(app, {
      requestId: 'sys-schedule-second',
      expectedSessionVersion: afterFailure.ok ? afterFailure.value.sessionVersion : 0,
      intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
    })
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: {
        attempts: [
          expect.objectContaining({ status: 'FAILED' }),
          expect.objectContaining({ status: 'WORKSPACE_PREPARING' }),
        ],
      },
    })
    expect(flowBaselineRow(dbPath, draftProjection.value.activeFlow.flowId)).toEqual(firstBaselineRow)
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({ flow_execution_baselines: 1, attempts: 2, composition_attempts: 2, workspace_prepare_outbox: 2 })
    store.close()
    app.close()
  })

  it('schedules independent work in parallel waves up to two and freezes each Attempt runtime binding', async () => {
    const dbPath = await tempDb()
    const baseline = scriptedBaseline()
    const app = appForBaselines(dbPath, [baseline, baseline, baseline])
    await start(app, 'req-start-wave', threeIndependentTasksDraft())
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
    await execute(app, {
      requestId: 'req-approve-wave',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    const approved = await app.observeM2B(ADDRESS)
    if (!approved.ok) throw new Error('expected approved projection')
    const [first, second] = await Promise.all([
      executeSystem(app, {
        requestId: 'sys-wave-first',
        intent: {
          type: 'system.schedule',
          flowId: draftProjection.value.activeFlow.flowId,
          authorizationScope: authorizationScope('src/first.ts'),
          executionInputDigest: `sha256:${'1'.repeat(64)}` as never,
        },
      }),
      executeSystem(app, {
        requestId: 'sys-wave-second',
        intent: {
          type: 'system.schedule',
          flowId: draftProjection.value.activeFlow.flowId,
          authorizationScope: authorizationScope('src/second.ts'),
          executionInputDigest: `sha256:${'2'.repeat(64)}` as never,
        },
      }),
    ])
    if (!first.ok) throw new Error(`first wave failed: ${JSON.stringify(first.error)}`)
    if (!second.ok) throw new Error(`second wave failed: ${JSON.stringify(second.error)}`)
    expect(first.value.taskRunId).not.toBe(second.value.taskRunId)
    expect(first).toMatchObject({ ok: true, value: { executionWave: { version: 1, maxParallelism: 2 } } })
    const afterSecond = await app.observeM2B(ADDRESS)
    if (!afterSecond.ok) throw new Error(`expected parallel projection: ${JSON.stringify(afterSecond.error)}`)
    expect(afterSecond.value.attempts.find((attempt) => attempt.taskRunId === first.value.taskRunId)?.runtimeBinding).toMatchObject({
      version: 1,
      taskRunId: first.value.taskRunId,
      executionInputDigest: `sha256:${'1'.repeat(64)}`,
      selection: { adapterId: 'fake-approved' },
    })
    expect(afterSecond.value.attempts.find((attempt) => attempt.taskRunId === second.value.taskRunId)?.runtimeBinding).toMatchObject({
      version: 1,
      taskRunId: second.value.taskRunId,
      executionInputDigest: `sha256:${'2'.repeat(64)}`,
      selection: { adapterId: 'fake-approved' },
    })
    await expect(executeSystem(app, {
      requestId: 'sys-wave-third',
      expectedSessionVersion: afterSecond.ok ? afterSecond.value.sessionVersion : 0,
      intent: {
        type: 'system.schedule',
        flowId: draftProjection.value.activeFlow.flowId,
        authorizationScope: authorizationScope('src/third.ts'),
      },
    })).resolves.toMatchObject({ ok: false, error: { code: 'ILLEGAL_TRANSITION' } })
    app.close()

    const restartedStore = new CollaborationHubSqliteStoreV1(dbPath)
    restartedStore.readProjectionM2B(ADDRESS)
    restartedStore.close()
    const reopened = appForBaselines(dbPath, [baseline])
    const restored = await reopened.observeM2B(ADDRESS)
    if (!restored.ok) throw new Error(`reopen failed: ${JSON.stringify(restored.error)}`)
    expect(restored.value.attempts).toHaveLength(2)
    expect(restored.value.attempts.every((attempt) => attempt.runtimeBinding?.selection.adapterId === 'fake-approved')).toBe(true)
    reopened.close()
  })

  it('schedules the requested READY TaskRun instead of silently substituting the first READY task', async () => {
    const dbPath = await tempDb()
    const baseline = scriptedBaseline()
    const app = appForBaselines(dbPath, [baseline])
    await start(app, 'req-start-targeted', twoIndependentTasksDraft())
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) {
      throw new Error('expected draft flow')
    }
    await execute(app, {
      requestId: 'req-approve-targeted',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    const approved = await app.observeM2B(ADDRESS)
    if (!approved.ok) throw new Error('expected approved projection')
    const targetTaskRunId = approved.value.taskRuns.find((task) => task.taskKey === 'second')?.taskRunId
    if (!targetTaskRunId) throw new Error('expected second TaskRun')

    await expect(executeSystem(app, {
      requestId: 'sys-target-second',
      intent: {
        type: 'system.schedule',
        flowId: draftProjection.value.activeFlow.flowId,
        authorizationScope: authorizationScope('src/second.ts'),
        targetTaskRunId,
      },
    })).resolves.toMatchObject({ ok: true, value: { taskRunId: targetTaskRunId } })
    app.close()
  })

  it('serializes an overlapping file authorization scope without blocking disjoint work', async () => {
    const dbPath = await tempDb()
    const baseline = scriptedBaseline()
    const app = appForBaselines(dbPath, [baseline, baseline, baseline])
    await start(app, 'req-start-scope', twoIndependentTasksDraft())
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
    await execute(app, {
      requestId: 'req-approve-scope',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    const approved = await app.observeM2B(ADDRESS)
    const sharedScope = authorizationScope('src/shared.ts')
    await executeSystem(app, {
      requestId: 'sys-scope-first',
      expectedSessionVersion: approved.ok ? approved.value.sessionVersion : 0,
      intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId, authorizationScope: sharedScope },
    })
    const afterFirst = await app.observeM2B(ADDRESS)
    await expect(executeSystem(app, {
      requestId: 'sys-scope-overlap',
      expectedSessionVersion: afterFirst.ok ? afterFirst.value.sessionVersion : 0,
      intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId, authorizationScope: sharedScope },
    })).resolves.toMatchObject({ ok: false, error: { code: 'ILLEGAL_TRANSITION' } })
    const disjoint = await executeSystem(app, {
      requestId: 'sys-scope-disjoint',
      expectedSessionVersion: afterFirst.ok ? afterFirst.value.sessionVersion : 0,
      intent: {
        type: 'system.schedule',
        flowId: draftProjection.value.activeFlow.flowId,
        authorizationScope: authorizationScope('src/disjoint.ts'),
      },
    })
    if (!disjoint.ok) throw new Error(`disjoint wave failed: ${JSON.stringify(disjoint.error)}`)
    expect(disjoint).toMatchObject({ ok: true })
    app.close()
  })

  it('rejects a later schedule when the provider baseline drifts and leaves persisted baseline state unchanged', async () => {
    const dbPath = await tempDb()
    const app = appForBaselines(dbPath, [scriptedBaseline('1'), scriptedBaseline('2')])
    await start(app, 'req-start', twoIndependentTasksDraft())
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
    await execute(app, {
      requestId: 'req-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })

    const approved = await app.observeM2B(ADDRESS)
    await executeSystem(app, {
      requestId: 'sys-schedule-first',
      expectedSessionVersion: approved.ok ? approved.value.sessionVersion : 0,
      intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
    })
    const firstScheduled = await app.observeM2B(ADDRESS)
    if (!firstScheduled.ok || !firstScheduled.value.attempts[0]) throw new Error('missing first attempt')
    const firstAttempt = firstScheduled.value.attempts[0]
    const firstBinding = workspaceBinding(dbPath, firstAttempt.attemptId)
    await executeSystem(app, {
      requestId: 'sys-workspace-first-failed',
      expectedSessionVersion: firstScheduled.value.sessionVersion,
      intent: {
        type: 'system.workspace.prepare.result.record',
        flowId: draftProjection.value.activeFlow.flowId,
        taskRunId: firstAttempt.taskRunId,
        attemptId: firstAttempt.attemptId,
        receipt: {
          status: 'FAILED',
          workspaceReceiptId: 'xhbw_first_failed' as WorkspaceReceiptId,
          receiptDigest: 'sha256:first-workspace-failed',
          failure: { kind: 'WORKTREE_CREATE_FAILED', failureDigest: 'sha256:first-worktree-failed' },
          ...firstBinding,
        },
      },
    })

    const beforeDrift = await app.observeM2B(ADDRESS)
    const oldBaselineRow = flowBaselineRow(dbPath, draftProjection.value.activeFlow.flowId)
    const storeBefore = new CollaborationHubSqliteStoreV1(dbPath)
    const beforeCounts = storeBefore.tableCounts()
    const beforeVersion = storeBefore.currentVersion(ADDRESS)
    storeBefore.close()
    await expect(
      executeSystem(app, {
        requestId: 'sys-schedule-drift',
        expectedSessionVersion: beforeDrift.ok ? beforeDrift.value.sessionVersion : 0,
        intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'BASELINE_CONFLICT' } })
    const storeAfter = new CollaborationHubSqliteStoreV1(dbPath)
    expect(storeAfter.tableCounts()).toEqual(beforeCounts)
    expect(storeAfter.currentVersion(ADDRESS)).toBe(beforeVersion)
    storeAfter.close()
    expect(flowBaselineRow(dbPath, draftProjection.value.activeFlow.flowId)).toEqual(oldBaselineRow)
    app.close()
  })

  it('records PREPARED workspace result as Attempt READY without completing the TaskRun', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath, 'CODING', ['xhbf_flow', 'xhbr_rev', 'xhbts_scope', 'xhbts_journal', 'xhbts_projection', 'xhbtr_scope', 'xhbtr_journal', 'xhbtr_projection', 'xhba_attempt'], 'runtime-1')
    await start(app)
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
    await execute(app, {
      requestId: 'req-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    const before = await app.observeM2B(ADDRESS)
    await executeSystem(app, {
      requestId: 'sys-schedule-1',
      expectedSessionVersion: before.ok ? before.value.sessionVersion : 0,
      intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
    })
    const scheduled = await app.observeM2B(ADDRESS)
    const binding = workspaceBinding(dbPath, 'xhba_attempt' as AttemptId)
    claimWorkspacePreparation(dbPath, 'xhba_attempt' as AttemptId)
    await executeSystem(app, {
      requestId: 'sys-workspace-1',
      expectedSessionVersion: scheduled.ok ? scheduled.value.sessionVersion : 0,
      intent: {
        type: 'system.workspace.prepare.result.record',
        flowId: draftProjection.value.activeFlow.flowId,
        taskRunId: 'xhbtr_projection' as TaskRunId,
        attemptId: 'xhba_attempt' as AttemptId,
        receipt: {
          status: 'PREPARED',
          workspaceReceiptId: 'xhbw_receipt' as WorkspaceReceiptId,
          receiptDigest: 'sha256:workspace',
          ...binding,
        },
      },
    })

    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: {
        taskRuns: expect.arrayContaining([expect.objectContaining({ taskKey: 'scope', status: 'READY' })]),
        attempts: [expect.objectContaining({ attemptId: 'xhba_attempt', status: 'READY', workspaceReceiptId: 'xhbw_receipt' })],
      },
    })
    expect(journalPayloads(dbPath, 'system.workspace.prepare.result.record')).toMatchObject([
      { phase: 'attempt.transition', from: 'WORKSPACE_PREPARING', to: 'READY' },
    ])
    app.close()
  })

  it('rejects an unclaimed workspace result when a workspace bridge is configured', async () => {
    const dbPath = await tempDb()
    const baseline = scriptedBaseline()
    const app = appFor(
      dbPath,
      'CODING',
      ['xhbf_flow', 'xhbr_rev', 'xhbts_scope', 'xhbts_journal', 'xhbts_projection', 'xhbtr_scope', 'xhbtr_journal', 'xhbtr_projection', 'xhba_attempt'],
      'runtime-1',
      testWorkspaceBridge(baseline),
    )
    const scheduled = await scheduleWorkspaceAttempt(app)
    const binding = workspaceBinding(dbPath, scheduled.attempt.attemptId)

    await expect(
      executeSystem(app, {
        requestId: 'sys-workspace-unclaimed',
        expectedSessionVersion: scheduled.sessionVersion,
        intent: {
          type: 'system.workspace.prepare.result.record',
          flowId: scheduled.flowId,
          taskRunId: scheduled.attempt.taskRunId,
          attemptId: scheduled.attempt.attemptId,
          receipt: {
            status: 'PREPARED',
            workspaceReceiptId: 'xhbw_unclaimed' as WorkspaceReceiptId,
            receiptDigest: 'sha256:unclaimed-workspace',
            ...binding,
          },
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'ILLEGAL_TRANSITION' } })
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { sessionVersion: scheduled.sessionVersion, attempts: [expect.objectContaining({ status: 'WORKSPACE_PREPARING' })] },
    })
    app.close()
  })

  it('coalesces concurrent workspace preparation for the same Attempt inside one process', async () => {
    const dbPath = await tempDb()
    let releasePrepare!: () => void
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve
    })
    const bridge: ExecutionWorkspaceBridgeV1 = {
      prepare: vi.fn(async ({ attempt, composition }) => {
        await prepareGate
        return {
          status: 'PREPARED' as const,
          workspaceReceiptId: 'xhbw_coalesced' as WorkspaceReceiptId,
          receiptDigest: 'sha256:coalesced-workspace',
          compositionAttemptId: composition.compositionAttemptId,
          attemptId: attempt.attempt_id,
          requestDigest: composition.requestDigest,
          baselineBindingDigest: composition.baselineBindingDigest,
          compositionDigest: composition.compositionDigest,
        }
      }),
      runtimeWorkspace: () => undefined,
    }
    const app = appFor(
      dbPath,
      'CODING',
      ['xhbf_flow', 'xhbr_rev', 'xhbts_scope', 'xhbts_journal', 'xhbts_projection', 'xhbtr_scope', 'xhbtr_journal', 'xhbtr_projection', 'xhba_attempt'],
      'runtime-1',
      bridge,
    )
    const scheduled = await scheduleWorkspaceAttempt(app)
    const request = {
      requestId: 'sys-workspace-coalesced',
      attemptId: scheduled.attempt.attemptId,
      expectedSessionVersion: scheduled.sessionVersion,
    }

    const first = app.prepareNextWorkspace(ADDRESS, request)
    const second = app.prepareNextWorkspace(ADDRESS, request)
    await vi.waitFor(() => expect(bridge.prepare).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    releasePrepare()
    const outcomes = await Promise.all([first, second])

    expect(bridge.prepare).toHaveBeenCalledTimes(1)
    expect(outcomes[0]).toMatchObject({ ok: true })
    expect(outcomes[1]).toEqual(outcomes[0])
    app.close()
  })

  it('records a bound FAILED workspace receipt when the private bridge throws instead of leaving the Attempt preparing', async () => {
    const dbPath = await tempDb()
    const bridge: ExecutionWorkspaceBridgeV1 = {
      prepare: vi.fn(async () => {
        throw Object.assign(new Error('private path must not escape'), { reasonCode: 'ATTEMPT_INPUT_MISSING' })
      }),
      runtimeWorkspace: () => undefined,
    }
    const app = appFor(
      dbPath,
      'CODING',
      ['xhbf_flow', 'xhbr_rev', 'xhbts_scope', 'xhbts_journal', 'xhbts_projection', 'xhbtr_scope', 'xhbtr_journal', 'xhbtr_projection', 'xhba_attempt'],
      'runtime-1',
      bridge,
    )
    const scheduled = await scheduleWorkspaceAttempt(app)

    await expect(app.prepareNextWorkspace(ADDRESS, {
      requestId: 'sys-workspace-bridge-failed',
      attemptId: scheduled.attempt.attemptId,
      expectedSessionVersion: scheduled.sessionVersion,
    })).resolves.toMatchObject({ ok: true })
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: {
        taskRuns: expect.arrayContaining([expect.objectContaining({ status: 'FAILED' })]),
        attempts: [expect.objectContaining({ status: 'FAILED' })],
      },
    })
    expect(JSON.stringify(journalPayloads(dbPath, 'system.workspace.prepare.result.record'))).not.toContain('private path')
    app.close()
  })

  it('rejects workspace receipt drift for each persisted composition binding field', async () => {
    const fields = ['attemptId', 'compositionAttemptId', 'requestDigest', 'baselineBindingDigest', 'compositionDigest'] as const
    for (const field of fields) {
      const dbPath = await tempDb(`workspace-drift-${field}.sqlite`)
      const app = appFor(dbPath, 'CODING', ['xhbf_flow', 'xhbr_rev', 'xhbts_scope', 'xhbts_journal', 'xhbts_projection', 'xhbtr_scope', 'xhbtr_journal', 'xhbtr_projection', 'xhba_attempt'], 'runtime-1')
      await start(app)
      const draftProjection = await app.observe(ADDRESS)
      if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
      await execute(app, {
        requestId: 'req-approve',
        expectedSessionVersion: draftProjection.value.sessionVersion,
        intent: {
          type: 'plan.revision.submit',
          flowId: draftProjection.value.activeFlow.flowId,
          baseRevisionId: draftProjection.value.activeRevision.revisionId,
          draft: draftProjection.value.activeRevision.draft,
        },
      })
      const before = await app.observeM2B(ADDRESS)
      await executeSystem(app, {
        requestId: 'sys-schedule-1',
        expectedSessionVersion: before.ok ? before.value.sessionVersion : 0,
        intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
      })
      const scheduled = await app.observeM2B(ADDRESS)
      const binding = workspaceBinding(dbPath, 'xhba_attempt' as AttemptId)
      claimWorkspacePreparation(dbPath, 'xhba_attempt' as AttemptId)
      const drifted = { ...binding, [field]: field === 'attemptId' ? ('xhba_drift' as AttemptId) : 'sha256:drift' }
      await expect(
        executeSystem(app, {
          requestId: `sys-workspace-drift-${field}`,
          expectedSessionVersion: scheduled.ok ? scheduled.value.sessionVersion : 0,
          intent: {
            type: 'system.workspace.prepare.result.record',
            flowId: draftProjection.value.activeFlow.flowId,
            taskRunId: 'xhbtr_projection' as TaskRunId,
            attemptId: 'xhba_attempt' as AttemptId,
            receipt: { status: 'PREPARED', workspaceReceiptId: 'xhbw_receipt' as WorkspaceReceiptId, receiptDigest: 'sha256:workspace', ...drifted },
          },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'WORKSPACE_RECEIPT_MISMATCH' } })
      await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({ ok: true, value: { sessionVersion: scheduled.ok ? scheduled.value.sessionVersion : 0 } })
      app.close()
    }
  })

  it('records fake agent report as Attempt RUNNING without Verification or ChangeSet side effects', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath, 'CODING', ['xhbf_flow', 'xhbr_rev', 'xhbts_scope', 'xhbts_journal', 'xhbts_projection', 'xhbtr_scope', 'xhbtr_journal', 'xhbtr_projection', 'xhba_attempt'], 'runtime-1')
    await start(app)
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
    await execute(app, {
      requestId: 'req-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    const before = await app.observeM2B(ADDRESS)
    await executeSystem(app, {
      requestId: 'sys-schedule-1',
      expectedSessionVersion: before.ok ? before.value.sessionVersion : 0,
      intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
    })
    const scheduled = await app.observeM2B(ADDRESS)
    const binding = workspaceBinding(dbPath, 'xhba_attempt' as AttemptId)
    claimWorkspacePreparation(dbPath, 'xhba_attempt' as AttemptId)
    await executeSystem(app, {
      requestId: 'sys-workspace-1',
      expectedSessionVersion: scheduled.ok ? scheduled.value.sessionVersion : 0,
      intent: {
        type: 'system.workspace.prepare.result.record',
        flowId: draftProjection.value.activeFlow.flowId,
        taskRunId: 'xhbtr_projection' as TaskRunId,
        attemptId: 'xhba_attempt' as AttemptId,
        receipt: {
          status: 'PREPARED',
          workspaceReceiptId: 'xhbw_receipt' as WorkspaceReceiptId,
          receiptDigest: 'sha256:workspace',
          ...binding,
        },
      },
    })
    const ready = await app.observeM2B(ADDRESS)
    await expect(executeSystem(app, {
      requestId: 'sys-agent-report-1',
      expectedSessionVersion: ready.ok ? ready.value.sessionVersion : 0,
      intent: {
        type: 'system.agent.report.record',
        flowId: draftProjection.value.activeFlow.flowId,
        taskRunId: 'xhbtr_projection' as TaskRunId,
        attemptId: 'xhba_attempt' as AttemptId,
      },
    })).resolves.toMatchObject({ ok: true })

    const publicRunning = await app.observeM2B(ADDRESS)
    expect(publicRunning).toMatchObject({
      ok: true,
      value: {
        taskRuns: expect.arrayContaining([expect.objectContaining({ taskKey: 'scope', status: 'RUNNING' })]),
        attempts: [expect.objectContaining({ attemptId: 'xhba_attempt', status: 'RUNNING' })],
      },
    })
    if (!publicRunning.ok) throw new Error('missing public running projection')
    expect(publicRunning.value.attempts[0]).not.toHaveProperty('runtimeSessionId')
    expect(journalPayloads(dbPath, 'system.agent.report.record')).toMatchObject([
      { phase: 'dispatch.outbox_persisted', attemptId: 'xhba_attempt' },
      { phase: 'attempt.transition', from: 'READY', to: 'STARTING' },
      { phase: 'attempt.transition', from: 'STARTING', to: 'RUNNING', runtimeSessionId: 'runtime-1' },
    ])
    app.close()
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({ agent_dispatch_outbox: 1, runtime_session_bindings: 1, workspace_receipts: 1 })
    expect(store.attempt('xhba_attempt' as AttemptId)).toMatchObject({ runtime_session_id: 'runtime-1' })
    store.close()
  })

  it('records OUTCOME_UNKNOWN without side effects and releases it only after its flow is cancelled', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath, 'CODING', [
      'xhbf_flow',
      'xhbr_rev',
      'xhbts_scope',
      'xhbts_journal',
      'xhbts_projection',
      'xhbtr_scope',
      'xhbtr_journal',
      'xhbtr_projection',
      'xhba_attempt',
      'xhbf_replacement',
      'xhbr_replacement',
      'xhbts_replacement_scope',
      'xhbts_replacement_journal',
      'xhbts_replacement_projection',
      'xhbtr_replacement_scope',
      'xhbtr_replacement_journal',
      'xhbtr_replacement_projection',
      'xhba_replacement',
    ], 'runtime-1')
    await start(app)
    const draftProjection = await app.observe(ADDRESS)
    if (!draftProjection.ok || !draftProjection.value.activeFlow || !draftProjection.value.activeRevision) throw new Error('expected draft flow')
    await execute(app, {
      requestId: 'req-approve',
      expectedSessionVersion: draftProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: draftProjection.value.activeFlow.flowId,
        baseRevisionId: draftProjection.value.activeRevision.revisionId,
        draft: draftProjection.value.activeRevision.draft,
      },
    })
    const before = await app.observeM2B(ADDRESS)
    await executeSystem(app, {
      requestId: 'sys-schedule-1',
      expectedSessionVersion: before.ok ? before.value.sessionVersion : 0,
      intent: { type: 'system.schedule', flowId: draftProjection.value.activeFlow.flowId },
    })
    const scheduled = await app.observeM2B(ADDRESS)
    const binding = workspaceBinding(dbPath, 'xhba_attempt' as AttemptId)
    claimWorkspacePreparation(dbPath, 'xhba_attempt' as AttemptId)
    await executeSystem(app, {
      requestId: 'sys-workspace-1',
      expectedSessionVersion: scheduled.ok ? scheduled.value.sessionVersion : 0,
      intent: {
        type: 'system.workspace.prepare.result.record',
        flowId: draftProjection.value.activeFlow.flowId,
        taskRunId: 'xhbtr_projection' as TaskRunId,
        attemptId: 'xhba_attempt' as AttemptId,
        receipt: {
          status: 'PREPARED',
          workspaceReceiptId: 'xhbw_receipt' as WorkspaceReceiptId,
          receiptDigest: 'sha256:workspace',
          ...binding,
        },
      },
    })
    const ready = await app.observeM2B(ADDRESS)
    await expect(executeSystem(app, {
      requestId: 'sys-agent-report-1',
      expectedSessionVersion: ready.ok ? ready.value.sessionVersion : 0,
      intent: {
        type: 'system.agent.report.record',
        flowId: draftProjection.value.activeFlow.flowId,
        taskRunId: 'xhbtr_projection' as TaskRunId,
        attemptId: 'xhba_attempt' as AttemptId,
      },
    })).resolves.toMatchObject({ ok: true })
    const running = await app.observeM2B(ADDRESS)
    await expect(
      executeSystem(app, {
        requestId: 'sys-agent-failed-without-signal',
        expectedSessionVersion: running.ok ? running.value.sessionVersion : 0,
        intent: {
          type: 'system.agent.outcome.record',
          flowId: draftProjection.value.activeFlow.flowId,
          taskRunId: 'xhbtr_projection' as TaskRunId,
          attemptId: 'xhba_attempt' as AttemptId,
          runtimeSessionId: 'runtime-1',
          outcome: 'FAILED',
          receiptDigest: 'sha256:failed-no-signal',
        } as never,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'ILLEGAL_TRANSITION' } })
    await expect(
      executeSystem(app, {
        requestId: 'sys-agent-unknown-with-signal',
        expectedSessionVersion: running.ok ? running.value.sessionVersion : 0,
        intent: {
          type: 'system.agent.outcome.record',
          flowId: draftProjection.value.activeFlow.flowId,
          taskRunId: 'xhbtr_projection' as TaskRunId,
          attemptId: 'xhba_attempt' as AttemptId,
          runtimeSessionId: 'runtime-1',
          outcome: 'OUTCOME_UNKNOWN',
          receiptDigest: 'sha256:unknown-with-signal',
          failure: { kind: 'AGENT_FAILURE', failureClass: 'RUNTIME', safeCode: 'RUNTIME_FAILED', receiptDigest: 'sha256:unknown-with-signal' },
        } as never,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'ILLEGAL_TRANSITION' } })
    await executeSystem(app, {
      requestId: 'sys-agent-outcome-unknown-1',
      expectedSessionVersion: running.ok ? running.value.sessionVersion : 0,
      intent: {
        type: 'system.agent.outcome.record',
        flowId: draftProjection.value.activeFlow.flowId,
        taskRunId: 'xhbtr_projection' as TaskRunId,
        attemptId: 'xhba_attempt' as AttemptId,
        runtimeSessionId: 'runtime-1',
        outcome: 'OUTCOME_UNKNOWN',
        receiptDigest: 'sha256:unknown-receipt',
      },
    })

    const publicUnknown = await app.observeM2B(ADDRESS)
    expect(publicUnknown).toMatchObject({
      ok: true,
      value: {
        taskRuns: expect.arrayContaining([expect.objectContaining({ taskKey: 'scope', status: 'OUTCOME_UNKNOWN' })]),
        attempts: [expect.objectContaining({ attemptId: 'xhba_attempt', status: 'OUTCOME_UNKNOWN' })],
      },
    })
    if (!publicUnknown.ok) throw new Error('missing public unknown projection')
    expect(publicUnknown.value.attempts[0]).not.toHaveProperty('runtimeSessionId')
    const privateUnknownStore = new CollaborationHubSqliteStoreV1(dbPath)
    try {
      expect(privateUnknownStore.attempt('xhba_attempt' as AttemptId)).toMatchObject({ runtime_session_id: 'runtime-1' })
    } finally {
      privateUnknownStore.close()
    }
    expect(journalPayloads(dbPath, 'system.agent.outcome.record')).toMatchObject([
      { phase: 'attempt.transition', to: 'OUTCOME_UNKNOWN', receiptDigest: 'sha256:unknown-receipt' },
    ])
    const unknown = await app.observeM2B(ADDRESS)
    await expect(
      executeSystem(app, {
        requestId: 'sys-agent-reconcile-drift',
        expectedSessionVersion: unknown.ok ? unknown.value.sessionVersion : 0,
        intent: {
          type: 'system.agent.reconcile',
          attemptId: 'xhba_attempt' as AttemptId,
          runtimeSessionId: 'runtime-1',
          expectedReceiptDigest: 'sha256:wrong-receipt',
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } })
    await executeSystem(app, {
      requestId: 'sys-agent-reconcile-1',
      expectedSessionVersion: unknown.ok ? unknown.value.sessionVersion : 0,
      intent: {
        type: 'system.agent.reconcile',
        attemptId: 'xhba_attempt' as AttemptId,
        runtimeSessionId: 'runtime-1',
        expectedReceiptDigest: 'sha256:unknown-receipt',
      },
    })
    expect(journalPayloads(dbPath, 'system.agent.reconcile')).toMatchObject([
      { phase: 'outcome_unknown.reconciled', attemptId: 'xhba_attempt', expectedReceiptDigest: 'sha256:unknown-receipt', outcome: 'OUTCOME_UNKNOWN' },
    ])
    const activeUnknownStore = new CollaborationHubSqliteStoreV1(dbPath)
    try {
      expect(activeUnknownStore.schedulerAttempts(ADDRESS.projectId)).toEqual([
        expect.objectContaining({ attemptId: 'xhba_attempt', status: 'OUTCOME_UNKNOWN' }),
      ])
    } finally {
      activeUnknownStore.close()
    }

    const beforeCancel = await app.observe(ADDRESS)
    if (!beforeCancel.ok || !beforeCancel.value.activeFlow) throw new Error('expected active unknown flow')
    await expect(execute(app, {
      requestId: 'req-cancel-unknown',
      expectedSessionVersion: beforeCancel.value.sessionVersion,
      intent: {
        type: 'flow.cancel',
        flowId: beforeCancel.value.activeFlow.flowId,
        reason: 'replace abandoned outcome-unknown flow',
      },
    })).resolves.toMatchObject({ ok: true })
    const cancelledUnknownStore = new CollaborationHubSqliteStoreV1(dbPath)
    try {
      expect(cancelledUnknownStore.schedulerAttempts(ADDRESS.projectId)).toEqual([])
    } finally {
      cancelledUnknownStore.close()
    }

    await expect(start(app, 'req-start-replacement')).resolves.toMatchObject({
      ok: true,
      value: { flowId: 'xhbf_replacement', revisionId: 'xhbr_replacement' },
    })
    const replacementDraft = await app.observe(ADDRESS)
    if (!replacementDraft.ok || !replacementDraft.value.activeFlow || !replacementDraft.value.activeRevision) {
      throw new Error('expected replacement draft flow')
    }
    await expect(execute(app, {
      requestId: 'req-approve-replacement',
      expectedSessionVersion: replacementDraft.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: replacementDraft.value.activeFlow.flowId,
        baseRevisionId: replacementDraft.value.activeRevision.revisionId,
        draft: replacementDraft.value.activeRevision.draft,
      },
    })).resolves.toMatchObject({ ok: true })

    const replacementReady = await app.observeM2B(ADDRESS)
    expect(replacementReady).toMatchObject({
      ok: true,
      value: {
        availableActions: expect.arrayContaining(['execution.next.confirm']),
        attempts: [],
      },
    })
    await expect(executeSystem(app, {
      requestId: 'sys-schedule-replacement',
      expectedSessionVersion: replacementReady.ok ? replacementReady.value.sessionVersion : 0,
      intent: {
        type: 'system.schedule',
        flowId: replacementDraft.value.activeFlow.flowId,
        authorizationScope: authorizationScope('test-default-schedule-scope'),
      },
    })).resolves.toMatchObject({
      ok: true,
      value: { flowId: 'xhbf_replacement', attemptId: 'xhba_replacement' },
    })
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: {
        attempts: [expect.objectContaining({ attemptId: 'xhba_replacement', status: 'WORKSPACE_PREPARING' })],
      },
    })
    app.close()
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({
      attempts: 2,
      flow_execution_baselines: 2,
      agent_dispatch_outbox: 1,
      runtime_session_bindings: 1,
      workspace_receipts: 1,
    })
    store.close()
  })

  it('rejects DESIGN system.schedule with zero SQLite writes', async () => {
    const dbPath = await tempDb()
    const app = appFor(dbPath, 'DESIGN')

    await expect(
      executeSystem(app, { requestId: 'sys-design', intent: { type: 'system.schedule', flowId: 'xhbf_flow' as FlowId } }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'DESIGN_RESERVED' } })
    expect(existsSync(dbPath)).toBe(false)
    app.close()
  })
