import type { CanonicalSessionAddressScopeV1 } from '@shared/xiaogui-session-scope'

export type SandboxEntry = {
  id: string
  path: string
  label: string
  createdAt: number
  kind: 'sandbox'
  sessionId?: string
  sessionFile?: string
}

export type SessionItem = {
  sessionId: string
  sessionFile?: string
  title: string
  updatedAt: number
  messageCount?: number
  modelId: string
  canonicalScope?: CanonicalSessionAddressScopeV1
}

export type ProjectSessionDisplayItem = {
  session: SessionItem
  groupKey?: string
  groupLabel?: string
}

/** Optional product-layer projection. Undefined keeps the native Pi flat list. */
export type ProjectSessionDisplayStrategy = {
  projectSessions: (sessions: readonly SessionItem[]) => ProjectSessionDisplayItem[]
  beforeOpenSession?: (session: SessionItem) => Promise<void>
}

export function diskProjectName(path: string) {
  return path.split(/[\\/]/).pop() || path
}

export function isSandboxPath(path: string) {
  return path.replace(/\\/g, '/').includes('sandbox-workspaces/')
}
