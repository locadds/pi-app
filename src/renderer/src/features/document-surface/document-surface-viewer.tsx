import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'

import type {
  OfficeSurfaceFieldV1,
  OfficeSurfaceModeV1,
  OfficeSurfaceOccurrenceV1,
  OfficeSurfacePurposeV1,
  OfficeSurfaceSessionReadyV1,
  OfficeSurfaceFieldUpdateResultV1,
} from '@shared/xiaogui-office-surface'
import { officeSurfaceWarningDisplayItemsV1 } from '@shared/xiaogui-office-drawing-degradation'
import type { TemplateReviewTargetV3 } from '@shared/xiaogui-work-template-review'
import {
  DocxHtmlViewer,
  type DocxHtmlViewerHandleV1,
  type DocxHtmlViewerSelectionV1,
  type DocxHtmlViewerStateV1,
} from '@renderer/components/docx-html-viewer'
import { ipcClient } from '@renderer/lib/ipc-client'
import {
  OfficeSurfaceFrameV1,
  type OfficeSurfaceFrameHandleV1,
} from '@renderer/features/office-surface/office-surface-frame'

export interface DocumentSurfaceViewerHandleV1 {
  focusTarget(targetId: string): boolean
  focusField(fieldId: string): void
  focusOccurrence(occurrenceId: string): void
  updateField(input: {
    fieldId: string
    value: string
    occurrenceIds: readonly string[]
  }): Promise<OfficeSurfaceFieldUpdateResultV1>
  readSelection(): DocxHtmlViewerSelectionV1 | null
  dispose(): void
}

const EMPTY_FIELDS: readonly OfficeSurfaceFieldV1[] = []
const EMPTY_OCCURRENCES: readonly OfficeSurfaceOccurrenceV1[] = []
const EMPTY_TARGETS: readonly TemplateReviewTargetV3[] = []

export const DocumentSurfaceViewerV1 = forwardRef<
  DocumentSurfaceViewerHandleV1,
  {
    purpose: OfficeSurfacePurposeV1
    documentToken: string | undefined
    title: string
    fields?: readonly OfficeSurfaceFieldV1[]
    occurrences?: readonly OfficeSurfaceOccurrenceV1[]
    activeFieldId?: string
    activeOccurrenceId?: string
    targets?: readonly TemplateReviewTargetV3[]
    selectedId?: string
    readonlyLabel?: string
    onSelectTarget?: (target: TemplateReviewTargetV3) => void
    onSelectOccurrence?: (occurrenceId: string, fieldId: string) => void
    onStateChange?: (state: DocxHtmlViewerStateV1, pageCount: number | null) => void
    onMappedTargetsChange?: (targetIds: readonly string[]) => void
    className?: string
  }
