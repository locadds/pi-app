import { useEffect, useRef, useState } from 'react'

import type {
  TemplateLibraryPreviewV1,
  TemplateLibraryVersionSummaryV1,
} from '@shared/xiaogui-template-library'
import type { TemplateReviewPageV2 } from '@shared/xiaogui-work-template-review'
import { ipcClient } from '@renderer/lib/ipc-client'

type PreviewPageAssetV1 = {
  pageNumber: number
  pdfBytes: Uint8Array
  text: string
}

function TemplateLibraryPreviewPage({ page }: { page: TemplateReviewPageV2 }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [renderState, setRenderState] = useState<'LOADING' | 'READY' | 'FAILED'>('LOADING')

  useEffect(() => {
    let disposed = false
    let loadingTask: { destroy(): Promise<void> } | null = null

    const renderPage = async () => {
      try {
        setRenderState('LOADING')
        const asset = await ipcClient.invoke(
          'xiaogui.templateReview.page.read',
          { pageToken: page.pageToken },
        ) as PreviewPageAssetV1
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
        if (!disposed) setRenderState('READY')
      } catch {
        if (!disposed) setRenderState('FAILED')
      }
    }

    void renderPage()
    return () => {
      disposed = true
      void loadingTask?.destroy()
    }
  }, [page.pageNumber, page.pageToken])

  return (
    <div
      className="relative mx-auto w-full max-w-[920px] overflow-hidden bg-white shadow-sm"
      style={{ aspectRatio: `${page.widthPoints} / ${page.heightPoints}` }}
      aria-label={`模板预览第 ${page.pageNumber} 页`}
    >
      <canvas ref={canvasRef} className="block h-auto w-full" />
      {renderState === 'LOADING' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white text-[12px] text-muted-foreground">
          正在显示第 {page.pageNumber} 页…
        </div>
      ) : null}
      {renderState === 'FAILED' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-amber-50 p-8 text-center text-[12px] leading-6 text-amber-900">
          本页未能在小规内显示。当前预览未成功，请关闭后重试。
        </div>
      ) : null}
    </div>
  )
}

export function TemplateLibraryPreviewDialog({
  entryName,
  version,
  onClose,
}: {
  entryName: string
  version: TemplateLibraryVersionSummaryV1
  onClose: () => void
}) {
  const [preview, setPreview] = useState<TemplateLibraryPreviewV1 | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [pageIndex, setPageIndex] = useState(0)

  useEffect(() => {
    let disposed = false
    let manifestId: string | null = null

    setPreview(null)
    setLoadFailed(false)
    setPageIndex(0)

    const release = async (id: string) => {
      await ipcClient.invoke('xiaogui.templateLibrary.preview.release', { manifestId: id })
    }
    const prepare = async () => {
      try {
        const next = await ipcClient.invoke(
          'xiaogui.templateLibrary.preview.prepare',
          { versionId: version.versionId },
        ) as TemplateLibraryPreviewV1
        manifestId = next.manifestId
        if (disposed) {
          const id = manifestId
          manifestId = null
          await release(id)
          return
        }
        setPreview(next)
      } catch {
        if (!disposed) setLoadFailed(true)
      }
    }

    void prepare()
    return () => {
      disposed = true
      if (!manifestId) return
      const id = manifestId
      manifestId = null
      void release(id).catch(() => undefined)
    }
  }, [version.versionId])

  const pages = preview?.render.pages ?? []
  const page = pages[pageIndex]

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-background"
      role="dialog"
      aria-modal="true"
      aria-label="模板版本预览"
    >
      <header className="flex h-14 items-center gap-3 border-b border-border px-5">
        <div className="min-w-0">
          <h1 className="truncate text-[14px] font-semibold">{entryName}</h1>
          <p className="text-[11px] text-muted-foreground">第 {version.versionNumber} 版 · 小规内置预览</p>
        </div>
        <button
          type="button"
          className="ml-auto rounded-md border px-3 py-1.5 text-[11px] hover:bg-muted"
          onClick={onClose}
        >
          关闭预览
        </button>
      </header>

      {loadFailed ? (
        <main className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-7">
          <div className="max-w-lg rounded-lg border border-destructive/40 bg-destructive/5 p-5 text-center text-[12px] leading-6 text-destructive">
            模板版本预览准备失败。小规没有打开外部文档，也没有把本机文件路径暴露到界面；请关闭后重试。
          </div>
        </main>
      ) : preview?.render.mode === 'STRUCTURED_FALLBACK' ? (
        <main className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-7">
          <section className="w-full max-w-2xl rounded-xl border border-amber-300 bg-amber-50 p-6 text-amber-950">
            <h2 className="text-[14px] font-semibold">无法生成内置页面预览</h2>
            <p className="mt-2 text-[12px] leading-6">
              本机文档渲染组件当前不可用或转换失败。这里显示的是结构化降级状态，不代表页面预览成功。
            </p>
            <ul className="mt-4 space-y-2">
              {preview.render.warnings.map((warning) => (
                <li key={`${warning.code}:${warning.message}`} className="rounded-md border border-amber-300/80 bg-white/60 p-3 text-[11px] leading-5">
                  <span className="mr-2 font-mono font-semibold">{warning.code}</span>
                  {warning.message}
                </li>
              ))}
            </ul>
          </section>
        </main>
      ) : preview ? (
        <>
          <div className="flex h-12 items-center justify-center gap-3 border-b border-border">
            <button
              type="button"
              aria-label="上一页"
              onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
              disabled={pageIndex <= 0}
              className="rounded-md border px-2.5 py-1 text-[11px] disabled:opacity-30"
            >
              上一页
            </button>
            <span className="min-w-24 text-center text-[12px]">第 {pages.length ? pageIndex + 1 : 0} / {pages.length} 页</span>
            <button
              type="button"
              aria-label="下一页"
              onClick={() => setPageIndex((current) => Math.min(pages.length - 1, current + 1))}
              disabled={pageIndex >= pages.length - 1}
              className="rounded-md border px-2.5 py-1 text-[11px] disabled:opacity-30"
            >
              下一页
            </button>
          </div>
          <main className="min-h-0 flex-1 overflow-auto bg-muted/30 p-7">
            {page ? (
              <TemplateLibraryPreviewPage key={page.pageToken} page={page} />
            ) : (
              <div className="mx-auto max-w-lg rounded-lg border border-amber-300 bg-amber-50 p-5 text-center text-[12px] text-amber-900">
                渲染结果没有可显示页面，当前预览未成功。
              </div>
            )}
          </main>
        </>
      ) : (
        <main className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-7 text-[12px] text-muted-foreground">
          正在准备模板预览…
        </main>
      )}
    </div>
  )
}
