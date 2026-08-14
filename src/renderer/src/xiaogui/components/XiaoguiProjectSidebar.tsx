/**
 * 小规包装组件：给上游 ProjectSidebar 挂上「一级模式作用域过滤」。
 *
 * 上游会话/项目数据一律不改；过滤发生在渲染前（可选 projectFilter /
 * sessionFilter prop 注入）。过滤实现全部在小规层（xiaogui/lib/mode-scope），
 * 查不到映射的旧记录 = 历史数据，一律按 WORK 处理（仅 WORK 模式可见）。
 */

import { useEffect, useMemo } from 'react'

import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'

import { ProjectSidebar } from '@renderer/features/workspace/project-sidebar'
import { normalizeSessionFileKey } from '@renderer/lib/session-file-key'
import { useUIStore } from '@renderer/stores/ui-store'

import { navigateToModeHome } from '../lib/navigate-mode-home'

import {
  refreshModeScope,
  startProjectBaselineWatcher,
  useModeScopeStore,
} from '../lib/mode-scope'
import { useXiaoguiStore } from '../stores/xiaogui-store'

export function XiaoguiProjectSidebar(props: {
  onOpenProject: () => void
  openProjectLabel: string
}) {
  const { t } = useTranslation()
  const collapsed = useUIStore((s) => s.sidebarCollapsed)
  const mode = useXiaoguiStore((s) => s.mode)
  const sessionModeMap = useModeScopeStore((s) => s.sessionModeMap)
  const projectModeMap = useModeScopeStore((s) => s.projectModeMap)
  const currentWorkspace = useUIStore((s) => s.currentWorkspace)

  // 当前活跃工作区的规范化 key（projectFilter 豁免用）
  const currentWorkspaceKey = useMemo(
    () => normalizeSessionFileKey(currentWorkspace),
    [currentWorkspace],
  )

  // 挂载时拉取 scope 映射一次，并上报项目基线 + 监听新增项目
  // （sandbox 的打标签裁决在主进程创建处完成，渲染层不再轮询）
  useEffect(() => {
    void refreshModeScope()
    return startProjectBaselineWatcher()
  }, [])

  // 会话过滤：映射缺失 = 历史数据 = WORK（仅 WORK 模式可见）
  const sessionFilter = useMemo(
    () => (sessionFile: string | undefined) => {
      const key = normalizeSessionFileKey(sessionFile)
      if (!key) return mode === 'WORK'
      return (sessionModeMap[key] ?? 'WORK') === mode
    },
    [sessionModeMap, mode],
  )

  // 项目过滤（含临时对话 sandbox 工作区）：同上。
  // 豁免：当前活跃工作区始终显示——用户已明确打开/正在使用，
  // 不因模式归属把整个项目藏掉（修复 CODING 打开 DESIGN 归属项目后侧栏不显示的问题）。
  const projectFilter = useMemo(
    () => (path: string) => {
      const key = normalizeSessionFileKey(path)
      if (!key) return mode === 'WORK'
      if (currentWorkspaceKey && key === currentWorkspaceKey) return true
      return (projectModeMap[key] ?? 'WORK') === mode
    },
    [projectModeMap, mode, currentWorkspaceKey],
  )

  // 「新建对话」按钮（任务 #34）：位于「打开文件夹」上方，
  // 点击 = 回到当前模式首屏（与模式切换同一底层动作 navigateToModeHome）。
  const newChatButton = collapsed ? (
    <div className="flex flex-col items-center pt-1">
      <button
        type="button"
        onClick={() => navigateToModeHome()}
        title={t('common:sidebar.startNewChat')}
        className="chrome-icon-btn flex h-8 w-8 items-center justify-center rounded-lg"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  ) : (
    <div className="px-2 pt-2">
      <button
        type="button"
        onClick={() => navigateToModeHome()}
        className="nav-row row-hover flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border/50 px-3 py-2.5 text-[13px] font-medium text-foreground-secondary hover:text-foreground"
      >
        <Plus className="h-4 w-4 shrink-0" />
        {t('common:sidebar.startNewChat')}
      </button>
    </div>
  )

  return (
    <>
      {newChatButton}
      <ProjectSidebar {...props} projectFilter={projectFilter} sessionFilter={sessionFilter} />
    </>
  )
}
