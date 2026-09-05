import { trustedSessionAccessV1 } from './trusted-session-access'
import { workerManager } from './worker-manager'
import type { WorkerInitResult } from './worker-manager-types'

/**
 * Main-only façade for workspace-scoped Worker operations. Callers provide a
 * candidate project id; the trusted access module decides whether it is an
 * already-authorized project and issues the opaque capability used by the
 * WorkerManager.
 */
export async function startTrustedWorkerForProjectV1(
  workspaceId: string,
): Promise<WorkerInitResult> {
  const project = trustedSessionAccessV1.project({ workspaceId })
  return workerManager.start(project.binding)
}

export async function restartTrustedWorkersForProjectV1(workspaceId: string): Promise<void> {
  const project = trustedSessionAccessV1.project({ workspaceId })
  await workerManager.stop()
  await workerManager.start(project.binding)
}
