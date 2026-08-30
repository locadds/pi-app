import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  TemplateReviewActionV2,
  TemplateReviewRequestV2,
  TemplateReviewRequestV3,
  TemplateReviewResultV2,
  TemplateReviewTargetV2,
  TemplateReviewTargetV3,
  TemplateReviewTextRangeV2,
} from '@shared/xiaogui-work-template-review'
import type { TemplateDraftReviewRequestV2 } from '@shared/xiaogui-template-draft-review'
import { ipcClient } from '@renderer/lib/ipc-client'
import { cn } from '@renderer/lib/utils'
import {
  AlertTriangle,
  FileText,
  Search,
  X,
} from '@renderer/components/icons'
import {
  DocumentSurfaceViewerV1,
  type DocumentSurfaceViewerHandleV1,
} from '@renderer/features/document-surface/document-surface-viewer'
import { TemplateDraftWorkspace } from '@renderer/features/template-draft/template-draft-workspace'

type TemplateReviewRequest = TemplateReviewRequestV2 | TemplateReviewRequestV3
type TemplateReviewTarget = TemplateReviewTargetV2 | TemplateReviewTargetV3
type ActionKind = TemplateReviewActionV2['kind']
type ActionState = Record<string, TemplateReviewActionV2[]>

const ACTION_LABELS: Record<ActionKind, string> = {
  KEEP: '原样保留',
  REPLACE_TEXT: '改成固定文字',
  FIELD: '设为待填写内容',
  REMOVE: '移除',
  REPLACE_IMAGE: '替换图片',
  REPEAT: '设为重复内容',
  CONDITIONAL: '设为条件内容',
}

const HIGH_RISK_LABELS: Record<string, string> = {
  SIGNATURE: '签字',
  SEAL: '印章',
  CONTACT_INFORMATION: '联系方式',
  OLD_PROJECT_DRAWING: '旧项目图件',
  SCANNED_ATTACHMENT: '扫描附件',
  FLOATING_OBJECT: '浮动对象',
  TEXT_BOX: '文本框',
  LOW_CONFIDENCE: '判断把握较低',
  PARSER_EXCEPTION: '解析异常',
  OTHER: '需要人工判断',
}

const draftByRequestId = new Map<string, ActionState>()

function isV3(payload: TemplateReviewRequest): payload is TemplateReviewRequestV3 {
  return payload.reviewVersion === 3
}

function groupActions(actions: readonly TemplateReviewActionV2[]): ActionState {
  const grouped: ActionState = {}
  for (const action of actions) {
    ;(grouped[action.targetId] ??= []).push(action)
  }
  return grouped
}

function requiresExplicitDecision(target: TemplateReviewTarget): boolean {
  return target.highlight === 'YELLOW' || target.highRisk || target.kind === 'UNMAPPED'
}

function defaultActions(payload: TemplateReviewRequest): ActionState {
  const state = groupActions(payload.draftActions)
  for (const target of payload.targets) {
    if (state[target.targetId]?.length) continue
    if (!requiresExplicitDecision(target)) state[target.targetId] = [{ targetId: target.targetId, kind: 'KEEP' }]
  }
  return state
}

function needsHighRiskOverride(
  target: TemplateReviewTarget | undefined,
  action: TemplateReviewActionV2,
): boolean {
  return !!target?.highRisk && (action.kind !== 'REMOVE' || !!action.range)
}

function selectedTextRange(container: HTMLElement | null): TemplateReviewTextRangeV2 | null {
  if (!container) return null
  const selection = window.getSelection()
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!container.contains(range.commonAncestorContainer)) return null
  const prefix = range.cloneRange()
  prefix.selectNodeContents(container)
  prefix.setEnd(range.startContainer, range.startOffset)
  const startUtf16 = prefix.toString().length
  const endUtf16Exclusive = startUtf16 + range.toString().length
  return endUtf16Exclusive > startUtf16 ? { startUtf16, endUtf16Exclusive } : null
}

function actionForRange(
  targetId: string,
  kind: ActionKind,
  range: TemplateReviewTextRangeV2 | null,
  value: string,
): TemplateReviewActionV2 {
  const base = { targetId, ...(range ? { range } : {}) }
  switch (kind) {
    case 'KEEP': return { ...base, kind }
    case 'REMOVE': return { ...base, kind }
    case 'REPLACE_TEXT': return { ...base, kind, replacementText: value }
    case 'FIELD': return { ...base, kind, fieldName: value }
    case 'REPLACE_IMAGE': return { ...base, kind, replacementImageToken: value }
    case 'REPEAT': return { ...base, kind, blockName: value }
    case 'CONDITIONAL': return { ...base, kind, conditionName: value }
  }
}

