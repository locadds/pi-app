import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import path from 'node:path'

import {
  verificationReceiptDigestV1,
  type ArtifactId,
  type Sha256Digest,
  type TaskVerificationFailedReceiptV1,
  type TaskVerificationPassedReceiptV1,
  type TaskVerificationReceiptV1,
  type TaskVerificationRequestV1,
  type TaskVerificationUnknownReceiptV1,
} from '@shared/xiaogui-task-verification'
import type { AttemptId } from '@shared/xiaogui-collaboration-hub'
import { inspectSafeDocxArchiveV1 } from '../docx-safety'

const VERIFICATION_TIMEOUT_MS = 120_000
const VERIFICATION_OUTPUT_LIMIT_BYTES = 256 * 1024

const FORBIDDEN_EXECUTION_KEYS = new Set([
  'command',
  'args',
  'cwd',
  'env',
  'shell',
  'executable',
  'timeoutMs',
  'maxOutputBytes',
])

export interface NoVerificationExecutionControlsV1 {
  readonly command?: never
  readonly args?: never
  readonly cwd?: never
  readonly env?: never
  readonly shell?: never
  readonly executable?: never
  readonly timeoutMs?: never
  readonly maxOutputBytes?: never
}

/**
 * The public verification fact is readonly and cannot carry process controls.
 * Runtime validation below also rejects controls smuggled through untyped IPC.
 */
export type FrozenTaskVerificationRequestV1 = Readonly<TaskVerificationRequestV1> &
  NoVerificationExecutionControlsV1

/** Main-process-only data. None of these paths may enter a public receipt. */
export interface TaskVerificationExecutionContextV1 extends NoVerificationExecutionControlsV1 {
  readonly worktreeRoot: string
  readonly trustedToolchainRoot: string
  readonly scopeEvidenceArtifactId: ArtifactId
  readonly inspectionArtifactId: ArtifactId
  readonly verificationScope?: 'TASK' | 'DELIVERY'
  readonly artifactPaths?: readonly string[]
  /** Main-only Delivery binding; never serialized into a public request/receipt. */
  readonly artifactSourceAttemptIds?: readonly AttemptId[]
}

/** Main-process-only artifact write. Content never enters a public receipt. */
export interface TaskArtifactWriteV1 {
  readonly artifactId: ArtifactId
  readonly contentDigest: Sha256Digest
  readonly kind: 'VERIFICATION_EVIDENCE' | 'VERIFICATION_DIAGNOSTIC'
  readonly mediaType: string
  readonly content: Uint8Array
}

export interface TaskVerificationExecutionResultV1 {
  readonly receipt: TaskVerificationReceiptV1
  readonly artifacts: readonly TaskArtifactWriteV1[]
}

export interface TaskVerificationExecutionPortV1 {
  verify(
    request: FrozenTaskVerificationRequestV1,
    executionContext: Readonly<TaskVerificationExecutionContextV1>,
  ): Promise<TaskVerificationExecutionResultV1>
}

