import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeCapabilityV1 } from '@shared/xiaogui-agent-runtime'
import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  HubSystemCommandRequestM2BV1,
  InitialPlanDraftInputV1,
  PlanRevisionId,
  TaskFileAuthorizationScopeV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import {
  taskChangeSetDigestV1,
  type ArtifactId,
  type EvidenceBundleId,
  type IsoDateTime,
  type QaResultId,
  type Sha256Digest,
  type TaskChangeSetCandidateId,
  type TaskChangeSetId,
  type TaskChangeSetV1,
  type VerificationAttemptId,
} from '@shared/xiaogui-task-verification'
import { createAgentRuntimeHostV1 } from '../agent-runtime/runtime-host'
import { ScriptedAgentRuntimeAdapterV1 } from '../agent-runtime/scripted-adapter'
import {
  createCollaborationHubApplicationV1,
  type DerivedExecutionBaselineProviderV1,
  type DerivedTaskExecutionBaselineV1,
} from './application'
import { digestBytes } from './attempt-workspace'
import { digestJson } from './digest'
import {
  GitDerivedExecutionBaselineProviderV1,
  type VerifiedTaskChangeSetMaterialV1,
} from './git-derived-execution-baseline'
import { GitExecutionBaselineProviderV1 } from './git-execution-baseline'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'

const TEMP_PARENT = 'D:\\CodexTemp\\xiaogui-hub-m2c-m4g'
const PROJECT_ID = `xgp1_${'7'.repeat(64)}`
const ADDRESS = { projectId: PROJECT_ID, sessionKey: `xgs1_${'8'.repeat(64)}` } as HubAddressV1
const roots: string[] = []

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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })))
}, 30_000)

