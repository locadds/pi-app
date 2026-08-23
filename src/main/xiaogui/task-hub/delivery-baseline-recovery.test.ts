import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  deliveryChangeSetDigestV1,
  deliveryTargetFingerprintV1,
  type DeliveryBatchId,
  type DeliveryChangeSetId,
  type DeliveryChangeSetV1,
  type DeliverySelectionDraftId,
  type DeliveryTargetV1,
} from '@shared/xiaogui-delivery'
import type { ArtifactId, Sha256Digest, TaskChangeSetId } from '@shared/xiaogui-task-verification'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  DeliveryBaselineRecoveryErrorV1,
  MainProcessDeliveryBaselineRecoveryPortV1,
  type DeliveryBaselineRecoveryDesiredFileV1,
} from './delivery-baseline-recovery'

const TEST_ROOT = 'E:\\CodexTemp\\m4f-b-tests'
const PROJECT_ID = 'project-delivery-recovery'
const CREATED_AT = '2026-08-24T00:00:00.000Z'

const rootsToRemove: string[] = []

beforeAll(async () => {
  await mkdir(TEST_ROOT, { recursive: true })
})

afterEach(async () => {
  const root = rootsToRemove.pop()
  if (root) await rm(root, { recursive: true, force: true })
})

describe('MainProcessDeliveryBaselineRecoveryPortV1', () => {
  it('three-way merges MODIFY and carries CREATE without writing the original target, then explicit cleanup removes the managed worktree', async () => {
    const fixture = await createFixture('merge-success')
    await writeRepoFile(fixture.repoRoot, 'docs/plan.md', 'alpha\nleft: base\nmiddle\nright: base\nomega\n')
    await git(fixture.repoRoot, ['add', 'docs/plan.md'])
    await git(fixture.repoRoot, ['commit', '-m', 'base'])
    const sourceTarget = await targetFor(fixture.repoRoot)
    const baseContent = await readFile(join(fixture.repoRoot, 'docs/plan.md'))

    await writeRepoFile(fixture.repoRoot, 'docs/plan.md', 'alpha\nleft: current\nmiddle\nright: base\nomega\n')
    await git(fixture.repoRoot, ['commit', '-am', 'current'])
    const currentTarget = await targetFor(fixture.repoRoot)
    const targetContentBefore = await readFile(join(fixture.repoRoot, 'docs/plan.md'), 'utf8')

    const modifyDesired = Buffer.from('alpha\nleft: base\nmiddle\nright: desired\nomega\n')
    const createDesired = Buffer.from('new child file\n')
    const desiredFiles = [
      desiredFile('docs/plan.md', 'artifact-plan', modifyDesired),
      desiredFile('notes/created.md', 'artifact-created', createDesired),
    ]
    const sourceChangeSet = changeSet(sourceTarget, [
      {
        operation: 'MODIFY',
        relativePath: 'docs/plan.md',
        baselineDigest: digestBytes(baseContent),
        contentDigest: digestBytes(modifyDesired),
        contentArtifactId: 'artifact-plan' as ArtifactId,
        sourceTaskChangeSetIds: ['task-change-plan' as TaskChangeSetId],
      },
      {
        operation: 'CREATE',
        relativePath: 'notes/created.md',
        baselineDigest: null,
        contentDigest: digestBytes(createDesired),
        contentArtifactId: 'artifact-created' as ArtifactId,
        sourceTaskChangeSetIds: ['task-change-created' as TaskChangeSetId],
      },
    ])

    const port = recoveryPort(fixture)
    const result = await port.recover({
      sourceBatchId: sourceChangeSet.batchId,
      sourceChangeSet,
      desiredFiles,
      currentTarget,
    })

    const worktreeRoot = result.privateIntegrationContext.worktreeRoot
    expect(await readFile(join(worktreeRoot, 'docs/plan.md'), 'utf8')).toBe('alpha\nleft: current\nmiddle\nright: desired\nomega\n')
    expect(await readFile(join(worktreeRoot, 'notes/created.md'), 'utf8')).toBe('new child file\n')
    expect(result.evidenceMaterial).toMatchObject({
      recoveredFileCount: 2,
      directReplacementCount: 0,
      threeWayMergeCount: 1,
      createCount: 1,
    })
    expect(await readFile(join(fixture.repoRoot, 'docs/plan.md'), 'utf8')).toBe(targetContentBefore)
    expect(existsSync(join(fixture.repoRoot, 'notes/created.md'))).toBe(false)
    expect(await git(fixture.repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    expect(existsSync(worktreeRoot)).toBe(true)

    await port.cleanup(result.privateIntegrationContext)

    expect(existsSync(worktreeRoot)).toBe(false)
    expect(existsSync(`${worktreeRoot}-inputs`)).toBe(false)
    expect(await managedRecoveryEntries(fixture.managedRoot)).toEqual([])
    expect(await git(fixture.repoRoot, ['worktree', 'list', '--porcelain'])).not.toContain(worktreeRoot)
    expect(await readFile(join(fixture.repoRoot, 'docs/plan.md'), 'utf8')).toBe(targetContentBefore)
    expect(await git(fixture.repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
  })

  it('fails closed on overlapping MODIFY conflicts and cleans the managed worktree and merge inputs while leaving the original target untouched', async () => {
    const fixture = await createFixture('merge-conflict')
    await writeRepoFile(fixture.repoRoot, 'docs/plan.md', 'alpha\nshared: base\nomega\n')
    await git(fixture.repoRoot, ['add', 'docs/plan.md'])
    await git(fixture.repoRoot, ['commit', '-m', 'base'])
    const sourceTarget = await targetFor(fixture.repoRoot)
    const baseContent = await readFile(join(fixture.repoRoot, 'docs/plan.md'))

    await writeRepoFile(fixture.repoRoot, 'docs/plan.md', 'alpha\nshared: current\nomega\n')
    await git(fixture.repoRoot, ['commit', '-am', 'current'])
    const currentTarget = await targetFor(fixture.repoRoot)
    const targetContentBefore = await readFile(join(fixture.repoRoot, 'docs/plan.md'), 'utf8')

    const desired = Buffer.from('alpha\nshared: desired\nomega\n')
    const sourceChangeSet = changeSet(sourceTarget, [{
      operation: 'MODIFY',
      relativePath: 'docs/plan.md',
      baselineDigest: digestBytes(baseContent),
      contentDigest: digestBytes(desired),
      contentArtifactId: 'artifact-conflict' as ArtifactId,
      sourceTaskChangeSetIds: ['task-change-conflict' as TaskChangeSetId],
    }])

    const port = recoveryPort(fixture)
    await expect(port.recover({
      sourceBatchId: sourceChangeSet.batchId,
      sourceChangeSet,
      desiredFiles: [desiredFile('docs/plan.md', 'artifact-conflict', desired)],
      currentTarget,
    })).rejects.toMatchObject({ reasonCode: 'DELIVERY_RECOVERY_FILE_CONFLICT' })

    expect(await readFile(join(fixture.repoRoot, 'docs/plan.md'), 'utf8')).toBe(targetContentBefore)
    expect(await git(fixture.repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    expect(await managedRecoveryEntries(fixture.managedRoot)).toEqual([])
    expect(await git(fixture.repoRoot, ['worktree', 'list', '--porcelain'])).not.toContain('delivery-recovery-')
  })

  it('returns DELIVERY_RECOVERY_TARGET_DIRTY before creating a recovery worktree when the original target has local changes', async () => {
    const fixture = await createFixture('target-dirty')
    await writeRepoFile(fixture.repoRoot, 'docs/plan.md', 'alpha\nbase\nomega\n')
    await git(fixture.repoRoot, ['add', 'docs/plan.md'])
    await git(fixture.repoRoot, ['commit', '-m', 'base'])
    const sourceTarget = await targetFor(fixture.repoRoot)
    const baseContent = await readFile(join(fixture.repoRoot, 'docs/plan.md'))
    const desired = Buffer.from('alpha\ndesired\nomega\n')
    const sourceChangeSet = changeSet(sourceTarget, [{
      operation: 'MODIFY',
      relativePath: 'docs/plan.md',
      baselineDigest: digestBytes(baseContent),
      contentDigest: digestBytes(desired),
      contentArtifactId: 'artifact-dirty' as ArtifactId,
      sourceTaskChangeSetIds: ['task-change-dirty' as TaskChangeSetId],
    }])

    await writeRepoFile(fixture.repoRoot, 'docs/plan.md', 'alpha\nlocally dirty\nomega\n')

    const port = recoveryPort(fixture)
    const recovery = port.recover({
      sourceBatchId: sourceChangeSet.batchId,
      sourceChangeSet,
      desiredFiles: [desiredFile('docs/plan.md', 'artifact-dirty', desired)],
      currentTarget: sourceTarget,
    })
    await expect(recovery).rejects.toBeInstanceOf(DeliveryBaselineRecoveryErrorV1)
    await expect(recovery).rejects.toMatchObject({ reasonCode: 'DELIVERY_RECOVERY_TARGET_DIRTY' })

    expect(await readFile(join(fixture.repoRoot, 'docs/plan.md'), 'utf8')).toBe('alpha\nlocally dirty\nomega\n')
    expect(await managedRecoveryEntries(fixture.managedRoot)).toEqual([])
    expect(await git(fixture.repoRoot, ['worktree', 'list', '--porcelain'])).not.toContain('delivery-recovery-')
  })
})

interface Fixture {
  readonly root: string
  readonly repoRoot: string
  readonly managedRoot: string
}

async function createFixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(join(TEST_ROOT, `${name}-`))
  rootsToRemove.push(root)
  const repoRoot = join(root, 'target-repo')
  const managedRoot = join(root, 'managed-recovery')
  await mkdir(repoRoot, { recursive: true })
  await mkdir(managedRoot, { recursive: true })
  await git(repoRoot, ['init'])
  await git(repoRoot, ['config', 'user.email', 'xiaogui@example.test'])
  await git(repoRoot, ['config', 'user.name', 'Xiaogui Test'])
  await git(repoRoot, ['config', 'core.autocrlf', 'false'])
  return { root, repoRoot, managedRoot }
}

function recoveryPort(fixture: Fixture): MainProcessDeliveryBaselineRecoveryPortV1 {
  return new MainProcessDeliveryBaselineRecoveryPortV1({
    managedRoot: fixture.managedRoot,
    projectResolver: { resolveProjectRoot: async () => fixture.repoRoot },
  })
}

async function targetFor(repoRoot: string): Promise<DeliveryTargetV1> {
  const baseRevision = (await git(repoRoot, ['rev-parse', '--verify', 'HEAD'])).trim()
  const baselineTreeHash = (await git(repoRoot, ['rev-parse', '--verify', 'HEAD^{tree}'])).trim()
  return {
    projectId: PROJECT_ID,
    baseRevision,
    baselineTreeHash,
    initialTargetFingerprint: deliveryTargetFingerprintV1({ projectId: PROJECT_ID, baseRevision, baselineTreeHash }),
  }
}

function changeSet(
  target: DeliveryTargetV1,
  fileChanges: DeliveryChangeSetV1['fileChanges'],
): DeliveryChangeSetV1 {
  const value = {
    kind: 'DELIVERY_CHANGESET' as const,
    version: 1 as const,
    deliveryChangeSetId: 'delivery-change-set' as DeliveryChangeSetId,
    batchId: 'delivery-batch' as DeliveryBatchId,
    selectionDraftId: 'delivery-selection-draft' as DeliverySelectionDraftId,
    flowId: 'flow-delivery-recovery' as DeliveryChangeSetV1['flowId'],
    selectionDigest: sha('selection'),
    taskChangeSetIds: fileChanges.flatMap((file) => file.sourceTaskChangeSetIds),
    taskChangeSets: fileChanges.flatMap((file) => file.sourceTaskChangeSetIds.map((taskChangeSetId) => ({
      taskRunId: `run-${taskChangeSetId}` as DeliveryChangeSetV1['taskChangeSets'][number]['taskRunId'],
      taskChangeSetId,
      digest: sha(`task-${taskChangeSetId}`),
      patchArtifactId: `patch-${taskChangeSetId}` as ArtifactId,
    }))),
    dependencyOrder: fileChanges.flatMap((file) => file.sourceTaskChangeSetIds),
    fileChanges,
    target,
    integrationTreeHash: sha('integration-tree'),
    evidenceArtifactIds: ['artifact-evidence' as ArtifactId],
    qaConfigVersion: 'qa-v1',
    createdAt: CREATED_AT as DeliveryChangeSetV1['createdAt'],
  }
  return { ...value, digest: deliveryChangeSetDigestV1(value) }
}

function desiredFile(
  relativePath: string,
  contentArtifactId: string,
  content: Buffer,
): DeliveryBaselineRecoveryDesiredFileV1 {
  return {
    relativePath,
    contentArtifactId: contentArtifactId as ArtifactId,
    contentDigest: digestBytes(content),
    content,
  }
}

async function writeRepoFile(repoRoot: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(repoRoot, relativePath)
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, content)
}

async function managedRecoveryEntries(managedRoot: string): Promise<readonly string[]> {
  return (await readdir(managedRoot)).filter((name) => name.startsWith('delivery-recovery-')).sort()
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`))
        return
      }
      resolvePromise(stdout ?? '')
    })
  })
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}

function sha(value: string): Sha256Digest {
  return digestBytes(Buffer.from(value))
}
