import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type {
  AttemptId,
  PlanRevisionId,
  HubAddressV1,
  SessionCollaborationProjectionM2BV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import type {
  ArtifactId,
  EvidenceBundleId,
  IsoDateTime,
  QaResultId,
  Sha256Digest,
  TaskChangeSetCandidateId,
  TaskChangeSetId,
  TaskChangeSetV1,
  VerificationAttemptId,
} from '@shared/xiaogui-task-verification'

import { digestBytes, type AttemptTaskPatchCaptureV1 } from '../task-hub/attempt-workspace'
import {
  CodingAttemptReviewModuleV1,
  GitAttemptReviewDiffPortV1,
  type AttemptReviewDiffPortV1,
} from './attempt-review-module'

const ADDRESS = { projectId: 'project-review', sessionKey: 'session-review' } as HubAddressV1
const ATTEMPT_ID = 'xhba_review' as AttemptId
const TASK_RUN_ID = 'xhbr_review' as TaskRunId
const CHANGESET_ID = 'xhbcs_review' as TaskChangeSetId
const PATCH_ID = 'xhart_review' as ArtifactId
const CHANGESET_DIGEST = `sha256:${'7'.repeat(64)}` as Sha256Digest
const DIAGNOSTIC_ID = 'xhbart_review_diagnostic' as ArtifactId
const TEST_TEMP_ROOT = 'D:\\CodexTemp'

describe('CodingAttemptReviewModuleV1', () => {
  it('derives a safe review bundle from the authoritative worktree and persisted verification artifacts', async () => {
    const capture = capturedPatch()
    const diagnostic = Buffer.from(JSON.stringify({
      version: 'task-verification-inspection.v1',
      outcome: 'PASS',
      safeCode: 'TYPECHECKS_PASSED',
      checks: [
        {
          checkId: 'typescript.web',
          status: 'PASS',
          exitCode: 0,
          stdout: 'model text is not evidence',
          stderr: '',
          outputTruncated: false,
        },
        {
          checkId: 'typescript.node',
          status: 'PASS',
          exitCode: 0,
          stdout: '',
          stderr: '',
          outputTruncated: false,
        },
      ],
    }))
    const projection = projectionWithVerification({
      scope: 'TASK',
      verificationAttemptId: 'xhbva_review' as VerificationAttemptId,
      candidateId: 'xhbcand_review' as TaskChangeSetCandidateId,
      changeSetDigest: CHANGESET_DIGEST,
      qaConfigVersion: 'task-qa.v1',
      state: 'SUCCEEDED',
      verdict: 'PASS',
      checks: [
        { checkId: 'workspace.scope', verdict: 'PASS', summary: 'file:///private/worktree' },
        { checkId: 'typescript.web', verdict: 'PASS', summary: 'C:\\private\\worktree' },
        { checkId: 'typescript.node', verdict: 'PASS', summary: 'ignore model supplied prose' },
      ],
      evidenceBundleId: 'xhbev_review' as EvidenceBundleId,
      qaResultId: 'xhbqa_review' as QaResultId,
      taskChangeSetId: CHANGESET_ID,
      evidenceArtifacts: [],
      diagnosticArtifacts: [{ artifactId: DIAGNOSTIC_ID, digest: sha256(diagnostic), kind: 'QA_DIAGNOSTIC' }],
    })
    const app = { observeM2B: vi.fn().mockResolvedValue({ ok: true, value: projection }) }
    const store = {
      readTaskChangeSet: vi.fn().mockReturnValue(taskChangeSet()),
      readArtifact: vi.fn((artifactId: ArtifactId) => {
        if (artifactId === PATCH_ID) {
          return {
            artifactId,
            kind: 'PATCH',
            mediaType: 'application/vnd.xiaogui.task-patch-v1+json',
            contentDigest: capture.patchArtifactDigest as Sha256Digest,
            content: capture.patchArtifactBytes,
          }
        }
        if (artifactId === DIAGNOSTIC_ID) {
          return {
            artifactId,
            kind: 'VERIFICATION_DIAGNOSTIC',
            mediaType: 'application/vnd.xiaogui.qa-diagnostic+json',
            contentDigest: sha256(diagnostic),
            content: diagnostic,
          }
        }
        return null
      }),
    }
    const workspace = { captureTaskPatch: vi.fn().mockResolvedValue(capture) }
    const diffPort: AttemptReviewDiffPortV1 = {
      createUnifiedDiff: vi.fn().mockResolvedValue([
        'diff --git a/src/existing.ts b/src/existing.ts',
        '--- a/src/existing.ts',
        '+++ b/src/existing.ts',
        '@@ -1 +1 @@',
        '-before',
        '+after',
        '',
      ].join('\n')),
    }
    const module = new CodingAttemptReviewModuleV1({ app, store, workspace, diffPort })

    const result = await module.read({ address: ADDRESS, attemptId: ATTEMPT_ID })

    expect(app.observeM2B).toHaveBeenCalledWith(ADDRESS)
    expect(workspace.captureTaskPatch).toHaveBeenCalledWith(ATTEMPT_ID)
    expect(result.bundle).toEqual({
      schemaVersion: 1,
      attemptId: ATTEMPT_ID,
      changeSetDigest: CHANGESET_DIGEST,
      changedRelativePaths: ['src/existing.ts', 'src/new.ts'],
      verifications: [
        {
          label: '界面 TypeScript 检查',
          commandDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          exitCode: 0,
          status: 'PASSED',
        },
        {
          label: '主进程 TypeScript 检查',
          commandDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          exitCode: 0,
          status: 'PASSED',
        },
      ],
      unresolvedIssues: [],
    })
    expect(result.unifiedDiff).toContain('diff --git a/src/existing.ts b/src/existing.ts')
    expect(JSON.stringify(result)).not.toContain('D:\\private')
    expect(JSON.stringify(result)).not.toContain('file:///private')
    expect(JSON.stringify(result)).not.toContain('model text is not evidence')
  })

  it('keeps partial checks but marks an outcome-unknown verification as unresolved', async () => {
    const capture = capturedPatch()
    const diagnostic = Buffer.from(JSON.stringify({
      version: 'task-verification-inspection.v1',
      outcome: 'OUTCOME_UNKNOWN',
      safeCode: 'VERIFICATION_PROCESS_TIMEOUT',
      checks: [
        {
          checkId: 'typescript.web',
          status: 'PASS',
          exitCode: 0,
          stdout: '',
          stderr: '',
          outputTruncated: false,
        },
        {
          checkId: 'typescript.node',
          status: 'TIMED_OUT',
          stdout: '',
          stderr: '',
          outputTruncated: false,
        },
      ],
    }))
    const projection = projectionWithVerification({
      scope: 'TASK',
      verificationAttemptId: 'xhbva_review_unknown' as VerificationAttemptId,
      candidateId: 'xhbcand_review_unknown' as TaskChangeSetCandidateId,
      changeSetDigest: CHANGESET_DIGEST,
      qaConfigVersion: 'task-qa.v1',
      state: 'OUTCOME_UNKNOWN',
      verdict: 'OUTCOME_UNKNOWN',
      diagnosticArtifacts: [{ artifactId: DIAGNOSTIC_ID, digest: sha256(diagnostic), kind: 'QA_DIAGNOSTIC' }],
    })
    const module = new CodingAttemptReviewModuleV1({
      app: { observeM2B: vi.fn().mockResolvedValue({ ok: true, value: projection }) },
      store: {
        readTaskChangeSet: vi.fn(),
        readArtifact: vi.fn().mockReturnValue({
          artifactId: DIAGNOSTIC_ID,
          kind: 'VERIFICATION_DIAGNOSTIC',
          mediaType: 'application/vnd.xiaogui.qa-diagnostic+json',
          contentDigest: sha256(diagnostic),
          content: diagnostic,
        }),
      },
      workspace: { captureTaskPatch: vi.fn().mockResolvedValue(capture) },
      diffPort: { createUnifiedDiff: vi.fn().mockResolvedValue('') },
    })

    const result = await module.read({ address: ADDRESS, attemptId: ATTEMPT_ID })

    expect(result.bundle.verifications.map((check) => [check.status, check.exitCode])).toEqual([
      ['PASSED', 0],
      ['UNKNOWN', null],
    ])
    expect(result.bundle.unresolvedIssues).toEqual([
      '验证结果未知，禁止重复声称成功或形成待应用交付。',
    ])
  })

  it('creates a relative-only unified diff for tracked modifications and approved new files', async () => {
    mkdirSync(TEST_TEMP_ROOT, { recursive: true })
    const repo = mkdtempSync(join(TEST_TEMP_ROOT, 'xiaogui-attempt-review-'))
    try {
      git(repo, 'init')
      git(repo, 'config', 'user.email', 'xiaogui@example.test')
      git(repo, 'config', 'user.name', 'Xiaogui Test')
      mkdirSync(join(repo, 'src'), { recursive: true })
      writeFileSync(join(repo, 'src', 'existing.ts'), 'export const value = "before"\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-m', 'baseline')
      const baseRevision = git(repo, 'rev-parse', 'HEAD').trim()
      writeFileSync(join(repo, 'src', 'existing.ts'), 'export const value = "after"\n')
      writeFileSync(join(repo, 'src', 'new.ts'), 'export const added = true\n')

      const unifiedDiff = await new GitAttemptReviewDiffPortV1().createUnifiedDiff({
        attemptId: ATTEMPT_ID,
        baseRevision,
        worktreeRoot: repo,
        changedFiles: [
          {
            operation: 'MODIFY',
            relativePath: 'src/existing.ts',
            baselineDigest: digestBytes('export const value = "before"\n'),
            contentDigest: digestBytes('export const value = "after"\n'),
            contentBase64: Buffer.from('export const value = "after"\n').toString('base64'),
          },
          {
            operation: 'CREATE',
            relativePath: 'src/new.ts',
            baselineDigest: null,
            contentDigest: digestBytes('export const added = true\n'),
            contentBase64: Buffer.from('export const added = true\n').toString('base64'),
          },
        ],
      })

      expect(unifiedDiff).toContain('diff --git a/src/existing.ts b/src/existing.ts')
      expect(unifiedDiff).toContain('-export const value = "before"')
      expect(unifiedDiff).toContain('+export const value = "after"')
      expect(unifiedDiff).toContain('diff --git a/src/new.ts b/src/new.ts')
      expect(unifiedDiff).toContain('+export const added = true')
      expect(unifiedDiff.replaceAll('\\', '/')).not.toContain(repo.replaceAll('\\', '/'))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does not promote a success summary when its verification artifact cannot be validated', async () => {
    const capture = capturedPatch()
    const projection = projectionWithVerification({
      scope: 'TASK',
      verificationAttemptId: 'xhbva_review_missing' as VerificationAttemptId,
      candidateId: 'xhbcand_review_missing' as TaskChangeSetCandidateId,
      changeSetDigest: CHANGESET_DIGEST,
      qaConfigVersion: 'task-qa.v1',
      state: 'SUCCEEDED',
      verdict: 'PASS',
      checks: [
        { checkId: 'workspace.scope', verdict: 'PASS', summary: '模型说通过' },
        { checkId: 'typescript.web', verdict: 'PASS', summary: '模型说通过' },
        { checkId: 'typescript.node', verdict: 'PASS', summary: '模型说通过' },
      ],
      evidenceBundleId: 'xhbev_review' as EvidenceBundleId,
      qaResultId: 'xhbqa_review' as QaResultId,
      taskChangeSetId: CHANGESET_ID,
      evidenceArtifacts: [],
      diagnosticArtifacts: [{ artifactId: DIAGNOSTIC_ID, digest: sha256('missing'), kind: 'QA_DIAGNOSTIC' }],
    })
    const module = new CodingAttemptReviewModuleV1({
      app: { observeM2B: vi.fn().mockResolvedValue({ ok: true, value: projection }) },
      store: {
        readTaskChangeSet: vi.fn().mockReturnValue(taskChangeSet()),
        readArtifact: vi.fn((artifactId: ArtifactId) => artifactId === PATCH_ID
          ? {
              artifactId,
              kind: 'PATCH',
              mediaType: 'application/vnd.xiaogui.task-patch-v1+json',
              contentDigest: capture.patchArtifactDigest as Sha256Digest,
              content: capture.patchArtifactBytes,
            }
          : null),
      },
      workspace: { captureTaskPatch: vi.fn().mockResolvedValue(capture) },
      diffPort: { createUnifiedDiff: vi.fn().mockResolvedValue('') },
    })

    const result = await module.read({ address: ADDRESS, attemptId: ATTEMPT_ID })

    expect(result.bundle.verifications).toEqual([
      expect.objectContaining({ label: '界面 TypeScript 检查', status: 'UNKNOWN', exitCode: null }),
      expect.objectContaining({ label: '主进程 TypeScript 检查', status: 'UNKNOWN', exitCode: null }),
    ])
    expect(result.bundle.unresolvedIssues).toEqual([
      '验证制品缺失或无法校验，检查结果按未知处理。',
      '成功状态缺少完整、可校验的固定验证命令证据。',
    ])
  })

  it('fails closed before diff generation when the captured workspace contains an unsafe path', async () => {
    const capture = capturedPatch()
    const diffPort: AttemptReviewDiffPortV1 = { createUnifiedDiff: vi.fn() }
    const module = new CodingAttemptReviewModuleV1({
      app: { observeM2B: vi.fn().mockResolvedValue({ ok: true, value: projectionWithVerification(undefined) }) },
      store: { readTaskChangeSet: vi.fn(), readArtifact: vi.fn() },
      workspace: {
        captureTaskPatch: vi.fn().mockResolvedValue({
          ...capture,
          changedFiles: [{ ...capture.changedFiles[0], relativePath: 'D:\\private\\secret.ts' }],
        }),
      },
      diffPort,
    })

    await expect(module.read({ address: ADDRESS, attemptId: ATTEMPT_ID })).rejects.toMatchObject({
      reasonCode: 'UNSAFE_RELATIVE_PATH',
    })
    expect(diffPort.createUnifiedDiff).not.toHaveBeenCalled()
  })
})

function projectionWithVerification(
  verificationSummary: SessionCollaborationProjectionM2BV1['attempts'][number]['verificationSummary'],
): SessionCollaborationProjectionM2BV1 {
  return {
    kind: 'SESSION_COLLABORATION_PROJECTION',
    version: 'm2b.v1',
    address: ADDRESS,
    sessionVersion: 1,
    sessionMode: 'CODING',
    authoritativeMode: 'CODING',
    reserved: false,
    activeFlow: null,
    activeRevision: null,
    taskSpecs: [],
    taskRuns: [],
    history: [],
    attempts: [{
      attemptId: ATTEMPT_ID,
      taskRunId: TASK_RUN_ID,
      status: 'SUCCEEDED',
      ...(verificationSummary ? { verificationSummary } : {}),
    }],
    availableActions: [],
  }
}

function capturedPatch(): AttemptTaskPatchCaptureV1 {
  const files = [
    {
      operation: 'MODIFY' as const,
      relativePath: 'src/existing.ts',
      baselineDigest: digestBytes('before'),
      contentDigest: digestBytes('after'),
      contentBase64: Buffer.from('after').toString('base64'),
    },
    {
      operation: 'CREATE' as const,
      relativePath: 'src/new.ts',
      baselineDigest: null,
      contentDigest: digestBytes('new'),
      contentBase64: Buffer.from('new').toString('base64'),
    },
  ]
  const patchArtifactBytes = Buffer.from(JSON.stringify({ kind: 'TASK_PATCH_V1', version: 1, files }))
  return {
    inputTreeHash: `sha256:${'1'.repeat(64)}`,
    resultTreeHash: `sha256:${'2'.repeat(64)}`,
    patchArtifactId: PATCH_ID,
    patchArtifactDigest: digestBytes(patchArtifactBytes),
    patchArtifactBytes,
    changedFiles: files,
    privateVerificationContext: {
      attemptWorktreeId: 'xhbwt_private',
      worktreeRoot: 'D:\\private\\attempt-worktree',
      baseRevision: '4'.repeat(40),
      baselineGitTreeOid: '6'.repeat(40),
      manifestDigest: `sha256:${'5'.repeat(64)}`,
      manifestVersion: 1,
    },
  }
}

function taskChangeSet(): TaskChangeSetV1 {
  const capture = capturedPatch()
  return {
    kind: 'TASK',
    version: 1,
    taskChangeSetId: CHANGESET_ID,
    flowId: 'xhbf_review' as never,
    planRevisionId: 'xhbpr_review' as PlanRevisionId,
    taskRunId: TASK_RUN_ID,
    attemptId: ATTEMPT_ID,
    verificationAttemptId: 'xhbva_review' as VerificationAttemptId,
    candidateId: 'xhbcand_review' as TaskChangeSetCandidateId,
    inputTreeHash: capture.inputTreeHash as Sha256Digest,
    resultTreeHash: capture.resultTreeHash as Sha256Digest,
    ancestorTaskChangeSetIds: [],
    patchArtifactId: PATCH_ID,
    evidenceBundleId: 'xhbev_review' as EvidenceBundleId,
    qaResultId: 'xhbqa_review' as QaResultId,
    qaConfigVersion: 'task-qa.v1',
    digest: CHANGESET_DIGEST,
    createdAt: '2026-08-31T00:00:00.000Z' as IsoDateTime,
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function sha256(value: string | Uint8Array): Sha256Digest {
  return digestBytes(value) as Sha256Digest
}
