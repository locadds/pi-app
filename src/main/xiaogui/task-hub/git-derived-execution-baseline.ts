import { execFile } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'

import type { FlowId, HubAddressV1, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import type {
  ArtifactId,
  Sha256Digest,
  TaskChangeSetId,
  TaskChangeSetV1,
} from '@shared/xiaogui-task-verification'

import type {
  DerivedExecutionBaselineProviderV1,
  DerivedTaskExecutionBaselineV1,
  ExecutionBaselineV1,
} from './application'
import type { ProjectWorkspaceResolverV1 } from './attempt-workspace'
import {
  resolveTaskChangeSetFilesV1,
  type DeliveryComposerTaskInputV1,
} from './delivery-composer'
import {
  cleanupDeliveryIntegrationWorktreeRootV1,
  MainProcessDeliveryIntegrationWorktreePortV1,
} from './delivery-integration-worktree'
import { digestJson } from './digest'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'

const GIT_OID_PATTERN = /^[0-9a-f]{40}$/
const INTERNAL_COMMIT_DATE = '2000-01-01T00:00:00Z'

export interface VerifiedTaskChangeSetMaterialV1 {
  readonly changeSet: TaskChangeSetV1
  readonly patchArtifact: {
    readonly artifactId: ArtifactId
    readonly digest: Sha256Digest
    readonly bytes: Uint8Array
  }
}

export interface VerifiedTaskChangeSetReaderV1 {
  read(taskChangeSetId: TaskChangeSetId): VerifiedTaskChangeSetMaterialV1 | null | Promise<VerifiedTaskChangeSetMaterialV1 | null>
}

export interface GitDerivedExecutionBaselineProviderOptionsV1 {
  readonly storeFactory: () => CollaborationHubSqliteStoreV1
  readonly projectResolver: ProjectWorkspaceResolverV1
  readonly managedRoot: string
  readonly taskChangeSetReader?: VerifiedTaskChangeSetReaderV1
  readonly now?: () => string
}

export type GitDerivedExecutionBaselineSafeCodeV1 =
  | 'DERIVED_BASELINE_BASE_INVALID'
  | 'DERIVED_BASELINE_CHANGESET_MISSING'
  | 'DERIVED_BASELINE_CHANGESET_INVALID'
  | 'DERIVED_BASELINE_CACHE_INVALID'
  | 'DERIVED_BASELINE_GIT_FAILED'

export class GitDerivedExecutionBaselineErrorV1 extends Error {
  constructor(readonly reasonCode: GitDerivedExecutionBaselineSafeCodeV1) {
    super(reasonCode)
    this.name = 'GitDerivedExecutionBaselineErrorV1'
  }
}

/**
 * Main-process deep Module that squashes the verified dependency closure into
 * an unreferenced deterministic Git commit. It never changes the source
 * worktree or a user-visible ref, and removes the private integration worktree
 * before returning the path-free baseline.
 */
export class GitDerivedExecutionBaselineProviderV1 implements DerivedExecutionBaselineProviderV1 {
  constructor(private readonly options: GitDerivedExecutionBaselineProviderOptionsV1) {
    if (!isAbsolute(options.managedRoot)) throw new GitDerivedExecutionBaselineErrorV1('DERIVED_BASELINE_BASE_INVALID')
  }

  async derive(input: Parameters<DerivedExecutionBaselineProviderV1['derive']>[0]): Promise<DerivedTaskExecutionBaselineV1> {
    if (!input.flowBaseline.baseRevision || !GIT_OID_PATTERN.test(input.flowBaseline.baseRevision) ||
      !GIT_OID_PATTERN.test(input.flowBaseline.baselineTreeHash) || input.ancestorTaskChangeSetIds.length === 0) {
      throw new GitDerivedExecutionBaselineErrorV1('DERIVED_BASELINE_BASE_INVALID')
    }
    const taskInputs = await this.readTaskInputs(input.ancestorTaskChangeSetIds)
    const dependencyOrder = input.ancestorTaskChangeSetIds as readonly TaskChangeSetId[]
    const resolved = resolveTaskChangeSetFilesV1({
      flowId: input.flowId,
      taskInputs,
      dependencyOrder,
      allowOrderedSameFileChanges: true,
    })
    if (!resolved.ok) throw new GitDerivedExecutionBaselineErrorV1('DERIVED_BASELINE_CHANGESET_INVALID')

    const derivationInputDigest = digestJson({
      version: 1,
      address: input.address,
      flowId: input.flowId,
      taskRunId: input.taskRunId,
      flowBaseline: input.flowBaseline,
      dependencyOrder,
      taskChangeSets: taskInputs.map(({ changeSet, patchArtifact }) => ({
        taskChangeSetId: changeSet.taskChangeSetId,
        digest: changeSet.digest,
        patchArtifactId: patchArtifact.artifactId,
        patchArtifactDigest: patchArtifact.digest,
      })),
    })
    const repositoryRoot = resolve(await this.options.projectResolver.resolveProjectRoot(input.address.projectId))
    const cached = this.readCached(derivationInputDigest)
    if (cached) {
      const baseline = parseCachedBaseline(cached.baseline_json, input)
      await assertCommitTree(repositoryRoot, baseline.baseRevision!, baseline.baselineTreeHash)
      return baseline
    }

    const target = {
      projectId: input.address.projectId,
      baseRevision: input.flowBaseline.baseRevision,
      baselineTreeHash: input.flowBaseline.baselineTreeHash,
      initialTargetFingerprint: input.flowBaseline.initialTargetFingerprint as Sha256Digest,
    }
    const integration = await new MainProcessDeliveryIntegrationWorktreePortV1({
      projectResolver: this.options.projectResolver,
      managedRoot: this.options.managedRoot,
      target,
      batchId: `derived-${derivationInputDigest}`,
    }).integrate(resolved.files)

    let derivedCommit: string
    let derivedTree: string
    try {
      derivedTree = exactGitOid(await git(integration.privateIntegrationContext.worktreeRoot, ['write-tree']))
      derivedCommit = exactGitOid(await git(
        integration.privateIntegrationContext.worktreeRoot,
        [
          '-c', 'user.name=Xiaogui Internal',
          '-c', 'user.email=xiaogui@internal.invalid',
          'commit-tree', derivedTree,
          '-p', input.flowBaseline.baseRevision,
          '-m', `xiaogui-derived-baseline-v1 ${derivationInputDigest}`,
        ],
        {
          GIT_AUTHOR_DATE: INTERNAL_COMMIT_DATE,
          GIT_COMMITTER_DATE: INTERNAL_COMMIT_DATE,
        },
      ))
      await assertCommitTree(repositoryRoot, derivedCommit, derivedTree)
    } finally {
      await cleanupDeliveryIntegrationWorktreeRootV1(
        integration.privateIntegrationContext.trustedToolchainRoot,
        integration.privateIntegrationContext.worktreeRoot,
      )
    }

    const baselineWithoutDerivation = {
      version: 1 as const,
      taskRunId: input.taskRunId,
      ancestorTaskChangeSetIds: [...input.ancestorTaskChangeSetIds],
      baselineId: `git-derived-baseline-v1-${derivationInputDigest}`,
      baseRevision: derivedCommit,
      baselineTreeHash: derivedTree,
      initialTargetFingerprint: input.flowBaseline.initialTargetFingerprint,
    }
    const withBaselineDigest = {
      ...baselineWithoutDerivation,
      baselineDigest: executionBaselineDigest(baselineWithoutDerivation),
    }
    const baseline: DerivedTaskExecutionBaselineV1 = {
      ...withBaselineDigest,
      derivationDigest: digestJson(withBaselineDigest),
    }
    this.writeCached(derivationInputDigest, input, baseline)
    return baseline
  }

  private async readTaskInputs(ids: readonly string[]): Promise<DeliveryComposerTaskInputV1[]> {
    if (this.options.taskChangeSetReader) {
      return Promise.all(ids.map(async (id) => {
        const material = await this.options.taskChangeSetReader!.read(id as TaskChangeSetId)
        if (!material) throw new GitDerivedExecutionBaselineErrorV1('DERIVED_BASELINE_CHANGESET_MISSING')
        return material
      }))
    }
    const store = this.options.storeFactory()
    try {
      return ids.map((id) => {
        const changeSet = store.readTaskChangeSet(id as TaskChangeSetId)
        if (!changeSet) throw new GitDerivedExecutionBaselineErrorV1('DERIVED_BASELINE_CHANGESET_MISSING')
        const artifact = store.readArtifact(changeSet.patchArtifactId)
        if (!artifact || artifact.kind !== 'PATCH') {
          throw new GitDerivedExecutionBaselineErrorV1('DERIVED_BASELINE_CHANGESET_MISSING')
        }
        return {
          changeSet,
          patchArtifact: {
            artifactId: artifact.artifactId,
            digest: artifact.contentDigest,
            bytes: artifact.content,
          },
        }
      })
    } finally {
      store.close()
    }
  }

  private readCached(derivationInputDigest: string) {
    const store = this.options.storeFactory()
    try {
      return store.derivedExecutionBaseline(derivationInputDigest)
    } finally {
      store.close()
    }
  }

  private writeCached(
    derivationInputDigest: string,
    input: {
      address: HubAddressV1
      flowId: FlowId
      taskRunId: TaskRunId
    },
    baseline: DerivedTaskExecutionBaselineV1,
  ): void {
    const store = this.options.storeFactory()
    try {
      store.writeDerivedExecutionBaseline({
        derivation_input_digest: derivationInputDigest,
        project_id: input.address.projectId,
        flow_id: input.flowId,
        task_run_id: input.taskRunId,
        baseline_json: JSON.stringify(baseline),
        created_at: this.options.now?.() ?? new Date().toISOString(),
      })
    } finally {
      store.close()
    }
  }
}

function parseCachedBaseline(
  value: string,
  input: {
    taskRunId: TaskRunId
    ancestorTaskChangeSetIds: readonly string[]
  },
): DerivedTaskExecutionBaselineV1 {
  try {
    const baseline = JSON.parse(value) as DerivedTaskExecutionBaselineV1
    const expectedBaselineDigest = executionBaselineDigest(baseline)
    const { derivationDigest: _ignored, ...withoutDerivation } = baseline
    const valid = baseline.version === 1 &&
      baseline.taskRunId === input.taskRunId &&
      sameStrings(baseline.ancestorTaskChangeSetIds, input.ancestorTaskChangeSetIds) &&
      baseline.baselineDigest === expectedBaselineDigest &&
      baseline.derivationDigest === digestJson(withoutDerivation) &&
      typeof baseline.baseRevision === 'string' && GIT_OID_PATTERN.test(baseline.baseRevision) &&
      GIT_OID_PATTERN.test(baseline.baselineTreeHash)
    if (valid) return baseline
  } catch {
    // Closed cache failure below.
  }
  throw new GitDerivedExecutionBaselineErrorV1('DERIVED_BASELINE_CACHE_INVALID')
}

function executionBaselineDigest(value: Pick<
  ExecutionBaselineV1,
  'baselineId' | 'baseRevision' | 'baselineTreeHash' | 'initialTargetFingerprint'
>): string {
  return digestJson({
    baselineId: value.baselineId,
    ...(value.baseRevision ? { baseRevision: value.baseRevision } : {}),
    baselineTreeHash: value.baselineTreeHash,
    initialTargetFingerprint: value.initialTargetFingerprint,
  })
}

async function assertCommitTree(repositoryRoot: string, commit: string, expectedTree: string): Promise<void> {
  const actualTree = exactGitOid(await git(repositoryRoot, ['rev-parse', '--verify', `${commit}^{tree}`]))
  if (actualTree !== expectedTree) throw new GitDerivedExecutionBaselineErrorV1('DERIVED_BASELINE_CACHE_INVALID')
}

function exactGitOid(value: string): string {
  const oid = value.trim()
  if (!GIT_OID_PATTERN.test(oid)) throw new GitDerivedExecutionBaselineErrorV1('DERIVED_BASELINE_GIT_FAILED')
  return oid
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function git(cwd: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...env },
    }, (error, stdout) => {
      if (error) {
        reject(new GitDerivedExecutionBaselineErrorV1('DERIVED_BASELINE_GIT_FAILED'))
        return
      }
      resolvePromise(stdout ?? '')
    })
  })
}
