/** Messages from Main → Worker utilityProcess. */
import type { CodingContextAgentPayloadV1 } from '@shared/xiaogui-coding-extension-pack'
import type { CodingRoleAgentSnapshotV1 } from '@shared/xiaogui-coding-role-control'

/** Operation-scoped Main-to-Worker lease. It is not a reusable Main capability. */
export type WorkerSessionExecutionLeaseV1 = Readonly<{
  schemaVersion: 1
  sessionFile: string
  authorizedCwd: string
  projectIdentityDigest: string
  slotBindingDigest: string
  operationNonce: string
}>

export type WorkerIncomingMessage = {
  type?: string
  requestId?: string
  cwd?: string
  /** Main-captured project entity identity for this Worker slot. */
  projectIdentityDigest?: string
  /** Main-captured immutable slot binding identity. */
  slotBindingDigest?: string
  sdkPath?: string | null
  /** Main-resolved, installation-bundled Pi Skill directories. */
  bundledSkillPaths?: string[]
  text?: string
  codingContext?: CodingContextAgentPayloadV1
  /** Main-only private Attempt role binding; never accepted from Renderer IPC. */
  codingRole?: CodingRoleAgentSnapshotV1
  expectedAttemptId?: string
  options?: unknown
  sessionFile?: string
  sessionExecutionLease?: WorkerSessionExecutionLeaseV1
  /** One-shot Main creation operation bound to an exact Worker slot. */
  creationOperationNonce?: string
  offset?: number
  limit?: number
  targetId?: string
  summarize?: boolean
  customInstructions?: string
  replaceInstructions?: string
  label?: string
  provider?: string
  modelId?: string
  level?: string
  patch?: Record<string, unknown>
  commandName?: string
  argumentPrefix?: string
  [key: string]: unknown
}

export type WorkerCommandRow = {
  id: string
  name: string
  description: string
  category: string
  source?: unknown
}

export type WorkerModelRow = {
  id: string
  name: string
  provider: string
  contextWindow: number
  maxOutput: number
  available: boolean
}
