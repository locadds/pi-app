// WORK-P3C-A 模板候选复核卡（custom kind = template_intake_review）。
// 冻结契约见 packages/shared/xiaogui-work-docx-template-intake.ts：
// 只渲染无路径预览与逻辑来源位置，绝不显示路径、OOXML、全文或内部存储标识。
// 遮罩 / X / Esc / 「稍后」一律走 onSuspend（只挂起，不 respond）；恢复后卡内草稿保留。
import { useEffect, useMemo, useState } from 'react'
import type {
  TemplateIntakeCandidateKindV1,
  TemplateIntakeCandidateV1,
  TemplateIntakeFinalDecisionItemV1,
  TemplateIntakeReviewRequestV1,
  TemplateIntakeReviewResultV1,
  TemplateIntakeRiskFlagV1,
  TemplateIntakeSourceAnchorV1,
} from '@shared/xiaogui-work-docx-template-intake'
import { TEMPLATE_INTAKE_REVIEW_PAGE_SIZE_V1 } from '@shared/xiaogui-work-docx-template-intake'
import { cn } from '@renderer/lib/utils'
import { AlertTriangle, ChevronLeft, ChevronRight, FileText, Search, X } from '@renderer/components/icons'

export interface TemplateIntakeDecisionEntry {
  decision: TemplateIntakeCandidateKindV1
  fieldName?: string
  highRiskOverrideReason?: string
}

export type TemplateIntakeDecisionState = Record<string, TemplateIntakeDecisionEntry>

export const TEMPLATE_INTAKE_DECISION_LABELS: Record<TemplateIntakeCandidateKindV1, string> = {
  FIXED: '固定内容',
  VARIABLE: '可变字段',
  REPEAT: '重复块',
  CONDITIONAL: '条件块',
  EXCLUDE: '排除项',
  UNRESOLVED: '无法判断',
}

const FINAL_DECISIONS = ['FIXED', 'VARIABLE', 'REPEAT', 'CONDITIONAL', 'EXCLUDE'] as const

const GROUP_ORDER: readonly TemplateIntakeCandidateKindV1[] = [
  'FIXED',
  'VARIABLE',
  'REPEAT',
  'CONDITIONAL',
  'EXCLUDE',
  'UNRESOLVED',
]

const RISK_FLAG_LABELS: Record<TemplateIntakeRiskFlagV1, string> = {
  SIGNATURE: '签名',
  SEAL: '印章',
  CONTACT_INFORMATION: '联系方式',
  OLD_PROJECT_DRAWING: '旧项目图纸',
  SCANNED_ATTACHMENT: '扫描附件',
  FLOATING_OBJECT: '浮动对象',
  TEXT_BOX: '文本框',
  OTHER: '其他',
}

const PART_LABELS: Record<TemplateIntakeSourceAnchorV1['part'], string> = {
  BODY: '正文',
  HEADER: '页眉',
  FOOTER: '页脚',
  TABLE: '表格',
  TEXT_BOX: '文本框',
  DRAWING: '图形',
}

/** 高风险 = 带任意风险标记的候选；默认必须排除。 */
export function isTemplateIntakeHighRisk(candidate: TemplateIntakeCandidateV1): boolean {
  return candidate.riskFlags.length > 0
}

/** 把无路径来源锚点转成人类可读的 Word 逻辑位置（序号从 1 开始，契约已约定）。 */
export function formatSourceAnchor(anchor: TemplateIntakeSourceAnchorV1): string {
  const parts: string[] = [PART_LABELS[anchor.part]]
  if (anchor.sectionIndex != null) parts.push(`第 ${anchor.sectionIndex} 节`)
  if (anchor.partIndex != null) parts.push(`片段 ${anchor.partIndex}`)
  if (anchor.tableIndex != null) parts.push(`表格 ${anchor.tableIndex}`)
  if (anchor.rowIndex != null) parts.push(`第 ${anchor.rowIndex} 行`)
  if (anchor.cellIndex != null) parts.push(`第 ${anchor.cellIndex} 列`)
  if (anchor.paragraphIndex != null) parts.push(`第 ${anchor.paragraphIndex} 段`)
  if (anchor.drawingIndex != null) parts.push(`图形 ${anchor.drawingIndex}`)
  return parts.join(' · ')
}

export function formatSourceAnchors(anchors: readonly TemplateIntakeSourceAnchorV1[]): string {
  if (anchors.length === 0) return '位置未知'
  return anchors.map(formatSourceAnchor).join('；')
}

