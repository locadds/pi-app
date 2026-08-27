/**
 * 协作计划 Hub 强类型薄客户端。
 *
 * 只封装 observe / perform 两个 IPC 通道：
 * - observe 读取 m2b.v1 投影（M3B 只读切片：taskRuns/attempts 真实状态）；
 * - perform 仍走 m2a.v1 用户意图（主进程 perform 仅接受 m2a.v1）。
 * - address 只接受当前会话 canonicalScope 的 projectId + sessionKey，
 *   不接收路径、mode、actor 或 SQLite key（actor 由主进程注入 trustedActor）。
 * - 返回值仅为共享契约 HubOutcomeV1；IPC 异常/非约定报文统一映射为安全
 *   INTERNAL 错误，绝不把异常栈或原始 IPC 内容抛给上层展示。
 */

import type {
  AttemptProjectionM2BV1,
  AttemptStatusM2BV1,
  CollaborationHubActionM2BV1,
  CollaborationHubActionV1,
  HubAddressV1,
  HubErrorCodeV1,
  HubOutcomeV1,
  HubSafeErrorV1,
  PerformReceiptV1,
  SessionCollaborationProjectionM2BV1,
  TaskRunProjectionM2BV1,
  TaskRunStatusM2BV1,
  UserIntentRequestV1,
} from '@shared/xiaogui-collaboration-hub'
import type {
  DeliveryApplyAttemptV1,
  DeliveryApplySafeCodeV1,
  DeliveryBatchProjectionV1,
  DeliveryBatchStateV1,
  DeliveryFileChangeSummaryV1,
  DeliveryGateSubjectV1,
  DeliveryHumanGateV1,
  DeliveryRecoveryLineageV1,
} from '@shared/xiaogui-delivery'
import type {
  XiaoguiDeliveryApproveGateRequestV1,
  XiaoguiDeliveryOutcomeV1,
  XiaoguiDeliveryPrepareRecoveryRequestV1,
  XiaoguiDeliveryReconcileApplyRequestV1,
  XiaoguiDeliveryReturnBatchRequestV1,
  XiaoguiDeliveryRetryApplyRequestV1,
  XiaoguiDeliverySafeErrorV1,
  XiaoguiDeliverySelectTasksRequestV1,
} from '@shared/xiaogui-delivery-ipc'
import type {
  XiaoguiTaskExecutionErrorCodeV1,
  XiaoguiTaskExecutionSafeErrorV1,
  XiaoguiTaskExecutionStartBatchOutcomeV1,
  XiaoguiTaskExecutionStartBatchRequestV1,
  XiaoguiTaskExecutionStartBatchResultV1,
  XiaoguiTaskExecutionStartOutcomeV1,
  XiaoguiTaskExecutionStartRequestV1,
  XiaoguiTaskExecutionStartResultV1,
} from '@shared/xiaogui-task-execution'
import { XIAOGUI_TASK_EXECUTION_BATCH_CONTRACT_VERSION_V1 } from '@shared/xiaogui-task-execution'
import type { TaskArtifactRefV1, TaskVerificationSummaryV1 } from '@shared/xiaogui-task-verification'

import { ipcClient } from '@renderer/lib/ipc-client'

/** perform（用户意图）契约版本：主进程 perform 仅接受 m2a.v1。 */
export const HUB_CONTRACT_VERSION = 'm2a.v1'
/** observe（只读投影）契约版本：M3B 起读取 m2b.v1 投影。 */
export const HUB_OBSERVE_CONTRACT_VERSION = 'm2b.v1'
/** 交付审阅/应用 IPC 契约版本：Renderer 只提交用户意图。 */
export const DELIVERY_CONTRACT_VERSION = 'm4d.v1'

