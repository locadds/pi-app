/**
 * WORK 模式首屏视图（小规 Agent · WORK 模式专用）。
 *
 * 定位：轻量业务入口。三个快捷项负责完成必要的本机选择，再把自然语言请求
 * 交给常驻 Composer；后续分析仍由 WORK 会话及其受控工具完成。
 *
 * 仅在 WORK 模式下呈现；其他模式渲染占位提示（与 ProjectInspectView 一致）。
 */

import { useState } from 'react'
import { activateWorkspace } from '@renderer/lib/activate-workspace'
import { submitComposerPrompt } from '@renderer/lib/composer-quick-submit'
import { ipcClient } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'
import { useXiaoguiStore } from '../stores/xiaogui-store'
import { TemplateLibraryView } from './TemplateLibraryView'

/** 朱砂红——与 ModeSelector / ProjectInspectView 保持同一强调色。 */
const ACCENT = '#c0392b'

type QuickActionId = 'FOLDER' | 'DOCUMENT' | 'TEMPLATE'

const QUICK_ACTIONS: { id: QuickActionId; title: string; description: string; ariaLabel: string }[] = [
  {
    id: 'FOLDER',
    title: '整理资料',
    description: '选择文件夹后，读取所有类型并整理归纳',
    ariaLabel: '选择文件夹并整理资料',
  },
  {
    id: 'DOCUMENT',
    title: '整理普通文档',
    description: '选择 DOC 或 DOCX，开始只读分析和模板整理',
    ariaLabel: '选择普通文档并开始分析',
  },
  {
    id: 'TEMPLATE',
    title: '按模板生成',
    description: '从本机模板库选择历史模板和版本',
    ariaLabel: '从历史模板生成文档',
  },
]

function displayName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '所选资料'
}

async function ensureWorkWorkspace(label: string): Promise<string | null> {
  const state = useUIStore.getState()
  if (state.currentWorkspace) return state.currentWorkspace
  if (!state.ephemeralSandboxDraft) return null
  const response = await ipcClient.invoke('workspace.sandbox.create', { label }) as {
    sandbox?: { path?: string }
  }
  const path = response.sandbox?.path
  if (!path) return null
  await activateWorkspace(path, { preferHome: true })
  return path
}

export function WorkHomeView() {
  const mode = useXiaoguiStore((s) => s.mode)
  const [view, setView] = useState<'HOME' | 'TEMPLATE_LIBRARY'>('HOME')
  const [busyAction, setBusyAction] = useState<QuickActionId | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runQuickAction = async (action: QuickActionId) => {
    if (busyAction) return
    setBusyAction(action)
    setError(null)
    try {
      if (action === 'TEMPLATE') {
        setView('TEMPLATE_LIBRARY')
        return
      }
      if (action === 'FOLDER') {
        const selected = await ipcClient.invoke('dialog:openDirectory') as { path?: string | null }
        if (!selected.path) return
        await activateWorkspace(selected.path, { preferHome: true })
        submitComposerPrompt(
          `整理我刚选择的文件夹“${displayName(selected.path)}”（${selected.path}）。请读取其中所有类型的文件并形成完整资料总账：能提取内容的请结合正文归类和概括；暂时不能语义解析的格式也必须按路径、类型和大小列入清单，并明确标注正文未读取。不要再次让我选择文件。`,
        )
        return
      }
      const workspaceRoot = await ensureWorkWorkspace('普通文档整理')
      if (!workspaceRoot) {
        setError('请先新建对话或打开一个工作区，再选择普通文档。')
        return
      }
      const selected = await ipcClient.invoke('xiaogui.work.template-intake.source.choose', {
        workspaceRoot,
      }) as { cancelled?: boolean; fileDisplayName?: string }
      if (selected.cancelled || !selected.fileDisplayName) return
      submitComposerPrompt(
        `请使用普通文档模板整理能力，把我刚选择的普通成品文档“${selected.fileDisplayName}”整理成可复用模板。请立即开始只读分析并生成候选内容报告，不要再次让我选择文件；原文档不得修改。`,
      )
    } catch (reason) {
      console.error('[WorkHomeView] 快捷入口执行失败:', reason)
      setError('没有完成选择或启动，请重试。')
    } finally {
      setBusyAction(null)
    }
  }

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
        {QUICK_ACTIONS.map((action) => (
          <li key={action.id}>
            <button
              type="button"
              aria-label={action.ariaLabel}
              data-testid="work-quick-action"
              disabled={busyAction != null}
              onClick={() => void runQuickAction(action.id)}
              className="group flex h-full w-full flex-col gap-1.5 rounded-lg border border-border/70 bg-background/40 px-3 py-2.5 text-left transition-colors hover:border-foreground/30 hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span
                className="w-fit rounded border px-1.5 py-px font-mono text-[10px] font-bold tracking-wider"
                style={{ color: ACCENT, borderColor: `${ACCENT}55` }}
              >
                {action.title}
              </span>
              <span className="text-[12px] leading-relaxed text-muted-foreground transition-colors group-hover:text-foreground">
                {busyAction === action.id ? '正在打开…' : action.description}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {error && <p role="alert" className="mt-3 text-[11px] text-destructive">{error}</p>}

      <footer className="mt-6 border-t border-dashed border-border/70 pt-2 font-mono text-[10px] text-muted-foreground">
        自然语言是主入口；专用能力以实际接入状态为准。
      </footer>
    </div>
  )
}