export interface VerificationProcessInvocationV1 {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly shell: false
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

export type VerificationProcessResultV1 =
  | {
      readonly status: 'EXITED'
      readonly exitCode: number
      readonly stdout: Uint8Array
      readonly stderr: Uint8Array
      readonly outputTruncated: boolean
    }
  | {
      readonly status: 'TIMED_OUT' | 'SPAWN_FAILED'
      readonly stdout: Uint8Array
      readonly stderr: Uint8Array
      readonly outputTruncated: boolean
    }

export interface VerificationProcessRunnerV1 {
  run(invocation: VerificationProcessInvocationV1): Promise<VerificationProcessResultV1>
}

export type VerificationDependencyReleaseStatusV1 = 'RELEASED' | 'OWNERSHIP_LOST' | 'FAILED'

export interface VerificationDependencyLeaseV1 {
  release(): VerificationDependencyReleaseStatusV1
}

export interface VerificationDependencyLinkPortV1 {
  acquire(
    worktreeRoot: string,
    trustedToolchainRoot: string,
  ): VerificationDependencyLeaseV1 | null
}

type VerificationProcessCompletionV1 =
  | { readonly status: 'EXITED'; readonly exitCode: number }
  | { readonly status: 'TIMED_OUT' | 'SPAWN_FAILED' }

export type TaskVerificationScriptV1 = (
  request: FrozenTaskVerificationRequestV1,
  executionContext: Readonly<TaskVerificationExecutionContextV1>,
) => TaskVerificationExecutionResultV1 | Promise<TaskVerificationExecutionResultV1>

interface InspectionCheckV1 {
  checkId: 'typescript.web' | 'typescript.node' | 'work.report-docx' | 'design.project'
  status: 'PASS' | 'FAIL' | 'TIMED_OUT' | 'SPAWN_FAILED'
  exitCode?: number
  stdout: string
  stderr: string
  outputTruncated: boolean
}

interface InspectionLogV1 {
  version: 'task-verification-inspection.v1'
  outcome: 'PASS' | 'FAIL' | 'OUTCOME_UNKNOWN'
  safeCode: string
  checks: readonly InspectionCheckV1[]
}

class NodeVerificationProcessRunnerV1 implements VerificationProcessRunnerV1 {
  run(invocation: VerificationProcessInvocationV1): Promise<VerificationProcessResultV1> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>
      try {
        // A Windows .cmd shim cannot be spawned with shell:false. Resolve only
        // the fixed tsc shim to its package entry and keep the shell disabled.
        const isWindowsTscShim = process.platform === 'win32' &&
          path.basename(invocation.executable).toLowerCase() === 'tsc.cmd'
        const executable = isWindowsTscShim ? process.execPath : invocation.executable
        const windowsTscEntry = path.join(path.dirname(invocation.executable), '..', 'typescript', 'bin', 'tsc')
        if (isWindowsTscShim) {
          accessSync(invocation.executable, fsConstants.R_OK)
          accessSync(windowsTscEntry, fsConstants.R_OK)
        }
        const args = isWindowsTscShim
          ? [windowsTscEntry, ...invocation.args]
          : [...invocation.args]
        child = spawn(executable, args, {
          cwd: invocation.cwd,
          shell: false,
          windowsHide: true,
          // In packaged Electron, process.execPath is electron.exe. This
          // code-owned flag makes the same trusted binary act as Node.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        })
      } catch {
        resolve(emptyProcessFailure('SPAWN_FAILED'))
        return
      }

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let capturedBytes = 0
      let outputTruncated = false
      let timedOut = false
      let settled = false

      const capture = (target: Buffer[], value: Buffer | string): void => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        const remaining = invocation.maxOutputBytes - capturedBytes
        if (remaining <= 0) {
          outputTruncated = true
          return
        }
        const accepted = chunk.subarray(0, remaining)
        target.push(accepted)
        capturedBytes += accepted.byteLength
        if (accepted.byteLength !== chunk.byteLength) outputTruncated = true
      }

      child.stdout?.on('data', (value: Buffer | string) => capture(stdoutChunks, value))
      child.stderr?.on('data', (value: Buffer | string) => capture(stderrChunks, value))

      const finish = (result: VerificationProcessCompletionV1): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          ...result,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          outputTruncated,
        } as VerificationProcessResultV1)
      }

      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
        finish({ status: 'TIMED_OUT' })
      }, invocation.timeoutMs)

      child.once('error', () => finish({ status: 'SPAWN_FAILED' }))
      child.once('close', (exitCode) => {
        if (timedOut) {
          finish({ status: 'TIMED_OUT' })
          return
        }
        if (typeof exitCode !== 'number') {
          finish({ status: 'SPAWN_FAILED' })
          return
        }
        finish({ status: 'EXITED', exitCode })
      })
    })
  }
}

class FileSystemVerificationDependencyLinkPortV1 implements VerificationDependencyLinkPortV1 {
  acquire(worktreeRoot: string, trustedToolchainRoot: string): VerificationDependencyLeaseV1 | null {
    const candidatePath = path.join(realpathSync(worktreeRoot), 'node_modules')
    const trustedPath = realpathSync(path.join(trustedToolchainRoot, 'node_modules'))
    accessSync(trustedPath, fsConstants.R_OK)
    if (!statSync(trustedPath).isDirectory() || lstatIfPresent(candidatePath)) return null

    try {
      symlinkSync(trustedPath, candidatePath, process.platform === 'win32' ? 'junction' : 'dir')
      if (!isOwnedDependencyLink(candidatePath, trustedPath)) {
        removeOwnedDependencyLink(candidatePath, trustedPath)
        return null
      }
    } catch {
      removeOwnedDependencyLink(candidatePath, trustedPath)
      return null
    }

    let active = true
    return {
      release: () => {
        if (!active) return 'RELEASED'
        active = false
        if (!isOwnedDependencyLink(candidatePath, trustedPath)) return 'OWNERSHIP_LOST'
        try {
          unlinkSync(candidatePath)
          return lstatIfPresent(candidatePath) ? 'FAILED' : 'RELEASED'
        } catch {
          return 'FAILED'
        }
      },
    }
  }
}

/**
 * Test seam. It still applies the same frozen-input and receipt-binding guard
 * as production, so a scripted fixture cannot create a second public shape.
 */
export class ScriptedTaskVerificationPortV1 implements TaskVerificationExecutionPortV1 {
  constructor(private readonly script: TaskVerificationScriptV1) {}

  async verify(
    request: FrozenTaskVerificationRequestV1,
    executionContext: Readonly<TaskVerificationExecutionContextV1>,
  ): Promise<TaskVerificationExecutionResultV1> {
    const invalidCode = validateInvocation(request, executionContext)
    if (invalidCode) return unknownResult(request, executionContext, invalidCode, [])

    try {
      const result = await this.script(request, executionContext)
      if (!resultMatchesRequest(
        result,
        request,
        executionContext.scopeEvidenceArtifactId,
        executionContext.inspectionArtifactId,
      )) {
        return unknownResult(request, executionContext, 'SCRIPTED_RECEIPT_MISMATCH', [])
      }
      return result
    } catch {
      return unknownResult(request, executionContext, 'SCRIPTED_VERIFICATION_ERROR', [])
    }
  }
}