/** IPC 层失败（拒绝、非约定返回）的安全映射；traceId 为空表示主进程未给出。 */
function ipcFailureError(): HubSafeErrorV1 {
  return { code: 'INTERNAL', messageKey: 'xiaogui.hub.error.ipc', traceId: '' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const HUB_ERROR_CODES = new Set<HubErrorCodeV1>([
  'SESSION_SCOPE_MISMATCH',
  'DESIGN_RESERVED',
  'DRAFT_INVALID',
  'ACTIVE_FLOW_EXISTS',
  'FLOW_NOT_FOUND',
  'REVISION_NOT_FOUND',
  'REVISION_CONFLICT',
  'STALE_SESSION_VERSION',
  'IDEMPOTENCY_CONFLICT',
  'INTENT_DISABLED',
  'IPC_VERSION_UNSUPPORTED',
  'INTERNAL',
])

const HUB_ACTIONS = new Set<CollaborationHubActionV1>(['flow.start.with_draft', 'plan.revision.submit', 'flow.cancel'])
const HUB_M2B_ACTIONS = new Set<CollaborationHubActionM2BV1>([...HUB_ACTIONS, 'execution.next.confirm'])
const HUB_TRACE_ID = /^xhbt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DELIVERY_TRACE_ID = /^xhbd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TASK_EXECUTION_TRACE_ID = /^xhbet_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/

const TASK_EXECUTION_ERROR_CODES = new Set<XiaoguiTaskExecutionErrorCodeV1>([
  'SESSION_SCOPE_MISMATCH',
  'DESIGN_RESERVED',
  'WORK_NOT_SUPPORTED',
  'FLOW_NOT_READY',
  'EXECUTION_INPUT_INVALID',
  'EXECUTION_IN_PROGRESS',
  'AGENT_UNAVAILABLE',
  'BASELINE_UNAVAILABLE',
  'WORKSPACE_PREPARATION_FAILED',
  'OUTCOME_UNKNOWN',
  'INTERNAL',
])

const DELIVERY_ERROR_CODES = new Set<XiaoguiDeliverySafeErrorV1['code']>([
  'IPC_VERSION_UNSUPPORTED',
  'DELIVERY_INPUT_INVALID',
  'STALE_DELIVERY_SUBJECT',
  'DELIVERY_NOT_FOUND',
  'ILLEGAL_TRANSITION',
  'INTERNAL',
])

const DELIVERY_STATES = new Set<DeliveryBatchStateV1>([
  'COMPOSING',
  'VERIFYING',
  'READY_FOR_REVIEW',
  'APPROVED',
  'REJECTED',
  'APPLYING',
  'APPLIED',
  'SUPERSEDED',
  'OUTCOME_UNKNOWN',
])

const DELIVERY_APPLY_SAFE_CODES = new Set<DeliveryApplySafeCodeV1>([
  'APPROVAL_SUBJECT_MISMATCH',
  'DELIVERY_CHANGESET_DIGEST_MISMATCH',
  'DELIVERY_FILE_INVALID',
  'TARGET_BASELINE_DRIFT',
  'TARGET_STATUS_DIRTY',
  'TARGET_FILE_DRIFT',
  'TARGET_WRITE_FAILED',
  'ROLLBACK_INCOMPLETE',
  'APPLY_ATTEMPT_CONFLICT',
  'APPLY_ATTEMPT_NOT_FOUND',
])

const INTENT_TYPES = new Set([
  ...HUB_ACTIONS,
  'flow.start',
  'agent.revision.proposal.record',
  'task.run.guide',
  'task.run.cancel',
  'attempt.interrupt',
  'delivery.selection.submit',
  'gate.decide',
  'apply.reconcile.request',
  'apply.retry.request',
  'apply.recovery.prepare',
  'correction.create',
  'system.schedule',
  'system.workspace.prepare.result.record',
  'system.agent.report.record',
  'system.agent.outcome.record',
  'system.agent.reconcile',
])

for (const action of [
  'delivery.selection.submit',
  'delivery.gate.approve',
  'delivery.gate.reject',
  'apply.reconcile.request',
  'apply.retry.request',
  'apply.recovery.prepare',
] as const) {
  HUB_M2B_ACTIONS.add(action)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => key in value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isTaskArtifactRef(value: unknown): value is TaskArtifactRefV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['artifactId', 'digest', 'kind']) &&
    isNonEmptyString(value.artifactId) &&
    typeof value.digest === 'string' &&
    SHA256_DIGEST.test(value.digest) &&
    ['PATCH', 'QA_EVIDENCE', 'QA_DIAGNOSTIC'].includes(String(value.kind))
  )
}

function isVerificationCheckSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['checkId', 'summary', 'verdict']) &&
    isNonEmptyString(value.checkId) &&
    isNonEmptyString(value.summary) &&
    ['PASS', 'FAIL'].includes(String(value.verdict))
  )
}

