import type { CanonicalSessionAddressScopeV1 } from '@shared/xiaogui-session-scope'

export type WorkspaceSessionChoice = {
  sessionId: string
  sessionFile?: string
  title?: string
  updatedAt?: number
  canonicalScope?: CanonicalSessionAddressScopeV1
}

export type WorkspaceSessionChoiceOptions = {
  sessionId?: string
  sessionFile?: string
}

export function chooseWorkspaceSession(
  sessions: WorkspaceSessionChoice[],
  options?: WorkspaceSessionChoiceOptions,
): WorkspaceSessionChoice | null {
  if (options?.sessionId && options.sessionFile) {
    return { sessionId: options.sessionId, sessionFile: options.sessionFile }
  }

  const restorableSessions = sessions.filter((s) => s.sessionFile)

  return (
    restorableSessions.find((s) => s.sessionId === options?.sessionId) ||
    restorableSessions.find((s) => s.sessionFile === options?.sessionFile) ||
    restorableSessions[0] ||
    null
  )
}
