import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { link, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AttemptId, HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import {
  deliveryTargetFingerprintV1,
  type DeliveryTargetV1,
} from '@shared/xiaogui-delivery'
import {
  AttemptWorkspaceError,
  GitAttemptWorkspaceServiceV1,
  SqliteAttemptWorkspaceRegistryV1,
  digestBytes,
  digestJson,
  type AttemptFileGrantV1,
  type AttemptWorkspaceBaselineSourceBindingV1,
  type AttemptWorkspaceBaselineSourceResolverV1,
  type AttemptFileManifestV1,
  type AttemptWorkspacePrepareRequestV1,
  type UserApprovedFileSelectionV1,
  projectWorktreeIdentityV2,
} from './attempt-workspace'
import { attemptWorktreeAuthorizationDigestV2 } from './attempt-execution-input'
import {
  cleanupDeliveryIntegrationWorktreeRootV1,
  MainProcessDeliveryIntegrationWorktreePortV1,
} from './delivery-integration-worktree'

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

async function gitLfAutocrlfRepo() {
  const root = await gitRepo()
  const target = join(root, 'src', 'existing.txt')
  const approvedBytes = Buffer.from('before\nsecond line\n')
  writeFileSync(target, approvedBytes)
  git(root, ['add', 'src/existing.txt'])
  git(root, ['commit', '-m', 'add LF baseline fixture'])
  git(root, ['config', '--local', 'core.autocrlf', 'true'])
  // Keep the authoritative source bytes exactly LF while Git's newly-added
  // worktrees smudge text files to CRLF.
  writeFileSync(target, approvedBytes)
  return { root, target, approvedBytes }
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
}

function service(
  dbPath: string,
  managedRoot = join(dbPath, '..', 'managed-worktrees'),
  baselineSourceResolver: AttemptWorkspaceBaselineSourceResolverV1 | undefined = testBaselineSourceResolver(),
) {
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
      { managedRoot, baselineSourceResolver },
    ),
  }
}

function testBaselineSourceResolver(): AttemptWorkspaceBaselineSourceResolverV1 {
  return {
    resolve({ request, grants }) {
      const baseline = {
        baselineId: `test-baseline-${request.baseRevision}`,
        baseRevision: request.baseRevision,
        baselineTreeHash: request.baselineTreeHash,
        initialTargetFingerprint: 'test-target-fingerprint',
        baselineDigest: 'test-baseline-digest',
        baselineBindingDigest: request.baselineBindingDigest,
      }
      const source = {
        version: 1 as const,
        kind: 'PROJECT' as const,
        attemptId: String(request.attemptId),
        projectId: request.projectId,
        sessionKey: 'test-session',
        flowId: 'test-flow',
        taskRunId: 'test-task',
        source: baseline,
        task: {
          ...baseline,
          derivationDigest: 'test-derivation',
          ancestorTaskChangeSetIds: [],
        },
        grantsDigest: digestJson(grants),
      }
      return { ...source, bindingDigest: digestJson(source) }
    },
  }
}

function testSourceResolverWithFlowId(flowId: string): AttemptWorkspaceBaselineSourceResolverV1 {
  const delegate = testBaselineSourceResolver()
  return {
    resolve(input) {
      const source = delegate.resolve(input)
      if (!source) return null
      const { bindingDigest: _ignored, ...withoutDigest } = source
      const rebound = { ...withoutDigest, flowId }
      return { ...rebound, bindingDigest: digestJson(rebound) }
    },
  }
}