function isVerificationFailure(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['source', 'failureClass', 'disposition', 'retryOrdinal', 'safeCode']) ||
    !Number.isSafeInteger(value.retryOrdinal)
  )
    return false

  if (value.source === 'QA_CHECKS_FAILED') {
    return (
      value.failureClass === 'TEST_FAILURE' &&
      value.disposition === 'REQUIRE_HUMAN_GATE' &&
      value.retryOrdinal === 0 &&
      value.safeCode === 'QA_CHECK_FAILED'
    )
  }
  if (value.source === 'VERIFICATION_LOGIC_FAILURE') {
    return (
      value.failureClass === 'LOGIC_FAILURE' &&
      value.disposition === 'REQUIRE_HUMAN_GATE' &&
      value.retryOrdinal === 0 &&
      ['INVALID_AGENT_RESULT', 'UNSATISFIED_ACCEPTANCE_CRITERIA', 'EXECUTION_LOGIC_ERROR'].includes(String(value.safeCode))
    )
  }
  if (value.source === 'VERIFICATION_POLICY_DENIED') {
    return (
      value.failureClass === 'POLICY_DENIED' &&
      value.disposition === 'REQUIRE_HUMAN_GATE' &&
      value.retryOrdinal === 0 &&
      ['POLICY_DENIED', 'EXECUTOR_NOT_ALLOWED'].includes(String(value.safeCode))
    )
  }
  if (value.source === 'VERIFICATION_TRANSIENT_INFRASTRUCTURE') {
    return (
      value.failureClass === 'TRANSIENT_INFRASTRUCTURE' &&
      value.disposition === 'AUTO_RETRY' &&
      (value.retryOrdinal === 1 || value.retryOrdinal === 2) &&
      value.safeCode === 'VERIFICATION_TEMPORARILY_UNAVAILABLE'
    )
  }
  if (value.source === 'VERIFICATION_TRANSIENT_BUDGET_EXCEEDED') {
    return (
      value.failureClass === 'TRANSIENT_INFRASTRUCTURE' &&
      value.disposition === 'REQUIRE_HUMAN_GATE' &&
      (value.retryOrdinal as number) >= 3 &&
      value.safeCode === 'VERIFICATION_TEMPORARILY_UNAVAILABLE'
    )
  }
  return (
    value.source === 'VERIFICATION_PERMANENT_INFRASTRUCTURE' &&
    value.failureClass === 'PERMANENT_INFRASTRUCTURE' &&
    value.disposition === 'REQUIRE_HUMAN_GATE' &&
    value.retryOrdinal === 0 &&
    value.safeCode === 'WORKSPACE_INTERNAL_ERROR'
  )
}

function isTaskVerificationSummary(value: unknown): value is TaskVerificationSummaryV1 {
  if (!isRecord(value)) return false
  const baseKeys = [
    'scope',
    'verificationAttemptId',
    'candidateId',
    'changeSetDigest',
    'qaConfigVersion',
    'diagnosticArtifacts',
    'state',
  ] as const
  if (
    value.scope !== 'TASK' ||
    !isNonEmptyString(value.verificationAttemptId) ||
    !isNonEmptyString(value.candidateId) ||
    typeof value.changeSetDigest !== 'string' ||
    !SHA256_DIGEST.test(value.changeSetDigest) ||
    !isNonEmptyString(value.qaConfigVersion) ||
    !Array.isArray(value.diagnosticArtifacts) ||
    !value.diagnosticArtifacts.every(isTaskArtifactRef)
  )
    return false

  if (value.state === 'STARTED') return hasExactKeys(value, baseKeys)
  if (value.state === 'FAILED') {
    return (
      hasExactKeys(value, [...baseKeys, 'verdict', 'checks', 'failure']) &&
      value.verdict === 'FAIL' &&
      Array.isArray(value.checks) &&
      value.checks.every(isVerificationCheckSummary) &&
      isVerificationFailure(value.failure)
    )
  }
  if (value.state === 'OUTCOME_UNKNOWN') {
    return hasExactKeys(value, [...baseKeys, 'verdict']) && value.verdict === 'OUTCOME_UNKNOWN'
  }
  return (
    value.state === 'SUCCEEDED' &&
    hasExactKeys(value, [
      ...baseKeys,
      'verdict',
      'checks',
      'evidenceBundleId',
      'qaResultId',
      'taskChangeSetId',
      'evidenceArtifacts',
    ]) &&
    value.verdict === 'PASS' &&
    Array.isArray(value.checks) &&
    value.checks.every(isVerificationCheckSummary) &&
    isNonEmptyString(value.evidenceBundleId) &&
    isNonEmptyString(value.qaResultId) &&
    isNonEmptyString(value.taskChangeSetId) &&
    Array.isArray(value.evidenceArtifacts) &&
    value.evidenceArtifacts.every(isTaskArtifactRef)
  )
}

function isSafeError(value: unknown): value is HubSafeErrorV1 {
  if (!isRecord(value) || typeof value.code !== 'string' || !HUB_ERROR_CODES.has(value.code as HubErrorCodeV1)) {
    return false
  }
  if (
    typeof value.messageKey !== 'string' ||
    typeof value.traceId !== 'string' ||
    (value.traceId !== '' && !HUB_TRACE_ID.test(value.traceId))
  )
    return false
  if (value.safeArgs === undefined) return true
  return isRecord(value.safeArgs) && Object.values(value.safeArgs).every((item) => ['string', 'number', 'boolean'].includes(typeof item))
}

function isTaskExecutionSafeError(value: unknown): value is XiaoguiTaskExecutionSafeErrorV1 {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    TASK_EXECUTION_ERROR_CODES.has(value.code as XiaoguiTaskExecutionErrorCodeV1) &&
    typeof value.messageKey === 'string' &&
    typeof value.traceId === 'string' &&
    (value.traceId === '' || TASK_EXECUTION_TRACE_ID.test(value.traceId))
  )
}

function isDeliverySafeError(value: unknown): value is XiaoguiDeliverySafeErrorV1 {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    DELIVERY_ERROR_CODES.has(value.code as XiaoguiDeliverySafeErrorV1['code']) &&
    typeof value.messageKey === 'string' &&
    typeof value.traceId === 'string' &&
    (value.traceId === '' || DELIVERY_TRACE_ID.test(value.traceId))
  )
}

