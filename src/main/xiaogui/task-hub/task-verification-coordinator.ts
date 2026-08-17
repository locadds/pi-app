import { createHash } from 'node:crypto'

import type { RuntimeOutcomeV1 } from '@shared/xiaogui-agent-runtime'
import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  SessionCollaborationProjectionM2BV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import {
  taskChangeSetDigestV1,
  taskEvidenceBundleDigestV1,
  taskQaResultDigestV1,
  verificationReceiptDigestV1,
  verificationRequestDigestV1,
  type ArtifactId,
  type EvidenceBundleId,
  type IsoDateTime,
  type QaResultId,
  type Sha256Digest,
  type TaskChangeSetId,
  type TaskChangeSetV1,
  type TaskEvidenceBundleV1,
  type TaskPassedQaResultV1,
  type TaskVerificationReceiptV1,
  type TaskVerificationRequestV1,
  type VerificationAttemptId,
} from '@shared/xiaogui-task-verification'

import { digestJson } from './digest'
import type { ProjectWorkspaceResolverV1 } from './attempt-workspace'
import {
  TaskCandidateAuditServiceV1,
  type RuntimeTaskCandidateSignalV1,
  type TaskCandidateAuditResultV1,
} from './task-candidate-audit'
import type {
  TaskArtifactWriteV1,
  TaskVerificationExecutionPortV1,
} from './verification-port'
import { CollaborationHubSqliteStoreV1, type VerificationOutboxRecordV1 } from './sqlite-store'

const VERIFIER_OWNER_ID = 'xiaogui-main-process-task-verifier'
const QA_CONFIG_VERSION = 'xiaogui.coding.task.v1'
const ACCEPTANCE_CRITERIA = ['approved-file-scope', 'typescript.web', 'typescript.node'] as const

export interface TaskVerificationSucceededInputV1 {
  readonly address: HubAddressV1
  readonly flowId: FlowId
  readonly taskRunId: TaskRunId
  readonly attemptId: AttemptId
  readonly outcome: Extract<RuntimeOutcomeV1, { state: 'SUCCEEDED' }>
  readonly createdAt: string
}

export type TaskVerificationCoordinatorResultV1 =
  | {
      readonly ok: true
      readonly verificationAttemptId: VerificationAttemptId
      readonly verdict: TaskVerificationReceiptV1['verdict']
    }
  | {
      readonly ok: false
      readonly reasonCode:
        | 'TASK_VERIFICATION_BINDING_MISMATCH'
        | 'TASK_VERIFICATION_CAPTURE_FAILED'
        | 'TASK_VERIFICATION_STORE_REJECTED'
        | 'TASK_VERIFICATION_CLAIM_REJECTED'
        | 'TASK_VERIFICATION_PORT_REJECTED'
    }

export interface TaskVerificationCoordinatorV1 {
  handleSucceeded(input: TaskVerificationSucceededInputV1): Promise<TaskVerificationCoordinatorResultV1>
  recoverPending(): Promise<readonly TaskVerificationCoordinatorResultV1[]>
  close(): Promise<void>
}

export interface TaskVerificationCoordinatorOptionsV1 {
  readonly storeFactory: () => CollaborationHubSqliteStoreV1
  readonly candidateAudit: TaskCandidateAuditServiceV1
  readonly verificationPort: TaskVerificationExecutionPortV1
  readonly projectResolver: ProjectWorkspaceResolverV1
  readonly now?: () => string
}

export class SqliteTaskVerificationCoordinatorV1 implements TaskVerificationCoordinatorV1 {
  private store: CollaborationHubSqliteStoreV1 | null = null
  private readonly inFlight = new Map<string, Promise<TaskVerificationCoordinatorResultV1>>()
  private closePromise: Promise<void> | undefined
  private closed = false

  constructor(private readonly options: TaskVerificationCoordinatorOptionsV1) {}

