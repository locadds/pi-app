/**
 * design.project.inspect 结果展示视图（小规 Agent · DESIGN 模式专用）。
 *
 * 视觉定位："测绘检查单"——虚线测量边框、等宽路径与 trace_id、朱砂印章式状态戳。
 *
 * 数据流：渲染进程 → IPC 白名单通道（xiaogui.tool.invoke）→ 主进程 ToolGateway
 * → Python sidecar（LocalProjectAdapter）。渲染进程不直接接触文件系统 / Python。
 *
 * 仅在 DESIGN 模式下可用；其他模式渲染占位提示。
 */

import { useEffect, useState, type FormEvent } from 'react'

import {
  useXiaoguiStore,
  type XiaoguiEvidence,
  type XiaoguiToolResult,
} from '../stores/xiaogui-store'

/** 测量红（朱砂）——与 ModeSelector 保持同一强调色。 */
const ACCENT = '#c0392b'

const STATUS_META: Record<
  XiaoguiToolResult['status'],
  { zh: string; cls: string; mark: string }
> = {
  ok: { zh: '通过', cls: 'text-green-700 border-green-700/50 dark:text-green-400 dark:border-green-400/50', mark: '✓' },
  warning: { zh: '有警告', cls: 'text-amber-700 border-amber-700/50 dark:text-amber-400 dark:border-amber-400/50', mark: '▲' },
  error: { zh: '错误', cls: 'text-red-700 border-red-700/50 dark:text-red-400 dark:border-red-400/50', mark: '✕' },
}

interface InspectFile {
  path: string
  type: string
  size: number
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function asFiles(raw: unknown): InspectFile[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (f): f is InspectFile =>
      !!f && typeof f === 'object' && typeof (f as InspectFile).path === 'string',
  )
}

function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((w): w is string => typeof w === 'string') : []
}

