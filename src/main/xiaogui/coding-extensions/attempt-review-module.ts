import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { CodingReviewBundleV1 } from '@shared/xiaogui-coding-extension-pack'
import type {
  AttemptId,
  AttemptProjectionM2BV1,
  HubAddressV1,
} from '@shared/xiaogui-collaboration-hub'
import type {
  Sha256Digest,
  TaskVerificationSummaryV1,
} from '@shared/xiaogui-task-verification'

import type { CollaborationHubApplicationV1 } from '../task-hub/application'
import type {
  AttemptTaskPatchCaptureV1,
  AttemptWorkspacePortV1,
  TaskPatchFileSnapshotV1,
} from '../task-hub/attempt-workspace'
import type { CollaborationHubSqliteStoreV1 } from '../task-hub/sqlite-store'

const PATCH_MEDIA_TYPE = 'application/vnd.xiaogui.task-patch-v1+json'
const DIAGNOSTIC_MEDIA_TYPE = 'application/vnd.xiaogui.qa-diagnostic+json'
const execFileAsync = promisify(execFile)
const MAX_DIFF_BYTES = 4 * 1024 * 1024

const VERIFICATION_COMMANDS = {
  'typescript.web': {
    label: '界面 TypeScript 检查',
    configPath: 'tsconfig.web.json',
  },
  'typescript.node': {
    label: '主进程 TypeScript 检查',
    configPath: 'tsconfig.node.json',
  },
} as const

type KnownVerificationCheckIdV1 = keyof typeof VERIFICATION_COMMANDS

type AttemptReviewApplicationPortV1 = Pick<CollaborationHubApplicationV1, 'observeM2B'>
type AttemptReviewStorePortV1 = Pick<CollaborationHubSqliteStoreV1, 'readArtifact' | 'readTaskChangeSet'>
type AttemptReviewWorkspacePortV1 = Pick<AttemptWorkspacePortV1, 'captureTaskPatch'>

export interface AttemptReviewDiffInputV1 {
  readonly attemptId: AttemptId
  readonly baseRevision: string
  readonly worktreeRoot: string
  readonly changedFiles: readonly TaskPatchFileSnapshotV1[]
}

export interface AttemptReviewDiffPortV1 {
  createUnifiedDiff(input: AttemptReviewDiffInputV1): Promise<string>
}

export interface CodingAttemptReviewProjectionV1 {
  readonly bundle: CodingReviewBundleV1
  readonly unifiedDiff: string
  readonly unifiedDiffDigest: Sha256Digest
}

export type CodingAttemptReviewReasonCodeV1 =
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_SCOPE_UNAVAILABLE'
  | 'DIFF_GENERATION_FAILED'
  | 'PATCH_ARTIFACT_MISMATCH'
  | 'PRIVATE_PATH_DISCLOSURE'
  | 'UNSAFE_RELATIVE_PATH'

export class CodingAttemptReviewErrorV1 extends Error {
  constructor(readonly reasonCode: CodingAttemptReviewReasonCodeV1) {
    super(reasonCode)
    this.name = 'CodingAttemptReviewErrorV1'
  }
}

export class CodingAttemptReviewModuleV1 {
  private readonly diffPort: AttemptReviewDiffPortV1

  constructor(private readonly options: {
    readonly app: AttemptReviewApplicationPortV1
    readonly store: AttemptReviewStorePortV1
    readonly workspace: AttemptReviewWorkspacePortV1
    readonly diffPort?: AttemptReviewDiffPortV1
  }) {
    this.diffPort = options.diffPort ?? new GitAttemptReviewDiffPortV1()
  }