/**
 * Production TASK verifier. Both process templates are code-owned and fixed:
 * the source installation's tsc checks the Attempt worktree's two configs.
 */
export class FixedTypecheckVerificationPortV1 implements TaskVerificationExecutionPortV1 {
  constructor(
    private readonly runner: VerificationProcessRunnerV1 = new NodeVerificationProcessRunnerV1(),
    private readonly dependencyLinks: VerificationDependencyLinkPortV1 = new FileSystemVerificationDependencyLinkPortV1(),
  ) {}

  async verify(
    request: FrozenTaskVerificationRequestV1,
    executionContext: Readonly<TaskVerificationExecutionContextV1>,
  ): Promise<TaskVerificationExecutionResultV1> {
    const invalidCode = validateInvocation(request, executionContext)
    if (invalidCode) return unknownResult(request, executionContext, invalidCode, [])

    let dependencyLease: VerificationDependencyLeaseV1 | null = null
    try {
      dependencyLease = this.dependencyLinks.acquire(
        executionContext.worktreeRoot,
        executionContext.trustedToolchainRoot,
      )
    } catch {
      // The verifier owns this dependency link. Any pre-existing path or
      // unavailable trusted installation therefore fails closed.
    }
    if (!dependencyLease) {
      return unknownResult(request, executionContext, 'VERIFICATION_TOOLCHAIN_UNAVAILABLE', [])
    }

    let result: TaskVerificationExecutionResultV1 | null = null
    try {
      result = await this.runFixedTypechecks(request, executionContext)
    } catch {
      result = unknownResult(request, executionContext, 'VERIFICATION_PROCESS_ERROR', [])
    }

    let releaseStatus: VerificationDependencyReleaseStatusV1 = 'FAILED'
    try {
      releaseStatus = dependencyLease.release()
    } catch {
      // A cleanup exception is an unknown verification outcome, never PASS.
    }
    if (releaseStatus !== 'RELEASED') {
      return unknownResult(request, executionContext, 'VERIFICATION_DEPENDENCY_CLEANUP_FAILED', [])
    }
    return result
  }

  private async runFixedTypechecks(
    request: FrozenTaskVerificationRequestV1,
    executionContext: Readonly<TaskVerificationExecutionContextV1>,
  ): Promise<TaskVerificationExecutionResultV1> {

    const executable = path.join(
      executionContext.trustedToolchainRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
    )
    const templates = [
      {
        checkId: 'typescript.web' as const,
        configPath: path.join(executionContext.worktreeRoot, 'tsconfig.web.json'),
      },
      {
        checkId: 'typescript.node' as const,
        configPath: path.join(executionContext.worktreeRoot, 'tsconfig.node.json'),
      },
    ]
    const inspectionChecks: InspectionCheckV1[] = []
    const evidenceArtifactId = taskVerificationEvidenceArtifactId(request, executionContext.inspectionArtifactId)
    const passedChecks: Array<{
      checkId: string
      summary: string
      artifactIds: readonly ArtifactId[]
      verdict: 'PASS'
    }> = [{
      checkId: 'workspace.scope',
      summary: '文件范围审计通过',
      artifactIds: [executionContext.scopeEvidenceArtifactId],
      verdict: 'PASS',
    }]

    for (const template of templates) {
      let outcome: VerificationProcessResultV1
      try {
        outcome = await this.runner.run({
          executable,
          args: ['--project', template.configPath, '--noEmit'],
          cwd: executionContext.worktreeRoot,
          shell: false,
          timeoutMs: VERIFICATION_TIMEOUT_MS,
          maxOutputBytes: VERIFICATION_OUTPUT_LIMIT_BYTES,
        })
      } catch {
        return unknownResult(request, executionContext, 'VERIFICATION_PROCESS_ERROR', inspectionChecks)
      }

      const inspection = toInspectionCheck(template.checkId, outcome)
      inspectionChecks.push(inspection)
      if (outcome.status !== 'EXITED') {
        return unknownResult(
          request,
          executionContext,
          outcome.status === 'TIMED_OUT'
            ? 'VERIFICATION_PROCESS_TIMEOUT'
            : 'VERIFICATION_TOOLCHAIN_UNAVAILABLE',
          inspectionChecks,
        )
      }
      if (outcome.exitCode !== 0) {
        return failedResult(request, executionContext, template.checkId, passedChecks, inspectionChecks)
      }
      passedChecks.push({
        checkId: template.checkId,
        summary: `${checkLabel(template.checkId)}通过`,
        artifactIds: [evidenceArtifactId],
        verdict: 'PASS',
      })
    }

    return passedResult(request, executionContext, passedChecks, inspectionChecks)
  }
}

