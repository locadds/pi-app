import type { InitialPlanDraftInputV1 } from './xiaogui-collaboration-hub'
import type { WorkDocxErrorCodeV1 } from './xiaogui-work-docx'

/**
 * Worker 内的 Pi 工具只能通过这条窄通道请求主进程能力。
 * 当前开放“创建协作计划草稿”和“WORK DOCX”两个版本化方法；
 * 后续能力必须显式扩充 method 联合类型。
 */
export const XIAOGUI_CREATE_COLLABORATION_PLAN_METHOD_V1 =
  'xiaogui.collaboration.create-plan-draft' as const
export const XIAOGUI_WORK_DOCX_METHOD_V1 = 'xiaogui.work.docx.v1' as const

export interface XiaoguiCreateCollaborationPlanPayloadV1 {
  draft: InitialPlanDraftInputV1
  /** Pi 会话自身的稳定标识，只用于防止 Worker 复用切换时串线。 */
  sourceSessionId: string
  sourceTurnId?: string
  toolCallId: string
}

export type XiaoguiWorkDocxActionV1 = 'PREPARE' | 'CONFIRM' | 'CANCEL' | 'OPEN' | 'REVEAL'

/**
 * WORK DOCX 的模型侧接口刻意不携带地址、路径或 operationId。
 * 主进程按可信会话绑定当前待确认操作，模型只表达用户意图。
 */
export interface XiaoguiWorkDocxPayloadV1 {
  action: XiaoguiWorkDocxActionV1
  sourceSessionId: string
  /** 一次用户提示触发的整段 Agent run 标识；工具子轮切换时保持不变。 */
  sourceRunId: string
  toolCallId: string
}

export type WorkerHostToolRequestV1 =
  | {
      type: 'host-tool-request'
      requestId: string
      method: typeof XIAOGUI_CREATE_COLLABORATION_PLAN_METHOD_V1
      payload: XiaoguiCreateCollaborationPlanPayloadV1
    }
  | {
      type: 'host-tool-request'
      requestId: string
      method: typeof XIAOGUI_WORK_DOCX_METHOD_V1
      payload: XiaoguiWorkDocxPayloadV1
    }

/** Worker 在本地超时或用户中止后，通知主进程停止保留可取消的中间状态。 */
export interface WorkerHostToolCancelV1 {
  type: 'host-tool-cancel'
  requestId: string
}

export interface XiaoguiCollaborationPlanCreatedV1 {
  kind: 'XIAOGUI_COLLABORATION_DRAFT_CREATED'
  taskCount: number
  sessionVersion: number
}

export type XiaoguiWorkDocxResultV1 =
  | {
      kind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED'
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_PREPARED'
      templateDisplayName: string
      payloadDisplayName: string
      placeholders: readonly string[]
      templateSha256: string
      payloadSha256: string
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_CANCELLED'
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_PUBLISHED'
      outputSha256: string
      templateSha256: string
      payloadSha256: string
      originalInputsUnchanged: true
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_ACCESSED'
      action: 'OPEN' | 'REVEAL'
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
  | 'WORK_DOCX_CONFIRMATION_REQUIRED'
  | 'WORK_DOCX_OPERATION_ACTIVE'
  | 'WORK_DOCX_NO_PENDING_OPERATION'
  | 'WORK_DOCX_NO_PUBLISHED_OUTPUT'
  | WorkDocxErrorCodeV1

export type WorkerHostToolOutcomeV1 =
  | { ok: true; value: XiaoguiCollaborationPlanCreatedV1 | XiaoguiWorkDocxResultV1 }
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