  handleSucceeded(input: TaskVerificationSucceededInputV1): Promise<TaskVerificationCoordinatorResultV1> {
    if (this.closed) return Promise.resolve({ ok: false, reasonCode: 'TASK_VERIFICATION_STORE_REJECTED' })
    const key = `success:${input.attemptId}`
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const task = this.handleSucceededOnce(input).finally(() => {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key)
    })
    this.inFlight.set(key, task)
    return task
  }

  async recoverPending(): Promise<readonly TaskVerificationCoordinatorResultV1[]> {
    if (this.closed) return []
    const results: TaskVerificationCoordinatorResultV1[] = []
    for (const pending of this.storeInstance().pendingTaskVerifications()) {
      if (this.closed) return results
      results.push(await this.completePendingAsUnknown(pending.address, pending.outbox))
    }
    return results
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = Promise.allSettled([...this.inFlight.values()]).then(() => {
      this.store?.close()
      this.store = null
    })
    return this.closePromise
  }

  private async handleSucceededOnce(input: TaskVerificationSucceededInputV1): Promise<TaskVerificationCoordinatorResultV1> {
    const store = this.storeInstance()
    const projection = store.readProjectionM2B(input.address)
    const planRevisionId = projection?.activeFlow?.activeRevisionId
    const attempt = projection?.attempts.find((candidate) => candidate.attemptId === input.attemptId)
    const taskRun = projection?.taskRuns.find((candidate) => candidate.taskRunId === input.taskRunId)
    if (
      !projection ||
      !planRevisionId ||
      projection.activeFlow?.flowId !== input.flowId ||
      attempt?.taskRunId !== input.taskRunId ||
      attempt.status !== 'RUNNING' ||
      attempt.runtimeSessionId !== input.outcome.runtimeSessionId ||
      taskRun?.attemptId !== input.attemptId ||
      taskRun.status !== 'RUNNING'
    ) {
      return { ok: false, reasonCode: 'TASK_VERIFICATION_BINDING_MISMATCH' }
    }

    let ancestorTaskChangeSetIds: readonly TaskChangeSetId[]
    try {
      ancestorTaskChangeSetIds = store.taskChangeSetAncestorIds(input.address, input.flowId, input.taskRunId)
    } catch {
      return { ok: false, reasonCode: 'TASK_VERIFICATION_STORE_REJECTED' }
    }

    let audited: TaskCandidateAuditResultV1
    try {
      audited = await this.options.candidateAudit.captureTaskCandidate({
        flowId: input.flowId,
        taskRunId: input.taskRunId,
        attemptId: input.attemptId,
        createdAt: this.timestamp(input.createdAt),
        runtimeSignal: runtimeSignal(input.outcome),
        ancestorTaskChangeSetIds,
      })
    } catch {
      return { ok: false, reasonCode: 'TASK_VERIFICATION_CAPTURE_FAILED' }
    }

    const ids = verificationIds(audited.candidate.candidateDigest)
    const requestWithoutDigest = {
      scope: 'TASK' as const,
      verificationAttemptId: ids.verificationAttemptId,
      verificationRequestId: ids.verificationRequestId,
      flowId: input.flowId,
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
      candidateId: audited.candidate.candidateId,
      changeSetDigest: audited.candidate.proposedChangeSetDigest,
      preparedTreeHash: audited.candidate.resultTreeHash,
      qaConfigVersion: QA_CONFIG_VERSION,
      acceptanceCriteria: ACCEPTANCE_CRITERIA,
    }
    const request: TaskVerificationRequestV1 = Object.freeze({
      ...requestWithoutDigest,
      requestDigest: verificationRequestDigestV1(requestWithoutDigest),
    })

    try {
      store.beginTaskVerification(input.address, {
        patchArtifact: {
          artifactId: audited.patchArtifact.artifactId,
          contentDigest: audited.patchArtifact.digest,
          kind: 'PATCH',
          mediaType: audited.patchArtifact.mediaType,
          content: audited.patchArtifact.bytes,
        },
        candidate: audited.candidate,
        ancestorTaskChangeSetIds: audited.ancestorTaskChangeSetIds,
        succeededAudit: {
          runtimeSessionId: input.outcome.runtimeSessionId,
          attemptId: input.attemptId,
          receiptDigest: input.outcome.receiptDigest,
          candidateDigest: input.outcome.candidateDigest,
        },
        verificationAttempt: {
          scope: 'TASK',
          verificationAttemptId: ids.verificationAttemptId,
          verificationRequestId: ids.verificationRequestId,
          flowId: input.flowId,
          taskRunId: input.taskRunId,
          attemptId: input.attemptId,
          candidateId: audited.candidate.candidateId,
          requestDigest: request.requestDigest,
          state: 'STARTED',
          startedAt: this.timestamp(input.createdAt),
        },
        verificationRequestJson: JSON.stringify(request),
        now: this.now(),
      })
    } catch {
      return { ok: false, reasonCode: 'TASK_VERIFICATION_STORE_REJECTED' }
    }

    const outbox = this.claim(request.verificationAttemptId, request.requestDigest)
    if (!outbox) {
      const pending = store.readVerificationOutbox(request.verificationAttemptId)
      if (!pending) return { ok: false, reasonCode: 'TASK_VERIFICATION_CLAIM_REJECTED' }
      return this.completePendingAsUnknown(input.address, pending, 'TASK_VERIFICATION_OUTBOX_CLAIM_FAILED')
    }

    const scopeArtifact = scopeEvidenceArtifact(ids.scopeEvidenceArtifactId, audited)
    let projectRoot: string
    try {
      projectRoot = await this.options.projectResolver.resolveProjectRoot(input.address.projectId)
    } catch {
      try {
        const completed = await this.completeWithUnknown(input.address, request, ids.inspectionArtifactId, 'PROJECT_ROOT_UNAVAILABLE')
        return { ok: true, verificationAttemptId: request.verificationAttemptId, verdict: completed.verdict }
      } catch {
        return { ok: false, reasonCode: 'TASK_VERIFICATION_STORE_REJECTED' }
      }
    }

    let result: Awaited<ReturnType<TaskVerificationExecutionPortV1['verify']>>
    try {
      result = await this.options.verificationPort.verify(request, {
        worktreeRoot: audited.privateVerificationContext.worktreeRoot,
        trustedToolchainRoot: projectRoot,
        scopeEvidenceArtifactId: ids.scopeEvidenceArtifactId,
        inspectionArtifactId: ids.inspectionArtifactId,
      })
    } catch {
      try {
        const completed = await this.completeWithUnknown(input.address, request, ids.inspectionArtifactId, 'TASK_VERIFICATION_PORT_REJECTED')
        return { ok: true, verificationAttemptId: request.verificationAttemptId, verdict: completed.verdict }
      } catch {
        return { ok: false, reasonCode: 'TASK_VERIFICATION_PORT_REJECTED' }
      }
    }

    const evidenceArtifacts = result.receipt.verdict === 'OUTCOME_UNKNOWN'
      ? []
      : [
          scopeArtifact,
          ...result.artifacts.filter((artifact) => artifact.kind === 'VERIFICATION_EVIDENCE'),
        ]
    const diagnosticArtifacts = result.artifacts.filter((artifact) => artifact.kind === 'VERIFICATION_DIAGNOSTIC')
    if (result.receipt.verdict !== 'PASS') {
      const completed = store.completeTaskVerification(input.address, {
        receipt: result.receipt,
        evidenceArtifacts,
        diagnosticArtifacts,
        now: this.now(),
      })
      return { ok: true, verificationAttemptId: request.verificationAttemptId, verdict: completed.verdict }
    }

    const evidenceWithoutDigest = {
      scope: 'TASK' as const,
      evidenceBundleId: ids.evidenceBundleId,
      verificationAttemptId: request.verificationAttemptId,
      flowId: input.flowId,
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
      changeSetDigest: request.changeSetDigest,
      qaConfigVersion: request.qaConfigVersion,
      artifactIds: result.receipt.evidenceArtifactIds,
    }
    const evidenceBundle: TaskEvidenceBundleV1 = {
      ...evidenceWithoutDigest,
      bundleDigest: taskEvidenceBundleDigestV1(evidenceWithoutDigest),
    }
    const qaWithoutDigest = {
      scope: 'TASK' as const,
      qaResultId: ids.qaResultId,
      verificationAttemptId: request.verificationAttemptId,
      flowId: input.flowId,
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
      candidateId: request.candidateId,
      changeSetDigest: request.changeSetDigest,
      qaConfigVersion: request.qaConfigVersion,
      verdict: 'PASS' as const,
      checks: result.receipt.checks,
    }
    const qaResult: TaskPassedQaResultV1 = {
      ...qaWithoutDigest,
      resultDigest: taskQaResultDigestV1(qaWithoutDigest),
    }
    const changeSet: TaskChangeSetV1 = {
      kind: 'TASK',
      taskChangeSetId: ids.taskChangeSetId,
      version: 1,
      flowId: input.flowId,
      planRevisionId,
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
      verificationAttemptId: request.verificationAttemptId,
      candidateId: request.candidateId,
      inputTreeHash: audited.candidate.inputTreeHash,
      resultTreeHash: audited.candidate.resultTreeHash,
      ancestorTaskChangeSetIds: audited.ancestorTaskChangeSetIds,
      patchArtifactId: audited.candidate.patchArtifactId,
      evidenceBundleId: evidenceBundle.evidenceBundleId,
      qaResultId: qaResult.qaResultId,
      qaConfigVersion: request.qaConfigVersion,
      digest: request.changeSetDigest,
      createdAt: this.now() as IsoDateTime,
    }
    if (taskChangeSetDigestV1(changeSet) !== changeSet.digest) {
      const completed = await this.completeWithUnknown(input.address, request, ids.inspectionArtifactId, 'TASK_CHANGESET_DIGEST_MISMATCH')
      return { ok: true, verificationAttemptId: request.verificationAttemptId, verdict: completed.verdict }
    }

    const completed = store.completeTaskVerification(input.address, {
      receipt: result.receipt,
      evidenceBundle,
      qaResult,
      taskChangeSet: changeSet,
      evidenceArtifacts,
      diagnosticArtifacts,
      now: this.now(),
    })
    return { ok: true, verificationAttemptId: request.verificationAttemptId, verdict: completed.verdict }
  }

  private async completeBeginFailureAsUnknown(
    input: TaskVerificationSucceededInputV1,
    safeCode: string,
  ): Promise<void> {
    const store = this.storeInstance()
    const attempt = store.attempt(input.attemptId)
    if (!attempt || attempt.status !== 'RUNNING') return
    const emptyCandidateDigest = digestJson({
      flowId: input.flowId,
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
      safeCode,
    }) as Sha256Digest
    const ids = verificationIds(emptyCandidateDigest)
    const requestWithoutDigest = {
      scope: 'TASK' as const,
      verificationAttemptId: ids.verificationAttemptId,
      verificationRequestId: ids.verificationRequestId,
      flowId: input.flowId,
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
      candidateId: `xhcand_${hashHex(emptyCandidateDigest).slice(0, 32)}` as never,
      changeSetDigest: digestJson({ safeCode, role: 'begin-failed-changeset' }) as Sha256Digest,
      preparedTreeHash: digestJson({ safeCode, role: 'begin-failed-tree' }) as Sha256Digest,
      qaConfigVersion: QA_CONFIG_VERSION,
      acceptanceCriteria: ACCEPTANCE_CRITERIA,
    }
    const request: TaskVerificationRequestV1 = Object.freeze({
      ...requestWithoutDigest,
      requestDigest: verificationRequestDigestV1(requestWithoutDigest),
    })
    await this.recordRuntimeOutcomeUnknown(input, safeCode, request.requestDigest)
  }

  private async recordRuntimeOutcomeUnknown(
    input: TaskVerificationSucceededInputV1,
    safeCode: string,
    requestDigest: string,
  ): Promise<void> {
    const store = this.storeInstance()
    const receipt = {
      requestId: `xhbvr_${hashHex(`${input.attemptId}:${safeCode}:${requestDigest}`).slice(0, 48)}`,
      intentType: 'system.agent.outcome.record' as const,
      sessionVersion: 0,
      flowId: input.flowId,
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
    }
    store.writeAgentOutcome(input.address, {
      requestId: receipt.requestId,
      commandType: 'system.agent.outcome.record',
      payloadHash: digestJson({ input, safeCode, requestDigest }),
    }, {
      attemptId: input.attemptId,
      taskRunId: input.taskRunId,
      runtimeSessionId: input.outcome.runtimeSessionId,
      outcome: 'OUTCOME_UNKNOWN',
      receiptDigest: digestJson({ safeCode, requestDigest }),
      receipt,
      now: this.now(),
    })
  }

  private async completePendingAsUnknown(
    address: HubAddressV1,
    outbox: VerificationOutboxRecordV1,
    safeCode = 'MAIN_PROCESS_RESTART_VERIFICATION_UNBOUND',
  ): Promise<TaskVerificationCoordinatorResultV1> {
    const request = JSON.parse(outbox.requestJson) as TaskVerificationRequestV1
    const claimed = outbox.status === 'CLAIMED'
      ? outbox
      : this.claim(request.verificationAttemptId, request.requestDigest)
    if (!claimed) return { ok: false, reasonCode: 'TASK_VERIFICATION_CLAIM_REJECTED' }
    try {
      const completed = await this.completeWithUnknown(address, request, verificationIds(request.requestDigest).inspectionArtifactId, safeCode)
      return {
        ok: true,
        verificationAttemptId: request.verificationAttemptId,
        verdict: completed.verdict,
      }
    } catch {
      return { ok: false, reasonCode: 'TASK_VERIFICATION_STORE_REJECTED' }
    }
  }

  private async completeWithUnknown(
    address: HubAddressV1,
    request: TaskVerificationRequestV1,
    diagnosticArtifactId: ArtifactId,
    safeCode: string,
  ) {
    const diagnostic = diagnosticArtifact(diagnosticArtifactId, safeCode)
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
      verdict: 'OUTCOME_UNKNOWN' as const,
      reason: safeCode,
    }
    return this.storeInstance().completeTaskVerification(address, {
      receipt: { ...receiptWithoutDigest, receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest) },
      diagnosticArtifacts: [diagnostic],
      now: this.now(),
    })
  }

  private claim(verificationAttemptId: VerificationAttemptId, requestDigest: string): VerificationOutboxRecordV1 | null {
    return this.storeInstance().claimVerificationOutbox({
      verificationAttemptId,
      ownerId: VERIFIER_OWNER_ID,
      claimDigest: digestJson({ verificationAttemptId, requestDigest, ownerId: VERIFIER_OWNER_ID }),
      now: this.now(),
    })
  }

  private storeInstance(): CollaborationHubSqliteStoreV1 {
    this.store ??= this.options.storeFactory()
    return this.store
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  private timestamp(value: string): IsoDateTime {
    return new Date(value).toISOString() as IsoDateTime
  }
}

