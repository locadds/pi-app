/**
 * Composer 工具栏「协作计划」入口按钮。
 *
 * 点击后打开现有右栏的「协作」Tab（不新增页面/路由）。
 * 当前会话没有 canonicalScope 时禁用，并提示“请先进入已建立的会话”。
 */

import { Network } from '@renderer/components/icons'
import { useUIStore } from '@renderer/stores/ui-store'

const PANEL_ID = 'collaboration'

export function ComposerCollaborationButton() {
  const currentSessionId = useUIStore((s) => s.currentSessionId)
  const sessions = useUIStore((s) => s.sessions)
  const enabled = useUIStore((s) => s.rightPanelPrefs[PANEL_ID] ?? false)

  const hasCanonicalScope = sessions.some((s) => s.sessionId === currentSessionId && s.canonicalScope)

  // 用户在右栏设置中显式关闭该核心面板时，不改变原生 Composer 布局。
  if (!enabled) return null

  const openCollaborationPanel = () => {
    const state = useUIStore.getState()
    state.setActivePanel(PANEL_ID)
    state.revealRightPanel()
  }

  return (
    <button
      type="button"
      disabled={!hasCanonicalScope}
      title={hasCanonicalScope ? '协作计划' : '请先进入已建立的会话'}
      aria-label="协作计划"
      onClick={openCollaborationPanel}
      className="composer-toolbar-btn flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground-secondary/70 disabled:opacity-30"
    >
      <Network className="h-[15px] w-[15px]" strokeWidth={2} />
    </button>
  )
}