>(function DocumentSurfaceViewerV1(
  {
    purpose,
    documentToken,
    title,
    fields = EMPTY_FIELDS,
    occurrences = EMPTY_OCCURRENCES,
    activeFieldId,
    activeOccurrenceId,
    targets = EMPTY_TARGETS,
    selectedId,
    readonlyLabel,
    onSelectTarget,
    onSelectOccurrence,
    onStateChange,
    onMappedTargetsChange,
    className,
  },
  ref,
) {
  const officeRef = useRef<OfficeSurfaceFrameHandleV1 | null>(null)
  const htmlRef = useRef<DocxHtmlViewerHandleV1 | null>(null)
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange
  const [mode, setMode] = useState<OfficeSurfaceModeV1 | null>(null)
  const [session, setSession] = useState<OfficeSurfaceSessionReadyV1 | null>(null)
  const [officeReady, setOfficeReady] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<readonly string[]>([])
  const [fallbackActive, setFallbackActive] = useState(false)
  const warningItems = officeSurfaceWarningDisplayItemsV1(warnings)
  const reviewProjection = useMemo(
    () => deriveReviewProjection(targets, fields, occurrences),
    [fields, occurrences, targets],
  )

  useImperativeHandle(
    ref,
    () => ({
      focusTarget: (targetId: string) => {
        if (fallbackActive) return htmlRef.current?.focus(targetId) ?? false
        const occurrenceId = reviewProjection.occurrenceIdByTargetId.get(targetId)
        if (!occurrenceId) return false
        officeRef.current?.focusOccurrence(occurrenceId)
        return true
      },
      focusField: (fieldId: string) => {
        if (fallbackActive) {
          const targetId = fallbackTargetIdForField(reviewProjection, fieldId)
          if (targetId) htmlRef.current?.focus(targetId)
          return
        }
        officeRef.current?.focusField(fieldId)
      },
      focusOccurrence: (occurrenceId: string) => {
        if (fallbackActive) {
          const targetId = reviewProjection.targetIdByOccurrenceId.get(occurrenceId)
          if (targetId) htmlRef.current?.focus(targetId)
          return
        }
        officeRef.current?.focusOccurrence(occurrenceId)
      },
      updateField: (input) =>
        officeRef.current?.updateField(input) ??
        Promise.reject(new Error('文档界面尚未准备好，暂时不能同步业务字段。')),
      readSelection: () => fallbackActive ? htmlRef.current?.readSelection() ?? null : null,
      dispose: () => {
        htmlRef.current?.dispose()
        if (session) {
          void Promise.resolve(
            ipcClient.invoke('xiaogui.officeSurface.session.release', { sessionId: session.sessionId }),
          )
        }
      },
    }),
    [fallbackActive, reviewProjection, session],
  )

  useEffect(() => {
    let cancelled = false
    void Promise.resolve(ipcClient.invoke('xiaogui.officeSurface.mode.get'))
      .then((value: unknown) => {
        if (cancelled) return
        const next = readMode(value)
        setMode(next)
        if (next === 'OFF') {
          setMessage('当前运行方式尚未启用小规文档界面，已回退到只读 DOCX 预览。')
          setFallbackActive(true)
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setMode('OFF')
        setMessage(`无法确认文档界面能力，已回退到只读 DOCX 预览。${readErrorMessage(error)}`)
        setFallbackActive(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!mode || mode === 'OFF' || !documentToken) return
    let cancelled = false
    let openedSessionId: string | null = null
    setSession(null)
    setOfficeReady(false)
    setMessage(null)
    setWarnings([])
    setFallbackActive(false)
    onStateChangeRef.current?.('LOADING', null)
    void Promise.resolve(
      ipcClient.invoke('xiaogui.officeSurface.session.prepare', {
        purpose,
        documentToken,
        title,
        fields: reviewProjection.fields,
        occurrences: reviewProjection.occurrences,
      }),
    )
      .then((ready: OfficeSurfaceSessionReadyV1) => {
        openedSessionId = ready.sessionId
        if (cancelled) {
          return Promise.resolve(
            ipcClient.invoke('xiaogui.officeSurface.session.release', {
              sessionId: ready.sessionId,
            }),
          )
        }
        setSession(ready)
        setMessage(null)
        setWarnings(ready.warnings)
        onMappedTargetsChange?.(
          ready.mappedOccurrenceIds
            .map((occurrenceId) => reviewProjection.targetIdByOccurrenceId.get(occurrenceId))
            .filter((targetId): targetId is string => Boolean(targetId)),
        )
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setSession(null)
        setMessage(`文档界面暂时不可用，已回退到只读 DOCX 预览。${readErrorMessage(error)}`)
        setFallbackActive(true)
      })
    return () => {
      cancelled = true
      if (openedSessionId) {
        void Promise.resolve(
          ipcClient.invoke('xiaogui.officeSurface.session.release', {
            sessionId: openedSessionId,
          }),
        )
      }
    }
  }, [
    documentToken,
    onMappedTargetsChange,
    purpose,
    reviewProjection.fields,
    reviewProjection.occurrences,
    reviewProjection.targetIdByOccurrenceId,
    mode,
    title,
  ])

  useEffect(() => {
    if (fallbackActive) {
      const targetId = activeOccurrenceId
        ? reviewProjection.targetIdByOccurrenceId.get(activeOccurrenceId)
        : activeFieldId
          ? fallbackTargetIdForField(reviewProjection, activeFieldId)
          : undefined
      if (targetId) htmlRef.current?.focus(targetId)
      return
    }
    if (!officeReady) return
    if (activeOccurrenceId) officeRef.current?.focusOccurrence(activeOccurrenceId)
    else if (activeFieldId) officeRef.current?.focusField(activeFieldId)
  }, [activeFieldId, activeOccurrenceId, fallbackActive, officeReady, reviewProjection])

  if (!documentToken) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">没有可显示的文档。</div>
    )
  }

  return (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ''}`}>
      <div className="flex min-h-9 items-center gap-2 border-b border-border bg-background px-3 py-1 text-[11px]">
        <span className="font-medium">文档复核</span>
        {message ? (
          <span className="min-w-0 flex-1 truncate text-amber-700" title={message}>
            {message}
          </span>
        ) : null}
        {warningItems.length > 0 ? (
          <details className="min-w-0 flex-1 text-amber-700" data-office-warning-count={warningItems.length}>
            <summary>{warningItems.length} 条导入提示（展开查看全部）</summary>
            <ol className="max-h-32 overflow-auto pl-5">
              {warningItems.map((item) => (
                <li key={item.key} data-drawing-degradation={item.degradation?.reason ?? undefined}>
                  {item.message}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {fallbackActive ? (
          <DocxHtmlViewer
            ref={htmlRef}
            documentToken={documentToken}
            targets={targets}
            selectedId={selectedId}
            readonlyLabel={readonlyLabel ?? 'Office 界面不可用，当前为 DOCX 只读预览'}
            onSelectTarget={onSelectTarget}
            onStateChange={onStateChange}
            onMappedTargetsChange={onMappedTargetsChange}
            className="h-full"
          />
        ) : mode === null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            正在准备文档界面…
          </div>
        ) : mode === 'OFF' ? null : (
          session ? (
            <OfficeSurfaceFrameV1
              ref={officeRef}
              sessionId={session.sessionId}
              gatewayOrigin={session.gatewayOrigin}
              onReady={() => {
                setOfficeReady(true)
                onStateChangeRef.current?.('READY', null)
              }}
              onDirtyChange={(dirty) => {
                if (!dirty) onStateChangeRef.current?.('READY', null)
              }}
              onOccurrenceSelect={(occurrenceId) => {
                const occurrence = reviewProjection.occurrences.find((item) => item.occurrenceId === occurrenceId)
                if (occurrence) onSelectOccurrence?.(occurrenceId, occurrence.fieldId)
                const targetId = reviewProjection.targetIdByOccurrenceId.get(occurrenceId)
                const target = targetId ? targets.find((item) => item.targetId === targetId) : undefined
                if (target) onSelectTarget?.(target)
              }}
              onError={(error) => {
                setOfficeReady(false)
                setSession(null)
                setMessage(`${error} 已回退到只读 DOCX 预览。`)
                setFallbackActive(true)
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              正在准备文档界面…
            </div>
          )
        )}
      </div>
    </div>
  )
})

function readMode(value: unknown): OfficeSurfaceModeV1 {
  if (!value || typeof value !== 'object') return 'OFF'
  const mode = (value as { mode?: unknown }).mode
  return mode === 'UNIVER_EXPERIMENTAL' || mode === 'UNIVER_PREFERRED' ? mode : 'OFF'
}

function deriveReviewProjection(
  targets: readonly TemplateReviewTargetV3[],
  fields: readonly OfficeSurfaceFieldV1[],
  occurrences: readonly OfficeSurfaceOccurrenceV1[],
): {
  fields: readonly OfficeSurfaceFieldV1[]
  occurrences: readonly OfficeSurfaceOccurrenceV1[]
  occurrenceIdByTargetId: ReadonlyMap<string, string>
  targetIdByOccurrenceId: ReadonlyMap<string, string>
} {
  if (fields.length || occurrences.length) {
    const occurrenceIdByTargetId = new Map<string, string>()
    const targetIdByOccurrenceId = new Map<string, string>()
    for (const occurrence of occurrences) {
      const candidates = targets.filter((target) => sourceAnchorMatchesOccurrence(target, occurrence))
      const target = candidates.find((candidate) => textRangeMatchesOccurrence(candidate, occurrence))
        ?? candidates.find((candidate) => candidate.preview.trim() === occurrence.originalText.trim())
        ?? candidates[0]
      if (!target) continue
      targetIdByOccurrenceId.set(occurrence.occurrenceId, target.targetId)
      if (!occurrenceIdByTargetId.has(target.targetId)) {
        occurrenceIdByTargetId.set(target.targetId, occurrence.occurrenceId)
      }
    }
    return {
      fields,
      occurrences,
      occurrenceIdByTargetId,
      targetIdByOccurrenceId,
    }
  }

  if (!targets.length) {
    return {
      fields,
      occurrences,
      occurrenceIdByTargetId: new Map(),
      targetIdByOccurrenceId: new Map(),
    }
  }

  const derivedFields: OfficeSurfaceFieldV1[] = []
  const derivedOccurrences: OfficeSurfaceOccurrenceV1[] = []
  const occurrenceIdByTargetId = new Map<string, string>()
  const targetIdByOccurrenceId = new Map<string, string>()

  for (const target of targets) {
    const sourceAnchor = toOfficeSourceAnchor(target)
    const originalText = target.preview.trim()
    if (!sourceAnchor || !originalText || target.kind === 'IMAGE' || target.kind === 'DRAWING') continue
    const fieldId = `review:${target.targetId}`
    const occurrenceId = `review-occurrence:${target.targetId}`
    derivedFields.push({
      fieldId,
      displayName: '待复核内容',
      occurrenceIds: [occurrenceId],
    })
    derivedOccurrences.push({
      occurrenceId,
      fieldId,
      originalText,
      sourceAnchor,
      ...(target.sourceAnchor.textRange ? { textRange: target.sourceAnchor.textRange } : {}),
      state: target.highRisk
        ? 'BLOCKING'
        : target.highlight === 'YELLOW'
          ? 'WARNING'
          : 'FIELD',
    })
    occurrenceIdByTargetId.set(target.targetId, occurrenceId)
    targetIdByOccurrenceId.set(occurrenceId, target.targetId)
  }

  return {
    fields: derivedFields,
    occurrences: derivedOccurrences,
    occurrenceIdByTargetId,
    targetIdByOccurrenceId,
  }
}

function sourceAnchorMatchesOccurrence(
  target: TemplateReviewTargetV3,
  occurrence: OfficeSurfaceOccurrenceV1,
): boolean {
  const targetAnchor = toOfficeSourceAnchor(target)
  if (!targetAnchor || targetAnchor.part !== occurrence.sourceAnchor.part) return false
  const keys = [
    'sectionIndex',
    'partIndex',
    'paragraphIndex',
    'tableIndex',
    'rowIndex',
    'cellIndex',
    'drawingIndex',
  ] as const
  return keys.every((key) => targetAnchor[key] === occurrence.sourceAnchor[key])
}

function textRangeMatchesOccurrence(
  target: TemplateReviewTargetV3,
  occurrence: OfficeSurfaceOccurrenceV1,
): boolean {
  if (!occurrence.textRange) return false
  const targetRange = target.sourceAnchor.textRange
  return targetRange?.startUtf16 === occurrence.textRange.startUtf16
    && targetRange.endUtf16Exclusive === occurrence.textRange.endUtf16Exclusive
}

function fallbackTargetIdForField(
  projection: ReturnType<typeof deriveReviewProjection>,
  fieldId: string,
): string | undefined {
  const field = projection.fields.find((item) => item.fieldId === fieldId)
  const occurrenceIds = field?.occurrenceIds
    ?? projection.occurrences.filter((item) => item.fieldId === fieldId).map((item) => item.occurrenceId)
  return occurrenceIds
    .map((occurrenceId) => projection.targetIdByOccurrenceId.get(occurrenceId))
    .find((targetId): targetId is string => Boolean(targetId))
}

function toOfficeSourceAnchor(target: TemplateReviewTargetV3): OfficeSurfaceOccurrenceV1['sourceAnchor'] | null {
  const anchor = target.sourceAnchor
  if (
    anchor.part !== 'BODY'
    && anchor.part !== 'HEADER'
    && anchor.part !== 'FOOTER'
    && anchor.part !== 'TABLE_CELL'
    && anchor.part !== 'TEXT_BOX'
    && anchor.part !== 'DRAWING'
  ) return null
  return {
    part: anchor.part,
    ...(anchor.sectionIndex !== undefined ? { sectionIndex: anchor.sectionIndex } : {}),
    ...(anchor.partIndex !== undefined ? { partIndex: anchor.partIndex } : {}),
    ...(anchor.paragraphIndex !== undefined ? { paragraphIndex: anchor.paragraphIndex } : {}),
    ...(anchor.tableIndex !== undefined ? { tableIndex: anchor.tableIndex } : {}),
    ...(anchor.rowIndex !== undefined ? { rowIndex: anchor.rowIndex } : {}),
    ...(anchor.cellIndex !== undefined ? { cellIndex: anchor.cellIndex } : {}),
    ...(anchor.drawingIndex !== undefined ? { drawingIndex: anchor.drawingIndex } : {}),
  }
}

function readErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return message ? `（${message.slice(0, 160)}）` : ''
}
