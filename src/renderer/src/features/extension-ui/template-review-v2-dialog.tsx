import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  TemplateReviewActionV2,
  TemplateReviewRequestV2,
  TemplateReviewResultV2,
  TemplateReviewTargetV2,
  TemplateReviewTextRangeV2,
} from '@shared/xiaogui-work-template-review'
import { ipcClient } from '@renderer/lib/ipc-client'
import { cn } from '@renderer/lib/utils'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileText,
  Search,
  X,
} from '@renderer/components/icons'

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
const PAGE_TARGET_COUNT = 20

type PageAssetV1 = {
  pageNumber: number
  pdfBytes: Uint8Array
  text: string
}

function PdfReviewPage({
  pageNumber,
  pageToken,
  widthPoints,
  heightPoints,
  targets,
  selectedId,
  onSelect,
}: {
  pageNumber: number
  pageToken: string
  widthPoints: number
  heightPoints: number
  targets: readonly TemplateReviewTargetV2[]
  selectedId: string
  onSelect: (target: TemplateReviewTargetV2) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let loadingTask: { destroy(): Promise<void> } | null = null
    const render = async () => {
      try {
        setError(null)
        const asset = await ipcClient.invoke(
          'xiaogui.templateReview.page.read',
          { pageToken },
        ) as PageAssetV1
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
        const task = pdfjs.getDocument({ data: new Uint8Array(asset.pdfBytes) })
        loadingTask = task
        const document = await task.promise
        const pdfPage = await document.getPage(asset.pageNumber)
        const viewport = pdfPage.getViewport({ scale: 1.35 })
        const canvas = canvasRef.current
        if (!canvas || disposed) return
        const context = canvas.getContext('2d')
        if (!context) throw new Error('CANVAS_UNAVAILABLE')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        canvas.style.width = '100%'
        canvas.style.height = 'auto'
        await pdfPage.render({ canvas, canvasContext: context, viewport }).promise
        pdfPage.cleanup()
      } catch {
        if (!disposed) setError('本页暂时无法显示，请使用右侧待处理清单继续复核。')
      }
    }
    void render()
    return () => {
      disposed = true
      void loadingTask?.destroy()
    }
  }, [pageToken])

  return (
    <div
      className="relative mx-auto w-full max-w-[920px] overflow-hidden bg-white shadow-sm"
      style={{ aspectRatio: `${widthPoints} / ${heightPoints}` }}
      aria-label={`文档第 ${pageNumber} 页`}
    >
      <canvas ref={canvasRef} className="block h-auto w-full" />
      {targets.flatMap((target) =>
        target.pageRegions
          .filter((region) => region.pageNumber === pageNumber)
          .map((region, index) => (
            <button
              key={`${target.targetId}-${index}`}
              type="button"
              aria-label={`复核：${target.preview.slice(0, 30)}`}
              title={target.preview}
              onClick={() => onSelect(target)}
              className={cn(
                'absolute border outline-none transition-colors',
                target.highlight === 'YELLOW'
                  ? 'border-amber-500 bg-amber-300/45 hover:bg-amber-300/65'
                  : 'border-transparent bg-transparent hover:border-primary/50 hover:bg-primary/10',
                selectedId === target.targetId && 'ring-2 ring-primary ring-offset-1',
              )}
              style={{
                left: `${region.x / widthPoints * 100}%`,
                top: `${region.y / heightPoints * 100}%`,
                width: `${Math.max(region.width / widthPoints * 100, 0.6)}%`,
                height: `${Math.max(region.height / heightPoints * 100, 0.8)}%`,
              }}
            />
          )),
      )}
      {error && <div className="absolute inset-x-6 top-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-center text-xs text-amber-800">{error}</div>}
    </div>
  )
}

function groupActions(actions: readonly TemplateReviewActionV2[]): ActionState {
  const grouped: ActionState = {}
  for (const action of actions) {
    ;(grouped[action.targetId] ??= []).push(action)
  }
  return grouped
}

function defaultActions(payload: TemplateReviewRequestV2): ActionState {
  const state = groupActions(payload.draftActions)
  for (const target of payload.targets) {
    if (state[target.targetId]?.length) continue
    // 未标黄内容不要求用户逐段点选；仍可在文档中主动点击修改。
    if (!requiresExplicitDecision(target)) state[target.targetId] = [{ targetId: target.targetId, kind: 'KEEP' }]
  }
  return state
}

