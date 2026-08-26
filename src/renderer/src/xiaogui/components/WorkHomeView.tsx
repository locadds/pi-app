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

import { useUIStore } from '@renderer/stores/ui-store'
import { useXiaoguiStore } from '../stores/xiaogui-store'

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
    prompt: '按我选择的 Word 模板，根据刚才的资料生成新文档，先把要填的内容列给我确认',
  },
  {
    title: '整理普通 Word',
    prompt: '把我选择的普通成品 Word 整理成可复用模板，先给我一份候选内容报告',
  },
]

export function WorkHomeView() {
  const mode = useXiaoguiStore((s) => s.mode)
  const setComposerPrefill = useUIStore((s) => s.setComposerPrefill)

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
      <header>
        <h1 className="text-lg font-semibold text-foreground">工作台</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">
          直接告诉小规你想完成什么，或选择一个示例开始。
        </p>
      </header>

      <div className="mb-2 mt-6">
        <h2 className="text-[12px] font-semibold text-foreground">试试这样说</h2>
      </div>
      <ul className="flex flex-wrap gap-x-6 gap-y-2">
        {EXAMPLE_PROMPTS.map((ex) => (
          <li key={ex.title}>
            <button
              type="button"
              aria-label={`填写示例提示词：${ex.title}`}
              title={ex.prompt}
              onClick={() => setComposerPrefill(ex.prompt)}
              className="text-[12px] font-medium underline decoration-current/35 underline-offset-4 transition-colors hover:decoration-current focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              style={{ color: ACCENT }}
            >
              {ex.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
