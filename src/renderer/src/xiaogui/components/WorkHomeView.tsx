/**
 * WORK 模式首屏视图（小规 Agent · WORK 模式专用）。
 *
 * 定位：轻量引导面板——WORK 模式以自然语言对话为入口。用户在常驻对话框
 * 直接说明需求，由小规/Pi 选择已接入的能力执行；需要选择资料、确认范围或
 * 展示结果时，界面才出现卡片或对话框。本页只说明用法，不提供功能按钮，
 * 也不宣称未接入的能力。
 *
 * 仅在 WORK 模式下呈现；其他模式渲染占位提示（与 ProjectInspectView 一致）。
 */

import { useXiaoguiStore } from '../stores/xiaogui-store'

/** 朱砂红——与 ModeSelector / ProjectInspectView 保持同一强调色。 */
const ACCENT = '#c0392b'

/** 示例提示词：只覆盖当前对话能力，不暗示尚未接通的自然语言工具调用。 */
const EXAMPLE_PROMPTS: { title: string; prompt: string }[] = [
  {
    title: '整理文件',
    prompt: '帮我看看当前目录里有哪些文件，按类型归类列一份清单',
  },
  {
    title: '撰写文本报告',
    prompt: '根据本项目里的资料，帮我起草一份工作小结的文本初稿',
  },
  {
    title: '读写与汇总',
    prompt: '读取我指定的几个文本文件，把要点汇总成一份纪要',
  },
]

export function WorkHomeView() {
  const mode = useXiaoguiStore((s) => s.mode)

  if (mode !== 'WORK') {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        <p className="max-w-[26rem] leading-relaxed">
          工作台仅在 <span className="font-semibold text-foreground">WORK｜工作</span>{' '}
          模式下呈现，请先切换模式。
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      {/* ---- 标题 ---- */}
      <header className="mb-5 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold text-foreground">工作台</h1>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          work · 日常工作
        </span>
      </header>

      {/* ---- 用法说明（虚线测量框，与 DESIGN 视图同一观感） ---- */}
      <section className="rounded-lg border border-dashed border-border bg-background/40 px-5 py-4">
        <p className="text-[13px] leading-relaxed text-foreground">
          <span className="font-medium">在下方对话框里直接说明需求</span>，
          <span className="font-semibold" style={{ color: ACCENT }}>
            小规
          </span>
          会围绕当前项目和会话协助整理、起草与分析。需要选择资料、确认范围或展示结果时，
          界面会出现卡片或对话框，由你决定是否继续。
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-foreground/90">
          当前已接入的专用文档能力：根据 DOCX 模板和 JSON 数据另存一份新文档；
          生成前会请你确认，原文件不会被修改。
        </p>
        <p className="mt-2 text-[11px] text-muted-foreground/80">
          这项能力目前仍需点击输入框旁的文档按钮；自然语言调度接通后将移除这个过渡入口。
        </p>
      </section>

      {/* ---- 示例提示词 ---- */}
      <div className="mb-1 mt-6 flex items-baseline justify-between">
        <h2 className="text-[12px] font-semibold text-foreground">试试这样说</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70">
          examples
        </span>
      </div>
      <ul className="grid gap-2 sm:grid-cols-3">
        {EXAMPLE_PROMPTS.map((ex) => (
          <li
            key={ex.title}
            className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-background/40 px-3 py-2.5"
          >
            <span
              className="w-fit rounded border px-1.5 py-px font-mono text-[10px] font-bold tracking-wider"
              style={{ color: ACCENT, borderColor: `${ACCENT}55` }}
            >
              {ex.title}
            </span>
            <span className="text-[12px] leading-relaxed text-muted-foreground">
              {ex.prompt}
            </span>
          </li>
        ))}
      </ul>

      {/* ---- 尾注 ---- */}
      <footer className="mt-6 border-t border-dashed border-border/70 pt-2 font-mono text-[10px] text-muted-foreground">
        自然语言是主入口；专用能力以实际接入状态为准。
      </footer>
    </div>
  )
}
