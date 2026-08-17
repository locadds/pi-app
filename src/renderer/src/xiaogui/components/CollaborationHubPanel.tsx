/**
 * 协作计划面板（右栏「协作」Tab）。
 *
 * 呈现主进程 SESSION_COLLABORATION_PROJECTION（m2b.v1），所有可用动作
 * 完全由 projection.availableActions 决定；Renderer 不自行推导。
 * execution.next.confirm 只开放本地两阶段确认，最终只调用一次窄执行 IPC。
 * DESIGN 模式只显示预留说明，不出现任何动作按钮。
 * 不展示绝对路径、异常栈或原始对象；错误只显示安全码 + 中文短文案 + traceId。
 */

import { useEffect, useMemo, useState } from 'react'

import type {
  AttemptStatusM2BV1,
  CollaborationFlowSummaryV1,
  HubSafeErrorV1,
  SessionCollaborationProjectionM2BV1,
  TaskRunStatusM2BV1,
  TaskSpecProjectionV1,
} from '@shared/xiaogui-collaboration-hub'
import type { TaskVerificationFailureSourceV1, TaskVerificationSummaryV1 } from '@shared/xiaogui-task-verification'

import { useUIStore } from '@renderer/stores/ui-store'

import {
  DEFAULT_CANCEL_REASON,
  HUB_ERROR_TEXT,
  TASK_EXECUTION_ERROR_TEXT,
  parseTaskExecutionPaths,
  useCollaborationHubStore,
  type PlanTaskFormItem,
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

function shortDigest(digest: string): string {
  const value = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest
  return `sha256:${value.slice(0, 12)}…`
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
        <span>
          错误 {error.code}：{HUB_ERROR_TEXT[error.code] ?? '未知错误'}
        </span>
        <button type="button" onClick={onDismiss} className="shrink-0 text-red-500/70 hover:text-red-500">
          ✕
        </button>
      </div>
      {error.traceId && <div className="mt-1 font-mono text-[10px] opacity-70">traceId: {error.traceId}</div>}
    </div>
  )
}

function TaskRowFields({
  task,
  index,
  canRemove,
  onChange,
  onRemove,
}: {
  task: PlanTaskFormItem
  index: number
  canRemove: boolean
  onChange: (index: number, patch: Partial<PlanTaskFormItem>) => void
  onRemove: (index: number) => void
}) {
  const inputCls = 'w-full rounded-md border border-border/60 bg-transparent px-2 py-1 text-[12px] outline-none focus:border-primary/60'
  return (
    <div className="rounded-lg border border-border/40 p-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <input
          aria-label={`任务 ${index + 1} 标识`}
          placeholder="任务标识 taskKey"
          value={task.taskKey}
          onChange={(e) => onChange(index, { taskKey: e.target.value })}
          className={inputCls}
        />
        {canRemove && (
          <button
            type="button"
            aria-label={`删除任务 ${index + 1}`}
            onClick={() => onRemove(index)}
            className="shrink-0 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground hover:text-destructive"
          >
            ✕
          </button>
        )}
      </div>
      <input
        aria-label={`任务 ${index + 1} 标题`}
        placeholder="任务标题"
        value={task.title}
        onChange={(e) => onChange(index, { title: e.target.value })}
        className={`${inputCls} mb-1.5`}
      />
      <input
        aria-label={`任务 ${index + 1} 摘要`}
        placeholder="摘要（可选）"
        value={task.summary}
        onChange={(e) => onChange(index, { summary: e.target.value })}
        className={`${inputCls} mb-1.5`}
      />
      <input
        aria-label={`任务 ${index + 1} 依赖`}
        placeholder="依赖 taskKey，逗号分隔（可选）"
        value={task.dependsOnText}
        onChange={(e) => onChange(index, { dependsOnText: e.target.value })}
        className={inputCls}
      />
    </div>
  )
}

