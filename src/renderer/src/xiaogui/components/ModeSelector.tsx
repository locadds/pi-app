/**
 * 小规 Agent 一级模式切换器（WORK｜工作、DESIGN｜规划设计、CODING｜编程）。
 *
 * 视觉定位：侧栏顶部的"模式转盘"——测量/制图工作台美学：
 * - 英文模式 ID 用等宽字体（仪器刻度感），中文标签为主读信息；
 * - 当前模式以测量红（朱砂）刻度点 + 下划刻度线标识；
 * - 全部使用 pi-app 语义 token（foreground/border/muted-foreground），自动跟随深浅主题。
 *
 * 状态来源：useXiaoguiStore（经 IPC 白名单通道 xiaogui.mode.switch / mode.get 同步主进程）。
 * 渲染进程不接触文件系统 / Python 进程。
 */

import { useEffect } from 'react'

import { useUIStore } from '@renderer/stores/ui-store'

import { useXiaoguiStore, XIAOGUI_MODES, type XiaoguiMode } from '../stores/xiaogui-store'

/** 测量红（朱砂）：仅用于模式刻度与强调，克制使用。 */
const ACCENT = '#c0392b'

const MODE_HINT: Record<XiaoguiMode, string> = {
  WORK: '日常工作 · 轻量任务',
  DESIGN: '规划设计 · 接口预留',
  CODING: '编程 · 小规工作台',
}

export function ModeSelector() {
  // 侧栏折叠态（40px 窄栏）：不渲染模式转盘，避免破坏窄栏布局
  const collapsed = useUIStore((s) => s.sidebarCollapsed)
  const mode = useXiaoguiStore((s) => s.mode)
  const switchMode = useXiaoguiStore((s) => s.switchMode)
  const refreshMode = useXiaoguiStore((s) => s.refreshMode)
  const sidecar = useXiaoguiStore((s) => s.sidecar)
  const refreshSidecarStatus = useXiaoguiStore((s) => s.refreshSidecarStatus)

  // 挂载时与主进程对齐一次模式与 sidecar 状态
  useEffect(() => {
    void refreshMode()
    void refreshSidecarStatus()
  }, [refreshMode, refreshSidecarStatus])

  if (collapsed) return null

  return (
    <section aria-label="小规 Agent 一级模式" className="select-none px-2 pt-2">
      <div className="flex items-baseline justify-between px-0.5 pb-1.5">
        <span className="text-[10px] font-semibold tracking-[0.3em] text-muted-foreground">
          小规 AGENT
        </span>
        {/* sidecar 运行指示（DESIGN 模式依赖 Python Runtime） */}
        <span
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
          title={
            sidecar
              ? `Python Runtime：${sidecar.running ? '运行中' : '待启动（首次调用时惰性拉起）'}`
              : 'Python Runtime：状态未知'
          }
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: sidecar?.running ? '#16a34a' : 'currentColor',
              opacity: sidecar?.running ? 1 : 0.5,
            }}
          />
          RUNTIME
        </span>
      </div>

      <div
        className="grid grid-cols-3 gap-1 rounded-lg border border-border/70 bg-black/[0.03] p-1 dark:bg-white/[0.04]"
        role="tablist"
        aria-label="一级工作模式"
      >
        {XIAOGUI_MODES.map((m) => {
          const active = m.id === mode
          return (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={MODE_HINT[m.id]}
              onClick={() => {
                if (!active) void switchMode(m.id)
              }}
              className={[
                'group relative flex flex-col items-center rounded-md px-1 py-1.5 outline-none',
                'transition-colors duration-150 focus-visible:ring-1',
                active
                  ? 'bg-background shadow-sm'
                  : 'cursor-pointer text-muted-foreground hover:bg-background/60 hover:text-foreground',
              ].join(' ')}
            >
              <span
                className="font-mono text-[9px] font-medium uppercase tracking-[0.14em]"
                style={{ color: active ? ACCENT : undefined }}
              >
                {m.id}
              </span>
              <span
                className={[
                  'mt-0.5 text-[12px] leading-tight transition-colors',
                  active ? 'font-semibold text-foreground' : '',
                ].join(' ')}
              >
                {m.zhLabel}
              </span>
              {/* 刻度线：当前模式的下划红线 */}
              <span
                aria-hidden
                className="mt-1 block h-[2px] w-5 rounded-full transition-all duration-200"
                style={{
                  background: active ? ACCENT : 'transparent',
                  transform: active ? 'scaleX(1)' : 'scaleX(0.4)',
                  opacity: active ? 1 : 0,
                }}
              />
            </button>
          )
        })}
      </div>

      <p className="px-0.5 pt-1.5 text-[10px] leading-snug text-muted-foreground/80">
        {MODE_HINT[mode]}
      </p>
    </section>
  )
}
