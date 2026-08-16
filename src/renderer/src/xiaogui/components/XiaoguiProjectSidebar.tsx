/** 小规包装：项目共享；会话只按主进程签发的规范作用域分组。 */

import { useMemo } from 'react'

import { useTranslation } from 'react-i18next'

// 图标必须经上游图标基础设施引用（契约：lucide-react 等三方库只允许出现在 components/icons 内）
import { Plus } from '@renderer/components/icons'
import { ProjectSidebar } from '@renderer/features/workspace/project-sidebar'
import type { ProjectSessionDisplayStrategy, SessionItem } from '@renderer/features/workspace/project-sidebar-types'
import { useUIStore } from '@renderer/stores/ui-store'

import { groupCanonicalSessionsByMode } from '../lib/canonical-session-display'
import { prepareCanonicalSessionOpen } from '../lib/canonical-session-open'
import { navigateToModeHome } from '../lib/navigate-mode-home'

export function XiaoguiProjectSidebar(props: { onOpenProject: () => void; openProjectLabel: string }) {
  const { t } = useTranslation()
  const collapsed = useUIStore((s) => s.sidebarCollapsed)
  const sessionDisplayStrategy = useMemo<ProjectSessionDisplayStrategy>(
    () => ({
      projectSessions: (sessions) => {
        const canonical = sessions.flatMap((session) =>
          session.canonicalScope ? [{ item: session, scope: session.canonicalScope }] : [],
        )
        const grouped = groupCanonicalSessionsByMode(canonical)
        const displayed = grouped.flatMap((group) =>
          group.items.map((session, index) => ({
            session,
            groupKey: group.key,
            groupLabel: index === 0 ? group.label : undefined,
          })),
        )

        // Missing scope is an exceptional partial-upgrade state. Keep the row
        // visible, but beforeOpenSession below refuses to infer a mode for it.
        const unresolved = sessions
          .filter((session) => !session.canonicalScope)
          .map((session: SessionItem) => ({ session }))
        return [...displayed, ...unresolved]
      },
      beforeOpenSession: async (session) => {
        if (!session.canonicalScope) throw new Error('canonical_session_scope_missing')
        await prepareCanonicalSessionOpen(session.canonicalScope)
      },
    }),
    [],
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
      <ProjectSidebar {...props} sessionDisplayStrategy={sessionDisplayStrategy} />
    </>
  )
}