function rangeOverlaps(left: TemplateReviewTextRangeV2, right: TemplateReviewTextRangeV2): boolean {
  return left.startUtf16 < right.endUtf16Exclusive && right.startUtf16 < left.endUtf16Exclusive
}

function asV3Target(target: TemplateReviewTarget): TemplateReviewTargetV3 {
  if ('renderAnchor' in target) return target
  return {
    ...target,
    renderAnchor: { status: 'UNMAPPED', textSelectionAllowed: false },
  }
}

function canSplitTarget(target: TemplateReviewTarget | null): boolean {
  if (!target || target.kind === 'IMAGE') return false
  return !('renderAnchor' in target) || target.renderAnchor.textSelectionAllowed
}

function isDirectDocxReview(payload: TemplateReviewRequest): payload is TemplateReviewRequestV3 {
  return isV3(payload) && payload.document.render.mode === 'DOCX_HTML'
}

type TemplateReviewDialogProps = {
  requestId: string
  payload: TemplateDraftReviewRequestV2 | TemplateReviewRequest
  onSuspend: () => void
  onCancel: (result: Extract<TemplateReviewResultV2, { cancelled: true }>) => void
  onSubmit: (result: TemplateReviewResultV2) => void
}

export function TemplateReviewV2Dialog(props: TemplateReviewDialogProps) {
  const [advanced, setAdvanced] = useState(false)
  if (props.payload.reviewVersion === 4) {
    if (advanced) {
      return (
        <TemplateCandidateReviewDialog
          {...props}
          payload={props.payload.advancedReview}
          onSuspend={() => setAdvanced(false)}
        />
      )
    }
    return (
      <TemplateDraftWorkspace
        {...props}
        payload={props.payload}
        onOpenAdvanced={() => setAdvanced(true)}
      />
    )
  }
  return <TemplateCandidateReviewDialog {...props} payload={props.payload} />
}

