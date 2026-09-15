import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AttemptId, FlowId, PlanRevisionId, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import {
  deliveryTargetFingerprintV1,
  type DeliveryApplyAttemptIdV1,
  type DeliveryChangeSetV2,
  type DeliveryTargetV1,
} from '@shared/xiaogui-delivery'
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

import { digestBytes } from './attempt-workspace'
import {
  DeliveryComposerV2,
  type DeliveryComposerTaskInputV2,
} from './delivery-composer'
import {
  cleanupDeliveryIntegrationWorktreeRootV1,
  MainProcessDeliveryIntegrationWorktreePortV1,
} from './delivery-integration-worktree'
import {
  MainProcessChangeApplyPortV1,
  MainProcessChangeApplyPortV2,
  SqliteDeliveryApplyAttemptRegistryV1,
} from './change-apply'

const roots: string[] = []
const PROJECT_ID = 'xgp1_single_accept_spike'
const FLOW_ID = 'xhbf_single_accept_spike' as FlowId
const CREATED_AT = '2026-09-15T00:00:00.000Z' as IsoDateTime

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

describe('single accept Delivery/Apply seam spike', () => {
  it('composes a DELETE+CREATE rename in a real integration worktree and applies it successfully', async () => {
    const fixture = await composeRename()
    try {
      expect(fixture.composed.changeSet.fileChanges.map((file) => file.operation)).toEqual(['DELETE', 'CREATE'])
      expect(fixture.composed.changeSet.fileChanges[0]).toMatchObject({
        relativePath: 'src/old.txt',
        rename: { groupId: 'rename-1', counterpartPath: 'src/new.txt', role: 'SOURCE' },
      })
      expect(fixture.composed.changeSet.fileChanges[1]).toMatchObject({
        relativePath: 'src/new.txt',
        rename: { groupId: 'rename-1', counterpartPath: 'src/old.txt', role: 'TARGET' },
      })
      await expect(readFile(join(fixture.integrationRoot, 'src', 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(fixture.integrationRoot, 'src', 'new.txt'), 'utf8')).resolves.toBe('renamed')

      const registry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath: join(fixture.root, 'apply.sqlite') })
      const port = new MainProcessChangeApplyPortV2({
        projectResolver: { resolveProjectRoot: () => fixture.projectRoot },
        registry,
      })
      const receipt = await port.apply({
        applyAttemptId: 'xhbaa_success' as DeliveryApplyAttemptIdV1,
        approval: approvalFor(fixture.composed.changeSet),
        changeSet: fixture.composed.changeSet,
        fileContents: fixture.applyContents,
      })

      expect(receipt.verdict).toBe('SUCCEEDED')
      expect(receipt.changedRelativePaths).toEqual(['src/new.txt', 'src/old.txt'])
      await expect(readFile(join(fixture.projectRoot, 'src', 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(fixture.projectRoot, 'src', 'new.txt'), 'utf8')).resolves.toBe('renamed')
      registry.close()
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  it('rejects a changed rename source before touching either side', async () => {
    const fixture = await composeRename('conflict')
    try {
      await writeFile(join(fixture.projectRoot, 'src', 'old.txt'), 'user change')
      const registry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath: join(fixture.root, 'apply-conflict.sqlite') })
      const port = new MainProcessChangeApplyPortV2({
        projectResolver: { resolveProjectRoot: () => fixture.projectRoot },
        registry,
        gitSnapshotReader: cleanSnapshotFor(fixture.target),
      })

      await expect(port.apply({
        applyAttemptId: 'xhbaa_conflict' as DeliveryApplyAttemptIdV1,
        approval: approvalFor(fixture.composed.changeSet),
        changeSet: fixture.composed.changeSet,
        fileContents: fixture.applyContents,
      })).rejects.toMatchObject({ reasonCode: 'TARGET_FILE_DRIFT' })
      await expect(readFile(join(fixture.projectRoot, 'src', 'old.txt'), 'utf8')).resolves.toBe('user change')
      expect(existsSync(join(fixture.projectRoot, 'src', 'new.txt'))).toBe(false)
      registry.close()
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  it('rejects an occupied rename target before deleting the source', async () => {
    const fixture = await composeRename('target-conflict')
    try {
      await writeFile(join(fixture.projectRoot, 'src', 'new.txt'), 'user target')
      const registry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath: join(fixture.root, 'apply-target-conflict.sqlite') })
      const port = new MainProcessChangeApplyPortV2({
        projectResolver: { resolveProjectRoot: () => fixture.projectRoot },
        registry,
        gitSnapshotReader: cleanSnapshotFor(fixture.target),
      })

      await expect(port.apply({
        applyAttemptId: 'xhbaa_target_conflict' as DeliveryApplyAttemptIdV1,
        approval: approvalFor(fixture.composed.changeSet),
        changeSet: fixture.composed.changeSet,
        fileContents: fixture.applyContents,
      })).rejects.toMatchObject({ reasonCode: 'TARGET_FILE_DRIFT' })
      await expect(readFile(join(fixture.projectRoot, 'src', 'old.txt'), 'utf8')).resolves.toBe('old')
      await expect(readFile(join(fixture.projectRoot, 'src', 'new.txt'), 'utf8')).resolves.toBe('user target')
      registry.close()
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  it('restores the deleted source when failure is injected before creating the target', async () => {
    const fixture = await composeRename('rollback-after-delete')
    try {
      const registry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath: join(fixture.root, 'apply-rollback-after-delete.sqlite') })
      const receipt = await new MainProcessChangeApplyPortV2({
        projectResolver: { resolveProjectRoot: () => fixture.projectRoot },
        registry,
      }).apply({
        applyAttemptId: 'xhbaa_rollback_after_delete' as DeliveryApplyAttemptIdV1,
        approval: approvalFor(fixture.composed.changeSet),
        changeSet: fixture.composed.changeSet,
        fileContents: fixture.applyContents,
        faultInjection: { failAfterWrites: 1 },
      })

      expect(receipt).toMatchObject({ verdict: 'FAILED_ROLLED_BACK', safeCode: 'TARGET_WRITE_FAILED' })
      await expect(readFile(join(fixture.projectRoot, 'src', 'old.txt'), 'utf8')).resolves.toBe('old')
      expect(existsSync(join(fixture.projectRoot, 'src', 'new.txt'))).toBe(false)
      registry.close()
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  it('rolls back both completed effects after failure injection and replays the persisted receipt after reopen', async () => {
    const fixture = await composeRename('rollback')
    const applyAttemptId = 'xhbaa_rollback' as DeliveryApplyAttemptIdV1
    try {
      const dbPath = join(fixture.root, 'apply-rollback.sqlite')
      const registry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath })
      const port = new MainProcessChangeApplyPortV2({
        projectResolver: { resolveProjectRoot: () => fixture.projectRoot },
        registry,
      })
      const receipt = await port.apply({
        applyAttemptId,
        approval: approvalFor(fixture.composed.changeSet),
        changeSet: fixture.composed.changeSet,
        fileContents: fixture.applyContents,
        faultInjection: { failAfterWrites: 2 },
      })

      expect(receipt).toMatchObject({ verdict: 'FAILED_ROLLED_BACK', safeCode: 'TARGET_WRITE_FAILED' })
      await expect(readFile(join(fixture.projectRoot, 'src', 'old.txt'), 'utf8')).resolves.toBe('old')
      expect(existsSync(join(fixture.projectRoot, 'src', 'new.txt'))).toBe(false)
      registry.close()

      const reopened = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath })
      const inspected = await new MainProcessChangeApplyPortV2({
        projectResolver: { resolveProjectRoot: () => fixture.projectRoot },
        registry: reopened,
      }).inspect(applyAttemptId)
      expect(inspected).toEqual(receipt)
      reopened.close()
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  it('rejects cross-version inspect in both directions when V1 and V2 share the SQLite table', async () => {
    const fixture = await composeRename('cross-version')
    try {
      const registry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath: join(fixture.root, 'apply-cross-version.sqlite') })
      const common = {
        requestDigest: digest('cross-version-request'),
        projectRoot: fixture.projectRoot,
        plannedFiles: [],
        writtenRelativePaths: [],
        status: 'STARTED',
      }
      registry.put({
        ...common,
        applyAttemptId: 'xhbaa_persisted_v2' as DeliveryApplyAttemptIdV1,
        changeSet: fixture.composed.changeSet,
      } as never)
      registry.put({
        ...common,
        applyAttemptId: 'xhbaa_persisted_v1' as DeliveryApplyAttemptIdV1,
        changeSet: { ...fixture.composed.changeSet, version: 1 },
      } as never)

      const options = { projectResolver: { resolveProjectRoot: () => fixture.projectRoot }, registry }
      await expect(new MainProcessChangeApplyPortV1(options).inspect(
        'xhbaa_persisted_v2' as DeliveryApplyAttemptIdV1,
      )).rejects.toMatchObject({ reasonCode: 'APPLY_ATTEMPT_CONFLICT' })
      await expect(new MainProcessChangeApplyPortV2(options).inspect(
        'xhbaa_persisted_v1' as DeliveryApplyAttemptIdV1,
      )).rejects.toMatchObject({ reasonCode: 'APPLY_ATTEMPT_CONFLICT' })
      registry.close()
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)
})

async function composeRename(suffix = 'success') {
  const root = await mkdtemp(join(tmpdir(), `xiaogui-single-accept-${suffix}-`))
  roots.push(root)
  const projectRoot = join(root, 'project')
  await mkdir(join(projectRoot, 'src'), { recursive: true })
  await writeFile(join(projectRoot, 'src', 'old.txt'), 'old')
  git(root, ['init', projectRoot])
  git(projectRoot, ['config', 'user.email', 'xiaogui@example.test'])
  git(projectRoot, ['config', 'user.name', 'Xiaogui Test'])
  git(projectRoot, ['add', '.'])
  git(projectRoot, ['commit', '-m', 'synthetic baseline'])
  const baseRevision = git(projectRoot, ['rev-parse', 'HEAD'])
  const baselineTreeHash = git(projectRoot, ['rev-parse', 'HEAD^{tree}'])
  const target = {
    projectId: PROJECT_ID,
    baseRevision,
    baselineTreeHash,
    initialTargetFingerprint: deliveryTargetFingerprintV1({ projectId: PROJECT_ID, baseRevision, baselineTreeHash }),
  } satisfies DeliveryTargetV1
  const taskInput = renameTaskInput(baseRevision, baselineTreeHash)
  const managedRoot = join(root, 'delivery-managed')
  const integrationPort = new MainProcessDeliveryIntegrationWorktreePortV1({
    projectResolver: { resolveProjectRoot: () => projectRoot },
    managedRoot,
    target,
    batchId: `xhbd_single_${suffix}`,
  })
  const composed = await new DeliveryComposerV2({ integrationWorktree: integrationPort }).compose({
    flowId: FLOW_ID,
    deliveryBatchId: `xhbd_single_${suffix}` as never,
    selectionDraftId: `xhbsd_single_${suffix}` as never,
    deliveryChangeSetId: `xhbdcs_single_${suffix}` as never,
    taskInputs: [taskInput],
    dependencyOrder: [taskInput.changeSet.taskChangeSetId],
    selectionDigest: digest('selection'),
    target,
    qaConfigVersion: 'xiaogui.single-accept.delivery.v2',
    createdAt: CREATED_AT,
  })
  if (!composed.ok) throw new Error(`composition failed: ${composed.reasonCode}`)
  const integrationRoot = composed.privateIntegrationContext.worktreeRoot
  return {
    root,
    projectRoot,
    composed,
    target,
    integrationRoot,
    applyContents: composed.files
      .filter((file) => file.operation !== 'DELETE')
      .map((file) => ({
        relativePath: file.relativePath,
        contentArtifactId: file.contentArtifactId,
        content: Buffer.from(file.content),
        contentDigest: file.contentDigest,
      })),
    cleanup: async () => cleanupDeliveryIntegrationWorktreeRootV1(projectRoot, integrationRoot),
  }
}

function cleanSnapshotFor(target: DeliveryTargetV1) {
  return {
    read: async () => ({
      headRevision: target.baseRevision,
      treeHash: target.baselineTreeHash,
      porcelainStatus: [],
    }),
  }
}

function renameTaskInput(baseRevision: string, baselineTreeHash: string): DeliveryComposerTaskInputV2 {
  const taskChangeSetId = 'xhbcs_single_rename' as TaskChangeSetId
  const patchArtifactId = 'xhart_single_rename' as ArtifactId
  const patchFiles = [
    {
      operation: 'DELETE' as const,
      relativePath: 'src/old.txt',
      baselineDigest: digest('old'),
      contentDigest: null,
      rename: { groupId: 'rename-1', counterpartPath: 'src/new.txt', role: 'SOURCE' as const },
    },
    {
      operation: 'CREATE' as const,
      relativePath: 'src/new.txt',
      baselineDigest: null,
      contentDigest: digest('renamed'),
      contentBase64: Buffer.from('renamed').toString('base64'),
      rename: { groupId: 'rename-1', counterpartPath: 'src/old.txt', role: 'TARGET' as const },
    },
  ]
  const patchBytes = Buffer.from(JSON.stringify({ kind: 'TASK_PATCH_V2', version: 2, files: patchFiles }), 'utf8')
  const taskWithoutDigest = {
    kind: 'TASK' as const,
    taskChangeSetId,
    version: 1 as const,
    flowId: FLOW_ID,
    planRevisionId: 'xhbpr_single' as PlanRevisionId,
    taskRunId: 'xhbr_single_rename' as TaskRunId,
    attemptId: 'xhba_single_rename' as AttemptId,
    verificationAttemptId: 'xhbva_single_rename' as VerificationAttemptId,
    candidateId: 'xhcand_single_rename' as TaskChangeSetCandidateId,
    inputTreeHash: digestJson({ kind: 'GIT_TREE_INPUT_V1', gitTreeOid: baselineTreeHash }),
    resultTreeHash: digestJson({ baseRevision, files: patchFiles }),
    ancestorTaskChangeSetIds: [] as readonly TaskChangeSetId[],
    patchArtifactId,
    evidenceBundleId: 'xhbev_single_rename' as EvidenceBundleId,
    qaResultId: 'xhbqa_single_rename' as QaResultId,
    qaConfigVersion: 'xiaogui.single-accept.task.v2',
    createdAt: CREATED_AT,
  }
  const changeSet: TaskChangeSetV1 = {
    ...taskWithoutDigest,
    digest: taskChangeSetDigestV1(taskWithoutDigest),
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

function approvalFor(changeSet: DeliveryChangeSetV2) {
  return {
    deliveryChangeSetId: changeSet.deliveryChangeSetId,
    version: changeSet.version,
    digest: changeSet.digest,
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
}

function digest(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}

function digestJson(value: unknown): Sha256Digest {
  return digest(JSON.stringify(value))
}
