import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// Runtime composition reaches the desktop configuration boundary while this
// test only exercises Main stores and Git. Keep Electron persistence out of
// the fixture; the production composition itself remains unmocked.
vi.mock('electron-store', () => {
  class ElectronStore {
    private readonly values: Record<string, unknown>

    constructor(options: { defaults?: Record<string, unknown> } = {}) {
      this.values = { ...options.defaults }
    }

    get(key: string): unknown {
      return this.values[key]
    }

    set(key: string, value: unknown): void {
      this.values[key] = value
    }

    delete(key: string): void {
      delete this.values[key]
    }

    get store(): Record<string, unknown> {
      return { ...this.values }
    }
  }

  return { default: ElectronStore }
})

import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  InitialPlanDraftInputV1,
  TaskFileAuthorizationScopeV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import type { RuntimeCapabilityV1 } from '@shared/xiaogui-agent-runtime'
import {
  taskChangeSetDigestV1,
  type ArtifactId,
  type Sha256Digest,
  type TaskChangeSetId,
  type TaskChangeSetV1,
  type VerificationAttemptId,
} from '@shared/xiaogui-task-verification'

import {
  AttemptExecutionInputStoreV1,
  type ResolvedAttemptExecutionInputV1,
} from './attempt-execution-input'
import { createAgentRuntimeHostV1 } from '../agent-runtime/runtime-host'
import { ScriptedAgentRuntimeAdapterV1 } from '../agent-runtime/scripted-adapter'
import {
  digestBytes,
  GitAttemptWorkspaceServiceV1,
  SqliteAttemptWorkspaceRegistryV1,
  type AttemptFileGrantV1,
  type AttemptWorkspaceBaselineSourceResolverV1,
  type AttemptWorkspaceLeaseV1,
  type AttemptWorkspacePortV1,
  type AttemptWorkspacePrepareRequestV1,
} from './attempt-workspace'
import { digestJson } from './digest'
import { PrivateRuntimePayloadVaultV1 } from './private-payload-vault'
import { createCollaborationHubApplicationV1, type CollaborationHubApplicationV1 } from './application'
import { GitExecutionBaselineProviderV1 } from './git-execution-baseline'
import { GitDerivedExecutionBaselineProviderV1 } from './git-derived-execution-baseline'
import {
  createMainAttemptWorkspaceBaselineSourceResolverV1,
} from './runtime-composition'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'

const PROJECT_ID = `xgp1_${'7'.repeat(64)}` as HubAddressV1['projectId']
const SESSION_KEY = `xgs1_${'8'.repeat(64)}` as HubAddressV1['sessionKey']
const ADDRESS = { projectId: PROJECT_ID, sessionKey: SESSION_KEY } as HubAddressV1
const approvedCapability: RuntimeCapabilityV1 = {
  adapterId: 'main-source-test-runtime',
  runtimeKind: 'OTHER',
  protocol: 'HEADLESS',
  capabilityDigest: 'sha256:main-source-test-runtime',
  approvalStatus: 'APPROVED_FOR_PRODUCTION',
  health: 'AVAILABLE',
  canCreateSession: true,
  canResumeSession: true,
  diagnosticOnly: false,
  stream: 'POLL',
  interrupt: 'BEST_EFFORT',
  inspect: 'SNAPSHOT',
  interactivePermission: 'HOST_MEDIATED',
}
const roots: string[] = []
const harnesses: MainHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) {
    try {
      harness.close()
    } catch {
      // Preserve the primary assertion if cleanup encounters an old worktree.
    }
  }
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

