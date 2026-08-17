import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { link, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AttemptId } from '@shared/xiaogui-collaboration-hub'
import {
  AttemptWorkspaceError,
  GitAttemptWorkspaceServiceV1,
  SqliteAttemptWorkspaceRegistryV1,
  digestBytes,
  type AttemptFileGrantV1,
  type AttemptWorkspacePrepareRequestV1,
} from './attempt-workspace'

const roots: string[] = []
const PROJECT_ID = 'xgp1_test_project'
const projectRoots = new Map<string, string>()

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
}, 30000)

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function gitRepo() {
  const root = await tempRoot('xiaogui-attempt-source-')
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

function service(dbPath: string, managedRoot = join(dbPath, '..', 'managed-worktrees')) {
  const registry = new SqliteAttemptWorkspaceRegistryV1({ dbPath })
  return {
    registry,
    workspace: new GitAttemptWorkspaceServiceV1(
      registry,
      {
        resolveProjectRoot(projectId) {
          const projectRoot = projectRoots.get(projectId)
          if (!projectRoot) throw new Error('PROJECT_NOT_REGISTERED')
          return projectRoot
        },
      },
      { managedRoot },
    ),
  }
}

function prepareRequest(input: {
  projectRoot: string
  managedRoot?: string
  grants: AttemptFileGrantV1[]
  projectId?: string
  attemptId?: AttemptId
  baseRevision?: string
  baselineTreeHash?: string
  manifestAttemptId?: AttemptId
  manifestVersion?: number
  faultInjection?: AttemptWorkspacePrepareRequestV1['faultInjection']
}): AttemptWorkspacePrepareRequestV1 {
  const attemptId = input.attemptId ?? ('xhba_attempt' as AttemptId)
  const projectId = input.projectId ?? PROJECT_ID
  projectRoots.set(projectId, input.projectRoot)
  const baseRevision = input.baseRevision ?? git(input.projectRoot, ['rev-parse', 'HEAD'])
  return {
    attemptId,
    compositionAttemptId: `xhbc_${attemptId}`,
    requestDigest: 'sha256:workspace-request',
    baselineBindingDigest: 'sha256:baseline-binding',
    compositionDigest: 'sha256:composition',
    projectId,
    baseRevision,
    baselineTreeHash: input.baselineTreeHash ?? git(input.projectRoot, ['rev-parse', `${baseRevision}^{tree}`]),
    manifest: { attemptId: input.manifestAttemptId ?? attemptId, version: input.manifestVersion ?? 1, grants: input.grants },
    ownerId: 'codex-project-lead',
    faultInjection: input.faultInjection,
  }
}

describe('GitAttemptWorkspaceServiceV1', () => {
  it('creates a detached attempt worktree from a real git repository without touching the source worktree', async () => {
    const projectRoot = await gitRepo()
    const beforeHead = git(projectRoot, ['rev-parse', 'HEAD'])
    const beforeStatus = git(projectRoot, ['status', '--porcelain'])
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const request = prepareRequest({
      projectRoot,
      managedRoot: await tempRoot('xiaogui-attempt-managed-'),
      grants: [
        { operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') },
        { operation: 'CREATE', relativePath: 'src/new-file.txt' },
      ],
    })
    expect(request).not.toHaveProperty('targetProjectRoot')
    expect(request).not.toHaveProperty('managedRoot')
    const result = await workspace.prepare(request)

    expect(result.receipt.status).toBe('PREPARED')
    expect(git(projectRoot, ['rev-parse', 'HEAD'])).toBe(beforeHead)
    expect(git(projectRoot, ['status', '--porcelain'])).toBe(beforeStatus)
    expect(existsSync(join(result.handle.rootPath, 'src', 'new-file.txt'))).toBe(true)
    expect(result.allowedRelativePaths).toEqual(['src/existing.txt', 'src/new-file.txt'])
    expect(git(result.handle.rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD')

    writeFileSync(join(result.handle.rootPath, 'src', 'existing.txt'), 'after')
    writeFileSync(join(result.handle.rootPath, 'src', 'new-file.txt'), 'created')
    await expect(workspace.auditChanges(result.handle.attemptId)).resolves.toMatchObject({
      ok: true,
      actualRelativePaths: ['src/existing.txt', 'src/new-file.txt'],
    })
    registry.close()
  })

  it('replays the same request and rejects manifest or source-worktree drift', async () => {
    const projectRoot = await gitRepo()
    const managedRoot = await tempRoot('xiaogui-attempt-managed-')
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const request = prepareRequest({
      projectRoot,
      managedRoot,
      grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
    })
    const first = await workspace.prepare(request)
    await expect(workspace.prepare(request)).resolves.toMatchObject({ handle: { rootPath: first.handle.rootPath } })
    projectRoots.set('xgp1_drift_project', projectRoot)
    await expect(workspace.prepare({ ...request, projectId: 'xgp1_drift_project' })).rejects.toMatchObject({
      reasonCode: 'MANIFEST_CONFLICT',
    })
    await expect(
      workspace.prepare({
        ...request,
        manifest: { ...request.manifest, grants: [{ operation: 'CREATE', relativePath: 'src/other.txt' }] },
      }),
    ).rejects.toMatchObject({ reasonCode: 'MANIFEST_CONFLICT' })
    registry.close()

    writeFileSync(join(projectRoot, 'src', 'dirty.txt'), 'dirty')
    const dirty = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    await expect(
      dirty.workspace.prepare(
        prepareRequest({
          projectRoot,
          managedRoot: await tempRoot('xiaogui-attempt-managed-'),
          attemptId: 'xhba_dirty' as AttemptId,
          grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'REPO_NOT_CLEAN_FOR_BASELINE' })
    dirty.registry.close()
  })

  it('rejects tree hashes as base revisions and mismatched initial manifest ownership', async () => {
    const projectRoot = await gitRepo()
    const treeHash = git(projectRoot, ['rev-parse', 'HEAD^{tree}'])
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    await expect(
      workspace.prepare(
        prepareRequest({
          projectRoot,
          managedRoot: await tempRoot('xiaogui-attempt-managed-'),
          baseRevision: treeHash,
          baselineTreeHash: treeHash,
          grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'BASE_REVISION_NOT_COMMIT' })
    await expect(
      workspace.prepare(
        prepareRequest({
          projectRoot,
          managedRoot: await tempRoot('xiaogui-attempt-managed-'),
          attemptId: 'xhba_owner' as AttemptId,
          manifestAttemptId: 'xhba_other' as AttemptId,
          grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'MANIFEST_CONFLICT' })
    await expect(
      workspace.prepare(
        prepareRequest({
          projectRoot,
          managedRoot: await tempRoot('xiaogui-attempt-managed-'),
          attemptId: 'xhba_version' as AttemptId,
          manifestVersion: 2,
          grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'MANIFEST_VERSION_CONFLICT' })
    registry.close()
  })

  it('fails closed on invalid path kinds and unapproved diff output', async () => {
    const projectRoot = await gitRepo()
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const managedRoot = await tempRoot('xiaogui-attempt-managed-')
    for (const relativePath of ['../escape.txt', '.git/config', 'C:\\outside.txt', 'src/file.txt:ads']) {
      await expect(
        workspace.prepare(
          prepareRequest({
            projectRoot,
            managedRoot: await tempRoot('xiaogui-attempt-managed-invalid-'),
            attemptId: `xhba_${relativePath.length}` as AttemptId,
            grants: [{ operation: 'CREATE', relativePath }],
          }),
        ),
      ).rejects.toBeInstanceOf(AttemptWorkspaceError)
    }

    const prepared = await workspace.prepare(
      prepareRequest({
        projectRoot,
        managedRoot,
        grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
      }),
    )
    writeFileSync(join(prepared.handle.rootPath, 'src', 'unapproved.txt'), 'no')
    await expect(workspace.auditChanges(prepared.handle.attemptId)).resolves.toMatchObject({
      ok: false,
      rejectedReasonCode: 'PATH_FORBIDDEN',
      actualRelativePaths: ['src/unapproved.txt'],
    })
    registry.close()
  }, 30000)

  it('rejects deletion and rename instead of treating them as approved MODIFY or CREATE paths', async () => {
    const deleteRoot = await gitRepo()
    const deleteService = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const deleted = await deleteService.workspace.prepare(
      prepareRequest({
        projectRoot: deleteRoot,
        managedRoot: await tempRoot('xiaogui-attempt-managed-'),
        grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
      }),
    )
    await rm(join(deleted.handle.rootPath, 'src', 'existing.txt'))
    await expect(deleteService.workspace.auditChanges(deleted.handle.attemptId)).resolves.toMatchObject({
      ok: false,
      rejectedReasonCode: 'PATH_FORBIDDEN',
      actualRelativePaths: ['src/existing.txt'],
    })
    deleteService.registry.close()

    const renameRoot = await gitRepo()
    const renameService = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const renamed = await renameService.workspace.prepare(
      prepareRequest({
        projectRoot: renameRoot,
        managedRoot: await tempRoot('xiaogui-attempt-managed-'),
        grants: [
          { operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') },
          { operation: 'CREATE', relativePath: 'src/renamed.txt' },
        ],
      }),
    )
    await rm(join(renamed.handle.rootPath, 'src', 'renamed.txt'))
    await rename(join(renamed.handle.rootPath, 'src', 'existing.txt'), join(renamed.handle.rootPath, 'src', 'renamed.txt'))
    await expect(renameService.workspace.auditChanges(renamed.handle.attemptId)).resolves.toMatchObject({
      ok: false,
      rejectedReasonCode: 'PATH_FORBIDDEN',
      actualRelativePaths: ['src/existing.txt', 'src/renamed.txt'],
    })
    renameService.registry.close()
  }, 30000)

  it('approves scoped CREATE expansion as a new manifest version and rejects DELETE expansion', async () => {
    const projectRoot = await gitRepo()
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const prepared = await workspace.prepare(
      prepareRequest({
        projectRoot,
        managedRoot: await tempRoot('xiaogui-attempt-managed-'),
        grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
      }),
    )
    writeFileSync(join(prepared.handle.rootPath, 'src', 'existing.txt'), 'already modified')
    const request = workspace.requestScopeExpansion({
      requestId: 'scope-1',
      attemptId: prepared.handle.attemptId,
      baseManifestVersion: 1,
      requestedGrants: [{ operation: 'CREATE', relativePath: 'src/extra.txt' }],
      reasonDigest: 'sha256:reason',
    })
    await expect(
      workspace.approveScopeExpansion({
        requestId: request.requestId,
        attemptId: prepared.handle.attemptId,
        baseManifestVersion: request.baseManifestVersion,
        requestDigest: request.requestDigest,
        ownerId: 'codex-project-lead',
      }),
    ).resolves.toMatchObject({
      version: 2,
      grants: expect.arrayContaining([expect.objectContaining({ operation: 'CREATE', relativePath: 'src/extra.txt' })]),
    })
    expect(readFileSync(join(prepared.handle.rootPath, 'src', 'extra.txt'), 'utf8')).toBe('')
    await expect(
      workspace.approveScopeExpansion({
        requestId: request.requestId,
        attemptId: prepared.handle.attemptId,
        baseManifestVersion: request.baseManifestVersion,
        requestDigest: request.requestDigest,
        ownerId: 'codex-project-lead',
      }),
    ).resolves.toMatchObject({ version: 2 })
    await expect(
      workspace.approveScopeExpansion({
        requestId: request.requestId,
        attemptId: 'xhba_forged',
        baseManifestVersion: request.baseManifestVersion,
        requestDigest: request.requestDigest,
        ownerId: 'codex-project-lead',
      }),
    ).rejects.toMatchObject({ reasonCode: 'MANIFEST_CONFLICT' })
    const mixed = workspace.requestScopeExpansion({
      requestId: 'scope-mixed',
      attemptId: prepared.handle.attemptId,
      baseManifestVersion: 2,
      requestedGrants: [
        { operation: 'CREATE', relativePath: 'src/should-not-exist.txt' },
        { operation: 'CREATE', relativePath: '../escape.txt' },
      ],
      reasonDigest: 'sha256:reason',
    })
    await expect(
      workspace.approveScopeExpansion({
        requestId: mixed.requestId,
        attemptId: prepared.handle.attemptId,
        baseManifestVersion: mixed.baseManifestVersion,
        requestDigest: mixed.requestDigest,
        ownerId: 'codex-project-lead',
      }),
    ).rejects.toBeInstanceOf(AttemptWorkspaceError)
    expect(existsSync(join(prepared.handle.rootPath, 'src', 'should-not-exist.txt'))).toBe(false)
    const deleteRequest = workspace.requestScopeExpansion({
      requestId: 'scope-delete',
      attemptId: prepared.handle.attemptId,
      baseManifestVersion: 2,
      requestedGrants: [{ operation: 'DELETE', relativePath: 'src/existing.txt' }],
      reasonDigest: 'sha256:reason',
    })
    await expect(
      workspace.approveScopeExpansion({
        requestId: deleteRequest.requestId,
        attemptId: prepared.handle.attemptId,
        baseManifestVersion: deleteRequest.baseManifestVersion,
        requestDigest: deleteRequest.requestDigest,
        ownerId: 'codex-project-lead',
      }),
    ).rejects.toMatchObject({
      reasonCode: 'DELETE_FORBIDDEN',
    })
    registry.close()
  })

  it('rejects hardlink scope expansion and recovers owned CREATE batches across crash points', async () => {
    const projectRoot = await gitRepo()
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const prepared = await workspace.prepare(
      prepareRequest({
        projectRoot,
        managedRoot: await tempRoot('xiaogui-attempt-managed-'),
        grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
      }),
    )
    await link(join(prepared.handle.rootPath, 'src', 'existing.txt'), join(prepared.handle.rootPath, 'src', 'hard.txt'))
    const hardlinkRequest = workspace.requestScopeExpansion({
      requestId: 'scope-hardlink',
      attemptId: prepared.handle.attemptId,
      baseManifestVersion: 1,
      requestedGrants: [{ operation: 'MODIFY', relativePath: 'src/hard.txt', baselineDigest: digestBytes('before') }],
      reasonDigest: 'sha256:reason',
    })
    await expect(
      workspace.approveScopeExpansion({
        requestId: hardlinkRequest.requestId,
        attemptId: prepared.handle.attemptId,
        baseManifestVersion: hardlinkRequest.baseManifestVersion,
        requestDigest: hardlinkRequest.requestDigest,
        ownerId: 'codex-project-lead',
      }),
    ).rejects.toMatchObject({
      reasonCode: 'TARGET_HARDLINK',
    })
    registry.close()

    const beforeCreateRoot = await gitRepo()
    const beforeCreateDb = join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite')
    const beforeCreate = service(beforeCreateDb)
    const beforeCreateRequest = prepareRequest({
      projectRoot: beforeCreateRoot,
      managedRoot: await tempRoot('xiaogui-attempt-managed-'),
      attemptId: 'xhba_before_create' as AttemptId,
      faultInjection: 'BEFORE_CREATE',
      grants: [{ operation: 'CREATE', relativePath: 'src/new.txt' }],
    })
    await expect(beforeCreate.workspace.prepare(beforeCreateRequest)).rejects.toMatchObject({ reasonCode: 'CREATE_BATCH_PENDING' })
    beforeCreate.registry.close()
    writeFileSync(join(beforeCreateRoot, 'src', 'dirty-after-lease.txt'), 'dirty')
    const beforeCreateRecovered = service(beforeCreateDb)
    const beforeCreateResult = await beforeCreateRecovered.workspace.prepare({ ...beforeCreateRequest, faultInjection: undefined })
    expect(existsSync(join(beforeCreateResult.handle.rootPath, 'src', 'new.txt'))).toBe(true)
    beforeCreateRecovered.registry.close()

    const afterCreateRoot = await gitRepo()
    const afterCreateDb = join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite')
    const afterCreate = service(afterCreateDb)
    const afterCreateRequest = prepareRequest({
      projectRoot: afterCreateRoot,
      managedRoot: await tempRoot('xiaogui-attempt-managed-'),
      attemptId: 'xhba_after_create' as AttemptId,
      faultInjection: 'AFTER_CREATE_BEFORE_MANIFEST_COMMIT',
      grants: [{ operation: 'CREATE', relativePath: 'src/new.txt' }],
    })
    await expect(afterCreate.workspace.prepare(afterCreateRequest)).rejects.toMatchObject({ reasonCode: 'CREATE_BATCH_PENDING' })
    const pendingTarget = afterCreate.registry.pendingCreateBatches()[0].targets[0].realPath
    expect(existsSync(pendingTarget)).toBe(true)
    afterCreate.registry.close()
    const afterCreateRecovered = service(afterCreateDb)
    const afterCreateResult = await afterCreateRecovered.workspace.prepare({ ...afterCreateRequest, faultInjection: undefined })
    expect(afterCreateResult).toMatchObject({ receipt: { status: 'PREPARED' }, allowedRelativePaths: ['src/new.txt'] })
    expect(existsSync(pendingTarget)).toBe(true)
    afterCreateRecovered.registry.close()

    const afterCommitRoot = await gitRepo()
    const afterCommitDb = join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite')
    const afterCommitManaged = await tempRoot('xiaogui-attempt-managed-')
    const afterCommit = service(afterCommitDb, afterCommitManaged)
    const afterCommitRequest = prepareRequest({
      projectRoot: afterCommitRoot,
      managedRoot: afterCommitManaged,
      attemptId: 'xhba_after_commit' as AttemptId,
      faultInjection: 'AFTER_MANIFEST_COMMIT',
      grants: [{ operation: 'CREATE', relativePath: 'src/new.txt' }],
    })
    await expect(afterCommit.workspace.prepare(afterCommitRequest)).rejects.toMatchObject({ reasonCode: 'CREATE_BATCH_PENDING' })
    afterCommit.registry.close()
    const replayed = service(afterCommitDb, afterCommitManaged)
    const replayedResult = await replayed.workspace.prepare({ ...afterCommitRequest, faultInjection: undefined })
    expect(replayedResult).toMatchObject({
      receipt: { status: 'PREPARED' },
      allowedRelativePaths: ['src/new.txt'],
    })
    replayed.workspace.recoverPendingCreateBatches()
    expect(existsSync(join(replayedResult.handle.rootPath, 'src', 'new.txt'))).toBe(true)
    replayed.registry.close()
  }, 30000)
})