export type ModeTaskVerificationModeV1 = 'WORK' | 'DESIGN' | 'CODING'
export type ModeTaskVerificationArtifactKindV1 = 'WORK_REPORT_DOCX' | 'DESIGN_PROJECT_RESULT'

export interface ModeTaskVerificationArtifactV1 {
  readonly path: string
  readonly sha256: string
  readonly kind: ModeTaskVerificationArtifactKindV1
}

export interface ModeTaskVerificationResolutionV1 {
  readonly mode: ModeTaskVerificationModeV1
  readonly artifacts: readonly ModeTaskVerificationArtifactV1[]
  readonly requireAll: boolean
}

/**
 * Selects the authoritative verifier for a Task without allowing mode-specific
 * summaries to manufacture a PASS. The resolver is Main-owned and may only
 * expose the private, already-settled Attempt artifact projection.
 */
export class ModeTaskVerificationPortV1 implements TaskVerificationExecutionPortV1 {
  constructor(
    private readonly codePort: TaskVerificationExecutionPortV1,
    private readonly resolveMode: (
      request: FrozenTaskVerificationRequestV1,
      executionContext: Readonly<TaskVerificationExecutionContextV1>,
    ) => Promise<ModeTaskVerificationResolutionV1 | null>,
  ) {}

  async verify(
    request: FrozenTaskVerificationRequestV1,
    executionContext: Readonly<TaskVerificationExecutionContextV1>,
  ): Promise<TaskVerificationExecutionResultV1> {
    const invalidCode = validateInvocation(request, executionContext)
    if (invalidCode) return unknownResult(request, executionContext, invalidCode, [])

    let resolution: ModeTaskVerificationResolutionV1 | null
    try {
      resolution = await this.resolveMode(request, executionContext)
    } catch {
      return unknownResult(request, executionContext, 'ARTIFACT_RESOLUTION_UNKNOWN', [])
    }
    if (!isModeTaskVerificationResolution(resolution)) {
      return unknownResult(request, executionContext, 'ARTIFACT_RESOLUTION_UNKNOWN', [])
    }
    if (resolution.mode === 'CODING') return this.codePort.verify(request, executionContext)
    return this.verifyModeArtifacts(request, executionContext, resolution)
  }

  private async verifyModeArtifacts(
    request: FrozenTaskVerificationRequestV1,
    executionContext: Readonly<TaskVerificationExecutionContextV1>,
    resolution: ModeTaskVerificationResolutionV1,
  ): Promise<TaskVerificationExecutionResultV1> {
    const checkId = resolution.mode === 'WORK' ? 'work.report-docx' : 'design.project'
    const expectedKind = resolution.mode === 'WORK' ? 'WORK_REPORT_DOCX' : 'DESIGN_PROJECT_RESULT'
    const allowedArtifactPaths = safeArtifactPathSet(executionContext.artifactPaths)
    if (allowedArtifactPaths === null) {
      return failedResult(
        request,
        executionContext,
        checkId,
        [{
          checkId: 'workspace.scope',
          summary: '文件范围审计通过',
          artifactIds: [executionContext.scopeEvidenceArtifactId],
          verdict: 'PASS' as const,
        }],
        [artifactInspection(checkId, 'FAIL')],
        'ARTIFACT_VERIFICATION_FAILED',
      )
    }
    const passedChecks = [{
      checkId: 'workspace.scope',
      summary: '文件范围审计通过',
      artifactIds: [executionContext.scopeEvidenceArtifactId],
      verdict: 'PASS' as const,
    }]
    const inspected: InspectionCheckV1[] = []
    let verifiedCount = 0

    for (const artifact of resolution.artifacts) {
      if (!validModeArtifactDescriptor(artifact, expectedKind) ||
        (allowedArtifactPaths !== undefined && !allowedArtifactPaths.has(artifact.path))) {
        return failedResult(
          request,
          executionContext,
          checkId,
          passedChecks,
          [artifactInspection(checkId, 'FAIL')],
          'ARTIFACT_VERIFICATION_FAILED',
        )
      }

      const content = readModeArtifact(executionContext.worktreeRoot, artifact.path)
      if (content.kind === 'MISSING') {
        if (resolution.requireAll) {
          return failedResult(
            request,
            executionContext,
            checkId,
            passedChecks,
            [artifactInspection(checkId, 'FAIL')],
            'ARTIFACT_VERIFICATION_FAILED',
          )
        }
        continue
      }
      if (content.kind !== 'PRESENT' || !digestMatches(content.bytes, artifact.sha256)) {
        return failedResult(
          request,
          executionContext,
          checkId,
          passedChecks,
          [artifactInspection(checkId, 'FAIL')],
          'ARTIFACT_VERIFICATION_FAILED',
        )
      }

      const structurallyValid = resolution.mode === 'WORK'
        ? await validWorkReportArtifact(content.bytes)
        : validDesignProjectArtifact(content.bytes)
      if (!structurallyValid) {
        return failedResult(
          request,
          executionContext,
          checkId,
          passedChecks,
          [artifactInspection(checkId, 'FAIL')],
          'ARTIFACT_VERIFICATION_FAILED',
        )
      }
      verifiedCount += 1
      inspected.push(artifactInspection(checkId, 'PASS'))
    }

    if (verifiedCount === 0) {
      return failedResult(
        request,
        executionContext,
        checkId,
        passedChecks,
        [artifactInspection(checkId, 'FAIL')],
        'ARTIFACT_VERIFICATION_FAILED',
      )
    }

    const evidenceArtifactId = taskVerificationEvidenceArtifactId(request, executionContext.inspectionArtifactId)
    return passedResult(
      request,
      executionContext,
      [...passedChecks, {
        checkId,
        summary: `${checkLabel(checkId)}通过`,
        artifactIds: [evidenceArtifactId],
        verdict: 'PASS' as const,
      }],
      inspected,
      'ARTIFACTS_VERIFIED',
    )
  }
}

