import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AttemptId, FlowId, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import type {
  ArtifactId,
  Sha256Digest,
  TaskChangeSetCandidateId,
  TaskVerificationRequestV1,
  VerificationAttemptId,
} from '@shared/xiaogui-task-verification'
import type { WorkReportDraftV1 } from '@shared/xiaogui-work-report-docx'

import { renderWorkReportArtifactV1 } from '../work-report-docx-service'
import {
  ModeTaskVerificationPortV1,
  type FrozenTaskVerificationRequestV1,
  type ModeTaskVerificationArtifactV1,
  type ModeTaskVerificationModeV1,
  type TaskVerificationExecutionContextV1,
  type TaskVerificationExecutionPortV1,
} from './verification-port'

const TEST_ROOT = 'E:\\XiaoguiInternalCandidate\\hub-runtime-01-pi-20260910'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

describe('ModeTaskVerificationPortV1', () => {
  it('verifies a real rendered WORK DOCX without invoking the coding verifier', async () => {
    const root = tempRoot('work-')
    const artifact = await renderWorkReportArtifactV1(workReportDraft())
    const relativePath = 'artifacts/report.docx'
    mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true })
    writeFileSync(path.join(root, relativePath), artifact.content)
    const codePort = neverCodePort()
    const port = new ModeTaskVerificationPortV1(codePort, async () => resolution('WORK', [
      artifactDescriptor(relativePath, artifact.content, 'WORK_REPORT_DOCX'),
    ], true))

    const result = await port.verify(request(), context(root, [relativePath]))

    expect(result.receipt).toMatchObject({
      verdict: 'PASS',
      checks: [
        { checkId: 'workspace.scope', verdict: 'PASS' },
        { checkId: 'work.report-docx', verdict: 'PASS' },
      ],
      diagnosticArtifactIds: [INSPECTION_ARTIFACT_ID],
    })
    expect(codePort.verify).not.toHaveBeenCalled()
    expect(readFileSync(path.join(root, relativePath))).toEqual(artifact.content)
    expect(result.artifacts.every((entry) => (
      entry.contentDigest === sha256(entry.content)
    ))).toBe(true)
  })

  it('verifies a safe DESIGN overview summary without running fixed TypeScript checks', async () => {
    const root = tempRoot('design-')
    const summary = {
      kind: 'DESIGN_PROJECT_OVERVIEW_V1',
      status: 'ok',
      source_version: 'fixture-design-v1',
      trace_id: 'trace-fixture-1',
      sources: [{ path: 'inputs/scene.json', sha256: sha('a') }],
    }
    const bytes = Buffer.from(`${JSON.stringify(summary)}\n`, 'utf8')
    const relativePath = 'artifacts/design-result.json'
    mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true })
    writeFileSync(path.join(root, relativePath), bytes)
    const codePort = neverCodePort()
    const port = new ModeTaskVerificationPortV1(codePort, async () => resolution('DESIGN', [
      artifactDescriptor(relativePath, bytes, 'DESIGN_PROJECT_RESULT'),
    ], true))

    const result = await port.verify(request(), context(root, [relativePath]))

    expect(result.receipt).toMatchObject({
      verdict: 'PASS',
      checks: [
        { checkId: 'workspace.scope', verdict: 'PASS' },
        { checkId: 'design.project', verdict: 'PASS' },
      ],
    })
    expect(codePort.verify).not.toHaveBeenCalled()
  })

  it.each([
    ['digest mismatch', 'artifacts/report.docx', 'sha256:' + '0'.repeat(64), true],
    ['required artifact missing', 'artifacts/missing.docx', sha('a'), true],
    ['parent traversal', '../report.docx', sha('a'), true],
    ['absolute path', path.resolve('report.docx'), sha('a'), true],
    ['git metadata path', '.git/config', sha('a'), true],
  ])('returns ARTIFACT_VERIFICATION_FAILED for %s', async (_label, relativePath, expectedDigest, requireAll) => {
    const root = tempRoot('invalid-')
    const artifact = await renderWorkReportArtifactV1(workReportDraft())
    const safePath = 'artifacts/report.docx'
    mkdirSync(path.dirname(path.join(root, safePath)), { recursive: true })
    writeFileSync(path.join(root, safePath), artifact.content)
    const codePort = neverCodePort()
    const descriptor: ModeTaskVerificationArtifactV1 = {
      path: relativePath,
      sha256: expectedDigest,
      kind: 'WORK_REPORT_DOCX',
    }
    const port = new ModeTaskVerificationPortV1(codePort, async () => resolution('WORK', [descriptor], requireAll))

    const result = await port.verify(request(), context(root))

    expect(result.receipt).toMatchObject({
      verdict: 'FAIL',
      reason: 'ARTIFACT_VERIFICATION_FAILED',
      checks: expect.arrayContaining([
        expect.objectContaining({ checkId: 'work.report-docx', verdict: 'FAIL' }),
      ]),
    })
    expect(codePort.verify).not.toHaveBeenCalled()
  })

  it('rejects a hard-linked artifact and a design summary containing private paths', async () => {
    const root = tempRoot('unsafe-')
    const artifact = await renderWorkReportArtifactV1(workReportDraft())
    const sourcePath = path.join(root, 'source.docx')
    const hardLinkPath = path.join(root, 'hard-link.docx')
    writeFileSync(sourcePath, artifact.content)
    linkSync(sourcePath, hardLinkPath)
    const codePort = neverCodePort()
    const hardLinkPort = new ModeTaskVerificationPortV1(codePort, async () => resolution('WORK', [
      artifactDescriptor('hard-link.docx', artifact.content, 'WORK_REPORT_DOCX'),
    ], true))

    await expect(hardLinkPort.verify(request(), context(root, ['hard-link.docx']))).resolves.toMatchObject({
      receipt: { verdict: 'FAIL', reason: 'ARTIFACT_VERIFICATION_FAILED' },
    })

    const privateSummary = Buffer.from(JSON.stringify({
      kind: 'DESIGN_PROJECT_OVERVIEW_V1',
      status: 'ok',
      source_version: 'fixture-design-v1',
      trace_id: 'trace-fixture-private',
      root: 'C:\\private\\project',
      sources: [{ path: 'inputs/scene.json', sha256: sha('b') }],
    }), 'utf8')
    const summaryPath = 'design-result.json'
    writeFileSync(path.join(root, summaryPath), privateSummary)
    const designPort = new ModeTaskVerificationPortV1(codePort, async () => resolution('DESIGN', [
      artifactDescriptor(summaryPath, privateSummary, 'DESIGN_PROJECT_RESULT'),
    ], true))

    await expect(designPort.verify(request(), context(root, [summaryPath]))).resolves.toMatchObject({
      receipt: { verdict: 'FAIL', reason: 'ARTIFACT_VERIFICATION_FAILED' },
    })
    expect(codePort.verify).not.toHaveBeenCalled()
  })

  it('allows partial artifact lists only when at least one safe artifact verifies', async () => {
    const root = tempRoot('partial-')
    const artifact = await renderWorkReportArtifactV1(workReportDraft())
    const relativePath = 'report.docx'
    writeFileSync(path.join(root, relativePath), artifact.content)
    const codePort = neverCodePort()
    const port = new ModeTaskVerificationPortV1(codePort, async () => resolution('WORK', [
      { path: 'missing.docx', sha256: sha('c'), kind: 'WORK_REPORT_DOCX' },
      artifactDescriptor(relativePath, artifact.content, 'WORK_REPORT_DOCX'),
    ], false))

    await expect(port.verify(request(), context(root, ['missing.docx', relativePath]))).resolves.toMatchObject({ receipt: { verdict: 'PASS' } })
    expect(codePort.verify).not.toHaveBeenCalled()
  })

  it('keeps CODING on the supplied fixed verifier and fails closed on resolver uncertainty', async () => {
    const codingCodePort: TaskVerificationExecutionPortV1 = {
      verify: vi.fn(async () => {
        throw new Error('CODE_PORT_DELEGATED')
      }),
    }
    const codingPort = new ModeTaskVerificationPortV1(codingCodePort, async () => resolution('CODING', [], false))
    await expect(codingPort.verify(request(), context(tempRoot('coding-')))).rejects.toThrow('CODE_PORT_DELEGATED')
    expect(codingCodePort.verify).toHaveBeenCalledOnce()

    const unknownCodePort = neverCodePort()
    const unknownPort = new ModeTaskVerificationPortV1(unknownCodePort, async () => null)
    await expect(unknownPort.verify(request(), context(tempRoot('unknown-')))).resolves.toMatchObject({
      receipt: { verdict: 'OUTCOME_UNKNOWN', reason: 'ARTIFACT_RESOLUTION_UNKNOWN' },
    })
    expect(unknownCodePort.verify).not.toHaveBeenCalled()
  })
})