describe('Main Attempt baseline source resolver', () => {
  it('prepares a scheduled Attempt through the real Main PROJECT source proof and keeps flow/task binding digests distinct', async () => {
    const projectRoot = createFixtureProject('project')
    const { composition, userDataDir, hubDbPath } = createComposition(projectRoot)
    const flowId = await startAndApprove(composition, oneTaskDraft())
    const scheduled = await schedule(composition, flowId, 'project-schedule')
    const grants: AttemptFileGrantV1[] = [{ operation: 'CREATE', relativePath: 'src/new.txt' }]
    composition.stageAttemptInput({
      attemptId: scheduled.attemptId,
      projectId: PROJECT_ID,
      sessionKey: SESSION_KEY,
      promptBytes: '只创建已批准文件',
      grants,
    })

    const prepared = await composition.application.prepareNextWorkspace(ADDRESS, {
      requestId: 'project-workspace-prepare',
      attemptId: scheduled.attemptId,
    })
    expect(prepared).toMatchObject({ ok: true })

    const store = new CollaborationHubSqliteStoreV1(hubDbPath)
    try {
      const flow = store.flowExecutionBaseline(flowId)
      const task = store.taskExecutionBaseline(scheduled.attemptId)
      expect(flow).toBeDefined()
      expect(task).toBeDefined()
      expect(flow?.baseline_binding_digest).not.toBe(task?.baseline_binding_digest)
      expect(task?.base_revision).toBe(flow?.base_revision)
      expect(task?.baseline_tree_hash).toBe(flow?.baseline_tree_hash)
    } finally {
      store.close()
    }

    const lease = readLease(join(userDataDir, 'xiaogui', 'task-hub', 'attempt-workspaces.sqlite'), scheduled.attemptId)
    expect(lease?.baselineSource).toMatchObject({
      version: 1,
      kind: 'PROJECT',
      attemptId: scheduled.attemptId,
      projectId: PROJECT_ID,
      flowId,
      taskRunId: scheduled.taskRunId,
      source: {
        baseRevision: git(projectRoot, ['rev-parse', 'HEAD']),
        baselineTreeHash: git(projectRoot, ['rev-parse', 'HEAD^{tree}']),
      },
      task: {
        baseRevision: git(projectRoot, ['rev-parse', 'HEAD']),
        baselineTreeHash: git(projectRoot, ['rev-parse', 'HEAD^{tree}']),
        ancestorTaskChangeSetIds: [],
      },
    })
    if (!lease) throw new Error('missing project lease')
    expect(readFileSync(join(lease.worktreeRoot, 'src', 'new.txt'))).toEqual(Buffer.alloc(0))
  }, 30_000)

  it('recovers an old A to C derived baseline through the real Git provider, scheduler records, Main source proof, and prepare', async () => {
    const projectRoot = createFixtureProject('derived')
    const { composition, userDataDir, hubDbPath } = createComposition(projectRoot)
    const flowId = await startAndApprove(composition, parentChildDraft())
    const tasks = readSchedulerTasks(hubDbPath, flowId)
    if (tasks.length !== 2) throw new Error('expected parent and child task runs')
    const parent = tasks.find((task) => task.taskKey === 'parent')
    const child = tasks.find((task) => task.taskKey === 'child')
    if (!parent || !child) throw new Error('expected parent and child task keys')
    const ancestor = insertVerifiedAncestor(hubDbPath, {
      flowId,
      planRevisionId: readActiveRevisionId(hubDbPath, flowId),
      taskRunId: parent.taskRunId,
    })

    const scheduled = await schedule(composition, flowId, 'derived-schedule', child.taskRunId)
    expect(scheduled.taskRunId).toBe(child.taskRunId)
    const grants: AttemptFileGrantV1[] = [{
      operation: 'MODIFY',
      relativePath: 'src/value.txt',
      baselineDigest: digestBytes('from A\n'),
    }]
    const staged = composition.stageAttemptInput({
      attemptId: scheduled.attemptId,
      projectId: PROJECT_ID,
      sessionKey: SESSION_KEY,
      promptBytes: '继续 A 的结果完成 C',
      grants,
    })
    const prepared = await composition.application.prepareNextWorkspace(ADDRESS, {
      requestId: 'derived-workspace-prepare',
      attemptId: scheduled.attemptId,
    })
    expect(prepared).toMatchObject({ ok: true })

    const flowBaseRevision = git(projectRoot, ['rev-parse', 'HEAD'])
    const flowTree = git(projectRoot, ['rev-parse', 'HEAD^{tree}'])
    const store = new CollaborationHubSqliteStoreV1(hubDbPath)
    let taskBaseline: ReturnType<CollaborationHubSqliteStoreV1['taskExecutionBaseline']>
    let flowBaseline: ReturnType<CollaborationHubSqliteStoreV1['flowExecutionBaseline']>
    try {
      flowBaseline = store.flowExecutionBaseline(flowId)
      taskBaseline = store.taskExecutionBaseline(scheduled.attemptId)
      expect(flowBaseline).toMatchObject({ base_revision: flowBaseRevision, baseline_tree_hash: flowTree })
      expect(taskBaseline).toMatchObject({
        task_run_id: child.taskRunId,
        base_revision: expect.stringMatching(/^[0-9a-f]{40}$/i),
        ancestor_task_change_set_ids_json: JSON.stringify([ancestor.taskChangeSetId]),
      })
      expect(taskBaseline?.base_revision).not.toBe(flowBaseline?.base_revision)
      expect(taskBaseline?.baseline_binding_digest).not.toBe(flowBaseline?.baseline_binding_digest)
    } finally {
      store.close()
    }
    if (!taskBaseline || !flowBaseline) throw new Error('missing derived baseline records')

    const cache = readDerivedCache(hubDbPath, flowId, child.taskRunId)
    expect(cache).toBeDefined()
    expect(cache?.baselineJson).toContain(taskBaseline.base_revision)

    const lease = readLease(join(userDataDir, 'xiaogui', 'task-hub', 'attempt-workspaces.sqlite'), scheduled.attemptId)
    expect(lease?.baselineSource).toMatchObject({
      kind: 'DERIVED',
      attemptId: scheduled.attemptId,
      projectId: PROJECT_ID,
      flowId,
      taskRunId: child.taskRunId,
      source: {
        baseRevision: flowBaseRevision,
        baselineTreeHash: flowTree,
      },
      task: {
        baseRevision: taskBaseline.base_revision,
        baselineTreeHash: taskBaseline.baseline_tree_hash,
        ancestorTaskChangeSetIds: [ancestor.taskChangeSetId],
      },
      derivation: {
        derivationInputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        cacheDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    })
    if (!lease?.baselineSource || lease.baselineSource.kind !== 'DERIVED') throw new Error('missing derived source proof')
    expect(lease.baselineSource.derivation?.derivationInputDigest).toBe(cache!.derivationInputDigest)
    expect(lease.baselineSource.derivation?.cacheDigest).toBe(digestBytes(Buffer.from(cache!.baselineJson, 'utf8')))
    expect(readFileSync(join(lease.worktreeRoot, 'src', 'value.txt'), 'utf8')).toBe('from A\n')
    expect(readFileSync(join(projectRoot, 'src', 'value.txt'), 'utf8')).toBe('base\n')
    expect(git(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')

    // Reopen the private input vault and workspace registry to prove the
    // persisted A->C source proof is reused on cold recovery. No runtime/model
    // is started by this replay.
    const request = prepareRequestFromRecords(hubDbPath, scheduled.attemptId, staged.grants)
    await composition.close()
    const recovered = reopenWorkspace({ projectRoot, userDataDir, hubDbPath })
    try {
      const replayed = await recovered.workspace.prepare(request)
      expect(replayed.handle.rootPath).toBe(lease.worktreeRoot)
      expect(recovered.registry.getLease(scheduled.attemptId)?.baselineSource).toEqual(lease.baselineSource)
    } finally {
      recovered.close()
    }

    removeLeaseBaselineSource(
      join(userDataDir, 'xiaogui', 'task-hub', 'attempt-workspaces.sqlite'),
      scheduled.attemptId,
    )
    const legacyRecovered = reopenWorkspace({ projectRoot, userDataDir, hubDbPath })
    try {
      const replayedLegacy = await legacyRecovered.workspace.prepare(request)
      expect(replayedLegacy.handle.rootPath).toBe(lease.worktreeRoot)
      expect(legacyRecovered.registry.getLease(scheduled.attemptId)?.baselineSource).toEqual(lease.baselineSource)
    } finally {
      legacyRecovered.close()
    }
  }, 30_000)

  it('rejects missing, unregistered, or mismatched Main source bindings', async () => {
    const projectRoot = createFixtureProject('negative')
    const { composition, hubDbPath } = createComposition(projectRoot)
    const flowId = await startAndApprove(composition, oneTaskDraft())
    const scheduled = await schedule(composition, flowId, 'negative-schedule')
    const grants: AttemptFileGrantV1[] = [{ operation: 'CREATE', relativePath: 'src/new.txt' }]
    const staged = composition.stageAttemptInput({
      attemptId: scheduled.attemptId,
      projectId: PROJECT_ID,
      sessionKey: SESSION_KEY,
      promptBytes: 'negative source fixture',
      grants,
    })
    const request = prepareRequestFromRecords(hubDbPath, scheduled.attemptId, staged.grants)
    const exactResolver = mainResolver(hubDbPath, staged)
    expect(exactResolver.resolve({ request, grants: staged.grants })).not.toBeNull()

    const missingResolver = createMainAttemptWorkspaceBaselineSourceResolverV1(hubDbPath, () => undefined)
    expect(missingResolver.resolve({ request, grants: staged.grants })).toBeNull()

    const unregisteredRequest = { ...request, attemptId: 'xhba_unregistered_main_source' as AttemptId }
    expect(exactResolver.resolve({ request: unregisteredRequest, grants: staged.grants })).toBeNull()

    const mismatchedRequest = { ...request, compositionDigest: 'sha256:wrong-composition-binding' }
    expect(exactResolver.resolve({ request: mismatchedRequest, grants: staged.grants })).toBeNull()
    expect(exactResolver.resolve({
      request,
      grants: [{ operation: 'CREATE', relativePath: 'src/other.txt' }],
    })).toBeNull()
  }, 30_000)
})

interface MainHarness {
  readonly application: CollaborationHubApplicationV1
  readonly stageAttemptInput: AttemptExecutionInputStoreV1['stage']
  close(): void
}

function createComposition(projectRoot: string): {
  composition: MainHarness
  userDataDir: string
  hubDbPath: string
} {
  const userDataDir = tempRoot('xiaogui-main-source-user-data-')
  const taskHubDir = join(userDataDir, 'xiaogui', 'task-hub')
  mkdirSync(taskHubDir, { recursive: true })
  const hubDbPath = join(userDataDir, 'xiaogui-task-hub-m2a.sqlite')
  const managedRoot = join(userDataDir, 'xiaogui', 'attempt-worktrees')
  const workspaceDbPath = join(taskHubDir, 'attempt-workspaces.sqlite')
  const payloadDbPath = join(taskHubDir, 'private-runtime-payloads.sqlite')
  const inputDbPath = join(taskHubDir, 'attempt-execution-inputs.sqlite')
  const projectResolver = { resolveProjectRoot: () => projectRoot }
  const payloads = new PrivateRuntimePayloadVaultV1({ dbPath: payloadDbPath })
  const workspaceRegistry = new SqliteAttemptWorkspaceRegistryV1({ dbPath: workspaceDbPath })
  const workspace: GitAttemptWorkspaceServiceV1 = new GitAttemptWorkspaceServiceV1(
    workspaceRegistry,
    projectResolver,
    {
      managedRoot,
      baselineSourceResolver: createMainAttemptWorkspaceBaselineSourceResolverV1(
        hubDbPath,
        (): AttemptExecutionInputStoreV1 => inputStore,
      ),
    },
  )
  const inputStore: AttemptExecutionInputStoreV1 = new AttemptExecutionInputStoreV1({
    dbPath: inputDbPath,
    payloadVault: payloads,
    workspace,
    now: () => '2026-09-14T00:00:00.000Z',
  })
  const app = createCollaborationHubApplicationV1({
    lookup: {
      lookup: async () => ({
        kind: 'FOUND' as const,
        scope: { ...ADDRESS, sessionMode: 'CODING' as const },
      }),
    },
    storeFactory: () => new CollaborationHubSqliteStoreV1(hubDbPath),
    agentRuntime: createAgentRuntimeHostV1(new ScriptedAgentRuntimeAdapterV1({
      capabilities: [approvedCapability],
      createRuntimeSessionId: 'main-source-test-runtime-session',
    })),
    baselineProvider: new GitExecutionBaselineProviderV1(projectResolver),
    derivedBaselineProvider: new GitDerivedExecutionBaselineProviderV1({
      storeFactory: () => new CollaborationHubSqliteStoreV1(hubDbPath),
      projectResolver,
      managedRoot: join(userDataDir, 'xiaogui', 'derived-baseline-worktrees'),
      now: () => '2026-09-14T00:00:00.000Z',
    }),
    workspaceBridge: inputStore.bridge,
    runtimePromptVault: inputStore,
    now: () => '2026-09-14T00:00:00.000Z',
  })
  let closed = false
  const composition: MainHarness = {
    application: app,
    stageAttemptInput: inputStore.stage.bind(inputStore),
    close() {
      if (closed) return
      closed = true
      app.close()
      inputStore?.close()
      payloads.close()
      workspaceRegistry.close()
    },
  }
  harnesses.push(composition)
  return { composition, userDataDir, hubDbPath }
}

async function startAndApprove(composition: MainHarness, draft: InitialPlanDraftInputV1): Promise<FlowId> {
  const started = await composition.application.execute({
    contractVersion: 'm2a.v1',
    address: ADDRESS,
    trustedActor: { kind: 'main-process-user' },
    requestId: `main-source-start-${draft.tasks.length}`,
    intent: { type: 'flow.start.with_draft', draft },
  })
  if (!started.ok || !started.value.flowId || !started.value.revisionId) throw new Error('main source flow start failed')
  const projection = await composition.application.observe(ADDRESS)
  if (!projection.ok || !projection.value.activeRevision) throw new Error('main source draft missing')
  const approved = await composition.application.execute({
    contractVersion: 'm2a.v1',
    address: ADDRESS,
    trustedActor: { kind: 'main-process-user' },
    requestId: `main-source-approve-${draft.tasks.length}`,
    expectedSessionVersion: projection.value.sessionVersion,
    intent: {
      type: 'plan.revision.submit',
      flowId: started.value.flowId,
      baseRevisionId: started.value.revisionId,
      draft: projection.value.activeRevision.draft,
    },
  })
  if (!approved.ok) throw new Error('main source plan approval failed')
  return started.value.flowId as FlowId
}

async function schedule(
  composition: MainHarness,
  flowId: FlowId,
  label: string,
  targetTaskRunId?: string,
): Promise<{ attemptId: AttemptId; taskRunId: TaskRunId }> {
  const projection = await composition.application.observeM2B(ADDRESS)
  if (!projection.ok) throw new Error('main source M2B projection missing')
  const scheduled = await composition.application.executeSystem({
    contractVersion: 'm2b.v1',
    address: ADDRESS,
    trustedActor: { kind: 'main-process-system' },
    requestId: label,
    intent: {
      type: 'system.schedule',
      flowId,
      ...(targetTaskRunId ? { targetTaskRunId: targetTaskRunId as TaskRunId } : {}),
      authorizationScope: authorizationScope(label),
    },
  })
  if (!scheduled.ok || !scheduled.value.attemptId || !scheduled.value.taskRunId) {
    throw new Error(`main source schedule failed: ${JSON.stringify(scheduled)}`)
  }
  return { attemptId: scheduled.value.attemptId, taskRunId: scheduled.value.taskRunId }
}

function authorizationScope(label: string): TaskFileAuthorizationScopeV1 {
  const base = {
    version: 1 as const,
    pathTokens: [`sha256:${digestJson({ label, role: 'main-source-test' })}` as TaskFileAuthorizationScopeV1['pathTokens'][number]],
  }
  return { ...base, scopeDigest: `sha256:${digestJson(base)}` as TaskFileAuthorizationScopeV1['scopeDigest'] }
}

function oneTaskDraft(): InitialPlanDraftInputV1 {
  return { objective: '验证 Main PROJECT source proof', tasks: [{ taskKey: 'task', title: 'Main source task' }] }
}

function parentChildDraft(): InitialPlanDraftInputV1 {
  return {
    objective: '恢复旧失败 A 到 C 派生基线',
    tasks: [
      { taskKey: 'parent', title: '已验证的 A' },
      { taskKey: 'child', title: '恢复 C', dependsOn: ['parent'] },
    ],
  }
}

function createFixtureProject(label: string): string {
  const root = tempRoot(`xiaogui-main-source-project-${label}-`)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'value.txt'), 'base\n')
  git(root, ['init'])
  git(root, ['config', 'user.email', 'xiaogui@example.test'])
  git(root, ['config', 'user.name', 'Xiaogui Main Source Test'])
  git(root, ['config', 'core.autocrlf', 'false'])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'main source baseline'])
  return root
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

