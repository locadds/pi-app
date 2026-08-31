import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'

export interface DirectExtensionUIResponse {
  id: string
  cancelled?: boolean
  reason?: 'timeout'
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
  options: { timeoutMs?: number } = {},
): Promise<DirectExtensionUIResponse> {
  const id = `xiaogui-direct-${randomUUID()}`
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const onClosed = () => finish({ id, cancelled: true })
    const cleanup = () => {
      pending.delete(id)
      win.removeListener('closed', onClosed)
      if (timeout) clearTimeout(timeout)
    }
    const finish = (response: DirectExtensionUIResponse) => {
      const active = pending.get(id)
      if (!active) return
      const shouldDismiss = response.reason === 'timeout' && !win.isDestroyed()
      active.cleanup()
      if (shouldDismiss) {
        try {
          win.webContents.send('ipc:extension-ui-dismiss', {
            type: 'extension-ui-dismiss',
            id,
            reason: 'timeout',
          })
        } catch {
          // Renderer may disappear between the destroyed check and send; cleanup already ran.
        }
      }
      resolve(response)
    }

    pending.set(id, { resolve: finish, cleanup })
    win.once('closed', onClosed)
    if (win.isDestroyed()) {
      finish({ id, cancelled: true })
      return
    }
    if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
      timeout = setTimeout(() => finish({ id, cancelled: true, reason: 'timeout' }), options.timeoutMs)
    }
    try {
      win.webContents.send('ipc:extension-ui-request', {
        ...request,
        id,
        origin: 'xiaogui-direct',
      })
    } catch {
      finish({ id, cancelled: true })
    }
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

export function hasPendingDirectExtensionUI(): boolean {
  return pending.size > 0
}

export const __test = {
  pendingCount: () => pending.size,
}
