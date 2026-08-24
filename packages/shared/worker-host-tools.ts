import type { InitialPlanDraftInputV1 } from './xiaogui-collaboration-hub'
import type {
  DocumentSnapshotV1,
  WorkDocumentSnapshotErrorCodeV1,
} from './xiaogui-document-snapshot'
import type { WorkDocxErrorCodeV1 } from './xiaogui-work-docx'
import type {
  WorkDocxTemplateFieldInputV1,
  WorkDocxTemplateFieldV1,
  WorkDocxTemplateProfileV1,
} from './xiaogui-work-docx-template-data'
import type {
  TemplateIntakeDecisionV1,
  TemplateIntakeDraftDecisionItemV1,
  TemplateIntakeErrorCodeV1,
  TemplateIntakeFinalDecisionItemV1,
  TemplateIntakeReportV1,
  TemplateIntakeSourceAnchorV1,
  TemplateIntakeUpdateOperationV1,
  TemplateIntakeWarningV1,
} from './xiaogui-work-docx-template-intake'

/**
 * Worker 内的 Pi 工具只能通过这条窄通道请求主进程能力。
 * 当前开放“创建协作计划草稿”、三版“WORK DOCX”和“WORK 文档快照”五个版本化方法；
 * 后续能力必须显式扩充 method 联合类型。
 */
export const XIAOGUI_CREATE_COLLABORATION_PLAN_METHOD_V1 =
  'xiaogui.collaboration.create-plan-draft' as const
export const XIAOGUI_WORK_DOCX_METHOD_V1 = 'xiaogui.work.docx.v1' as const
export const XIAOGUI_WORK_DOCX_TEMPLATE_DATA_METHOD_V1 =
  'xiaogui.work.docx-template-data.v1' as const
export const XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_METHOD_V1 =
  'xiaogui.work.docx-template-intake.v1' as const
export const XIAOGUI_WORK_DOCUMENT_SNAPSHOT_METHOD_V1 = 'xiaogui.work.document-snapshot.v1' as const

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

export type XiaoguiWorkDocxTemplateDataActionV1 =
  | 'SELECT_TEMPLATE'
  | 'PREPARE'
  | 'CONFIRM'
  | 'CANCEL'
  | 'OPEN'
  | 'REVEAL'

export interface XiaoguiWorkDocxTemplateDataPayloadV1 {
  action: XiaoguiWorkDocxTemplateDataActionV1
  fields?: readonly WorkDocxTemplateFieldInputV1[]
  sourceSessionId: string
  sourceRunId: string
  toolCallId: string
}

export type TemplateIntakeAnalysisFragmentKindV1 =
  | 'PARAGRAPH'
  | 'HEADING'
  | 'TABLE_CELL'
  | 'HEADER'
  | 'FOOTER'

/** 只在主进程与 Worker 之间短暂传递；不得进入公开工具结果或 Pi 会话历史。 */
export interface TemplateIntakeAnalysisFragmentV1 {
  fragmentId: string
  kind: TemplateIntakeAnalysisFragmentKindV1
  anchor: TemplateIntakeSourceAnchorV1
  text: string
}

export interface TemplateIntakeAnalysisBatchV1 {
  batchIndex: number
  characterCount: number
  fragments: readonly TemplateIntakeAnalysisFragmentV1[]
}

export interface TemplateIntakeModelSuggestionV1 {
  fragmentIds: readonly string[]
  kind: 'FIXED' | 'VARIABLE' | 'REPEAT' | 'CONDITIONAL' | 'EXCLUDE' | 'UNRESOLVED'
  reason: string
  confidence: number | null
  suggestedName?: string
}

export type TemplateIntakeModelAnalysisV1 =
  | {
      status: 'COMPLETE'
      modelVersion: string
      suggestions: readonly TemplateIntakeModelSuggestionV1[]
    }
  | {
      status: 'DEGRADED'
      modelVersion: string | null
      warning: Pick<TemplateIntakeWarningV1, 'code' | 'message'>
    }

export interface TemplateIntakeReviewSubmissionV1 {
  decisions: readonly TemplateIntakeFinalDecisionItemV1[]
}

type XiaoguiWorkDocxTemplateIntakeCommonPayloadV1 = {
  sourceSessionId: string
  sourceRunId: string
  toolCallId: string
}

export type XiaoguiWorkDocxTemplateIntakePayloadV1 =
  | (XiaoguiWorkDocxTemplateIntakeCommonPayloadV1 & {
      action: 'START'
      /** 首次 START 省略；Worker 临时模型分析完成后仍以 START 回送。 */
      analysis?: TemplateIntakeModelAnalysisV1
      /** 回送分析时绑定主进程签发的报告编号，防止旧分析被用于新文档。 */
      reportId?: string
    })
  | (XiaoguiWorkDocxTemplateIntakeCommonPayloadV1 & {
      action: 'UPDATE'
      operations: readonly TemplateIntakeUpdateOperationV1[]
    })
  | (XiaoguiWorkDocxTemplateIntakeCommonPayloadV1 & {
      action: 'REVIEW'
      /** 首次 REVIEW 省略；复核卡提交后仍以 REVIEW 回送。 */
      submission?: TemplateIntakeReviewSubmissionV1
    })
  | (XiaoguiWorkDocxTemplateIntakeCommonPayloadV1 & {
      action: 'RESUME'
      reportId?: string
    })
  | (XiaoguiWorkDocxTemplateIntakeCommonPayloadV1 & {
      action: 'DELETE'
      reportId: string
      confirmed: true
    })
  | (XiaoguiWorkDocxTemplateIntakeCommonPayloadV1 & {
      action: 'CANCEL'
    })

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
  | {
      type: 'host-tool-request'
      requestId: string
      method: typeof XIAOGUI_WORK_DOCX_TEMPLATE_DATA_METHOD_V1
      payload: XiaoguiWorkDocxTemplateDataPayloadV1
    }
  | {
      type: 'host-tool-request'
      requestId: string
      method: typeof XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_METHOD_V1
      payload: XiaoguiWorkDocxTemplateIntakePayloadV1
    }
  | {
      type: 'host-tool-request'
      requestId: string
      method: typeof XIAOGUI_WORK_DOCUMENT_SNAPSHOT_METHOD_V1
      payload: XiaoguiWorkDocumentSnapshotPayloadV1
    }

