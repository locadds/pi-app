/**
 * 协作计划面板（右栏「协作」Tab）。
 *
 * 呈现主进程 SESSION_COLLABORATION_PROJECTION（m2b.v1），所有可用动作
 * 完全由 projection.availableActions 决定；Renderer 不自行推导。
 * execution.next.confirm 只开放本地两阶段确认，本批任务取自
 * projection.executionReadiness（readyTaskRunIds + availableSlots，最多 2 个），
 * 最终只调用一次批量执行 IPC（xiaogui.task-execution.batch.v1）。
 * DESIGN 模式只显示预留说明，不出现任何动作按钮。
 * 不展示绝对路径、异常栈或原始对象；错误只显示安全码 + 中文短文案 + traceId。
 */

import { useEffect, useMemo, useState } from 'react'

import type {
  AttemptProjectionM2BV1,
  AttemptStatusM2BV1,
  CollaborationFlowSummaryV1,
  HubSafeErrorV1,
  SessionCollaborationProjectionM2BV1,
  TaskDependencyStateV1,
  TaskRunProjectionM2BV1,
  TaskRunStatusM2BV1,
  TaskSpecProjectionV1,
} from '@shared/xiaogui-collaboration-hub'
import type { RuntimeAdapterSelectionV1 } from '@shared/xiaogui-agent-runtime'
import type { DeliveryApplyAttemptV1, DeliveryBatchProjectionV1, DeliveryBatchStateV1 } from '@shared/xiaogui-delivery'
import type { TaskVerificationFailureSourceV1, TaskVerificationSummaryV1 } from '@shared/xiaogui-task-verification'

import { useUIStore } from '@renderer/stores/ui-store'
import { onAppEvent } from '@renderer/lib/ipc-client'
import { sessionFilesEqual } from '@renderer/lib/session-file-key'

import { CodingAttemptPlanCard } from './CodingAttemptPlanCard'
import { CodingAttemptReviewCard } from './CodingAttemptReviewCard'
import { useCodingAttemptStore } from '../stores/coding-attempt-store'

import {
  DEFAULT_CANCEL_REASON,
  DELIVERY_ERROR_TEXT,
  HUB_ERROR_TEXT,
  TASK_EXECUTION_ERROR_TEXT,
  eligibleExecutionTaskRunIds,
  emptyTaskExecutionForm,
  parseTaskExecutionPaths,
  useCollaborationHubStore,
} from '../stores/collaboration-hub-store'

const FLOW_STATUS_TEXT: Record<CollaborationFlowSummaryV1['status'], string> = {
  AWAITING_PLAN_APPROVAL: '待批准',
  PLAN_ACTIVE: '已激活',
  CANCELLED: '已取消',
}

/** M2B TaskRun 真实状态 → 中文短文案（只读展示）。 */
const TASK_RUN_STATUS_TEXT: Record<TaskRunStatusM2BV1, string> = {
  BLOCKED: '阻塞',
  DEPENDENCY_ELIGIBLE: '依赖就绪',
  READY: '就绪',
  RUNNING: '运行中',
  VERIFYING: '验证中',
  FAILED: '失败',
  VERIFIED: '已验证',
  DELIVERY_PENDING: '待交付',
  APPLYING: '应用中',
  CANCEL_REQUESTED: '取消中',
  DONE: '已完成',
  INTERRUPT_REQUESTED: '中断中',
  OUTCOME_UNKNOWN: '结果未知',
  CANCELLED: '已取消',
  INVALIDATED: '已失效',
  SUPERSEDED: '已被取代',
}

/** M2B Attempt 状态 → 中文短文案（只读展示）。 */
const ATTEMPT_STATUS_TEXT: Record<AttemptStatusM2BV1, string> = {
  CREATED: '已创建',
  WORKSPACE_PREPARING: '准备工作区',
  READY: '就绪',
  STARTING: '启动中',
  RUNNING: '运行中',
  VERIFYING: '验证中',
  INTERRUPT_REQUESTED: '中断中',
  OUTCOME_UNKNOWN: '结果未知',
  SUCCEEDED: '成功',
  FAILED: '失败',
  INTERRUPTED: '已中断',
  CANCELLED: '已取消',
}

const VERIFICATION_STATUS_TEXT: Record<TaskVerificationSummaryV1['state'], string> = {
  STARTED: '验证中',
  SUCCEEDED: '已验证',
  FAILED: '验证失败',
  OUTCOME_UNKNOWN: '结果未知',
}

const VERIFICATION_FAILURE_TEXT: Record<TaskVerificationFailureSourceV1['source'], string> = {
  QA_CHECKS_FAILED: '固定检查未通过',
  VERIFICATION_LOGIC_FAILURE: '验证逻辑未通过',
  VERIFICATION_POLICY_DENIED: '验证规则不允许',
  VERIFICATION_TRANSIENT_INFRASTRUCTURE: '验证环境暂时不可用',
  VERIFICATION_TRANSIENT_BUDGET_EXCEEDED: '验证环境多次不可用',
  VERIFICATION_PERMANENT_INFRASTRUCTURE: '验证环境不可用',
}

const DELIVERY_STATE_TEXT: Record<DeliveryBatchStateV1, string> = {
  COMPOSING: '组合中',
  VERIFYING: '交付复验中',
  READY_FOR_REVIEW: '待审阅',
  APPROVED: '已批准',
  REJECTED: '已退回',
  APPLYING: '应用中',
  APPLIED: '已应用',
  SUPERSEDED: '已被新交付替代',
  OUTCOME_UNKNOWN: '结果未知',
}

const DELIVERY_APPLY_INTEGRITY_TEXT: Record<string, string> = {
  TARGET_BASELINE_DRIFT: '项目代码已变化，旧批准不能继续使用。',
  TARGET_STATUS_DIRTY: '项目存在未提交改动，请先自行处理并刷新；小规不会覆盖这些改动。',
  TARGET_FILE_DRIFT: '交付文件已变化，当前交付不能直接重试。',
}

const DELIVERY_NON_RETRYABLE_SAFE_CODES = new Set(Object.keys(DELIVERY_APPLY_INTEGRITY_TEXT))
const DELIVERY_FAILED_APPLY_STATES = new Set<DeliveryApplyAttemptV1['state']>(['FAILED', 'FAILED_ROLLED_BACK'])

