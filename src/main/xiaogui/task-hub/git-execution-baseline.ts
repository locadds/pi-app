import { execFile } from 'node:child_process'

import type { ExecutionBaselineProviderV1, ExecutionBaselineV1 } from './application'
import type { ProjectWorkspaceResolverV1 } from './attempt-workspace'
import { digestJson } from './digest'

// The current Attempt workspace contract is SHA-1 Git only. Keep the
// provider aligned so an unsupported object format fails before scheduling.
const GIT_OID_PATTERN = /^[0-9a-f]{40}$/

export type GitExecutionBaselineRevisionV1 = 'HEAD' | 'HEAD^{tree}'

export interface GitExecutionBaselineReaderV1 {
  read(repositoryRoot: string, revision: GitExecutionBaselineRevisionV1): Promise<string>
}

export type GitExecutionBaselineFailureReasonV1 =
  | 'GIT_BASELINE_READ_FAILED'
  | 'GIT_BASELINE_INVALID_OID'

export class GitExecutionBaselineErrorV1 extends Error {
  constructor(readonly reasonCode: GitExecutionBaselineFailureReasonV1) {
    super(reasonCode)
    this.name = 'GitExecutionBaselineErrorV1'
  }
}

const nodeGitExecutionBaselineReaderV1: GitExecutionBaselineReaderV1 = {
  read(repositoryRoot, revision) {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['rev-parse', '--verify', revision],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 64 * 1024,
        },
        (error, stdout) => {
          if (error) {
            reject(new GitExecutionBaselineErrorV1('GIT_BASELINE_READ_FAILED'))
            return
          }
          resolve(stdout)
        },
      )
    })
  },
}

function exactGitOid(output: string): string {
  const oid = typeof output === 'string' ? output.trim() : ''
  if (!GIT_OID_PATTERN.test(oid)) {
    throw new GitExecutionBaselineErrorV1('GIT_BASELINE_INVALID_OID')
  }
  return oid
}

/**
 * Main-process adapter that captures an immutable, path-free Git baseline.
 * Project paths remain private to the resolver and Git reader seam.
 */
export class GitExecutionBaselineProviderV1 implements ExecutionBaselineProviderV1 {
  constructor(
    private readonly projectWorkspaceResolver: ProjectWorkspaceResolverV1,
    private readonly gitReader: GitExecutionBaselineReaderV1 = nodeGitExecutionBaselineReaderV1,
  ) {}

  async capture(input: Parameters<ExecutionBaselineProviderV1['capture']>[0]): Promise<ExecutionBaselineV1> {
    const repositoryRoot = await this.projectWorkspaceResolver.resolveProjectRoot(input.address.projectId)

    let baseRevision: string
    let baselineTreeHash: string
    try {
      baseRevision = exactGitOid(await this.gitReader.read(repositoryRoot, 'HEAD'))
      baselineTreeHash = exactGitOid(await this.gitReader.read(repositoryRoot, 'HEAD^{tree}'))
    } catch (error) {
      if (error instanceof GitExecutionBaselineErrorV1) throw error
      throw new GitExecutionBaselineErrorV1('GIT_BASELINE_READ_FAILED')
    }

    const baselineId = `git-baseline-v1-${digestJson({
      projectId: input.address.projectId,
      baseRevision,
      baselineTreeHash,
    })}`
    const initialTargetFingerprint = digestJson({
      kind: 'xiaogui-git-project-v1',
      projectId: input.address.projectId,
    })
    const baseline = {
      baselineId,
      baseRevision,
      baselineTreeHash,
      initialTargetFingerprint,
    }
    return { ...baseline, baselineDigest: digestJson(baseline) }
  }
}
