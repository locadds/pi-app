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
  AttemptStatusM2BV1,
  CollaborationHubActionV1,
  HubAddressV1,
  HubErrorCodeV1,
  HubOutcomeV1,
  HubSafeErrorV1,
  PerformReceiptV1,
  SessionCollaborationProjectionM2BV1,
  TaskRunStatusM2BV1,
  UserIntentRequestV1,
} from '@shared/xiaogui-collaboration-hub'

import { ipcClient } from '@renderer/lib/ipc-client'

/** perform（用户意图）契约版本：主进程 perform 仅接受 m2a.v1。 */
export const HUB_CONTRACT_VERSION = 'm2a.v1'
/** observe（只读投影）契约版本：M3B 起读取 m2b.v1 投影。 */
export const HUB_OBSERVE_CONTRACT_VERSION = 'm2b.v1'

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
const HUB_TRACE_ID = /^xhbt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  'correction.create',
  'system.schedule',
  'system.workspace.prepare.result.record',
  'system.agent.report.record',
  'system.agent.outcome.record',
  'system.agent.reconcile',
  'system.verification.complete',
  'system.verification.reconcile',
])

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
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

function isTaskRunM2B(value: unknown): boolean {
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

function isAttemptM2B(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.attemptId === 'string' &&
    typeof value.taskRunId === 'string' &&
    ATTEMPT_STATUSES_M2B.has(value.status as AttemptStatusM2BV1) &&
    (value.runtimeSessionId === undefined || typeof value.runtimeSessionId === 'string') &&
    (value.workspaceReceiptId === undefined || typeof value.workspaceReceiptId === 'string')
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
    value.availableActions.every((action) => typeof action === 'string' && HUB_ACTIONS.has(action as CollaborationHubActionV1))
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

/** 生成唯一请求标识（幂等键由 requestId + payload hash 在主进程判定）。 */
export function newHubRequestId(): string {
  return `xhui_${crypto.randomUUID()}`
}