function isPlanTask(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.taskKey === 'string' &&
    typeof value.title === 'string' &&
    (value.summary === undefined || typeof value.summary === 'string') &&
    (value.dependsOn === undefined || isStringArray(value.dependsOn))
  )
}

function isDraft(value: unknown): boolean {
  return isRecord(value) && typeof value.objective === 'string' && Array.isArray(value.tasks) && value.tasks.every(isPlanTask)
}

function isFlow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.flowId === 'string' &&
    ['AWAITING_PLAN_APPROVAL', 'PLAN_ACTIVE', 'CANCELLED'].includes(String(value.status)) &&
    (value.activeRevisionId === null || typeof value.activeRevisionId === 'string') &&
    typeof value.objective === 'string'
  )
}

const TASK_RUN_STATUSES_M2B = new Set<TaskRunStatusM2BV1>([
  'BLOCKED',
  'DEPENDENCY_ELIGIBLE',
  'READY',
  'RUNNING',
  'VERIFYING',
  'FAILED',
  'VERIFIED',
  'DELIVERY_PENDING',
  'APPLYING',
  'CANCEL_REQUESTED',
  'DONE',
  'INTERRUPT_REQUESTED',
  'OUTCOME_UNKNOWN',
  'CANCELLED',
  'INVALIDATED',
  'SUPERSEDED',
])

const ATTEMPT_STATUSES_M2B = new Set<AttemptStatusM2BV1>([
  'CREATED',
  'WORKSPACE_PREPARING',
  'READY',
  'STARTING',
  'RUNNING',
  'VERIFYING',
  'INTERRUPT_REQUESTED',
  'OUTCOME_UNKNOWN',
  'SUCCEEDED',
  'FAILED',
  'INTERRUPTED',
  'CANCELLED',
])

function isTaskRunM2B(value: unknown): value is TaskRunProjectionM2BV1 {
  return (
    isRecord(value) &&
    typeof value.taskRunId === 'string' &&
    typeof value.taskSpecId === 'string' &&
    typeof value.taskKey === 'string' &&
    TASK_RUN_STATUSES_M2B.has(value.status as TaskRunStatusM2BV1) &&
    (value.unavailableReason === undefined || value.unavailableReason === 'AGENT_DISABLED_M2A') &&
    (value.attemptId === undefined || typeof value.attemptId === 'string')
  )
}

function isAttemptM2B(value: unknown): value is AttemptProjectionM2BV1 {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ['attemptId', 'taskRunId', 'status', 'runtimeSessionId', 'workspaceReceiptId', 'verificationSummary'].includes(key),
    ) &&
    typeof value.attemptId === 'string' &&
    typeof value.taskRunId === 'string' &&
    ATTEMPT_STATUSES_M2B.has(value.status as AttemptStatusM2BV1) &&
    (value.runtimeSessionId === undefined || typeof value.runtimeSessionId === 'string') &&
    (value.workspaceReceiptId === undefined || typeof value.workspaceReceiptId === 'string') &&
    (value.verificationSummary === undefined || isTaskVerificationSummary(value.verificationSummary))
  )
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    !value.includes('\0') &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !value.startsWith('file://') &&
    !value.split(/[\\/]/).some((segment) => segment === '' || segment === '.' || segment === '..')
  )
}

function isDeliveryFileChangeSummary(value: unknown): value is DeliveryFileChangeSummaryV1 {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ['operation', 'relativePath', 'baselineDigest', 'contentDigest', 'contentArtifactId', 'sourceTaskChangeSetIds'].includes(key),
    ) &&
    (value.operation === 'MODIFY' || value.operation === 'CREATE') &&
    typeof value.relativePath === 'string' &&
    isSafeRelativePath(value.relativePath) &&
    (value.baselineDigest === null || (typeof value.baselineDigest === 'string' && SHA256_DIGEST.test(value.baselineDigest))) &&
    typeof value.contentDigest === 'string' &&
    SHA256_DIGEST.test(value.contentDigest) &&
    isNonEmptyString(value.contentArtifactId) &&
    isStringArray(value.sourceTaskChangeSetIds)
  )
}

function isDeliveryGateSubject(value: unknown): value is DeliveryGateSubjectV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['deliveryChangeSetId', 'version', 'digest']) &&
    isNonEmptyString(value.deliveryChangeSetId) &&
    value.version === 1 &&
    typeof value.digest === 'string' &&
    SHA256_DIGEST.test(value.digest)
  )
}