const MODE_ARTIFACT_MAX_BYTES_V1 = 16 * 1024 * 1024
const SHA256_DIGEST_PATTERN_V1 = /^sha256:[0-9a-f]{64}$/i
const PRIVATE_DESIGN_PATH_KEYS_V1 = new Set([
  'root',
  'rootpath',
  'sourcepath',
  'worktreeroot',
  'worktreepath',
  'projectroot',
  'trustedtoolchainroot',
  'absolutepath',
  'privatepath',
])

type ModeArtifactReadResultV1 =
  | { readonly kind: 'MISSING' }
  | { readonly kind: 'INVALID' }
  | { readonly kind: 'PRESENT'; readonly bytes: Buffer }

function isModeTaskVerificationResolution(
  value: ModeTaskVerificationResolutionV1 | null,
): value is ModeTaskVerificationResolutionV1 {
  if (!value || typeof value !== 'object' || !Array.isArray(value.artifacts)) return false
  return (value.mode === 'WORK' || value.mode === 'DESIGN' || value.mode === 'CODING') &&
    typeof value.requireAll === 'boolean'
}

function validModeArtifactDescriptor(
  value: unknown,
  expectedKind: ModeTaskVerificationArtifactKindV1,
): value is ModeTaskVerificationArtifactV1 {
  if (!value || typeof value !== 'object') return false
  const artifact = value as Partial<ModeTaskVerificationArtifactV1>
  return artifact.kind === expectedKind &&
    safeArtifactRelativePath(artifact.path) &&
    typeof artifact.sha256 === 'string' &&
    SHA256_DIGEST_PATTERN_V1.test(artifact.sha256)
}

function safeArtifactRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    value !== value.trim() ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[a-z]:/i.test(value)
  ) return false
  const normalized = path.posix.normalize(value)
  if (normalized !== value) return false
  return value.split('/').every((part) => (
    part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'
  ))
}

function safeArtifactPathSet(
  values: readonly string[] | undefined,
): Set<string> | undefined | null {
  if (values === undefined) return undefined
  if (!Array.isArray(values)) return null
  const paths = new Set<string>()
  for (const value of values) {
    if (!safeArtifactRelativePath(value)) return null
    paths.add(value)
  }
  return paths
}

function readModeArtifact(root: string, relativePath: string): ModeArtifactReadResultV1 {
  try {
    const realRoot = realpathSync(root)
    let target = realRoot
    const parts = relativePath.split('/')
    for (const [index, part] of parts.entries()) {
      target = path.join(target, part)
      let entry
      try {
        entry = lstatSync(target)
      } catch (error) {
        return isNodeErrorWithCode(error, 'ENOENT') ? { kind: 'MISSING' } : { kind: 'INVALID' }
      }
      if (entry.isSymbolicLink()) return { kind: 'INVALID' }
      if (index < parts.length - 1) {
        if (!entry.isDirectory()) return { kind: 'INVALID' }
        continue
      }
      if (!entry.isFile()) return { kind: 'INVALID' }
      const stat = statSync(target)
      if (stat.nlink > 1 || stat.size > MODE_ARTIFACT_MAX_BYTES_V1) return { kind: 'INVALID' }
      const realTarget = realpathSync(target)
      const targetRelative = path.relative(realRoot, realTarget)
      if (
        !targetRelative ||
        path.isAbsolute(targetRelative) ||
        targetRelative === '..' ||
        targetRelative.startsWith(`..${path.sep}`)
      ) return { kind: 'INVALID' }
      const bytes = readFileSync(target)
      const after = lstatSync(target)
      if (
        after.isSymbolicLink() ||
        !after.isFile() ||
        after.nlink > 1 ||
        after.size !== stat.size ||
        bytes.byteLength > MODE_ARTIFACT_MAX_BYTES_V1
      ) return { kind: 'INVALID' }
      return { kind: 'PRESENT', bytes }
    }
    return { kind: 'INVALID' }
  } catch {
    return { kind: 'INVALID' }
  }
}

