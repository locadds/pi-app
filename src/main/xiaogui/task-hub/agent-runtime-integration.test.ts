import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  InitialPlanDraftInputV1,
  TaskFileAuthorizationScopeV1,
  TaskRunId,
  WorkspaceReceiptId,
} from '@shared/xiaogui-collaboration-hub'
import type {
  RuntimeAdapterSelectionV1,
  RuntimeCapabilityV1,
  RuntimeCreateOrResumeOutcomeV1,
  RuntimeCreateOrResumeRequestV1,
  RuntimeOutcomeV1,
  RuntimeScopeBindingV1,
} from '@shared/xiaogui-agent-runtime'
import type { SessionAddressV1, SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import type { VerificationAttemptId } from '@shared/xiaogui-task-verification'
import { createAgentRuntimeHostV1 } from '../agent-runtime/runtime-host'
import { ScriptedAgentRuntimeAdapterV1 } from '../agent-runtime/scripted-adapter'
import { createCollaborationHubApplicationV1, type ExecutionWorkspaceBridgeV1, type RuntimePromptVaultV1 } from './application'
import { GitAttemptWorkspaceServiceV1, SqliteAttemptWorkspaceRegistryV1, digestBytes } from './attempt-workspace'
import { digestJson } from './digest'
import { PrivateRuntimePayloadVaultV1 } from './private-payload-vault'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'
import type { TaskVerificationCoordinatorV1, TaskVerificationSucceededInputV1 } from './task-verification-coordinator'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

function authorizationScope(label: string): TaskFileAuthorizationScopeV1 {
  const pathTokens = [`sha256:${digestJson({ label, role: 'authorization-path' })}` as TaskFileAuthorizationScopeV1['pathTokens'][number]]
  const base = { version: 1 as const, pathTokens }
  return { ...base, scopeDigest: `sha256:${digestJson(base)}` as TaskFileAuthorizationScopeV1['scopeDigest'] }
}

const approvedSelection: RuntimeAdapterSelectionV1 = {
  adapterId: 'fake-approved',
  runtimeKind: 'OTHER',
  protocol: 'HEADLESS',
  capabilityDigest: 'sha256:fake-approved',
  approvalStatus: 'APPROVED_FOR_PRODUCTION',
  diagnosticOnly: false,
  stream: 'POLL',
  interrupt: 'BEST_EFFORT',
  inspect: 'SNAPSHOT',
}

const diagnosticCapability: RuntimeCapabilityV1 = {
  ...approvedSelection,
  adapterId: 'fake-diagnostic',
  protocol: 'NON_INTERACTIVE_CLI_DIAGNOSTIC',
  approvalStatus: 'DISCOVERED',
  health: 'UNAVAILABLE',
  canCreateSession: false,
  canResumeSession: false,
  diagnosticOnly: true,
  stream: 'NONE',
  interrupt: 'NONE',
  inspect: 'NONE',
  interactivePermission: 'NONE',
}

const approvedCapability: RuntimeCapabilityV1 = {
  ...approvedSelection,
  health: 'AVAILABLE',
  canCreateSession: true,
  canResumeSession: true,
  interactivePermission: 'HOST_MEDIATED',
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDb(name = 'hub.sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-hub-m2b-runtime-'))
  roots.push(root)
  return join(root, name)
}

function writeSystemIdempotencyForTest(
  dbPath: string,
  reconcileStart: TaskVerificationSucceededInputV1['reconcileStart'],
): void {
  if (!reconcileStart) throw new Error('missing reconcile start')
  const db = new DatabaseSync(dbPath)
  try {
    const projection = db
      .prepare('select version from session_projection where project_id = ? and session_key = ?')
      .get(ADDRESS.projectId, ADDRESS.sessionKey) as { version: number } | undefined
    if (!projection) throw new Error('missing session projection')
    db.prepare(
      'insert into idempotency_keys (scope_key, request_id, command_type, payload_hash, receipt_json) values (?, ?, ?, ?, ?)',
    ).run(
      `${ADDRESS.projectId}:${ADDRESS.sessionKey}`,
      reconcileStart.idempotency.requestId,
      reconcileStart.idempotency.commandType,
      reconcileStart.idempotency.payloadHash,
      JSON.stringify({ ...reconcileStart.receipt, sessionVersion: projection.version }),
    )
  } finally {
    db.close()
  }
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
    objective: '验证 fake runtime 和 M2B 执行骨架',
    tasks: [{ taskKey: 'scope', title: '执行首个任务' }],
  }
}