function asString(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

export function ProjectInspectView() {
  const mode = useXiaoguiStore((s) => s.mode)
  const invoking = useXiaoguiStore((s) => s.invoking)
  const lastResult = useXiaoguiStore((s) => s.lastResult)
  const lastError = useXiaoguiStore((s) => s.lastError)
  const invokeDesignProjectInspect = useXiaoguiStore((s) => s.invokeDesignProjectInspect)
  const clearResult = useXiaoguiStore((s) => s.clearResult)
  const sidecar = useXiaoguiStore((s) => s.sidecar)
  const refreshSidecarStatus = useXiaoguiStore((s) => s.refreshSidecarStatus)

  const [path, setPath] = useState('')

  useEffect(() => {
    void refreshSidecarStatus()
  }, [refreshSidecarStatus])

  if (mode !== 'DESIGN') {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        <p className="max-w-[26rem] leading-relaxed">
          项目检查仅在 <span className="font-semibold text-foreground">DESIGN｜规划设计</span>{' '}
          模式下可用，请先切换模式。
        </p>
      </div>
    )
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = path.trim()
    if (!trimmed || invoking) return
    void invokeDesignProjectInspect(trimmed)
  }

  const files = lastResult ? asFiles(lastResult.data['files']) : []
  const projectName = lastResult ? asString(lastResult.data['project_name']) : ''
  const projectRoot = lastResult ? asString(lastResult.data['root']) : ''
  const projectId = lastResult ? asString(lastResult.data['project_id']) : ''
  const spatialRef = lastResult ? asString(lastResult.data['spatial_reference_status']) : ''
  const fileTypes =
    lastResult && typeof lastResult.data['file_types'] === 'object'
      ? Object.entries(lastResult.data['file_types'] as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'number')
          .map(([k, v]) => [k, v as number] as const)
      : []
  const status = lastResult ? STATUS_META[lastResult.status] : null

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      {/* ---- 标题 ---- */}
      <header className="mb-5 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold text-foreground">项目检查</h1>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          design.project.inspect
        </span>
      </header>

      {/* ---- 路径输入（虚线测量框） ---- */}
      <form onSubmit={handleSubmit}>
        <div className="flex items-stretch gap-2 rounded-lg border border-dashed border-border bg-background/40 p-2">
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="输入项目目录路径，例如 D:\项目\某单元控制性详细规划"
            spellCheck={false}
            aria-label="项目目录路径"
            className="min-w-0 flex-1 bg-transparent px-2 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
          <button
            type="submit"
            disabled={invoking || !path.trim()}
            className={[
              'shrink-0 rounded-md px-4 py-1.5 text-[13px] font-medium transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'bg-foreground text-background hover:opacity-90',
            ].join(' ')}
          >
            {invoking ? (
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
                />
                检查中…
              </span>
            ) : (
              '检查'
            )}
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-muted-foreground/80">
          读取原始成果（只读），不会修改任何文件；
          {sidecar?.running ? 'Python Runtime 运行中。' : '首次检查将惰性拉起 Python Runtime。'}
        </p>
      </form>

      {/* ---- IPC 层错误（非 ToolResult 的传输错误） ---- */}
      {lastError && (
        <div
          role="alert"
          className="mt-5 rounded-lg border border-red-700/40 bg-red-700/[0.06] px-4 py-3 dark:border-red-400/40 dark:bg-red-400/[0.08]"
        >
          <p className="text-[13px] font-medium text-red-700 dark:text-red-400">调用失败</p>
          <p className="mt-1 break-all font-mono text-[12px] text-red-700/90 dark:text-red-400/90">
            {lastError}
          </p>
        </div>
      )}

      {/* ---- 结果：检查单 ---- */}
      {lastResult && status && (
        <section className="mt-6 overflow-hidden rounded-lg border border-border bg-background/40">
          {/* 单头：状态印章 + 项目标识 + trace_id */}
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold text-foreground">
                {projectName || '（未知项目）'}
              </p>
              <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={projectRoot}>
                {projectRoot}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span
                className={[
                  'inline-flex rotate-[-2deg] items-center gap-1.5 rounded border-2 px-2 py-0.5',
                  'font-mono text-[11px] font-bold tracking-[0.18em]',
                  status.cls,
                ].join(' ')}
              >
                <span aria-hidden>{status.mark}</span>
                {status.zh}
              </span>
              {lastResult.trace_id && (
                <span className="font-mono text-[10px] text-muted-foreground" title="trace_id">
                  trace {lastResult.trace_id}
                </span>
              )}
            </div>
          </div>

          <div className="px-4 py-4">
            {/* 概览：文件数 / 类型分布 / 空间基准 / project_id */}
            <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">专业文件</dt>
                <dd className="mt-0.5 font-mono text-[13px] font-semibold text-foreground">
                  {files.length}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">类型分布</dt>
                <dd className="mt-0.5 flex flex-wrap gap-1">
                  {fileTypes.length > 0 ? (
                    fileTypes.map(([ext, count]) => (
                      <span
                        key={ext}
                        className="rounded border border-border/80 px-1 py-px font-mono text-[10px] uppercase text-muted-foreground"
                      >
                        {ext}×{count}
                      </span>
                    ))
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">空间基准</dt>
                <dd className="mt-0.5 font-mono text-[12px] text-foreground">
                  {spatialRef || '—'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">project_id</dt>
                <dd className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={projectId}>
                  {projectId || '—'}
                </dd>
              </div>
            </dl>

            {/* warnings */}
            {lastResult.warnings.length > 0 && (
              <div className="mb-4 rounded-md border border-amber-700/30 bg-amber-700/[0.05] px-3 py-2 dark:border-amber-400/30 dark:bg-amber-400/[0.06]">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                  Warnings · {lastResult.warnings.length}
                </p>
                <ul className="space-y-0.5">
                  {lastResult.warnings.map((w, i) => (
                    <li key={i} className="break-all text-[12px] text-amber-800/90 dark:text-amber-200/80">
                      ▲ {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 文件列表 */}
            <div className="mb-1 flex items-baseline justify-between">
              <h2 className="text-[12px] font-semibold text-foreground">
                文件清单 <span className="font-mono text-muted-foreground">({files.length})</span>
              </h2>
              <button
                type="button"
                onClick={clearResult}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                清除结果
              </button>
            </div>
            {files.length > 0 ? (
              <ul className="max-h-72 overflow-y-auto rounded-md border border-border/70">
                {files.map((f) => (
                  <li
                    key={f.path}
                    className="flex items-center gap-3 border-b border-border/40 px-3 py-1.5 last:border-b-0"
                  >
                    <span
                      className="w-11 shrink-0 text-center font-mono text-[10px] font-bold uppercase"
                      style={{ color: ACCENT }}
                    >
                      .{f.type}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={f.path}>
                      {f.path}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {formatSize(f.size)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted-foreground">
                未发现已识别类型的专业文件
              </p>
            )}

            {/* evidence（证据链，按 docs/DESIGN_TOOLS.md 要求随结果返回） */}
            {lastResult.evidence.length > 0 && (
              <details className="mt-3 group">
                <summary className="cursor-pointer list-none text-[11px] text-muted-foreground hover:text-foreground">
                  <span className="group-open:hidden">▸ 证据链（{lastResult.evidence.length}）</span>
                  <span className="hidden group-open:inline">▾ 证据链（{lastResult.evidence.length}）</span>
                </summary>
                <ul className="mt-1.5 space-y-1">
                  {lastResult.evidence.map((ev: XiaoguiEvidence, i) => (
                    <li key={i} className="break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
                      [{ev.source_type}] {ev.source_path ?? ''}
                      {ev.location ? ` @${ev.location}` : ''}
                      {ev.excerpt ? ` — ${ev.excerpt}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {/* 单尾：来源版本与生成时间 */}
            <footer className="mt-4 flex flex-wrap justify-between gap-2 border-t border-dashed border-border/70 pt-2 font-mono text-[10px] text-muted-foreground">
              <span>source_version: {lastResult.source_version}</span>
              <span>generated_at: {lastResult.generated_at}</span>
            </footer>
          </div>
        </section>
      )}

      {/* ---- 空状态 ---- */}
      {!lastResult && !lastError && !invoking && (
        <div className="mt-10 rounded-lg border border-dashed border-border/80 px-6 py-10 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/70">
            NO INSPECTION YET
          </p>
          <p className="mt-2 text-[13px] text-muted-foreground">
            输入项目目录路径并点击"检查"，由 Python Professional Runtime 扫描专业文件。
          </p>
        </div>
      )}
    </div>
  )
}