function DraftCreateForm({ projection }: { projection: SessionCollaborationProjectionM2BV1 }) {
  const form = useCollaborationHubStore((s) => s.form)
  const formErrors = useCollaborationHubStore((s) => s.formErrors)
  const submitting = useCollaborationHubStore((s) => s.submitting)
  const setForm = useCollaborationHubStore((s) => s.setForm)
  const startWithDraft = useCollaborationHubStore((s) => s.startWithDraft)
  const canStart = projection.availableActions.includes('flow.start.with_draft')

  const patchTask = (index: number, patch: Partial<PlanTaskFormItem>) => {
    const tasks = form.tasks.map((t, i) => (i === index ? { ...t, ...patch } : t))
    setForm({ ...form, tasks })
  }
  const removeTask = (index: number) => setForm({ ...form, tasks: form.tasks.filter((_, i) => i !== index) })
  const addTask = () =>
    setForm({
      ...form,
      tasks: [...form.tasks, { taskKey: '', title: '', summary: '', dependsOnText: '' }],
    })

  return (
    <div data-testid="hub-draft-form">
      <div className="mb-2 text-[12px] font-medium text-foreground">新建协作计划草稿</div>
      <textarea
        aria-label="协作计划目标"
        placeholder="目标（必填）"
        value={form.objective}
        onChange={(e) => setForm({ ...form, objective: e.target.value })}
        rows={2}
        className="mb-2 w-full resize-y rounded-md border border-border/60 bg-transparent px-2 py-1 text-[12px] outline-none focus:border-primary/60"
      />
      <div className="flex flex-col gap-2">
        {form.tasks.map((task, index) => (
          <TaskRowFields
            key={index}
            task={task}
            index={index}
            canRemove={form.tasks.length > 1}
            onChange={patchTask}
            onRemove={removeTask}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={addTask}
          className="rounded-md border border-border/60 px-2 py-1 text-[12px] text-foreground-secondary hover:bg-accent"
        >
          + 添加任务
        </button>
        {canStart && (
          <button
            type="button"
            disabled={submitting}
            onClick={() => void startWithDraft()}
            className="rounded-md bg-primary px-3 py-1 text-[12px] text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            建立草稿
          </button>
        )}
      </div>
      {formErrors.length > 0 && (
        <ul className="mt-2 list-disc pl-4 text-[12px] text-amber-700 dark:text-amber-300">
          {formErrors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ReadonlyTaskSpec({ spec }: { spec: TaskSpecProjectionV1 }) {
  // M2B 投影已携带真实 taskRun 状态，旧契约遗留的 unavailableReason 徽标不再展示
  return (
    <li className="rounded-lg border border-border/40 p-2">
      <div className="text-[12px] font-medium text-foreground">{spec.title}</div>
      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{spec.taskKey}</div>
      {spec.summary && <div className="mt-1 text-[12px] text-foreground-secondary">{spec.summary}</div>}
      {spec.dependsOn.length > 0 && <div className="mt-1 text-[11px] text-muted-foreground">依赖：{spec.dependsOn.join('、')}</div>}
    </li>
  )
}

function CancelFlowSection({ flowId }: { flowId: string }) {
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
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">{flowId}</div>
    </div>
  )
}

function TaskExecutionSection({ projection }: { projection: SessionCollaborationProjectionM2BV1 }) {
  const executionForm = useCollaborationHubStore((s) => s.executionForm)
  const executionFormErrors = useCollaborationHubStore((s) => s.executionFormErrors)
  const executionReviewing = useCollaborationHubStore((s) => s.executionReviewing)
  const executionError = useCollaborationHubStore((s) => s.executionError)
  const submitting = useCollaborationHubStore((s) => s.submitting)
  const setExecutionForm = useCollaborationHubStore((s) => s.setExecutionForm)
  const reviewTaskExecution = useCollaborationHubStore((s) => s.reviewTaskExecution)
  const returnToTaskExecutionEdit = useCollaborationHubStore((s) => s.returnToTaskExecutionEdit)
  const startNextTaskExecution = useCollaborationHubStore((s) => s.startNextTaskExecution)
  const clearExecutionError = useCollaborationHubStore((s) => s.clearExecutionError)

  if (!projection.availableActions.includes('execution.next.confirm')) return null

  const modifyPaths = parseTaskExecutionPaths(executionForm.modifyPathsText)
  const createPaths = parseTaskExecutionPaths(executionForm.createPathsText)
  const inputCls =
    'w-full resize-y rounded-md border border-border/60 bg-transparent px-2 py-1 text-[12px] outline-none focus:border-primary/60 disabled:opacity-50'

  return (
    <div className="mt-3 rounded-lg border border-border/50 p-2.5" data-testid="hub-task-execution">
      <div className="mb-1 text-[12px] font-medium text-foreground">执行当前可执行任务</div>
      <div className="mb-2 text-[11px] text-muted-foreground">主进程会在最终确认后选择当前可执行任务。</div>

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
          <textarea
            aria-label="本次任务说明"
            placeholder="说明本次任务要完成什么"
            value={executionForm.prompt}
            onChange={(event) => setExecutionForm({ ...executionForm, prompt: event.target.value })}
            rows={3}
            className={`${inputCls} mb-2`}
          />
          <textarea
            aria-label="允许修改的已有文件"
            placeholder={'允许修改的已有文件（每行一条项目内相对路径）\nsrc/example.ts'}
            value={executionForm.modifyPathsText}
            onChange={(event) => setExecutionForm({ ...executionForm, modifyPathsText: event.target.value })}
            rows={3}
            className={`${inputCls} mb-2`}
          />
          <textarea
            aria-label="允许新建的文件"
            placeholder={'允许新建的文件（每行一条项目内相对路径）\nsrc/new-file.ts'}
            value={executionForm.createPathsText}
            onChange={(event) => setExecutionForm({ ...executionForm, createPathsText: event.target.value })}
            rows={3}
            className={inputCls}
          />
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
            onClick={reviewTaskExecution}
            className="mt-2 rounded-md bg-primary px-3 py-1 text-[12px] text-primary-foreground hover:bg-primary/90"
          >
            核对执行范围
          </button>
        </div>
      ) : (
        <div data-testid="hub-task-execution-review">
          <div className="rounded-md bg-muted/50 p-2">
            <div className="text-[11px] font-medium text-muted-foreground">任务说明</div>
            <div className="mt-1 whitespace-pre-wrap break-words text-[12px] text-foreground">{executionForm.prompt.trim()}</div>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <ReadonlyExecutionPaths title="允许修改" paths={modifyPaths} />
            <ReadonlyExecutionPaths title="允许新建" paths={createPaths} />
          </div>
          <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">
            最终确认后，智能体不能删除文件，也不能操作清单之外的文件。
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={returnToTaskExecutionEdit}
              className="rounded-md border border-border/60 px-2 py-1 text-[12px] text-foreground-secondary hover:bg-accent disabled:opacity-40"
            >
              返回修改
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void startNextTaskExecution()}
              className="rounded-md bg-primary px-3 py-1 text-[12px] text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {submitting ? '正在提交…' : '确认并执行'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
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
  return (
    <div data-testid="hub-awaiting-approval">
      <div className="mb-1 text-[12px] font-medium text-foreground">{flow.objective}</div>
      <div className="mb-2 text-[11px] text-muted-foreground">
        计划版本 {revision.revisionId} · digest <span className="font-mono">{revision.digest}</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {revision.draft.tasks.map((task) => (
          <li key={task.taskKey} className="rounded-lg border border-border/40 p-2">
            <div className="text-[12px] font-medium text-foreground">{task.title}</div>
            <div className="font-mono text-[10px] text-muted-foreground">{task.taskKey}</div>
            {task.summary && <div className="mt-1 text-[12px] text-foreground-secondary">{task.summary}</div>}
            {task.dependsOn && task.dependsOn.length > 0 && (
              <div className="mt-1 text-[11px] text-muted-foreground">依赖：{task.dependsOn.join('、')}</div>
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
        <CancelFlowSection flowId={flow.flowId} />
      </div>
    </div>
  )
}

function ActivePlanView({ projection }: { projection: SessionCollaborationProjectionM2BV1 }) {
  const flow = projection.activeFlow
  if (!flow) return null
  const attemptsByRun = new Map<string, typeof projection.attempts>()
  for (const attempt of projection.attempts) {
    const list = attemptsByRun.get(attempt.taskRunId) ?? []
    list.push(attempt)
    attemptsByRun.set(attempt.taskRunId, list)
  }
  return (
    <div data-testid="hub-active-plan">
      <div className="mb-1 text-[12px] font-medium text-foreground">{flow.objective}</div>
      <ul className="flex flex-col gap-1.5">
        {projection.taskSpecs.map((spec) => (
          <ReadonlyTaskSpec key={spec.taskSpecId} spec={spec} />
        ))}
      </ul>
      {projection.taskRuns.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">任务运行（只读）</div>
          <ul className="flex flex-col gap-1">
            {projection.taskRuns.map((run) => (
              <li key={run.taskRunId} className="rounded-md border border-border/30 px-2 py-1 text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-muted-foreground">{run.taskKey}</span>
                  <span
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                    data-testid={`hub-taskrun-status-${run.taskKey}`}
                  >
                    {TASK_RUN_STATUS_TEXT[run.status]}
                  </span>
                </div>
                {(attemptsByRun.get(run.taskRunId) ?? []).map((attempt) => (
                  <div key={attempt.attemptId} className="mt-1 text-[10px] text-muted-foreground">
                    <div className="flex items-center justify-between">
                      <span className="min-w-0 truncate font-mono">尝试 {attempt.attemptId}</span>
                      <span className="ml-2 shrink-0">{ATTEMPT_STATUS_TEXT[attempt.status]}</span>
                    </div>
                    {attempt.verificationSummary && (
                      <TaskVerificationSummaryCard attemptId={attempt.attemptId} summary={attempt.verificationSummary} />
                    )}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      <TaskExecutionSection projection={projection} />
      <div className="mt-3">
        <CancelFlowSection flowId={flow.flowId} />
      </div>
    </div>
  )
}

export function CollaborationHubPanel() {
  const currentSessionId = useUIStore((s) => s.currentSessionId)
  const sessions = useUIStore((s) => s.sessions)
  const scope = useMemo(() => sessions.find((s) => s.sessionId === currentSessionId)?.canonicalScope, [sessions, currentSessionId])
  const addressKey = scope ? `${scope.projectId}/${scope.sessionKey}` : ''

  const loading = useCollaborationHubStore((s) => s.loading)
  const projection = useCollaborationHubStore((s) => s.projection)
  const error = useCollaborationHubStore((s) => s.error)
  const refresh = useCollaborationHubStore((s) => s.refresh)
  const clearError = useCollaborationHubStore((s) => s.clearError)

  // address 只来自当前会话 canonicalScope 的 projectId + sessionKey；
  // 切换会话时 setAddress 会清空旧投影与临时表单
  useEffect(() => {
    const next = scope ? { projectId: scope.projectId, sessionKey: scope.sessionKey } : null
    useCollaborationHubStore.getState().setAddress(next)
    if (next) void useCollaborationHubStore.getState().refresh()
  }, [addressKey, scope?.sessionMode])

  if (!scope) {
    return (
      <div className="p-4 text-[12px] text-muted-foreground" data-testid="hub-no-session">
        请先进入已建立的会话
      </div>
    )
  }

  const reserved = projection?.reserved
  const flow = projection?.activeFlow ?? null

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3" data-testid="collaboration-hub-panel">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12px] font-medium text-foreground">协作计划</span>
        <button
          type="button"
          aria-label="刷新协作计划"
          disabled={loading}
          onClick={() => void refresh()}
          className="rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-foreground-secondary hover:bg-accent disabled:opacity-40"
        >
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      {error && <ErrorBanner error={error} onDismiss={clearError} />}

      {!projection && loading && <div className="text-[12px] text-muted-foreground">加载中…</div>}

      {projection && reserved && (
        <div
          className="rounded-lg border border-dashed border-border/60 p-3 text-[12px] text-muted-foreground"
          data-testid="hub-design-reserved"
        >
          规划设计（DESIGN）模式暂未开放协作计划（DESIGN_RESERVED）。请在 WORK 或 CODING 会话中使用。
        </div>
      )}

      {projection && !reserved && !flow && <DraftCreateForm projection={projection} />}
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
