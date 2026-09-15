import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  deliveryTargetFingerprintV1,
  type DeliveryTargetV1,
} from '@shared/xiaogui-delivery'
import type { Sha256Digest } from '@shared/xiaogui-task-verification'

import {
  cleanupDeliveryIntegrationWorktreeRootV1,
  MainProcessDeliveryIntegrationWorktreePortV1,
} from './delivery-integration-worktree'

describe('MainProcessDeliveryIntegrationWorktreePortV1', () => {
  it('rejects duplicate V2 net effects for the same normalized path', async () => {
    const projectId = `xgp1_${'4'.repeat(64)}`
    const target = {
      projectId,
      baseRevision: 'a'.repeat(40),
      baselineTreeHash: 'b'.repeat(40),
      initialTargetFingerprint: deliveryTargetFingerprintV1({
        projectId,
        baseRevision: 'a'.repeat(40),
        baselineTreeHash: 'b'.repeat(40),
      }),
    } satisfies DeliveryTargetV1
    const port = new MainProcessDeliveryIntegrationWorktreePortV1({
      projectResolver: { resolveProjectRoot: () => 'unused' },
      managedRoot: 'unused',
      target,
      batchId: 'xhbd_duplicate_v2',
    })
    const duplicateEffect = {
      operation: 'CREATE' as const,
      relativePath: 'nested/result.txt',
      baselineDigest: null,
      contentDigest: digest('created'),
      contentArtifactId: 'artifact-duplicate' as never,
      content: Buffer.from('created'),
      sourceTaskChangeSetId: 'xhbcs_duplicate' as never,
    }

    await expect(port.integrateV2([duplicateEffect, duplicateEffect])).rejects.toMatchObject({
      reasonCode: 'DELIVERY_WORKTREE_FILE_INVALID',
    })
  })

  it('creates a managed integration worktree and writes only approved files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaogui-delivery-integration-'))
    const repo = join(root, 'repo')
    const managedRoot = join(root, 'managed')
    await git(root, ['init', 'repo'])
    await writeFile(join(repo, 'a.txt'), 'old')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'])
    const baseRevision = (await git(repo, ['rev-parse', '--verify', 'HEAD'])).trim()
    const baselineTreeHash = (await git(repo, ['rev-parse', '--verify', 'HEAD^{tree}'])).trim()
    const target = {
      projectId: `xgp1_${'1'.repeat(64)}`,
      baseRevision,
      baselineTreeHash,
      initialTargetFingerprint: deliveryTargetFingerprintV1({
        projectId: `xgp1_${'1'.repeat(64)}`,
        baseRevision,
        baselineTreeHash,
      }),
    } satisfies DeliveryTargetV1
    const port = new MainProcessDeliveryIntegrationWorktreePortV1({
      projectResolver: { resolveProjectRoot: () => repo },
      managedRoot,
      target,
      batchId: 'xhbd_batch_1',
    })

    const result = await port.integrate([
      {
        operation: 'MODIFY',
        relativePath: 'a.txt',
        baselineDigest: digest('old'),
        contentDigest: digest('new'),
        contentArtifactId: 'artifact-a' as never,
        content: Buffer.from('new'),
        sourceTaskChangeSetId: 'xhbcs_1' as never,
      },
      {
        operation: 'CREATE',
        relativePath: 'nested/b.txt',
        baselineDigest: null,
        contentDigest: digest('created'),
        contentArtifactId: 'artifact-b' as never,
        content: Buffer.from('created'),
        sourceTaskChangeSetId: 'xhbcs_2' as never,
      },
    ])

    expect(result.integrationTreeHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.privateIntegrationContext.worktreeRoot.startsWith(managedRoot)).toBe(true)
    await expect(readFile(join(repo, 'a.txt'), 'utf8')).resolves.toBe('old')
    await expect(readFile(join(result.privateIntegrationContext.worktreeRoot, 'a.txt'), 'utf8')).resolves.toBe('new')
    await expect(readFile(join(result.privateIntegrationContext.worktreeRoot, 'nested', 'b.txt'), 'utf8')).resolves.toBe('created')
    await cleanupDeliveryIntegrationWorktreeRootV1(repo, result.privateIntegrationContext.worktreeRoot)
    await expect(git(repo, ['worktree', 'list'])).resolves.not.toContain(result.privateIntegrationContext.worktreeRoot)

    await rm(root, { recursive: true, force: true })
  })

  it('rejects a repeat integration without overwriting an existing result root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaogui-delivery-integration-repeat-'))
    const repo = join(root, 'repo')
    const managedRoot = join(root, '交付 工作树')
    let integrationWorktreeRoot: string | undefined
    try {
      await git(root, ['init', 'repo'])
      const relativePath = '报告 空间.txt'
      await writeFile(join(repo, '.gitattributes'), '*.txt text eol=lf\n')
      await writeFile(join(repo, relativePath), 'old\r\n')
      await git(repo, ['add', '.gitattributes', relativePath])
      await git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'])
      const baseRevision = (await git(repo, ['rev-parse', '--verify', 'HEAD'])).trim()
      const baselineTreeHash = (await git(repo, ['rev-parse', '--verify', 'HEAD^{tree}'])).trim()
      const projectId = `xgp1_${'3'.repeat(64)}`
      const target = {
        projectId,
        baseRevision,
        baselineTreeHash,
        initialTargetFingerprint: deliveryTargetFingerprintV1({ projectId, baseRevision, baselineTreeHash }),
      } satisfies DeliveryTargetV1
      const port = new MainProcessDeliveryIntegrationWorktreePortV1({
        projectResolver: { resolveProjectRoot: () => repo },
        managedRoot,
        target,
        batchId: 'xhbd_repeat_result',
      })
      const firstContent = Buffer.from('first result\r\n')
      const first = await port.integrate([
        {
          operation: 'MODIFY',
          relativePath,
          baselineDigest: digest('old\r\n'),
          contentDigest: digest('first result\r\n'),
          contentArtifactId: 'artifact-first' as never,
          content: firstContent,
          sourceTaskChangeSetId: 'xhbcs_repeat' as never,
        },
      ])
      integrationWorktreeRoot = first.privateIntegrationContext.worktreeRoot
      await expect(readFile(join(integrationWorktreeRoot, relativePath), 'utf8')).resolves.toBe('first result\r\n')

      await expect(port.integrate([{
        operation: 'MODIFY', relativePath, baselineDigest: digest('old\r\n'), contentDigest: digest('first result\r\n'),
        contentArtifactId: 'artifact-first' as never, content: firstContent, sourceTaskChangeSetId: 'xhbcs_repeat' as never,
      }])).resolves.toEqual(first)

      await expect(
        port.integrate([
          {
            operation: 'MODIFY',
            relativePath,
            baselineDigest: digest('old\r\n'),
            contentDigest: digest('second result\r\n'),
            contentArtifactId: 'artifact-second' as never,
            content: Buffer.from('second result\r\n'),
            sourceTaskChangeSetId: 'xhbcs_repeat' as never,
          },
        ]),
      ).rejects.toMatchObject({ reasonCode: 'DELIVERY_WORKTREE_BASELINE_DRIFT' })
      await expect(readFile(join(integrationWorktreeRoot, relativePath), 'utf8')).resolves.toBe('first result\r\n')
      await expect(readFile(join(repo, relativePath), 'utf8')).resolves.toBe('old\r\n')
    } finally {
      if (integrationWorktreeRoot) {
        await cleanupDeliveryIntegrationWorktreeRootV1(repo, integrationWorktreeRoot)
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves an unknown colliding delivery directory untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaogui-delivery-integration-unknown-'))
    const repo = join(root, 'repo')
    const managedRoot = join(root, 'managed')
    const batchId = 'xhbd_unknown_collision'
    const unknownRoot = join(managedRoot, `delivery-${createHash('sha256').update(batchId).digest('hex').slice(0, 32)}`)
    try {
      await git(root, ['init', 'repo'])
      await writeFile(join(repo, 'a.txt'), 'old')
      await git(repo, ['add', 'a.txt'])
      await git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'])
      await mkdir(unknownRoot, { recursive: true })
      await writeFile(join(unknownRoot, 'owner.txt'), 'not a delivery worktree')
      const baseRevision = (await git(repo, ['rev-parse', '--verify', 'HEAD'])).trim()
      const baselineTreeHash = (await git(repo, ['rev-parse', '--verify', 'HEAD^{tree}'])).trim()
      const projectId = `xgp1_${'8'.repeat(64)}`
      const port = new MainProcessDeliveryIntegrationWorktreePortV1({ projectResolver: { resolveProjectRoot: () => repo },
        managedRoot, batchId, target: { projectId, baseRevision, baselineTreeHash,
          initialTargetFingerprint: deliveryTargetFingerprintV1({ projectId, baseRevision, baselineTreeHash }) } })
      await expect(port.integrate([{ operation: 'MODIFY', relativePath: 'a.txt', baselineDigest: digest('old'),
        contentDigest: digest('new'), contentArtifactId: 'artifact-unknown' as never, content: Buffer.from('new'),
        sourceTaskChangeSetId: 'xhbcs_unknown' as never }])).rejects.toMatchObject({ reasonCode: 'DELIVERY_WORKTREE_BASELINE_DRIFT' })
      await expect(readFile(join(unknownRoot, 'owner.txt'), 'utf8')).resolves.toBe('not a delivery worktree')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

function digest(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message))
        return
      }
      resolve(stdout)
    })
  })
}
