import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants } from 'node:fs'
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

type VerificationProcessCompletionV1 =
  | { readonly status: 'EXITED'; readonly exitCode: number }
  | { readonly status: 'TIMED_OUT' | 'SPAWN_FAILED' }

export type TaskVerificationScriptV1 = (
  request: FrozenTaskVerificationRequestV1,
  executionContext: Readonly<TaskVerificationExecutionContextV1>,
) => TaskVerificationExecutionResultV1 | Promise<TaskVerificationExecutionResultV1>

interface InspectionCheckV1 {
  checkId: 'typescript.web' | 'typescript.node'
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
  constructor(private readonly runner: VerificationProcessRunnerV1 = new NodeVerificationProcessRunnerV1()) {}

  async verify(
    request: FrozenTaskVerificationRequestV1,
    executionContext: Readonly<TaskVerificationExecutionContextV1>,
  ): Promise<TaskVerificationExecutionResultV1> {
    const invalidCode = validateInvocation(request, executionContext)
    if (invalidCode) return unknownResult(request, executionContext, invalidCode, [])

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
): TaskVerificationExecutionResultV1 {
  const log = {
    version: 'task-verification-inspection.v1',
    outcome: 'PASS',
    safeCode: 'TYPECHECKS_PASSED',
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
    reason: 'FIXED_TYPECHECK_FAILED',
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
  return checkId === 'typescript.web' ? '界面 TypeScript 检查' : '主进程 TypeScript 检查'
}
