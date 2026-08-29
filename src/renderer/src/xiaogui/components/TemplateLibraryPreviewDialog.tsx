import { useEffect, useState } from 'react'

import type {
  TemplateLibraryPreviewV1,
  TemplateLibraryVersionSummaryV1,
} from '@shared/xiaogui-template-library'
import { ipcClient } from '@renderer/lib/ipc-client'
import { DocumentSurfaceViewerV1 } from '@renderer/features/document-surface/document-surface-viewer'

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

  useEffect(() => {
    let disposed = false
    let manifestId: string | null = null

    setPreview(null)
    setLoadFailed(false)

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
        <main className="min-h-0 flex-1 bg-muted/30">
          <DocumentSurfaceViewerV1
            purpose="TEMPLATE_LIBRARY_PREVIEW"
            documentToken={preview.render.documentToken}
            title={`${entryName} 第 ${version.versionNumber} 版`}
            readonlyLabel="模板库版本只读预览"
          />
        </main>
      ) : (
        <main className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-7 text-[12px] text-muted-foreground">
          正在准备模板预览…
        </main>
      )}
    </div>
  )
}
