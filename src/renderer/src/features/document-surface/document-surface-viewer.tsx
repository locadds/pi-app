import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

import type {
  OfficeSurfaceFieldV1,
  OfficeSurfaceModeV1,
  OfficeSurfaceOccurrenceV1,
  OfficeSurfacePurposeV1,
  OfficeSurfaceSessionReadyV1,
} from '@shared/xiaogui-office-surface'
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
  readSelection(): DocxHtmlViewerSelectionV1 | null
  dispose(): void
}

type SurfaceKind = 'OFFICE' | 'HTML'
const EMPTY_FIELDS: readonly OfficeSurfaceFieldV1[] = []
const EMPTY_OCCURRENCES: readonly OfficeSurfaceOccurrenceV1[] = []
const EMPTY_TARGETS: readonly TemplateReviewTargetV3[] = []

export const DocumentSurfaceViewerV1 = forwardRef<DocumentSurfaceViewerHandleV1, {
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
  onStateChange?: (state: DocxHtmlViewerStateV1, pageCount: number | null) => void
  onMappedTargetsChange?: (targetIds: readonly string[]) => void
  className?: string
}>(function DocumentSurfaceViewerV1({
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
  onStateChange,
  onMappedTargetsChange,
  className,
}, ref) {
  const officeRef = useRef<OfficeSurfaceFrameHandleV1 | null>(null)
  const htmlRef = useRef<DocxHtmlViewerHandleV1 | null>(null)
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange
  const [mode, setMode] = useState<OfficeSurfaceModeV1>('OFF')
  // 兼容视图先可见；主进程确认试验模式后再无刷新切换到 Office Surface。
  const [surface, setSurface] = useState<SurfaceKind>('HTML')
  const [session, setSession] = useState<OfficeSurfaceSessionReadyV1 | null>(null)
  const [officeReady, setOfficeReady] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useImperativeHandle(ref, () => ({
    focusTarget: (targetId: string) => htmlRef.current?.focus(targetId) ?? false,
    focusField: (fieldId: string) => officeRef.current?.focusField(fieldId),
    focusOccurrence: (occurrenceId: string) => officeRef.current?.focusOccurrence(occurrenceId),
    readSelection: () => htmlRef.current?.readSelection() ?? null,
    dispose: () => htmlRef.current?.dispose(),
  }), [])

  useEffect(() => {
    let cancelled = false
    void Promise.resolve(ipcClient.invoke('xiaogui.officeSurface.mode.get')).then((value: unknown) => {
      if (cancelled) return
      const next = readMode(value)
      setMode(next)
      setSurface(next === 'OFF' ? 'HTML' : 'OFFICE')
    }).catch(() => {
      if (!cancelled) setSurface('HTML')
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (surface !== 'OFFICE' || !documentToken) return
    let cancelled = false
    let openedSessionId: string | null = null
    setSession(null)
    setOfficeReady(false)
    setMessage(null)
    onStateChangeRef.current?.('LOADING', null)
    void Promise.resolve(ipcClient.invoke('xiaogui.officeSurface.session.prepare', {
      purpose,
      documentToken,
      title,
      fields,
      occurrences,
    })).then((ready: OfficeSurfaceSessionReadyV1) => {
      openedSessionId = ready.sessionId
      if (cancelled) {
        return Promise.resolve(ipcClient.invoke('xiaogui.officeSurface.session.release', { sessionId: ready.sessionId }))
      }
      setSession(ready)
      setMessage(ready.warnings[0] ?? null)
    }).catch((error: unknown) => {
      if (cancelled) return
      setMessage(`文档工作表面暂时不可用，已切换到兼容视图。${readErrorMessage(error)}`)
      setSurface('HTML')
    })
    return () => {
      cancelled = true
      if (openedSessionId) {
        void Promise.resolve(ipcClient.invoke('xiaogui.officeSurface.session.release', { sessionId: openedSessionId }))
      }
    }
  }, [documentToken, fields, occurrences, purpose, surface, title])

  useEffect(() => {
    if (!officeReady) return
    if (activeOccurrenceId) officeRef.current?.focusOccurrence(activeOccurrenceId)
    else if (activeFieldId) officeRef.current?.focusField(activeFieldId)
  }, [activeFieldId, activeOccurrenceId, officeReady])

  if (!documentToken) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">没有可显示的文档。</div>
  }

  return (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ''}`}>
      <div className="flex min-h-9 items-center gap-2 border-b border-border bg-background px-3 py-1 text-[11px]">
        <span className="font-medium">文档视图</span>
        {mode !== 'OFF' ? (
          <div className="flex rounded-md bg-muted p-0.5">
            <button
              type="button"
              onClick={() => setSurface('OFFICE')}
              className={`rounded px-2 py-1 ${surface === 'OFFICE' ? 'bg-background shadow-sm' : ''}`}
            >
              工作表面（试验）
            </button>
            <button
              type="button"
              onClick={() => setSurface('HTML')}
              className={`rounded px-2 py-1 ${surface === 'HTML' ? 'bg-background shadow-sm' : ''}`}
            >
              原版式兼容视图
            </button>
          </div>
        ) : null}
        {message ? <span className="min-w-0 flex-1 truncate text-amber-700" title={message}>{message}</span> : null}
      </div>
      <div className="min-h-0 flex-1">
        {surface === 'OFFICE' ? (
          session ? (
            <OfficeSurfaceFrameV1
              ref={officeRef}
              gatewayOrigin={session.gatewayOrigin}
              gatewayAccessToken={session.gatewayAccessToken}
              onReady={() => {
                setOfficeReady(true)
                onStateChangeRef.current?.('READY', null)
              }}
              onDirtyChange={(dirty) => {
                if (!dirty) onStateChangeRef.current?.('READY', null)
              }}
              onError={(error) => {
                setOfficeReady(false)
                setMessage(`${error} 已切换到兼容视图。`)
                setSurface('HTML')
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在准备文档工作表面…</div>
          )
        ) : surface === 'HTML' ? (
          <DocxHtmlViewer
            ref={htmlRef}
            documentToken={documentToken}
            targets={targets}
            selectedId={selectedId}
            readonlyLabel={readonlyLabel}
            onSelectTarget={onSelectTarget}
            onStateChange={onStateChange}
            onMappedTargetsChange={onMappedTargetsChange}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在选择文档显示方式…</div>
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

function readErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return message ? `（${message.slice(0, 160)}）` : ''
}