describe('cross-application derived baseline scheduling', () => {
  it('shares one SQLite-reserved derivation for the same request and verified ancestor', async () => {
    const fixture = await fixtureRoot()
    const setup = applicationFor(fixture, [
      'xhbf_concurrent',
      'xhbr_concurrent',
      'xhbts_concurrent_parent',
      'xhbts_concurrent_child',
      'xhbtr_concurrent_parent',
      'xhbtr_concurrent_child',
    ], new Map())
    await setup.execute(userRequest('req-concurrent-start', {
      type: 'flow.start.with_draft',
      draft: parentChildDraft(),
    }))
    const draft = await setup.observeM2B(ADDRESS)
    if (!draft.ok || !draft.value.activeFlow || !draft.value.activeRevision) throw new Error('expected draft flow')
    await setup.execute(userRequest('req-concurrent-approve', {
      type: 'plan.revision.submit',
      flowId: draft.value.activeFlow.flowId,
      baseRevisionId: draft.value.activeRevision.revisionId,
      draft: draft.value.activeRevision.draft,
    }))
    const approved = await setup.observeM2B(ADDRESS)
    if (!approved.ok || !approved.value.activeFlow || !approved.value.activeRevision) throw new Error('expected active plan')
    const parent = approved.value.taskRuns.find((task) => task.taskKey === 'parent')
    if (!parent) throw new Error('expected parent task')
    const material = taskMaterial(
      approved.value.activeFlow.flowId,
      approved.value.activeRevision.revisionId,
      parent.taskRunId,
    )
    seedVerifiedAncestor(fixture.dbPath, material)
    setup.close()

    const materials = new Map([[material.changeSet.taskChangeSetId, material]])
    const first = applicationFor(fixture, ['xhba_concurrent_first'], materials)
    const second = applicationFor(fixture, ['xhba_concurrent_second'], materials)
    const current = await first.observeM2B(ADDRESS)
    if (!current.ok || !current.value.activeFlow) throw new Error('expected active flow')
    const request = systemScheduleRequest(current.value.activeFlow.flowId)

    try {
      const [firstOutcome, secondOutcome] = await Promise.all([
        first.executeSystem(request),
        second.executeSystem(request),
      ])

      expect(firstOutcome).toEqual(secondOutcome)
      expect(firstOutcome).toMatchObject({ ok: true, value: { requestId: request.requestId } })
      const store = new CollaborationHubSqliteStoreV1(fixture.dbPath)
      try {
        expect(store.tableCounts()).toMatchObject({
          attempts: 1,
          execution_waves: 1,
          derived_execution_baselines: 1,
          derived_execution_baseline_reservations: 0,
        })
      } finally {
        store.close()
      }
      expect((await git(fixture.repo, ['worktree', 'list', '--porcelain'])).includes('delivery-')).toBe(false)
    } finally {
      first.close()
      second.close()
    }
  })

  it('does not revive a cancelled flow when verified-ancestor derivation finishes late', async () => {
    const fixture = await fixtureRoot()
    const setup = applicationFor(fixture, [
      'xhbf_cancel_race',
      'xhbr_cancel_race',
      'xhbts_cancel_parent',
      'xhbts_cancel_child',
      'xhbtr_cancel_parent',
      'xhbtr_cancel_child',
    ], new Map())
    await setup.execute(userRequest('req-cancel-race-start', {
      type: 'flow.start.with_draft',
      draft: parentChildDraft(),
    }))
    const draft = await setup.observeM2B(ADDRESS)
    if (!draft.ok || !draft.value.activeFlow || !draft.value.activeRevision) throw new Error('expected draft flow')
    await setup.execute(userRequest('req-cancel-race-approve', {
      type: 'plan.revision.submit',
      flowId: draft.value.activeFlow.flowId,
      baseRevisionId: draft.value.activeRevision.revisionId,
      draft: draft.value.activeRevision.draft,
    }))
    const approved = await setup.observeM2B(ADDRESS)
    if (!approved.ok || !approved.value.activeFlow || !approved.value.activeRevision) throw new Error('expected active plan')
    const parent = approved.value.taskRuns.find((task) => task.taskKey === 'parent')
    if (!parent) throw new Error('expected parent task')
    const material = taskMaterial(
      approved.value.activeFlow.flowId,
      approved.value.activeRevision.revisionId,
      parent.taskRunId,
    )
    seedVerifiedAncestor(fixture.dbPath, material)
    setup.close()

    let signalDerivationStarted!: () => void
    let releaseDerivation!: () => void
    const derivationStarted = new Promise<void>((resolve) => { signalDerivationStarted = resolve })
    const derivationGate = new Promise<void>((resolve) => { releaseDerivation = resolve })
    const slowProvider: DerivedExecutionBaselineProviderV1 = {
      derive: async (input) => {
        signalDerivationStarted()
        await derivationGate
        return derivedBaseline(input)
      },
    }
    const app = applicationFor(
      fixture,
      ['xhba_cancel_race_late'],
      new Map([[material.changeSet.taskChangeSetId, material]]),
      slowProvider,
    )
    const beforeSchedule = await app.observeM2B(ADDRESS)
    if (!beforeSchedule.ok || !beforeSchedule.value.activeFlow) throw new Error('expected schedulable flow')
    const flowId = beforeSchedule.value.activeFlow.flowId
    const request = systemScheduleRequest(flowId, beforeSchedule.value.sessionVersion)
    const schedule = app.executeSystem(request)

    try {
      await derivationStarted
      await expect(app.execute(userRequest('req-cancel-race-cancel', {
        type: 'flow.cancel',
        flowId,
        reason: 'cancel while derived baseline is pending',
      }, beforeSchedule.value.sessionVersion))).resolves.toMatchObject({ ok: true })
      releaseDerivation()

      await expect(schedule).resolves.toMatchObject({ ok: false, error: { code: 'STALE_SESSION_VERSION' } })
      await expect(app.executeSystem(request)).resolves.toMatchObject({
        ok: false,
        error: { code: 'STALE_SESSION_VERSION' },
      })
      await expect(app.observeM2B(ADDRESS)).resolves.toMatchObject({
        ok: true,
        value: {
          activeFlow: null,
          attempts: [],
          history: expect.arrayContaining([expect.objectContaining({ flowId, status: 'CANCELLED' })]),
        },
      })
    } finally {
      releaseDerivation()
      app.close()
    }

    const store = new CollaborationHubSqliteStoreV1(fixture.dbPath)
    try {
      expect(store.tableCounts()).toMatchObject({
        attempts: 0,
        execution_waves: 0,
        flow_execution_baselines: 0,
        task_execution_baselines: 0,
      })
    } finally {
      store.close()
    }
    const restarted = applicationFor(fixture, [], new Map())
    try {
      await expect(restarted.executeSystem(request)).resolves.toMatchObject({
        ok: false,
        error: { code: 'STALE_SESSION_VERSION' },
      })
      await expect(restarted.observeM2B(ADDRESS)).resolves.toMatchObject({
        ok: true,
        value: {
          activeFlow: null,
          attempts: [],
          history: expect.arrayContaining([expect.objectContaining({ flowId, status: 'CANCELLED' })]),
        },
      })
    } finally {
      restarted.close()
    }
  })
})

