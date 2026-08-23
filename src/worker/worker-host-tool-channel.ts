import type {
  WorkerHostToolOutcomeV1,
  WorkerHostToolErrorCodeV1,
  WorkerHostToolRequestV1,
  WorkerHostToolResponseV1,
} from '@shared/worker-host-tools'

import { sendToMain } from './worker-transport.js'

const REQUEST_TIMEOUT_MS = 30_000

interface PendingRequest {
  resolve: (outcome: WorkerHostToolOutcomeV1) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

const pending = new Map<string, PendingRequest>()
let requestSequence = 0

function errorOutcome(
  code: WorkerHostToolErrorCodeV1,
  message: string,
): WorkerHostToolOutcomeV1 {
  return { ok: false, error: { code, message } }
}

function finish(requestId: string, outcome: WorkerHostToolOutcomeV1): boolean {
  const entry = pending.get(requestId)
  if (!entry) return false
  pending.delete(requestId)
  clearTimeout(entry.timer)
  if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)
  entry.resolve(outcome)
  return true
}

export function requestWorkerHostTool(
  request: Omit<WorkerHostToolRequestV1, 'type' | 'requestId'>,
  signal?: AbortSignal,
): Promise<WorkerHostToolOutcomeV1> {
  if (signal?.aborted) {
    return Promise.resolve(errorOutcome('HOST_TOOL_ABORTED', '协作计划创建已取消'))
  }

  const requestId = `host-tool-${Date.now()}-${++requestSequence}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      finish(requestId, errorOutcome('HOST_TOOL_TIMEOUT', '协作计划创建超时，请稍后重试'))
    }, REQUEST_TIMEOUT_MS)
    const entry: PendingRequest = { resolve, timer, signal }
    if (signal) {
      entry.onAbort = () => {
        finish(requestId, errorOutcome('HOST_TOOL_ABORTED', '协作计划创建已取消'))
      }
      signal.addEventListener('abort', entry.onAbort, { once: true })
    }
    pending.set(requestId, entry)
    try {
      sendToMain({
        type: 'host-tool-request',
        requestId,
        method: request.method,
        payload: request.payload,
      } satisfies WorkerHostToolRequestV1)
    } catch {
      finish(requestId, errorOutcome('HOST_TOOL_UNAVAILABLE', '小规主进程能力尚未就绪'))
    }
  })
}

/** 在 Worker 的普通 RPC 分派前截获主进程回包。 */
export function receiveWorkerHostToolResponse(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const response = message as Partial<WorkerHostToolResponseV1>
  if (response.type !== 'host-tool-response' || typeof response.requestId !== 'string') return false
  const outcome = response.outcome as Partial<WorkerHostToolOutcomeV1> | undefined
  if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
    finish(response.requestId, errorOutcome('HOST_TOOL_FAILED', '主进程返回了无法识别的结果'))
    return true
  }
  // 合法的 host-tool 回包必须在这里终止分发。即使请求已超时或取消，
  // 迟到的回包也不能落入普通 Worker RPC，否则会被误报为未知消息。
  if (!finish(response.requestId, outcome as WorkerHostToolOutcomeV1)) {
    console.warn('[Worker] Dropping late host-tool response:', response.requestId)
  }
  return true
}
