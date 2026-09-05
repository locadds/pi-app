import type { BrowserWindow } from 'electron'
import type { XiaoguiPromptContextV1 } from '@shared/xiaogui-prompt-contract'
import {
  attachWorkerHandlers,
  canAcquireNewWorker,
  disposeWorkerSlot,
  evictIdleWorkers,
  forkWorkerForCwd,
  remapSessionWorkerSlot,
  slotRequest,
} from './worker-manager-pool'
import type {
  WorkerAppEventForward,
  WorkerHostToolRequestHandler,
  WorkerSlot,
} from './worker-manager-types'
import { readMaxSessionWorkers } from './worker-pool-config'
import { normalizeSessionKey, workspacePoolKey } from './worker-session-key'
import type {
  TrustedProjectBindingHandleV1,
  TrustedSessionBindingHandleV1,
} from './trusted-worker-capability'
import { createWorkerSessionCreationOperationV1 } from './worker-session-creation-operation'

export type NewSessionPoolOptions = {
  cwd: string
  projectBinding: TrustedProjectBindingHandleV1
  projectIdentityDigest: string
  pool: Map<string, WorkerSlot>
  mainWindow: BrowserWindow | null
  foregroundPoolKey: () => string | null
  slotMatchesCurrentRuntime: (slot: WorkerSlot) => boolean
  setForeground: (slot: WorkerSlot) => void
  onAppEvent: (payload: WorkerAppEventForward) => void
  onHostToolRequest?: WorkerHostToolRequestHandler
  onSlotExit: (slot: WorkerSlot, code: number) => void
  beforeActivate?: (result: { sessionId: string; sessionFile: string }) => Promise<void>
  issueRuntimeSession: (sessionFile: string) => TrustedSessionBindingHandleV1
  activateSession: (
    slot: WorkerSlot,
    binding: TrustedSessionBindingHandleV1,
    promptContext: XiaoguiPromptContextV1,
  ) => Promise<void>
  promptContext: XiaoguiPromptContextV1
  finalizePromptContext?: (sessionFile: string) => Promise<XiaoguiPromptContextV1>
}

function findReusableWorkspaceSlot(options: NewSessionPoolOptions): WorkerSlot | null {
  const foregroundKey = options.foregroundPoolKey()
  const foreground = foregroundKey ? options.pool.get(foregroundKey) : null
  if (
    foreground &&
    foreground.cwd === options.cwd &&
    options.slotMatchesCurrentRuntime(foreground) &&
    !foreground.sessionFile &&
    !foreground.agentTurnActive &&
    !foreground.stopping
  ) {
    return foreground
  }
  for (const slot of options.pool.values()) {
    if (
      slot.cwd === options.cwd &&
      options.slotMatchesCurrentRuntime(slot) &&
      !slot.sessionFile &&
      !slot.agentTurnActive &&
      !slot.stopping
    ) {
      return slot
    }
  }
  return null
}

function nextWorkspacePoolKey(pool: Map<string, WorkerSlot>, cwd: string): string {
  const base = workspacePoolKey(cwd)
  if (!pool.has(base)) return base
  for (let suffix = 1; ; suffix++) {
    const candidate = `${base}:new:${suffix}`
    if (!pool.has(candidate)) return candidate
  }
}

async function runNewSession(
  slot: WorkerSlot,
  options: NewSessionPoolOptions,
): Promise<{ sessionId: string; sessionFile?: string; binding?: TrustedSessionBindingHandleV1 }> {
  if (slot.initPromise) await slot.initPromise
  const creation = createWorkerSessionCreationOperationV1({ slot, pool: options.pool })
  const response = await slotRequest(slot, 'newSession', {
    promptContext: options.promptContext,
    creationOperationNonce: creation.nonce,
  })
  if (response.type === 'error') {
    throw new Error(String(response.error || 'newSession failed'))
  }
  slot.promptContext = options.promptContext
  const sessionId = String(response.sessionId ?? '')
  const sessionFile = response.sessionFile
    ? creation.acceptTarget(response)
    : undefined
  if (sessionFile) {
    await options.beforeActivate?.({ sessionId, sessionFile })
    const binding = options.issueRuntimeSession(sessionFile)
    if (options.finalizePromptContext) {
      const finalContext = await options.finalizePromptContext(sessionFile)
      await options.activateSession(slot, binding, finalContext)
      slot.promptContext = finalContext
    }
    await remapSessionWorkerSlot(options.pool, slot.poolKey, sessionFile)
    slot.sessionBinding = binding
    options.setForeground(slot)
    await evictIdleWorkers(options.pool, {
      foregroundKey: slot.poolKey,
      maxWorkers: readMaxSessionWorkers(),
      mainWindow: options.mainWindow,
    })
    return { sessionId, sessionFile, binding }
  }
  throw new Error('SESSION_CREATION_RECEIPT_INVALID')
}

export async function createNewSessionInPool(
  options: NewSessionPoolOptions,
): Promise<{ sessionId: string; sessionFile?: string; binding?: TrustedSessionBindingHandleV1 }> {
  const reusable = findReusableWorkspaceSlot(options)
  if (reusable) {
    try {
      return await runNewSession(reusable, options)
    } catch (error) {
      if (options.pool.get(reusable.poolKey) === reusable) options.pool.delete(reusable.poolKey)
      await disposeWorkerSlot(reusable, options.mainWindow)
      throw error
    }
  }

  const capacity = canAcquireNewWorker(options.pool)
  if (!capacity.ok) throw new Error(capacity.reason)
  if (options.pool.size >= readMaxSessionWorkers()) {
    await evictIdleWorkers(options.pool, {
      foregroundKey: null,
      maxWorkers: readMaxSessionWorkers() - 1,
      mainWindow: options.mainWindow,
    })
  }

  const poolKey = nextWorkspacePoolKey(options.pool, options.cwd)
  const { slot, init } = await forkWorkerForCwd(options.cwd, {
    projectBinding: options.projectBinding,
    projectIdentityDigest: options.projectIdentityDigest,
    poolKey,
    sessionFile: null,
    promptContext: options.promptContext,
  })
  options.pool.set(poolKey, slot)
  attachWorkerHandlers(slot, slot.worker, {
    mainWindow: options.mainWindow,
    getForegroundPoolKey: options.foregroundPoolKey,
    onAppEvent: options.onAppEvent,
    onHostToolRequest: options.onHostToolRequest,
    onSlotExit: options.onSlotExit,
  })

  try {
    await init
    return await runNewSession(slot, options)
  } catch (error) {
    if (options.pool.get(slot.poolKey) === slot) options.pool.delete(slot.poolKey)
    await disposeWorkerSlot(slot, options.mainWindow)
    throw error
  }
}
