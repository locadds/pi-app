import { useState } from 'react'

import type {
  TemplateMaterializePreviewRequestV1,
  TemplateMaterializePreviewResultV1 as SharedTemplateMaterializePreviewResultV1,
} from '@shared/xiaogui-work-docx-template-materialize'
import { FileText } from '@renderer/components/icons'
import type { DocxHtmlViewerStateV1 } from '@renderer/components/docx-html-viewer'
import { DocumentSurfaceViewerV1 } from '@renderer/features/document-surface/document-surface-viewer'

export type TemplateMaterializePreviewPayloadV1 = TemplateMaterializePreviewRequestV1
export type TemplateMaterializePreviewResultV1 = SharedTemplateMaterializePreviewResultV1

export function TemplateMaterializePreviewDialog({
  payload,
  onResult,
}: {
  payload: TemplateMaterializePreviewPayloadV1
  onResult: (result: TemplateMaterializePreviewResultV1) => void
}) {
  const [modificationInstruction, setModificationInstruction] = useState('')
  const [viewerState, setViewerState] = useState<DocxHtmlViewerStateV1>('LOADING')
  const canGenerate = payload.document.render.mode === 'DOCX_HTML' && !!payload.document.render.documentToken && viewerState === 'READY'

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

      <main className="min-h-0 flex-1 bg-muted/30">
        {payload.document.render.mode === 'DOCX_HTML' ? (
          <DocumentSurfaceViewerV1
            purpose="MATERIALIZED_PREVIEW"
            documentToken={payload.document.render.documentToken}
            title={payload.plan.source.displayName}
            readonlyLabel="修改后模板只读预览"
            onStateChange={(nextState) => setViewerState(nextState)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-7">
            <div className="max-w-lg rounded-lg border border-amber-300 bg-amber-50 p-5 text-center text-sm text-amber-800">
              没有可显示的修改后文档预览，请返回修改并重新生成。
            </div>
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
          className="rounded-md border px-4 py-2 text-[12px] hover:bg-muted disabled:opacity-40"
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
