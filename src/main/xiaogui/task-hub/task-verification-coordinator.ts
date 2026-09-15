import { createHash } from 'node:crypto'

import type { RuntimeOutcomeV1 } from '@shared/xiaogui-agent-runtime'
import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  PerformReceiptV1,
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
import type { IdempotencyInput } from './sqlite-store'

const VERIFIER_OWNER_ID = 'xiaogui-main-process-task-verifier'
import { MODE_VERIFICATION_POLICY_V1 } from './mode-verification-policy'

export interface UnsettledTaskVerificationInputV1 {
  readonly projectId: string
  readonly sessionMode: 'WORK' | 'DESIGN' | 'CODING'
  readonly flowId: FlowId
  readonly taskRunId: TaskRunId
  readonly attemptId: AttemptId
  readonly runtimeSessionId: string
  readonly candidateDigest: Sha256Digest
  readonly createdAt: string
}

export type UnsettledTaskVerificationResultV1 =
  | { readonly verdict: 'PASS'; readonly candidateDigest: Sha256Digest; readonly receiptDigest: Sha256Digest; readonly receiptJson: string }
  | { readonly verdict: 'FAIL'; readonly candidateDigest: Sha256Digest; readonly receiptDigest: Sha256Digest; readonly receiptJson: string; readonly diagnostic: string }
  | { readonly verdict: 'OUTCOME_UNKNOWN'; readonly candidateDigest: Sha256Digest; readonly reason: string }

/** Main-only pre-settlement verification. It records no Hub terminal state. */
export class MainUnsettledTaskVerificationPortV1 {
  constructor(
    private readonly candidateAudit: TaskCandidateAuditServiceV1,
    private readonly verificationPort: TaskVerificationExecutionPortV1,
    private readonly projectResolver: ProjectWorkspaceResolverV1,
  ) {}

  async verify(input: UnsettledTaskVerificationInputV1): Promise<UnsettledTaskVerificationResultV1> {
    try {
      const audited = await this.candidateAudit.captureTaskCandidate({
        flowId: input.flowId,
        taskRunId: input.taskRunId,
        attemptId: input.attemptId,
        createdAt: new Date(input.createdAt).toISOString(),
        runtimeSignal: {
          runtimeSessionId: input.runtimeSessionId,
          receiptDigest: `sha256:${digestJson({ kind: 'PI_UNSETTLED_RUNTIME_SIGNAL_V1', runtimeSessionId: input.runtimeSessionId, candidateDigest: input.candidateDigest })}`,
          candidateDigest: input.candidateDigest,
        },
        allowNoApprovedChanges: true,
      })
      if (audited.candidate.resultTreeHash !== input.candidateDigest) {
        return { verdict: 'OUTCOME_UNKNOWN', candidateDigest: audited.candidate.resultTreeHash, reason: 'CANDIDATE_CHANGED' }
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
        qaConfigVersion: MODE_VERIFICATION_POLICY_V1[input.sessionMode].task,
        acceptanceCriteria: ['approved-file-scope', ...MODE_VERIFICATION_POLICY_V1[input.sessionMode].checks],
      }
      const request: TaskVerificationRequestV1 = Object.freeze({ ...requestWithoutDigest, requestDigest: verificationRequestDigestV1(requestWithoutDigest) })
      if (audited.changedFiles.length === 0) {
        const receiptWithoutDigest = {
          scope: 'TASK' as const, verificationAttemptId: request.verificationAttemptId,
          verificationRequestId: request.verificationRequestId, flowId: request.flowId, taskRunId: request.taskRunId,
          attemptId: request.attemptId, candidateId: request.candidateId, requestDigest: request.requestDigest,
          changeSetDigest: request.changeSetDigest, qaConfigVersion: request.qaConfigVersion,
          diagnosticArtifactIds: [] as ArtifactId[], evidenceArtifactIds: [] as ArtifactId[],
          verdict: 'FAIL' as const,
          checks: [{ checkId: 'candidate.non-empty', summary: '候选未产生可交付变更', artifactIds: [] as ArtifactId[], verdict: 'FAIL' as const }] as const,
          failure: { source: 'VERIFICATION_LOGIC_FAILURE' as const, failureClass: 'LOGIC_FAILURE' as const,
            disposition: 'REQUIRE_HUMAN_GATE' as const, retryOrdinal: 0 as const, safeCode: 'UNSATISFIED_ACCEPTANCE_CRITERIA' as const },
          reason: 'TASK_CANDIDATE_EMPTY',
        }
        const receipt = { ...receiptWithoutDigest, receiptDigest: verificationReceiptDigestV1(receiptWithoutDigest) }
        return { verdict: 'FAIL', candidateDigest: audited.candidate.resultTreeHash, receiptDigest: receipt.receiptDigest,
          receiptJson: JSON.stringify(receipt), diagnostic: '候选未产生可交付变更，请完成任务要求后再次结束运行。' }
      }
      const projectRoot = await this.projectResolver.resolveProjectRoot(input.projectId)
      const result = await this.verificationPort.verify(request, {
        verificationScope: 'TASK',
        artifactPaths: audited.changedFiles.map(file => file.relativePath),
        worktreeRoot: audited.privateVerificationContext.worktreeRoot,
        trustedToolchainRoot: projectRoot,
        scopeEvidenceArtifactId: ids.scopeEvidenceArtifactId,
        inspectionArtifactId: ids.inspectionArtifactId,
        ...('authorizationDigest' in audited.privateVerificationContext
          ? { worktreeAuthorizationDigest: audited.privateVerificationContext.authorizationDigest }
          : {}),
      })
      if (result.receipt.candidateId !== request.candidateId || result.receipt.requestDigest !== request.requestDigest) {
        return { verdict: 'OUTCOME_UNKNOWN', candidateDigest: audited.candidate.resultTreeHash, reason: 'VERIFICATION_RECEIPT_MISMATCH' }
      }
      const receiptJson = JSON.stringify(result.receipt)
      if (result.receipt.verdict === 'PASS') return { verdict: 'PASS', candidateDigest: audited.candidate.resultTreeHash, receiptDigest: result.receipt.receiptDigest, receiptJson }
      if (result.receipt.verdict === 'FAIL') return {
        verdict: 'FAIL', candidateDigest: audited.candidate.resultTreeHash, receiptDigest: result.receipt.receiptDigest, receiptJson,
        diagnostic: verificationDiagnosticText(result),
      }
      return { verdict: 'OUTCOME_UNKNOWN', candidateDigest: audited.candidate.resultTreeHash, reason: result.receipt.reason ?? 'TASK_VERIFICATION_UNKNOWN' }
    } catch {
      return { verdict: 'OUTCOME_UNKNOWN', candidateDigest: input.candidateDigest, reason: 'UNSETTLED_VERIFICATION_FAILED' }
    }
  }
}

