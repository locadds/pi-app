import { registerHandler } from '../registry'
import { workerManager } from '../../worker-manager'
import { configStore } from '../../config-store'
import {
  cancelDirectExtensionUI,
  respondDirectExtensionUI,
} from '../../direct-extension-ui'

export function registerExtensionUiHandlers(): void {
  registerHandler('ipc:extension.respondUI', async (req) => {
    if (!respondDirectExtensionUI(req)) workerManager.respondExtensionUI(req)
    return { ok: true }
  })

  registerHandler('ipc:extension.cancelUI', async (req) => {
    if (!cancelDirectExtensionUI(req.id)) {
      workerManager.cancelExtensionUI(req.id, req.reason ?? 'renderer-cancel')
    }
    return { ok: true }
  })

  registerHandler('ipc:extension.config.get', async (req) => {
    const workspaceId = req.workspaceId || workerManager.cwd || configStore.get('currentProject') || ''
    return { config: configStore.getExtensionConfig(workspaceId, req.extensionId) || {} }
  })

  registerHandler('ipc:extension.config.set', async (req) => {
    const workspaceId = req.workspaceId || workerManager.cwd || configStore.get('currentProject') || ''
    configStore.setExtensionConfig(workspaceId, req.extensionId, req.config || {})
    return { ok: true }
  })
}