  async read(input: {
    readonly address: HubAddressV1
    readonly attemptId: AttemptId
  }): Promise<CodingAttemptReviewProjectionV1> {
    const observed = await this.options.app.observeM2B(input.address)
    if (!observed.ok) throw new CodingAttemptReviewErrorV1('ATTEMPT_SCOPE_UNAVAILABLE')
    const attempt = observed.value.attempts.find((candidate) => candidate.attemptId === input.attemptId)
    if (!attempt) throw new CodingAttemptReviewErrorV1('ATTEMPT_NOT_FOUND')

    const capture = await this.options.workspace.captureTaskPatch(input.attemptId)
    const changedRelativePaths = capture.changedFiles.map((file) => safeRelativePath(file.relativePath)).sort()
    await this.assertPersistedPatchBinding(attempt, capture)

    const verification = this.verificationProjection(attempt.verificationSummary)
    const unifiedDiff = await this.diffPort.createUnifiedDiff({
      attemptId: input.attemptId,
      baseRevision: capture.privateVerificationContext.baseRevision,
      worktreeRoot: capture.privateVerificationContext.worktreeRoot,
      changedFiles: capture.changedFiles,
    })
    if (containsPrivatePath(unifiedDiff, capture.privateVerificationContext.worktreeRoot)) {
      throw new CodingAttemptReviewErrorV1('PRIVATE_PATH_DISCLOSURE')
    }

    return {
      bundle: {
        schemaVersion: 1,
        attemptId: input.attemptId,
        changeSetDigest: attempt.verificationSummary?.changeSetDigest ?? capture.patchArtifactDigest,
        changedRelativePaths,
        verifications: verification.verifications,
        unresolvedIssues: verification.unresolvedIssues,
      },
      unifiedDiff,
      unifiedDiffDigest: digestBytes(unifiedDiff),
    }
  }

  private async assertPersistedPatchBinding(
    attempt: AttemptProjectionM2BV1,
    capture: AttemptTaskPatchCaptureV1,
  ): Promise<void> {
    const summary = attempt.verificationSummary
    if (summary?.state !== 'SUCCEEDED') return
    const changeSet = this.options.store.readTaskChangeSet(summary.taskChangeSetId)
    if (
      !changeSet ||
      changeSet.attemptId !== attempt.attemptId ||
      changeSet.digest !== summary.changeSetDigest ||
      changeSet.patchArtifactId !== capture.patchArtifactId
    ) {
      throw new CodingAttemptReviewErrorV1('PATCH_ARTIFACT_MISMATCH')
    }
    const artifact = this.options.store.readArtifact(changeSet.patchArtifactId)
    if (
      !artifact ||
      artifact.kind !== 'PATCH' ||
      artifact.mediaType !== PATCH_MEDIA_TYPE ||
      artifact.contentDigest !== capture.patchArtifactDigest ||
      digestBytes(artifact.content) !== artifact.contentDigest ||
      !sameBytes(artifact.content, capture.patchArtifactBytes)
    ) {
      throw new CodingAttemptReviewErrorV1('PATCH_ARTIFACT_MISMATCH')
    }
  }

  private verificationProjection(summary: TaskVerificationSummaryV1 | undefined): {
    readonly verifications: CodingReviewBundleV1['verifications']
    readonly unresolvedIssues: readonly string[]
  } {
    if (!summary) {
      return { verifications: [], unresolvedIssues: ['尚未形成权威验证记录，禁止据此提交交付。'] }
    }
    if (summary.state === 'STARTED') {
      return { verifications: [], unresolvedIssues: ['验证尚未完成，禁止据此提交交付。'] }
    }

    const inspection = this.readInspection(summary)
    const unresolvedIssues: string[] = []
    if (!inspection) unresolvedIssues.push('验证制品缺失或无法校验，检查结果按未知处理。')
    if (summary.state === 'FAILED') unresolvedIssues.push('验证未通过，必须修复或人工决定后再继续。')
    if (summary.state === 'OUTCOME_UNKNOWN') unresolvedIssues.push('验证结果未知，禁止重复声称成功或形成待应用交付。')

    const checks = inspection?.checks ?? summaryChecksAsUnknown(summary)
    if (summary.state === 'SUCCEEDED') {
      const expected = Object.keys(VERIFICATION_COMMANDS) as KnownVerificationCheckIdV1[]
      if (expected.some((checkId) => !checks.some((check) => check.checkId === checkId && check.status === 'PASS'))) {
        unresolvedIssues.push('成功状态缺少完整、可校验的固定验证命令证据。')
      }
    }

    return {
      verifications: checks.map((check) => ({
        label: VERIFICATION_COMMANDS[check.checkId].label,
        commandDigest: commandDigest(check.checkId),
        exitCode: check.exitCode,
        status: check.status === 'PASS' ? 'PASSED' : check.status === 'FAIL' ? 'FAILED' : 'UNKNOWN',
      })),
      unresolvedIssues: unique(unresolvedIssues),
    }
  }

