import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'

export interface DirectExtensionUIResponse {
  id: string
  cancelled?: boolean
  result?: unknown
}

interface DirectPending {
  resolve: (response: DirectExtensionUIResponse) => void
  cleanup: () => void
}

const pending = new Map<string, DirectPending>()

/** 主进程领域动作借用既有 Extension UI 宿主，不需要先制造一次模型工具调用。 */
export function requestDirectExtensionUI(
  win: BrowserWindow,
  request: Record<string, unknown>,
): Promise<DirectExtensionUIResponse> {
  const id = `xiaogui-direct-${randomUUID()}`
  return new Promise((resolve) => {
    const onClosed = () => finish({ id, cancelled: true })
    const cleanup = () => {
      pending.delete(id)
      win.removeListener('closed', onClosed)
    }
    const finish = (response: DirectExtensionUIResponse) => {
      const active = pending.get(id)
      if (!active) return
      active.cleanup()
      resolve(response)
    }

    pending.set(id, { resolve: finish, cleanup })
    win.once('closed', onClosed)
    if (win.isDestroyed()) {
      finish({ id, cancelled: true })
      return
    }
    win.webContents.send('ipc:extension-ui-request', {
      ...request,
      id,
      origin: 'xiaogui-direct',
    })
  })
}

export function respondDirectExtensionUI(response: DirectExtensionUIResponse): boolean {
  const current = pending.get(response.id)
  if (!current) return false
  current.resolve(response)
  return true
}

export function cancelDirectExtensionUI(id: string | undefined): boolean {
  if (!id) return false
  const current = pending.get(id)
  if (!current) return false
  current.resolve({ id, cancelled: true })
  return true
}

export const __test = {
  pendingCount: () => pending.size,
}
