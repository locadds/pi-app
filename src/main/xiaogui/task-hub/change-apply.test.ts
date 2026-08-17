import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { FlowId } from '@shared/xiaogui-collaboration-hub'
import {
  deliveryChangeSetDigestV1,
  deliveryTargetFingerprintV1,
  type DeliveryApplyAttemptIdV1,
  type DeliveryChangeSetV1,
  type DeliveryFileChangeSummaryV1,
} from '@shared/xiaogui-delivery'
import type { ArtifactId, IsoDateTime, Sha256Digest, TaskChangeSetId } from '@shared/xiaogui-task-verification'

import {
  ChangeApplyErrorV1,
  InMemoryDeliveryApplyAttemptRegistryV1,
  MainProcessChangeApplyPortV1,
  SqliteDeliveryApplyAttemptRegistryV1,
  type DeliveryApplyAttemptRegistryV1,
  type DeliveryGitSnapshotReaderV1,
} from './change-apply'
import type { ProjectWorkspaceResolverV1 } from './attempt-workspace'

const roots: string[] = []
const PROJECT_ID = `xgp1_${'1'.repeat(64)}`
const HEAD = 'a'.repeat(40)
const TREE = 'b'.repeat(40)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('MainProcessChangeApplyPortV1', () => {
  it('applies approved MODIFY and CREATE files without exposing private rollback data', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'old')
    const changeSet = deliveryChangeSet([
      fileChange('MODIFY', 'a.txt', 'old', 'new'),
      fileChange('CREATE', 'b.txt', null, 'created'),
    ])
    const port = portFor(root)

    const receipt = await port.apply({
      applyAttemptId: 'xhba_1' as DeliveryApplyAttemptIdV1,
      approval: approvalFor(changeSet),
      changeSet,
      fileContents: fileContentsFor(changeSet, { 'a.txt': 'new', 'b.txt': 'created' }),
    })

    expect(receipt.verdict).toBe('SUCCEEDED')
    expect(receipt.changedRelativePaths).toEqual(['a.txt', 'b.txt'])
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('created')
    const publicReceipt = JSON.stringify(receipt)
    expect(publicReceipt).not.toContain(root)
    expect(publicReceipt).not.toContain('old')
  })

  it('rejects target baseline drift before writing user files', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'old')
    const changeSet = deliveryChangeSet([fileChange('MODIFY', 'a.txt', 'old', 'new')])
    const port = portFor(root, { headRevision: 'c'.repeat(40), treeHash: TREE, porcelainStatus: [] })

    await expect(port.apply({
      applyAttemptId: 'xhba_2' as DeliveryApplyAttemptIdV1,
      approval: approvalFor(changeSet),
      changeSet,
      fileContents: fileContentsFor(changeSet, { 'a.txt': 'new' }),
    })).rejects.toMatchObject({ reasonCode: 'TARGET_BASELINE_DRIFT' })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old')
  })

  it('rolls back all proven writes when a later write fails', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'old')
    const changeSet = deliveryChangeSet([
      fileChange('MODIFY', 'a.txt', 'old', 'new'),
      fileChange('CREATE', 'b.txt', null, 'created'),
    ])
    const port = portFor(root)

    const receipt = await port.apply({
      applyAttemptId: 'xhba_3' as DeliveryApplyAttemptIdV1,
      approval: approvalFor(changeSet),
      changeSet,
      fileContents: fileContentsFor(changeSet, { 'a.txt': 'new', 'b.txt': 'created' }),
      faultInjection: { failAfterWrites: 1 },
    })

    expect(receipt.verdict).toBe('FAILED_ROLLED_BACK')
    expect(receipt.safeCode).toBe('TARGET_WRITE_FAILED')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old')
    await expect(readFile(join(root, 'b.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('marks OUTCOME_UNKNOWN when rollback cannot be proven complete', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'old')
    const changeSet = deliveryChangeSet([fileChange('MODIFY', 'a.txt', 'old', 'new')])
    const port = portFor(root)

    const receipt = await port.apply({
      applyAttemptId: 'xhba_4' as DeliveryApplyAttemptIdV1,
      approval: approvalFor(changeSet),
      changeSet,
      fileContents: fileContentsFor(changeSet, { 'a.txt': 'new' }),
      faultInjection: { failAfterWrites: 1, corruptRollbackForRelativePath: 'a.txt' },
    })

    expect(receipt.verdict).toBe('OUTCOME_UNKNOWN')
    expect(receipt.safeCode).toBe('ROLLBACK_INCOMPLETE')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('rollback-corrupted-by-test')
  })

  it('replays and inspects the same ApplyAttempt idempotently', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'old')
    const changeSet = deliveryChangeSet([fileChange('MODIFY', 'a.txt', 'old', 'new')])
    const registry = new InMemoryDeliveryApplyAttemptRegistryV1()
    const port = portFor(root, undefined, registry)
    const input = {
      applyAttemptId: 'xhba_5' as DeliveryApplyAttemptIdV1,
      approval: approvalFor(changeSet),
      changeSet,
      fileContents: fileContentsFor(changeSet, { 'a.txt': 'new' }),
    }

    const first = await port.apply(input)
    const replay = await port.apply(input)
    const inspected = await port.inspect(input.applyAttemptId)

    expect(replay).toEqual(first)
    expect(inspected).toEqual(first)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new')
  })

  it('rejects conflicting reuse of an ApplyAttempt id', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'old')
    const firstChangeSet = deliveryChangeSet([fileChange('MODIFY', 'a.txt', 'old', 'new')])
    const secondChangeSet = deliveryChangeSet([fileChange('MODIFY', 'a.txt', 'old', 'other')], 'xhbd_2')
    const port = portFor(root)
    const applyAttemptId = 'xhba_conflict' as DeliveryApplyAttemptIdV1

    await port.apply({
      applyAttemptId,
      approval: approvalFor(firstChangeSet),
      changeSet: firstChangeSet,
      fileContents: fileContentsFor(firstChangeSet, { 'a.txt': 'new' }),
    })
    await expect(port.apply({
      applyAttemptId,
      approval: approvalFor(secondChangeSet),
      changeSet: secondChangeSet,
      fileContents: fileContentsFor(secondChangeSet, { 'a.txt': 'other' }),
    }))
      .rejects.toBeInstanceOf(ChangeApplyErrorV1)
  })

  it('persists STARTED attempts and marks restarted inspect as SUCCEEDED when desired files landed', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'new')
    const changeSet = deliveryChangeSet([fileChange('MODIFY', 'a.txt', 'old', 'new')])
    const applyAttemptId = 'xhba_restart_success' as DeliveryApplyAttemptIdV1
    const dbPath = join(root, 'apply-attempts.sqlite')
    const firstRegistry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath })
    firstRegistry.put(startedAttempt(applyAttemptId, root, changeSet, ['a.txt']))
    firstRegistry.close()

    const restartedRegistry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath })
    const receipt = await portFor(root, undefined, restartedRegistry).inspect(applyAttemptId)
    restartedRegistry.close()

    expect(receipt.verdict).toBe('SUCCEEDED')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new')
  })

  it('rolls back a restarted before/desired mixed attempt even when the written list was not flushed', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'new')
    await writeFile(join(root, 'b.txt'), 'old-b')
    const changeSet = deliveryChangeSet([
      fileChange('MODIFY', 'a.txt', 'old-a', 'new'),
      fileChange('MODIFY', 'b.txt', 'old-b', 'new-b'),
    ])
    const applyAttemptId = 'xhba_restart_mixed' as DeliveryApplyAttemptIdV1
    const dbPath = join(root, 'apply-attempts.sqlite')
    const firstRegistry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath })
    firstRegistry.put(startedAttempt(applyAttemptId, root, changeSet, []))
    firstRegistry.close()

    const restartedRegistry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath })
    const receipt = await portFor(root, undefined, restartedRegistry).inspect(applyAttemptId)
    restartedRegistry.close()

    expect(receipt.verdict).toBe('FAILED_ROLLED_BACK')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old-a')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('old-b')
  })

  it('keeps restarted inspect OUTCOME_UNKNOWN and leaves third-party content untouched', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'third-party')
    const changeSet = deliveryChangeSet([fileChange('MODIFY', 'a.txt', 'old', 'new')])
    const applyAttemptId = 'xhba_restart_unknown' as DeliveryApplyAttemptIdV1
    const dbPath = join(root, 'apply-attempts.sqlite')
    const firstRegistry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath })
    firstRegistry.put(startedAttempt(applyAttemptId, root, changeSet, ['a.txt']))
    firstRegistry.close()

    const restartedRegistry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath })
    const receipt = await portFor(root, undefined, restartedRegistry).inspect(applyAttemptId)
    restartedRegistry.close()

    expect(receipt.verdict).toBe('OUTCOME_UNKNOWN')
    expect(receipt.safeCode).toBe('ROLLBACK_INCOMPLETE')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('third-party')

    await writeFile(join(root, 'a.txt'), 'old')
    const reconciledRegistry = new SqliteDeliveryApplyAttemptRegistryV1({ dbPath })
    const reconciled = await portFor(root, undefined, reconciledRegistry).inspect(applyAttemptId)
    reconciledRegistry.close()

    expect(reconciled.verdict).toBe('FAILED_ROLLED_BACK')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old')
  })
})