function isDeliveryGate(value: unknown): value is DeliveryHumanGateV1 {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ['gateId', 'batchId', 'subject', 'state', 'decisionDigest', 'decidedAt', 'createdAt'].includes(key),
    ) &&
    isNonEmptyString(value.gateId) &&
    isNonEmptyString(value.batchId) &&
    isDeliveryGateSubject(value.subject) &&
    ['OPEN', 'APPROVED', 'REJECTED'].includes(String(value.state)) &&
    (value.decisionDigest === undefined || (typeof value.decisionDigest === 'string' && SHA256_DIGEST.test(value.decisionDigest))) &&
    (value.decidedAt === undefined || typeof value.decidedAt === 'string') &&
    typeof value.createdAt === 'string'
  )
}

function isDeliveryApplyAttempt(value: unknown): value is DeliveryApplyAttemptV1 {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      [
        'applyAttemptId',
        'batchId',
        'deliveryChangeSetId',
        'requestDigest',
        'targetFingerprintBefore',
        'state',
        'receiptDigest',
        'safeCode',
        'changedRelativePaths',
        'targetFingerprintAfter',
        'startedAt',
        'finishedAt',
      ].includes(key),
    ) &&
    isNonEmptyString(value.applyAttemptId) &&
    isNonEmptyString(value.batchId) &&
    isNonEmptyString(value.deliveryChangeSetId) &&
    typeof value.requestDigest === 'string' &&
    SHA256_DIGEST.test(value.requestDigest) &&
    typeof value.targetFingerprintBefore === 'string' &&
    SHA256_DIGEST.test(value.targetFingerprintBefore) &&
    ['STARTED', 'SUCCEEDED', 'FAILED', 'FAILED_ROLLED_BACK', 'OUTCOME_UNKNOWN'].includes(String(value.state)) &&
    (value.receiptDigest === undefined || (typeof value.receiptDigest === 'string' && SHA256_DIGEST.test(value.receiptDigest))) &&
    (value.safeCode === undefined || DELIVERY_APPLY_SAFE_CODES.has(value.safeCode as DeliveryApplySafeCodeV1)) &&
    (value.changedRelativePaths === undefined ||
      (isStringArray(value.changedRelativePaths) && value.changedRelativePaths.every(isSafeRelativePath))) &&
    (value.targetFingerprintAfter === undefined ||
      (typeof value.targetFingerprintAfter === 'string' && SHA256_DIGEST.test(value.targetFingerprintAfter))) &&
    typeof value.startedAt === 'string' &&
    (value.finishedAt === undefined || typeof value.finishedAt === 'string')
  )
}

function isDeliveryRecoveryLineage(value: unknown): value is DeliveryRecoveryLineageV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'sourceBatchId',
      'sourceDeliveryChangeSetId',
      'sourceDeliveryChangeSetDigest',
      'sourceTargetFingerprint',
      'currentTargetFingerprint',
    ]) &&
    isNonEmptyString(value.sourceBatchId) &&
    isNonEmptyString(value.sourceDeliveryChangeSetId) &&
    typeof value.sourceDeliveryChangeSetDigest === 'string' &&
    SHA256_DIGEST.test(value.sourceDeliveryChangeSetDigest) &&
    typeof value.sourceTargetFingerprint === 'string' &&
    SHA256_DIGEST.test(value.sourceTargetFingerprint) &&
    typeof value.currentTargetFingerprint === 'string' &&
    SHA256_DIGEST.test(value.currentTargetFingerprint)
  )
}

function isDeliveryBatchProjection(value: unknown): value is DeliveryBatchProjectionV1 {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      [
        'batchId',
        'flowId',
        'state',
        'selectionDigest',
        'selectedTaskRunIds',
        'taskChangeSetIds',
        'targetFingerprint',
        'deliveryChangeSetId',
        'deliveryChangeSetDigest',
        'recoverySourceBatchId',
        'recoveryLineage',
        'fileChangeSummaries',
        'evidenceArtifactIds',
        'qaConfigVersion',
        'gate',
        'applyAttempt',
      ].includes(key),
    ) &&
    isNonEmptyString(value.batchId) &&
    isNonEmptyString(value.flowId) &&
    DELIVERY_STATES.has(value.state as DeliveryBatchStateV1) &&
    typeof value.selectionDigest === 'string' &&
    SHA256_DIGEST.test(value.selectionDigest) &&
    isStringArray(value.selectedTaskRunIds) &&
    isStringArray(value.taskChangeSetIds) &&
    typeof value.targetFingerprint === 'string' &&
    SHA256_DIGEST.test(value.targetFingerprint) &&
    (value.deliveryChangeSetId === undefined || isNonEmptyString(value.deliveryChangeSetId)) &&
    (value.deliveryChangeSetDigest === undefined ||
      (typeof value.deliveryChangeSetDigest === 'string' && SHA256_DIGEST.test(value.deliveryChangeSetDigest))) &&
    (value.recoverySourceBatchId === undefined || isNonEmptyString(value.recoverySourceBatchId)) &&
    (value.recoveryLineage === undefined || isDeliveryRecoveryLineage(value.recoveryLineage)) &&
    (value.fileChangeSummaries === undefined ||
      (Array.isArray(value.fileChangeSummaries) && value.fileChangeSummaries.every(isDeliveryFileChangeSummary))) &&
    (value.evidenceArtifactIds === undefined || isStringArray(value.evidenceArtifactIds)) &&
    (value.qaConfigVersion === undefined || typeof value.qaConfigVersion === 'string') &&
    (value.gate === undefined || isDeliveryGate(value.gate)) &&
    (value.applyAttempt === undefined || isDeliveryApplyAttempt(value.applyAttempt))
  )
}