function digestMatches(bytes: Uint8Array, expected: string): boolean {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` === expected.toLowerCase()
}

async function validWorkReportArtifact(bytes: Buffer): Promise<boolean> {
  try {
    await inspectSafeDocxArchiveV1(bytes)
    return true
  } catch {
    return false
  }
}

function validDesignProjectArtifact(bytes: Buffer): boolean {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return false
  }
  if (!isRecord(value) || hasPrivateDesignPathData(value)) return false
  if (
    value.kind !== 'DESIGN_PROJECT_OVERVIEW_V1' ||
    value.status !== 'ok' ||
    !nonEmptyString(value.source_version) ||
    !nonEmptyString(value.trace_id) ||
    !Array.isArray(value.sources) ||
    value.sources.length === 0
  ) return false
  return value.sources.every((source) => (
    isRecord(source) &&
    safeArtifactRelativePath(source.path) &&
    typeof source.sha256 === 'string' &&
    SHA256_DIGEST_PATTERN_V1.test(source.sha256)
  ))
}

function hasPrivateDesignPathData(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrivateDesignPathData)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, nested]) => {
    const normalizedKey = key.replace(/[\s_-]/g, '').toLowerCase()
    if (PRIVATE_DESIGN_PATH_KEYS_V1.has(normalizedKey)) return true
    if (typeof nested === 'string' && looksLikeAbsolutePath(nested)) return true
    return hasPrivateDesignPathData(nested)
  })
}

function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith('file://') || path.isAbsolute(value) || path.win32.isAbsolute(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function artifactInspection(
  checkId: 'work.report-docx' | 'design.project',
  status: 'PASS' | 'FAIL',
): InspectionCheckV1 {
  return { checkId, status, stdout: '', stderr: '', outputTruncated: false }
}

function lstatIfPresent(targetPath: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(targetPath)
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return null
    throw error
  }
}

function isOwnedDependencyLink(candidatePath: string, trustedPath: string): boolean {
  try {
    const candidate = lstatSync(candidatePath)
    return candidate.isSymbolicLink() && samePath(realpathSync(candidatePath), trustedPath)
  } catch {
    return false
  }
}

function removeOwnedDependencyLink(candidatePath: string, trustedPath: string): void {
  if (!isOwnedDependencyLink(candidatePath, trustedPath)) return
  try {
    unlinkSync(candidatePath)
  } catch {
    // The caller will fail closed; never remove a path whose ownership changed.
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function validateInvocation(
  request: FrozenTaskVerificationRequestV1,
  executionContext: Readonly<TaskVerificationExecutionContextV1>,
): string | null {
  if (!request || typeof request !== 'object' || !Object.isFrozen(request)) return 'VERIFICATION_REQUEST_NOT_FROZEN'
  if (!executionContext || typeof executionContext !== 'object') return 'VERIFICATION_CONTEXT_INVALID'
  if (containsForbiddenExecutionKey(request) || containsForbiddenExecutionKey(executionContext)) {
    return 'VERIFICATION_EXECUTION_CONTROL_REJECTED'
  }
  if (request.scope !== 'TASK') return 'VERIFICATION_SCOPE_UNSUPPORTED'
  const requiredRequestStrings = [
    request.verificationAttemptId,
    request.verificationRequestId,
    request.flowId,
    request.requestDigest,
    request.changeSetDigest,
    request.preparedTreeHash,
    request.qaConfigVersion,
    request.taskRunId,
    request.attemptId,
    request.candidateId,
  ]
  if (requiredRequestStrings.some((value) => typeof value !== 'string' || value.length === 0)) {
    return 'VERIFICATION_REQUEST_INVALID'
  }
  if (!Array.isArray(request.acceptanceCriteria) || request.acceptanceCriteria.some((value) => typeof value !== 'string')) {
    return 'VERIFICATION_REQUEST_INVALID'
  }
  if (
    !isSafeAbsolutePath(executionContext.worktreeRoot) ||
    !isSafeAbsolutePath(executionContext.trustedToolchainRoot) ||
    typeof executionContext.scopeEvidenceArtifactId !== 'string' ||
    executionContext.scopeEvidenceArtifactId.length === 0 ||
    typeof executionContext.inspectionArtifactId !== 'string' ||
    executionContext.inspectionArtifactId.length === 0
  ) {
    return 'VERIFICATION_CONTEXT_INVALID'
  }
  return null
}

function containsForbiddenExecutionKey(value: object): boolean {
  return Object.keys(value).some((key) => FORBIDDEN_EXECUTION_KEYS.has(key))
}

function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value)
}

function toInspectionCheck(
  checkId: InspectionCheckV1['checkId'],
  outcome: VerificationProcessResultV1,
): InspectionCheckV1 {
  const status = outcome.status === 'EXITED'
    ? outcome.exitCode === 0 ? 'PASS' : 'FAIL'
    : outcome.status
  return {
    checkId,
    status,
    ...(outcome.status === 'EXITED' ? { exitCode: outcome.exitCode } : {}),
    stdout: Buffer.from(outcome.stdout).toString('utf8'),
    stderr: Buffer.from(outcome.stderr).toString('utf8'),
    outputTruncated: outcome.outputTruncated,
  }
}

function passedResult(
  request: FrozenTaskVerificationRequestV1,
  executionContext: Readonly<TaskVerificationExecutionContextV1>,
  checks: readonly { checkId: string; summary: string; artifactIds: readonly ArtifactId[]; verdict: 'PASS' }[],
  inspectionChecks: readonly InspectionCheckV1[],
  safeCode = 'TYPECHECKS_PASSED',
): TaskVerificationExecutionResultV1 {
  const log = {
    version: 'task-verification-inspection.v1',
    outcome: 'PASS',
    safeCode,
    checks: inspectionChecks,
  } satisfies InspectionLogV1
  const diagnosticArtifact = inspectionArtifact(executionContext.inspectionArtifactId, log)
  const evidenceArtifact = verificationEvidenceArtifact(
    taskVerificationEvidenceArtifactId(request, executionContext.inspectionArtifactId),
    log,
  )
  const receiptWithoutDigest = {
    ...receiptBinding(request, diagnosticArtifact.artifactId),
    verdict: 'PASS' as const,
    checks,
    evidenceArtifactIds: [executionContext.scopeEvidenceArtifactId, evidenceArtifact.artifactId],
  } satisfies Omit<TaskVerificationPassedReceiptV1, 'receiptDigest'>
  return {
    receipt: { ...receiptWithoutDigest, receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest) },
    artifacts: [evidenceArtifact, diagnosticArtifact],
  }
}

function failedResult(
  request: FrozenTaskVerificationRequestV1,
  executionContext: Readonly<TaskVerificationExecutionContextV1>,
  failedCheckId: InspectionCheckV1['checkId'],
  passedChecks: readonly { checkId: string; summary: string; artifactIds: readonly ArtifactId[]; verdict: 'PASS' }[],
  inspectionChecks: readonly InspectionCheckV1[],
  reason = 'FIXED_TYPECHECK_FAILED',
): TaskVerificationExecutionResultV1 {
  const log = {
    version: 'task-verification-inspection.v1',
    outcome: 'FAIL',
    safeCode: 'QA_CHECK_FAILED',
    checks: inspectionChecks,
  } satisfies InspectionLogV1
  const diagnosticArtifact = inspectionArtifact(executionContext.inspectionArtifactId, log)
  const evidenceArtifact = verificationEvidenceArtifact(
    taskVerificationEvidenceArtifactId(request, executionContext.inspectionArtifactId),
    log,
  )
  const failedCheck = {
    checkId: failedCheckId,
    summary: `${checkLabel(failedCheckId)}未通过`,
    artifactIds: [evidenceArtifact.artifactId],
    verdict: 'FAIL' as const,
  }
  const receiptWithoutDigest = {
    ...receiptBinding(request, diagnosticArtifact.artifactId),
    verdict: 'FAIL' as const,
    checks: [failedCheck, ...passedChecks] as const,
    evidenceArtifactIds: [executionContext.scopeEvidenceArtifactId, evidenceArtifact.artifactId],
    failure: {
      source: 'QA_CHECKS_FAILED' as const,
      failureClass: 'TEST_FAILURE' as const,
      disposition: 'REQUIRE_HUMAN_GATE' as const,
      retryOrdinal: 0 as const,
      safeCode: 'QA_CHECK_FAILED' as const,
    },
    reason,
  } satisfies Omit<TaskVerificationFailedReceiptV1, 'receiptDigest'>
  return {
    receipt: { ...receiptWithoutDigest, receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest) },
    artifacts: [evidenceArtifact, diagnosticArtifact],
  }
}

function unknownResult(
  request: FrozenTaskVerificationRequestV1,
  executionContext: Readonly<TaskVerificationExecutionContextV1>,
  safeCode: string,
  inspectionChecks: readonly InspectionCheckV1[],
): TaskVerificationExecutionResultV1 {
  const artifactId = typeof executionContext?.inspectionArtifactId === 'string' && executionContext.inspectionArtifactId
    ? executionContext.inspectionArtifactId
    : 'task-verification-inspection-unbound' as ArtifactId
  const artifact = inspectionArtifact(artifactId, {
    version: 'task-verification-inspection.v1',
    outcome: 'OUTCOME_UNKNOWN',
    safeCode,
    checks: inspectionChecks,
  })
  const receiptWithoutDigest = {
    ...receiptBinding(request, artifact.artifactId),
    verdict: 'OUTCOME_UNKNOWN' as const,
    reason: safeCode,
  } satisfies Omit<TaskVerificationUnknownReceiptV1, 'receiptDigest'>
  return {
    receipt: { ...receiptWithoutDigest, receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest) },
    artifacts: [artifact],
  }
}

function receiptBinding(request: FrozenTaskVerificationRequestV1, diagnosticArtifactId: ArtifactId) {
  return {
    verificationAttemptId: request.verificationAttemptId,
    verificationRequestId: request.verificationRequestId,
    flowId: request.flowId,
    requestDigest: request.requestDigest,
    changeSetDigest: request.changeSetDigest,
    qaConfigVersion: request.qaConfigVersion,
    diagnosticArtifactIds: [diagnosticArtifactId],
    scope: 'TASK' as const,
    taskRunId: request.taskRunId,
    attemptId: request.attemptId,
    candidateId: request.candidateId,
  }
}

function inspectionArtifact(artifactId: ArtifactId, log: InspectionLogV1): TaskArtifactWriteV1 {
  const content = Buffer.from(JSON.stringify(log), 'utf8')
  return {
    artifactId,
    contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}` as Sha256Digest,
    kind: 'VERIFICATION_DIAGNOSTIC',
    mediaType: 'application/vnd.xiaogui.qa-diagnostic+json',
    content,
  }
}

