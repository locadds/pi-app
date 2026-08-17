import type { AttemptId, FlowId, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import {
  taskCandidateDigestV1,
  taskChangeSetDigestV1,
  type ArtifactId,
  type ChangeSetCandidateV1,
  type IsoDateTime,
  type Sha256Digest,
  type TaskArtifactRefV1,
  type TaskChangeSetCandidateId,
  type TaskChangeSetId,
} from '@shared/xiaogui-task-verification'

import {
  digestJson,
  type AttemptTaskPatchCapturePortV1,
  type AttemptTaskPatchCaptureV1,
  type TaskPatchFileSnapshotV1,
} from './attempt-workspace'

export const TASK_PATCH_MEDIA_TYPE_V1 = 'application/vnd.xiaogui.task-patch-v1+json' as const

export interface RuntimeTaskCandidateSignalV1 {
  readonly runtimeSessionId: string
  readonly receiptDigest: string
  readonly candidateDigest: string
}

export interface CaptureTaskCandidateInputV1 {
  readonly flowId: FlowId
  readonly taskRunId: TaskRunId
  readonly attemptId: AttemptId
  /** Stable timestamp from the persisted runtime-outcome record. */
  readonly createdAt: IsoDateTime | string
  readonly runtimeSignal: RuntimeTaskCandidateSignalV1
  readonly ancestorTaskChangeSetIds?: readonly TaskChangeSetId[]
}

export interface PrivateTaskPatchArtifactV1 extends TaskArtifactRefV1 {
  readonly kind: 'PATCH'
  readonly mediaType: typeof TASK_PATCH_MEDIA_TYPE_V1
  readonly bytes: Uint8Array
}

/**
 * Main-process-only result. The candidate is safe to persist/project by its
 * shared shape; the remaining fields are private verification inputs.
 */
export interface TaskCandidateAuditResultV1 {
  readonly candidate: ChangeSetCandidateV1
  readonly patchArtifact: PrivateTaskPatchArtifactV1
  readonly changedFiles: readonly TaskPatchFileSnapshotV1[]
  readonly ancestorTaskChangeSetIds: readonly TaskChangeSetId[]
  readonly runtimeCandidateBindingDigest: Sha256Digest
  readonly privateVerificationContext: AttemptTaskPatchCaptureV1['privateVerificationContext']
}

export type TaskCandidateAuditReasonCodeV1 =
  | 'CANDIDATE_IDENTITY_INVALID'
  | 'CANDIDATE_TIMESTAMP_INVALID'

export class TaskCandidateAuditErrorV1 extends Error {
  constructor(readonly reasonCode: TaskCandidateAuditReasonCodeV1) {
    super(reasonCode)
    this.name = 'TaskCandidateAuditErrorV1'
  }
}

export class TaskCandidateAuditServiceV1 {
  constructor(private readonly workspace: AttemptTaskPatchCapturePortV1) {}

  async captureTaskCandidate(input: CaptureTaskCandidateInputV1): Promise<TaskCandidateAuditResultV1> {
    assertIdentity(input)
    const createdAt = canonicalTimestamp(input.createdAt)
    const capture = await this.workspace.captureTaskPatch(input.attemptId)
    const ancestorTaskChangeSetIds = validatedAncestorIds(input.ancestorTaskChangeSetIds ?? [])
    const inputTreeHash = capture.inputTreeHash as Sha256Digest
    const resultTreeHash = capture.resultTreeHash as Sha256Digest
    const patchArtifactId = capture.patchArtifactId as ArtifactId
    const proposedChangeSetDigest = taskChangeSetDigestV1({
      inputTreeHash,
      resultTreeHash,
      ancestorTaskChangeSetIds,
      patchArtifactId,
    })
    const hostCandidateIdentityDigest = digestJson({
      kind: 'HOST_TASK_CANDIDATE_ID_V1',
      flowId: input.flowId,
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
      inputTreeHash,
      resultTreeHash,
      patchArtifactId,
      patchArtifactDigest: capture.patchArtifactDigest,
      ancestorTaskChangeSetIds,
    }) as Sha256Digest
    const candidateId = candidateIdFrom(hostCandidateIdentityDigest)
    const candidateWithoutDigest: Omit<ChangeSetCandidateV1, 'candidateDigest'> = {
      kind: 'TASK_CANDIDATE',
      candidateId,
      flowId: input.flowId,
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
      inputTreeHash,
      resultTreeHash,
      patchArtifactId,
      proposedChangeSetDigest,
      createdAt,
    }
    const candidate: ChangeSetCandidateV1 = {
      ...candidateWithoutDigest,
      candidateDigest: taskCandidateDigestV1(candidateWithoutDigest),
    }
    const runtimeCandidateBindingDigest = digestJson({
      kind: 'RUNTIME_TASK_CANDIDATE_BINDING_V1',
      runtimeSessionId: input.runtimeSignal.runtimeSessionId,
      runtimeReceiptDigest: input.runtimeSignal.receiptDigest,
      runtimeCandidateDigest: input.runtimeSignal.candidateDigest,
      candidateId: candidate.candidateId,
      hostCandidateDigest: candidate.candidateDigest,
    }) as Sha256Digest

    return {
      candidate,
      patchArtifact: {
        artifactId: patchArtifactId,
        digest: capture.patchArtifactDigest as Sha256Digest,
        kind: 'PATCH',
        mediaType: TASK_PATCH_MEDIA_TYPE_V1,
        bytes: capture.patchArtifactBytes,
      },
      changedFiles: capture.changedFiles,
      ancestorTaskChangeSetIds,
      runtimeCandidateBindingDigest,
      privateVerificationContext: capture.privateVerificationContext,
    }
  }
}

function assertIdentity(input: CaptureTaskCandidateInputV1): void {
  if (
    !cleanIdentity(input.flowId) ||
    !cleanIdentity(input.taskRunId) ||
    !cleanIdentity(input.attemptId) ||
    !cleanIdentity(input.runtimeSignal.runtimeSessionId) ||
    !cleanDigestSignal(input.runtimeSignal.receiptDigest) ||
    !cleanDigestSignal(input.runtimeSignal.candidateDigest)
  ) {
    throw new TaskCandidateAuditErrorV1('CANDIDATE_IDENTITY_INVALID')
  }
}

function cleanIdentity(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(value)
}

function cleanDigestSignal(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[A-Za-z0-9._-]{1,256}$/.test(value)
}

function validatedAncestorIds(ids: readonly TaskChangeSetId[]): readonly TaskChangeSetId[] {
  if (!Array.isArray(ids) || ids.some((id) => !cleanIdentity(id))) {
    throw new TaskCandidateAuditErrorV1('CANDIDATE_IDENTITY_INVALID')
  }
  const ordered = [...ids]
  if (new Set(ordered).size !== ordered.length) {
    throw new TaskCandidateAuditErrorV1('CANDIDATE_IDENTITY_INVALID')
  }
  return ordered
}

function candidateIdFrom(bindingDigest: Sha256Digest): TaskChangeSetCandidateId {
  return `xhcand_${bindingDigest.slice('sha256:'.length, 'sha256:'.length + 32)}` as TaskChangeSetCandidateId
}

function canonicalTimestamp(value: string): IsoDateTime {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TaskCandidateAuditErrorV1('CANDIDATE_TIMESTAMP_INVALID')
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TaskCandidateAuditErrorV1('CANDIDATE_TIMESTAMP_INVALID')
  }
  return value as IsoDateTime
}
