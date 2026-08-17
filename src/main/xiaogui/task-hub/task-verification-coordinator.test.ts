import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { RuntimeOutcomeV1 } from '@shared/xiaogui-agent-runtime'
import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  PlanRevisionId,
  SessionCollaborationProjectionM2BV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import {
  taskCandidateDigestV1,
  taskChangeSetDigestV1,
  verificationReceiptDigestV1,
  verificationRequestDigestV1,
  type ArtifactId,
  type ChangeSetCandidateV1,
  type Sha256Digest,
  type TaskChangeSetCandidateId,
  type TaskChangeSetId,
  type TaskVerificationRequestV1,
  type VerificationAttemptId,
} from '@shared/xiaogui-task-verification'

import { createTaskVerificationCoordinatorV1 } from './task-verification-coordinator'
import type { TaskCandidateAuditResultV1 } from './task-candidate-audit'
import type { CompleteTaskVerificationRecordV1, VerificationOutboxRecordV1 } from './sqlite-store'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as HubAddressV1
const FLOW_ID = 'xhbf_flow' as FlowId
const PLAN_REVISION_ID = 'xhbr_revision' as PlanRevisionId
const TASK_RUN_ID = 'xhbtr_task' as TaskRunId
const ATTEMPT_ID = 'xhba_attempt' as AttemptId
const RUNTIME_OUTCOME = {
  state: 'SUCCEEDED',
  runtimeSessionId: 'runtime-1',
  receiptDigest: 'sha256:runtime-receipt',
  candidateDigest: 'sha256:runtime-candidate',
} satisfies Extract<RuntimeOutcomeV1, { state: 'SUCCEEDED' }>

describe('SqliteTaskVerificationCoordinatorV1', () => {
  it('captures the authoritative candidate, runs fixed verification, and seals PASS objects', async () => {
    const candidate = candidateFixture([])
    const audited = auditFixture(candidate)
    const completed: CompleteTaskVerificationRecordV1[] = []
    const store = fakeStore(completed)

    const coordinator = createTaskVerificationCoordinatorV1({
      storeFactory: () => store as never,
      candidateAudit: {
        captureTaskCandidate: vi.fn(async (input) => {
          expect(input.ancestorTaskChangeSetIds).toEqual([])
          expect(input.createdAt).toBe('2026-08-17T00:00:01.000Z')
          return audited
        }),
      } as never,
      verificationPort: {
        verify: vi.fn(async (request, context) => {
          expect(Object.isFrozen(request)).toBe(true)
          expect(context.scopeEvidenceArtifactId).toMatch(/^xhbart_scope_/)
          return passVerification(request, context.scopeEvidenceArtifactId, context.inspectionArtifactId)
        }),
      },
      projectResolver: { resolveProjectRoot: vi.fn(async () => process.cwd()) },
      now: () => '2026-08-17T00:00:02.000Z',
    })

    await expect(coordinator.handleSucceeded({
      address: ADDRESS,
      flowId: FLOW_ID,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      outcome: RUNTIME_OUTCOME,
      createdAt: '2026-08-17T00:00:01.000Z',
    })).resolves.toMatchObject({ ok: true, verdict: 'PASS' })

    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      evidenceBundle: { changeSetDigest: candidate.proposedChangeSetDigest },
      qaResult: { verdict: 'PASS', changeSetDigest: candidate.proposedChangeSetDigest },
      taskChangeSet: {
        planRevisionId: PLAN_REVISION_ID,
        patchArtifactId: candidate.patchArtifactId,
        digest: candidate.proposedChangeSetDigest,
      },
    })
    expect(completed[0]?.evidenceArtifacts?.[0]?.mediaType).toBe('application/vnd.xiaogui.scope-evidence+json')
    expect(Buffer.from(completed[0]!.evidenceArtifacts![0]!.content).toString('utf8')).not.toContain(process.cwd())
  })

  it('returns ok UNKNOWN when project resolution fails after begin', async () => {
    const completed: CompleteTaskVerificationRecordV1[] = []
    const candidate = candidateFixture([])
    const store = fakeStore(completed)
    const verify = vi.fn()
    const coordinator = createTaskVerificationCoordinatorV1({
      storeFactory: () => store as never,
      candidateAudit: { captureTaskCandidate: vi.fn(async () => auditFixture(candidate)) } as never,
      verificationPort: { verify },
      projectResolver: {
        resolveProjectRoot: vi.fn(async () => {
          throw new Error('PROJECT_NOT_FOUND')
        }),
      },
      now: () => '2026-08-17T00:00:02.000Z',
    })

    await expect(coordinator.handleSucceeded({
      address: ADDRESS,
      flowId: FLOW_ID,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      outcome: RUNTIME_OUTCOME,
      createdAt: '2026-08-17T00:00:01.000Z',
    })).resolves.toMatchObject({ ok: true, verdict: 'OUTCOME_UNKNOWN' })

    expect(verify).not.toHaveBeenCalled()
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      receipt: { verdict: 'OUTCOME_UNKNOWN', reason: 'PROJECT_ROOT_UNAVAILABLE' },
    })
    expect(completed[0]?.evidenceBundle).toBeUndefined()
    expect(completed[0]?.qaResult).toBeUndefined()
    expect(completed[0]?.taskChangeSet).toBeUndefined()
  })
})