async function readyAttempt(
  dbPath: string,
  capabilities: readonly RuntimeCapabilityV1[] = [approvedCapability],
  options: {
    afterAgentDispatchStart?: (requestId: string) => void
    createOutcome?: RuntimeCreateOrResumeOutcomeV1
    outcomesBySession?: Record<string, RuntimeOutcomeV1>
    taskVerificationCoordinator?: TaskVerificationCoordinatorV1
  } = {},
) {
  let id = 0
  const app = createCollaborationHubApplicationV1({
    lookup: lookup('CODING'),
    storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
    agentRuntime: createAgentRuntimeHostV1(new ScriptedAgentRuntimeAdapterV1({
      capabilities,
      createRuntimeSessionId: 'runtime-1',
      createOutcome: options.createOutcome,
      outcomesBySession: options.outcomesBySession,
    })),
    baselineProvider: { capture: async () => scriptedBaseline() },
    workspaceBridge: testWorkspaceBridge(scriptedBaseline()),
    runtimePromptVault: testPromptVault(),
    taskVerificationCoordinator: options.taskVerificationCoordinator,
    afterAgentDispatchStart: options.afterAgentDispatchStart,
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
  await app.execute({
    contractVersion: 'm2a.v1',
    address: ADDRESS,
    trustedActor: { kind: 'main-process-user' },
    requestId: 'req-approve',
    expectedSessionVersion: before.value.sessionVersion,
    intent: {
      type: 'plan.revision.submit',
      flowId: start.value.flowId,
      baseRevisionId: start.value.revisionId,
      draft: before.value.activeRevision.draft,
    },
  })
  const approved = await app.observeM2B(ADDRESS)
  const scheduled = await app.executeSystem({
    contractVersion: 'm2b.v1',
    address: ADDRESS as HubAddressV1,
    trustedActor: { kind: 'main-process-system' },
    requestId: 'sys-schedule',
    expectedSessionVersion: approved.ok ? approved.value.sessionVersion : 0,
    intent: {
      type: 'system.schedule',
      flowId: start.value.flowId as FlowId,
      authorizationScope: authorizationScope('src/value.txt'),
    },
  })
  if (!scheduled.ok || !scheduled.value.taskRunId || !scheduled.value.attemptId) throw new Error('schedule failed')
  const afterSchedule = await app.observeM2B(ADDRESS)
  const bindingStore = new CollaborationHubSqliteStoreV1(dbPath)
  const binding = bindingStore.compositionAttempt(scheduled.value.attemptId)
  const workspaceClaim = bindingStore.claimWorkspacePrepareOutbox({
    attemptId: scheduled.value.attemptId,
    ownerId: 'test-main-process',
    claimDigest: digestJson({ attemptId: scheduled.value.attemptId, role: 'test-workspace-claim' }),
    now: '2026-08-17T00:00:00.000Z',
  })
  bindingStore.close()
  if (!binding) throw new Error('missing workspace binding')
  if (!workspaceClaim) throw new Error('missing workspace prepare claim')
  await expect(app.executeSystem({
    contractVersion: 'm2b.v1',
    address: ADDRESS as HubAddressV1,
    trustedActor: { kind: 'main-process-system' },
    requestId: 'sys-workspace',
    expectedSessionVersion: afterSchedule.ok ? afterSchedule.value.sessionVersion : 0,
    intent: {
      type: 'system.workspace.prepare.result.record',
      flowId: start.value.flowId as FlowId,
      taskRunId: scheduled.value.taskRunId,
      attemptId: scheduled.value.attemptId,
      receipt: {
        status: 'PREPARED',
        workspaceReceiptId: 'xhbw_ready' as WorkspaceReceiptId,
        receiptDigest: 'sha256:workspace-ready',
        ...binding,
      },
    },
  })).resolves.toMatchObject({ ok: true })
  return { app, flowId: start.value.flowId as FlowId, taskRunId: scheduled.value.taskRunId, attemptId: scheduled.value.attemptId }
}

function scriptedBaseline() {
  const base = {
    baselineId: 'baseline-1',
    baselineTreeHash: 'sha256:baseline-tree',
    initialTargetFingerprint: 'sha256:initial-target',
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

async function gitRepo() {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-hub-real-git-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'existing.txt'), 'before')
  git(root, ['init'])
  git(root, ['config', 'user.email', 'xiaogui@example.test'])
  git(root, ['config', 'user.name', 'Xiaogui Test'])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'baseline'])
  return root
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
}

