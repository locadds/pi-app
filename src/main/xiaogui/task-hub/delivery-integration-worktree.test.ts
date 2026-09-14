import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    const managedRoot = join(root, 'managed')
    let integrationWorktreeRoot: string | undefined
    try {
      await git(root, ['init', 'repo'])
      await writeFile(join(repo, 'a.txt'), 'old')
      await git(repo, ['add', 'a.txt'])
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
      const firstContent = Buffer.from('first result')
      const first = await port.integrate([
        {
          operation: 'MODIFY',
          relativePath: 'a.txt',
          baselineDigest: digest('old'),
          contentDigest: digest('first result'),
          contentArtifactId: 'artifact-first' as never,
          content: firstContent,
          sourceTaskChangeSetId: 'xhbcs_repeat' as never,
        },
      ])
      integrationWorktreeRoot = first.privateIntegrationContext.worktreeRoot
      await expect(readFile(join(integrationWorktreeRoot, 'a.txt'), 'utf8')).resolves.toBe('first result')

      await expect(
        port.integrate([
          {
            operation: 'MODIFY',
            relativePath: 'a.txt',
            baselineDigest: digest('old'),
            contentDigest: digest('second result'),
            contentArtifactId: 'artifact-second' as never,
            content: Buffer.from('second result'),
            sourceTaskChangeSetId: 'xhbcs_repeat' as never,
          },
        ]),
      ).rejects.toMatchObject({ reasonCode: 'DELIVERY_WORKTREE_BASELINE_DRIFT' })
      await expect(readFile(join(integrationWorktreeRoot, 'a.txt'), 'utf8')).resolves.toBe('first result')
      await expect(readFile(join(repo, 'a.txt'), 'utf8')).resolves.toBe('old')
    } finally {
      if (integrationWorktreeRoot) {
        await cleanupDeliveryIntegrationWorktreeRootV1(repo, integrationWorktreeRoot)
      }
      await rm(root, { recursive: true, force: true })
    }
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