const INSPECTION_ARTIFACT_ID = 'inspection-mode-artifact' as ArtifactId
const SCOPE_ARTIFACT_ID = 'scope-mode-artifact' as ArtifactId

function workReportDraft(): WorkReportDraftV1 {
  return {
    title: '模式验证报告',
    sections: [{ heading: '结果', paragraphs: ['真实 DOCX'], bullets: ['安全结构'] }],
  }
}

function neverCodePort(): TaskVerificationExecutionPortV1 & { verify: ReturnType<typeof vi.fn> } {
  return {
    verify: vi.fn(async () => {
      throw new Error('CODE_PORT_MUST_NOT_RUN')
    }),
  }
}

function request(): FrozenTaskVerificationRequestV1 {
  return Object.freeze({
    verificationAttemptId: 'verification-mode-1' as VerificationAttemptId,
    verificationRequestId: 'verification-request-mode-1',
    flowId: 'flow-mode-1' as FlowId,
    requestDigest: sha('1'),
    changeSetDigest: sha('2'),
    preparedTreeHash: sha('3'),
    qaConfigVersion: 'task-mode-artifact.v1',
    acceptanceCriteria: Object.freeze(['产物结构与证据通过']),
    scope: 'TASK',
    taskRunId: 'task-mode-1' as TaskRunId,
    attemptId: 'attempt-mode-1' as AttemptId,
    candidateId: 'candidate-mode-1' as TaskChangeSetCandidateId,
  } satisfies TaskVerificationRequestV1)
}

