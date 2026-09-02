import { execFileSync } from 'node:child_process'
import { chmod, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  AttemptCheckpointWorkspaceAdapterError,
  GitAttemptCheckpointWorkspaceAdapterV1,
  type AttemptCheckpointWorkspaceAuthorityV1,
  type AttemptCheckpointWorkspaceBindingV1,
} from './attempt-checkpoint-workspace-port'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
}, 30_000)

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function git(cwd: string, args: string[], encoding: BufferEncoding = 'utf8') {
  return execFileSync('git', args, {
    cwd,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

async function fixture() {
  const sourceRoot = await tempRoot('xiaogui-checkpoint-source-')
  const managedRoot = await tempRoot('xiaogui-checkpoint-worktrees-')
  const snapshotRoot = await tempRoot('xiaogui-checkpoint-snapshots-')
  const worktreeRoot = join(managedRoot, 'attempt-a')
  await mkdir(join(sourceRoot, 'src'), { recursive: true })
  await writeFile(join(sourceRoot, 'src', 'tracked.txt'), 'baseline\n')
  await writeFile(join(sourceRoot, 'src', 'script.sh'), '#!/bin/sh\necho baseline\n')
  git(sourceRoot, ['init'])
  git(sourceRoot, ['config', 'user.email', 'xiaogui@example.test'])
  git(sourceRoot, ['config', 'user.name', 'Xiaogui Test'])
  git(sourceRoot, ['add', '.'])
  git(sourceRoot, ['commit', '-m', 'baseline'])
  git(sourceRoot, ['worktree', 'add', '--detach', worktreeRoot, 'HEAD'])

  let binding: AttemptCheckpointWorkspaceBindingV1 = {
    attemptId: 'attempt-a',
    state: 'IDLE',
    worktreeBindingDigest: 'sha256:binding-a',
    worktreeRoot,
  }
  const authority: AttemptCheckpointWorkspaceAuthorityV1 = {
    async inspect(attemptId) {
      return attemptId === binding.attemptId ? { ...binding } : undefined
    },
  }
  let nextId = 0
  const adapter = new GitAttemptCheckpointWorkspaceAdapterV1({
    authority,
    managedRoot,
    snapshotRoot,
    idFactory: () => `snapshot-${++nextId}`,
  })
  return {
    adapter,
    sourceRoot,
    worktreeRoot,
    setBinding(next: AttemptCheckpointWorkspaceBindingV1) {
      binding = next
    },
  }
}

describe('GitAttemptCheckpointWorkspaceAdapterV1', () => {
  it('restores tracked, staged, untracked, binary, deletion, and Git mode state without touching the user project', async () => {
    const { adapter, sourceRoot, worktreeRoot } = await fixture()
    const tracked = join(worktreeRoot, 'src', 'tracked.txt')
    const script = join(worktreeRoot, 'src', 'script.sh')
    const binary = join(worktreeRoot, 'src', 'asset.bin')
    const deleted = join(worktreeRoot, 'src', 'deleted.txt')
    await writeFile(deleted, 'delete me\n')
    git(worktreeRoot, ['add', 'src/deleted.txt'])
    git(worktreeRoot, ['commit', '-m', 'add deletion fixture'])
    await writeFile(tracked, 'staged version\n')
    git(worktreeRoot, ['add', 'src/tracked.txt'])
    await writeFile(tracked, 'worktree version\n')
    await writeFile(binary, Buffer.from([0, 1, 2, 255, 0, 127]))
    await rm(deleted)
    git(worktreeRoot, ['update-index', '--chmod=+x', 'src/script.sh'])
    if (process.platform !== 'win32') await chmod(script, 0o755)

    const expectedStatus = git(worktreeRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
    const expectedIndexText = git(worktreeRoot, ['show', ':src/tracked.txt'])
    const sourceStatusBefore = git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
    const snapshot = await adapter.capture({
      attemptId: 'attempt-a',
      worktreeBindingDigest: 'sha256:binding-a',
    })

    expect(snapshot.snapshotRef).toMatch(/^xgwc_snapshot-/)
    expect(JSON.stringify(snapshot)).not.toContain(worktreeRoot)
    expect(JSON.stringify(snapshot)).not.toContain(sourceRoot)

    await writeFile(tracked, 'later mutation\n')
    git(worktreeRoot, ['add', 'src/tracked.txt'])
    await rm(binary)
    await writeFile(join(worktreeRoot, 'src', 'later.txt'), 'not in checkpoint\n')
    git(worktreeRoot, ['update-index', '--chmod=-x', 'src/script.sh'])

    const preview = await adapter.previewRestore({
      attemptId: 'attempt-a',
      worktreeBindingDigest: 'sha256:binding-a',
      snapshotRef: snapshot.snapshotRef,
      expectedDigest: snapshot.snapshotDigest,
    })
    expect(preview.changedRelativePaths).toEqual([
      'src/asset.bin',
      'src/later.txt',
      'src/script.sh',
      'src/tracked.txt',
    ])
    expect(JSON.stringify(preview)).not.toContain(worktreeRoot)
    expect(preview.changeCount).toBe(4)

    await expect(adapter.restore({
      attemptId: 'attempt-a',
      worktreeBindingDigest: 'sha256:binding-a',
      snapshotRef: snapshot.snapshotRef,
      expectedDigest: snapshot.snapshotDigest,
    })).resolves.toEqual({
      attemptId: 'attempt-a',
      worktreeBindingDigest: 'sha256:binding-a',
      restoredSnapshotDigest: snapshot.snapshotDigest,
    })

    expect(git(worktreeRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(expectedStatus)
    expect(git(worktreeRoot, ['show', ':src/tracked.txt'])).toBe(expectedIndexText)
    await expect(readFile(tracked, 'utf8')).resolves.toBe('worktree version\n')
    await expect(readFile(binary)).resolves.toEqual(Buffer.from([0, 1, 2, 255, 0, 127]))
    expect(git(worktreeRoot, ['ls-files', '--stage', 'src/script.sh'])).toMatch(/^100755 /)
    expect(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(sourceStatusBefore)
    await expect(readFile(join(sourceRoot, 'src', 'tracked.txt'), 'utf8')).resolves.toBe('baseline\n')
  }, 30_000)

  it('fails closed on busy or mismatched bindings before reading or mutating the worktree', async () => {
    const { adapter, worktreeRoot, setBinding } = await fixture()
    setBinding({
      attemptId: 'attempt-a',
      state: 'BUSY',
      worktreeBindingDigest: 'sha256:binding-a',
      worktreeRoot,
    })
    await expect(adapter.capture({
      attemptId: 'attempt-a',
      worktreeBindingDigest: 'sha256:binding-a',
    })).rejects.toMatchObject({ code: 'ATTEMPT_BUSY' } satisfies Partial<AttemptCheckpointWorkspaceAdapterError>)

    setBinding({
      attemptId: 'attempt-a',
      state: 'IDLE',
      worktreeBindingDigest: 'sha256:different-binding',
      worktreeRoot,
    })
    await expect(adapter.inspect({
      attemptId: 'attempt-a',
      worktreeBindingDigest: 'sha256:binding-a',
    })).rejects.toMatchObject({ code: 'BINDING_MISMATCH' } satisfies Partial<AttemptCheckpointWorkspaceAdapterError>)
  })

  it('rejects a hard-linked untracked file instead of checkpointing data outside the Attempt worktree', async () => {
    const { adapter, sourceRoot, worktreeRoot } = await fixture()
    const externalFile = join(sourceRoot, 'external-private.txt')
    await writeFile(externalFile, 'must remain outside the checkpoint\n')
    await link(externalFile, join(worktreeRoot, 'src', 'hardlink.txt'))

    await expect(adapter.capture({
      attemptId: 'attempt-a',
      worktreeBindingDigest: 'sha256:binding-a',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_ENTRY' } satisfies Partial<AttemptCheckpointWorkspaceAdapterError>)
    await expect(readFile(externalFile, 'utf8')).resolves.toBe('must remain outside the checkpoint\n')
  })
})