/** 初始决定：草稿优先；高风险候选默认排除；其余用报告给的默认决定。 */
export function initialTemplateIntakeDecisions(
  payload: TemplateIntakeReviewRequestV1,
): TemplateIntakeDecisionState {
  const draftByCandidate = new Map(payload.draftDecisions.map((d) => [d.candidateId, d]))
  const state: TemplateIntakeDecisionState = {}
  for (const c of payload.report.candidates) {
    const draft = draftByCandidate.get(c.candidateId)
    const decision = draft?.decision ?? (isTemplateIntakeHighRisk(c) ? 'EXCLUDE' : c.defaultDecision)
    state[c.candidateId] = {
      decision,
      fieldName: draft?.fieldName ?? (decision === 'VARIABLE' ? c.suggestedName : undefined),
      highRiskOverrideReason: draft?.highRiskOverrideReason,
    }
  }
  return state
}

export type TemplateIntakeGroupFilter = 'ALL' | TemplateIntakeCandidateKindV1

export function filterTemplateIntakeCandidates(
  candidates: readonly TemplateIntakeCandidateV1[],
  state: TemplateIntakeDecisionState,
  group: TemplateIntakeGroupFilter,
  keyword: string,
): TemplateIntakeCandidateV1[] {
  const kw = keyword.trim().toLowerCase()
  return candidates.filter((c) => {
    const entry = state[c.candidateId]
    const decision = entry?.decision ?? c.defaultDecision
    if (group !== 'ALL' && decision !== group) return false
    if (!kw) return true
    const haystack = [c.preview, c.reason, entry?.fieldName, formatSourceAnchors(c.sourceAnchors)]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    return haystack.includes(kw)
  })
}

export interface TemplateIntakeSubmitCheck {
  unresolvedCount: number
  missingVariableFieldNameIds: string[]
  missingOverrideReasonIds: string[]
  highRiskOverrides: Array<{ candidate: TemplateIntakeCandidateV1; reason: string }>
}

export function checkTemplateIntakeSubmit(
  report: TemplateIntakeReviewRequestV1['report'],
  state: TemplateIntakeDecisionState,
): TemplateIntakeSubmitCheck {
  let unresolvedCount = 0
  const missingVariableFieldNameIds: string[] = []
  const missingOverrideReasonIds: string[] = []
  const highRiskOverrides: TemplateIntakeSubmitCheck['highRiskOverrides'] = []
  for (const c of report.candidates) {
    const entry = state[c.candidateId]
    const decision = entry?.decision ?? 'UNRESOLVED'
    if (decision === 'UNRESOLVED') {
      unresolvedCount += 1
      continue
    }
    if (decision === 'VARIABLE' && !entry?.fieldName?.trim()) {
      missingVariableFieldNameIds.push(c.candidateId)
    }
    if (isTemplateIntakeHighRisk(c) && decision !== 'EXCLUDE') {
      const reason = (entry?.highRiskOverrideReason ?? '').trim()
      if (!reason) missingOverrideReasonIds.push(c.candidateId)
      else highRiskOverrides.push({ candidate: c, reason })
    }
  }
  return { unresolvedCount, missingVariableFieldNameIds, missingOverrideReasonIds, highRiskOverrides }
}

/**
 * 展开为逐项最终决定：candidateId 与报告候选一一对应，不遗漏不新增。
 * 仅在通过 checkTemplateIntakeSubmit 且高风险覆盖已二次确认后调用。
 */
export function buildTemplateIntakeResult(
  report: TemplateIntakeReviewRequestV1['report'],
  state: TemplateIntakeDecisionState,
): TemplateIntakeReviewResultV1 {
  const decisions: TemplateIntakeFinalDecisionItemV1[] = report.candidates.map((c) => {
    const entry = state[c.candidateId]
    const decision = (entry?.decision ?? 'EXCLUDE') as TemplateIntakeFinalDecisionItemV1['decision']
    const item: TemplateIntakeFinalDecisionItemV1 = { candidateId: c.candidateId, decision }
    if (decision === 'VARIABLE' && entry?.fieldName?.trim()) item.fieldName = entry.fieldName.trim()
    if (isTemplateIntakeHighRisk(c) && decision !== 'EXCLUDE') {
      item.highRiskOverrideReason = (entry?.highRiskOverrideReason ?? '').trim()
      item.highRiskOverrideConfirmed = true
    }
    return item
  })
  return { cancelled: false, decisions }
}