function removeLeaseBaselineSource(dbPath: string, attemptId: string): void {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db
      .prepare('select lease_json from attempt_workspace_leases where attempt_id = ?')
      .get(attemptId) as { lease_json: string } | undefined
    if (!row) throw new Error('missing lease')
    const lease = JSON.parse(row.lease_json) as Record<string, unknown>
    delete lease.baselineSource
    db.prepare('update attempt_workspace_leases set lease_json = ? where attempt_id = ?').run(
      JSON.stringify(lease),
      attemptId,
    )
  } finally {
    db.close()
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
  it('resolves approved MODIFY and CREATE files while deriving the MODIFY digest from the authoritative project root', async () => {
    const projectRoot = await gitRepo()
    projectRoots.set(PROJECT_ID, projectRoot)
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    try {
      await expect(
        workspace.resolveApprovedFiles(PROJECT_ID, [
          { operation: 'CREATE', relativePath: 'src/new-file.txt' },
          { operation: 'MODIFY', relativePath: 'src/existing.txt' },
        ]),
      ).resolves.toEqual([
        { operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') },
        { operation: 'CREATE', relativePath: 'src/new-file.txt' },
      ])
      expect(existsSync(join(projectRoot, 'src', 'new-file.txt'))).toBe(false)
    } finally {
      registry.close()
    }
  })

  it('fails the whole file selection on an invalid path or DELETE without materializing CREATE targets', async () => {
    const projectRoot = await gitRepo()
    projectRoots.set(PROJECT_ID, projectRoot)
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const createTarget = join(projectRoot, 'src', 'must-not-exist.txt')
    try {
      await expect(
        workspace.resolveApprovedFiles(PROJECT_ID, [
          { operation: 'CREATE', relativePath: 'src/must-not-exist.txt' },
          { operation: 'MODIFY', relativePath: '../escape.txt' },
        ]),
      ).rejects.toMatchObject({ reasonCode: 'PATH_FORBIDDEN' })
      await expect(
        workspace.resolveApprovedFiles(PROJECT_ID, [
          { operation: 'CREATE', relativePath: 'src/must-not-exist.txt' },
          { operation: 'DELETE', relativePath: 'src/existing.txt' },
        ] as unknown as readonly UserApprovedFileSelectionV1[]),
      ).rejects.toMatchObject({ reasonCode: 'DELETE_FORBIDDEN' })
      expect(existsSync(createTarget)).toBe(false)
    } finally {
      registry.close()
    }
  })

  it('rejects duplicate selections and hard-link aliases with the existing closed failure codes', async () => {
    const projectRoot = await gitRepo()
    projectRoots.set(PROJECT_ID, projectRoot)
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    try {
      await expect(
        workspace.resolveApprovedFiles(PROJECT_ID, [
          { operation: 'MODIFY', relativePath: 'src/existing.txt' },
          { operation: 'CREATE', relativePath: 'src/existing.txt' },
        ]),
      ).rejects.toMatchObject({ reasonCode: 'PATH_CONFLICT' })
      await link(join(projectRoot, 'src', 'existing.txt'), join(projectRoot, 'src', 'hardlink.txt'))
      await expect(
        workspace.resolveApprovedFiles(PROJECT_ID, [{ operation: 'MODIFY', relativePath: 'src/hardlink.txt' }]),
      ).rejects.toMatchObject({ reasonCode: 'TARGET_HARDLINK' })
    } finally {
      registry.close()
    }
  })

  it('allows only one manifest successor for a base version across SQLite connections', async () => {
    const dbPath = join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite')
    const first = new SqliteAttemptWorkspaceRegistryV1({ dbPath })
    const second = new SqliteAttemptWorkspaceRegistryV1({ dbPath })
    const initial: AttemptFileManifestV1 = {
      attemptId: 'xhba_manifest_cas',
      version: 1,
      grants: [],
      manifestDigest: 'sha256:manifest-v1',
    }
    const successorA: AttemptFileManifestV1 = {
      attemptId: initial.attemptId,
      version: 2,
      grants: [{ operation: 'CREATE', relativePath: 'src/a.txt' }],
      manifestDigest: 'sha256:manifest-v2-a',
    }
    const successorB: AttemptFileManifestV1 = {
      attemptId: initial.attemptId,
      version: 2,
      grants: [{ operation: 'CREATE', relativePath: 'src/b.txt' }],
      manifestDigest: 'sha256:manifest-v2-b',
    }
    try {
      first.commitManifestAndCreateBatch(initial)
      first.commitManifestAndCreateBatch(successorA)
      expect(() => second.commitManifestAndCreateBatch(successorB)).toThrowError(
        expect.objectContaining({ reasonCode: 'MANIFEST_VERSION_CONFLICT' }),
      )
      expect(second.getManifest(initial.attemptId)).toEqual(successorA)
    } finally {
      second.close()
      first.close()
    }
  })

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
    const capture = await workspace.captureTaskPatch(result.handle.attemptId)
    expect(capture).toMatchObject({
      inputTreeHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      patchArtifactId: expect.stringMatching(/^xhart_[0-9a-f]{32}$/),
      patchArtifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      resultTreeHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      changedFiles: [
        {
          operation: 'MODIFY',
          relativePath: 'src/existing.txt',
          baselineDigest: digestBytes('before'),
          contentDigest: digestBytes('after'),
          contentBase64: Buffer.from('after').toString('base64'),
        },
        {
          operation: 'CREATE',
          relativePath: 'src/new-file.txt',
          baselineDigest: null,
          contentDigest: digestBytes('created'),
          contentBase64: Buffer.from('created').toString('base64'),
        },
      ],
      privateVerificationContext: {
        attemptWorktreeId: result.handle.attemptWorktreeId,
        worktreeRoot: result.handle.rootPath,
        baseRevision: request.baseRevision,
        baselineGitTreeOid: request.baselineTreeHash,
        manifestDigest: result.manifest.manifestDigest,
        manifestVersion: 1,
      },
    })
    expect(capture.inputTreeHash).not.toBe(request.baselineTreeHash)
    expect(capture.inputTreeHash).toBe(
      digestJson({ kind: 'GIT_TREE_INPUT_V1', gitTreeOid: request.baselineTreeHash }),
    )
    expect(capture.resultTreeHash).toBe(
      digestJson({ kind: 'TASK_RESULT_TREE_V1', inputTreeHash: capture.inputTreeHash, files: capture.changedFiles }),
    )
    expect(JSON.parse(Buffer.from(capture.patchArtifactBytes).toString('utf8'))).toEqual({
      kind: 'TASK_PATCH_V1',
      version: 1,
      files: capture.changedFiles,
    })
    expect(capture.patchArtifactDigest).toBe(digestBytes(capture.patchArtifactBytes))
    expect(Buffer.from(capture.patchArtifactBytes).toString('utf8')).not.toContain(result.handle.rootPath)
    registry.close()
  }, 20_000)

  it('revalidates the prepared worktree and exposes only current manifest file digests to the runtime', async () => {
    const projectRoot = await gitRepo()
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const prepared = await workspace.prepare(
      prepareRequest({
        projectRoot,
        managedRoot: await tempRoot('xiaogui-attempt-managed-'),
        grants: [
          { operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') },
          { operation: 'CREATE', relativePath: 'src/new-file.txt' },
        ],
      }),
    )
    writeFileSync(join(prepared.handle.rootPath, 'src', 'existing.txt'), 'current existing')
    writeFileSync(join(prepared.handle.rootPath, 'src', 'new-file.txt'), 'current new')

    const access = await workspace.runtimeAccess(prepared.handle.attemptId)

    expect(access).toEqual({
      workspace: prepared.workspace,
      rootPath: prepared.handle.rootPath,
      allowedFiles: [
        { relativePath: 'src/existing.txt', contentDigest: digestBytes('current existing') },
        { relativePath: 'src/new-file.txt', contentDigest: digestBytes('current new') },
      ],
    })
    await expect(workspace.runtimeBinding(prepared.handle.attemptId)).resolves.toEqual(access?.workspace)
    registry.close()
  })

  it('captures binary MODIFY baselines and content as exact bytes', async () => {
    const projectRoot = await gitRepo()
    const before = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a])
    const after = Buffer.from([0xff, 0x00, 0x01, 0x80])
    writeFileSync(join(projectRoot, 'src', 'binary.dat'), before)
    git(projectRoot, ['add', 'src/binary.dat'])
    git(projectRoot, ['commit', '-m', 'add binary fixture'])
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const prepared = await workspace.prepare(
      prepareRequest({
        projectRoot,
        managedRoot: await tempRoot('xiaogui-attempt-managed-'),
        grants: [{ operation: 'MODIFY', relativePath: 'src/binary.dat', baselineDigest: digestBytes(before) }],
      }),
    )
    writeFileSync(join(prepared.handle.rootPath, 'src', 'binary.dat'), after)

    await expect(workspace.captureTaskPatch(prepared.handle.attemptId)).resolves.toMatchObject({
      changedFiles: [
        {
          operation: 'MODIFY',
          relativePath: 'src/binary.dat',
          baselineDigest: digestBytes(before),
          contentDigest: digestBytes(after),
          contentBase64: after.toString('base64'),
        },
      ],
    })
    registry.close()
  })

  it('compares MODIFY baselines using checkout-filtered bytes', async () => {
    const projectRoot = await gitRepo()
    const target = join(projectRoot, 'src', 'existing.txt')
    writeFileSync(target, 'before\nsecond line\n')
    git(projectRoot, ['add', 'src/existing.txt'])
    git(projectRoot, ['commit', '-m', 'add multiline fixture'])
    git(projectRoot, ['config', 'core.autocrlf', 'true'])
    await rm(target)
    git(projectRoot, ['checkout', '--', 'src/existing.txt'])
    const baselineBytes = readFileSync(target)
    expect(baselineBytes.includes(Buffer.from('\r\n'))).toBe(true)

    projectRoots.set(PROJECT_ID, projectRoot)
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const [grant] = await workspace.resolveApprovedFiles(PROJECT_ID, [
      { operation: 'MODIFY', relativePath: 'src/existing.txt' },
    ])
    const prepared = await workspace.prepare(
      prepareRequest({
        projectRoot,
        managedRoot: await tempRoot('xiaogui-attempt-managed-'),
        grants: [grant],
      }),
    )
    writeFileSync(join(prepared.handle.rootPath, 'src', 'existing.txt'), 'after\r\nsecond line\r\n')

    await expect(workspace.captureTaskPatch(prepared.handle.attemptId)).resolves.toMatchObject({
      changedFiles: [
        {
          operation: 'MODIFY',
          relativePath: 'src/existing.txt',
          baselineDigest: digestBytes(baselineBytes),
        },
      ],
    })
    registry.close()
  })

  it('preserves approved LF bytes through prepare, capture, and Delivery, then replays results without reseeding', async () => {
    const { root: projectRoot, target, approvedBytes } = await gitLfAutocrlfRepo()
    projectRoots.set(PROJECT_ID, projectRoot)
    const managedRoot = await tempRoot('xiaogui-attempt-managed-')
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'), managedRoot)
    let deliveryWorktreeRoot: string | undefined
    try {
      const [grant] = await workspace.resolveApprovedFiles(PROJECT_ID, [
        { operation: 'MODIFY', relativePath: 'src/existing.txt' },
      ])
      const request = prepareRequest({
        projectRoot,
        managedRoot,
        attemptId: 'xhba_lf_source' as AttemptId,
        grants: [grant],
      })
      const prepared = await workspace.prepare(request)

      expect(readFileSync(join(prepared.handle.rootPath, 'src', 'existing.txt'))).toEqual(approvedBytes)
      expect(git(prepared.handle.rootPath, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')

      const resultBytes = Buffer.from('after\nsecond line\n')
      const resultPath = join(prepared.handle.rootPath, 'src', 'existing.txt')
      writeFileSync(resultPath, resultBytes)
      const capture = await workspace.captureTaskPatch(prepared.handle.attemptId)
      expect(capture).toMatchObject({
        changedFiles: [
          {
            operation: 'MODIFY',
            relativePath: 'src/existing.txt',
            baselineDigest: digestBytes(approvedBytes),
            contentDigest: digestBytes(resultBytes),
          },
        ],
      })

      await expect(workspace.prepare(request)).resolves.toMatchObject({ handle: { rootPath: prepared.handle.rootPath } })
      expect(readFileSync(resultPath)).toEqual(resultBytes)
      expect(readFileSync(target)).toEqual(approvedBytes)

      const baseRevision = git(projectRoot, ['rev-parse', 'HEAD'])
      const baselineTreeHash = git(projectRoot, ['rev-parse', `${baseRevision}^{tree}`])
      const deliveryTarget = {
        projectId: PROJECT_ID,
        baseRevision,
        baselineTreeHash,
        initialTargetFingerprint: deliveryTargetFingerprintV1({
          projectId: PROJECT_ID,
          baseRevision,
          baselineTreeHash,
        }),
      } satisfies DeliveryTargetV1
      const delivery = new MainProcessDeliveryIntegrationWorktreePortV1({
        projectResolver: { resolveProjectRoot: () => projectRoot },
        managedRoot: await tempRoot('xiaogui-delivery-managed-'),
        target: deliveryTarget,
        batchId: 'xhbd_lf_delivery',
      })
      const integration = await delivery.integrate(
        capture.changedFiles.map((file) => ({
          operation: file.operation,
          relativePath: file.relativePath,
          baselineDigest: file.baselineDigest as never,
          contentDigest: file.contentDigest as never,
          contentArtifactId: `artifact-${file.relativePath}` as never,
          content: Buffer.from(file.contentBase64, 'base64'),
          sourceTaskChangeSetId: 'xhbcs_lf_delivery' as never,
        })),
      )
      deliveryWorktreeRoot = integration.privateIntegrationContext.worktreeRoot
      expect(readFileSync(join(deliveryWorktreeRoot, 'src', 'existing.txt'))).toEqual(resultBytes)
      expect(readFileSync(target)).toEqual(approvedBytes)
      expect(git(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    } finally {
      try {
        if (deliveryWorktreeRoot) await cleanupDeliveryIntegrationWorktreeRootV1(projectRoot, deliveryWorktreeRoot)
      } finally {
        registry.close()
      }
    }
  }, 30000)

  it('rejects authoritative source raw-byte drift during capture', async () => {
    const { root: projectRoot, target, approvedBytes } = await gitLfAutocrlfRepo()
    projectRoots.set(PROJECT_ID, projectRoot)
    const sourceHead = git(projectRoot, ['rev-parse', 'HEAD'])
    const sourceTree = git(projectRoot, ['rev-parse', 'HEAD^{tree}'])
    const sourceStatus = git(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
    const { workspace, registry } = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    try {
      const [grant] = await workspace.resolveApprovedFiles(PROJECT_ID, [
        { operation: 'MODIFY', relativePath: 'src/existing.txt' },
      ])
      const prepared = await workspace.prepare(
        prepareRequest({
          projectRoot,
          grants: [grant],
        }),
      )
      writeFileSync(join(prepared.handle.rootPath, 'src', 'existing.txt'), Buffer.from('task result\n'))

      const driftedBytes = Buffer.from('before\r\nsecond line\r\n')
      writeFileSync(target, driftedBytes)
      // Refresh only the synthetic source index. Git normalizes this CRLF
      // worktree byte sequence back to the existing LF blob; it must not
      // rewrite the authoritative file or move HEAD/tree.
      git(projectRoot, ['add', '--', 'src/existing.txt'])
      expect(git(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
      expect(readFileSync(target)).not.toEqual(approvedBytes)
      await expect(
        workspace.prepare(
          prepareRequest({
            projectRoot,
            attemptId: 'xhba_drift_prepare' as AttemptId,
            grants: [grant],
          }),
        ),
      ).rejects.toMatchObject({ reasonCode: 'TARGET_DIGEST_MISMATCH' })
      await expect(workspace.captureTaskPatch(prepared.handle.attemptId)).rejects.toMatchObject({
        reasonCode: 'TARGET_DIGEST_MISMATCH',
      })
      expect(readFileSync(target)).toEqual(driftedBytes)
      expect(git(projectRoot, ['rev-parse', 'HEAD'])).toBe(sourceHead)
      expect(git(projectRoot, ['rev-parse', 'HEAD^{tree}'])).toBe(sourceTree)
      expect(git(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(sourceStatus)
    } finally {
      registry.close()
    }
  }, 30000)

  it('fails closed on an interrupted existing worktree instead of overwriting a result', async () => {
    const { root: projectRoot } = await gitLfAutocrlfRepo()
    projectRoots.set(PROJECT_ID, projectRoot)
    const dbPath = join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite')
    const managedRoot = await tempRoot('xiaogui-attempt-managed-')
    const first = service(dbPath, managedRoot)
    const [grant] = await first.workspace.resolveApprovedFiles(PROJECT_ID, [
      { operation: 'MODIFY', relativePath: 'src/existing.txt' },
    ])
    const request = prepareRequest({
      projectRoot,
      managedRoot,
      attemptId: 'xhba_interrupted_result' as AttemptId,
      grants: [grant, { operation: 'CREATE', relativePath: 'src/new.txt' }],
      faultInjection: 'AFTER_CREATE_BEFORE_MANIFEST_COMMIT',
    })
    try {
      await expect(first.workspace.prepare(request)).rejects.toMatchObject({ reasonCode: 'CREATE_BATCH_PENDING' })
      const worktreeRoot = first.registry.getLease(request.attemptId)?.worktreeRoot
      if (!worktreeRoot) throw new Error('missing worktree lease')
      const resultBytes = Buffer.from('interrupted task result\n')
      const resultPath = join(worktreeRoot, 'src', 'existing.txt')
      writeFileSync(resultPath, resultBytes)
      first.registry.close()

      const recovered = service(dbPath, managedRoot)
      try {
        await expect(recovered.workspace.prepare({ ...request, faultInjection: undefined })).rejects.toMatchObject({
          reasonCode: 'WORKTREE_DRIFT',
        })
        expect(readFileSync(resultPath)).toEqual(resultBytes)
      } finally {
        recovered.registry.close()
      }
    } finally {
      // The normal path closes above before reopening; this guard only closes
      // the first registry if the injected failure happened before that point.
      try {
        first.registry.close()
      } catch {
        // already closed
      }
    }
  })

  it('fails closed when no trusted Main baseline source proof is available', async () => {
    const projectRoot = await gitRepo()
    const managedRoot = await tempRoot('xiaogui-attempt-managed-')
    const { workspace, registry } = service(
      join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'),
      managedRoot,
      { resolve: () => null },
    )
    try {
      await expect(
        workspace.prepare(prepareRequest({
          projectRoot,
          managedRoot,
          attemptId: 'xhba_source_missing' as AttemptId,
          grants: [{ operation: 'CREATE', relativePath: 'src/new.txt' }],
        })),
      ).rejects.toMatchObject({ reasonCode: 'BASELINE_SOURCE_MISSING' })
    } finally {
      registry.close()
    }
  })

  it('rejects a source binding for another Attempt even when its digest is internally consistent', async () => {
    const projectRoot = await gitRepo()
    const managedRoot = await tempRoot('xiaogui-attempt-managed-')
    const delegate = testBaselineSourceResolver()
    const mismatchedResolver: AttemptWorkspaceBaselineSourceResolverV1 = {
      resolve(input) {
        const source = delegate.resolve(input)
        if (!source) return null
        const { bindingDigest: _ignored, ...withoutDigest } = source
        const mismatched = { ...withoutDigest, attemptId: 'xhba_different_attempt' }
        return { ...mismatched, bindingDigest: digestJson(mismatched) }
      },
    }
    const { workspace, registry } = service(
      join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'),
      managedRoot,
      mismatchedResolver,
    )
    try {
      await expect(
        workspace.prepare(prepareRequest({
          projectRoot,
          managedRoot,
          attemptId: 'xhba_source_binding_conflict' as AttemptId,
          grants: [{ operation: 'CREATE', relativePath: 'src/new.txt' }],
        })),
      ).rejects.toMatchObject({ reasonCode: 'BASELINE_SOURCE_MISMATCH' })
    } finally {
      registry.close()
    }
  })

  it('freezes the first source proof and refuses a conflicting proof after a cold registry recovery', async () => {
    const projectRoot = await gitRepo()
    const managedRoot = await tempRoot('xiaogui-attempt-managed-')
    const dbPath = join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite')
    const request = prepareRequest({
      projectRoot,
      managedRoot,
      attemptId: 'xhba_source_frozen' as AttemptId,
      grants: [{ operation: 'CREATE', relativePath: 'src/new.txt' }],
    })
    const first = service(dbPath, managedRoot)
    let firstSource: AttemptWorkspaceBaselineSourceBindingV1 | undefined
    let firstRoot = ''
    try {
      const prepared = await first.workspace.prepare(request)
      firstRoot = prepared.handle.rootPath
      firstSource = first.registry.getLease(request.attemptId)?.baselineSource
      expect(firstSource).toBeDefined()
    } finally {
      first.registry.close()
    }
    const recovered = service(dbPath, managedRoot, testSourceResolverWithFlowId('recovered-but-different'))
    try {
      await expect(recovered.workspace.prepare(request)).rejects.toMatchObject({
        reasonCode: 'BASELINE_SOURCE_MISMATCH',
      })
      expect(recovered.registry.getLease(request.attemptId)?.baselineSource).toEqual(firstSource)
      expect(recovered.registry.getLease(request.attemptId)?.worktreeRoot).toBe(firstRoot)
    } finally {
      recovered.registry.close()
    }
  })

  it('fills only a legacy source-less lease when the exact Main proof is replayed', async () => {
    const projectRoot = await gitRepo()
    const managedRoot = await tempRoot('xiaogui-attempt-managed-')
    const dbPath = join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite')
    const request = prepareRequest({
      projectRoot,
      managedRoot,
      attemptId: 'xhba_source_legacy_exact' as AttemptId,
      grants: [{ operation: 'CREATE', relativePath: 'src/new.txt' }],
    })
    const first = service(dbPath, managedRoot)
    let expectedSource: AttemptWorkspaceBaselineSourceBindingV1 | undefined
    let expectedRoot = ''
    try {
      const prepared = await first.workspace.prepare(request)
      expectedRoot = prepared.handle.rootPath
      expectedSource = first.registry.getLease(request.attemptId)?.baselineSource
      expect(expectedSource).toBeDefined()
    } finally {
      first.registry.close()
    }
    removeLeaseBaselineSource(dbPath, String(request.attemptId))

    const recovered = service(dbPath, managedRoot)
    try {
      const replayed = await recovered.workspace.prepare(request)
      expect(replayed.handle.rootPath).toBe(expectedRoot)
      expect(recovered.registry.getLease(request.attemptId)?.baselineSource).toEqual(expectedSource)
    } finally {
      recovered.registry.close()
    }
  })

  it('does not supplement a source-less legacy lease when Main proof is missing', async () => {
    const projectRoot = await gitRepo()
    const managedRoot = await tempRoot('xiaogui-attempt-managed-')
    const dbPath = join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite')
    const request = prepareRequest({
      projectRoot,
      managedRoot,
      attemptId: 'xhba_source_legacy_missing' as AttemptId,
      grants: [{ operation: 'CREATE', relativePath: 'src/new.txt' }],
    })
    const first = service(dbPath, managedRoot)
    try {
      await first.workspace.prepare(request)
    } finally {
      first.registry.close()
    }
    removeLeaseBaselineSource(dbPath, String(request.attemptId))

    const recovered = service(dbPath, managedRoot, { resolve: () => null })
    try {
      await expect(recovered.workspace.prepare(request)).rejects.toMatchObject({
        reasonCode: 'BASELINE_SOURCE_MISSING',
      })
      expect(recovered.registry.getLease(request.attemptId)?.baselineSource).toBeUndefined()
    } finally {
      recovered.registry.close()
    }
  })

  it('keeps source proof grants bound to the initial request while approving a CREATE-only scope expansion', async () => {
    const projectRoot = await gitRepo()
    const managedRoot = await tempRoot('xiaogui-attempt-managed-')
    const initialGrant = { operation: 'CREATE' as const, relativePath: 'src/initial.txt' }
    const expansionGrant = { operation: 'CREATE' as const, relativePath: 'src/expanded.txt' }
    const observedGrants: AttemptFileGrantV1[][] = []
    const delegate = testBaselineSourceResolver()
    const resolver: AttemptWorkspaceBaselineSourceResolverV1 = {
      resolve(input) {
        observedGrants.push([...input.grants])
        return delegate.resolve(input)
      },
    }
    const { workspace, registry } = service(
      join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'),
      managedRoot,
      resolver,
    )
    const request = prepareRequest({
      projectRoot,
      managedRoot,
      attemptId: 'xhba_source_scope_expansion' as AttemptId,
      grants: [initialGrant],
    })
    try {
      await workspace.prepare(request)
      const expansion = workspace.requestScopeExpansion({
        requestId: 'xhbs_scope_expansion',
        attemptId: String(request.attemptId),
        baseManifestVersion: 1,
        requestedGrants: [expansionGrant],
        reasonDigest: 'sha256:scope-expansion-reason',
      })
      const manifest = await workspace.approveScopeExpansion({
        requestId: expansion.requestId,
        attemptId: expansion.attemptId,
        baseManifestVersion: expansion.baseManifestVersion,
        requestDigest: expansion.requestDigest,
        ownerId: request.ownerId,
      })
      expect(manifest.grants).toEqual([expansionGrant, initialGrant])
      expect(observedGrants.length).toBeGreaterThanOrEqual(2)
      expect(observedGrants.every((grants) => JSON.stringify(grants) === JSON.stringify([initialGrant]))).toBe(true)
    } finally {
      registry.close()
    }
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
    const displacedWorktree = `${first.handle.rootPath}-original`
    await rename(first.handle.rootPath, displacedWorktree)
    try {
      git(managedRoot, ['clone', '--no-local', projectRoot, first.handle.rootPath])
      await expect(workspace.runtimeBinding(first.handle.attemptId)).rejects.toMatchObject({ reasonCode: 'WORKTREE_DRIFT' })
      await expect(workspace.auditChanges(first.handle.attemptId)).rejects.toMatchObject({ reasonCode: 'WORKTREE_DRIFT' })
    } finally {
      await rm(first.handle.rootPath, { recursive: true, force: true })
      await rename(displacedWorktree, first.handle.rootPath)
    }
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
    const invalidRelativePaths = [
      '../escape.txt',
      '.git/config',
      'C:\\outside.txt',
      'src/file.txt:ads',
      'src/../redirected.txt',
      'src/./file.txt',
      'src//file.txt',
    ]
    for (const [invalidPathIndex, relativePath] of invalidRelativePaths.entries()) {
      await expect(
        workspace.prepare(
          prepareRequest({
            projectRoot,
            managedRoot: await tempRoot('xiaogui-attempt-managed-invalid-'),
            attemptId: `xhba_invalid_${invalidPathIndex}` as AttemptId,
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

  it('rejects case-insensitive Git metadata segments', async () => {
    const projectRoot = await gitRepo()
    const gitMetadata = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const prepared = await gitMetadata.workspace.prepare(
      prepareRequest({
        projectRoot,
        managedRoot: await tempRoot('xiaogui-attempt-managed-'),
        attemptId: 'xhba_git_case_alias' as AttemptId,
        grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
      }),
    )
    const request = gitMetadata.workspace.requestScopeExpansion({
      requestId: 'scope-git-case-alias',
      attemptId: prepared.handle.attemptId,
      baseManifestVersion: 1,
      requestedGrants: [
        {
          operation: 'MODIFY',
          relativePath: '.GIT',
          baselineDigest: digestBytes(readFileSync(join(prepared.handle.rootPath, '.git'))),
        },
      ],
      reasonDigest: 'sha256:git-case-alias',
    })
    await expect(
      gitMetadata.workspace.approveScopeExpansion({
        requestId: request.requestId,
        attemptId: prepared.handle.attemptId,
        baseManifestVersion: request.baseManifestVersion,
        requestDigest: request.requestDigest,
        ownerId: 'codex-project-lead',
      }),
    ).rejects.toMatchObject({ reasonCode: 'PATH_FORBIDDEN' })
    gitMetadata.registry.close()
  }, 30000)

  it.skipIf(process.platform !== 'win32')('rejects Windows case aliases across manifest versions', async () => {
    const projectRoot = await gitRepo()
    const pathAlias = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const prepared = await pathAlias.workspace.prepare(
      prepareRequest({
        projectRoot,
        managedRoot: await tempRoot('xiaogui-attempt-managed-'),
        attemptId: 'xhba_file_case_alias' as AttemptId,
        grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
      }),
    )
    const request = pathAlias.workspace.requestScopeExpansion({
      requestId: 'scope-file-case-alias',
      attemptId: prepared.handle.attemptId,
      baseManifestVersion: 1,
      requestedGrants: [{ operation: 'MODIFY', relativePath: 'src/EXISTING.txt', baselineDigest: digestBytes('before') }],
      reasonDigest: 'sha256:file-case-alias',
    })
    await expect(
      pathAlias.workspace.approveScopeExpansion({
        requestId: request.requestId,
        attemptId: prepared.handle.attemptId,
        baseManifestVersion: request.baseManifestVersion,
        requestDigest: request.requestDigest,
        ownerId: 'codex-project-lead',
      }),
    ).rejects.toMatchObject({ reasonCode: 'PATH_CONFLICT' })
    pathAlias.registry.close()
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
    await expect(deleteService.workspace.captureTaskPatch(deleted.handle.attemptId)).rejects.toMatchObject({
      reasonCode: 'PATH_FORBIDDEN',
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
    await expect(renameService.workspace.captureTaskPatch(renamed.handle.attemptId)).rejects.toMatchObject({
      reasonCode: 'PATH_FORBIDDEN',
    })
    renameService.registry.close()
  }, 30000)

  it('freezes ATTEMPT_WORKTREE V2 baseline bytes and captures real MODIFY CREATE DELETE including ignored files', async () => {
    const projectRoot = await gitRepo()
    writeFileSync(join(projectRoot, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(projectRoot, 'delete-me.txt'), 'delete me')
    git(projectRoot, ['add', '.gitignore', 'delete-me.txt'])
    git(projectRoot, ['commit', '-m', 'ignore fixture'])
    projectRoots.set(PROJECT_ID, projectRoot)
    const dbPath = join(await tempRoot('xiaogui-attempt-v2-db-'), 'workspace.sqlite')
    const baselineDigest = 'a'.repeat(64)
    const resolver: AttemptWorkspaceBaselineSourceResolverV1 = {
      resolve({ request, grants }) {
        const baseline = {
          baselineId: `baseline-${request.baseRevision}`, baseRevision: request.baseRevision,
          baselineTreeHash: request.baselineTreeHash, initialTargetFingerprint: 'target',
          baselineDigest, baselineBindingDigest: request.baselineBindingDigest,
        }
        const source = { version: 1 as const, kind: 'PROJECT' as const, attemptId: String(request.attemptId),
          projectId: request.projectId, sessionKey: 'test-session', flowId: 'flow', taskRunId: 'task',
          source: baseline, task: { ...baseline, derivationDigest: 'derivation', ancestorTaskChangeSetIds: [] },
          grantsDigest: digestJson(grants) }
        return { ...source, bindingDigest: digestJson(source) }
      },
    }
    const { workspace, registry } = service(dbPath, await tempRoot('xiaogui-attempt-v2-managed-'), resolver)
    const attemptId = 'xhba_attempt_v2' as AttemptId
    const authBase = {
      version: 2 as const, mode: 'ATTEMPT_WORKTREE' as const,
      projectId: PROJECT_ID as HubAddressV1['projectId'], sessionKey: 'test-session' as HubAddressV1['sessionKey'],
      acceptance: { requestId: 'accept-1', assignmentId: 'assignment-1', taskId: 'task-1',
        taskContentDigest: `sha256:${'b'.repeat(64)}`,
        targetProjectIdentity: projectWorktreeIdentityV2(PROJECT_ID, projectRoot),
        baselineSourceDigest: `sha256:${baselineDigest}` },
    }
    const baseRevision = git(projectRoot, ['rev-parse', 'HEAD'])
    const prepared = await workspace.prepareWorktree({
      attemptId, compositionAttemptId: 'composition-v2', requestDigest: 'request-v2',
      baselineBindingDigest: 'binding-v2', compositionDigest: 'composition-digest-v2', projectId: PROJECT_ID,
      baseRevision, baselineTreeHash: git(projectRoot, ['rev-parse', 'HEAD^{tree}']),
      authorization: { ...authBase, authorizationDigest: attemptWorktreeAuthorizationDigestV2(authBase) },
      ownerId: 'xiaogui-main-process',
    })
    writeFileSync(join(prepared.rootPath, 'src', 'existing.txt'), 'after')
    writeFileSync(join(prepared.rootPath, 'created.txt'), 'created')
    writeFileSync(join(prepared.rootPath, 'ignored.txt'), 'ignored but captured')
    await rm(join(prepared.rootPath, 'delete-me.txt'))
    const captured = await workspace.captureTaskPatchV2(attemptId)
    expect(JSON.parse(Buffer.from(captured.patchArtifactBytes).toString('utf8'))).toMatchObject({ kind: 'TASK_PATCH_V2', version: 2 })
    expect(captured.changedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'DELETE', relativePath: 'delete-me.txt', contentDigest: null }),
      expect.objectContaining({ operation: 'MODIFY', relativePath: 'src/existing.txt', contentBase64: Buffer.from('after').toString('base64') }),
      expect.objectContaining({ operation: 'CREATE', relativePath: 'created.txt' }),
      expect.objectContaining({ operation: 'CREATE', relativePath: 'ignored.txt' }),
    ]))

    await mkdir(join(prepared.rootPath, 'nested', '.git'), { recursive: true })
    await expect(workspace.captureTaskPatchV2(attemptId)).rejects.toMatchObject({ reasonCode: 'PATH_FORBIDDEN' })
    await rm(join(prepared.rootPath, 'nested'), { recursive: true })
    await link(join(prepared.rootPath, 'created.txt'), join(prepared.rootPath, 'created-link.txt'))
    await expect(workspace.captureTaskPatchV2(attemptId)).rejects.toMatchObject({ reasonCode: 'TARGET_HARDLINK' })
    await rm(join(prepared.rootPath, 'created-link.txt'))

    if (process.platform === 'win32') {
      await rename(join(prepared.rootPath, 'src', 'existing.txt'), join(prepared.rootPath, 'src', 'EXISTING.txt'))
      await expect(workspace.captureTaskPatchV2(attemptId)).rejects.toMatchObject({ reasonCode: 'PATH_CONFLICT' })
      await rename(join(prepared.rootPath, 'src', 'EXISTING.txt'), join(prepared.rootPath, 'src', 'existing.txt'))
    }
    git(prepared.rootPath, ['update-index', '--chmod=+x', 'src/existing.txt'])
    await expect(workspace.captureTaskPatchV2(attemptId)).rejects.toMatchObject({ reasonCode: 'PATH_FORBIDDEN' })
    git(prepared.rootPath, ['update-index', '--chmod=-x', 'src/existing.txt'])

    writeFileSync(join(projectRoot, 'src', 'existing.txt'), 'source drift')
    await expect(workspace.captureTaskPatchV2(attemptId)).rejects.toMatchObject({ reasonCode: 'REPO_NOT_CLEAN_FOR_BASELINE' })
    writeFileSync(join(projectRoot, 'src', 'existing.txt'), 'before')

    const db = new DatabaseSync(dbPath)
    const row = db.prepare('select lease_json from attempt_workspace_leases where attempt_id = ?').get(attemptId) as { lease_json: string }
    const damaged = JSON.parse(row.lease_json)
    damaged.worktreeAuthorization.authorizationDigest = `sha256:${'f'.repeat(64)}`
    db.prepare('update attempt_workspace_leases set lease_json = ? where attempt_id = ?').run(JSON.stringify(damaged), attemptId)
    db.close()
    await expect(workspace.captureTaskPatchV2(attemptId)).rejects.toMatchObject({ reasonCode: 'MANIFEST_CONFLICT' })
    registry.close()
  }, 30_000)

  it('seeds DERIVED V2 from immutable commit bytes and refuses capture when the registered source disappears', async () => {
    const projectRoot = await gitRepo()
    const sourceRevision = git(projectRoot, ['rev-parse', 'HEAD'])
    const sourceTree = git(projectRoot, ['rev-parse', 'HEAD^{tree}'])
    writeFileSync(join(projectRoot, 'src', 'existing.txt'), 'derived bytes')
    git(projectRoot, ['add', 'src/existing.txt'])
    git(projectRoot, ['commit', '-m', 'private derived fixture'])
    const derivedRevision = git(projectRoot, ['rev-parse', 'HEAD'])
    const derivedTree = git(projectRoot, ['rev-parse', 'HEAD^{tree}'])
    git(projectRoot, ['switch', '--detach', sourceRevision])
    projectRoots.set(PROJECT_ID, projectRoot)
    let sourceAvailable = true
    const sourceDigest = '1'.repeat(64)
    const resolver: AttemptWorkspaceBaselineSourceResolverV1 = {
      resolve({ request, grants }) {
        if (!sourceAvailable) return null
        const sourceBaseline = { baselineId: 'source-baseline', baseRevision: sourceRevision,
          baselineTreeHash: sourceTree, initialTargetFingerprint: 'target', baselineDigest: sourceDigest,
          baselineBindingDigest: 'flow-binding' }
        const taskBaseline = { baselineId: 'derived-baseline', baseRevision: derivedRevision,
          baselineTreeHash: derivedTree, initialTargetFingerprint: 'target', baselineDigest: '2'.repeat(64),
          baselineBindingDigest: request.baselineBindingDigest, derivationDigest: 'derived-input',
          ancestorTaskChangeSetIds: ['ancestor-1'] }
        const source = { version: 1 as const, kind: 'DERIVED' as const, attemptId: String(request.attemptId),
          projectId: request.projectId, sessionKey: 'test-session', flowId: 'flow', taskRunId: 'task',
          source: sourceBaseline, task: taskBaseline, grantsDigest: digestJson(grants),
          derivation: { derivationInputDigest: 'derived-input', cacheDigest: `sha256:${'3'.repeat(64)}` } }
        return { ...source, bindingDigest: digestJson(source) }
      },
    }
    const { workspace, registry } = service(join(await tempRoot('xiaogui-derived-v2-db-'), 'workspace.sqlite'),
      await tempRoot('xiaogui-derived-v2-managed-'), resolver)
    const attemptId = 'xhba_derived_v2' as AttemptId
    const authBase = { version: 2 as const, mode: 'ATTEMPT_WORKTREE' as const,
      projectId: PROJECT_ID as HubAddressV1['projectId'], sessionKey: 'test-session' as HubAddressV1['sessionKey'],
      acceptance: { requestId: 'accept-derived', assignmentId: 'assignment-derived', taskId: 'task-derived',
        taskContentDigest: `sha256:${'4'.repeat(64)}`, targetProjectIdentity: projectWorktreeIdentityV2(PROJECT_ID, projectRoot),
        baselineSourceDigest: `sha256:${sourceDigest}` } }
    const prepared = await workspace.prepareWorktree({ attemptId, compositionAttemptId: 'composition-derived',
      requestDigest: 'request-derived', baselineBindingDigest: 'task-binding', compositionDigest: 'composition-derived-digest',
      projectId: PROJECT_ID, baseRevision: derivedRevision, baselineTreeHash: derivedTree,
      authorization: { ...authBase, authorizationDigest: attemptWorktreeAuthorizationDigestV2(authBase) }, ownerId: 'main' })
    expect(readFileSync(join(prepared.rootPath, 'src', 'existing.txt'), 'utf8')).toBe('derived bytes')
    writeFileSync(join(prepared.rootPath, 'src', 'existing.txt'), 'result bytes')
    sourceAvailable = false
    await expect(workspace.captureTaskPatchV2(attemptId)).rejects.toMatchObject({ reasonCode: 'BASELINE_SOURCE_MISSING' })
    registry.close()
  }, 30_000)

  it('captures only actual approved changes and revalidates unchanged MODIFY baselines and single-link files', async () => {
    const projectRoot = await gitRepo()
    const noChanges = service(join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite'))
    const unchanged = await noChanges.workspace.prepare(
      prepareRequest({
        projectRoot,
        managedRoot: await tempRoot('xiaogui-attempt-managed-'),
        grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
      }),
    )
    await expect(noChanges.workspace.captureTaskPatch(unchanged.handle.attemptId)).rejects.toMatchObject({
      reasonCode: 'NO_APPROVED_CHANGES',
    })
    await expect(noChanges.workspace.captureTaskPatch(unchanged.handle.attemptId, {
      allowNoApprovedChanges: true,
    })).resolves.toMatchObject({
      changedFiles: [],
    })
    const secondUnchanged = await noChanges.workspace.prepare(
      prepareRequest({
        projectRoot,
        managedRoot: await tempRoot('xiaogui-attempt-managed-'),
        attemptId: 'xhba_attempt_second' as AttemptId,
        grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
      }),
    )
    const firstEmptyPatch = await noChanges.workspace.captureTaskPatch(unchanged.handle.attemptId, {
      allowNoApprovedChanges: true,
    })
    const secondEmptyPatch = await noChanges.workspace.captureTaskPatch(secondUnchanged.handle.attemptId, {
      allowNoApprovedChanges: true,
    })
    expect(secondEmptyPatch.patchArtifactDigest).toBe(firstEmptyPatch.patchArtifactDigest)
    expect(secondEmptyPatch.patchArtifactId).not.toBe(firstEmptyPatch.patchArtifactId)
    writeFileSync(join(unchanged.handle.rootPath, 'src', 'existing.txt'), 'after')
    await link(join(unchanged.handle.rootPath, 'src', 'existing.txt'), join(unchanged.handle.rootPath, 'src', 'alias.txt'))
    await expect(noChanges.workspace.captureTaskPatch(unchanged.handle.attemptId)).rejects.toMatchObject({
      reasonCode: 'PATH_FORBIDDEN',
    })
    await rm(join(unchanged.handle.rootPath, 'src', 'alias.txt'))
    await link(join(unchanged.handle.rootPath, 'src', 'existing.txt'), join(projectRoot, 'linked-approved-file.txt'))
    await expect(noChanges.workspace.captureTaskPatch(unchanged.handle.attemptId)).rejects.toMatchObject({
      reasonCode: 'TARGET_HARDLINK',
    })
    noChanges.registry.close()
  }, 30_000)

  it('approves scoped CREATE expansion as a new manifest version and rejects DELETE expansion', async () => {
    const projectRoot = await gitRepo()
    const dbPath = join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite')
    const { workspace, registry } = service(dbPath)
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
    expect(registry.getPrepared(prepared.handle.attemptId)?.result).toMatchObject({
      handle: { manifestVersion: 2 },
      allowedRelativePaths: ['src/existing.txt', 'src/extra.txt'],
    })
    await expect(workspace.auditChanges(prepared.handle.attemptId)).resolves.toMatchObject({ ok: true })
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
    expect(registry.getScopeRequest(mixed.requestId)?.state).toBe('REJECTED')
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
    expect(registry.getScopeRequest(deleteRequest.requestId)?.state).toBe('REJECTED')
    await expect(
      workspace.approveScopeExpansion({
        requestId: deleteRequest.requestId,
        attemptId: prepared.handle.attemptId,
        baseManifestVersion: deleteRequest.baseManifestVersion,
        requestDigest: deleteRequest.requestDigest,
        ownerId: 'codex-project-lead',
      }),
    ).rejects.toMatchObject({ reasonCode: 'MANIFEST_CONFLICT' })
    registry.close()

    const reopened = new SqliteAttemptWorkspaceRegistryV1({ dbPath })
    expect(reopened.getScopeRequest(mixed.requestId)?.state).toBe('REJECTED')
    expect(reopened.getScopeRequest(deleteRequest.requestId)?.state).toBe('REJECTED')
    reopened.close()
  }, 20_000)

  it('persists approved scope expansion across a registry restart without creating another manifest version', async () => {
    const projectRoot = await gitRepo()
    const dbPath = join(await tempRoot('xiaogui-attempt-db-'), 'workspace.sqlite')
    const managedRoot = await tempRoot('xiaogui-attempt-managed-')
    const first = service(dbPath, managedRoot)
    const prepared = await first.workspace.prepare(
      prepareRequest({
        projectRoot,
        managedRoot,
        attemptId: 'xhba_scope_restart' as AttemptId,
        grants: [{ operation: 'MODIFY', relativePath: 'src/existing.txt', baselineDigest: digestBytes('before') }],
      }),
    )
    const request = first.workspace.requestScopeExpansion({
      requestId: 'scope-restart',
      attemptId: prepared.handle.attemptId,
      baseManifestVersion: 1,
      requestedGrants: [{ operation: 'CREATE', relativePath: 'src/restarted.txt' }],
      reasonDigest: 'sha256:restart-reason',
    })
    await first.workspace.approveScopeExpansion({
      requestId: request.requestId,
      attemptId: prepared.handle.attemptId,
      baseManifestVersion: request.baseManifestVersion,
      requestDigest: request.requestDigest,
      ownerId: 'codex-project-lead',
    })
    first.registry.close()

    const reopened = service(dbPath, managedRoot)
    expect(reopened.registry.getScopeRequest(request.requestId)?.state).toBe('APPROVED')
    await expect(
      reopened.workspace.approveScopeExpansion({
        requestId: request.requestId,
        attemptId: prepared.handle.attemptId,
        baseManifestVersion: request.baseManifestVersion,
        requestDigest: request.requestDigest,
        ownerId: 'codex-project-lead',
      }),
    ).resolves.toMatchObject({ version: 2 })
    expect(reopened.registry.getManifest(prepared.handle.attemptId)?.version).toBe(2)
    reopened.registry.close()
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