function context(
  root: string,
  artifactPaths?: readonly string[],
): Readonly<TaskVerificationExecutionContextV1> {
  return Object.freeze({
    worktreeRoot: root,
    trustedToolchainRoot: path.join(root, 'trusted-toolchain'),
    scopeEvidenceArtifactId: SCOPE_ARTIFACT_ID,
    inspectionArtifactId: INSPECTION_ARTIFACT_ID,
    ...(artifactPaths === undefined
      ? {}
      : {
          verificationScope: 'TASK' as const,
          artifactPaths: Object.freeze([...artifactPaths]),
        }),
  })
}

function resolution(
  mode: ModeTaskVerificationModeV1,
  artifacts: readonly ModeTaskVerificationArtifactV1[],
  requireAll: boolean,
) {
  return { mode, artifacts, requireAll }
}

function artifactDescriptor(
  artifactPath: string,
  content: Uint8Array,
  kind: ModeTaskVerificationArtifactV1['kind'],
): ModeTaskVerificationArtifactV1 {
  return { path: artifactPath, sha256: sha256(content), kind }
}

function tempRoot(prefix: string): string {
  mkdirSync(TEST_ROOT, { recursive: true })
  const root = mkdtempSync(path.join(TEST_ROOT, `mode-artifact-${prefix}`))
  roots.push(root)
  return root
}

function sha(character: string): Sha256Digest {
  return `sha256:${character.repeat(64)}` as Sha256Digest
}

function sha256(content: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(content).digest('hex')}` as Sha256Digest
}
