/**
 * Session JSONL bound to Worker only after user sends a prompt (fast Timeline switch).
 * Timeline preview: session.getMessages reads JSONL via buildTimelinePageFromSessionFile (main disk fallback or Worker RPC).
 * Agent turn / navigateTree: ensureWorkerSessionBound → loadSession binds the live AgentSession.
 */
import type { TrustedSessionBindingHandleV1 } from './trusted-worker-capability'

let pendingWorkerSessionBinding: TrustedSessionBindingHandleV1 | null = null

/** 首条消息前尚未创建磁盘目录的临时对话草稿 */
let pendingEphemeralSandboxDraft = false

export function setPendingEphemeralSandboxDraft(v: boolean): void {
  pendingEphemeralSandboxDraft = v
}

export function isPendingEphemeralSandboxDraft(): boolean {
  return pendingEphemeralSandboxDraft
}

export function setPendingWorkerSessionBinding(binding: TrustedSessionBindingHandleV1 | null): void {
  pendingWorkerSessionBinding = binding
}

export function getPendingWorkerSessionBinding(): TrustedSessionBindingHandleV1 | null {
  return pendingWorkerSessionBinding
}

export type WorkerSessionBindResult = {
  sessionId: string
  model?: string
  thinkingLevel?: string
  modelFallbackMessage?: string
}

export async function ensureWorkerSessionBound(
  loadSession: (
    binding: TrustedSessionBindingHandleV1,
    opts?: { force?: boolean },
  ) => Promise<WorkerSessionBindResult>,
  opts?: { force?: boolean; sessionBinding?: TrustedSessionBindingHandleV1 | null },
): Promise<WorkerSessionBindResult | null> {
  if (pendingEphemeralSandboxDraft) {
    throw new Error('EPHEMERAL_SANDBOX_DRAFT')
  }
  const binding = opts?.sessionBinding || pendingWorkerSessionBinding
  if (!binding) return null
  const result = await loadSession(binding, { force: opts?.force === true })
  pendingWorkerSessionBinding = null
  return result
}
