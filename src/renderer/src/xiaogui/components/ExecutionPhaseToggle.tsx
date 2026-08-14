/**
 * 小规 Agent 执行方式切换器（ASK｜问询、PLAN｜规划、EXECUTE｜执行）。
 *
 * 与一级工作模式（WORK/DESIGN/CODING）正交：模式决定"在哪个领域做事"，
 * 执行方式决定"以什么方式推进"（V0.1 仅状态标记与策略路由接口，
 * 不实现 Plan Engine，不拦截任何行为）。
 *
 * 视觉定位：Composer 输入框上方的"档位指示条"——延续 ModeSelector 的
 * 测量工作台美学：
 * - 等宽字体英文档位（仪器刻度感），当前档位以测量红（朱砂）标识；
 * - 全部使用 pi-app 语义 token（foreground/border/muted-foreground），
 *   自动跟随深浅主题。
 *
 * 状态来源：useXiaoguiStore（经 IPC 白名单通道 xiaogui.phase.get /
 * phase.switch 同步主进程）。渲染进程不接触文件系统 / Python 进程。
 */

import { useEffect } from 'react'

import { useXiaoguiStore, type ExecutionPhase } from '../stores/xiaogui-store'

/** 测量红（朱砂）：与 ModeSelector 一致，仅用于当前档位强调。 */
const ACCENT = '#c0392b'

const PHASES: { id: ExecutionPhase; zhLabel: string; hint: string }[] = [
  { id: 'ASK', zhLabel: '问询', hint: '只回答，不主动执行操作' },
  { id: 'PLAN', zhLabel: '规划', hint: '先输出计划，用户确认后再执行' },
  { id: 'EXECUTE', zhLabel: '执行', hint: '直接执行操作' },
]

export function ExecutionPhaseToggle() {
  const phase = useXiaoguiStore((s) => s.executionPhase)
  const switchExecutionPhase = useXiaoguiStore((s) => s.switchExecutionPhase)
  const refreshExecutionPhase = useXiaoguiStore((s) => s.refreshExecutionPhase)

  // 挂载时与主进程对齐一次执行方式
  useEffect(() => {
    void refreshExecutionPhase()
  }, [refreshExecutionPhase])

  return (
    <div className="mb-1.5 flex select-none items-center justify-end gap-2 px-0.5">
      <span className="text-[10px] font-semibold tracking-[0.3em] text-muted-foreground">
        执行方式
      </span>
      <div
        className="flex items-center gap-0.5 rounded-full border border-border/70 bg-black/[0.03] p-0.5 dark:bg-white/[0.04]"
        role="tablist"
        aria-label="执行方式"
      >
        {PHASES.map((p) => {
          const active = p.id === phase
          return (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={p.hint}
              onClick={() => {
                if (!active) void switchExecutionPhase(p.id)
              }}
              className={[
                'flex items-baseline gap-1 rounded-full px-2 py-0.5 outline-none',
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
                {p.id}
              </span>
              <span
                className={[
                  'text-[10px] leading-tight transition-colors',
                  active ? 'font-semibold text-foreground' : '',
                ].join(' ')}
              >
                {p.zhLabel}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}