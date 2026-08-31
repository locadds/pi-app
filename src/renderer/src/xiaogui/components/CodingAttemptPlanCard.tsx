import { useEffect, useState } from 'react'

import type { CodingPlanBodyV1, CodingPlanTodoStatusV1 } from '@shared/xiaogui-coding-extension-pack'

import { useCodingAttemptStore } from '../stores/coding-attempt-store'

const TODO_STATUS_TEXT: Record<CodingPlanTodoStatusV1, string> = {
  PENDING: '待开始',
  IN_PROGRESS: '进行中',
  COMPLETED: '已完成',
  BLOCKED: '已阻塞',
}

const PLAN_STATE_TEXT = {
  AWAITING_APPROVAL: '等待批准',
  APPROVED: '已批准',
  EXECUTING: '执行中',
} as const

interface EditablePlan {
  objective: string
  steps: { stepId: string; title: string; validation: string }[]
}

export function CodingAttemptPlanCard({ attemptId }: { readonly attemptId: string }) {
  const projection = useCodingAttemptStore((state) => state.plansByAttempt[attemptId])
  const error = useCodingAttemptStore((state) => state.planErrorsByAttempt[attemptId])
  const submitting = useCodingAttemptStore((state) => state.submittingAttemptIds.includes(attemptId))
  const resumeRequired = useCodingAttemptStore((state) => state.resumeRequiredByAttempt[attemptId] === true)
  const revisePlan = useCodingAttemptStore((state) => state.revisePlan)
  const approveAndStart = useCodingAttemptStore((state) => state.approveAndStart)
  const resumeExecution = useCodingAttemptStore((state) => state.resumeExecution)
  const [editing, setEditing] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [draft, setDraft] = useState<EditablePlan>({ objective: '', steps: [] })

  useEffect(() => {
    if (!projection) return
    setDraft({
      objective: projection.plan.objective,
      steps: projection.plan.steps.map((step) => ({
        stepId: step.stepId,
        title: step.title,
        validation: step.validation,
      })),
    })
    setEditing(false)
    setFormError(null)
  }, [projection?.plan.revision, projection?.planDigest])

  if (!projection) return null

  const save = async () => {
    const objective = draft.objective.trim()
    const steps = draft.steps.map((step) => ({
      stepId: step.stepId,
      title: step.title.trim(),
      validation: step.validation.trim(),
    }))
    if (!objective || steps.some((step) => !step.title || !step.validation)) {
      setFormError('目标、步骤标题和验证方法都不能为空。')
      return
    }
    const body: CodingPlanBodyV1 = {
      objective,
      steps,
      constraints: projection.plan.constraints,
    }
    if (await revisePlan(attemptId, body)) setEditing(false)
  }

  return (
    <section className="mt-2 rounded-md border border-border/50 bg-muted/20 p-2 text-[11px]" aria-label="执行计划">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="font-medium text-foreground">执行计划</h4>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground-secondary">
          {PLAN_STATE_TEXT[projection.state]}
        </span>
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-muted-foreground">
            计划目标
            <textarea
              aria-label="计划目标"
              value={draft.objective}
              disabled={submitting}
              onChange={(event) => setDraft({ ...draft, objective: event.target.value })}
              className="min-h-14 resize-y rounded border border-border/60 bg-background px-2 py-1 text-[11px] text-foreground outline-none focus:border-primary"
            />
          </label>
          {draft.steps.map((step, index) => (
            <div key={step.stepId} className="rounded border border-border/40 p-2">
              <label className="flex flex-col gap-1 text-muted-foreground">
                第 {index + 1} 步标题
                <input
                  aria-label={`第 ${index + 1} 步标题`}
                  value={step.title}
                  disabled={submitting}
                  onChange={(event) => setDraft({
                    ...draft,
                    steps: draft.steps.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, title: event.target.value } : item),
                  })}
                  className="rounded border border-border/60 bg-background px-2 py-1 text-[11px] text-foreground outline-none focus:border-primary"
                />
              </label>
              <label className="mt-2 flex flex-col gap-1 text-muted-foreground">
                第 {index + 1} 步验证方法
                <input
                  aria-label={`第 ${index + 1} 步验证方法`}
                  value={step.validation}
                  disabled={submitting}
                  onChange={(event) => setDraft({
                    ...draft,
                    steps: draft.steps.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, validation: event.target.value } : item),
                  })}
                  className="rounded border border-border/60 bg-background px-2 py-1 text-[11px] text-foreground outline-none focus:border-primary"
                />
              </label>
            </div>
          ))}
          {formError && <div className="text-destructive">{formError}</div>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void save()}
              className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-40"
            >
              {submitting ? '保存中…' : '保存修改'}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => setEditing(false)}
              className="rounded border border-border/60 px-2 py-1 text-foreground-secondary disabled:opacity-40"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="font-medium text-foreground-secondary">{projection.plan.objective}</div>
          <ol className="mt-2 flex flex-col gap-1.5">
            {projection.plan.steps.map((step, index) => (
              <li key={step.stepId} className="rounded border border-border/30 px-2 py-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-foreground-secondary">{index + 1}. {step.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{TODO_STATUS_TEXT[step.status]}</span>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">验证：{step.validation}</div>
              </li>
            ))}
          </ol>
          {projection.plan.constraints.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] text-muted-foreground">约束</div>
              <ul className="mt-1 list-disc pl-4 text-[10px] text-foreground-secondary">
                {projection.plan.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}
              </ul>
            </div>
          )}
          {error?.code === 'EXECUTION_RESUME_FAILED' && (
            <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              计划已批准，但执行尚未开始。
            </div>
          )}
          {error && error.code !== 'EXECUTION_RESUME_FAILED' && (
            <div className="mt-2 text-destructive">计划状态已变化，请刷新后重试。</div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {projection.state === 'AWAITING_APPROVAL' && (
              <>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => setEditing(true)}
                  className="rounded border border-border/60 px-2 py-1 text-foreground-secondary disabled:opacity-40"
                >
                  修改计划
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void approveAndStart(attemptId)}
                  className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-40"
                >
                  {submitting ? '正在启动…' : '批准并开始执行'}
                </button>
              </>
            )}
            {projection.state === 'APPROVED' && resumeRequired && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void resumeExecution(attemptId)}
                className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-40"
              >
                {submitting ? '正在继续…' : '继续执行'}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
