import { ipcClient } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'
import { refreshComposerRunDisplay } from '@renderer/lib/composer-run-display'
import { resolveBootWorkspaceState } from '@renderer/lib/boot-workspace-state'
import { enterBlankSession } from '@renderer/lib/blank-session-transition'
let bootstrapping: Promise<void> | null = null

/**
 * Application first-paint boot (called once on Renderer mount):
 * 1. Read persisted currentWorkspace
 * 2. resolveBootWorkspaceState → no project/sandbox → ephemeral draft home
 * 3. Disk project → setWorkspace + restore UI metadata only (no Worker until a Worker-required action)
 */
export function ensureWorkspaceWorkerOnBoot(): Promise<void> {
  if (bootstrapping) return bootstrapping
  bootstrapping = (async () => {
    const persisted = useUIStore.getState().currentWorkspace
    const boot = resolveBootWorkspaceState(persisted)
    if (boot.ephemeralDraft) {
      enterBlankSession('ephemeral-sandbox')
      queueMicrotask(() => void refreshComposerRunDisplay())
      return
    }
    const path = boot.workspace
    if (!path) return
    useUIStore.getState().setWorkspace(path)
    // Re-open only a Main-authenticated project registration; this never starts
    // a Worker until a Worker-required action occurs.
    try {
      await ipcClient.invoke('workspace.open', { path, awaitWorker: false })
    } catch (error) {
      console.error('[ensureWorkspaceWorkerOnBoot] trusted project reopen failed:', error)
      useUIStore.getState().setWorkspace(null)
      enterBlankSession('ephemeral-sandbox')
      queueMicrotask(() => void refreshComposerRunDisplay())
      return
    }
    try {
      await refreshComposerRunDisplay()
    } catch (error) {
      console.error('[ensureWorkspaceWorkerOnBoot]', error)
    }
  })()
  return bootstrapping
}
