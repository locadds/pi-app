/**
 * WORK 模式首屏视图（小规 Agent · WORK 模式专用）。
 *
 * 定位：轻量引导面板——WORK 模式以自然语言对话为入口。用户在常驻对话框
 * 直接说明需求，由小规选择已接入的能力执行；需要选择资料、确认范围或
 * 展示结果时，界面才出现卡片或对话框。本页只说明用法，不提供直接执行任务的
 * 功能按钮，也不宣称未接入的能力。示例快捷项只把自然语言填入对话框。
 *
 * 仅在 WORK 模式下呈现；其他模式渲染占位提示（与 ProjectInspectView 一致）。
 */

import { useState } from 'react'
import { useUIStore } from '@renderer/stores/ui-store'
import { useXiaoguiStore } from '../stores/xiaogui-store'
import { TemplateLibraryView } from './TemplateLibraryView'

/** 朱砂红——与 ModeSelector / ProjectInspectView 保持同一强调色。 */
const ACCENT = '#c0392b'

/** 示例提示词：只覆盖当前对话能力，不暗示尚未接通的自然语言工具调用。 */
const EXAMPLE_PROMPTS: { title: string; prompt: string }[] = [
  {
    title: '整理资料',
    prompt: '帮我看看当前目录里有哪些文件，按类型归类列一份清单',
  },
  {
    title: '按模板生成',
    prompt: '按我选择的文档模板，根据刚才的资料生成新文档，先把要填的内容列给我确认',
  },
  {
    title: '整理普通文档',
    prompt: '把我选择的普通成品文档整理成可复用模板，先给我一份候选内容报告',
  },
]

export function WorkHomeView() {
  const mode = useXiaoguiStore((s) => s.mode)
  const setComposerPrefill = useUIStore((s) => s.setComposerPrefill)
  const [view, setView] = useState<'HOME' | 'TEMPLATE_LIBRARY'>('HOME')

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

  if (view === 'TEMPLATE_LIBRARY') {
    return <TemplateLibraryView onBack={() => setView('HOME')} />
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-5 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold text-foreground">工作台</h1>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          work · 日常工作
        </span>
        <button type="button" onClick={() => setView('TEMPLATE_LIBRARY')} className="ml-auto text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">模板库</button>
      </header>

      <div className="mb-1 mt-6 flex items-baseline justify-between">
        <h2 className="text-[12px] font-semibold text-foreground">试试这样说</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70">
          examples
        </span>
      </div>
      <ul className="grid gap-2 sm:grid-cols-3">
        {EXAMPLE_PROMPTS.map((ex) => (
          <li key={ex.title}>
            <button
              type="button"
              aria-label={`填写示例提示词：${ex.title}`}
              onClick={() => setComposerPrefill(ex.prompt)}
              className="group flex h-full w-full flex-col gap-1.5 rounded-lg border border-border/70 bg-background/40 px-3 py-2.5 text-left transition-colors hover:border-foreground/30 hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span
                className="w-fit rounded border px-1.5 py-px font-mono text-[10px] font-bold tracking-wider"
                style={{ color: ACCENT, borderColor: `${ACCENT}55` }}
              >
                {ex.title}
              </span>
              <span className="text-[12px] leading-relaxed text-muted-foreground transition-colors group-hover:text-foreground">
                {ex.prompt}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <footer className="mt-6 border-t border-dashed border-border/70 pt-2 font-mono text-[10px] text-muted-foreground">
        自然语言是主入口；专用能力以实际接入状态为准。
      </footer>
    </div>
  )
}
