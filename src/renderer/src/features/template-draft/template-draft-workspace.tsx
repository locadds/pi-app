import { useMemo, useRef, useState } from 'react'

import type { TemplateDraftReviewRequestV2 } from '@shared/xiaogui-template-draft-review'
import type { TemplateReviewActionV2, TemplateReviewResultV2 } from '@shared/xiaogui-work-template-review'
import { DocxHtmlViewer, type DocxHtmlViewerHandleV1 } from '@renderer/components/docx-html-viewer'
import { FileText, X } from '@renderer/components/icons'
import { TemplateFieldPanel } from './template-field-panel'
import { TemplateIssuePanel, type TemplateIssueChoiceStateV2 } from './template-issue-panel'

type WorkspaceTab = 'FIELDS' | 'ISSUES'

function actionWithFieldName(action: TemplateReviewActionV2, name: string): TemplateReviewActionV2 {
  if (action.kind === 'FIELD') return { ...action, fieldName: name }
  if (action.kind === 'REPEAT') return { ...action, blockName: name }
  if (action.kind === 'CONDITIONAL') return { ...action, conditionName: name }
  return action
}

export function TemplateDraftWorkspace({
  requestId,
  payload,
  onSuspend,
  onCancel,
  onSubmit,
  onOpenAdvanced,
}: {
  requestId: string
  payload: TemplateDraftReviewRequestV2
  onSuspend: () => void
  onCancel: (result: Extract<TemplateReviewResultV2, { cancelled: true }>) => void
  onSubmit: (result: TemplateReviewResultV2) => void
  onOpenAdvanced: () => void
}) {
  const [tab, setTab] = useState<WorkspaceTab>(payload.fieldGraph.issues.length ? 'ISSUES' : 'FIELDS')
  const [fieldNames, setFieldNames] = useState<Record<string, string>>(() => Object.fromEntries(payload.fieldGraph.fields.map((field) => [field.fieldId, field.displayName])))
  const [choices, setChoices] = useState<Record<string, TemplateIssueChoiceStateV2>>({})
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(payload.fieldGraph.fields[0]?.fieldId ?? null)
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(payload.fieldGraph.issues[0]?.issueId ?? null)
  const [message, setMessage] = useState<string | null>(null)
  const viewerRef = useRef<DocxHtmlViewerHandleV1 | null>(null)

  const visibleIssues = payload.fieldGraph.issues.slice(0, payload.quickIssueLimit)
  const overflowIssues = Math.max(0, payload.fieldGraph.issues.length - visibleIssues.length)
  const bindingByTarget = useMemo(() => new Map(payload.targetBindings.map((binding) => [binding.targetId, binding])), [payload.targetBindings])
  const pendingIssues = payload.fieldGraph.issues.filter((issue) => !choices[issue.issueId])

  const focusField = (fieldId: string) => {
    setSelectedFieldId(fieldId)
    const binding = payload.targetBindings.find((item) => item.fieldId === fieldId)
    if (binding) viewerRef.current?.focus(binding.targetId)
  }
  const focusIssue = (issueId: string) => {
    setSelectedIssueId(issueId)
    const binding = payload.targetBindings.find((item) => item.issueIds.includes(issueId))
    if (binding) viewerRef.current?.focus(binding.targetId)
  }

  const effectiveActions = (): TemplateReviewActionV2[] => payload.recommendedActions.map((recommended) => {
    const binding = bindingByTarget.get(recommended.targetId)
    let action = binding?.fieldId
      ? actionWithFieldName(recommended, fieldNames[binding.fieldId] || '待填写内容')
      : recommended
    for (const issueId of binding?.issueIds ?? []) {
      const choice = choices[issueId]
      if (!choice) continue
      if (choice.action === 'KEEP_ORIGINAL') {
        action = {
          targetId: recommended.targetId,
          kind: 'KEEP',
          ...(choice.reason
            ? { highRiskOverrideReason: choice.reason, highRiskOverrideConfirmed: true as const }
            : {}),
        }
      } else if (choice.action === 'REMOVE_CONTENT') {
        action = { targetId: recommended.targetId, kind: 'REMOVE' }
      }
    }
    return action
  })

  const submit = () => {
    if (pendingIssues.length) {
      setTab('ISSUES')
      const blocking = pendingIssues.find((issue) => issue.severity === 'BLOCKING')
      setMessage(blocking
        ? `还有 ${pendingIssues.length} 个问题未处理，其中“${blocking.title}”会阻止生成模板。`
        : `还有 ${pendingIssues.length} 个问题未处理。`)
      return
    }
    const invalidName = payload.fieldGraph.fields.find((field) => !fieldNames[field.fieldId]?.trim())
    if (invalidName) {
      setTab('FIELDS')
      setSelectedFieldId(invalidName.fieldId)
      setMessage('字段名称不能为空。')
      return
    }
    onSubmit({
      cancelled: false,
      actions: effectiveActions(),
      confirmedAtLocal: new Date().toISOString(),
      confirmedBy: 'LOCAL_USER',
    })
  }

  return (
    <div className="fixed inset-0 z-[100] flex bg-background" role="dialog" aria-modal="true" aria-label="模板草稿复核" data-request-id={requestId}>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-border px-5">
          <FileText className="h-5 w-5" />
          <div className="min-w-0">
            <h1 className="text-[14px] font-semibold">模板草稿</h1>
            <p className="truncate text-[11px] text-muted-foreground">{payload.document.source.displayName}</p>
          </div>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
            <span>{payload.fieldGraph.fields.length} 个业务字段</span>
            <span>{payload.fieldGraph.issues.length - pendingIssues.length} / {payload.fieldGraph.issues.length} 个问题已处理</span>
            <button type="button" onClick={onSuspend} className="rounded-md p-2 hover:bg-muted" aria-label="稍后继续"><X className="h-4 w-4" /></button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <main className="min-h-0 min-w-0 basis-[68%] bg-muted/30">
            {payload.document.render.mode === 'DOCX_HTML' ? (
              <DocxHtmlViewer
                ref={viewerRef}
                documentToken={payload.document.render.documentToken}
                targets={payload.advancedReview.targets}
                readonlyLabel="模板草稿预览；黄色位置需要确认"
                onSelectTarget={(target) => {
                  const binding = bindingByTarget.get(target.targetId)
                  if (binding?.issueIds[0]) {
                    setTab('ISSUES')
                    setSelectedIssueId(binding.issueIds[0])
                  } else if (binding?.fieldId) {
                    setTab('FIELDS')
                    setSelectedFieldId(binding.fieldId)
                  }
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-10 text-center text-[12px] leading-6 text-muted-foreground">
                当前文档只能使用结构化兼容视图。字段和问题仍可在右侧处理，或进入高级检查查看详细位置。
              </div>
            )}
          </main>

          <aside className="flex min-w-[360px] basis-[32%] flex-col border-l border-border bg-background">
            <div className="border-b border-border px-5 py-4">
              <p className="text-[13px] font-semibold">先确认模板要复用什么</p>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">普通正文默认原样保留。这里只展示业务字段和真正需要判断的问题。</p>
              <div className="mt-3 grid grid-cols-2 rounded-lg bg-muted p-1 text-[11px]">
                <button type="button" onClick={() => setTab('FIELDS')} className={`rounded-md px-2 py-1.5 ${tab === 'FIELDS' ? 'bg-background shadow-sm' : ''}`}>业务字段（{payload.fieldGraph.fields.length}）</button>
                <button type="button" onClick={() => setTab('ISSUES')} className={`rounded-md px-2 py-1.5 ${tab === 'ISSUES' ? 'bg-background shadow-sm' : ''}`}>待确认（{pendingIssues.length}）</button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {tab === 'FIELDS' ? (
                <TemplateFieldPanel
                  fields={payload.fieldGraph.fields}
                  names={fieldNames}
                  selectedFieldId={selectedFieldId}
                  onSelect={focusField}
                  onRename={(fieldId, name) => setFieldNames((current) => ({ ...current, [fieldId]: name }))}
                />
              ) : (
                <>
                  <TemplateIssuePanel
                    issues={visibleIssues}
                    choices={choices}
                    selectedIssueId={selectedIssueId}
                    onSelect={focusIssue}
                    onChoose={(issueId, choice) => {
                      if (choice.action === 'OPEN_ADVANCED_REVIEW') {
                        setChoices((current) => {
                          const next = { ...current }
                          delete next[issueId]
                          return next
                        })
                        return
                      }
                      setChoices((current) => ({ ...current, [issueId]: choice }))
                      setMessage(null)
                    }}
                    onOpenAdvanced={onOpenAdvanced}
                  />
                  {overflowIssues > 0 && (
                    <button type="button" onClick={onOpenAdvanced} className="mt-3 w-full rounded-lg border border-amber-300 bg-amber-50 p-3 text-left text-[11px] text-amber-800">
                      另有 {overflowIssues} 个复杂问题，请进入高级检查逐处处理。
                    </button>
                  )}
                </>
              )}
              {message && <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">{message}</p>}
            </div>
            <div className="border-t border-border p-4">
              <div className="flex items-center gap-2">
                <button type="button" onClick={onOpenAdvanced} className="rounded-md border px-3 py-2 text-[12px]">高级检查</button>
                <button type="button" onClick={() => onCancel({ cancelled: true, draftActions: effectiveActions() })} className="rounded-md border px-3 py-2 text-[12px]">关闭并保存草稿</button>
                <button type="button" onClick={submit} disabled={pendingIssues.length > 0} className="ml-auto rounded-md bg-primary px-3 py-2 text-[12px] text-primary-foreground disabled:opacity-40">确认字段草稿</button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