export function buildTemplateIntakeDraftResult(
  report: TemplateIntakeReviewRequestV1['report'],
  state: TemplateIntakeDecisionState,
): Extract<TemplateIntakeReviewResultV1, { cancelled: true }> {
  return {
    cancelled: true,
    draftDecisions: report.candidates.map((candidate) => {
      const entry = state[candidate.candidateId]
      return {
        candidateId: candidate.candidateId,
        decision: entry?.decision ?? candidate.defaultDecision,
        ...(entry?.fieldName ? { fieldName: entry.fieldName } : {}),
        ...(entry?.highRiskOverrideReason
          ? { highRiskOverrideReason: entry.highRiskOverrideReason }
          : {}),
      }
    }),
  }
}

// ---- 卡内草稿：挂起/恢复期间保留，提交或放弃后清除 ----

const draftByRequestId = new Map<string, TemplateIntakeDecisionState>()
const MAX_SUSPENDED_DRAFTS = 50

export function loadTemplateIntakeDraft(
  requestId: string,
  payload: TemplateIntakeReviewRequestV1,
): TemplateIntakeDecisionState {
  const existing = draftByRequestId.get(requestId)
  if (existing) return existing
  const initial = initialTemplateIntakeDecisions(payload)
  saveTemplateIntakeDraft(requestId, initial)
  return initial
}

export function saveTemplateIntakeDraft(requestId: string, state: TemplateIntakeDecisionState): void {
  if (!draftByRequestId.has(requestId) && draftByRequestId.size >= MAX_SUSPENDED_DRAFTS) {
    const oldestRequestId = draftByRequestId.keys().next().value
    if (typeof oldestRequestId === 'string') draftByRequestId.delete(oldestRequestId)
  }
  draftByRequestId.set(requestId, state)
}

export function clearTemplateIntakeDraft(requestId: string): void {
  draftByRequestId.delete(requestId)
}

// ---- 组件 ----

