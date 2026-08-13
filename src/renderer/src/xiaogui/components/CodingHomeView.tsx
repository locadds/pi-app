/**
 * CODING 模式首屏视图（小规 Agent · CODING 模式专用）。
 *
 * 定位：信息性说明卡——CODING = Pi 原生编程能力，受企业开发规范与守卫管控。
 * 真正的编程交互仍走常驻对话框（Composer），本视图不做任何功能入口。
 *
 * 表述约束：当前无真实沙箱，不出现"沙箱/sandbox"字样；
 * 企业管控表述为"遵循企业开发规范 + 危险操作留痕/拦截（由企业守卫扩展提供）"。
 *
 * 仅在 CODING 模式下呈现；其他模式渲染占位提示（与 ProjectInspectView 一致）。
 */

import { useXiaoguiStore } from '../stores/xiaogui-store'

/** 朱砂红——与 ModeSelector / ProjectInspectView 保持同一强调色。 */
const ACCENT = '#c0392b'

/** 管控要点：信息性描述，不对应具体已装组件。 */
const GUARD_POINTS: { mark: string; text: string }[] = [
  {
    mark: '§',
    text: '遵循企业开发规范：复用优先、来源可追溯、安全信息不入库',
  },
  {
    mark: '✓',
    text: '危险操作留痕 / 拦截（由企业守卫扩展提供）',
  },
  {
    mark: '≡',
    text: '编程会话与工具调用全程可审计，写操作进入企业策略链路',
  },
]

export function CodingHomeView() {
  const mode = useXiaoguiStore((s) => s.mode)

  if (mode !== 'CODING') {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        <p className="max-w-[26rem] leading-relaxed">
          编程说明卡仅在 <span className="font-semibold text-foreground">CODING｜编程</span>{' '}
          模式下呈现，请先切换模式。
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      {/* ---- 标题 ---- */}
      <header className="mb-5 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold text-foreground">编程</h1>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          coding · pi native
        </span>
      </header>

      {/* ---- 说明卡（虚线测量框，与 DESIGN 视图同一观感） ---- */}
      <section className="overflow-hidden rounded-lg border border-dashed border-border bg-background/40">
        <div className="border-b border-border/70 px-5 py-4">
          <p className="text-[13px] leading-relaxed text-foreground">
            CODING 模式即{' '}
            <span className="font-semibold" style={{ color: ACCENT }}>
              Pi 原生编程能力
            </span>
            ：读写代码、运行命令、调试与重构，全部通过下方常驻对话框完成。
            在企业环境中，该能力受企业开发规范与守卫扩展管控。
          </p>
        </div>

        {/* ---- 管控要点 ---- */}
        <ul className="space-y-2 px-5 py-4">
          {GUARD_POINTS.map((g) => (
            <li key={g.text} className="flex items-start gap-3">
              <span
                className="mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border font-mono text-[11px] font-bold"
                style={{ color: ACCENT, borderColor: `${ACCENT}55` }}
                aria-hidden
              >
                {g.mark}
              </span>
              <span className="text-[12px] leading-relaxed text-muted-foreground">
                {g.text}
              </span>
            </li>
          ))}
        </ul>

        {/* ---- 引导 ---- */}
        <div className="border-t border-dashed border-border/70 px-5 py-3">
          <p className="text-[12px] text-muted-foreground">
            直接在下方对话框描述你的编程任务即可开始，例如：
            <span className="font-mono text-[12px] text-foreground">
              "帮我看懂这个函数并补上单元测试"
            </span>
          </p>
        </div>
      </section>

      {/* ---- 尾注 ---- */}
      <footer className="mt-6 flex flex-wrap justify-between gap-2 border-t border-dashed border-border/70 pt-2 font-mono text-[10px] text-muted-foreground">
        <span>runtime: pi native coding harness</span>
        <span>guard: enterprise policy extension</span>
      </footer>
    </div>
  )
}