export function createTaskVerificationCoordinatorV1(
  options: TaskVerificationCoordinatorOptionsV1,
): TaskVerificationCoordinatorV1 {
  return new SqliteTaskVerificationCoordinatorV1(options)
}

function runtimeSignal(outcome: Extract<RuntimeOutcomeV1, { state: 'SUCCEEDED' }>): RuntimeTaskCandidateSignalV1 {
  return {
    runtimeSessionId: outcome.runtimeSessionId,
    receiptDigest: outcome.receiptDigest,
    candidateDigest: outcome.candidateDigest,
  }
}

function verificationIds(seed: string): {
  verificationAttemptId: VerificationAttemptId
  verificationRequestId: string
  scopeEvidenceArtifactId: ArtifactId
  inspectionArtifactId: ArtifactId
  evidenceBundleId: EvidenceBundleId
  qaResultId: QaResultId
  taskChangeSetId: TaskChangeSetId
} {
  const hex = hashHex(seed)
  return {
    verificationAttemptId: `xhbva_${hex.slice(0, 32)}` as VerificationAttemptId,
    verificationRequestId: `xhbvr_${hex.slice(0, 48)}`,
    scopeEvidenceArtifactId: `xhbart_scope_${hex.slice(0, 32)}` as ArtifactId,
    inspectionArtifactId: `xhbart_inspect_${hex.slice(0, 32)}` as ArtifactId,
    evidenceBundleId: `xhbev_${hex.slice(0, 32)}` as EvidenceBundleId,
    qaResultId: `xhbqa_${hex.slice(0, 32)}` as QaResultId,
    taskChangeSetId: `xhbcs_${hex.slice(0, 32)}` as TaskChangeSetId,
  }
}