function TemplateCandidateReviewDialog({
  requestId,
  payload,
  onSuspend,
  onCancel,
  onSubmit,
}: Omit<TemplateReviewDialogProps, 'payload'> & { payload: TemplateReviewRequest }) {
  const initial = draftByRequestId.get(requestId) ?? defaultActions(payload)
  const [actions, setActions] = useState<ActionState>(initial)
  const [selectedId, setSelectedId] = useState(() =>
    payload.targets.find((target) => requiresExplicitDecision(target) && !initial[target.targetId]?.length)?.targetId
      ?? payload.targets[0]?.targetId
      ?? '',
  )
  const [query, setQuery] = useState('')
  const [chosenRange, setChosenRange] = useState<TemplateReviewTextRangeV2 | null>(null)
  const [editKind, setEditKind] = useState<ActionKind | null>(null)
  const [editValue, setEditValue] = useState('')
  const [replacementImageName, setReplacementImageName] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [confirmingHighRisk, setConfirmingHighRisk] = useState(false)
  const [viewerMappedIds, setViewerMappedIds] = useState<readonly string[]>([])
  const targetElement = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<DocumentSurfaceViewerHandleV1 | null>(null)

  useEffect(() => {
    draftByRequestId.set(requestId, actions)
  }, [actions, requestId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (confirmingHighRisk) setConfirmingHighRisk(false)
      else onSuspend()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmingHighRisk, onSuspend])

  const selectedTarget = payload.targets.find((target) => target.targetId === selectedId) ?? null
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
  const filteredTargets = useMemo(() => payload.targets.filter((target) =>
    !normalizedQuery ||
    `${target.preview}\n${target.reason}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery),
  ), [normalizedQuery, payload.targets])
  const officeReviewTargets = useMemo(
    () => isV3(payload) ? payload.targets.map(asV3Target) : [],
    [payload],
  )
  const pendingTargets = payload.targets.filter(
    (target) => requiresExplicitDecision(target) && !(actions[target.targetId]?.length),
  )
  const unresolvedInViewer = useMemo(
    () => new Set(
      isV3(payload)
        ? payload.targets
            .filter((target) => target.renderAnchor.status !== 'PROJECTED' || !viewerMappedIds.includes(target.targetId))
            .map((target) => target.targetId)
        : payload.targets.map((target) => target.targetId),
    ),
    [payload, viewerMappedIds],
  )
  const resolvedCount = payload.targets.length - pendingTargets.length

  const selectTarget = (target: TemplateReviewTarget) => {
    setSelectedId(target.targetId)
    if (isDirectDocxReview(payload)) viewerRef.current?.focusTarget(target.targetId)
    setChosenRange(null)
    setEditKind(null)
    setEditValue('')
    setReplacementImageName('')
    setOverrideReason(actions[target.targetId]?.[0]?.highRiskOverrideReason ?? '')
    setMessage(null)
  }

  const captureRange = () => {
    if (!canSplitTarget(selectedTarget)) {
      setChosenRange(null)
      if (selectedTarget && 'renderAnchor' in selectedTarget && selectedTarget.renderAnchor.status === 'PROJECTED') {
        setMessage('此处已在文档中定位，但文字范围不能可靠换算；请整段处理。')
      }
      return
    }
    if (isV3(payload) && !isDirectDocxReview(payload)) {
      setChosenRange(null)
      setMessage('当前是结构化复核视图，不能可靠框选拆分；请整项处理。')
      return
    }
    const selection = isDirectDocxReview(payload)
      ? viewerRef.current?.readSelection() ?? null
      : null
    if (selection) {
      setSelectedId(selection.targetId)
      setChosenRange(selection.range)
      setMessage(`已选择第 ${selection.range.startUtf16 + 1} 至 ${selection.range.endUtf16Exclusive} 个字符，可只处理这部分。`)
      return
    }
    if (isDirectDocxReview(payload)) {
      setChosenRange(null)
      setMessage('请先在左侧文档标黄内容中框选一段文字。')
      return
    }
    const range = selectedTextRange(targetElement.current)
    setChosenRange(range)
    if (range) setMessage(`已选择第 ${range.startUtf16 + 1} 至 ${range.endUtf16Exclusive} 个字符，可只处理这部分。`)
  }

  const applyAction = (kind: ActionKind, value = '') => {
    if (!selectedTarget) return
    if (['REPLACE_TEXT', 'FIELD', 'REPLACE_IMAGE', 'REPEAT', 'CONDITIONAL'].includes(kind) && !value.trim()) {
      setMessage(kind === 'FIELD' ? '请填写中文字段名。' : '请先填写修改内容。')
      return
    }
    const nextAction = actionForRange(selectedTarget.targetId, kind, chosenRange, value.trim())
    if (needsHighRiskOverride(selectedTarget, nextAction)) {
      if (!overrideReason.trim()) {
        setMessage('此处属于高风险内容，保留或修改前请填写原因。')
        return
      }
      nextAction.highRiskOverrideReason = overrideReason.trim()
    }
    const current = actions[selectedTarget.targetId] ?? []
    if (chosenRange && current.some((action) => action.range && rangeOverlaps(action.range, chosenRange))) {
      setMessage('该选区与已处理部分重叠，请重新框选。')
      return
    }
    setActions((previous) => {
      if (!chosenRange) return { ...previous, [selectedTarget.targetId]: [nextAction] }
      const ranged = (previous[selectedTarget.targetId] ?? []).filter((action) => action.range)
      return { ...previous, [selectedTarget.targetId]: [...ranged, nextAction] }
    })
    setEditKind(null)
    setEditValue('')
    setChosenRange(null)
    setReplacementImageName('')
    window.getSelection()?.removeAllRanges()
    setMessage('已保存此处决定。')
  }

  const beginEdit = (kind: ActionKind) => {
    setEditKind(kind)
    setEditValue(kind === 'REPLACE_TEXT' && chosenRange && selectedTarget
      ? selectedTarget.preview.slice(chosenRange.startUtf16, chosenRange.endUtf16Exclusive)
      : '')
    setMessage(null)
  }

  const chooseReplacementImage = async () => {
    setMessage(null)
    try {
      const result = await ipcClient.invoke('xiaogui.templateReview.image.choose') as
        | { cancelled: true }
        | { cancelled: false; token: string; displayName: string }
      if (result.cancelled) return
      setEditKind('REPLACE_IMAGE')
      setEditValue(result.token)
      setReplacementImageName(result.displayName)
    } catch {
      setMessage('替换图片读取失败，请重新选择 PNG 或 JPG。')
    }
  }

  const submit = (highRiskConfirmed: boolean) => {
    if (pendingTargets.length) {
      setMessage(`还有 ${pendingTargets.length} 处黄色内容没有处理。`)
      return
    }
    const allActions = Object.values(actions).flat()
    const highRiskActions = allActions.filter((action) => {
      const target = payload.targets.find((item) => item.targetId === action.targetId)
      return needsHighRiskOverride(target, action)
    })
    const missingReason = highRiskActions.find((action) => !action.highRiskOverrideReason?.trim())
    if (missingReason) {
      const target = payload.targets.find((item) => item.targetId === missingReason.targetId)
      if (target) selectTarget(target)
      setMessage('高风险内容需要填写保留或修改原因后才能继续。')
      return
    }
    if (highRiskActions.length && !highRiskConfirmed) {
      setConfirmingHighRisk(true)
      return
    }
    const confirmedActions = highRiskConfirmed
      ? allActions.map((action) => {
          const target = payload.targets.find((item) => item.targetId === action.targetId)
          return needsHighRiskOverride(target, action)
            ? { ...action, highRiskOverrideConfirmed: true as const }
            : action
        })
      : allActions
    draftByRequestId.delete(requestId)
    onSubmit({
      cancelled: false,
      actions: confirmedActions,
      confirmedAtLocal: new Date().toISOString(),
      confirmedBy: 'LOCAL_USER',
    })
  }

  const cancel = () => {
    draftByRequestId.delete(requestId)
    onCancel({ cancelled: true, draftActions: Object.values(actions).flat() })
  }

  return (
    <div className="fixed inset-0 z-[100] flex bg-background" role="dialog" aria-modal="true" aria-label="文档模板复核">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-border px-5">
          <FileText className="h-5 w-5" />
          <div className="min-w-0">
            <h1 className="text-[14px] font-semibold">文档模板复核</h1>
            <p className="truncate text-[11px] text-muted-foreground">{payload.document.source.displayName}</p>
          </div>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
            <span>{resolvedCount} / {payload.targets.length} 已明确</span>
            <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary" style={{ width: `${payload.targets.length ? resolvedCount / payload.targets.length * 100 : 100}%` }} />
            </div>
            <button type="button" onClick={onSuspend} className="rounded-md p-2 hover:bg-muted" aria-label="稍后继续"><X className="h-4 w-4" /></button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <main className="flex min-h-0 min-w-0 basis-[70%] flex-col overflow-hidden bg-muted/30">
            <div className="flex h-12 items-center gap-2 border-b border-border bg-background px-4">
              <span className="text-[12px] text-muted-foreground">
                {isV3(payload)
                  ? `页面视图（近似分页）${payload.document.render.approximatePageCount ? ` · ${payload.document.render.approximatePageCount} 个页面段` : ''}`
                  : '结构化视图'}
              </span>
              <label className="ml-auto flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} className="w-44 bg-transparent text-[12px] outline-none" placeholder="筛选待处理内容" />
              </label>
            </div>
            <div className="min-h-0 flex-1">
              {isV3(payload) && payload.document.render.mode === 'DOCX_HTML' ? (
                <div onMouseUp={captureRange} className="h-full min-h-0 overflow-hidden">
                  <DocumentSurfaceViewerV1
                    ref={viewerRef}
                    purpose="TEMPLATE_ADVANCED_REVIEW"
                    documentToken={payload.document.render.documentToken}
                    title={payload.document.source.displayName}
                    targets={officeReviewTargets}
                    selectedId={selectedId}
                    readonlyLabel="高级复核试用；文档内容保持只读"
                    onSelectTarget={(target) => {
                      const original = payload.targets.find((item) => item.targetId === target.targetId)
                      if (original) selectTarget(original)
                    }}
                    onMappedTargetsChange={setViewerMappedIds}
                  />
                </div>
              ) : (
                <div className="h-full overflow-auto p-7">
                  <div className="mx-auto max-w-[820px] bg-white px-16 py-14 text-[#1b1b1b] shadow-sm">
                    {filteredTargets.length ? filteredTargets.map((target) => {
                      const chosen = target.targetId === selectedId
                      const handled = !!actions[target.targetId]?.length
                      return (
                        <div
                          key={target.targetId}
                          data-target-id={target.targetId}
                          onClick={() => selectTarget(target)}
                          className={cn(
                            'relative mb-3 cursor-text whitespace-pre-wrap rounded-sm px-1 py-0.5 text-[14px] leading-7 outline outline-1 outline-transparent transition-colors',
                            target.highlight === 'YELLOW' && !handled && 'bg-amber-200/75',
                            target.highlight === 'YELLOW' && handled && 'bg-emerald-100/60',
                            chosen && 'outline-primary/70',
                            target.kind === 'IMAGE' && 'flex min-h-40 items-center justify-center border border-dashed text-muted-foreground',
                          )}
                        >
                          {target.preview || (target.kind === 'IMAGE' ? '文档图片' : '空白内容')}
                        </div>
                      )
                    }) : <div className="py-20 text-center text-sm text-muted-foreground">没有匹配内容</div>}
                  </div>
                </div>
              )}
            </div>
          </main>

          <aside className="flex min-w-[330px] basis-[30%] flex-col border-l border-border bg-background">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-[13px] font-semibold">处理当前内容</h2>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">黄色表示需要人工判断。未标黄内容也可以从清单中选择后修改。</p>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
              {!selectedTarget ? <p className="text-[12px] text-muted-foreground">请在左侧选择一处内容。</p> : <>
                <div
                  ref={targetElement}
                  onMouseUp={captureRange}
                  className="rounded-lg border bg-muted/20 p-3 text-[12px] leading-6"
                >
                  {selectedTarget.preview || '图片或绘图对象'}
                </div>
                <p className="mt-3 text-[11px] leading-5 text-muted-foreground">{selectedTarget.reason}</p>
                {unresolvedInViewer.has(selectedTarget.targetId) ? (
                  <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                    {selectedTarget.riskFlags.some((flag) => flag === 'FLOATING_OBJECT' || flag === 'TEXT_BOX')
                      ? '这是 Word 浮动图形或文本框，当前文档视图无法稳定定位；请在右侧处理。可定位的行内图片会直接在左侧标黄。'
                      : '此处无法在左侧文档中可靠定位，仍需在这里人工处理。'}
                  </p>
                ) : null}
                {!!selectedTarget.riskFlags.length && <div className="mt-2 flex flex-wrap gap-1">
                  {selectedTarget.riskFlags.map((flag) => <span key={flag} className="inline-flex items-center gap-1 rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"><AlertTriangle className="h-3 w-3" />{HIGH_RISK_LABELS[flag] ?? flag}</span>)}
                </div>}
                {chosenRange && <div className="mt-3 rounded-md border border-primary/40 bg-primary/5 p-2 text-[11px]">将只处理所选文字：{selectedTarget.preview.slice(chosenRange.startUtf16, chosenRange.endUtf16Exclusive)}。所选范围以外会原样保留。</div>}
                {selectedTarget.highRisk && <textarea value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} rows={2} className="mt-3 w-full rounded-md border border-amber-400 px-2 py-1.5 text-[12px]" placeholder="保留或修改此高风险内容的原因" />}

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => applyAction('KEEP')} className="rounded-md border px-3 py-2 text-[12px] hover:bg-muted">原样保留</button>
                  <button type="button" onClick={() => selectedTarget.kind === 'IMAGE' ? void chooseReplacementImage() : beginEdit('REPLACE_TEXT')} className="rounded-md border px-3 py-2 text-[12px] hover:bg-muted">修改</button>
                  <button type="button" onClick={() => applyAction('REMOVE')} className="rounded-md border px-3 py-2 text-[12px] hover:bg-muted">移除</button>
                  <button type="button" disabled={!chosenRange || !canSplitTarget(selectedTarget)} onClick={() => beginEdit('REPLACE_TEXT')} className="rounded-md border px-3 py-2 text-[12px] hover:bg-muted disabled:opacity-40">拆分后修改</button>
                </div>

                {editKind && <div className="mt-4 rounded-lg border p-3">
                  <p className="mb-2 text-[11px] font-medium">{ACTION_LABELS[editKind]}</p>
                  {editKind === 'REPLACE_TEXT' && <div className="mb-2 flex gap-2 text-[11px]"><button type="button" onClick={() => setEditKind('REPLACE_TEXT')} className="rounded border bg-muted px-2 py-1">固定文字</button><button type="button" onClick={() => { setEditKind('FIELD'); setEditValue('') }} className="rounded border px-2 py-1">待填写内容</button></div>}
                  {editKind === 'REPLACE_IMAGE'
                    ? <button type="button" onClick={() => void chooseReplacementImage()} className="w-full rounded-md border px-2 py-2 text-left text-[12px]">{replacementImageName || '选择 PNG 或 JPG 图片'}</button>
                    : <textarea autoFocus value={editValue} onChange={(event) => setEditValue(event.target.value)} rows={3} className="w-full rounded-md border px-2 py-1.5 text-[12px]" placeholder={editKind === 'FIELD' ? '填写中文字段名，例如：项目名称' : '填写修改后的内容'} />}
                  <div className="mt-2 flex justify-end gap-2"><button type="button" onClick={() => setEditKind(null)} className="rounded-md border px-2 py-1 text-[11px]">取消</button><button type="button" onClick={() => applyAction(editKind, editValue)} className="rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground">保存</button></div>
                </div>}

                <details className="mt-4 rounded-lg border px-3 py-2 text-[11px]">
                  <summary className="cursor-pointer text-muted-foreground">更多设置</summary>
                  <div className="mt-2 flex gap-2"><button type="button" onClick={() => beginEdit('REPEAT')} className="rounded border px-2 py-1">重复内容</button><button type="button" onClick={() => beginEdit('CONDITIONAL')} className="rounded border px-2 py-1">条件内容</button></div>
                </details>

                {!!actions[selectedTarget.targetId]?.length && <div className="mt-4 rounded-lg bg-emerald-50 p-3 text-[11px] text-emerald-800">
                  <p className="mb-1 font-medium">已保存</p>
                  <div className="flex flex-wrap gap-1">
                    {actions[selectedTarget.targetId].map((action, index) => <button
                      key={`${action.kind}-${action.range?.startUtf16 ?? 'all'}-${index}`}
                      type="button"
                      title="点击撤销这项决定"
                      onClick={() => setActions((previous) => {
                        const next = (previous[selectedTarget.targetId] ?? []).filter((_, actionIndex) => actionIndex !== index)
                        return { ...previous, [selectedTarget.targetId]: next }
                      })}
                      className="rounded border border-emerald-300 bg-white px-1.5 py-0.5 hover:bg-emerald-100"
                    >
                      {ACTION_LABELS[action.kind]}{action.range ? `（${action.range.startUtf16 + 1}-${action.range.endUtf16Exclusive}）` : ''} · 撤销
                    </button>)}
                  </div>
                </div>}
                {message && <p className="mt-3 text-[11px] text-amber-700">{message}</p>}
              </>}
            </div>
            <div className="border-t border-border p-4">
              <div className="mb-3 flex max-h-28 flex-wrap gap-1 overflow-auto">
                {pendingTargets.slice(0, 30).map((target) => <button key={target.targetId} type="button" title={target.preview} onClick={() => selectTarget(target)} className="max-w-full truncate rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">待处理：{target.preview || '图片或无法定位内容'}</button>)}
              </div>
              <div className="flex gap-2"><button type="button" onClick={cancel} className="rounded-md border px-3 py-2 text-[12px]">关闭并保存草稿</button><button type="button" onClick={() => submit(false)} disabled={pendingTargets.length > 0} className="ml-auto rounded-md bg-primary px-3 py-2 text-[12px] text-primary-foreground disabled:opacity-40">完成复核并预览</button></div>
            </div>
          </aside>
        </div>

        {confirmingHighRisk && <div className="absolute inset-0 flex items-center justify-center bg-black/50 p-6"><div className="w-full max-w-lg rounded-xl bg-background p-5 shadow-xl"><h3 className="text-[14px] font-semibold">再次确认高风险内容</h3><p className="mt-2 text-[12px] leading-6 text-muted-foreground">你选择保留或修改了签字、印章、联系方式、旧项目图件等高风险内容。确认后，这些原因会写入本机复核记录。</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setConfirmingHighRisk(false)} className="rounded-md border px-3 py-2 text-[12px]">返回修改</button><button type="button" onClick={() => submit(true)} className="rounded-md bg-amber-600 px-3 py-2 text-[12px] text-white">确认并进入整份预览</button></div></div></div>}
      </div>
    </div>
  )
}