function isProjection(value: unknown): value is SessionCollaborationProjectionM2BV1 {
  if (!isRecord(value) || value.kind !== 'SESSION_COLLABORATION_PROJECTION' || value.version !== 'm2b.v1') return false
  if (
    !isRecord(value.address) ||
    typeof value.address.projectId !== 'string' ||
    typeof value.address.sessionKey !== 'string' ||
    !Number.isSafeInteger(value.sessionVersion) ||
    (value.sessionVersion as number) < 0 ||
    !['WORK', 'DESIGN', 'CODING'].includes(String(value.sessionMode)) ||
    !['WORK', 'DESIGN', 'CODING'].includes(String(value.authoritativeMode))
  )
    return false

  const reserved = value.reserved
  if (
    reserved !== false &&
    (!isRecord(reserved) || reserved.code !== 'DESIGN_RESERVED' || reserved.messageKey !== 'xiaogui.hub.design_reserved')
  )
    return false

  const revision = value.activeRevision
  if (
    revision !== null &&
    (!isRecord(revision) ||
      typeof revision.revisionId !== 'string' ||
      !['DRAFT', 'ACTIVE'].includes(String(revision.status)) ||
      typeof revision.digest !== 'string' ||
      !isDraft(revision.draft))
  )
    return false

  if (value.activeFlow !== null && !isFlow(value.activeFlow)) return false
  if (!Array.isArray(value.history) || !value.history.every(isFlow)) return false
  if (
    !Array.isArray(value.taskSpecs) ||
    !value.taskSpecs.every(
      (item) =>
        isRecord(item) &&
        typeof item.taskSpecId === 'string' &&
        typeof item.taskKey === 'string' &&
        typeof item.title === 'string' &&
        (item.summary === undefined || typeof item.summary === 'string') &&
        isStringArray(item.dependsOn) &&
        item.unavailableReason === 'AGENT_DISABLED_M2A',
    )
  )
    return false
  if (!Array.isArray(value.taskRuns) || !value.taskRuns.every(isTaskRunM2B)) return false
  if (!Array.isArray(value.attempts) || !value.attempts.every(isAttemptM2B)) return false
  if (value.activeDelivery !== undefined && value.activeDelivery !== null && !isDeliveryBatchProjection(value.activeDelivery)) return false

  // 关系校验：id 唯一且引用一致，避免 orphan/mismatched attempt 被静默隐藏
  const taskRuns = value.taskRuns as SessionCollaborationProjectionM2BV1['taskRuns']
  const attempts = value.attempts as SessionCollaborationProjectionM2BV1['attempts']
  if (new Set(taskRuns.map((run) => run.taskRunId)).size !== taskRuns.length) return false
  if (new Set(attempts.map((attempt) => attempt.attemptId)).size !== attempts.length) return false
  const runIds = new Set(taskRuns.map((run) => run.taskRunId))
  const attemptById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]))
  for (const attempt of attempts) {
    if (!runIds.has(attempt.taskRunId)) return false
  }
  for (const run of taskRuns) {
    if (run.attemptId === undefined) continue
    const attempt = attemptById.get(run.attemptId)
    if (!attempt || attempt.taskRunId !== run.taskRunId) return false
  }

  return (
    Array.isArray(value.availableActions) &&
    value.availableActions.every(
      (action) => typeof action === 'string' && HUB_M2B_ACTIONS.has(action as CollaborationHubActionM2BV1),
    )
  )
}

function isTaskExecutionResult(value: unknown): value is XiaoguiTaskExecutionStartResultV1 {
  if (!isRecord(value) || !isTaskRunM2B(value.taskRun) || !isAttemptM2B(value.attempt)) return false
  return (
    value.attempt.taskRunId === value.taskRun.taskRunId &&
    (value.taskRun.attemptId === undefined || value.taskRun.attemptId === value.attempt.attemptId)
  )
}

function isReceipt(value: unknown): value is PerformReceiptV1 {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.intentType === 'string' &&
    INTENT_TYPES.has(value.intentType) &&
    Number.isSafeInteger(value.sessionVersion) &&
    (value.sessionVersion as number) >= 0 &&
    (value.flowId === undefined || typeof value.flowId === 'string') &&
    (value.revisionId === undefined || typeof value.revisionId === 'string')
  )
}

