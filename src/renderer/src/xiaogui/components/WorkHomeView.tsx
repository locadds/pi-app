/**
 * WORK 模式首屏视图（小规 Agent · WORK 模式专用）。
 *
 * 定位：轻量引导面板——说明 WORK 模式用途，引导用户直接使用常驻对话框
 * 让小规帮忙整理文件、撰写文本报告，并通过工具栏触发已接入的具体工具。
 * 不引入额外依赖，不宣称未安装的第三方能力。
 *
 * 仅在 WORK 模式下呈现；其他模式渲染占位提示（与 ProjectInspectView 一致）。
 */

import { useXiaoguiStore } from '../stores/xiaogui-store'

/** 朱砂红——与 ModeSelector / ProjectInspectView 保持同一强调色。 */
const ACCENT = '#c0392b'

/** 示例提示词：全部基于 Pi 原生对话能力和已接入的小规工具。 */
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

      {/* ---- 用途说明（虚线测量框，与 DESIGN 视图同一观感） ---- */}
      <section className="rounded-lg border border-dashed border-border bg-background/40 px-5 py-4">
        <p className="text-[13px] leading-relaxed text-foreground">
          <span className="font-semibold" style={{ color: ACCENT }}>
            小规
          </span>
          可以陪你处理日常工作。整理资料、起草报告等轻量任务，
          <span className="font-medium">直接在下方对话框里说明需求即可</span>。
        </p>
        <p className="mt-2 text-[11px] text-muted-foreground/80">
          需要从 DOCX 模板生成新文档时，请先进入或新建 WORK 会话，再点击页面底部输入框旁的文档按钮；
          小规会让你选择文件并在生成前再次确认。
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
        以上能力优先复用 Pi 原生对话能力和已接入的小规工具。
      </footer>
    </div>
  )
}