function verificationDiagnosticText(result: Awaited<ReturnType<TaskVerificationExecutionPortV1['verify']>>): string {
  const artifactText = result.artifacts
    .filter(artifact => artifact.kind === 'VERIFICATION_DIAGNOSTIC')
    .map(artifact => Buffer.from(artifact.content).toString('utf8'))
    .join('\n')
  const checks = result.receipt.verdict === 'FAIL'
    ? result.receipt.checks.map(check => `${check.checkId}:${check.summary}`).join('\n')
    : ''
  return [result.receipt.reason, checks, artifactText].filter(Boolean).join('\n').slice(0, 8_000)
}

export interface TaskVerificationSucceededInputV1 {
  readonly address: HubAddressV1
  readonly flowId: FlowId
  readonly taskRunId: TaskRunId
  readonly attemptId: AttemptId
  readonly outcome: Extract<RuntimeOutcomeV1, { state: 'SUCCEEDED' }>
  readonly createdAt: string
  readonly reconcileStart?: {
    readonly idempotency: IdempotencyInput
    readonly receipt: PerformReceiptV1
    readonly expectedReceiptDigest?: string
  }
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
  readonly attemptRoleProvider?: {
    readAttemptRole(attemptId: AttemptId): 'RESEARCH' | 'IMPLEMENT' | 'REVIEW' | null
  }
  readonly now?: () => string
  readonly onVerifiedTask?: (input: {
    address: HubAddressV1
    flowId: FlowId
    taskRunId: TaskRunId
    attemptId: AttemptId
    candidateDigest: Sha256Digest
    taskChangeSetDigest: Sha256Digest
    taskChangeSetId: TaskChangeSetId
  }) => Promise<void>
  readonly isAuthorizedV2Attempt?: (attemptId: AttemptId) => Promise<boolean>
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
    if (this.options.onVerifiedTask && this.options.isAuthorizedV2Attempt) {
      for (const candidate of this.storeInstance().automaticDeliveryCandidates()) {
        if (this.closed) break
        try {
          if (await this.options.isAuthorizedV2Attempt(candidate.attemptId)) {
            await this.options.onVerifiedTask(candidate)
          }
        } catch { /* Keep the sealed verification; the next recovery retries the exact candidate. */ }
      }
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
    const privateAttempt = store.attempt(input.attemptId)
    const taskRun = projection?.taskRuns.find((candidate) => candidate.taskRunId === input.taskRunId)
    const sourceStatus = input.reconcileStart ? 'OUTCOME_UNKNOWN' : 'RUNNING'
    if (
      !projection ||
      !planRevisionId ||
      projection.activeFlow?.flowId !== input.flowId ||
      attempt?.taskRunId !== input.taskRunId ||
      attempt.status !== sourceStatus ||
      privateAttempt?.task_run_id !== input.taskRunId ||
      privateAttempt.status !== sourceStatus ||
      privateAttempt.runtime_session_id !== input.outcome.runtimeSessionId ||
      taskRun?.attemptId !== input.attemptId ||
      taskRun.status !== sourceStatus
    ) {
      return { ok: false, reasonCode: 'TASK_VERIFICATION_BINDING_MISMATCH' }
    }

    let ancestorTaskChangeSetIds: readonly TaskChangeSetId[]
    try {
      ancestorTaskChangeSetIds = store.taskChangeSetAncestorIds(input.address, input.flowId, input.taskRunId)
    } catch {
      return { ok: false, reasonCode: 'TASK_VERIFICATION_STORE_REJECTED' }
    }

    let attemptRole: 'RESEARCH' | 'IMPLEMENT' | 'REVIEW' | null = null
    try {
      attemptRole = this.options.attemptRoleProvider?.readAttemptRole(input.attemptId) ?? null
    } catch {
      return { ok: false, reasonCode: 'TASK_VERIFICATION_BINDING_MISMATCH' }
    }
    const allowNoApprovedChanges = attemptRole === 'RESEARCH' || attemptRole === 'REVIEW'

    let audited: TaskCandidateAuditResultV1
    try {
      audited = await this.options.candidateAudit.captureTaskCandidate({
        flowId: input.flowId,
        taskRunId: input.taskRunId,
        attemptId: input.attemptId,
        createdAt: this.timestamp(input.createdAt),
        runtimeSignal: runtimeSignal(input.outcome),
        ancestorTaskChangeSetIds,
        allowNoApprovedChanges,
      })
    } catch {
      return { ok: false, reasonCode: 'TASK_VERIFICATION_CAPTURE_FAILED' }
    }
    if (this.options.attemptRoleProvider && !attemptRole && audited.captureVersion !== 2) {
      return { ok: false, reasonCode: 'TASK_VERIFICATION_BINDING_MISMATCH' }
    }
    if (allowNoApprovedChanges && audited.changedFiles.length !== 0) {
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
      qaConfigVersion: MODE_VERIFICATION_POLICY_V1[projection!.authoritativeMode].task,
      acceptanceCriteria: ['approved-file-scope', ...MODE_VERIFICATION_POLICY_V1[projection!.authoritativeMode].checks],
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
        ...(input.reconcileStart
          ? {
              reconcileStart: {
                idempotency: input.reconcileStart.idempotency,
                receipt: input.reconcileStart.receipt,
                runtimeSessionId: input.outcome.runtimeSessionId,
                expectedReceiptDigest: input.reconcileStart.expectedReceiptDigest,
                receiptDigest: input.outcome.receiptDigest,
              },
            }
          : {}),
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
        verificationScope: 'TASK',
        artifactPaths: audited.changedFiles.map(file => file.relativePath),
        worktreeRoot: audited.privateVerificationContext.worktreeRoot,
        trustedToolchainRoot: projectRoot,
        scopeEvidenceArtifactId: ids.scopeEvidenceArtifactId,
        inspectionArtifactId: ids.inspectionArtifactId,
        ...('authorizationDigest' in audited.privateVerificationContext
          ? { worktreeAuthorizationDigest: audited.privateVerificationContext.authorizationDigest }
          : {}),
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
      return this.completeOrDegradeToUnknown(input.address, request, ids.inspectionArtifactId, {
        receipt: result.receipt,
        evidenceArtifacts,
        diagnosticArtifacts,
        now: this.now(),
      })
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

    const completed = await this.completeOrDegradeToUnknown(input.address, request, ids.inspectionArtifactId, {
      receipt: result.receipt,
      evidenceBundle,
      qaResult,
      taskChangeSet: changeSet,
      evidenceArtifacts,
      diagnosticArtifacts,
      now: this.now(),
    })
    if (completed.ok && completed.verdict === 'PASS' && audited.captureVersion === 2 && this.options.onVerifiedTask) {
      try {
        await this.options.onVerifiedTask({ address: input.address, flowId: input.flowId, taskRunId: input.taskRunId,
          attemptId: input.attemptId, candidateDigest: audited.candidate.candidateDigest,
          taskChangeSetDigest: changeSet.digest, taskChangeSetId: changeSet.taskChangeSetId })
      } catch { /* Verification stays authoritative; recovery may retry automatic Delivery. */ }
    }
    return completed
  }

  private async completeOrDegradeToUnknown(
    address: HubAddressV1,
    request: TaskVerificationRequestV1,
    diagnosticArtifactId: ArtifactId,
    record: Parameters<CollaborationHubSqliteStoreV1['completeTaskVerification']>[1],
  ): Promise<TaskVerificationCoordinatorResultV1> {
    try {
      const completed = this.storeInstance().completeTaskVerification(address, record)
      return {
        ok: true,
        verificationAttemptId: request.verificationAttemptId,
        verdict: completed.verdict,
      }
    } catch {
      try {
        const completed = await this.completeWithUnknown(
          address,
          request,
          diagnosticArtifactId,
          'TASK_VERIFICATION_COMPLETION_REJECTED',
        )
        return {
          ok: true,
          verificationAttemptId: request.verificationAttemptId,
          verdict: completed.verdict,
        }
      } catch {
        return { ok: false, reasonCode: 'TASK_VERIFICATION_STORE_REJECTED' }
      }
    }
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
