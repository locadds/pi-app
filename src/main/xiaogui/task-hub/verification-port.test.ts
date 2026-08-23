import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type {
  AttemptId,
  FlowId,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import type {
  ArtifactId,
  Sha256Digest,
  TaskChangeSetCandidateId,
  TaskVerificationRequestV1,
  VerificationAttemptId,
} from '@shared/xiaogui-task-verification'
import {
  FixedTypecheckVerificationPortV1,
  ScriptedTaskVerificationPortV1,
  type FrozenTaskVerificationRequestV1,
  type TaskVerificationExecutionContextV1,
  type TaskVerificationExecutionPortV1,
  type VerificationProcessInvocationV1,
  type VerificationProcessResultV1,
  type VerificationProcessRunnerV1,
  type VerificationDependencyLinkPortV1,
} from './verification-port'

function request(): FrozenTaskVerificationRequestV1 {
  return Object.freeze({
    verificationAttemptId: 'verification-attempt-1' as VerificationAttemptId,
    verificationRequestId: 'verification-request-1',
    flowId: 'flow-1' as FlowId,
    requestDigest: sha('1'),
    changeSetDigest: sha('2'),
    preparedTreeHash: sha('3'),
    qaConfigVersion: 'task-fixed-typecheck.v1',
    acceptanceCriteria: Object.freeze(['类型检查通过']),
    scope: 'TASK',
    taskRunId: 'task-run-1' as TaskRunId,
    attemptId: 'attempt-1' as AttemptId,
    candidateId: 'candidate-1' as TaskChangeSetCandidateId,
  } satisfies TaskVerificationRequestV1)
}

function executionContext(): Readonly<TaskVerificationExecutionContextV1> {
  return Object.freeze({
    worktreeRoot: path.resolve('private-attempt-worktree'),
    trustedToolchainRoot: path.resolve('private-source-installation'),
    scopeEvidenceArtifactId: 'artifact-workspace-scope-evidence-1' as ArtifactId,
    inspectionArtifactId: 'artifact-verification-inspection-1' as ArtifactId,
  })
}

function exited(exitCode: number, stdout = '', stderr = ''): VerificationProcessResultV1 {
  return {
    status: 'EXITED',
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    outputTruncated: false,
  }
}

function processFailure(status: 'TIMED_OUT' | 'SPAWN_FAILED'): VerificationProcessResultV1 {
  return {
    status,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    outputTruncated: false,
  }
}

class RecordingRunner implements VerificationProcessRunnerV1 {
  readonly invocations: VerificationProcessInvocationV1[] = []

  constructor(private readonly results: readonly VerificationProcessResultV1[]) {}

  async run(invocation: VerificationProcessInvocationV1): Promise<VerificationProcessResultV1> {
    this.invocations.push(invocation)
    return this.results[this.invocations.length - 1] ?? processFailure('SPAWN_FAILED')
  }
}

class StubDependencyLinks implements VerificationDependencyLinkPortV1 {
  acquire() {
    return { release: () => 'RELEASED' as const }
  }
}

function fixedPort(runner: VerificationProcessRunnerV1): FixedTypecheckVerificationPortV1 {
  return new FixedTypecheckVerificationPortV1(runner, new StubDependencyLinks())
}

function compileTimeRejectsFreeCommand(
  port: TaskVerificationExecutionPortV1,
  frozenRequest: FrozenTaskVerificationRequestV1,
  context: Readonly<TaskVerificationExecutionContextV1>,
): void {
  if (false) {
    // @ts-expect-error Verification requests have no arbitrary command input.
    void port.verify({ ...frozenRequest, command: 'calc.exe' }, context)
    // @ts-expect-error Verification requests have no arbitrary process arguments.
    void port.verify({ ...frozenRequest, args: ['--arbitrary'] }, context)
  }
}

describe('TASK fixed verification port', () => {
  it('runs exactly the two fixed typechecks and returns a strict PASS receipt plus private logs', async () => {
    const runner = new RecordingRunner([
      exited(0, 'web typecheck passed'),
      exited(0, 'node typecheck passed'),
    ])
    const port = fixedPort(runner)
    const frozenRequest = request()
    const context = executionContext()

    compileTimeRejectsFreeCommand(port, frozenRequest, context)
    const result = await port.verify(frozenRequest, context)

    expect(runner.invocations).toHaveLength(2)
    expect(runner.invocations.map((invocation) => ({
      args: invocation.args,
      cwd: invocation.cwd,
      shell: invocation.shell,
      timeoutMs: invocation.timeoutMs,
      maxOutputBytes: invocation.maxOutputBytes,
    }))).toEqual([
      {
        args: ['--project', path.join(context.worktreeRoot, 'tsconfig.web.json'), '--noEmit'],
        cwd: context.worktreeRoot,
        shell: false,
        timeoutMs: 120_000,
        maxOutputBytes: 256 * 1024,
      },
      {
        args: ['--project', path.join(context.worktreeRoot, 'tsconfig.node.json'), '--noEmit'],
        cwd: context.worktreeRoot,
        shell: false,
        timeoutMs: 120_000,
        maxOutputBytes: 256 * 1024,
      },
    ])
    expect(runner.invocations[0]?.executable).toBe(path.join(
      context.trustedToolchainRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
    ))
    expect(result.receipt).toMatchObject({
      verdict: 'PASS',
      scope: 'TASK',
      verificationAttemptId: frozenRequest.verificationAttemptId,
      taskRunId: frozenRequest.taskRunId,
      attemptId: frozenRequest.attemptId,
      candidateId: frozenRequest.candidateId,
      checks: [
        { checkId: 'workspace.scope', verdict: 'PASS' },
        { checkId: 'typescript.web', verdict: 'PASS' },
        { checkId: 'typescript.node', verdict: 'PASS' },
      ],
      diagnosticArtifactIds: [context.inspectionArtifactId],
    })
    expect(result.artifacts).toHaveLength(2)
    const diagnosticArtifact = result.artifacts.find((artifact) => artifact.kind === 'VERIFICATION_DIAGNOSTIC')!
    const evidenceArtifact = result.artifacts.find((artifact) => artifact.kind === 'VERIFICATION_EVIDENCE')!
    expect(diagnosticArtifact.artifactId).toBe(context.inspectionArtifactId)
    expect(result.receipt.verdict === 'PASS' && result.receipt.evidenceArtifactIds).toEqual([
      context.scopeEvidenceArtifactId,
      evidenceArtifact.artifactId,
    ])
    expect(result.receipt.verdict === 'PASS' && result.receipt.checks).toEqual([
      expect.objectContaining({
        checkId: 'workspace.scope',
        artifactIds: [context.scopeEvidenceArtifactId],
        verdict: 'PASS',
      }),
      expect.objectContaining({
        checkId: 'typescript.web',
        artifactIds: [evidenceArtifact.artifactId],
        verdict: 'PASS',
      }),
      expect.objectContaining({
        checkId: 'typescript.node',
        artifactIds: [evidenceArtifact.artifactId],
        verdict: 'PASS',
      }),
    ])
    expect(result.artifacts.some((artifact) => artifact.artifactId === context.scopeEvidenceArtifactId)).toBe(false)
    for (const artifact of result.artifacts) {
      expect(artifact.contentDigest).toBe(`sha256:${createHash('sha256').update(artifact.content).digest('hex')}`)
    }
    expect(Buffer.from(diagnosticArtifact.content).toString('utf8')).toContain('web typecheck passed')
    expect(Buffer.from(evidenceArtifact.content).toString('utf8')).not.toContain('web typecheck passed')

    const publicReceipt = JSON.stringify(result.receipt)
    expect(publicReceipt).not.toContain(context.worktreeRoot)
    expect(publicReceipt).not.toContain(context.trustedToolchainRoot)
    expect(publicReceipt).not.toContain('web typecheck passed')

    const scripted = new ScriptedTaskVerificationPortV1(vi.fn(async () => result))
    await expect(scripted.verify(frozenRequest, context)).resolves.toEqual(result)
  })

  it('returns typed FAIL with the failed check first and does not run beyond it', async () => {
    const runner = new RecordingRunner([
      exited(0, 'web passed'),
      exited(2, '', 'node type error at a private path'),
    ])
    const port = fixedPort(runner)

    const result = await port.verify(request(), executionContext())

    expect(runner.invocations).toHaveLength(2)
    expect(result.receipt).toMatchObject({
      verdict: 'FAIL',
      checks: [
        { checkId: 'typescript.node', verdict: 'FAIL' },
        { checkId: 'workspace.scope', verdict: 'PASS' },
        { checkId: 'typescript.web', verdict: 'PASS' },
      ],
      failure: {
        source: 'QA_CHECKS_FAILED',
        failureClass: 'TEST_FAILURE',
        disposition: 'REQUIRE_HUMAN_GATE',
        retryOrdinal: 0,
        safeCode: 'QA_CHECK_FAILED',
      },
      reason: 'FIXED_TYPECHECK_FAILED',
    })
    expect(JSON.stringify(result.receipt)).not.toContain('node type error at a private path')
    const diagnosticArtifact = result.artifacts.find((artifact) => artifact.kind === 'VERIFICATION_DIAGNOSTIC')!
    expect(Buffer.from(diagnosticArtifact.content).toString('utf8')).toContain('node type error at a private path')
  })

  it('returns OUTCOME_UNKNOWN without PASS or FAIL fields when the fixed process times out', async () => {
    const runner = new RecordingRunner([processFailure('TIMED_OUT')])
    const port = fixedPort(runner)

    const result = await port.verify(request(), executionContext())

    expect(runner.invocations).toHaveLength(1)
    expect(result.receipt).toMatchObject({
      verdict: 'OUTCOME_UNKNOWN',
      reason: 'VERIFICATION_PROCESS_TIMEOUT',
    })
    expect('checks' in result.receipt).toBe(false)
    expect('evidenceArtifactIds' in result.receipt).toBe(false)
    expect('failure' in result.receipt).toBe(false)
  })

  it('maps a missing toolchain to OUTCOME_UNKNOWN instead of throwing', async () => {
    const port = new FixedTypecheckVerificationPortV1()
    const missingToolchainContext = Object.freeze({
      ...executionContext(),
      trustedToolchainRoot: path.resolve('definitely-missing-task-verification-toolchain'),
    })

    await expect(port.verify(request(), missingToolchainContext)).resolves.toMatchObject({
      receipt: {
        verdict: 'OUTCOME_UNKNOWN',
        reason: 'VERIFICATION_TOOLCHAIN_UNAVAILABLE',
      },
    })
  })

  it('links trusted dependencies only while checks run and refuses a pre-existing path', async () => {
    const testRoot = mkdtempSync(path.join(tmpdir(), 'xiaogui-verification-'))
    const worktreeRoot = path.join(testRoot, 'attempt')
    const trustedToolchainRoot = path.join(testRoot, 'trusted')
    const trustedNodeModules = path.join(trustedToolchainRoot, 'node_modules')
    const candidateNodeModules = path.join(worktreeRoot, 'node_modules')
    mkdirSync(worktreeRoot, { recursive: true })
    mkdirSync(trustedNodeModules, { recursive: true })
    const runner = new RecordingRunner([exited(0), exited(0)])
    const observingRunner: VerificationProcessRunnerV1 = {
      run: async (invocation) => {
        expect(lstatSync(candidateNodeModules).isSymbolicLink()).toBe(true)
        expect(realpathSync(candidateNodeModules)).toBe(realpathSync(trustedNodeModules))
        return runner.run(invocation)
      },
    }
    const port = new FixedTypecheckVerificationPortV1(observingRunner)
    const context = Object.freeze({
      ...executionContext(),
      worktreeRoot,
      trustedToolchainRoot,
    })

    try {
      const result = await port.verify(request(), context)

      expect(result.receipt.verdict).toBe('PASS')
      expect(runner.invocations).toHaveLength(2)
      expect(existsSync(candidateNodeModules)).toBe(false)

      mkdirSync(candidateNodeModules)
      const blocked = await port.verify(request(), context)
      expect(blocked.receipt).toMatchObject({
        verdict: 'OUTCOME_UNKNOWN',
        reason: 'VERIFICATION_TOOLCHAIN_UNAVAILABLE',
      })
      expect(runner.invocations).toHaveLength(2)
    } finally {
      rmSync(testRoot, { force: true, recursive: true })
    }
  })

  it('rejects runtime-smuggled process controls before the runner is called', async () => {
    const runner = new RecordingRunner([exited(0), exited(0)])
    const port = fixedPort(runner)
    const injectedRequest = Object.freeze({
      ...request(),
      command: 'calc.exe',
      args: ['/arbitrary'],
      cwd: path.resolve('untrusted'),
      env: { LEAK: '1' },
    }) as unknown as FrozenTaskVerificationRequestV1

    const result = await port.verify(injectedRequest, executionContext())

    expect(runner.invocations).toHaveLength(0)
    expect(result.receipt).toMatchObject({
      verdict: 'OUTCOME_UNKNOWN',
      reason: 'VERIFICATION_EXECUTION_CONTROL_REJECTED',
    })
  })
})

function sha(character: string): Sha256Digest {
  return `sha256:${character.repeat(64)}` as Sha256Digest
}