  private readInspection(summary: Exclude<TaskVerificationSummaryV1, { state: 'STARTED' }>): InspectionProjectionV1 | null {
    for (const reference of summary.diagnosticArtifacts) {
      const artifact = this.options.store.readArtifact(reference.artifactId)
      if (
        !artifact ||
        artifact.kind !== 'VERIFICATION_DIAGNOSTIC' ||
        artifact.mediaType !== DIAGNOSTIC_MEDIA_TYPE ||
        artifact.contentDigest !== reference.digest ||
        digestBytes(artifact.content) !== reference.digest
      ) continue
      const parsed = parseInspectionArtifact(artifact.content)
      if (!parsed || !inspectionMatchesSummary(parsed, summary)) continue
      return parsed
    }
    return null
  }
}

/**
 * Main-process adapter for Git's own diff engine. The private worktree root is
 * only used as process cwd and is never copied into the returned patch.
 */
export class GitAttemptReviewDiffPortV1 implements AttemptReviewDiffPortV1 {
  async createUnifiedDiff(input: AttemptReviewDiffInputV1): Promise<string> {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(input.baseRevision)) {
      throw new CodingAttemptReviewErrorV1('DIFF_GENERATION_FAILED')
    }
    const files = input.changedFiles.map((file) => ({
      ...file,
      relativePath: safeRelativePath(file.relativePath),
    }))
    const modified = files
      .filter((file) => file.operation === 'MODIFY')
      .map((file) => file.relativePath)
      .sort()
    const created = files
      .filter((file) => file.operation === 'CREATE')
      .map((file) => file.relativePath)
      .sort()
    const sections: string[] = []

    if (modified.length > 0) {
      sections.push(await gitDiff(input.worktreeRoot, [
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--binary',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        input.baseRevision,
        '--',
        ...modified,
      ], false))
    }
    for (const relativePath of created) {
      sections.push(await gitDiff(input.worktreeRoot, [
        'diff',
        '--no-index',
        '--no-ext-diff',
        '--no-color',
        '--binary',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--',
        '/dev/null',
        relativePath,
      ], true))
    }

    const unifiedDiff = sections.filter(Boolean).join(sections.length > 1 ? '\n' : '')
    if (
      Buffer.byteLength(unifiedDiff, 'utf8') > MAX_DIFF_BYTES ||
      containsPrivatePath(unifiedDiff, input.worktreeRoot)
    ) throw new CodingAttemptReviewErrorV1('PRIVATE_PATH_DISCLOSURE')
    return unifiedDiff
  }
}

interface InspectionProjectionV1 {
  readonly outcome: 'PASS' | 'FAIL' | 'OUTCOME_UNKNOWN'
  readonly checks: readonly {
    readonly checkId: KnownVerificationCheckIdV1
    readonly status: 'PASS' | 'FAIL' | 'UNKNOWN'
    readonly exitCode: number | null
  }[]
}