function scopeEvidenceArtifact(
  artifactId: ArtifactId,
  audited: TaskCandidateAuditResultV1,
): TaskArtifactWriteV1 {
  const content = Buffer.from(JSON.stringify({
    version: 'task-scope-evidence.v1',
    candidateId: audited.candidate.candidateId,
    inputTreeHash: audited.candidate.inputTreeHash,
    resultTreeHash: audited.candidate.resultTreeHash,
    changedFiles: audited.changedFiles.map((file) => ({
      operation: file.operation,
      relativePath: file.relativePath,
      baselineDigest: file.baselineDigest,
      contentDigest: file.contentDigest,
    })),
  }), 'utf8')
  return {
    artifactId,
    contentDigest: digestBytes(content),
    kind: 'VERIFICATION_EVIDENCE',
    mediaType: 'application/vnd.xiaogui.scope-evidence+json',
    content,
  }
}

function diagnosticArtifact(artifactId: ArtifactId, safeCode: string): TaskArtifactWriteV1 {
  const content = Buffer.from(JSON.stringify({
    version: 'task-verification-diagnostic.v1',
    outcome: 'OUTCOME_UNKNOWN',
    safeCode,
  }), 'utf8')
  return {
    artifactId,
    contentDigest: digestBytes(content),
    kind: 'VERIFICATION_DIAGNOSTIC',
    mediaType: 'application/vnd.xiaogui.qa-diagnostic+json',
    content,
  }
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}

function hashHex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function taskVerificationProjectionStatus(
  projection: SessionCollaborationProjectionM2BV1,
  attemptId: AttemptId,
): string | undefined {
  return projection.attempts.find((attempt) => attempt.attemptId === attemptId)?.status
}