/**
 * WORK 文档快照的模型侧接口同样不携带地址、路径、文件句柄或密码。
 * 模型只表达“读取 PDF”与可选起止页；主进程按可信会话绑定派生项目与 WORK 模式。
 */
export interface XiaoguiWorkDocumentSnapshotPayloadV1 {
  action: 'READ_PDF'
  /** 1 起始；省略时从第 1 页开始。 */
  startPage?: number
  /** 1 起始含端点；省略时最多读取 20 页。 */
  endPage?: number
  sourceSessionId: string
  sourceRunId: string
  toolCallId: string
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
  | { kind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED' }
  | {
      kind: 'XIAOGUI_WORK_DOCX_PREPARED'
      templateDisplayName: string
      payloadDisplayName: string
      placeholders: readonly string[]
      templateSha256: string
      payloadSha256: string
    }
  | { kind: 'XIAOGUI_WORK_DOCX_CANCELLED' }
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

export type XiaoguiWorkDocxTemplateDataResultV1 =
  | { kind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED' }
  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_PREPARATION_REQUIRED'
      templateDisplayName: string
      templateSha256: string
      profile: WorkDocxTemplateProfileV1
    }

  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_SELECTED'
      templateDisplayName: string
      templateSha256: string
      fields: readonly WorkDocxTemplateFieldV1[]
      profile: WorkDocxTemplateProfileV1
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_INPUT_REQUIRED'
      unresolvedFields: readonly string[]
    }
  | { kind: 'XIAOGUI_WORK_DOCX_TARGET_SELECTION_CANCELLED' }
  | {
      kind: 'XIAOGUI_WORK_DOCX_PREPARED'
      templateDisplayName: string
      fields: readonly string[]
      templateSha256: string
      dataSha256: string
    }
  | { kind: 'XIAOGUI_WORK_DOCX_CANCELLED' }
  | {
      kind: 'XIAOGUI_WORK_DOCX_PUBLISHED'
      outputSha256: string
      templateSha256: string
      dataSha256: string
      originalInputsUnchanged: true
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_ACCESSED'
      action: 'OPEN' | 'REVEAL'
    }

export type XiaoguiWorkDocxTemplateIntakeResultV1 =
  | { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_SELECTION_CANCELLED' }
  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED'
      reportId: string
      fileDisplayName: string
      analysisBatches: readonly TemplateIntakeAnalysisBatchV1[]
      deterministicWarnings: readonly TemplateIntakeWarningV1[]
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY'
      report: TemplateIntakeReportV1
      draftDecisions: readonly TemplateIntakeDraftDecisionItemV1[]
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED'
      report: TemplateIntakeReportV1
      draftDecisions: readonly TemplateIntakeDraftDecisionItemV1[]
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REVIEW_REQUIRED'
      report: TemplateIntakeReportV1
      draftDecisions: readonly TemplateIntakeDraftDecisionItemV1[]
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CONFIRMED'
      decision: TemplateIntakeDecisionV1
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_RESUMED'
      report: TemplateIntakeReportV1
      draftDecisions: readonly TemplateIntakeDraftDecisionItemV1[]
      decision?: TemplateIntakeDecisionV1
    }
  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_DELETED'
      reportId: string
    }
  | { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CANCELLED' }

export type XiaoguiWorkDocumentSnapshotResultV1 =
  | {
      kind: 'XIAOGUI_WORK_DOCUMENT_SELECTION_CANCELLED'
    }
  | {
      kind: 'XIAOGUI_WORK_DOCUMENT_SNAPSHOT_READY'
      snapshot: DocumentSnapshotV1
    }

export type WorkerHostToolErrorCodeV1 =
  | 'HOST_TOOL_UNAVAILABLE'
  | 'HOST_TOOL_REQUEST_INVALID'
  | 'HOST_TOOL_NOT_FOREGROUND'
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
  | 'WORK_DOCUMENT_SNAPSHOT_ACTIVE'
  | WorkDocxErrorCodeV1
  | TemplateIntakeErrorCodeV1
  | WorkDocumentSnapshotErrorCodeV1

export type WorkerHostToolOutcomeV1 =
  | {
      ok: true
      value:
        | XiaoguiCollaborationPlanCreatedV1
        | XiaoguiWorkDocxResultV1
        | XiaoguiWorkDocxTemplateDataResultV1
        | XiaoguiWorkDocxTemplateIntakeResultV1
        | XiaoguiWorkDocumentSnapshotResultV1
    }
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