export function TemplateIntakeReviewDialog({
  requestId,
  payload,
  onSuspend,
  onCancel,
  onSubmit,
}: {
  requestId: string
  payload: TemplateIntakeReviewRequestV1
  /** 遮罩 / X / Esc / 「稍后」：只挂起，不 respond，不产生确认记录。 */
  onSuspend: () => void
  /** 明确关闭：返回 cancelled:true 和逐项草稿，不产生确认记录。 */
  onCancel: (result: Extract<TemplateIntakeReviewResultV1, { cancelled: true }>) => void
  onSubmit: (result: TemplateIntakeReviewResultV1) => void
}) {
  const { report } = payload
  const pageSize = TEMPLATE_INTAKE_REVIEW_PAGE_SIZE_V1
  const [decisions, setDecisions] = useState<TemplateIntakeDecisionState>(() =>
    loadTemplateIntakeDraft(requestId, payload),
  )
  const [group, setGroup] = useState<TemplateIntakeGroupFilter>('ALL')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(0)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [showSecondConfirm, setShowSecondConfirm] = useState(false)

  useEffect(() => {
    saveTemplateIntakeDraft(requestId, decisions)
  }, [requestId, decisions])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showSecondConfirm) setShowSecondConfirm(false)
      else onSuspend()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSuspend, showSecondConfirm])

  const filtered = useMemo(
    () => filterTemplateIntakeCandidates(report.candidates, decisions, group, keyword),
    [report.candidates, decisions, group, keyword],
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pageItems = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  const groupCounts = useMemo(() => {
    const counts: Record<TemplateIntakeCandidateKindV1, number> = {
      FIXED: 0, VARIABLE: 0, REPEAT: 0, CONDITIONAL: 0, EXCLUDE: 0, UNRESOLVED: 0,
    }
    for (const c of report.candidates) {
      const d = decisions[c.candidateId]?.decision ?? c.defaultDecision
      counts[d] += 1
    }
    return counts
  }, [report.candidates, decisions])

  const unresolvedCount = groupCounts.UNRESOLVED

  const setEntry = (candidateId: string, patch: Partial<TemplateIntakeDecisionEntry>) => {
    setDecisions((prev) => ({
      ...prev,
      [candidateId]: { ...prev[candidateId], ...patch },
    }))
    setSubmitError(null)
  }

  const applyBatch = (decision: (typeof FINAL_DECISIONS)[number]) => {
    setDecisions((prev) => {
      const next = { ...prev }
      for (const c of filtered) {
        next[c.candidateId] = {
          ...next[c.candidateId],
          decision,
          fieldName:
            decision === 'VARIABLE'
              ? (next[c.candidateId]?.fieldName ?? c.suggestedName)
              : next[c.candidateId]?.fieldName,
        }
      }
      return next
    })
    setSubmitError(null)
  }

  const attemptSubmit = () => {
    const check = checkTemplateIntakeSubmit(report, decisions)
    if (check.unresolvedCount > 0) {
      setSubmitError(`还有 ${check.unresolvedCount} 项「无法判断」，请为每项做出决定后再提交。`)
      return
    }
    if (check.missingVariableFieldNameIds.length > 0) {
      setSubmitError(`有 ${check.missingVariableFieldNameIds.length} 个可变字段尚未填写字段名。`)
      return
    }
    if (check.missingOverrideReasonIds.length > 0) {
      setSubmitError(
        `有 ${check.missingOverrideReasonIds.length} 项高风险候选不再排除，必须为每项填写覆盖理由后才能提交。`,
      )
      return
    }
    if (check.highRiskOverrides.length > 0) {
      setShowSecondConfirm(true)
      return
    }
    clearTemplateIntakeDraft(requestId)
    onSubmit(buildTemplateIntakeResult(report, decisions))
  }

  const confirmOverridesAndSubmit = () => {
    clearTemplateIntakeDraft(requestId)
    onSubmit(buildTemplateIntakeResult(report, decisions))
  }

  const handleCancel = () => {
    clearTemplateIntakeDraft(requestId)
    onCancel(buildTemplateIntakeDraftResult(report, decisions))
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !showSecondConfirm) onSuspend()
      }}
    >
      <div
        className="relative flex max-h-[85vh] w-full max-w-4xl flex-col rounded-xl border border-border bg-background shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="模板候选复核"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            <span className="text-[13px] font-semibold">模板候选复核</span>
            <span className="text-[11px] text-muted-foreground">
              {report.file.displayName} · 共 {report.candidates.length} 项候选
            </span>
          </div>
          <button
            type="button"
            onClick={onSuspend}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            aria-label="稍后"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 分组与关键词筛选 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2">
          <button
            type="button"
            data-testid="group-all"
            onClick={() => { setGroup('ALL'); setPage(0) }}
            className={cn(
              'rounded-md border px-2 py-1 text-[11px]',
              group === 'ALL' ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted',
            )}
          >
            全部（{report.candidates.length}）
          </button>
          {GROUP_ORDER.map((g) => (
            <button
              key={g}
              type="button"
              data-testid={`group-${g}`}
              onClick={() => { setGroup(g); setPage(0) }}
              className={cn(
                'rounded-md border px-2 py-1 text-[11px]',
                group === g ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted',
                g === 'UNRESOLVED' && groupCounts.UNRESOLVED > 0 && 'border-amber-500/60 text-amber-600',
              )}
            >
              {TEMPLATE_INTAKE_DECISION_LABELS[g]}（{groupCounts[g]}）
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={keyword}
              onChange={(e) => { setKeyword(e.target.value); setPage(0) }}
              placeholder="按关键词筛选"
              aria-label="按关键词筛选"
              className="w-40 bg-transparent text-[12px] focus:outline-none"
            />
          </div>
        </div>

        {/* 批量决定（作用于当前筛选结果，提交时展开为逐项记录） */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
          <span>将当前筛选的 {filtered.length} 项设为：</span>
          {FINAL_DECISIONS.map((d) => (
            <button
              key={d}
              type="button"
              data-testid={`batch-${d}`}
              disabled={filtered.length === 0}
              onClick={() => applyBatch(d)}
              className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-40"
            >
              {TEMPLATE_INTAKE_DECISION_LABELS[d]}
            </button>
          ))}
        </div>

        {/* 候选列表 */}
        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {pageItems.length === 0 && (
            <div className="py-10 text-center text-[12px] text-muted-foreground">当前筛选条件下没有候选</div>
          )}
          {pageItems.map((c) => {
            const entry = decisions[c.candidateId]
            const decision = entry?.decision ?? c.defaultDecision
            const highRisk = isTemplateIntakeHighRisk(c)
            const needsOverrideReason = highRisk && decision !== 'EXCLUDE'
            return (
              <div
                key={c.candidateId}
                data-testid={`candidate-${c.candidateId}`}
                className="rounded-lg border border-border/60 bg-muted/10 p-3"
              >
                <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/90">
                  {c.preview}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>来源：{formatSourceAnchors(c.sourceAnchors)}</span>
                  <span>置信度：{c.confidence == null ? '无法确定' : `${Math.round(c.confidence * 100)}%`}</span>
                  {c.riskFlags.map((f) => (
                    <span
                      key={f}
                      className="inline-flex items-center gap-0.5 rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600"
                    >
                      <AlertTriangle className="h-3 w-3" />
                      {RISK_FLAG_LABELS[f]}
                    </span>
                  ))}
                </div>
                {c.reason && (
                  <div className="mt-1.5 text-[11px] text-muted-foreground">理由：{c.reason}</div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">决定：</span>
                  {decision === 'UNRESOLVED' && (
                    <span className="rounded border border-amber-500/60 px-1.5 py-0.5 text-[10px] text-amber-600">
                      无法判断（待决定）
                    </span>
                  )}
                  {FINAL_DECISIONS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      data-testid={`decision-${c.candidateId}-${d}`}
                      onClick={() =>
                        setEntry(c.candidateId, {
                          decision: d,
                          fieldName: d === 'VARIABLE' ? (entry?.fieldName ?? c.suggestedName) : entry?.fieldName,
                        })
                      }
                      className={cn(
                        'rounded-md border px-2 py-1 text-[11px]',
                        decision === d
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:bg-muted',
                      )}
                    >
                      {TEMPLATE_INTAKE_DECISION_LABELS[d]}
                    </button>
                  ))}
                </div>
                {decision === 'VARIABLE' && (
                  <input
                    value={entry?.fieldName ?? ''}
                    onChange={(e) => setEntry(c.candidateId, { fieldName: e.target.value })}
                    placeholder="字段名"
                    aria-label={`字段名 ${c.candidateId}`}
                    className="mt-2 w-64 rounded-md border border-border bg-background px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                )}
                {needsOverrideReason && (
                  <div className="mt-2">
                    <textarea
                      value={entry?.highRiskOverrideReason ?? ''}
                      onChange={(e) => setEntry(c.candidateId, { highRiskOverrideReason: e.target.value })}
                      placeholder="该候选含风险标记，不再排除时必须填写覆盖理由"
                      aria-label={`覆盖理由 ${c.candidateId}`}
                      rows={2}
                      className="w-full rounded-md border border-amber-500/50 bg-background px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 分页 */}
        <div className="flex items-center justify-between border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
          <span>
            第 {currentPage + 1} / {pageCount} 页 · 筛选后 {filtered.length} 项（每页 {pageSize} 项）
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              data-testid="page-prev"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
              className="rounded-md border border-border p-1 hover:bg-muted disabled:opacity-40"
              aria-label="上一页"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              data-testid="page-next"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(currentPage + 1)}
              className="rounded-md border border-border p-1 hover:bg-muted disabled:opacity-40"
              aria-label="下一页"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSuspend}
              className="rounded-md border border-border px-3 py-1.5 text-[12px] hover:bg-muted"
            >
              稍后
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-md border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-muted"
            >
              关闭并保存草稿
            </button>
          </div>
          <div className="flex items-center gap-3">
            {unresolvedCount > 0 && (
              <span data-testid="unresolved-hint" className="text-[11px] text-amber-600">
                还有 {unresolvedCount} 项无法判断
              </span>
            )}
            <button
              type="button"
              data-testid="submit-review"
              onClick={attemptSubmit}
              disabled={unresolvedCount > 0}
              className="rounded-md bg-primary px-3 py-1.5 text-[12px] text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              提交最终决定
            </button>
          </div>
        </div>

        {submitError && (
          <div data-testid="submit-error" className="border-t border-amber-500/40 bg-amber-500/10 px-4 py-2 text-[12px] text-amber-700">
            {submitError}
          </div>
        )}

        {/* 高风险覆盖二次确认：未确认前禁止返回 */}
        {showSecondConfirm && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-black/50 p-4">
            <div className="w-full max-w-lg rounded-xl border border-border bg-background p-5 shadow-xl" role="alertdialog" aria-label="高风险覆盖确认">
              <h3 className="mb-2 flex items-center gap-2 text-[14px] font-semibold">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                确认高风险覆盖
              </h3>
              <p className="mb-3 text-[12px] text-muted-foreground">
                以下候选带有风险标记，你选择不再排除。请逐项确认覆盖理由，确认后将写入最终决定。
              </p>
              <div className="max-h-[40vh] space-y-2 overflow-y-auto">
                {checkTemplateIntakeSubmit(report, decisions).highRiskOverrides.map(({ candidate, reason }) => (
                  <div key={candidate.candidateId} className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
                    <div className="text-[12px] text-foreground/90">
                      {candidate.preview.slice(0, 80)}
                      {candidate.preview.length > 80 ? '…' : ''}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">覆盖理由：{reason}</div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="second-confirm-back"
                  onClick={() => setShowSecondConfirm(false)}
                  className="rounded-md border border-border px-3 py-1.5 text-[12px] hover:bg-muted"
                >
                  返回修改
                </button>
                <button
                  type="button"
                  data-testid="second-confirm-ok"
                  onClick={confirmOverridesAndSubmit}
                  className="rounded-md bg-amber-600 px-3 py-1.5 text-[12px] text-white hover:opacity-90"
                >
                  确认覆盖并提交
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
