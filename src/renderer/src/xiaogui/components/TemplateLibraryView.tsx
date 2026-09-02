import { useEffect, useMemo, useState } from 'react'

import type {
  TemplateLibraryDetailV1,
  TemplateLibraryListResultV1,
  TemplateLibrarySummaryV1,
  TemplateLibraryUsageV1,
  TemplateLibraryVersionSummaryV1,
} from '@shared/xiaogui-template-library'
import { ipcClient } from '@renderer/lib/ipc-client'
import { submitComposerPrompt } from '@renderer/lib/composer-quick-submit'
import { TemplateLibraryPreviewDialog } from './TemplateLibraryPreviewDialog'

function readableBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function templatePrompt(entry: TemplateLibrarySummaryV1, versionNumber: number): string {
  return `使用本机模板库中的“${entry.name}”第 ${versionNumber} 版生成新文档，先把需要填写的内容列给我确认`
}

export function TemplateLibraryView({
  onBack,
  compact = false,
}: {
  onBack?: () => void
  compact?: boolean
}) {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [query, setQuery] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [showTrash, setShowTrash] = useState(false)
  const [result, setResult] = useState<TemplateLibraryListResultV1 | null>(null)
  const [usage, setUsage] = useState<TemplateLibraryUsageV1 | null>(null)
  const [detail, setDetail] = useState<TemplateLibraryDetailV1 | null>(null)
  const [previewVersion, setPreviewVersion] = useState<TemplateLibraryVersionSummaryV1 | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setError(null)
    try {
      const configuration = await ipcClient.invoke('xiaogui.templateLibrary.configuration.get') as { configured: boolean }
      setConfigured(configuration.configured)
      if (!configuration.configured) {
        setResult(null)
        setUsage(null)
        return
      }
      const [nextResult, nextUsage] = await Promise.all([
        ipcClient.invoke('xiaogui.templateLibrary.list', {
          query,
          tags: selectedTags,
          status: showTrash ? 'TRASHED' : 'ACTIVE',
          limit: 100,
          offset: 0,
        }) as Promise<TemplateLibraryListResultV1>,
        ipcClient.invoke('xiaogui.templateLibrary.usage') as Promise<TemplateLibraryUsageV1>,
      ])
      setResult(nextResult)
      setUsage(nextUsage)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '模板库读取失败')
    }
  }

  useEffect(() => { void refresh() }, [query, selectedTags, showTrash])

  const availableTags = useMemo(
    () => [...new Set(result?.items.flatMap((item) => item.tags) ?? [])],
    [result],
  )

  const configure = async () => {
    setBusy(true)
    try {
      const response = await ipcClient.invoke('xiaogui.templateLibrary.configuration.choose') as { configured: boolean }
      if (response.configured) await refresh()
    } finally {
      setBusy(false)
    }
  }

  const openDetail = async (entryId: string) => {
    setDetail(await ipcClient.invoke('xiaogui.templateLibrary.detail', { entryId }) as TemplateLibraryDetailV1)
  }

  const mutate = async (channel: 'trash' | 'restore' | 'purge', entryId: string) => {
    if (channel === 'purge' && !window.confirm('彻底删除后无法恢复，确定继续吗？')) return
    setBusy(true)
    try {
      await ipcClient.invoke(`xiaogui.templateLibrary.${channel}`, { entryId })
      setDetail(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={compact ? 'flex h-full min-w-0 flex-col px-3 py-3' : 'mx-auto flex h-full w-full max-w-5xl flex-col px-6 py-6'}>
      <header className={compact ? 'flex flex-col gap-2 border-b border-border/70 pb-3' : 'flex items-center gap-3 border-b border-border/70 pb-4'}>
        {onBack && <button type="button" onClick={onBack} className="rounded-md border px-2.5 py-1.5 text-[12px] hover:bg-muted">返回工作台</button>}
        <div><h1 className="text-[16px] font-semibold">本机模板库</h1><p className="mt-0.5 text-[11px] text-muted-foreground">保存复核完成的模板，并可按历史版本继续生成文档</p></div>
        {usage && <span className={compact ? 'text-[11px] text-muted-foreground' : 'ml-auto text-[11px] text-muted-foreground'}>{usage.activeTemplateCount} 个模板 · {usage.versionCount} 个版本 · {readableBytes(usage.totalAssetBytes)}</span>}
      </header>

      {configured === false ? <div className="m-auto max-w-md text-center"><h2 className="text-[15px] font-semibold">先选择模板库文件夹</h2><p className="mt-2 text-[12px] leading-6 text-muted-foreground">模板和版本记录由你放在指定磁盘，不固定占用 C 盘。小规不会自动删除。</p><button type="button" disabled={busy} onClick={configure} className="mt-5 rounded-md bg-primary px-4 py-2 text-[12px] text-primary-foreground disabled:opacity-40">选择文件夹</button></div> : <>
        <div className={compact ? 'flex flex-col gap-2 py-3' : 'flex items-center gap-2 py-4'}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 rounded-md border px-3 py-2 text-[12px]" placeholder="搜索名称、用途或标签" />
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowTrash(false)} className={`flex-1 rounded-md border px-3 py-2 text-[12px] ${!showTrash ? 'bg-muted font-medium' : ''}`}>模板</button>
            <button type="button" onClick={() => setShowTrash(true)} className={`flex-1 rounded-md border px-3 py-2 text-[12px] ${showTrash ? 'bg-muted font-medium' : ''}`}>回收站</button>
          </div>
        </div>
        {!!availableTags.length && <div className="mb-3 flex flex-wrap gap-1 text-[10px] text-muted-foreground">{availableTags.map((tag) => <button type="button" key={tag} onClick={() => setSelectedTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])} className={`rounded border px-1.5 py-0.5 ${selectedTags.includes(tag) ? 'bg-muted font-medium text-foreground' : ''}`}>{tag}</button>)}</div>}
        {error && <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</p>}
        <div className={compact ? 'grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto pb-4' : 'grid min-h-0 flex-1 gap-3 overflow-auto pb-5 sm:grid-cols-2 xl:grid-cols-3'}>
          {result?.items.map((entry) => <article key={entry.entryId} className="flex min-h-44 flex-col rounded-xl border bg-background p-4">
            <div className="flex items-start justify-between gap-2"><div><h2 className="text-[13px] font-semibold">{entry.name}</h2><p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted-foreground">{entry.purpose || '暂无用途说明'}</p></div><span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px]">v{entry.latestVersion.versionNumber}</span></div>
            <p className="mt-3 text-[11px] text-muted-foreground">{entry.fields.length} 个字段 · {entry.versionCount} 个版本 · {readableBytes(entry.latestVersion.byteLength)}</p>
            <div className="mt-auto flex flex-wrap gap-2 pt-4">
              {!showTrash && <button type="button" onClick={() => submitComposerPrompt(templatePrompt(entry, entry.latestVersion.versionNumber))} className="rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground">使用最新版</button>}
              <button type="button" onClick={() => void openDetail(entry.entryId)} className="rounded-md border px-2.5 py-1.5 text-[11px]">版本记录</button>
              <button type="button" disabled={busy} onClick={() => void mutate(showTrash ? 'restore' : 'trash', entry.entryId)} className="rounded-md border px-2.5 py-1.5 text-[11px]">{showTrash ? '恢复' : '放入回收站'}</button>
              {showTrash && <button type="button" disabled={busy} onClick={() => void mutate('purge', entry.entryId)} className="rounded-md border border-destructive/50 px-2.5 py-1.5 text-[11px] text-destructive">彻底删除</button>}
            </div>
          </article>)}
          {result && result.items.length === 0 && <div className="col-span-full py-20 text-center text-[12px] text-muted-foreground">{showTrash ? '回收站为空' : '还没有模板。完成文档复核后，正式模板会先保存到这里。'}</div>}
        </div>
      </>}

      {detail && <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-5"><div className="w-full max-w-xl rounded-xl bg-background p-5 shadow-xl"><div className="flex items-start gap-3"><div><h2 className="text-[15px] font-semibold">{detail.name}</h2><p className="mt-1 text-[11px] text-muted-foreground">选择最新版或任一历史版本后，会直接进入生成对话。</p></div><button type="button" className="ml-auto rounded-md border px-2 py-1 text-[11px]" onClick={() => setDetail(null)}>关闭</button></div><div className="mt-4 max-h-[55vh] space-y-2 overflow-auto">{detail.versions.map((version) => <div key={version.versionId} className="flex items-center gap-3 rounded-lg border p-3"><div><p className="text-[12px] font-medium">第 {version.versionNumber} 版{version.isLatest ? '（最新版）' : ''}</p><p className="mt-1 text-[10px] text-muted-foreground">{new Date(version.createdAt).toLocaleString()} · {version.fields.length} 个字段 · {readableBytes(version.byteLength)}</p></div>{detail.status === 'ACTIVE' && <div className="ml-auto flex gap-2"><button type="button" onClick={() => setPreviewVersion(version)} className="rounded-md border px-2.5 py-1.5 text-[11px]">预览</button><button type="button" onClick={() => { submitComposerPrompt(templatePrompt(detail, version.versionNumber)); setDetail(null) }} className="rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground">使用此版本</button></div>}</div>)}</div></div></div>}
      {detail && previewVersion && <TemplateLibraryPreviewDialog entryName={detail.name} version={previewVersion} onClose={() => setPreviewVersion(null)} />}
    </div>
  )
}