/** runtimeBinding 只向用户暴露 Agent 类型；OTHER 时退回 adapter 名称。 */
const AGENT_KIND_TEXT: Record<RuntimeAdapterSelectionV1['runtimeKind'], string> = {
  KIMI: 'Kimi Agent',
  QODER: 'Qoder Agent',
  CODEX: 'Codex Agent',
  OTHER: '',
}

function agentDisplayName(selection: RuntimeAdapterSelectionV1): string {
  return AGENT_KIND_TEXT[selection.runtimeKind] || selection.adapterId
}

/** 任务运行分组：同组为空就不显示。分组以 executionReadiness 实时快照为权威。 */
type TaskGroupKey = 'executable' | 'awaiting-plan' | 'running' | 'waiting' | 'verifying' | 'failed' | 'done'

const TASK_GROUP_DEFS: readonly { key: TaskGroupKey; title: string }[] = [
  { key: 'executable', title: '可执行' },
  { key: 'awaiting-plan', title: '等待批准计划' },
  { key: 'running', title: '执行中' },
  { key: 'waiting', title: '等待依赖' },
  { key: 'verifying', title: '验证中' },
  { key: 'failed', title: '失败' },
  { key: 'done', title: '待交付 / 已完成' },
]

/** 无实时 readiness 时（终态/历史投影）按 TaskRun 状态回退分组。 */
const RUN_STATUS_GROUP: Record<TaskRunStatusM2BV1, TaskGroupKey> = {
  BLOCKED: 'waiting',
  DEPENDENCY_ELIGIBLE: 'executable',
  READY: 'executable',
  RUNNING: 'running',
  VERIFYING: 'verifying',
  FAILED: 'failed',
  VERIFIED: 'done',
  DELIVERY_PENDING: 'done',
  APPLYING: 'running',
  CANCEL_REQUESTED: 'running',
  DONE: 'done',
  INTERRUPT_REQUESTED: 'running',
  OUTCOME_UNKNOWN: 'failed',
  CANCELLED: 'failed',
  INVALIDATED: 'failed',
  SUPERSEDED: 'failed',
}

function currentAttemptOf(
  run: TaskRunProjectionM2BV1,
  attempts: readonly AttemptProjectionM2BV1[],
): AttemptProjectionM2BV1 | undefined {
  return attempts.find((attempt) => attempt.attemptId === run.attemptId) ?? attempts[attempts.length - 1]
}

function groupKeyForRun(
  run: TaskRunProjectionM2BV1,
  readiness: TaskDependencyStateV1 | undefined,
  attempts: readonly AttemptProjectionM2BV1[],
  awaitingPlanAttemptIds: ReadonlySet<string>,
): TaskGroupKey {
  const currentAttempt = currentAttemptOf(run, attempts)
  if (currentAttempt?.status === 'READY' && awaitingPlanAttemptIds.has(currentAttempt.attemptId)) {
    return 'awaiting-plan'
  }
  if (readiness) {
    if (readiness.state === 'READY') return 'executable'
    if (readiness.state === 'WAITING_FOR_DEPENDENCIES' || readiness.state === 'BLOCKED_BY_FAILED_DEPENDENCY') {
      return 'waiting'
    }
    if (readiness.state === 'IN_FLIGHT') {
      // 执行波内任务再结合当前 attempt 状态细分：验证中 / 执行中
      return currentAttemptOf(run, attempts)?.status === 'VERIFYING' ? 'verifying' : 'running'
    }
    // TERMINAL：落到 TaskRun/Attempt 的终态展示
  }
  return RUN_STATUS_GROUP[run.status]
}

/**
 * 卡片徽标：存在实时 readiness 时显示与 readiness 一致的用户语义，
 * 避免「分组可执行 + 徽标阻塞」这类矛盾（未派发任务的 raw TaskRun 仍是 BLOCKED）；
 * TERMINAL 或无快照时回退 TaskRun 终态文案。
 */
function taskRunBadgeText(
  run: TaskRunProjectionM2BV1,
  readiness: TaskDependencyStateV1 | undefined,
  attempts: readonly AttemptProjectionM2BV1[],
  awaitingPlanAttemptIds: ReadonlySet<string>,
): string {
  const currentAttempt = currentAttemptOf(run, attempts)
  if (currentAttempt?.status === 'READY' && awaitingPlanAttemptIds.has(currentAttempt.attemptId)) {
    return '等待批准计划'
  }
  if (readiness) {
    if (readiness.state === 'READY') return '就绪'
    if (readiness.state === 'WAITING_FOR_DEPENDENCIES') return '等待依赖'
    if (readiness.state === 'BLOCKED_BY_FAILED_DEPENDENCY') return '前置失败'
    if (readiness.state === 'IN_FLIGHT') {
      return currentAttemptOf(run, attempts)?.status === 'VERIFYING' ? '验证中' : '执行中'
    }
  }
  return TASK_RUN_STATUS_TEXT[run.status]
}

/** 依赖/阻断原因：以 executionReadiness 实时快照为权威，只显示任务标题。 */
function dependencyReasonText(
  depState: TaskDependencyStateV1 | undefined,
  titleByRunId: ReadonlyMap<string, string>,
): string | null {
  if (!depState) return null
  const titlesOf = (ids: readonly string[]) =>
    ids.map((id) => titleByRunId.get(id)).filter((title): title is string => Boolean(title))
  const blockingTitles = titlesOf(depState.blockingTaskRunIds)
  const titles = blockingTitles.length > 0 ? blockingTitles : titlesOf(depState.dependencyTaskRunIds)
  const suffix = titles.length > 0 ? `：${titles.join('、')}` : ''
  if (depState.state === 'WAITING_FOR_DEPENDENCIES') return `等待前置任务完成${suffix}`
  if (depState.state === 'BLOCKED_BY_FAILED_DEPENDENCY') return `前置任务失败，暂不能继续${suffix}`
  return null
}

function isFailedApplyAttempt(applyAttempt: DeliveryApplyAttemptV1 | undefined): applyAttempt is DeliveryApplyAttemptV1 {
  return Boolean(applyAttempt && DELIVERY_FAILED_APPLY_STATES.has(applyAttempt.state))
}

function hasExplicitEmptyChangedRelativePaths(applyAttempt: DeliveryApplyAttemptV1 | undefined): boolean {
  return Array.isArray(applyAttempt?.changedRelativePaths) && applyAttempt.changedRelativePaths.length === 0
}