async function fixtureRoot() {
  await mkdir(TEMP_PARENT, { recursive: true })
  const root = await mkdtemp(join(TEMP_PARENT, 'derived-application-race-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  await git(root, ['init', 'repo'])
  await git(repo, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(repo, 'src/value.txt'), 'base\n')
  await git(repo, ['add', '.'])
  await git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'])
  return {
    root,
    repo,
    managedRoot: join(root, 'derived-baseline-worktrees'),
    dbPath: join(root, 'hub.sqlite'),
  }
}

function applicationFor(
  fixture: Awaited<ReturnType<typeof fixtureRoot>>,
  ids: string[],
  materials: ReadonlyMap<TaskChangeSetId, VerifiedTaskChangeSetMaterialV1>,
  derivedBaselineProvider?: DerivedExecutionBaselineProviderV1,
) {
  let index = 0
  const projectResolver = { resolveProjectRoot: () => fixture.repo }
  return createCollaborationHubApplicationV1({
    lookup: lookup(),
    storeFactory: () => new CollaborationHubSqliteStoreV1(fixture.dbPath),
    agentRuntime: createAgentRuntimeHostV1(new ScriptedAgentRuntimeAdapterV1({
      capabilities: [approvedCapability],
      createRuntimeSessionId: 'runtime-concurrent',
    })),
    baselineProvider: new GitExecutionBaselineProviderV1(projectResolver),
    derivedBaselineProvider: derivedBaselineProvider ?? new GitDerivedExecutionBaselineProviderV1({
      storeFactory: () => new CollaborationHubSqliteStoreV1(fixture.dbPath),
      projectResolver,
      managedRoot: fixture.managedRoot,
      taskChangeSetReader: { read: (id) => materials.get(id) ?? null },
      now: () => '2026-08-27T00:00:00.000Z',
    }),
    now: () => '2026-08-27T00:00:00.000Z',
    idFactory: (prefix) => ids[index++] ?? `${prefix}_unexpected_${index}`,
  })
}

function lookup(): SessionScopeLookupV1 {
  return {
    lookup: async (address: SessionAddressV1) => ({
      kind: 'FOUND' as const,
      scope: { ...address, sessionMode: 'CODING' as const },
    }),
  }
}

function parentChildDraft(): InitialPlanDraftInputV1 {
  return {
    objective: '验证已通过父任务后的并发派生',
    tasks: [
      { taskKey: 'parent', title: '已验证父任务' },
      { taskKey: 'child', title: '并发调度子任务', dependsOn: ['parent'] },
    ],
  }
}

function userRequest(
  requestId: string,
  intent: Parameters<ReturnType<typeof applicationFor>['execute']>[0]['intent'],
  expectedSessionVersion?: number,
) {
  return {
    contractVersion: 'm2a.v1' as const,
    address: ADDRESS,
    trustedActor: { kind: 'main-process-user' as const },
    requestId,
    ...(expectedSessionVersion === undefined ? {} : { expectedSessionVersion }),
    intent,
  }
}

function systemScheduleRequest(flowId: FlowId, expectedSessionVersion?: number): HubSystemCommandRequestM2BV1 {
  const pathTokens = [`sha256:${digestJson({ role: 'derived-concurrency-scope' })}` as Sha256Digest]
  const scopeBase = { version: 1 as const, pathTokens }
  const authorizationScope = {
    ...scopeBase,
    scopeDigest: `sha256:${digestJson(scopeBase)}` as Sha256Digest,
  } satisfies TaskFileAuthorizationScopeV1
  return {
    contractVersion: 'm2b.v1',
    address: ADDRESS,
    trustedActor: { kind: 'main-process-system' },
    requestId: 'sys-derived-concurrent',
    ...(expectedSessionVersion === undefined ? {} : { expectedSessionVersion }),
    intent: {
      type: 'system.schedule',
      flowId,
      authorizationScope,
      executionInputDigest: `sha256:${'9'.repeat(64)}` as Sha256Digest,
    },
  }
}

function derivedBaseline(
  input: Parameters<DerivedExecutionBaselineProviderV1['derive']>[0],
): DerivedTaskExecutionBaselineV1 {
  const baselineDigest = digestJson({
    baselineId: input.flowBaseline.baselineId,
    ...(input.flowBaseline.baseRevision ? { baseRevision: input.flowBaseline.baseRevision } : {}),
    baselineTreeHash: input.flowBaseline.baselineTreeHash,
    initialTargetFingerprint: input.flowBaseline.initialTargetFingerprint,
  })
  const value = {
    version: 1 as const,
    taskRunId: input.taskRunId,
    ancestorTaskChangeSetIds: input.ancestorTaskChangeSetIds,
    baselineId: input.flowBaseline.baselineId,
    ...(input.flowBaseline.baseRevision ? { baseRevision: input.flowBaseline.baseRevision } : {}),
    baselineTreeHash: input.flowBaseline.baselineTreeHash,
    initialTargetFingerprint: input.flowBaseline.initialTargetFingerprint,
    baselineDigest,
  }
  return { ...value, derivationDigest: digestJson(value) }
}

function taskMaterial(
  flowId: FlowId,
  planRevisionId: PlanRevisionId,
  taskRunId: TaskRunId,
): VerifiedTaskChangeSetMaterialV1 {
  const taskChangeSetId = 'xhbtcs_concurrent_parent' as TaskChangeSetId
  const patchArtifactId = 'xhart_concurrent_parent' as ArtifactId
  const after = 'from verified parent\n'
  const patchBytes = Buffer.from(JSON.stringify({
    kind: 'TASK_PATCH_V1',
    version: 1,
    files: [{
      operation: 'MODIFY',
      relativePath: 'src/value.txt',
      baselineDigest: digestBytes('base\n'),
      contentDigest: digestBytes(after),
      contentBase64: Buffer.from(after).toString('base64'),
    }],
  }))
  const withoutDigest = {
    kind: 'TASK' as const,
    taskChangeSetId,
    version: 1 as const,
    flowId,
    planRevisionId,
    taskRunId,
    attemptId: 'xhba_verified_parent' as AttemptId,
    verificationAttemptId: 'xhbva_verified_parent' as VerificationAttemptId,
    candidateId: 'xhbcand_verified_parent' as TaskChangeSetCandidateId,
    inputTreeHash: `sha256:${'a'.repeat(64)}` as Sha256Digest,
    resultTreeHash: `sha256:${'b'.repeat(64)}` as Sha256Digest,
    ancestorTaskChangeSetIds: [] as readonly TaskChangeSetId[],
    patchArtifactId,
    evidenceBundleId: 'xhbe_verified_parent' as EvidenceBundleId,
    qaResultId: 'xhbqa_verified_parent' as QaResultId,
    qaConfigVersion: 'xiaogui.coding.task.v1',
    createdAt: '2026-08-27T00:00:00.000Z' as IsoDateTime,
  }
  const changeSet: TaskChangeSetV1 = {
    ...withoutDigest,
    digest: taskChangeSetDigestV1(withoutDigest),
  }
  return {
    changeSet,
    patchArtifact: {
      artifactId: patchArtifactId,
      digest: digestBytes(patchBytes) as Sha256Digest,
      bytes: patchBytes,
    },
  }
}

function seedVerifiedAncestor(dbPath: string, material: VerifiedTaskChangeSetMaterialV1): void {
  const changeSet = material.changeSet
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma foreign_keys = off')
    db.prepare("update task_runs set status = 'VERIFIED' where task_run_id = ?").run(changeSet.taskRunId)
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
  } finally {
    db.close()
  }
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message))
        return
      }
      resolve(stdout ?? '')
    })
  })
}
