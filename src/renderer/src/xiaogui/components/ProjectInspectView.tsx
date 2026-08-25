/**
 * DESIGN 模式首屏视图（小规 Agent · 极简对话式入口）。
 *
 * 定位：只展示研究阶段的预留说明，不对用户暗示已具备可执行的
 * design.* 能力，也不提供动作按钮。
 * 仅在 DESIGN 模式下呈现；其他模式渲染占位提示。
 */

import { useXiaoguiStore } from '../stores/xiaogui-store'

export function ProjectInspectView() {
  const mode = useXiaoguiStore((s) => s.mode)
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
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/60">design · xiaogui</p>
        <h1 className="mt-3 text-xl font-semibold text-foreground">规划设计</h1>
        <p className="mt-1 text-[12px] text-muted-foreground">接口已预留，功能仍在研究和能力边界确认中</p>
        <p className="mt-8 text-[13px] leading-relaxed text-muted-foreground">
          当前不执行规划设计任务。日常文档工作请使用
          <span className="mx-1 font-semibold text-foreground">WORK</span>
          ，编程与多 Agent 协作请使用
          <span className="mx-1 font-semibold text-foreground">CODING</span>。
        </p>
      </div>
    </div>
  )
}