function parseInspectionArtifact(content: Uint8Array): InspectionProjectionV1 | null {
  if (content.byteLength === 0 || content.byteLength > 512 * 1024) return null
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(content).toString('utf8'))
  } catch {
    return null
  }
  if (!isRecord(value) || value.version !== 'task-verification-inspection.v1') return null
  if (value.outcome !== 'PASS' && value.outcome !== 'FAIL' && value.outcome !== 'OUTCOME_UNKNOWN') return null
  if (!Array.isArray(value.checks)) return null
  const checks: Array<InspectionProjectionV1['checks'][number]> = []
  for (const check of value.checks) {
    if (!isRecord(check) || !isKnownCheckId(check.checkId)) return null
    if (!['PASS', 'FAIL', 'TIMED_OUT', 'SPAWN_FAILED'].includes(String(check.status))) return null
    const exitCode = check.exitCode === undefined
      ? null
      : Number.isSafeInteger(check.exitCode) ? Number(check.exitCode) : null
    if ((check.status === 'PASS' || check.status === 'FAIL') && exitCode === null) return null
    if ((check.status === 'TIMED_OUT' || check.status === 'SPAWN_FAILED') && check.exitCode !== undefined) return null
    checks.push({
      checkId: check.checkId,
      status: check.status === 'PASS' ? 'PASS' : check.status === 'FAIL' ? 'FAIL' : 'UNKNOWN',
      exitCode,
    })
  }
  if (new Set(checks.map((check) => check.checkId)).size !== checks.length) return null
  return { outcome: value.outcome, checks }
}

function inspectionMatchesSummary(
  inspection: InspectionProjectionV1,
  summary: Exclude<TaskVerificationSummaryV1, { state: 'STARTED' }>,
): boolean {
  const expectedOutcome = summary.state === 'SUCCEEDED' ? 'PASS' : summary.state === 'FAILED' ? 'FAIL' : 'OUTCOME_UNKNOWN'
  if (inspection.outcome !== expectedOutcome) return false
  if (summary.state === 'OUTCOME_UNKNOWN') return true
  const verdictById = new Map(summary.checks.map((check) => [check.checkId, check.verdict]))
  return inspection.checks.every((check) => verdictById.get(check.checkId) === check.status)
}

function summaryChecksAsUnknown(
  summary: Exclude<TaskVerificationSummaryV1, { state: 'STARTED' }>,
): readonly InspectionProjectionV1['checks'][number][] {
  if (summary.state === 'OUTCOME_UNKNOWN') return []
  return summary.checks
    .filter((check): check is typeof check & { checkId: KnownVerificationCheckIdV1 } => isKnownCheckId(check.checkId))
    .map((check) => ({ checkId: check.checkId, status: 'UNKNOWN', exitCode: null }))
}

function commandDigest(checkId: KnownVerificationCheckIdV1): Sha256Digest {
  const command = VERIFICATION_COMMANDS[checkId]
  return digestBytes(JSON.stringify({
    kind: 'XIAOGUI_FIXED_VERIFICATION_COMMAND_V1',
    executable: 'typescript/tsc',
    args: ['--project', command.configPath, '--noEmit'],
  }))
}

async function gitDiff(
  worktreeRoot: string,
  args: readonly string[],
  allowDifferenceExit: boolean,
): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', worktreeRoot, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: MAX_DIFF_BYTES,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
      },
    })
    return result.stdout
  } catch (error) {
    if (allowDifferenceExit && isExecFileDifference(error)) return error.stdout
    throw new CodingAttemptReviewErrorV1('DIFF_GENERATION_FAILED')
  }
}

function isExecFileDifference(value: unknown): value is { code: 1; stdout: string } {
  return isRecord(value) && value.code === 1 && typeof value.stdout === 'string'
}

function safeRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) throw new CodingAttemptReviewErrorV1('UNSAFE_RELATIVE_PATH')
  return value
}

function containsPrivatePath(value: string, privateRoot: string): boolean {
  const normalizedValue = value.replaceAll('\\', '/').toLowerCase()
  const normalizedRoot = privateRoot.replaceAll('\\', '/').toLowerCase()
  return normalizedRoot.length > 0 && normalizedValue.includes(normalizedRoot)
}

function digestBytes(value: Uint8Array | string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right))
}

function isKnownCheckId(value: unknown): value is KnownVerificationCheckIdV1 {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VERIFICATION_COMMANDS, value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}