function requiresExplicitDecision(target: TemplateReviewTargetV2): boolean {
  return target.highlight === 'YELLOW' || target.highRisk || target.kind === 'UNMAPPED'
}

function needsHighRiskOverride(
  target: TemplateReviewTargetV2 | undefined,
  action: TemplateReviewActionV2,
): boolean {
  // 局部移除仍会保留目标其余部分，因此也属于“覆盖默认移除”。
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

function targetPageNumber(target: TemplateReviewTargetV2, index: number): number {
  return target.pageRegions[0]?.pageNumber ?? Math.floor(index / PAGE_TARGET_COUNT) + 1
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

export function TemplateReviewV2Dialog({
  requestId,
  payload,
  onSuspend,
  onCancel,
  onSubmit,
}: {
  requestId: string
  payload: TemplateReviewRequestV2
  onSuspend: () => void
  onCancel: (result: Extract<TemplateReviewResultV2, { cancelled: true }>) => void
  onSubmit: (result: TemplateReviewResultV2) => void
}) {
  const initial = draftByRequestId.get(requestId) ?? defaultActions(payload)
  const [actions, setActions] = useState<ActionState>(initial)
  const [selectedId, setSelectedId] = useState(() =>
    payload.targets.find((target) => requiresExplicitDecision(target) && !initial[target.targetId]?.length)?.targetId
      ?? payload.targets[0]?.targetId
      ?? '',
  )
  const [page, setPage] = useState(() => {
    const index = payload.targets.findIndex((target) => target.targetId === selectedId)
    return index >= 0 ? targetPageNumber(payload.targets[index], index) : 1
  })
  const [query, setQuery] = useState('')
  const [chosenRange, setChosenRange] = useState<TemplateReviewTextRangeV2 | null>(null)
  const [editKind, setEditKind] = useState<ActionKind | null>(null)
  const [editValue, setEditValue] = useState('')
  const [replacementImageName, setReplacementImageName] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [confirmingHighRisk, setConfirmingHighRisk] = useState(false)
  const targetElement = useRef<HTMLDivElement | null>(null)

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

  const indexedTargets = useMemo(
    () => payload.targets.map((target, index) => ({ target, pageNumber: targetPageNumber(target, index) })),
    [payload.targets],
  )
  const pageCount = Math.max(
    payload.document.render.pageCount ?? 0,
    ...indexedTargets.map((item) => item.pageNumber),
    1,
  )
  const visibleTargets = indexedTargets.filter(({ target, pageNumber }) => {
    if (pageNumber !== page) return false
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return !normalized || `${target.preview}\n${target.reason}`.toLocaleLowerCase('zh-CN').includes(normalized)
  })
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
  const pdfTargets = payload.targets.filter((target) =>
    target.pageRegions.some((region) => region.pageNumber === page)
    && (!normalizedQuery || `${target.preview}\n${target.reason}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery)),
  )
  const selectedTarget = payload.targets.find((target) => target.targetId === selectedId) ?? null
  const pendingTargets = payload.targets.filter(
    (target) => requiresExplicitDecision(target) && !(actions[target.targetId]?.length),
  )
  const resolvedCount = payload.targets.length - pendingTargets.length

  const selectTarget = (target: TemplateReviewTargetV2, targetPage: number) => {
    setSelectedId(target.targetId)
    setPage(targetPage)
    setChosenRange(null)
    setEditKind(null)
    setEditValue('')
    setReplacementImageName('')
    setOverrideReason(actions[target.targetId]?.[0]?.highRiskOverrideReason ?? '')
    setMessage(null)
  }

  const captureRange = () => {
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
      const item = indexedTargets.find((entry) => entry.target.targetId === missingReason.targetId)
      if (target && item) selectTarget(target, item.pageNumber)
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
          <main className="flex min-w-0 basis-[70%] flex-col bg-muted/30">
            <div className="flex h-12 items-center gap-2 border-b border-border bg-background px-4">
              <button type="button" onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} className="rounded-md border p-1.5 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
              <span className="text-[12px]">第 {page} / {pageCount} 页</span>
              <button type="button" onClick={() => setPage(Math.min(pageCount, page + 1))} disabled={page >= pageCount} className="rounded-md border p-1.5 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
              <label className="ml-auto flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} className="w-44 bg-transparent text-[12px] outline-none" placeholder="在当前页查找" />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-7">
              {payload.document.render.mode === 'STRUCTURED_FALLBACK' && (
                <div className="mx-auto mb-4 max-w-[820px] rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                  当前无法还原完整页面版式，正在使用结构化文档视图。所有无法定位的内容仍会列入待处理清单，不会静默跳过。
                </div>
              )}
              {payload.document.render.mode === 'PDF' && payload.document.render.pages[page - 1]
                ? <PdfReviewPage
                    pageNumber={payload.document.render.pages[page - 1].pageNumber}
                    pageToken={payload.document.render.pages[page - 1].pageToken}
                    widthPoints={payload.document.render.pages[page - 1].widthPoints}
                    heightPoints={payload.document.render.pages[page - 1].heightPoints}
                    targets={pdfTargets}
                    selectedId={selectedId}
                    onSelect={(target) => selectTarget(target, page)}
                  />
                : <div className="mx-auto min-h-[960px] max-w-[820px] bg-white px-16 py-14 text-[#1b1b1b] shadow-sm">
                {visibleTargets.length ? visibleTargets.map(({ target, pageNumber }) => {
                  const chosen = target.targetId === selectedId
                  const handled = !!actions[target.targetId]?.length
                  return (
                    <div
                      key={target.targetId}
                      data-target-id={target.targetId}
                      onClick={() => selectTarget(target, pageNumber)}
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
                }) : <div className="py-20 text-center text-sm text-muted-foreground">当前页没有匹配内容</div>}
              </div>}
            </div>
          </main>

          <aside className="flex min-w-[330px] basis-[30%] flex-col border-l border-border bg-background">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-[13px] font-semibold">处理当前内容</h2>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">黄色表示需要人工判断。未标黄内容也可以直接点击修改。</p>
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
                {!!selectedTarget.riskFlags.length && <div className="mt-2 flex flex-wrap gap-1">
                  {selectedTarget.riskFlags.map((flag) => <span key={flag} className="inline-flex items-center gap-1 rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"><AlertTriangle className="h-3 w-3" />{HIGH_RISK_LABELS[flag] ?? flag}</span>)}
                </div>}
                {chosenRange && <div className="mt-3 rounded-md border border-primary/40 bg-primary/5 p-2 text-[11px]">将只处理所选文字：{selectedTarget.preview.slice(chosenRange.startUtf16, chosenRange.endUtf16Exclusive)}。所选范围以外会原样保留。</div>}
                {selectedTarget.highRisk && <textarea value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} rows={2} className="mt-3 w-full rounded-md border border-amber-400 px-2 py-1.5 text-[12px]" placeholder="保留或修改此高风险内容的原因" />}

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => applyAction('KEEP')} className="rounded-md border px-3 py-2 text-[12px] hover:bg-muted">原样保留</button>
                  <button type="button" onClick={() => selectedTarget.kind === 'IMAGE' ? void chooseReplacementImage() : beginEdit('REPLACE_TEXT')} className="rounded-md border px-3 py-2 text-[12px] hover:bg-muted">修改</button>
                  <button type="button" onClick={() => applyAction('REMOVE')} className="rounded-md border px-3 py-2 text-[12px] hover:bg-muted">移除</button>
                  <button type="button" disabled={!chosenRange || selectedTarget.kind === 'IMAGE'} onClick={() => beginEdit('REPLACE_TEXT')} className="rounded-md border px-3 py-2 text-[12px] hover:bg-muted disabled:opacity-40">拆分后修改</button>
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
                {pendingTargets.slice(0, 30).map((target) => <button key={target.targetId} type="button" title={target.preview} onClick={() => { const item = indexedTargets.find((entry) => entry.target.targetId === target.targetId); if (item) selectTarget(target, item.pageNumber) }} className="max-w-full truncate rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">待处理：{target.preview || '图片或无法定位内容'}</button>)}
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