function readSchedulerTasks(hubDbPath: string, flowId: FlowId): Array<{ taskRunId: TaskRunId; taskKey: string; dependsOn: string[] }> {
  const store = new CollaborationHubSqliteStoreV1(hubDbPath)
  try {
    return store.schedulerTasks(flowId).map((task) => ({
      taskRunId: task.taskRunId,
      taskKey: task.taskKey,
      dependsOn: [...task.dependsOn],
    }))
  } finally {
    store.close()
  }
}

function readActiveRevisionId(hubDbPath: string, flowId: FlowId): string {
  const db = new DatabaseSync(hubDbPath)
  try {
    const row = db.prepare('select active_revision_id from flows where flow_id = ?').get(flowId) as { active_revision_id: string | null } | undefined
    if (!row?.active_revision_id) throw new Error('missing active revision')
    return row.active_revision_id
  } finally {
    db.close()
  }
}

function insertVerifiedAncestor(
  hubDbPath: string,
  input: { flowId: FlowId; planRevisionId: string; taskRunId: TaskRunId },
): { taskChangeSetId: TaskChangeSetId; patchArtifactId: ArtifactId } {
  const taskChangeSetId = 'xhbtcs_main_ancestor' as TaskChangeSetId
  const patchArtifactId = 'xhart_main_ancestor' as ArtifactId
  const verificationAttemptId = 'xhbva_main_ancestor' as VerificationAttemptId
  const candidateId = 'xhbcand_main_ancestor'
  const patch = {
    kind: 'TASK_PATCH_V1' as const,
    version: 1 as const,
    files: [{
      operation: 'MODIFY' as const,
      relativePath: 'src/value.txt',
      baselineDigest: digestBytes('base\n'),
      contentDigest: digestBytes('from A\n'),
      contentBase64: Buffer.from('from A\n', 'utf8').toString('base64'),
    }],
  }
  const patchBytes = Buffer.from(JSON.stringify(patch), 'utf8')
  const withoutDigest: Omit<TaskChangeSetV1, 'digest'> = {
    kind: 'TASK',
    version: 1,
    taskChangeSetId,
    flowId: input.flowId,
    planRevisionId: input.planRevisionId as never,
    taskRunId: input.taskRunId,
    attemptId: 'xhba_main_ancestor' as AttemptId,
    verificationAttemptId,
    candidateId: candidateId as never,
    inputTreeHash: `sha256:${'a'.repeat(64)}` as Sha256Digest,
    resultTreeHash: `sha256:${'b'.repeat(64)}` as Sha256Digest,
    ancestorTaskChangeSetIds: [],
    patchArtifactId,
    evidenceBundleId: 'xhbe_main_ancestor' as never,
    qaResultId: 'xhbqa_main_ancestor' as never,
    qaConfigVersion: 'xiaogui.coding.task.v1',
    createdAt: '2026-09-14T00:00:00.000Z' as never,
  }
  const changeSet: TaskChangeSetV1 = {
    ...withoutDigest,
    digest: taskChangeSetDigestV1(withoutDigest),
  }
  const db = new DatabaseSync(hubDbPath)
  try {
    // The fixture is a verified checkpoint input. Its parent verification
    // objects are intentionally outside this source-binding seam; the real
    // provider only accepts the immutable change-set and PATCH artifact rows.
    db.exec('pragma foreign_keys = off')
    db.prepare('insert into artifacts (artifact_id, kind, media_type, content_digest, content, created_at) values (?, ?, ?, ?, ?, ?)').run(
      patchArtifactId,
      'PATCH',
      'application/json',
      digestBytes(patchBytes),
      patchBytes,
      '2026-09-14T00:00:00.000Z',
    )
    db.prepare(`
      insert into task_change_sets (
        task_change_set_id, version, flow_id, plan_revision_id, task_run_id,
        attempt_id, verification_attempt_id, candidate_id, input_tree_hash,
        result_tree_hash, ancestor_task_change_set_ids_json, patch_artifact_id,
        evidence_bundle_id, qa_result_id, qa_config_version, digest,
        change_set_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    db.prepare('update task_runs set status = ?, unavailable_reason = ? where task_run_id = ?').run(
      'VERIFIED',
      'M2B1_SCHEDULED',
      input.taskRunId,
    )
  } finally {
    db.close()
  }
  return { taskChangeSetId, patchArtifactId }
}

function prepareRequestFromRecords(
  hubDbPath: string,
  attemptId: AttemptId,
  grants: readonly AttemptFileGrantV1[],
): AttemptWorkspacePrepareRequestV1 {
  const store = new CollaborationHubSqliteStoreV1(hubDbPath)
  try {
    const scope = store.attemptExecutionScope(attemptId)
    const composition = store.compositionAttempt(attemptId)
    const task = store.taskExecutionBaseline(attemptId)
    if (!scope || !composition || !task || !task.base_revision) throw new Error('missing Main attempt records')
    return {
      attemptId,
      compositionAttemptId: composition.compositionAttemptId,
      requestDigest: composition.requestDigest,
      baselineBindingDigest: composition.baselineBindingDigest,
      compositionDigest: composition.compositionDigest,
      projectId: scope.project_id,
      baseRevision: task.base_revision,
      baselineTreeHash: task.baseline_tree_hash,
      manifest: { attemptId, version: 1, grants },
      ownerId: 'xiaogui-main-process',
    }
  } finally {
    store.close()
  }
}

function mainResolver(
  hubDbPath: string,
  staged: ResolvedAttemptExecutionInputV1,
): AttemptWorkspaceBaselineSourceResolverV1 {
  const inputStore = { resolve: () => staged } as unknown as AttemptExecutionInputStoreV1
  return createMainAttemptWorkspaceBaselineSourceResolverV1(hubDbPath, () => inputStore)
}

function readLease(dbPath: string, attemptId: AttemptId): AttemptWorkspaceLeaseV1 | null {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare('select lease_json from attempt_workspace_leases where attempt_id = ?').get(attemptId) as { lease_json: string } | undefined
    return row ? JSON.parse(row.lease_json) as AttemptWorkspaceLeaseV1 : null
  } finally {
    db.close()
  }
}

function removeLeaseBaselineSource(dbPath: string, attemptId: AttemptId): void {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare('select lease_json from attempt_workspace_leases where attempt_id = ?').get(attemptId) as { lease_json: string } | undefined
    if (!row) throw new Error('missing lease')
    const lease = JSON.parse(row.lease_json) as Record<string, unknown>
    delete lease.baselineSource
    db.prepare('update attempt_workspace_leases set lease_json = ? where attempt_id = ?').run(JSON.stringify(lease), attemptId)
  } finally {
    db.close()
  }
}

function readDerivedCache(
  hubDbPath: string,
  flowId: FlowId,
  taskRunId: TaskRunId,
): { derivationInputDigest: string; baselineJson: string } | null {
  const db = new DatabaseSync(hubDbPath)
  try {
    const row = db.prepare(`
      select derivation_input_digest, baseline_json
        from derived_execution_baselines
       where flow_id = ? and task_run_id = ?
    `).get(flowId, taskRunId) as { derivation_input_digest: string; baseline_json: string } | undefined
    return row ? { derivationInputDigest: row.derivation_input_digest, baselineJson: row.baseline_json } : null
  } finally {
    db.close()
  }
}

function reopenWorkspace(input: {
  projectRoot: string
  userDataDir: string
  hubDbPath: string
}): {
  workspace: GitAttemptWorkspaceServiceV1
  registry: SqliteAttemptWorkspaceRegistryV1
  close(): void
} {
  const taskHubDir = join(input.userDataDir, 'xiaogui', 'task-hub')
  const payloads = new PrivateRuntimePayloadVaultV1({ dbPath: join(taskHubDir, 'private-runtime-payloads.sqlite') })
  const inputStore = new AttemptExecutionInputStoreV1({
    dbPath: join(taskHubDir, 'attempt-execution-inputs.sqlite'),
    payloadVault: payloads,
    workspace: {} as AttemptWorkspacePortV1,
  })
  const registry = new SqliteAttemptWorkspaceRegistryV1({ dbPath: join(taskHubDir, 'attempt-workspaces.sqlite') })
  const resolver = createMainAttemptWorkspaceBaselineSourceResolverV1(input.hubDbPath, () => inputStore)
  const workspace = new GitAttemptWorkspaceServiceV1(
    registry,
    { resolveProjectRoot: () => input.projectRoot },
    {
      managedRoot: join(input.userDataDir, 'xiaogui', 'attempt-worktrees'),
      baselineSourceResolver: resolver,
    },
  )
  return {
    workspace,
    registry,
    close() {
      registry.close()
      inputStore.close()
      payloads.close()
    },
  }
}
