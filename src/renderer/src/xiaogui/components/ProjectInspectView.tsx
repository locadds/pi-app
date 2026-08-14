/**
 * DESIGN 模式首屏视图（小规 Agent · 极简对话式入口）。
 *
 * 定位：打开即输入框——首屏主体是底部常驻的 Composer 输入框
 * （由 app.tsx 的 ComposerDock 始终渲染），本视图只提供居中的极简引导。
 * 项目检查等 design.* 能力通过对话触发，不在首屏展示表单与检查单。
 *
 * 项目归属：用户从首屏明确选择打开项目目录时（意图明确），
 * 在 activateWorkspace 成功后显式重归属为当前模式（见 mode-scope 的
 * setProjectModeToCurrent）。
 *
 * 仅在 DESIGN 模式下呈现；其他模式渲染占位提示。
 */

import { activateWorkspace } from '@renderer/lib/activate-workspace'
import { useUIStore } from '@renderer/stores/ui-store'

import { setProjectModeToCurrent } from '../lib/mode-scope'
import { useXiaoguiStore } from '../stores/xiaogui-store'

export function ProjectInspectView() {
  const mode = useXiaoguiStore((s) => s.mode)
  const currentWorkspace = useUIStore((s) => s.currentWorkspace)

  if (mode !== 'DESIGN') {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        <p className="max-w-[26rem] leading-relaxed">
          规划首屏仅在 <span className="font-semibold text-foreground">DESIGN｜规划设计</span>{' '}
          模式下呈现，请先切换模式。
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/60">
          design · pi runtime
        </p>
        <h1 className="mt-3 text-xl font-semibold text-foreground">规划设计</h1>

        {currentWorkspace ? (
          <p className="mt-8 text-[13px] leading-relaxed text-muted-foreground">
            当前项目
            <span className="mx-1 font-medium text-foreground">
              {projectName(currentWorkspace)}
            </span>
            ，在下方描述你想了解的项目情况。
          </p>
        ) : (
          <p className="mt-8 text-[12px] text-muted-foreground/70">
            先
            <button
              type="button"
              onClick={() => void openProjectDirectory()}
              className="mx-0.5 underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
            >
              打开项目文件夹
            </button>
            ，再描述你想了解的项目情况
          </p>
        )}
      </div>
    </div>
  )
}

/** 从路径提取项目（目录）名。 */
function projectName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

/** 打开项目流程：目录对话框 → activateWorkspace → 显式重归属为当前模式（DESIGN）。 */
async function openProjectDirectory(): Promise<void> {
  if (!window.piDesktop) {
    console.error('piDesktop not available')
    return
  }
  try {
    const res = await window.piDesktop.invoke('ipc:dialog:openDirectory')
    if (res?.path) {
      await activateWorkspace(res.path, { preferHome: true })
      // 用户明确选择打开该项目 = 意图明确：归属重设为当前模式（不带 ifAbsent）
      await setProjectModeToCurrent(res.path)
    }
  } catch (e) {
    console.error('[ProjectInspectView] Failed to open project:', e)
  }
}