function verificationEvidenceArtifact(artifactId: ArtifactId, log: InspectionLogV1): TaskArtifactWriteV1 {
  const content = Buffer.from(JSON.stringify({
    version: 'task-verification-evidence.v1',
    outcome: log.outcome,
    checks: log.checks.map((check) => ({
      checkId: check.checkId,
      status: check.status,
      ...(check.exitCode === undefined ? {} : { exitCode: check.exitCode }),
    })),
  }), 'utf8')
  return {
    artifactId,
    contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}` as Sha256Digest,
    kind: 'VERIFICATION_EVIDENCE',
    mediaType: 'application/vnd.xiaogui.qa-evidence+json',
    content,
  }
}

function taskVerificationEvidenceArtifactId(
  request: FrozenTaskVerificationRequestV1,
  inspectionArtifactId: ArtifactId,
): ArtifactId {
  const digest = createHash('sha256').update(JSON.stringify({
    scope: 'TASK',
    verificationAttemptId: request.verificationAttemptId,
    requestDigest: request.requestDigest,
    inspectionArtifactId,
  })).digest('hex')
  return `xhbart_${digest}` as ArtifactId
}

function resultMatchesRequest(
  result: TaskVerificationExecutionResultV1,
  request: FrozenTaskVerificationRequestV1,
  scopeEvidenceArtifactId: ArtifactId,
  inspectionArtifactId: ArtifactId,
): boolean {
  const receipt = result?.receipt
  if (!receipt || typeof receipt !== 'object') return false
  if (
    receipt.scope !== 'TASK' ||
    receipt.verificationAttemptId !== request.verificationAttemptId ||
    receipt.verificationRequestId !== request.verificationRequestId ||
    receipt.flowId !== request.flowId ||
    receipt.requestDigest !== request.requestDigest ||
    receipt.changeSetDigest !== request.changeSetDigest ||
    receipt.qaConfigVersion !== request.qaConfigVersion ||
    receipt.taskRunId !== request.taskRunId ||
    receipt.attemptId !== request.attemptId ||
    receipt.candidateId !== request.candidateId ||
    !['PASS', 'FAIL', 'OUTCOME_UNKNOWN'].includes(receipt.verdict)
  ) return false
  if (!Array.isArray(result.artifacts)) return false
  const artifactById = new Map(result.artifacts.map((artifact) => [artifact.artifactId, artifact]))
  if (artifactById.size !== result.artifacts.length) return false
  const diagnostic = artifactById.get(inspectionArtifactId)
  if (diagnostic?.kind !== 'VERIFICATION_DIAGNOSTIC' || !ArrayBuffer.isView(diagnostic.content)) return false
  if (receipt.verdict === 'PASS' || receipt.verdict === 'FAIL') {
    if (
      receipt.evidenceArtifactIds.length !== 2 ||
      receipt.evidenceArtifactIds[0] !== scopeEvidenceArtifactId
    ) return false
    const evidence = artifactById.get(receipt.evidenceArtifactIds[1])
    return result.artifacts.length === 2 &&
      receipt.diagnosticArtifactIds.length === 1 &&
      receipt.diagnosticArtifactIds[0] === inspectionArtifactId &&
      evidence?.kind === 'VERIFICATION_EVIDENCE' &&
      ArrayBuffer.isView(evidence.content)
  }
  return result.artifacts.length === 1 &&
    receipt.diagnosticArtifactIds.length === 1 &&
    receipt.diagnosticArtifactIds[0] === inspectionArtifactId
}

function emptyProcessFailure(status: 'TIMED_OUT' | 'SPAWN_FAILED'): VerificationProcessResultV1 {
  return {
    status,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    outputTruncated: false,
  }
}

function checkLabel(checkId: InspectionCheckV1['checkId']): string {
  if (checkId === 'typescript.web') return '界面 TypeScript 检查'
  if (checkId === 'typescript.node') return '主进程 TypeScript 检查'
  if (checkId === 'work.report-docx') return '工作报告 DOCX 产物校验'
  return '设计项目结果校验'
}
