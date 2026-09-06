import { invalidateAdapterCatalog } from '../../../extension-compat/adapter-loader'
import { configStore } from '../../config-store'
import { sqliteIndex } from '../../sqlite-index'
import { workerManager } from '../../worker-manager'
import {
  bindSandboxSession,
  createSandboxWorkspace,
  deleteSandboxWorkspace,
  isSandboxWorkspacePath,
  listSandboxWorkspaces,
  renameSandboxWorkspace,
} from '../../sandbox-workspaces'
import { sessionPreviewProcess } from '../../session-preview-process'
import { registerHandler, registerHandlerWithSchema } from '../registry'
import { workspaceOpenSchema, workspaceSandboxDeleteSchema } from '../schemas'
import { xiaogui } from '../../xiaogui/sidecar-bridge'
import { getScope, setScope } from '../../xiaogui/scope-store'
import { ensureDesignExtensionDeployed } from '../../xiaogui/design-extension-deploy'
import { errorMessage } from '@shared/error-message'
import { getMainWindow } from '../../window'
import { refreshGitWorkspaceWatch } from '../../git-workspace-watch'
import { trustedSessionAccessV1 } from '../../trusted-session-access'
import { registerTrustedProjectRoot } from '../../trusted-workspace'

export function registerWorkspaceHandlers(): void {
  registerHandler('ipc:workspace.ensureWorker', async (req) => {
    const requestedPath = String(req?.path || '').trim()
    if (!requestedPath) return { ok: false, workspaceId: '', error: 'missing path' }
    let project
    try {
      project = trustedSessionAccessV1.project({ workspaceId: requestedPath })
    } catch (e: unknown) {
      return { ok: false, workspaceId: '', error: errorMessage(e) }
    }
    const path = project.authorizedRoot
    configStore.set('currentProject', path)
    // 小规：DESIGN 项目启动 worker 前确保扩展已部署（幂等；失败不阻塞启动）
    if (getScope('project', path) === 'DESIGN') {
      await ensureDesignExtensionDeployed(path).catch(() => {})
    }
    try {
      const r = await workerManager.start(project.binding)
      refreshGitWorkspaceWatch(getMainWindow())
      return { ok: true, workspaceId: path, sessionId: r.sessionId, model: r.model }
    } catch (e: unknown) {
      return { ok: false, workspaceId: path, error: errorMessage(e) || 'Worker start failed' }
    }
  })

  registerHandlerWithSchema('ipc:workspace.open', workspaceOpenSchema, async (req) => {
    const project = trustedSessionAccessV1.project({ workspaceId: req.path })
    const path = project.authorizedRoot
    const name = path.split(/[\\/]/).pop() || path
    invalidateAdapterCatalog()
    configStore.addRecentProject(path)
    configStore.set('currentProject', path)
    try {
      sqliteIndex.upsertWorkspace(path, name, path)
    } catch (e) {
      console.warn('[IPC] workspace index skipped (sqlite):', (e as Error).message)
    }
    // awaitWorker true: block until Worker is ready (legacy / explicit).
    // awaitWorker false / omitted: register project only; Worker starts on first
    // Worker-required action (prompt / session.new / ensureWorker).
    if (req.awaitWorker === true) {
      try {
        await workerManager.start(project.binding)
        refreshGitWorkspaceWatch(getMainWindow())
      } catch (e) {
        console.error('[IPC] Worker start failed:', e)
        throw e
      }
    } else {
      refreshGitWorkspaceWatch(getMainWindow())
    }
    return { workspaceId: path, path, name }
  })

  registerHandler('ipc:workspace.switch', async (req) => {
    const project = trustedSessionAccessV1.project({ workspaceId: req.workspaceId })
    const workspaceId = project.authorizedRoot
    if (getScope('project', workspaceId) === 'DESIGN') {
      await ensureDesignExtensionDeployed(workspaceId).catch(() => {})
    }
    configStore.set('currentProject', workspaceId)
    const result = await workerManager.start(project.binding)
    refreshGitWorkspaceWatch(getMainWindow())
    return {
      workspaceId,
      path: workspaceId,
      name: workspaceId.split(/[\\/]/).pop(),
      ...result,
    }
  })

  registerHandler('ipc:workspace.sandbox.create', async (req) => {
    const created = createSandboxWorkspace(req.label)
    const registered = registerTrustedProjectRoot(created.path, 'MANAGED_SANDBOX')
    if (!registered.ok) throw new Error(registered.error)
    const box = { ...created, path: registered.cwd }
    // 小规：sandbox 在创建处直接按当前模式打标签（主进程裁决，无渲染层轮询
    // 竞态）；失败不影响创建本身。标签缺失时渲染层按历史数据归 WORK。
    try {
      setScope('project', box.path, xiaogui.getMode())
    } catch (e) {
      console.warn('[xiaogui] sandbox scope 打标签失败:', e)
    }
    return { sandbox: { ...box, kind: 'sandbox' as const } }
  })

  registerHandler('ipc:workspace.sandbox.list', async () => {
    const sandboxes = (
      await Promise.all(
        listSandboxWorkspaces().map(async (sandbox) => {
          const registered = registerTrustedProjectRoot(sandbox.path, 'MANAGED_SANDBOX')
          if (!registered.ok) return null
          const s = { ...sandbox, path: registered.cwd }
          if (!s.sessionId || !s.sessionFile) {
            const latest = (await sessionPreviewProcess.listSessions(s.path).catch(() => []))[0]
            if (latest?.id && latest.path) {
              s.sessionId = latest.id
              s.sessionFile = latest.path
              bindSandboxSession(s.path, latest.id, latest.path)
            }
          }
          return s.sessionId && s.sessionFile ? { ...s, kind: 'sandbox' as const } : null
        }),
      )
    ).filter(Boolean)
    return { sandboxes }
  })

  registerHandler('ipc:workspace.sandbox.rename', async (req) => {
    return { ok: renameSandboxWorkspace(req.path, req.label || '') }
  })

  registerHandlerWithSchema('ipc:workspace.sandbox.delete', workspaceSandboxDeleteSchema, async (req) => {
    return { ok: deleteSandboxWorkspace(req.path) }
  })

  registerHandler('ipc:workspace.isSandbox', async (req) => {
    return { sandbox: isSandboxWorkspacePath(req.path || '') }
  })
}