function shortDigest(digest: string): string {
  if (digest.startsWith('sha256:')) {
    return `sha256:${digest.slice('sha256:'.length, 'sha256:'.length + 12)}…`
  }
  return `${digest.slice(0, 12)}…`
}

function TaskVerificationSummaryCard({
  attemptId,
  summary,
}: {
  attemptId: string
  summary: TaskVerificationSummaryV1
}) {
  const checks = summary.state === 'SUCCEEDED' || summary.state === 'FAILED' ? summary.checks : []
  return (
    <div
      className="mt-1.5 rounded border border-border/30 bg-muted/20 px-2 py-1.5 text-[10px] text-muted-foreground"
      data-testid={`hub-verification-summary-${attemptId}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground-secondary">任务验证</span>
        <span data-testid={`hub-verification-status-${attemptId}`}>{VERIFICATION_STATUS_TEXT[summary.state]}</span>
      </div>
      {checks.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5" aria-label="验证检查摘要">
          {checks.map((check) => (
            <li key={check.checkId} className="flex items-start justify-between gap-2">
              <span className="min-w-0 break-words">{check.summary}</span>
              <span className="shrink-0">{check.verdict === 'PASS' ? '通过' : '未通过'}</span>
            </li>
          ))}
        </ul>
      )}
      {summary.state === 'STARTED' && <div className="mt-1">正在按固定规则检查候选变更。</div>}
      {summary.state === 'FAILED' && (
        <div className="mt-1">
          {VERIFICATION_FAILURE_TEXT[summary.failure.source]}，未形成任务变更集。
        </div>
      )}
      {summary.state === 'OUTCOME_UNKNOWN' && (
        <div className="mt-1">当前结果无法证明，尚未形成任务变更集。</div>
      )}
      {summary.state === 'SUCCEEDED' && (
        <div className="mt-1 flex flex-col gap-0.5">
          <div>
            证据包 <span className="font-mono">{summary.evidenceBundleId}</span> · 证据 {summary.evidenceArtifacts.length} 项
          </div>
          <div>
            任务变更集 <span className="font-mono">{summary.taskChangeSetId}</span>
          </div>
          <div>
            变更摘要 <span className="font-mono">{shortDigest(summary.changeSetDigest)}</span>
          </div>
        </div>
      )}
      {summary.diagnosticArtifacts.length > 0 && <div className="mt-1">诊断记录 {summary.diagnosticArtifacts.length} 项</div>}
    </div>
  )
}

function ErrorBanner({ error, onDismiss }: { error: HubSafeErrorV1; onDismiss: () => void }) {
  return (
    <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-700 dark:text-red-300">
      <div className="flex items-start justify-between gap-2">
        <span>{HUB_ERROR_TEXT[error.code] ?? '发生了未知错误，请稍后重试'}</span>
        <button type="button" onClick={onDismiss} className="shrink-0 text-red-500/70 hover:text-red-500">
          ✕
        </button>
      </div>
      <details className="mt-1 text-[10px] opacity-70">
        <summary className="cursor-pointer">错误详情（供反馈使用）</summary>
        <div className="mt-1 font-mono">
          {error.code}
          {error.traceId ? ` · ${error.traceId}` : ''}
        </div>
      </details>
    </div>
  )
}

function NaturalLanguagePlanEntry({ available }: { available: boolean }) {
  if (!available) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 p-3 text-[12px] text-muted-foreground">
        当前会话暂不支持创建协作计划。
      </div>
    )
  }
  return (
    <div
      className="rounded-lg border border-dashed border-border/60 p-3"
      data-testid="hub-natural-language-entry"
    >
      <div className="text-[12px] font-medium text-foreground">直接在对话里说出你要完成的事</div>
      <div className="mt-1.5 text-[12px] leading-5 text-muted-foreground">
        直接说需求就行，拆分和先后顺序由小规帮你整理；结果会回到这里等你确认。
      </div>
      <div className="mt-2 rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-foreground-secondary">
        例如：把本周项目汇报拆成资料整理、初稿编写和复核，安排多个 Agent 协作完成。
      </div>
    </div>
  )
}

function dependencyTitles(dependsOn: readonly string[], titleByKey: ReadonlyMap<string, string>): string[] {
  return dependsOn.map((key) => titleByKey.get(key) ?? '未命名任务')
}

function ReadonlyTaskSpec({
  spec,
  titleByKey,
}: {
  spec: TaskSpecProjectionV1
  titleByKey: ReadonlyMap<string, string>
}) {
  // M2B 投影已携带真实 taskRun 状态，旧契约遗留的 unavailableReason 徽标不再展示
  return (
    <li className="rounded-lg border border-border/40 p-2">
      <div className="text-[12px] font-medium text-foreground">{spec.title}</div>
      {spec.summary && <div className="mt-1 text-[12px] text-foreground-secondary">{spec.summary}</div>}
      {spec.dependsOn.length > 0 && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          需先完成：{dependencyTitles(spec.dependsOn, titleByKey).join('、')}
        </div>
      )}
    </li>
  )
}

function CancelFlowSection() {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const submitting = useCollaborationHubStore((s) => s.submitting)
  const cancelActiveFlow = useCollaborationHubStore((s) => s.cancelActiveFlow)
  const available = useCollaborationHubStore((s) => s.projection?.availableActions.includes('flow.cancel') ?? false)
  if (!available) return null
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-destructive/40 px-3 py-1 text-[12px] text-destructive hover:bg-destructive/10"
      >
        取消协作计划
      </button>
    )
  }
  return (
    <div className="rounded-lg border border-destructive/30 p-2">
      <input
        aria-label="取消原因"
        placeholder={DEFAULT_CANCEL_REASON}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="mb-2 w-full rounded-md border border-border/60 bg-transparent px-2 py-1 text-[12px] outline-none focus:border-destructive/60"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={submitting}
          onClick={() =>
            void cancelActiveFlow(reason).then((cancelled) => {
              if (cancelled) setOpen(false)
            })
          }
          className="rounded-md bg-destructive px-3 py-1 text-[12px] text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40"
        >
          确认取消
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent"
        >
          返回
        </button>
      </div>
    </div>
  )
}

function TaskExecutionSection({ projection }: { projection: SessionCollaborationProjectionM2BV1 }) {
  const executionForms = useCollaborationHubStore((s) => s.executionForms)
  const selectedTaskRunIds = useCollaborationHubStore((s) => s.selectedExecutionTaskRunIds)
  const executionFormErrors = useCollaborationHubStore((s) => s.executionFormErrors)
  const executionReviewing = useCollaborationHubStore((s) => s.executionReviewing)
  const executionError = useCollaborationHubStore((s) => s.executionError)
  const executionItemErrors = useCollaborationHubStore((s) => s.executionItemErrors)
  const submitting = useCollaborationHubStore((s) => s.submitting)
  const setExecutionForm = useCollaborationHubStore((s) => s.setExecutionForm)
  const toggleExecutionTaskSelection = useCollaborationHubStore((s) => s.toggleExecutionTaskSelection)
  const reviewExecutionBatch = useCollaborationHubStore((s) => s.reviewExecutionBatch)
  const returnToExecutionBatchEdit = useCollaborationHubStore((s) => s.returnToExecutionBatchEdit)
  const startExecutionBatch = useCollaborationHubStore((s) => s.startExecutionBatch)
  const clearExecutionError = useCollaborationHubStore((s) => s.clearExecutionError)

  if (!projection.availableActions.includes('execution.next.confirm')) return null

  // 实时 readiness 决定当前并行/等待摘要；lastExecutionWave 只提供「本批新调度」历史数量，
  // 其 activeAttemptIds 不能当作新调度展示。
  const readiness = projection.executionReadiness
  const wave = projection.lastExecutionWave
  const currentDepStates = readiness?.dependencyStates ?? []
  const waitingCount = currentDepStates.filter((s) => s.state === 'WAITING_FOR_DEPENDENCIES').length
  const blockedCount = currentDepStates.filter((s) => s.state === 'BLOCKED_BY_FAILED_DEPENDENCY').length
  const summaryParts: string[] = []
  if (readiness) {
    summaryParts.push(
      `并行上限 ${readiness.maxParallelism} · 执行中 ${readiness.activeAttemptCount} 个 · 可再派发 ${readiness.availableSlots} 个`,
    )
  }
  if (wave) summaryParts.push(`本批新调度 ${wave.scheduled.length} 个`)
  if (waitingCount > 0) summaryParts.push(`等待依赖 ${waitingCount} 个`)
  if (blockedCount > 0) summaryParts.push(`前置失败 ${blockedCount} 个`)

  // 本批可执行任务完全由 readiness.readyTaskRunIds + availableSlots 决定（最多 2 个）；
  // 规则与 store 收敛共用同一份实现，没有可用槽位或没有 READY 任务时不显示确认区。
  const eligibleIds = eligibleExecutionTaskRunIds(projection)
  if (eligibleIds.length === 0) return null

  const titleByKey = new Map(projection.taskSpecs.map((spec) => [spec.taskKey, spec.title]))
  const runById = new Map(projection.taskRuns.map((run) => [run.taskRunId, run]))
  const depStateByRunId = new Map(currentDepStates.map((state) => [state.taskRunId, state]))
  const titleOf = (taskRunId: string) => {
    const run = runById.get(taskRunId as TaskRunProjectionM2BV1['taskRunId'])
    return (run && titleByKey.get(run.taskKey)) || '协作任务'
  }
  const selectedIds = selectedTaskRunIds.filter((id) => eligibleIds.includes(id))
  const inputCls =
    'w-full resize-y rounded-md border border-border/60 bg-transparent px-2 py-1 text-[12px] outline-none focus:border-primary/60 disabled:opacity-50'

  return (
    <div className="mt-3 rounded-lg border border-border/50 p-2.5" data-testid="hub-task-execution">
      <div className="mb-1 text-[12px] font-medium text-foreground">执行本批可执行任务</div>
      <div className="mb-2 text-[11px] text-muted-foreground">
        同一项目最多并行执行 2 个任务；勾选本批要执行的就绪任务，并分别确认任务说明与文件范围。
      </div>
      {summaryParts.length > 0 && (
        <div
          className="mb-2 rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-foreground-secondary"
          data-testid="hub-execution-wave-summary"
        >
          {summaryParts.join(' · ')}
        </div>
      )}

      {executionError && (
        <div className="mb-2 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-700 dark:text-red-300">
          <div className="flex items-start justify-between gap-2">
            <span>
              错误 {executionError.code}：{TASK_EXECUTION_ERROR_TEXT[executionError.code]}
            </span>
            <button type="button" onClick={clearExecutionError} className="shrink-0 text-red-500/70 hover:text-red-500">
              ✕
            </button>
          </div>
          {executionError.traceId && <div className="mt-1 font-mono text-[10px] opacity-70">traceId: {executionError.traceId}</div>}
        </div>
      )}

      {!executionReviewing ? (
        <div data-testid="hub-task-execution-edit">
          <ul className="flex flex-col gap-2">
            {eligibleIds.map((taskRunId) => {
              const title = titleOf(taskRunId)
              const selected = selectedIds.includes(taskRunId)
              const form = executionForms[taskRunId] ?? emptyTaskExecutionForm()
              const itemError = executionItemErrors[taskRunId]
              const depState = depStateByRunId.get(taskRunId)
              const depSummary =
                depState && depState.dependencyTaskRunIds.length > 0
                  ? `前置任务已完成：${depState.dependencyTaskRunIds.map((id) => titleOf(id)).join('、')}`
                  : '无前置依赖'
              return (
                <li key={taskRunId} className="rounded-md border border-border/40 p-2" data-testid={`hub-execution-task-${taskRunId}`}>
                  <label className="flex items-center gap-2 text-[12px]">
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={submitting}
                      onChange={() => toggleExecutionTaskSelection(taskRunId)}
                    />
                    <span className="font-medium text-foreground">{title}</span>
                    <span className="text-[10px] text-muted-foreground">{depSummary}</span>
                  </label>
                  {itemError && (
                    <div className="mt-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-700 dark:text-red-300">
                      错误 {itemError.code}：{TASK_EXECUTION_ERROR_TEXT[itemError.code]}
                      {itemError.traceId && <div className="mt-1 font-mono text-[10px] opacity-70">traceId: {itemError.traceId}</div>}
                    </div>
                  )}
                  {selected && (
                    <div className="mt-2">
                      <textarea
                        aria-label={`任务说明：${title}`}
                        placeholder="说明本次任务要完成什么"
                        value={form.prompt}
                        onChange={(event) => setExecutionForm(taskRunId, { ...form, prompt: event.target.value })}
                        rows={2}
                        className={`${inputCls} mb-2`}
                      />
                      <textarea
                        aria-label={`允许修改的已有文件：${title}`}
                        placeholder={'允许修改的已有文件（每行一条项目内相对路径）\nsrc/example.ts'}
                        value={form.modifyPathsText}
                        onChange={(event) => setExecutionForm(taskRunId, { ...form, modifyPathsText: event.target.value })}
                        rows={2}
                        className={`${inputCls} mb-2`}
                      />
                      <textarea
                        aria-label={`允许新建的文件：${title}`}
                        placeholder={'允许新建的文件（每行一条项目内相对路径）\nsrc/new-file.ts'}
                        value={form.createPathsText}
                        onChange={(event) => setExecutionForm(taskRunId, { ...form, createPathsText: event.target.value })}
                        rows={2}
                        className={inputCls}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="mt-1.5 text-[11px] text-muted-foreground">只允许项目内相对路径；本次不允许删除文件。</div>
          {executionFormErrors.length > 0 && (
            <ul className="mt-2 list-disc pl-4 text-[11px] text-amber-700 dark:text-amber-300">
              {executionFormErrors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={reviewExecutionBatch}
            className="mt-2 rounded-md bg-primary px-3 py-1 text-[12px] text-primary-foreground hover:bg-primary/90"
          >
            核对本批执行范围
          </button>
        </div>
      ) : (
        <div data-testid="hub-task-execution-review">
          {selectedIds.map((taskRunId) => {
            const title = titleOf(taskRunId)
            const form = executionForms[taskRunId] ?? emptyTaskExecutionForm()
            return (
              <div key={taskRunId} className="mb-2" data-testid={`hub-execution-review-${taskRunId}`}>
                <div className="mb-1 text-[12px] font-medium text-foreground">{title}</div>
                <div className="rounded-md bg-muted/50 p-2">
                  <div className="text-[11px] font-medium text-muted-foreground">任务说明</div>
                  <div className="mt-1 whitespace-pre-wrap break-words text-[12px] text-foreground">{form.prompt.trim()}</div>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <ReadonlyExecutionPaths title="允许修改" paths={parseTaskExecutionPaths(form.modifyPathsText)} />
                  <ReadonlyExecutionPaths title="允许新建" paths={parseTaskExecutionPaths(form.createPathsText)} />
                </div>
              </div>
            )
          })}
          <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">
            本批 {selectedIds.length} 个任务，最多并行 {readiness?.maxParallelism ?? 2}{' '}
            个；最终确认后，智能体不能删除文件，也不能操作清单之外的文件。
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={returnToExecutionBatchEdit}
              className="rounded-md border border-border/60 px-2 py-1 text-[12px] text-foreground-secondary hover:bg-accent disabled:opacity-40"
            >
              返回修改
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void startExecutionBatch()}
              className="rounded-md bg-primary px-3 py-1 text-[12px] text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {submitting ? '正在提交…' : '确认并执行本批'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function DeliveryReviewSection({ delivery }: { delivery: DeliveryBatchProjectionV1 }) {
  const submitting = useCollaborationHubStore((s) => s.submitting)
  const deliveryError = useCollaborationHubStore((s) => s.deliveryError)
  const deliveryReviewSubjectKey = useCollaborationHubStore((s) => s.deliveryReviewSubjectKey)
  const clearDeliveryError = useCollaborationHubStore((s) => s.clearDeliveryError)
  const reviewActiveDelivery = useCollaborationHubStore((s) => s.reviewActiveDelivery)
  const returnToDeliveryReview = useCollaborationHubStore((s) => s.returnToDeliveryReview)
  const approveActiveDelivery = useCollaborationHubStore((s) => s.approveActiveDelivery)
  const rejectActiveDelivery = useCollaborationHubStore((s) => s.rejectActiveDelivery)
  const reconcileActiveDelivery = useCollaborationHubStore((s) => s.reconcileActiveDelivery)
  const retryActiveDelivery = useCollaborationHubStore((s) => s.retryActiveDelivery)
  const prepareActiveDeliveryRecovery = useCollaborationHubStore((s) => s.prepareActiveDeliveryRecovery)
  const availableActions = useCollaborationHubStore((s) => s.projection?.availableActions ?? [])
  const files = delivery.fileChangeSummaries ?? []
  const evidenceCount = delivery.evidenceArtifactIds?.length ?? 0
  const canApprove = availableActions.includes('delivery.gate.approve') && delivery.gate?.state === 'OPEN'
  const canReject = availableActions.includes('delivery.gate.reject') && delivery.gate?.state === 'OPEN'
  const reviewing = deliveryReviewSubjectKey !== null && deliveryReviewSubjectKey === currentDeliverySubjectKey(delivery)
  const applyAttempt = delivery.applyAttempt
  const applySafeCode = applyAttempt?.safeCode
  const integrityText = applySafeCode ? DELIVERY_APPLY_INTEGRITY_TEXT[applySafeCode] : null
  const failedApplyAttempt = isFailedApplyAttempt(applyAttempt)
  const canPrepareRecovery =
    availableActions.includes('apply.recovery.prepare') &&
    failedApplyAttempt &&
    applyAttempt.safeCode === 'TARGET_BASELINE_DRIFT' &&
    hasExplicitEmptyChangedRelativePaths(applyAttempt)
  const canRetryApply =
    availableActions.includes('apply.retry.request') &&
    failedApplyAttempt &&
    !(applySafeCode && DELIVERY_NON_RETRYABLE_SAFE_CODES.has(applySafeCode))

  return (
    <div className="mt-3 rounded-lg border border-border/50 p-2.5" data-testid="hub-delivery-review">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-foreground">交付审阅</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{DELIVERY_STATE_TEXT[delivery.state]}</span>
      </div>
      <div className="grid gap-1 text-[11px] text-muted-foreground">
        <div>
          交付批次 <span className="font-mono">{delivery.batchId}</span>
        </div>
        <div>完整任务 {delivery.selectedTaskRunIds.length} 个 · 任务变更集 {delivery.taskChangeSetIds.length} 个</div>
        <div>
          选择摘要 <span className="font-mono">{shortDigest(delivery.selectionDigest)}</span>
        </div>
        {delivery.deliveryChangeSetDigest && (
          <div>
            交付摘要 <span className="font-mono">{shortDigest(delivery.deliveryChangeSetDigest)}</span>
          </div>
        )}
        <div>证据摘要 {evidenceCount} 项</div>
      </div>
      <div className="mt-2 rounded-md border border-border/40 p-2">
        <div className="mb-1 text-[11px] font-medium text-muted-foreground">文件摘要</div>
        {files.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">暂无文件摘要</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {files.map((file) => (
              <li key={`${file.operation}:${file.relativePath}`} className="flex items-start justify-between gap-2 text-[11px]">
                <span className="min-w-0 break-all font-mono text-foreground-secondary">{file.relativePath}</span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {file.operation === 'CREATE' ? '新建' : '修改'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {deliveryError && (
        <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-700 dark:text-red-300">
          <div className="flex items-start justify-between gap-2">
            <span>
              错误 {deliveryError.code}：{DELIVERY_ERROR_TEXT[deliveryError.code]}
            </span>
            <button type="button" onClick={clearDeliveryError} className="shrink-0 text-red-500/70 hover:text-red-500">
              ✕
            </button>
          </div>
          {deliveryError.traceId && <div className="mt-1 font-mono text-[10px] opacity-70">traceId: {deliveryError.traceId}</div>}
        </div>
      )}
      {integrityText && (
        <div
          className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200"
          data-testid="hub-delivery-integrity-note"
        >
          {integrityText}
        </div>
      )}
      {reviewing ? (
        <div className="mt-2" data-testid="hub-delivery-confirm">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">
            确认应用会按当前交付摘要写入用户项目；审阅本身不会写入文件。
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={returnToDeliveryReview}
              className="rounded-md border border-border/60 px-2 py-1 text-[12px] text-foreground-secondary hover:bg-accent disabled:opacity-40"
            >
              返回
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void approveActiveDelivery()}
              className="rounded-md bg-primary px-3 py-1 text-[12px] text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {submitting ? '正在确认…' : '确认应用'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {canApprove && (
            <button
              type="button"
              disabled={submitting}
              onClick={reviewActiveDelivery}
              className="rounded-md bg-primary px-3 py-1 text-[12px] text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              审阅
            </button>
          )}
          {canReject && (
            <button
              type="button"
              disabled={submitting}
              onClick={() => void rejectActiveDelivery('用户退回当前交付')}
              className="rounded-md border border-destructive/40 px-3 py-1 text-[12px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
            >
              退回交付
            </button>
          )}
          {availableActions.includes('apply.reconcile.request') && (
            <button
              type="button"
              disabled={submitting}
              onClick={() => void reconcileActiveDelivery()}
              className="rounded-md border border-border/60 px-2 py-1 text-[12px] text-foreground-secondary hover:bg-accent disabled:opacity-40"
            >
              对账
            </button>
          )}
          {canRetryApply && (
            <button
              type="button"
              disabled={submitting}
              onClick={() => void retryActiveDelivery()}
              className="rounded-md border border-border/60 px-2 py-1 text-[12px] text-foreground-secondary hover:bg-accent disabled:opacity-40"
            >
              重试应用
            </button>
          )}
          {canPrepareRecovery && (
            <button
              type="button"
              disabled={submitting}
              onClick={() => void prepareActiveDeliveryRecovery()}
              className="rounded-md border border-border/60 px-2 py-1 text-[12px] text-foreground-secondary hover:bg-accent disabled:opacity-40"
            >
              {submitting ? '正在重新准备…' : '按当前代码重新准备交付'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function DeliverySelectionSection({ projection }: { projection: SessionCollaborationProjectionM2BV1 }) {
  const submitting = useCollaborationHubStore((s) => s.submitting)
  const selectedDeliveryTaskRunIds = useCollaborationHubStore((s) => s.selectedDeliveryTaskRunIds)
  const toggleDeliveryTaskSelection = useCollaborationHubStore((s) => s.toggleDeliveryTaskSelection)
  const createDeliveryFromSelection = useCollaborationHubStore((s) => s.createDeliveryFromSelection)
  if (projection.activeDelivery || !projection.availableActions.includes('delivery.selection.submit')) return null
  const verifiedRuns = projection.taskRuns.filter((run) => {
    if (run.status !== 'VERIFIED') return false
    return projection.attempts.some(
      (attempt) => attempt.taskRunId === run.taskRunId && attempt.verificationSummary?.state === 'SUCCEEDED',
    )
  })
  if (verifiedRuns.length === 0) return null
  const titleByKey = new Map(projection.taskSpecs.map((spec) => [spec.taskKey, spec.title]))

  return (
    <div className="mt-3 rounded-lg border border-border/50 p-2.5" data-testid="hub-delivery-selection">
      <div className="mb-1 text-[12px] font-medium text-foreground">创建交付</div>
      <ul className="flex flex-col gap-1">
        {verifiedRuns.map((run) => (
          <li key={run.taskRunId}>
            <label className="flex items-center gap-2 rounded-md border border-border/30 px-2 py-1 text-[11px]">
              <input
                type="checkbox"
                checked={selectedDeliveryTaskRunIds.includes(run.taskRunId)}
                disabled={submitting}
                onChange={() => toggleDeliveryTaskSelection(run.taskRunId)}
              />
              <span className="min-w-0 text-foreground-secondary">
                {titleByKey.get(run.taskKey) ?? '已完成任务'}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={submitting || selectedDeliveryTaskRunIds.length === 0}
        onClick={() => void createDeliveryFromSelection()}
        className="mt-2 rounded-md bg-primary px-3 py-1 text-[12px] text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
      >
        创建交付
      </button>
    </div>
  )
}

function currentDeliverySubjectKey(delivery: DeliveryBatchProjectionV1): string | null {
  if (!delivery.gate) return null
  return `${delivery.gate.gateId}:${delivery.gate.subject.deliveryChangeSetId}:${delivery.gate.subject.version}:${delivery.gate.subject.digest}`
}

function ReadonlyExecutionPaths({ title, paths }: { title: string; paths: string[] }) {
  return (
    <div className="rounded-md border border-border/40 p-2">
      <div className="text-[11px] font-medium text-muted-foreground">{title}</div>
      {paths.length === 0 ? (
        <div className="mt-1 text-[11px] text-muted-foreground">无</div>
      ) : (
        <ul className="mt-1 flex flex-col gap-0.5">
          {paths.map((relativePath) => (
            <li key={relativePath} className="break-all font-mono text-[10px] text-foreground-secondary">
              {relativePath}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AwaitingApprovalView({ projection }: { projection: SessionCollaborationProjectionM2BV1 }) {
  const submitting = useCollaborationHubStore((s) => s.submitting)
  const approveActiveRevision = useCollaborationHubStore((s) => s.approveActiveRevision)
  const flow = projection.activeFlow
  const revision = projection.activeRevision
  if (!flow || !revision) return null
  const canApprove = projection.availableActions.includes('plan.revision.submit')
  const titleByKey = new Map(revision.draft.tasks.map((task) => [task.taskKey, task.title]))
  return (
    <div data-testid="hub-awaiting-approval">
      <div className="mb-1 text-[12px] font-medium text-foreground">{flow.objective}</div>
      <div className="mb-2 text-[11px] text-muted-foreground">小规已整理出 {revision.draft.tasks.length} 项任务，请确认是否按此执行。</div>
      <ul className="flex flex-col gap-1.5">
        {revision.draft.tasks.map((task) => (
          <li key={task.taskKey} className="rounded-lg border border-border/40 p-2">
            <div className="text-[12px] font-medium text-foreground">{task.title}</div>
            {task.summary && <div className="mt-1 text-[12px] text-foreground-secondary">{task.summary}</div>}
            {task.dependsOn && task.dependsOn.length > 0 && (
              <div className="mt-1 text-[11px] text-muted-foreground">
                需先完成：{dependencyTitles(task.dependsOn, titleByKey).join('、')}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-2">
        {canApprove && (
          <button
            type="button"
            disabled={submitting}
            onClick={() => void approveActiveRevision()}
            className="rounded-md bg-primary px-3 py-1 text-[12px] text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            批准计划
          </button>
        )}
        <CancelFlowSection />
      </div>
    </div>
  )
}

function TaskRunCard({
  run,
  title,
  badge,
  attempts,
  reason,
}: {
  run: TaskRunProjectionM2BV1
  title: string
  badge: string
  attempts: readonly AttemptProjectionM2BV1[]
  reason: string | null
}) {
  return (
    <li className="rounded-md border border-border/30 px-2 py-1 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="text-foreground-secondary">{title}</span>
        <span
          className="rounded bg-muted px-1.5 py-0.5 text-[10px]"
          data-testid={`hub-taskrun-status-${run.taskKey}`}
        >
          {badge}
        </span>
      </div>
      {reason && <div className="mt-1 text-[10px] text-muted-foreground">{reason}</div>}
      {attempts.map((attempt, attemptIndex) => (
        <div key={attempt.attemptId} className="mt-1 text-[10px] text-muted-foreground">
          {/* 不展示 attemptId、runtimeSessionId、路径或摘要；有绑定时只显示 Agent 类型 + 状态 */}
          <span data-testid={`hub-attempt-agent-${run.taskKey}-${attemptIndex + 1}`}>
            {attempt.runtimeBinding
              ? `${agentDisplayName(attempt.runtimeBinding.selection)} · ${ATTEMPT_STATUS_TEXT[attempt.status]}`
              : `执行尝试 · ${ATTEMPT_STATUS_TEXT[attempt.status]}`}
          </span>
          {attempt.verificationSummary && (
            <TaskVerificationSummaryCard attemptId={attempt.attemptId} summary={attempt.verificationSummary} />
          )}
          <CodingAttemptPlanCard attemptId={attempt.attemptId} />
          <CodingAttemptReviewCard
            attemptId={attempt.attemptId}
            available={['VERIFYING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED', 'OUTCOME_UNKNOWN'].includes(attempt.status)}
          />
        </div>
      ))}
    </li>
  )
}

function ActivePlanView({ projection }: { projection: SessionCollaborationProjectionM2BV1 }) {
  const plansByAttempt = useCodingAttemptStore((state) => state.plansByAttempt)
  const flow = projection.activeFlow
  if (!flow) return null
  const attemptsByRun = new Map<string, typeof projection.attempts>()
  for (const attempt of projection.attempts) {
    const list = attemptsByRun.get(attempt.taskRunId) ?? []
    list.push(attempt)
    attemptsByRun.set(attempt.taskRunId, list)
  }
  const titleByKey = new Map(projection.taskSpecs.map((spec) => [spec.taskKey, spec.title]))
  const specByKey = new Map(projection.taskSpecs.map((spec) => [spec.taskKey, spec]))
  const titleByRunId = new Map(
    projection.taskRuns.map((run) => [run.taskRunId, titleByKey.get(run.taskKey) ?? '协作任务']),
  )
  // 分组与原因的权威来源是 executionReadiness 实时快照；
  // lastExecutionWave.dependencyStates 仅作历史证据，在没有实时快照时回退。
  const readinessByRunId = new Map(
    (projection.executionReadiness?.dependencyStates ?? []).map((state) => [state.taskRunId, state]),
  )
  const historicalDepStateByRunId = new Map(
    (projection.lastExecutionWave?.dependencyStates ?? []).map((state) => [state.taskRunId, state]),
  )
  const awaitingPlanAttemptIds = new Set(
    Object.values(plansByAttempt)
      .filter((plan) => plan.state === 'AWAITING_APPROVAL')
      .map((plan) => plan.attemptId),
  )
  const groups = TASK_GROUP_DEFS.map((def) => ({
    ...def,
    runs: projection.taskRuns.filter(
      (run) => groupKeyForRun(
        run,
        readinessByRunId.get(run.taskRunId),
        attemptsByRun.get(run.taskRunId) ?? [],
        awaitingPlanAttemptIds,
      ) === def.key,
    ),
  })).filter((group) => group.runs.length > 0)
  return (
    <div data-testid="hub-active-plan">
      <div className="mb-1 text-[12px] font-medium text-foreground">{flow.objective}</div>
      <ul className="flex flex-col gap-1.5">
        {projection.taskSpecs.map((spec) => (
          <ReadonlyTaskSpec key={spec.taskSpecId} spec={spec} titleByKey={titleByKey} />
        ))}
      </ul>
      {groups.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {groups.map((group) => (
            <div key={group.key} data-testid={`hub-task-group-${group.key}`}>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">{group.title}</div>
              <ul className="flex flex-col gap-1">
                {group.runs.map((run) => {
                  const spec = specByKey.get(run.taskKey)
                  const runAttempts = attemptsByRun.get(run.taskRunId) ?? []
                  const readiness = readinessByRunId.get(run.taskRunId)
                  const reason =
                    dependencyReasonText(
                      readiness ?? historicalDepStateByRunId.get(run.taskRunId),
                      titleByRunId,
                    ) ??
                    (run.status === 'BLOCKED' && spec && spec.dependsOn.length > 0
                      ? `需先完成：${dependencyTitles(spec.dependsOn, titleByKey).join('、')}`
                      : null)
                  return (
                    <TaskRunCard
                      key={run.taskRunId}
                      run={run}
                      title={titleByRunId.get(run.taskRunId) ?? '协作任务'}
                      badge={taskRunBadgeText(run, readiness, runAttempts, awaitingPlanAttemptIds)}
                      attempts={runAttempts}
                      reason={reason}
                    />
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      <DeliverySelectionSection projection={projection} />
      {projection.activeDelivery && <DeliveryReviewSection delivery={projection.activeDelivery} />}
      <TaskExecutionSection projection={projection} />
      <div className="mt-3">
        <CancelFlowSection />
      </div>
    </div>
  )
}

export function CollaborationHubPanel() {
  const currentSessionId = useUIStore((s) => s.currentSessionId)
  const sessions = useUIStore((s) => s.sessions)
  const currentSession = useMemo(
    () => sessions.find((session) => session.sessionId === currentSessionId),
    [sessions, currentSessionId],
  )
  const scope = currentSession?.canonicalScope
  const currentSessionFile = currentSession?.sessionFile
  const addressKey = scope ? `${scope.projectId}/${scope.sessionKey}` : ''

  const loading = useCollaborationHubStore((s) => s.loading)
  const projection = useCollaborationHubStore((s) => s.projection)
  const error = useCollaborationHubStore((s) => s.error)
  const refresh = useCollaborationHubStore((s) => s.refresh)
  const clearError = useCollaborationHubStore((s) => s.clearError)
  const codingPlansLoading = useCodingAttemptStore((s) => s.loadingPlans)
  const refreshCodingPlans = useCodingAttemptStore((s) => s.refreshPlans)

  // address 只来自当前会话 canonicalScope 的 projectId + sessionKey；
  // 切换会话时 setAddress 会清空旧投影与临时表单
  useEffect(() => {
    const next = scope ? { projectId: scope.projectId, sessionKey: scope.sessionKey } : null
    useCollaborationHubStore.getState().setAddress(next)
    if (next) void useCollaborationHubStore.getState().refresh()
    const codingAddress = scope?.sessionMode === 'CODING' ? next : null
    useCodingAttemptStore.getState().setAddress(codingAddress)
    if (codingAddress) void useCodingAttemptStore.getState().refreshPlans()
  }, [addressKey, scope?.sessionMode])

  const attemptStateKey = projection?.attempts
    .map((attempt) => `${attempt.attemptId}:${attempt.status}`)
    .join('|') ?? ''
  useEffect(() => {
    if (scope?.sessionMode !== 'CODING' || !attemptStateKey) return
    void useCodingAttemptStore.getState().refreshPlans()
  }, [addressKey, scope?.sessionMode, attemptStateKey])

  // 主进程已在工具返回前落好草稿；同一会话的工具结束事件只负责使投影失效并刷新。
  useEffect(() => {
    if (!currentSessionFile || !scope) return
    return onAppEvent((event) => {
      if (
        event.type !== 'tool' ||
        event.phase !== 'end' ||
        event.isError ||
        !sessionFilesEqual(event.sessionFile, currentSessionFile)
      ) {
        return
      }
      const details = event.details as { kind?: string } | undefined
      if (details?.kind !== 'XIAOGUI_COLLABORATION_DRAFT_CREATED') return
      const state = useCollaborationHubStore.getState()
      if (
        state.address?.projectId === scope.projectId &&
        state.address.sessionKey === scope.sessionKey
      ) {
        void state.refresh()
      }
    })
  }, [addressKey, currentSessionFile])

  if (!scope) {
    return (
      <div className="p-4 text-[12px] text-muted-foreground" data-testid="hub-no-session">
        这里还没有可协作的会话。请先在左侧打开或新建一个工作或编码会话。
      </div>
    )
  }

  const reserved = projection?.reserved
  const flow = projection?.activeFlow ?? null

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3" data-testid="collaboration-hub-panel">
      <div className="mb-3 flex items-center justify-between">
        <div className="min-w-0">
          <div className="h-[35px] w-[120px]" aria-label="小规 Hub">
            <img
              src="./brand/production-v1.0/hub/xiaogui-hub-primary.svg"
              alt="小规 Hub"
              className="block h-full w-full object-contain object-left dark:hidden"
            />
            <img
              src="./brand/production-v1.0/hub/xiaogui-hub-inverse.svg"
              alt=""
              aria-hidden="true"
              className="hidden h-full w-full object-contain object-left dark:block"
            />
          </div>
          <div className="mt-1 text-[11px] font-medium text-foreground-secondary">协作计划</div>
        </div>
        <button
          type="button"
          aria-label="刷新协作计划"
          disabled={loading || codingPlansLoading}
          onClick={() => {
            void refresh()
            if (scope.sessionMode === 'CODING') void refreshCodingPlans()
          }}
          className="rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-foreground-secondary hover:bg-accent disabled:opacity-40"
        >
          {loading || codingPlansLoading ? '加载中…' : '刷新'}
        </button>
      </div>

      {error && <ErrorBanner error={error} onDismiss={clearError} />}

      {!projection && loading && <div className="text-[12px] text-muted-foreground">加载中…</div>}

      {projection && reserved && (
        <div
          className="rounded-lg border border-dashed border-border/60 p-3 text-[12px] text-muted-foreground"
          data-testid="hub-design-reserved"
        >
          当前是规划设计会话，暂不支持协作计划；请切换到“工作”或“编码”会话后使用。
        </div>
      )}

      {projection && !reserved && !flow && (
        <NaturalLanguagePlanEntry available={projection.availableActions.includes('flow.start.with_draft')} />
      )}
      {projection && !reserved && flow?.status === 'AWAITING_PLAN_APPROVAL' && <AwaitingApprovalView projection={projection} />}
      {projection && !reserved && flow?.status === 'PLAN_ACTIVE' && <ActivePlanView projection={projection} />}

      {projection && projection.history.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">历史（只读）</div>
          <ul className="flex flex-col gap-1">
            {projection.history.map((item) => (
              <li key={item.flowId} className="flex items-center justify-between rounded-md border border-border/30 px-2 py-1 text-[11px]">
                <span className="min-w-0 truncate text-foreground-secondary">{item.objective}</span>
                <span className="ml-2 shrink-0 text-muted-foreground">{FLOW_STATUS_TEXT[item.status]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
