import type { CanonicalSessionAddressScopeV1 } from '@shared/xiaogui-session-scope'

import { ipcClient } from '@renderer/lib/ipc-client'

import { useXiaoguiStore, type XiaoguiMode } from '../stores/xiaogui-store'

/**
 * Verify the main-process-owned address immediately before opening a session,
 * then synchronize the runtime and renderer mode without navigating to a home
 * screen. The renderer never derives an identity or submits a filesystem path.
 */
export async function prepareCanonicalSessionOpen(
  expected: CanonicalSessionAddressScopeV1,
): Promise<CanonicalSessionAddressScopeV1> {
  const result = await ipcClient.invoke('xiaogui.scope.lookup', {
    projectId: expected.projectId,
    sessionKey: expected.sessionKey,
  })

  if (result?.kind !== 'FOUND' || !result.scope) {
    throw new Error(`canonical_session_scope_${String(result?.kind ?? 'NOT_FOUND').toLowerCase()}`)
  }

  const canonical = result.scope as CanonicalSessionAddressScopeV1
  const switched = await ipcClient.invoke('xiaogui.mode.switch', {
    mode: canonical.sessionMode,
  })
  const mode = switched?.mode as XiaoguiMode | undefined
  if (mode !== canonical.sessionMode) {
    throw new Error('canonical_session_mode_switch_failed')
  }

  useXiaoguiStore.setState({ mode })
  return canonical
}
