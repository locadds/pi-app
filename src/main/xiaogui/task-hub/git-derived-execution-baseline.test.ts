import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AttemptId, FlowId, HubAddressV1, PlanRevisionId, TaskRunId } from '@shared/xiaogui-collaboration-hub'
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

import { GitExecutionBaselineProviderV1 } from './git-execution-baseline'
import {
  GitDerivedExecutionBaselineProviderV1,
  type VerifiedTaskChangeSetMaterialV1,
} from './git-derived-execution-baseline'
import {
  GitAttemptWorkspaceServiceV1,
  SqliteAttemptWorkspaceRegistryV1,
  digestBytes,
} from './attempt-workspace'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'

const TEMP_PARENT = 'D:\\CodexTemp\\xiaogui-hub-m2c-m4g'
const PROJECT_ID = `xgp1_${'1'.repeat(64)}`
const ADDRESS = { projectId: PROJECT_ID, sessionKey: `xgs1_${'2'.repeat(64)}` } as HubAddressV1
const FLOW_ID = 'xhbf_derived_flow' as FlowId
const DOWNSTREAM_TASK_RUN_ID = 'xhbtr_task_c' as TaskRunId
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })))
}, 30_000)

describe('GitDerivedExecutionBaselineProviderV1', () => {
  it('materializes verified task A into task C baseline and C attempt worktree sees A without touching the source worktree', async () => {
    const fixture = await fixtureRoot()
    const material = taskMaterial('a', 'base\n', 'from A\n')
    const provider = derivedProvider(fixture, new Map([[material.changeSet.taskChangeSetId, material]]))
    const baseline = await provider.derive(await deriveInput(fixture.repo, [material.changeSet.taskChangeSetId]))

    expect(await readFile(join(fixture.repo, 'src/value.txt'), 'utf8')).toBe('base\n')
    expect(await git(fixture.repo, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    expect(await git(fixture.repo, ['show', `${baseline.baseRevision}:src/value.txt`])).toBe('from A\n')
    expect(await git(fixture.repo, ['rev-parse', `${baseline.baseRevision}^{tree}`])).toBe(`${baseline.baselineTreeHash}\n`)
    expect(existsSync(fixture.managedRoot)).toBe(true)
    expect((await git(fixture.repo, ['worktree', 'list', '--porcelain'])).includes('delivery-')).toBe(false)

    const registry = new SqliteAttemptWorkspaceRegistryV1({ dbPath: join(fixture.root, 'attempt-workspaces.sqlite') })
    try {
      const workspace = new GitAttemptWorkspaceServiceV1(
        registry,
        { resolveProjectRoot: () => fixture.repo },
        { managedRoot: join(fixture.root, 'attempt-worktrees') },
      )
      const prepared = await workspace.prepare({
        attemptId: 'xhba_task_c' as AttemptId,
        compositionAttemptId: 'xhbc_task_c',
        requestDigest: 'sha256:workspace-request-c',
        baselineBindingDigest: 'sha256:baseline-binding-c',
        compositionDigest: 'sha256:composition-c',
        projectId: PROJECT_ID,
        baseRevision: baseline.baseRevision!,
        baselineTreeHash: baseline.baselineTreeHash,
        manifest: {
          attemptId: 'xhba_task_c',
          version: 1,
          grants: [{ operation: 'MODIFY', relativePath: 'src/value.txt', baselineDigest: digestBytes('from A\n') }],
        },
        ownerId: 'xiaogui-main-process',
      })
      expect(await readFile(join(prepared.handle.rootPath, 'src/value.txt'), 'utf8')).toBe('from A\n')
      await git(fixture.repo, ['worktree', 'remove', '--force', prepared.handle.rootPath])
      await git(fixture.repo, ['worktree', 'prune'])
    } finally {
      registry.close()
    }
  })

  it('squashes two non-overlapping verified ancestors without changing source refs or index', async () => {
    const fixture = await fixtureRoot()
    const first = taskMaterial('non-overlap-a', 'base\n', 'from A\n')
    const second = taskMaterial('non-overlap-b', null, 'from B\n', [], 'src/other.txt')
    const before = await sourceGitState(fixture.repo)
    const provider = derivedProvider(fixture, new Map([
      [first.changeSet.taskChangeSetId, first],
      [second.changeSet.taskChangeSetId, second],
    ]))

    const baseline = await provider.derive(await deriveInput(fixture.repo, [
      first.changeSet.taskChangeSetId,
      second.changeSet.taskChangeSetId,
    ]))

    expect(await git(fixture.repo, ['show', `${baseline.baseRevision}:src/value.txt`])).toBe('from A\n')
    expect(await git(fixture.repo, ['show', `${baseline.baseRevision}:src/other.txt`])).toBe('from B\n')
    await expectSourceGitState(fixture.repo, before)
    expect(await git(fixture.repo, ['branch', '--contains', baseline.baseRevision!])).toBe('')
    expect((await git(fixture.repo, ['worktree', 'list', '--porcelain'])).includes('delivery-')).toBe(false)
  })

  it('applies same-file ancestors in dependency order when each precondition matches the previous result', async () => {
    const fixture = await fixtureRoot()
    const first = taskMaterial('ordered-a', 'base\n', 'from A\n')
    const second = taskMaterial(
      'ordered-b',
      'from A\n',
      'from B\n',
      [first.changeSet.taskChangeSetId],
    )
    const before = await sourceGitState(fixture.repo)
    const provider = derivedProvider(fixture, new Map([
      [first.changeSet.taskChangeSetId, first],
      [second.changeSet.taskChangeSetId, second],
    ]))

    const baseline = await provider.derive(await deriveInput(fixture.repo, [
      first.changeSet.taskChangeSetId,
      second.changeSet.taskChangeSetId,
    ]))

    expect(await git(fixture.repo, ['show', `${baseline.baseRevision}:src/value.txt`])).toBe('from B\n')
    await expectSourceGitState(fixture.repo, before)
    expect(await git(fixture.repo, ['branch', '--contains', baseline.baseRevision!])).toBe('')
    expect((await git(fixture.repo, ['worktree', 'list', '--porcelain'])).includes('delivery-')).toBe(false)
  })

  it('fails closed on a conflicting later ancestor and cleans the private worktree', async () => {
    const fixture = await fixtureRoot()
    const first = taskMaterial('conflicting-a', 'base\n', 'from A\n')
    const second = taskMaterial(
      'conflicting-b',
      'base\n',
      'unsafe B\n',
      [first.changeSet.taskChangeSetId],
    )
    const before = await sourceGitState(fixture.repo)
    const provider = derivedProvider(fixture, new Map([
      [first.changeSet.taskChangeSetId, first],
      [second.changeSet.taskChangeSetId, second],
    ]))

    await expect(provider.derive(await deriveInput(fixture.repo, [
      first.changeSet.taskChangeSetId,
      second.changeSet.taskChangeSetId,
    ]))).rejects.toMatchObject({ reasonCode: 'DELIVERY_WORKTREE_BASELINE_DRIFT' })

    await expectSourceGitState(fixture.repo, before)
    expect((await git(fixture.repo, ['worktree', 'list', '--porcelain'])).includes('delivery-')).toBe(false)
    const store = new CollaborationHubSqliteStoreV1(fixture.dbPath)
    try {
      expect(store.tableCounts().derived_execution_baselines).toBe(0)
    } finally {
      store.close()
    }
  })

  it('fails closed on a patch baseline conflict and removes the private integration worktree', async () => {
    const fixture = await fixtureRoot()
    const conflicting = taskMaterial('conflict', 'not-the-base\n', 'unsafe\n')
    const provider = derivedProvider(fixture, new Map([[conflicting.changeSet.taskChangeSetId, conflicting]]))

    await expect(provider.derive(await deriveInput(fixture.repo, [conflicting.changeSet.taskChangeSetId]))).rejects.toMatchObject({
      reasonCode: 'DELIVERY_WORKTREE_BASELINE_DRIFT',
    })
    expect(await readFile(join(fixture.repo, 'src/value.txt'), 'utf8')).toBe('base\n')
    expect(await git(fixture.repo, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    expect((await git(fixture.repo, ['worktree', 'list', '--porcelain'])).includes('delivery-')).toBe(false)
    const store = new CollaborationHubSqliteStoreV1(fixture.dbPath)
    try {
      expect(store.tableCounts().derived_execution_baselines).toBe(0)
    } finally {
      store.close()
    }
  })

  it('reuses the persisted derived commit after provider restart without rematerializing a worktree', async () => {
    const fixture = await fixtureRoot()
    const material = taskMaterial('restart', 'base\n', 'persisted A\n')
    const materials = new Map([[material.changeSet.taskChangeSetId, material]])
    const input = await deriveInput(fixture.repo, [material.changeSet.taskChangeSetId])
    const first = await derivedProvider(fixture, materials).derive(input)
    await rm(fixture.managedRoot, { recursive: true, force: true })
    expect(existsSync(fixture.managedRoot)).toBe(false)

    const restarted = await derivedProvider(fixture, materials).derive(input)

    expect(restarted).toEqual(first)
    expect(existsSync(fixture.managedRoot)).toBe(false)
    const store = new CollaborationHubSqliteStoreV1(fixture.dbPath)
    try {
      expect(store.tableCounts().derived_execution_baselines).toBe(1)
    } finally {
      store.close()
    }
  })
})

async function fixtureRoot() {
  await mkdir(TEMP_PARENT, { recursive: true })
  const root = await mkdtemp(join(TEMP_PARENT, 'derived-baseline-'))
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

function derivedProvider(
  fixture: Awaited<ReturnType<typeof fixtureRoot>>,
  materials: ReadonlyMap<TaskChangeSetId, VerifiedTaskChangeSetMaterialV1>,
) {
  return new GitDerivedExecutionBaselineProviderV1({
    storeFactory: () => new CollaborationHubSqliteStoreV1(fixture.dbPath),
    projectResolver: { resolveProjectRoot: () => fixture.repo },
    managedRoot: fixture.managedRoot,
    taskChangeSetReader: { read: (id) => materials.get(id) ?? null },
    now: () => '2026-08-27T00:00:00.000Z',
  })
}

async function deriveInput(repo: string, ancestorTaskChangeSetIds: readonly TaskChangeSetId[]) {
  const flowBaseline = await new GitExecutionBaselineProviderV1({ resolveProjectRoot: () => repo }).capture({
    address: ADDRESS,
    flowId: FLOW_ID,
    planRevisionId: 'xhbr_derived' as PlanRevisionId,
  })
  return {
    address: ADDRESS,
    flowId: FLOW_ID,
    taskRunId: DOWNSTREAM_TASK_RUN_ID,
    flowBaseline,
    ancestorTaskChangeSetIds,
  }
}

function taskMaterial(
  suffix: string,
  before: string | null,
  after: string,
  ancestors: readonly TaskChangeSetId[] = [],
  relativePath = 'src/value.txt',
): VerifiedTaskChangeSetMaterialV1 {
  const taskChangeSetId = `xhbtcs_${suffix}` as TaskChangeSetId
  const patchArtifactId = `xhart_${suffix}` as ArtifactId
  const patchBytes = Buffer.from(JSON.stringify({
    kind: 'TASK_PATCH_V1',
    version: 1,
    files: [{
      operation: before === null ? 'CREATE' : 'MODIFY',
      relativePath,
      baselineDigest: before === null ? null : digestBytes(before),
      contentDigest: digestBytes(after),
      contentBase64: Buffer.from(after).toString('base64'),
    }],
  }))
  const withoutDigest = {
    kind: 'TASK' as const,
    taskChangeSetId,
    version: 1 as const,
    flowId: FLOW_ID,
    planRevisionId: 'xhbr_derived' as PlanRevisionId,
    taskRunId: `xhbtr_${suffix}` as TaskRunId,
    attemptId: `xhba_${suffix}` as AttemptId,
    verificationAttemptId: `xhbva_${suffix}` as VerificationAttemptId,
    candidateId: `xhbcand_${suffix}` as TaskChangeSetCandidateId,
    inputTreeHash: `sha256:${'a'.repeat(64)}` as Sha256Digest,
    resultTreeHash: `sha256:${'b'.repeat(64)}` as Sha256Digest,
    ancestorTaskChangeSetIds: ancestors,
    patchArtifactId,
    evidenceBundleId: `xhbe_${suffix}` as EvidenceBundleId,
    qaResultId: `xhbqa_${suffix}` as QaResultId,
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

async function sourceGitState(repo: string) {
  return {
    head: await git(repo, ['rev-parse', '--verify', 'HEAD']),
    refs: await git(repo, ['show-ref']),
    indexTree: await git(repo, ['write-tree']),
    status: await git(repo, ['status', '--porcelain=v1', '--untracked-files=all']),
  }
}

async function expectSourceGitState(repo: string, expected: Awaited<ReturnType<typeof sourceGitState>>): Promise<void> {
  expect(await sourceGitState(repo)).toEqual(expected)
  expect(await readFile(join(repo, 'src/value.txt'), 'utf8')).toBe('base\n')
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message))
        return
      }
      resolvePromise(stdout ?? '')
    })
  })
}
