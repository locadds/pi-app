/**
 * 小规「回到当前模式首屏」公共动作（任务 #34）。
 *
 * 模式切换（xiaogui-store.switchMode）与侧栏「新建对话」按钮共用：
 * 清空当前视图绑定的会话/时间线，让 app.tsx 的 showHome 判定为 true，
 * 渲染目标模式的 Home View（WorkHomeView / CodingHomeView / ProjectInspectView）。
 *
 * 约束：
 * - 只清渲染层显示状态，后台会话继续运行，绝不 abort/terminate；
 *   清屏后 historySessionFile=null + currentSessionId=null，
 *   apply-app-event-route 会把后续事件路由到 background 缓存，不会把视图拉回旧会话。
 * - 用户之后点击侧栏任一会话仍可正常打开（走 switchSessionInPlace）。
 */

import { refreshComposerRunDisplay } from '@renderer/lib/composer-run-display'
import { beginSessionNavigation } from '@renderer/lib/session-navigation'
import { useExtensionUIStore } from '@renderer/stores/extension-ui-store'
import { useUIStore } from '@renderer/stores/ui-store'

export function navigateToModeHome(): void {
  // 推进导航代数：让上一个会话切换中尚未落地的异步结果失效，
  // 避免清屏后被过期回调重新写回（与 activateWorkspace 同一套令牌机制）。
  beginSessionNavigation()

  const store = useUIStore.getState()
  if (store.ephemeralSandboxDraft) store.clearEphemeralSandboxDraft()
  store.clearPendingNewSessionPlaceholder()
  useExtensionUIStore.getState().resetForSessionContext()
  store.setCurrentSession(null)
  store.setWorkerLiveSnapshot({ sessionId: null, sessionFile: null, status: 'idle' })
  store.clearTimeline()
  store.clearFileChanges()
  store.setHistoryMeta(0, 0, null)
  store.setHistoryLoading(false)
  store.setSubagentSessionGroup(null)
  void refreshComposerRunDisplay()
}
