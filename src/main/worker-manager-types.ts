import type { AppEvent } from '@shared/app-events'
import type { WorkerResponsePayload } from '@shared/worker-rpc-types'
import type {
  XiaoguiEffectivePromptDiagnosticsV1,
  XiaoguiPromptContextV1,
} from '@shared/xiaogui-prompt-contract'
import type { WorkerHostToolOutcomeV1, WorkerHostToolRequestV1 } from '@shared/worker-host-tools'
import type { WorkerTransport } from './worker-transport'

export type WorkerInitResult = {
  sessionId: string
  model?: string
  thinkingLevel?: string
  promptDiagnostics?: XiaoguiEffectivePromptDiagnosticsV1
}

export type WorkerSlot = {
  /** Pool map key: sessionFile abs path or `ws:${cwd}` */
  poolKey: string
  cwd: string
  /** Runtime identity captured when this worker was created. */
  runtime: { mode: 'host' | 'wsl'; distro: string | null }
  /** Bound session file when known; null for workspace-only slots */
  sessionFile: string | null
  /** Worker 当前实际绑定的 Pi session id；与 sessionFile 一起随生命周期回包同步更新。 */
  sessionId: string | null
  /** Last Main context sent for this slot; body-free and safe to retain in memory. */
  promptContext?: XiaoguiPromptContextV1 | null
  promptDiagnostics?: XiaoguiEffectivePromptDiagnosticsV1 | null
  worker: WorkerTransport
  pendingRequests: Map<
    string,
    { resolve: (v: WorkerResponsePayload) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >
  requestCounter: number
  initResolver: ((r: WorkerInitResult) => void) | null
  initRejecter: ((e: Error) => void) | null
  initPromise: Promise<WorkerInitResult> | null
  agentTurnActive: boolean
  /** Last time turn became idle (ms); used for idle TTL eviction */
  lastIdleAt: number
  /** Last time this slot was foreground (ms) */
  lastForegroundAt: number
  sdkFallback: boolean
  autoRestartEnabled: boolean
  stopping: boolean
}

export type WorkerAppEventForward = {
  event: AppEvent
  fromCwd: string
  fromPoolKey: string
  sessionFile: string | null
  agentTurnActive: boolean
}

export type WorkerHostToolRequestForward = {
  request: WorkerHostToolRequestV1
  fromCwd: string
  fromPoolKey: string
  sessionFile: string | null
  fromSessionId: string | null
  /** Worker 本地超时、用户中止或 slot 退出时由主进程触发。 */
  signal?: AbortSignal
}

export type WorkerHostToolRequestHandler = (
  payload: WorkerHostToolRequestForward,
) => Promise<WorkerHostToolOutcomeV1>
