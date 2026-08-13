import { ipcClient } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'
import { materializePendingNewSession } from '@renderer/lib/new-session'
import { beginSessionNavigation } from '@renderer/lib/session-navigation'

export function titleFromFirstMessage(text: string, maxLen = 48): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (!one) return 'New chat'
  return one.length > maxLen ? `${one.slice(0, maxLen)}…` : one
}

/** 临时对话首条消息：建 sandbox → 打开工作区 → 真 session（标题=首条消息） */
export async function finalizeEphemeralSandboxOnFirstSend(firstMessage: string): Promise<string> {
  const store = useUIStore.getState()
  if (!store.ephemeralSandboxDraft) {
    throw new Error('Not in ephemeral sandbox draft')
  }
  const label = titleFromFirstMessage(firstMessage)
  const res = await ipcClient.invoke('workspace.sandbox.create', { label })
  const box = res?.sandbox as { path: string; label: string } | undefined
  if (!box?.path) throw new Error('sandbox.create failed')
  // 小规：主进程已在创建处按当前模式打标签；立即回填渲染层本地缓存，
  // 否则侧栏过滤会把新临时对话按"历史=WORK"兜底（当前模式下不可见）
  void import('@renderer/xiaogui/lib/mode-scope').then((m) => m.rememberSandboxScope(box.path))

  store.clearEphemeralSandboxDraft()
  beginSessionNavigation()
  // 不阻塞等 Worker init；乐观 UI 已展示，prompt.send 前 materialize 会 session.new
  const already = useUIStore.getState().currentWorkspace === box.path
  if (!already) {
    void ipcClient.invoke('workspace.open', { path: box.path }).catch((e) => console.error(e))
  }
  store.setWorkspace(box.path)

  await materializePendingNewSession(box.path, firstMessage)

  window.dispatchEvent(new Event('pi-desktop:sandboxes-changed'))
  return box.path
}