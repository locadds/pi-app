import { describe, expect, it, vi } from 'vitest'

import type { AttemptId, FlowId, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import {
  taskCandidateDigestV1,
  taskChangeSetDigestV1,
  type TaskChangeSetId,
} from '@shared/xiaogui-task-verification'

import {
  AttemptWorkspaceError,
  digestBytes,
  type AttemptTaskPatchCapturePortV1,
  type AttemptTaskPatchCaptureV1,
} from './attempt-workspace'
import { TaskCandidateAuditServiceV1 } from './task-candidate-audit'

const FLOW_ID = 'xhbf_flow' as FlowId
const TASK_RUN_ID = 'xhbr_task' as TaskRunId
const ATTEMPT_ID = 'xhba_attempt' as AttemptId
const FIXED_TIME = '2026-08-17T12:00:00.000Z'

describe('TaskCandidateAuditServiceV1', () => {
  it('turns an authoritative MODIFY/CREATE capture into a canonical shared candidate and private patch artifact', async () => {
    const capture = capturedPatch()
    const captureTaskPatch = vi.fn<AttemptTaskPatchCapturePortV1['captureTaskPatch']>().mockResolvedValue(capture)
    const service = new TaskCandidateAuditServiceV1({ captureTaskPatch })

    const result = await service.captureTaskCandidate({
      flowId: FLOW_ID,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      createdAt: FIXED_TIME,
      runtimeSignal: {
        runtimeSessionId: 'xhr_session',
        receiptDigest: 'sha256:runtime-receipt',
        candidateDigest: 'sha256:runtime-candidate',
      },
      ancestorTaskChangeSetIds: ['xhtcs_z', 'xhtcs_a'] as TaskChangeSetId[],
    })

    expect(captureTaskPatch).toHaveBeenCalledOnce()
    expect(captureTaskPatch).toHaveBeenCalledWith(ATTEMPT_ID)
    expect(result.ancestorTaskChangeSetIds).toEqual(['xhtcs_z', 'xhtcs_a'])
    expect(result.candidate).toMatchObject({
      kind: 'TASK_CANDIDATE',
      candidateId: expect.stringMatching(/^xhcand_[0-9a-f]{32}$/),
      flowId: FLOW_ID,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      inputTreeHash: capture.inputTreeHash,
      resultTreeHash: capture.resultTreeHash,
      patchArtifactId: capture.patchArtifactId,
      createdAt: FIXED_TIME,
    })
    expect(result.candidate.proposedChangeSetDigest).toBe(
      taskChangeSetDigestV1({
        inputTreeHash: result.candidate.inputTreeHash,
        resultTreeHash: result.candidate.resultTreeHash,
        ancestorTaskChangeSetIds: result.ancestorTaskChangeSetIds,
        patchArtifactId: result.candidate.patchArtifactId,
      }),
    )
    const { candidateDigest: _candidateDigest, ...candidateEnvelope } = result.candidate
    expect(result.candidate.candidateDigest).toBe(taskCandidateDigestV1(candidateEnvelope))
    expect(result.patchArtifact).toEqual({
      artifactId: capture.patchArtifactId,
      digest: capture.patchArtifactDigest,
      kind: 'PATCH',
      mediaType: 'application/vnd.xiaogui.task-patch-v1+json',
      bytes: capture.patchArtifactBytes,
    })
    expect(result.changedFiles).toEqual(capture.changedFiles)
    expect(result.privateVerificationContext).toEqual(capture.privateVerificationContext)
    expect(JSON.stringify(result.candidate)).not.toContain(capture.privateVerificationContext.worktreeRoot)
    expect(Buffer.from(result.patchArtifact.bytes).toString('utf8')).not.toContain(
      capture.privateVerificationContext.worktreeRoot,
    )
  })

  it('audits the untrusted runtime signal without letting it change the host candidate identity', async () => {
    const captureTaskPatch = vi
      .fn<AttemptTaskPatchCapturePortV1['captureTaskPatch']>()
      .mockResolvedValue(capturedPatch())
    const service = new TaskCandidateAuditServiceV1({ captureTaskPatch })
    const base = {
      flowId: FLOW_ID,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      createdAt: FIXED_TIME,
      runtimeSignal: {
        runtimeSessionId: 'xhr_session',
        receiptDigest: 'sha256:runtime-receipt',
        candidateDigest: 'sha256:runtime-candidate-a',
      },
    }

    const first = await service.captureTaskCandidate(base)
    const second = await service.captureTaskCandidate({
      ...base,
      runtimeSignal: { ...base.runtimeSignal, candidateDigest: 'sha256:runtime-candidate-b' },
    })

    expect(first.candidate.candidateDigest).not.toBe(base.runtimeSignal.candidateDigest)
    expect(first.runtimeCandidateBindingDigest).not.toBe(second.runtimeCandidateBindingDigest)
    expect(first.candidate.candidateId).toBe(second.candidate.candidateId)
    expect(first.candidate.candidateDigest).toBe(second.candidate.candidateDigest)
    expect(first.candidate.patchArtifactId).toBe(second.candidate.patchArtifactId)
  })

  it('rejects an unapproved workspace diff before producing any candidate or artifact', async () => {
    const captureTaskPatch = vi
      .fn<AttemptTaskPatchCapturePortV1['captureTaskPatch']>()
      .mockRejectedValue(new AttemptWorkspaceError('PATH_FORBIDDEN'))
    const service = new TaskCandidateAuditServiceV1({ captureTaskPatch })

    await expect(
      service.captureTaskCandidate({
        flowId: FLOW_ID,
        taskRunId: TASK_RUN_ID,
        attemptId: ATTEMPT_ID,
        createdAt: FIXED_TIME,
        runtimeSignal: {
          runtimeSessionId: 'xhr_session',
          receiptDigest: 'sha256:runtime-receipt',
          candidateDigest: 'sha256:runtime-candidate',
        },
      }),
    ).rejects.toMatchObject({ reasonCode: 'PATH_FORBIDDEN' })
    expect(captureTaskPatch).toHaveBeenCalledOnce()
  })

  it('fails closed on malformed runtime identity before reading the workspace', async () => {
    const captureTaskPatch = vi.fn<AttemptTaskPatchCapturePortV1['captureTaskPatch']>()
    const service = new TaskCandidateAuditServiceV1({ captureTaskPatch })

    await expect(
      service.captureTaskCandidate({
        flowId: FLOW_ID,
        taskRunId: TASK_RUN_ID,
        attemptId: ATTEMPT_ID,
        createdAt: FIXED_TIME,
        runtimeSignal: {
          runtimeSessionId: 'file:///private/runtime',
          receiptDigest: 'sha256:runtime-receipt',
          candidateDigest: 'sha256:runtime-candidate',
        },
      }),
    ).rejects.toMatchObject({ reasonCode: 'CANDIDATE_IDENTITY_INVALID' })
    expect(captureTaskPatch).not.toHaveBeenCalled()
  })
})

function capturedPatch(): AttemptTaskPatchCaptureV1 {
  const patchArtifactBytes = Buffer.from(
    JSON.stringify({
      kind: 'TASK_PATCH_V1',
      version: 1,
      files: [
        {
          operation: 'MODIFY',
          relativePath: 'src/existing.ts',
          baselineDigest: digestBytes('before'),
          contentDigest: digestBytes('after'),
          contentBase64: Buffer.from('after').toString('base64'),
        },
        {
          operation: 'CREATE',
          relativePath: 'src/new.ts',
          baselineDigest: null,
          contentDigest: digestBytes('new'),
          contentBase64: Buffer.from('new').toString('base64'),
        },
      ],
    }),
  )
  return {
    inputTreeHash: `sha256:${'1'.repeat(64)}`,
    resultTreeHash: `sha256:${'2'.repeat(64)}`,
    patchArtifactId: `xhart_${'3'.repeat(32)}`,
    patchArtifactDigest: digestBytes(patchArtifactBytes),
    patchArtifactBytes,
    changedFiles: JSON.parse(patchArtifactBytes.toString('utf8')).files,
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