function isHubOutcome<T>(value: unknown, isSuccess: (candidate: unknown) => candidate is T): value is HubOutcomeV1<T> {
  if (!isRecord(value)) return false
  if (value.ok === true) return isSuccess(value.value)
  if (value.ok === false) return isSafeError(value.error)
  return false
}

function sameAddress(a: HubAddressV1, b: HubAddressV1): boolean {
  return a.projectId === b.projectId && a.sessionKey === b.sessionKey
}

/** 快照读取当前会话的协作投影（m2b.v1，非订阅流；动作后需重新 observe）。 */
export async function observeCollaborationHub(address: HubAddressV1): Promise<HubOutcomeV1<SessionCollaborationProjectionM2BV1>> {
  try {
    const res: unknown = await ipcClient.invoke('xiaogui.hub.observe', {
      contractVersion: HUB_OBSERVE_CONTRACT_VERSION,
      address,
    })
    if (!isHubOutcome(res, isProjection) || (res.ok && !sameAddress(res.value.address, address))) {
      return { ok: false, error: ipcFailureError() }
    }
    return res
  } catch {
    return { ok: false, error: ipcFailureError() }
  }
}

/** 提交用户意图；requestId 由调用方保证唯一，expectedSessionVersion 取当前投影。 */
export async function performHubIntent(address: HubAddressV1, request: UserIntentRequestV1): Promise<HubOutcomeV1<PerformReceiptV1>> {
  try {
    const res: unknown = await ipcClient.invoke('xiaogui.hub.perform', {
      contractVersion: HUB_CONTRACT_VERSION,
      address,
      request,
    })
    if (
      !isHubOutcome(res, isReceipt) ||
      (res.ok && (res.value.requestId !== request.requestId || res.value.intentType !== request.intent.type))
    ) {
      return { ok: false, error: ipcFailureError() }
    }
    return res
  } catch {
    return { ok: false, error: ipcFailureError() }
  }
}

/** 最终确认一次受控执行；请求不含内部版本、actor、摘要或系统指令。 */
export async function startTaskExecution(
  request: XiaoguiTaskExecutionStartRequestV1,
): Promise<XiaoguiTaskExecutionStartOutcomeV1> {
  try {
    const res: unknown = await ipcClient.invoke('xiaogui.hub.execution.start', request)
    if (isRecord(res) && res.ok === true && isTaskExecutionResult(res.value)) return { ok: true, value: res.value }
    if (isRecord(res) && res.ok === false && isTaskExecutionSafeError(res.error)) return { ok: false, error: res.error }
    return { ok: false, error: { code: 'INTERNAL', messageKey: 'xiaogui.execution.error.ipc', traceId: '' } }
  } catch {
    return { ok: false, error: { code: 'INTERNAL', messageKey: 'xiaogui.execution.error.ipc', traceId: '' } }
  }
}

function taskExecutionIpcFailureError(): XiaoguiTaskExecutionSafeErrorV1 {
  return { code: 'INTERNAL', messageKey: 'xiaogui.execution.error.ipc', traceId: '' }
}

const TASK_RUN_M2B_KEYS = ['taskRunId', 'taskSpecId', 'taskKey', 'status', 'unavailableReason', 'attemptId']

/**
 * batch 专用严格 taskRun 校验：契约键集精确匹配 + 字段类型。
 * 旧单任务路径沿用宽松的 isTaskRunM2B（非精确键），保持兼容不变。
 */
function isTaskRunM2BExact(value: unknown): value is TaskRunProjectionM2BV1 {
  return isRecord(value) && Object.keys(value).every((key) => TASK_RUN_M2B_KEYS.includes(key)) && isTaskRunM2B(value)
}

/** batch 专用严格安全错误：仅 code/messageKey/traceId 三个键。 */
function isTaskExecutionSafeErrorExact(value: unknown): value is XiaoguiTaskExecutionSafeErrorV1 {
  return isRecord(value) && hasExactKeys(value, ['code', 'messageKey', 'traceId']) && isTaskExecutionSafeError(value)
}

/** batch 成功项载荷：仅 taskRun/attempt 精确键；attempt 复用现有精确校验，并校验二者归属一致。 */
function isTaskExecutionBatchItemResult(value: unknown): value is XiaoguiTaskExecutionStartResultV1 {
  if (!isRecord(value) || !hasExactKeys(value, ['taskRun', 'attempt'])) return false
  if (!isTaskRunM2BExact(value.taskRun) || !isAttemptM2B(value.attempt)) return false
  return (
    value.attempt.taskRunId === value.taskRun.taskRunId &&
    (value.taskRun.attemptId === undefined || value.taskRun.attemptId === value.attempt.attemptId)
  )
}

/**
 * 批量结果逐项校验（fail closed）：
 * - 外层只接受 contractVersion + items 精确键集；
 * - 逐项顺序与请求一致，成功项只允许 ok/taskRunId/value，失败项只允许 ok/taskRunId/error；
 * - 成功载荷经 isTaskExecutionBatchItemResult 严格校验（taskRun/attempt 精确键、严格 taskRun、
 *   精确 attempt）；失败载荷经 isTaskExecutionSafeErrorExact 严格校验；
 * - 三层绑定：value.taskRun.taskRunId === item.taskRunId === request.items[index].taskRunId。
 */
