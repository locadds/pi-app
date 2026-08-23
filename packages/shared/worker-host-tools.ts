import type { InitialPlanDraftInputV1 } from './xiaogui-collaboration-hub'

/**
 * Worker 内的 Pi 工具只能通过这条窄通道请求主进程能力。
 * 当前只开放“创建协作计划草稿”，后续能力必须显式扩充 method 联合类型。
 */
export const XIAOGUI_CREATE_COLLABORATION_PLAN_METHOD_V1 =
  'xiaogui.collaboration.create-plan-draft' as const

export interface XiaoguiCreateCollaborationPlanPayloadV1 {
  draft: InitialPlanDraftInputV1
  /** Pi 会话自身的稳定标识，只用于防止 Worker 复用切换时串线。 */
  sourceSessionId: string
  sourceTurnId?: string
  toolCallId: string
}

export interface WorkerHostToolRequestV1 {
  type: 'host-tool-request'
  requestId: string
  method: typeof XIAOGUI_CREATE_COLLABORATION_PLAN_METHOD_V1
  payload: XiaoguiCreateCollaborationPlanPayloadV1
}

export interface XiaoguiCollaborationPlanCreatedV1 {
  kind: 'XIAOGUI_COLLABORATION_DRAFT_CREATED'
  taskCount: number
  sessionVersion: number
}

export type WorkerHostToolErrorCodeV1 =
  | 'HOST_TOOL_UNAVAILABLE'
  | 'HOST_TOOL_REQUEST_INVALID'
  | 'SESSION_NOT_READY'
  | 'DESIGN_RESERVED'
  | 'DRAFT_INVALID'
  | 'ACTIVE_FLOW_EXISTS'
  | 'SESSION_SCOPE_MISMATCH'
  | 'HOST_TOOL_FAILED'
  | 'HOST_TOOL_TIMEOUT'
  | 'HOST_TOOL_ABORTED'

export type WorkerHostToolOutcomeV1 =
  | { ok: true; value: XiaoguiCollaborationPlanCreatedV1 }
  | {
      ok: false
      error: {
        code: WorkerHostToolErrorCodeV1
        message: string
        traceId?: string
      }
    }

export interface WorkerHostToolResponseV1 {
  type: 'host-tool-response'
  requestId: string
  outcome: WorkerHostToolOutcomeV1
}
