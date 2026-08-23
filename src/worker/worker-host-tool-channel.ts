import type {
  WorkerHostToolCancelV1,
  WorkerHostToolOutcomeV1,
  WorkerHostToolErrorCodeV1,
  WorkerHostToolRequestV1,
  WorkerHostToolResponseV1,
} from '@shared/worker-host-tools'

import { sendToMain } from './worker-transport.js'

const REQUEST_TIMEOUT_MS = 30_000
const INTERACTIVE_WORK_DOCX_TIMEOUT_MS = 15 * 60_000
const INTERACTIVE_DOCUMENT_SNAPSHOT_TIMEOUT_MS = 15 * 60_000

interface PendingRequest {
  resolve: (outcome: WorkerHostToolOutcomeV1) => void
  timer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

const pending = new Map<string, PendingRequest>()
let requestSequence = 0

type WorkerHostToolRequestInputV1 = WorkerHostToolRequestV1 extends infer Request
  ? Request extends WorkerHostToolRequestV1
    ? Omit<Request, 'type' | 'requestId'>
    : never
  : never

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
  if (entry.timer) clearTimeout(entry.timer)
  if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)
  entry.resolve(outcome)
  return true
}

function requestTimeoutMs(request: WorkerHostToolRequestInputV1): number | null {
  if (request.method === 'xiaogui.work.docx.v1') {
    // CONFIRM 已越过独立的人类确认门，是不可取消的发布提交点。
    // 本地超时会造成“前端报失败、文件随后发布”的矛盾，因此必须等待真实回执。
    if (request.payload.action === 'CONFIRM') return null
    return INTERACTIVE_WORK_DOCX_TIMEOUT_MS
  }
  if (request.method === 'xiaogui.work.document-snapshot.v1') {
    // 系统选择器是交互式长等待；主进程解析阶段有自己的 60 秒时限与取消响应。
    return INTERACTIVE_DOCUMENT_SNAPSHOT_TIMEOUT_MS
  }
  return REQUEST_TIMEOUT_MS
}

function cancelOnMain(requestId: string): void {
  try {
    sendToMain({ type: 'host-tool-cancel', requestId } satisfies WorkerHostToolCancelV1)
  } catch {
    /* worker is already disconnecting */
  }
}

export function requestWorkerHostTool(
  request: WorkerHostToolRequestInputV1,
  signal?: AbortSignal,
): Promise<WorkerHostToolOutcomeV1> {
  if (signal?.aborted) {
    return Promise.resolve(errorOutcome('HOST_TOOL_ABORTED', '操作已取消'))
  }

  const requestId = `host-tool-${Date.now()}-${++requestSequence}`
  return new Promise((resolve) => {
    const timeoutMs = requestTimeoutMs(request)
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            cancelOnMain(requestId)
            finish(requestId, errorOutcome('HOST_TOOL_TIMEOUT', '小规操作超时，请稍后重试'))
          }, timeoutMs)
    const entry: PendingRequest = { resolve, timer, signal }
    if (signal) {
      entry.onAbort = () => {
        cancelOnMain(requestId)
        finish(requestId, errorOutcome('HOST_TOOL_ABORTED', '操作已取消'))
      }
      signal.addEventListener('abort', entry.onAbort, { once: true })
    }
    pending.set(requestId, entry)
    try {
      sendToMain({
        type: 'host-tool-request',
        requestId,
        ...request,
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
  const outcome = response.outcome as
    | {
        ok?: unknown
        value?: unknown
        error?: unknown
      }
    | undefined
  const validSuccess =
    outcome?.ok === true &&
    !!outcome.value &&
    typeof outcome.value === 'object' &&
    typeof (outcome.value as { kind?: unknown }).kind === 'string'
  const validFailure =
    outcome?.ok === false &&
    !!outcome.error &&
    typeof outcome.error === 'object' &&
    typeof (outcome.error as { code?: unknown }).code === 'string' &&
    typeof (outcome.error as { message?: unknown }).message === 'string'
  if (!validSuccess && !validFailure) {
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