function portFor(
  root: string,
  snapshot: { headRevision: string; treeHash: string; porcelainStatus: readonly string[] } = {
    headRevision: HEAD,
    treeHash: TREE,
    porcelainStatus: [],
  },
  registry: DeliveryApplyAttemptRegistryV1 = new InMemoryDeliveryApplyAttemptRegistryV1(),
) {
  const resolver: ProjectWorkspaceResolverV1 = { resolveProjectRoot: async () => root }
  const gitSnapshotReader: DeliveryGitSnapshotReaderV1 = { read: async () => snapshot }
  return new MainProcessChangeApplyPortV1({ projectResolver: resolver, gitSnapshotReader, registry })
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-apply-'))
  roots.push(root)
  await mkdir(join(root, 'nested'), { recursive: true })
  return root
}

function approvalFor(changeSet: DeliveryChangeSetV1) {
  return {
    deliveryChangeSetId: changeSet.deliveryChangeSetId,
    version: changeSet.version,
    digest: changeSet.digest,
  }
}

function deliveryChangeSet(fileChanges: readonly DeliveryFileChangeSummaryV1[], id = 'xhbd_1'): DeliveryChangeSetV1 {
  const targetSeed = {
    projectId: PROJECT_ID,
    baseRevision: HEAD,
    baselineTreeHash: TREE,
    initialTargetFingerprint: 'sha256:placeholder' as Sha256Digest,
  }
  const target = {
    ...targetSeed,
    initialTargetFingerprint: deliveryTargetFingerprintV1({
      projectId: targetSeed.projectId,
      baseRevision: targetSeed.baseRevision,
      baselineTreeHash: targetSeed.baselineTreeHash,
    }),
  }
  const withoutDigest = {
    kind: 'DELIVERY_CHANGESET' as const,
    deliveryChangeSetId: id as never,
    batchId: 'xhbb_1' as never,
    selectionDraftId: 'xhbsd_1' as never,
    version: 1 as const,
    flowId: 'xhbf_1' as FlowId,
    selectionDigest: digest('selection'),
    taskChangeSetIds: ['xhbcs_1' as TaskChangeSetId],
    taskChangeSets: [],
    dependencyOrder: ['xhbcs_1' as TaskChangeSetId],
    target,
    fileChanges,
    integrationTreeHash: digest('integration'),
    evidenceArtifactIds: [],
    qaConfigVersion: 'xiaogui.coding.delivery.v1',
    createdAt: '2026-08-17T00:00:00.000Z' as IsoDateTime,
  }
  return { ...withoutDigest, digest: deliveryChangeSetDigestV1(withoutDigest) }
}