function gitBaseline(projectRoot: string) {
  const baseRevision = git(projectRoot, ['rev-parse', 'HEAD'])
  const base = {
    baselineId: 'baseline-real-git',
    baseRevision,
    baselineTreeHash: git(projectRoot, ['rev-parse', 'HEAD^{tree}']),
    initialTargetFingerprint: digestJson({ projectRoot: 'redacted-test-root' }),
  }
  return { ...base, baselineDigest: digestJson(base) }
}

function runtimeRequest(scope: RuntimeScopeBindingV1): RuntimeCreateOrResumeRequestV1 {
  return {
    requestId: 'runtime-create',
    scope,
    workspace: {
      attemptWorktreeId: 'attempt-worktree-1',
      worktreeRootDigest: 'sha256:worktree',
      baseRevisionDigest: 'sha256:base',
      targetProjectRootDigest: 'sha256:project',
      writePolicy: 'ATTEMPT_WORKTREE_ONLY',
    },
    selection: approvedSelection,
    productionPolicy: { allowedSelections: [approvedSelection], rejectDiagnosticOnly: true },
    promptEnvelopeRef: {
      refId: 'prompt-ref',
      digest: 'sha256:prompt',
      mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
    },
  }
}

describe('M2B fake agent runtime integration', () => {
  it('dispatches an approved fake runtime report without verification or changeset side effects', async () => {
    const dbPath = await tempDb()
    const { app, flowId, taskRunId, attemptId } = await readyAttempt(dbPath)
    const beforeReport = await app.observeM2B(ADDRESS)
    await expect(
      app.executeSystem({
        contractVersion: 'm2b.v1',
        address: ADDRESS as HubAddressV1,
        trustedActor: { kind: 'main-process-system' },
        requestId: 'sys-agent-report',
        expectedSessionVersion: beforeReport.ok ? beforeReport.value.sessionVersion : 0,
        intent: {
          type: 'system.agent.report.record',
          flowId,
          taskRunId,
          attemptId,
        },
      }),
    ).resolves.toMatchObject({ ok: true })
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { attempts: [expect.objectContaining({ status: 'RUNNING', runtimeSessionId: 'runtime-1' })] },
    })
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({ agent_dispatch_outbox: 1, runtime_session_bindings: 1 })
    store.close()
    app.close()
  })

  it('recovers a persisted dispatch outbox after crash with a new application instance', async () => {
    const dbPath = await tempDb()
    const crashed = await readyAttempt(dbPath, [approvedCapability], {
      afterAgentDispatchStart: () => {
        throw new Error('crash-after-outbox')
      },
    })
    const beforeReport = await crashed.app.observeM2B(ADDRESS)
    const request = {
      contractVersion: 'm2b.v1' as const,
      address: ADDRESS as HubAddressV1,
      trustedActor: { kind: 'main-process-system' as const },
      requestId: 'sys-agent-report-recover',
      expectedSessionVersion: beforeReport.ok ? beforeReport.value.sessionVersion : 0,
      intent: {
        type: 'system.agent.report.record' as const,
        flowId: crashed.flowId,
        taskRunId: crashed.taskRunId,
        attemptId: crashed.attemptId,
      },
    }
    await expect(crashed.app.executeSystem(request)).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    crashed.app.close()

    const recovered = createCollaborationHubApplicationV1({
      lookup: lookup('CODING'),
      storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
      agentRuntime: createAgentRuntimeHostV1(new ScriptedAgentRuntimeAdapterV1({ capabilities: [approvedCapability], createRuntimeSessionId: 'runtime-1' })),
      baselineProvider: { capture: async () => scriptedBaseline() },
      workspaceBridge: testWorkspaceBridge(scriptedBaseline()),
      runtimePromptVault: testPromptVault(),
    })
    await expect(recovered.executeSystem(request)).resolves.toMatchObject({ ok: true })
    await expect(recovered.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { attempts: [expect.objectContaining({ status: 'RUNNING', runtimeSessionId: 'runtime-1' })] },
    })
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({ attempts: 1, agent_dispatch_outbox: 1, runtime_session_bindings: 1 })
    store.close()
    recovered.close()
  })

  it('bootstraps schedule to real attempt worktree, private prompt ref, and scripted runtime READY without leaking payload bytes or paths', async () => {
    const dbPath = await tempDb()
    const projectRoot = await gitRepo()
    const managedRoot = await mkdtemp(join(tmpdir(), 'xiaogui-hub-managed-worktrees-'))
    roots.push(managedRoot)
    const workspaceDbRoot = await mkdtemp(join(tmpdir(), 'xiaogui-hub-workspace-db-'))
    const payloadDbRoot = await mkdtemp(join(tmpdir(), 'xiaogui-hub-payload-db-'))
    roots.push(workspaceDbRoot, payloadDbRoot)
    const workspaceRegistry = new SqliteAttemptWorkspaceRegistryV1({ dbPath: join(workspaceDbRoot, 'workspace.sqlite') })
    const workspaceService = new GitAttemptWorkspaceServiceV1(
      workspaceRegistry,
      { resolveProjectRoot: (projectId) => (projectId === ADDRESS.projectId ? projectRoot : '') },
      { managedRoot },
    )
    const promptVault = new PrivateRuntimePayloadVaultV1({ dbPath: join(payloadDbRoot, 'payload.sqlite') })
    const app = createCollaborationHubApplicationV1({
      lookup: lookup('CODING'),
      storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
      agentRuntime: createAgentRuntimeHostV1(new ScriptedAgentRuntimeAdapterV1({ capabilities: [approvedCapability], createRuntimeSessionId: 'runtime-real-worktree' })),
      baselineProvider: { capture: async () => gitBaseline(projectRoot) },
      workspaceBridge: {
        prepare: async ({ attempt, composition, baseline }) =>
          (
            await workspaceService.prepare({
              attemptId: attempt.attempt_id,
              compositionAttemptId: composition.compositionAttemptId,
              requestDigest: composition.requestDigest,
              baselineBindingDigest: composition.baselineBindingDigest,
              compositionDigest: composition.compositionDigest,
              projectId: ADDRESS.projectId,
              baseRevision: baseline.base_revision ?? baseline.baseline_id,
              baselineTreeHash: baseline.baseline_tree_hash,
              manifest: {
                attemptId: attempt.attempt_id,
                version: 1,
                grants: [
                  { operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') },
                  { operation: 'CREATE', relativePath: 'src/created.txt' },
                ],
              },
              ownerId: 'codex-project-lead',
            })
          ).receipt,
        runtimeWorkspace: (attemptId) => workspaceService.runtimeBinding(attemptId),
      },
      runtimePromptVault: promptVault,
      now: () => '2026-08-17T00:00:00.000Z',
      idFactory: (() => {
        let id = 0
        return (prefix: string) => `${prefix}_${++id}`
      })(),
    })

    const start = await app.execute({
      contractVersion: 'm2a.v1',
      address: ADDRESS,
      trustedActor: { kind: 'main-process-user' },
      requestId: 'req-real-start',
      intent: { type: 'flow.start.with_draft', draft: draft() },
    })
    if (!start.ok || !start.value.flowId || !start.value.revisionId) throw new Error('start failed')
    const beforeApprove = await app.observe(ADDRESS)
    if (!beforeApprove.ok || !beforeApprove.value.activeRevision) throw new Error('missing draft')
    await app.execute({
      contractVersion: 'm2a.v1',
      address: ADDRESS,
      trustedActor: { kind: 'main-process-user' },
      requestId: 'req-real-approve',
      expectedSessionVersion: beforeApprove.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: start.value.flowId,
        baseRevisionId: start.value.revisionId,
        draft: beforeApprove.value.activeRevision.draft,
      },
    })
    const beforeSchedule = await app.observeM2B(ADDRESS)
    const scheduled = await app.executeSystem({
      contractVersion: 'm2b.v1',
      address: ADDRESS as HubAddressV1,
      trustedActor: { kind: 'main-process-system' },
      requestId: 'sys-real-schedule',
      expectedSessionVersion: beforeSchedule.ok ? beforeSchedule.value.sessionVersion : 0,
      intent: {
        type: 'system.schedule',
        flowId: start.value.flowId as FlowId,
        authorizationScope: authorizationScope('src/value.txt'),
      },
    })
    if (!scheduled.ok || !scheduled.value.attemptId || !scheduled.value.taskRunId) throw new Error('schedule failed')
    promptVault.putPrompt({ attemptId: scheduled.value.attemptId, payloadBytes: '{"task":"edit existing and create file"}' })
    const beforePrepare = await app.observeM2B(ADDRESS)
    await expect(
      app.prepareNextWorkspace(ADDRESS as HubAddressV1, {
        requestId: 'sys-real-workspace-prepare',
        attemptId: scheduled.value.attemptId,
        expectedSessionVersion: beforePrepare.ok ? beforePrepare.value.sessionVersion : 0,
      }),
    ).resolves.toMatchObject({ ok: true })
    const beforeReport = await app.observeM2B(ADDRESS)
    await expect(
      app.executeSystem({
        contractVersion: 'm2b.v1',
        address: ADDRESS as HubAddressV1,
        trustedActor: { kind: 'main-process-system' },
        requestId: 'sys-real-agent-report',
        expectedSessionVersion: beforeReport.ok ? beforeReport.value.sessionVersion : 0,
        intent: { type: 'system.agent.report.record', flowId: start.value.flowId as FlowId, taskRunId: scheduled.value.taskRunId, attemptId: scheduled.value.attemptId },
      }),
    ).resolves.toMatchObject({ ok: true })

    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.flowExecutionBaseline(start.value.flowId as FlowId)).toMatchObject({
      baseline_id: 'baseline-real-git',
      base_revision: git(projectRoot, ['rev-parse', 'HEAD']),
      baseline_tree_hash: git(projectRoot, ['rev-parse', 'HEAD^{tree}']),
    })
    const outbox = store.agentDispatchOutbox(scheduled.value.attemptId)
    if (!outbox?.runtime_request_json) throw new Error('missing runtime request')
    const runtimeRequestText = outbox.runtime_request_json
    expect(runtimeRequestText).not.toContain('edit existing and create file')
    expect(runtimeRequestText).not.toContain(projectRoot)
    expect(runtimeRequestText).not.toContain(managedRoot)
    const runtimeRequest = JSON.parse(runtimeRequestText) as RuntimeCreateOrResumeRequestV1
    expect(runtimeRequest.workspace).toEqual(await workspaceService.runtimeBinding(scheduled.value.attemptId))
    expect(runtimeRequest.promptEnvelopeRef).toEqual(promptVault.promptRefForAttempt(scheduled.value.attemptId))
    expect(store.tableCounts()).toMatchObject({ workspace_receipts: 1, agent_dispatch_outbox: 1, runtime_session_bindings: 1 })
    store.close()
    promptVault.close()
    workspaceRegistry.close()
    app.close()
  })

  it('hands an immediate SUCCEEDED outcome to task verification without downgrading the attempt', async () => {
    const dbPath = await tempDb()
    const verificationInputs: TaskVerificationSucceededInputV1[] = []
    const taskVerificationCoordinator: TaskVerificationCoordinatorV1 = {
      handleSucceeded: async (input) => {
        verificationInputs.push(input)
        return {
          ok: true,
          verificationAttemptId: 'xhbva_immediate_success' as VerificationAttemptId,
          verdict: 'PASS',
        }
      },
      recoverPending: async () => [],
      close: async () => undefined,
    }
    const { app, flowId, taskRunId, attemptId } = await readyAttempt(dbPath, [approvedCapability], {
      createOutcome: {
        state: 'SUCCEEDED',
        runtimeSessionId: 'runtime-1',
        receiptDigest: 'sha256:agent-succeeded',
        candidateDigest: 'sha256:candidate',
      },
      taskVerificationCoordinator,
    })
    const beforeReport = await app.observeM2B(ADDRESS)
    await expect(
      app.executeSystem({
        contractVersion: 'm2b.v1',
        address: ADDRESS as HubAddressV1,
        trustedActor: { kind: 'main-process-system' },
        requestId: 'sys-agent-report-succeeded',
        expectedSessionVersion: beforeReport.ok ? beforeReport.value.sessionVersion : 0,
        intent: { type: 'system.agent.report.record', flowId, taskRunId, attemptId },
      }),
    ).resolves.toMatchObject({ ok: true })
    expect(verificationInputs).toEqual([
      {
        address: ADDRESS,
        flowId,
        taskRunId,
        attemptId,
        outcome: {
          state: 'SUCCEEDED',
          runtimeSessionId: 'runtime-1',
          receiptDigest: 'sha256:agent-succeeded',
          candidateDigest: 'sha256:candidate',
        },
        createdAt: '2026-08-17T00:00:00.000Z',
      },
    ])
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { attempts: [expect.objectContaining({ status: 'RUNNING', runtimeSessionId: 'runtime-1' })] },
    })
    app.close()
  })

  it('closes immediate SUCCEEDED candidate capture failure as a closed agent failure', async () => {
    const dbPath = await tempDb()
    const taskVerificationCoordinator: TaskVerificationCoordinatorV1 = {
      handleSucceeded: async () => ({ ok: false, reasonCode: 'TASK_VERIFICATION_CAPTURE_FAILED' }),
      recoverPending: async () => [],
      close: async () => undefined,
    }
    const { app, flowId, taskRunId, attemptId } = await readyAttempt(dbPath, [approvedCapability], {
      createOutcome: {
        state: 'SUCCEEDED',
        runtimeSessionId: 'runtime-1',
        receiptDigest: 'sha256:agent-succeeded-capture-failed',
        candidateDigest: 'sha256:candidate',
      },
      taskVerificationCoordinator,
    })
    const beforeReport = await app.observeM2B(ADDRESS)
    await expect(
      app.executeSystem({
        contractVersion: 'm2b.v1',
        address: ADDRESS as HubAddressV1,
        trustedActor: { kind: 'main-process-system' },
        requestId: 'sys-agent-report-capture-failed',
        expectedSessionVersion: beforeReport.ok ? beforeReport.value.sessionVersion : 0,
        intent: { type: 'system.agent.report.record', flowId, taskRunId, attemptId },
      }),
    ).resolves.toMatchObject({ ok: true })
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { attempts: [expect.objectContaining({ status: 'FAILED', runtimeSessionId: 'runtime-1' })] },
    })
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({ agent_failures: 1, verification_attempts: 0 })
    store.close()
    app.close()
  })

  it('closes immediate SUCCEEDED verification start failure as OUTCOME_UNKNOWN', async () => {
    const dbPath = await tempDb()
    const taskVerificationCoordinator: TaskVerificationCoordinatorV1 = {
      handleSucceeded: async () => ({ ok: false, reasonCode: 'TASK_VERIFICATION_STORE_REJECTED' }),
      recoverPending: async () => [],
      close: async () => undefined,
    }
    const { app, flowId, taskRunId, attemptId } = await readyAttempt(dbPath, [approvedCapability], {
      createOutcome: {
        state: 'SUCCEEDED',
        runtimeSessionId: 'runtime-1',
        receiptDigest: 'sha256:agent-succeeded-start-failed',
        candidateDigest: 'sha256:candidate',
      },
      taskVerificationCoordinator,
    })
    const beforeReport = await app.observeM2B(ADDRESS)
    await expect(
      app.executeSystem({
        contractVersion: 'm2b.v1',
        address: ADDRESS as HubAddressV1,
        trustedActor: { kind: 'main-process-system' },
        requestId: 'sys-agent-report-start-failed',
        expectedSessionVersion: beforeReport.ok ? beforeReport.value.sessionVersion : 0,
        intent: { type: 'system.agent.report.record', flowId, taskRunId, attemptId },
      }),
    ).resolves.toMatchObject({ ok: true })
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { attempts: [expect.objectContaining({ status: 'OUTCOME_UNKNOWN', runtimeSessionId: 'runtime-1' })] },
    })
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({ agent_failures: 0, verification_attempts: 0 })
    store.close()
    app.close()
  })

  it('closes immediate SUCCEEDED as OUTCOME_UNKNOWN when task verification is not wired', async () => {
    const dbPath = await tempDb()
    const { app, flowId, taskRunId, attemptId } = await readyAttempt(dbPath, [approvedCapability], {
      createOutcome: {
        state: 'SUCCEEDED',
        runtimeSessionId: 'runtime-1',
        receiptDigest: 'sha256:agent-succeeded-without-verifier',
        candidateDigest: 'sha256:candidate',
      },
    })
    const beforeReport = await app.observeM2B(ADDRESS)
    await expect(
      app.executeSystem({
        contractVersion: 'm2b.v1',
        address: ADDRESS as HubAddressV1,
        trustedActor: { kind: 'main-process-system' },
        requestId: 'sys-agent-report-without-verifier',
        expectedSessionVersion: beforeReport.ok ? beforeReport.value.sessionVersion : 0,
        intent: { type: 'system.agent.report.record', flowId, taskRunId, attemptId },
      }),
    ).resolves.toMatchObject({ ok: true })
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { attempts: [expect.objectContaining({ status: 'OUTCOME_UNKNOWN', runtimeSessionId: 'runtime-1' })] },
    })
    app.close()
  })

  it('passes reconcile SUCCEEDED through task verification with replayable system idempotency', async () => {
    const dbPath = await tempDb()
    const verificationInputs: TaskVerificationSucceededInputV1[] = []
    const taskVerificationCoordinator: TaskVerificationCoordinatorV1 = {
      handleSucceeded: async (input) => {
        verificationInputs.push(input)
        writeSystemIdempotencyForTest(dbPath, input.reconcileStart)
        return {
          ok: true,
          verificationAttemptId: 'xhbva_reconcile_success' as VerificationAttemptId,
          verdict: 'PASS',
        }
      },
      recoverPending: async () => [],
      close: async () => undefined,
    }
    const { app, flowId, taskRunId, attemptId } = await readyAttempt(dbPath, [approvedCapability], {
      outcomesBySession: {
        'runtime-1': {
          state: 'SUCCEEDED',
          runtimeSessionId: 'runtime-1',
          receiptDigest: 'sha256:reconciled-success',
          candidateDigest: 'sha256:reconciled-candidate',
        },
      },
      taskVerificationCoordinator,
    })
    const beforeReport = await app.observeM2B(ADDRESS)
    await app.executeSystem({
      contractVersion: 'm2b.v1',
      address: ADDRESS as HubAddressV1,
      trustedActor: { kind: 'main-process-system' },
      requestId: 'sys-agent-report-ready',
      expectedSessionVersion: beforeReport.ok ? beforeReport.value.sessionVersion : 0,
      intent: { type: 'system.agent.report.record', flowId, taskRunId, attemptId },
    })
    const running = await app.observeM2B(ADDRESS)
    await app.executeSystem({
      contractVersion: 'm2b.v1',
      address: ADDRESS as HubAddressV1,
      trustedActor: { kind: 'main-process-system' },
      requestId: 'sys-agent-outcome-unknown',
      expectedSessionVersion: running.ok ? running.value.sessionVersion : 0,
      intent: {
        type: 'system.agent.outcome.record',
        flowId,
        taskRunId,
        attemptId,
        runtimeSessionId: 'runtime-1',
        outcome: 'OUTCOME_UNKNOWN',
        receiptDigest: 'sha256:unknown-before-reconcile',
      },
    })
    const unknown = await app.observeM2B(ADDRESS)
    const reconcileRequest = {
      contractVersion: 'm2b.v1' as const,
      address: ADDRESS as HubAddressV1,
      trustedActor: { kind: 'main-process-system' as const },
      requestId: 'sys-agent-reconcile-success',
      expectedSessionVersion: unknown.ok ? unknown.value.sessionVersion : 0,
      intent: {
        type: 'system.agent.reconcile' as const,
        attemptId,
        runtimeSessionId: 'runtime-1',
      },
    }
    await expect(app.executeSystem(reconcileRequest)).resolves.toMatchObject({ ok: true })
    await expect(app.executeSystem(reconcileRequest)).resolves.toMatchObject({ ok: true })
    expect(verificationInputs).toHaveLength(1)
    expect(verificationInputs[0]).toMatchObject({
      address: ADDRESS,
      flowId,
      taskRunId,
      attemptId,
      outcome: {
        state: 'SUCCEEDED',
        runtimeSessionId: 'runtime-1',
        receiptDigest: 'sha256:reconciled-success',
        candidateDigest: 'sha256:reconciled-candidate',
      },
      reconcileStart: {
        expectedReceiptDigest: 'sha256:unknown-before-reconcile',
        receipt: { requestId: 'sys-agent-reconcile-success', intentType: 'system.agent.reconcile' },
      },
    })
    app.close()
  })

  it('does not classify an unknown free runtime failure reason as FAILED', async () => {
    const dbPath = await tempDb()
    const { app, flowId, taskRunId, attemptId } = await readyAttempt(dbPath, [approvedCapability], {
      createOutcome: {
        state: 'FAILED',
        runtimeSessionId: 'runtime-1',
        receiptDigest: 'sha256:vendor-free-failure',
        reasonCode: 'VENDOR_FREE_TEXT',
      },
    })
    const beforeReport = await app.observeM2B(ADDRESS)
    await expect(
      app.executeSystem({
        contractVersion: 'm2b.v1',
        address: ADDRESS as HubAddressV1,
        trustedActor: { kind: 'main-process-system' },
        requestId: 'sys-agent-report-free-failure',
        expectedSessionVersion: beforeReport.ok ? beforeReport.value.sessionVersion : 0,
        intent: { type: 'system.agent.report.record', flowId, taskRunId, attemptId },
      }),
    ).resolves.toMatchObject({ ok: true })
    await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
      ok: true,
      value: { attempts: [expect.objectContaining({ status: 'OUTCOME_UNKNOWN', runtimeSessionId: 'runtime-1' })] },
    })
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({ agent_failures: 0, agent_succeeded_audits: 0 })
    store.close()
    app.close()
  })

  it('fails diagnostic runtime selection before any M2B dispatch write', async () => {
    const dbPath = await tempDb()
    let id = 0
    const app = createCollaborationHubApplicationV1({
      lookup: lookup('CODING'),
      storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
      agentRuntime: createAgentRuntimeHostV1(new ScriptedAgentRuntimeAdapterV1({ capabilities: [diagnosticCapability] })),
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
    await app.execute({
      contractVersion: 'm2a.v1',
      address: ADDRESS,
      trustedActor: { kind: 'main-process-user' },
      requestId: 'req-approve',
      expectedSessionVersion: before.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId: start.value.flowId,
        baseRevisionId: start.value.revisionId,
        draft: before.value.activeRevision.draft,
      },
    })
    const approved = await app.observeM2B(ADDRESS)
    await expect(
      app.executeSystem({
        contractVersion: 'm2b.v1',
        address: ADDRESS as HubAddressV1,
        trustedActor: { kind: 'main-process-system' },
        requestId: 'sys-schedule-diagnostic',
        expectedSessionVersion: approved.ok ? approved.value.sessionVersion : 0,
        intent: {
          type: 'system.schedule',
          flowId: start.value.flowId as FlowId,
          authorizationScope: authorizationScope('src/value.txt'),
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'AGENT_UNAVAILABLE' } })
    const store = new CollaborationHubSqliteStoreV1(dbPath)
    expect(store.tableCounts()).toMatchObject({ attempts: 0, workspace_prepare_outbox: 0, agent_dispatch_outbox: 0, runtime_session_bindings: 0 })
    store.close()
    app.close()
  })

  it('converts public DTO leaks and permission proof replay into closed runtime results', async () => {
    const scope: RuntimeScopeBindingV1 = {
      projectId: ADDRESS.projectId,
      sessionKey: ADDRESS.sessionKey,
      sessionMode: 'CODING',
      flowId: 'xhbf_flow',
      taskRunId: 'xhbtr_task',
      attemptId: 'xhba_attempt',
      attemptDigest: 'sha256:attempt',
      workspaceReceiptId: 'xhbw_ready',
      workspaceReceiptDigest: 'sha256:workspace-ready',
    }
    const host = createAgentRuntimeHostV1(
      new ScriptedAgentRuntimeAdapterV1({
        capabilities: [approvedCapability],
        createRuntimeSessionId: 'runtime-1',
        eventsBySession: {
          'runtime-1': [
            { type: 'SESSION_READY', runtimeSessionId: 'runtime-1', sequence: 1 },
            { type: 'TEXT_DELTA', runtimeSessionId: 'runtime-1', sequence: 2, textDigest: 'file:///secret.txt' },
          ],
        },
      }),
    )
    await host.createOrResume(runtimeRequest(scope))
    const events = []
    for await (const event of host.stream('runtime-1', 0)) events.push(event)
    expect(events).toEqual([
      { type: 'SESSION_READY', runtimeSessionId: 'runtime-1', sequence: 1 },
      { type: 'OUTCOME_UNKNOWN', runtimeSessionId: 'runtime-1', sequence: 2, reasonCode: 'PUBLIC_DTO_LEAK' },
    ])

    const permissionEvent = {
      type: 'PERMISSION_REQUESTED' as const,
      runtimeSessionId: 'runtime-1',
      sequence: 1,
      permissionRequestId: 'perm-1',
      scope,
      challengeDigest: 'sha256:challenge',
      decisionRequired: 'ALLOW_ONCE_OR_DENY' as const,
    }
    const permissionHost = createAgentRuntimeHostV1(
      new ScriptedAgentRuntimeAdapterV1({
        capabilities: [approvedCapability],
        createRuntimeSessionId: 'runtime-1',
        eventsBySession: { 'runtime-1': [permissionEvent] },
      }),
    )
    await permissionHost.createOrResume(runtimeRequest(scope))
    for await (const _ of permissionHost.stream('runtime-1', 0)) {
      // consume permission request into host state
    }
    const decision = {
      type: 'ALLOW_ONCE' as const,
      permissionRequestId: 'perm-1',
      challengeDigest: 'sha256:challenge',
      decisionRequestId: 'decision-1',
      scope,
      runtimeSessionId: 'runtime-1',
      proofId: 'proof-1',
      proofDigest: 'sha256:proof-1',
    }
    await expect(permissionHost.permission(decision)).resolves.toEqual({ accepted: true })
    await expect(permissionHost.permission({ ...decision, decisionRequestId: 'decision-2' })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PERMISSION_REQUEST_CONSUMED',
    })
  })
})
