import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  TemplateMaterializePreviewRequestV1,
  TemplateMaterializePreviewResultV1 as SharedTemplateMaterializePreviewResultV1,
} from '@shared/xiaogui-work-docx-template-materialize'
import type { TemplateReviewPageV2 } from '@shared/xiaogui-work-template-review'
import { ChevronLeft, ChevronRight, FileText } from '@renderer/components/icons'
import { ipcClient } from '@renderer/lib/ipc-client'

export type TemplateMaterializePreviewPayloadV1 = TemplateMaterializePreviewRequestV1
export type TemplateMaterializePreviewResultV1 = SharedTemplateMaterializePreviewResultV1

type PageAssetV1 = {
  pageNumber: number
  pdfBytes: Uint8Array
  text: string
}

function PreviewPage({
  page,
  onReady,
  onError,
}: {
  page: TemplateReviewPageV2
  onReady: (pageNumber: number) => void
  onError: (pageNumber: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let disposed = false
    let loadingTask: { destroy(): Promise<void> } | null = null
    const renderPage = async () => {
      try {
        setError(false)
        const asset = await ipcClient.invoke(
          'xiaogui.templateReview.page.read',
          { pageToken: page.pageToken },
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
        if (!disposed) onReady(page.pageNumber)
      } catch {
        if (!disposed) {
          setError(true)
          onError(page.pageNumber)
        }
      }
    }
    void renderPage()
    return () => {
      disposed = true
      void loadingTask?.destroy()
    }
  }, [onError, onReady, page.pageNumber, page.pageToken])

  return (
    <div
      className="relative mx-auto w-full max-w-[920px] overflow-hidden bg-white shadow-sm"
      style={{ aspectRatio: `${page.widthPoints} / ${page.heightPoints}` }}
      aria-label={`修改后预览第 ${page.pageNumber} 页`}
    >
      <canvas ref={canvasRef} className="block h-auto w-full" />
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-amber-50 p-8 text-center text-sm text-amber-800">
          本页未能在小规内显示。请返回修改后重新生成预览，当前不能生成正式模板。
        </div>
      )}
    </div>
  )
}

export function TemplateMaterializePreviewDialog({
  payload,
  onResult,
}: {
  payload: TemplateMaterializePreviewPayloadV1
  onResult: (result: TemplateMaterializePreviewResultV1) => void
}) {
  const [pageIndex, setPageIndex] = useState(0)
  const [modificationInstruction, setModificationInstruction] = useState('')
  const [failedPages, setFailedPages] = useState<Set<number>>(() => new Set())
  const [loadedPages, setLoadedPages] = useState<Set<number>>(() => new Set())
  const pages = payload.document.render.pages
  const page = pages[pageIndex]
  const canGenerate = pages.length > 0
    && failedPages.size === 0
    && loadedPages.size === pages.length

  const markReady = useCallback((pageNumber: number) => {
    setLoadedPages((previous) => new Set(previous).add(pageNumber))
    setFailedPages((previous) => {
      const next = new Set(previous)
      next.delete(pageNumber)
      return next
    })
  }, [])
  const markFailed = useCallback((pageNumber: number) => {
    setFailedPages((previous) => new Set(previous).add(pageNumber))
  }, [])

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-background" role="dialog" aria-modal="true" aria-label="修改后模板预览">
      <header className="flex h-14 items-center gap-3 border-b border-border px-5">
        <FileText className="h-5 w-5" />
        <div className="min-w-0">
          <h1 className="text-[14px] font-semibold">修改后模板预览</h1>
          <p className="truncate text-[11px] text-muted-foreground">{payload.plan.source.displayName}</p>
        </div>
        <div className="ml-auto text-[11px] text-muted-foreground">
          变量 {payload.plan.variables.length} 项 · 排除 {payload.plan.excludedCandidateCount} 项 · 原文档未修改
        </div>
      </header>

      <div className="flex h-12 items-center justify-center gap-3 border-b border-border">
        <button
          type="button"
          aria-label="上一页"
          onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
          disabled={pageIndex <= 0}
          className="rounded-md border p-1.5 disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-24 text-center text-[12px]">第 {pages.length ? pageIndex + 1 : 0} / {pages.length} 页</span>
        <span className="text-[11px] text-muted-foreground">已检查 {loadedPages.size} / {pages.length} 页</span>
        <button
          type="button"
          aria-label="下一页"
          onClick={() => setPageIndex((current) => Math.min(pages.length - 1, current + 1))}
          disabled={pageIndex >= pages.length - 1}
          className="rounded-md border p-1.5 disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <main className="min-h-0 flex-1 overflow-auto bg-muted/30 p-7">
        {page ? (
          <PreviewPage page={page} onReady={markReady} onError={markFailed} />
        ) : (
          <div className="mx-auto max-w-lg rounded-lg border border-amber-300 bg-amber-50 p-5 text-center text-sm text-amber-800">
            没有可显示的修改后页面，请返回修改并重新生成预览。
          </div>
        )}
      </main>

      <footer className="flex items-end gap-3 border-t border-border bg-background px-5 py-4">
        <label className="min-w-0 flex-1 text-[11px] text-muted-foreground">
          需要修改
          <input
            value={modificationInstruction}
            onChange={(event) => setModificationInstruction(event.target.value)}
            maxLength={2000}
            placeholder="输入要修改的内容，再点“需要修改”"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-[12px] text-foreground outline-none focus:border-foreground/40"
          />
        </label>
        <button
          type="button"
          disabled={!modificationInstruction.trim()}
          onClick={() => onResult({
            action: 'MODIFY',
            previewSha256: payload.plan.previewSha256,
            instruction: modificationInstruction.trim(),
          })}
          className="rounded-md border px-4 py-2 text-[12px] hover:bg-muted"
        >
          需要修改
        </button>
        <button
          type="button"
          disabled={!canGenerate}
          onClick={() => onResult({ action: 'CONFIRM', previewSha256: payload.plan.previewSha256 })}
          className="rounded-md bg-primary px-4 py-2 text-[12px] text-primary-foreground disabled:opacity-40"
        >
          生成正式模板
        </button>
      </footer>
    </div>
  )
}
