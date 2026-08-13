/**
 * 小规包装组件：给上游 ProjectSidebar 挂上「一级模式作用域过滤」。
 *
 * 上游会话/项目数据一律不改；过滤发生在渲染前（可选 projectFilter /
 * sessionFilter prop 注入）。过滤实现全部在小规层（xiaogui/lib/mode-scope），
 * 查不到映射的旧记录 = 历史数据，一律按 WORK 处理（仅 WORK 模式可见）。
 */

import { useEffect, useMemo } from 'react'

import { ProjectSidebar } from '@renderer/features/workspace/project-sidebar'
import { normalizeSessionFileKey } from '@renderer/lib/session-file-key'

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
  const mode = useXiaoguiStore((s) => s.mode)
  const sessionModeMap = useModeScopeStore((s) => s.sessionModeMap)
  const projectModeMap = useModeScopeStore((s) => s.projectModeMap)

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

  // 项目过滤（含临时对话 sandbox 工作区）：同上
  const projectFilter = useMemo(
    () => (path: string) => {
      const key = normalizeSessionFileKey(path)
      if (!key) return mode === 'WORK'
      return (projectModeMap[key] ?? 'WORK') === mode
    },
    [projectModeMap, mode],
  )

  return <ProjectSidebar {...props} projectFilter={projectFilter} sessionFilter={sessionFilter} />
}