function projection(): SessionCollaborationProjectionM2BV1 {
  return {
    kind: 'SESSION_COLLABORATION_PROJECTION',
    version: 'm2b.v1',
    address: ADDRESS,
    sessionVersion: 1,
    sessionMode: 'CODING',
    authoritativeMode: 'CODING',
    reserved: false,
    activeFlow: { flowId: FLOW_ID, status: 'PLAN_ACTIVE', activeRevisionId: PLAN_REVISION_ID, objective: '验证任务' },
    activeRevision: { revisionId: PLAN_REVISION_ID, status: 'ACTIVE', digest: 'sha256:revision', draft: { objective: '验证任务', tasks: [] } },
    taskSpecs: [],
    taskRuns: [{
      taskRunId: TASK_RUN_ID,
      taskSpecId: 'xhbts_task' as never,
      taskKey: 'task',
      status: 'RUNNING',
      attemptId: ATTEMPT_ID,
    }],
    attempts: [{
      attemptId: ATTEMPT_ID,
      taskRunId: TASK_RUN_ID,
      status: 'RUNNING',
      runtimeSessionId: RUNTIME_OUTCOME.runtimeSessionId,
    }],
    history: [],
    availableActions: ['flow.cancel'],
  }
}

function fakeStore(completed: CompleteTaskVerificationRecordV1[]) {
  let outbox: VerificationOutboxRecordV1 | null = null
  return {
    readProjectionM2B: vi.fn(() => projection()),
    activeFlow: vi.fn(() => ({
      flow_id: FLOW_ID,
      status: 'PLAN_ACTIVE',
      active_revision_id: PLAN_REVISION_ID,
      objective: '验证任务',
    })),
    taskChangeSetAncestorIds: vi.fn(() => [] as readonly TaskChangeSetId[]),
    beginTaskVerification: vi.fn((_address, record) => {
      const request = JSON.parse(record.verificationRequestJson) as TaskVerificationRequestV1
      outbox = {
        outboxId: `xhbvo_${request.verificationAttemptId}`,
        verificationAttemptId: request.verificationAttemptId,
        requestDigest: request.requestDigest,
        requestJson: record.verificationRequestJson,
        status: 'READY',
        createdAt: record.now,
      }
      return { verificationAttemptId: request.verificationAttemptId, outboxId: outbox.outboxId, replayed: false }
    }),
    claimVerificationOutbox: vi.fn(() => outbox ? { ...outbox, status: 'CLAIMED' as const } : null),
    readVerificationOutbox: vi.fn(() => outbox),
    pendingTaskVerifications: vi.fn(() => []),
    completeTaskVerification: vi.fn((_address, record) => {
      completed.push(record)
      return {
        verificationAttemptId: record.receipt.verificationAttemptId,
        verdict: record.receipt.verdict,
        replayed: false,
      }
    }),
    close: vi.fn(),
  }
}