function fileChange(
  operation: 'MODIFY' | 'CREATE',
  relativePath: string,
  before: string | null,
  after: string,
): DeliveryFileChangeSummaryV1 {
  return {
    operation,
    relativePath,
    baselineDigest: before === null ? null : digest(before),
    contentDigest: digest(after),
    contentArtifactId: `xhbart_${relativePath.replace(/[^a-z0-9]/gi, '_')}` as ArtifactId,
    sourceTaskChangeSetIds: ['xhbcs_1' as TaskChangeSetId],
  }
}

function fileContentsFor(changeSet: DeliveryChangeSetV1, contents: Record<string, string>) {
  return (changeSet.fileChanges ?? []).map((file) => ({
    relativePath: file.relativePath,
    contentArtifactId: file.contentArtifactId ?? '',
    content: Buffer.from(contents[file.relativePath] ?? '', 'utf8'),
    contentDigest: file.contentDigest,
  }))
}

function digest(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}

function startedAttempt(
  applyAttemptId: DeliveryApplyAttemptIdV1,
  root: string,
  changeSet: DeliveryChangeSetV1,
  writtenRelativePaths: readonly string[],
) {
  return {
    applyAttemptId,
    requestDigest: digest(`request:${applyAttemptId}`),
    projectRoot: root,
    changeSet,
    plannedFiles: changeSet.fileChanges.map((file) => ({
      operation: file.operation,
      relativePath: file.relativePath,
      realPath: join(root, file.relativePath),
      ...(file.operation === 'MODIFY' ? { beforeBytesBase64: beforeTextFor(file).toString('base64') } : {}),
    })),
    writtenRelativePaths,
    status: 'STARTED' as const,
  }
}

function beforeTextFor(file: DeliveryFileChangeSummaryV1): Buffer {
  const knownBefore: Record<string, string> = {
    [digest('old')]: 'old',
    [digest('old-a')]: 'old-a',
    [digest('old-b')]: 'old-b',
  }
  const value = file.baselineDigest ? knownBefore[file.baselineDigest] : undefined
  if (value === undefined) throw new Error(`missing before fixture for ${file.relativePath}`)
  return Buffer.from(value, 'utf8')
}
