/**
 * CODING 模式首屏视图（小规 Agent · Claude Code 形态极简入口）。
 *
 * 定位：打开即输入框——首屏主体是底部常驻的 Composer 输入框
 * （由 app.tsx 的 ComposerDock 始终渲染），本视图只提供居中的极简引导。
 * 企业安全护栏在后台静默工作（refreshGuardStatus 保留），不在首屏展示。
 * 仅在 CODING 模式下呈现；其他模式渲染占位提示。
 */

import { useEffect } from 'react'

import { activateWorkspace } from '@renderer/lib/activate-workspace'
import { useUIStore } from '@renderer/stores/ui-store'

import { useXiaoguiStore } from '../stores/xiaogui-store'

export function CodingHomeView() {
  const mode = useXiaoguiStore((s) => s.mode)
  const refreshGuardStatus = useXiaoguiStore((s) => s.refreshGuardStatus)
  const currentWorkspace = useUIStore((s) => s.currentWorkspace)

  // 安全护栏状态后台运行：挂载时（以及切换项目后）拉取一次，UI 无感知
  useEffect(() => {
    void refreshGuardStatus(currentWorkspace ?? undefined)
  }, [refreshGuardStatus, currentWorkspace])

  if (mode !== 'CODING') {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        <p className="max-w-[26rem] leading-relaxed">
          编程首屏仅在 <span className="font-semibold text-foreground">CODING｜编程</span> 模式下呈现，请先切换模式。
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/60">coding · xiaogui</p>
        <h1 className="mt-3 text-xl font-semibold text-foreground">编程模式</h1>
        <p className="mt-1 text-[12px] text-muted-foreground">小规编程执行环境</p>
        <p className="mt-1 text-[12px] text-muted-foreground">开始前会先确认任务和文件范围，完成后由你审阅，再决定是否应用到项目。</p>

        {currentWorkspace ? (
          <p className="mt-8 text-[13px] leading-relaxed text-muted-foreground">
            当前项目
            <span className="mx-1 font-medium text-foreground">{projectName(currentWorkspace)}</span>
            ，在下方输入任务即可开始编程。
          </p>
        ) : (
          <div className="mt-8 space-y-1.5">
            <p className="text-[13px] text-muted-foreground">在下方输入编程任务即可开始</p>
            <p className="text-[12px] text-muted-foreground/70">
              也可以先
              <button
                type="button"
                onClick={() => void openProjectDirectory()}
                className="mx-0.5 underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
              >
                打开项目文件夹
              </button>
              再开始
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/** 从路径提取项目（目录）名。 */
function projectName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  )
}

/** 项目跨模式共享；打开目录不改变任何会话归属。 */
async function openProjectDirectory(): Promise<void> {
  if (!window.piDesktop) {
    console.error('piDesktop not available')
    return
  }
  try {
    const res = await window.piDesktop.invoke('ipc:dialog:openDirectory')
    if (res?.path) {
      await activateWorkspace(res.path, { preferHome: true })
    }
  } catch (e) {
    console.error('[CodingHomeView] Failed to open project:', e)
  }
}