function candidateFixture(ancestorTaskChangeSetIds: readonly TaskChangeSetId[]): ChangeSetCandidateV1 {
  const inputTreeHash = 'sha256:input-tree' as Sha256Digest
  const resultTreeHash = 'sha256:result-tree' as Sha256Digest
  const patchArtifactId = 'xhbart_patch' as ArtifactId
  const withoutDigest = {
    kind: 'TASK_CANDIDATE' as const,
    candidateId: 'xhcand_candidate' as TaskChangeSetCandidateId,
    flowId: FLOW_ID,
    taskRunId: TASK_RUN_ID,
    attemptId: ATTEMPT_ID,
    inputTreeHash,
    resultTreeHash,
    patchArtifactId,
    proposedChangeSetDigest: taskChangeSetDigestV1({
      inputTreeHash,
      resultTreeHash,
      ancestorTaskChangeSetIds,
      patchArtifactId,
    }),
    createdAt: '2026-08-17T00:00:01.000Z' as never,
  }
  return { ...withoutDigest, candidateDigest: taskCandidateDigestV1(withoutDigest) }
}

function auditFixture(candidate: ChangeSetCandidateV1): TaskCandidateAuditResultV1 {
  const patchBytes = Buffer.from('patch')
  return {
    candidate,
    patchArtifact: {
      artifactId: candidate.patchArtifactId,
      digest: digestBytes(patchBytes),
      kind: 'PATCH',
      mediaType: 'application/vnd.xiaogui.task-patch-v1+json',
      bytes: patchBytes,
    },
    changedFiles: [{
      operation: 'MODIFY',
      relativePath: 'src/task.ts',
      baselineDigest: 'sha256:baseline',
      contentDigest: 'sha256:content',
      contentBase64: 'Y29udGVudA==',
    }],
    ancestorTaskChangeSetIds: [],
    runtimeCandidateBindingDigest: 'sha256:runtime-binding' as Sha256Digest,
    privateVerificationContext: {
      attemptWorktreeId: 'xhbwt_attempt',
      worktreeRoot: process.cwd(),
      baseRevision: 'abc123',
      baselineGitTreeOid: 'tree',
      manifestDigest: 'sha256:manifest',
      manifestVersion: 1,
    },
  }
}

function passVerification(
  request: TaskVerificationRequestV1,
  scopeEvidenceArtifactId: ArtifactId,
  inspectionArtifactId: ArtifactId,
) {
  const evidence = artifact('VERIFICATION_EVIDENCE', 'xhbart_typecheck' as ArtifactId, { ok: true })
  const diagnostic = artifact('VERIFICATION_DIAGNOSTIC', inspectionArtifactId, { ok: true })
  const receiptWithoutDigest = {
    scope: 'TASK' as const,
    verificationAttemptId: request.verificationAttemptId,
    verificationRequestId: request.verificationRequestId,
    flowId: request.flowId,
    taskRunId: request.taskRunId,
    attemptId: request.attemptId,
    candidateId: request.candidateId,
    requestDigest: request.requestDigest,
    changeSetDigest: request.changeSetDigest,
    qaConfigVersion: request.qaConfigVersion,
    diagnosticArtifactIds: [diagnostic.artifactId],
    verdict: 'PASS' as const,
    checks: [{
      checkId: 'typescript.web',
      summary: '界面 TypeScript 检查通过',
      artifactIds: [evidence.artifactId],
      verdict: 'PASS' as const,
    }],
    evidenceArtifactIds: [scopeEvidenceArtifactId, evidence.artifactId],
  }
  return {
    receipt: { ...receiptWithoutDigest, receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest) },
    artifacts: [evidence, diagnostic],
  }
}

function artifact(kind: 'VERIFICATION_EVIDENCE' | 'VERIFICATION_DIAGNOSTIC', artifactId: ArtifactId, value: unknown) {
  const content = Buffer.from(JSON.stringify(value), 'utf8')
  return {
    artifactId,
    contentDigest: digestBytes(content),
    kind,
    mediaType: kind === 'VERIFICATION_EVIDENCE'
      ? 'application/vnd.xiaogui.qa-evidence+json'
      : 'application/vnd.xiaogui.qa-diagnostic+json',
    content,
  }
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}