function isTaskExecutionBatchResult(
  value: unknown,
  request: XiaoguiTaskExecutionStartBatchRequestV1,
): value is XiaoguiTaskExecutionStartBatchResultV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['contractVersion', 'items']) ||
    value.contractVersion !== XIAOGUI_TASK_EXECUTION_BATCH_CONTRACT_VERSION_V1 ||
    !Array.isArray(value.items) ||
    value.items.length !== request.items.length
  )
    return false
  return value.items.every((item, index) => {
    if (!isRecord(item) || item.taskRunId !== request.items[index]!.taskRunId) return false
    if (item.ok === true) {
      return (
        hasExactKeys(item, ['ok', 'taskRunId', 'value']) &&
        isTaskExecutionBatchItemResult(item.value) &&
        item.value.taskRun.taskRunId === item.taskRunId
      )
    }
    if (item.ok === false) {
      return hasExactKeys(item, ['ok', 'taskRunId', 'error']) && isTaskExecutionSafeErrorExact(item.error)
    }
    return false
  })
}

/**
 * 一次用户确认启动一批（1..2 个）READY 任务；逐项返回成功或安全错误。
 * 请求只含公共 address/flowId 与明确的 taskRunId/prompt/files，不含内部版本或 actor。
 * 顶层响应 fail closed：成功仅 ok/value 精确键，失败仅 ok/error 精确键。
 */
export async function startTaskExecutionBatch(
  request: XiaoguiTaskExecutionStartBatchRequestV1,
): Promise<XiaoguiTaskExecutionStartBatchOutcomeV1> {
  try {
    const res: unknown = await ipcClient.invoke('xiaogui.hub.execution.startBatch', request)
    if (isRecord(res) && res.ok === true && hasExactKeys(res, ['ok', 'value']) && isTaskExecutionBatchResult(res.value, request)) {
      return { ok: true, value: res.value }
    }
    if (isRecord(res) && res.ok === false && hasExactKeys(res, ['ok', 'error']) && isTaskExecutionSafeErrorExact(res.error)) {
      return { ok: false, error: res.error }
    }
    return { ok: false, error: taskExecutionIpcFailureError() }
  } catch {
    return { ok: false, error: taskExecutionIpcFailureError() }
  }
}

function deliveryIpcFailureError(): XiaoguiDeliverySafeErrorV1 {
  return { code: 'INTERNAL', messageKey: 'xiaogui.delivery.error.ipc', traceId: '' }
}

async function invokeDelivery<TRequest>(
  channel: string,
  address: HubAddressV1,
  request: TRequest,
): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
  try {
    const res: unknown = await ipcClient.invoke(channel, {
      contractVersion: DELIVERY_CONTRACT_VERSION,
      address,
      request,
    })
    if (isRecord(res) && res.ok === true && isDeliveryBatchProjection(res.value)) return { ok: true, value: res.value }
    if (isRecord(res) && res.ok === false && isDeliverySafeError(res.error)) return { ok: false, error: res.error }
    return { ok: false, error: deliveryIpcFailureError() }
  } catch {
    return { ok: false, error: deliveryIpcFailureError() }
  }
}

export function submitDeliverySelection(
  address: HubAddressV1,
  request: XiaoguiDeliverySelectTasksRequestV1,
): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
  return invokeDelivery('xiaogui.delivery.selection.submit', address, request)
}

export function approveDeliveryGate(
  address: HubAddressV1,
  request: XiaoguiDeliveryApproveGateRequestV1,
): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
  return invokeDelivery('xiaogui.delivery.gate.approve', address, request)
}

export function returnDeliveryBatch(
  address: HubAddressV1,
  request: XiaoguiDeliveryReturnBatchRequestV1,
): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
  return invokeDelivery('xiaogui.delivery.batch.return', address, request)
}

export function reconcileDeliveryApply(
  address: HubAddressV1,
  request: XiaoguiDeliveryReconcileApplyRequestV1,
): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
  return invokeDelivery('xiaogui.delivery.apply.reconcile', address, request)
}

export function retryDeliveryApply(
  address: HubAddressV1,
  request: XiaoguiDeliveryRetryApplyRequestV1,
): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
  return invokeDelivery('xiaogui.delivery.apply.retry', address, request)
}

export function prepareDeliveryRecovery(
  address: HubAddressV1,
  request: XiaoguiDeliveryPrepareRecoveryRequestV1,
): Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> {
  return invokeDelivery('xiaogui.delivery.apply.recovery.prepare', address, request)
}

/** 生成唯一请求标识（幂等键由 requestId + payload hash 在主进程判定）。 */
export function newHubRequestId(): string {
  return `xhui_${crypto.randomUUID()}`
}
