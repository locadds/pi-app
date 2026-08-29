import { useState } from 'react'

import type {
  TemplateIssueActionV2,
  TemplateIssueV2,
} from '@shared/xiaogui-template-field-graph-v2'
import { AlertTriangle } from '@renderer/components/icons'
import { cn } from '@renderer/lib/utils'

export interface TemplateIssueChoiceStateV2 {
  action: TemplateIssueActionV2
  reason?: string
}

export function TemplateIssuePanel({
  issues,
  choices,
  selectedIssueId,
  onSelect,
  onChoose,
  onOpenAdvanced,
}: {
  issues: readonly TemplateIssueV2[]
  choices: Readonly<Record<string, TemplateIssueChoiceStateV2>>
  selectedIssueId: string | null
  onSelect: (issueId: string) => void
  onChoose: (issueId: string, choice: TemplateIssueChoiceStateV2) => void
  onOpenAdvanced: () => void
}) {
  const [keepIssueId, setKeepIssueId] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  if (!issues.length) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-[12px] leading-6 text-emerald-800">
        没有需要逐项确认的问题。未识别为字段的正文会原样保留。
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {issues.map((issue) => {
        const chosen = choices[issue.issueId]
        const highRisk = issue.kind === 'HIGH_RISK_CONTENT' || issue.kind === 'UNSUPPORTED_OBJECT'
        const cannotResolveHere = issue.kind === 'VALIDATION_FAILED' || issue.kind === 'SOURCE_CHANGED'
        return (
          <div
            key={issue.issueId}
            onClick={() => onSelect(issue.issueId)}
            className={cn(
              'rounded-lg border p-3',
              selectedIssueId === issue.issueId && 'border-primary bg-primary/5',
              issue.severity === 'BLOCKING' && !chosen && 'border-amber-300 bg-amber-50/50',
            )}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className={cn('mt-0.5 h-4 w-4', issue.severity === 'BLOCKING' ? 'text-amber-600' : 'text-muted-foreground')} />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-medium">{issue.title}</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{issue.question}</p>
              </div>
            </div>

            {chosen ? (
              <div className="mt-2 flex items-center justify-between rounded bg-emerald-50 px-2 py-1.5 text-[10px] text-emerald-800">
                <span>{chosen.action === 'ACCEPT_SUGGESTION' ? '已采用小规建议' : chosen.action === 'REMOVE_CONTENT' ? '已确认移除' : '已确认保留原文'}</span>
                <button type="button" onClick={(event) => { event.stopPropagation(); onChoose(issue.issueId, { action: 'OPEN_ADVANCED_REVIEW' }) }} className="underline">重新选择</button>
              </div>
            ) : cannotResolveHere ? (
              <button type="button" onClick={(event) => { event.stopPropagation(); onOpenAdvanced() }} className="mt-3 rounded-md border px-2.5 py-1.5 text-[11px] hover:bg-muted">
                进入高级检查
              </button>
            ) : keepIssueId === issue.issueId ? (
              <div className="mt-3" onClick={(event) => event.stopPropagation()}>
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} className="w-full rounded-md border border-amber-300 bg-background px-2 py-1.5 text-[11px]" placeholder="说明为什么要保留这类高风险内容" />
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" onClick={() => { setKeepIssueId(null); setReason('') }} className="rounded border px-2 py-1 text-[10px]">取消</button>
                  <button type="button" disabled={!reason.trim()} onClick={() => { onChoose(issue.issueId, { action: 'KEEP_ORIGINAL', reason: reason.trim() }); setKeepIssueId(null); setReason('') }} className="rounded bg-amber-600 px-2 py-1 text-[10px] text-white disabled:opacity-40">再次确认保留</button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {issue.suggestedActions.includes('ACCEPT_SUGGESTION') && (
                  <button type="button" onClick={(event) => { event.stopPropagation(); onChoose(issue.issueId, { action: 'ACCEPT_SUGGESTION' }) }} className="rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground">按建议处理</button>
                )}
                {issue.suggestedActions.includes('REMOVE_CONTENT') && (
                  <button type="button" onClick={(event) => { event.stopPropagation(); onChoose(issue.issueId, { action: 'REMOVE_CONTENT' }) }} className="rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground">确认移除</button>
                )}
                {issue.suggestedActions.includes('KEEP_ORIGINAL') && (
                  <button type="button" onClick={(event) => { event.stopPropagation(); if (highRisk) setKeepIssueId(issue.issueId); else onChoose(issue.issueId, { action: 'KEEP_ORIGINAL' }) }} className="rounded-md border px-2.5 py-1.5 text-[11px] hover:bg-muted">保留原文</button>
                )}
                <button type="button" onClick={(event) => { event.stopPropagation(); onOpenAdvanced() }} className="rounded-md border px-2.5 py-1.5 text-[11px] hover:bg-muted">逐处检查</button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

