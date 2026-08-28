import { z } from 'zod'

import {
  XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_METHOD_V1,
  type WorkerHostToolErrorCodeV1,
  type WorkerHostToolOutcomeV1,
} from '@shared/worker-host-tools'
import type { TemplateMaterializeErrorCodeV1 } from '@shared/xiaogui-work-docx-template-materialize'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

import type { WorkerHostToolRequestHandler } from '../worker-manager-types'
import type { SessionScopeResolverV1 } from './scope-resolver'
import type { WorkDocxTemplateMaterializeServiceV1 } from './work-docx-template-materialize-service'

const RequestSchema = z.object({
  type: z.literal('host-tool-request'),
  requestId: z.string().min(1).max(240),
  method: z.literal(XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_METHOD_V1),
  payload: z.discriminatedUnion('action', [
    z.object({
      action: z.literal('PREPARE'),
      reportId: z.string().min(1).max(160).optional(),
      sourceSessionId: z.string().min(1).max(200),
      sourceRunId: z.string().min(1).max(200),
      toolCallId: z.string().min(1).max(200),
    }).strict(),
    z.object({
      action: z.literal('CONFIRM'),
      templateName: z.string().min(1).max(120).optional(),
      purpose: z.string().max(500).optional(),
      tags: z.array(z.string().min(1).max(32)).max(20).optional(),
      previewConfirmationToken: z.string().min(1).max(240).optional(),
      sourceSessionId: z.string().min(1).max(200),
      sourceRunId: z.string().min(1).max(200),
      toolCallId: z.string().min(1).max(200),
    }).strict(),
    ...(['RESUME', 'CANCEL', 'OPEN', 'REVEAL', 'EXPORT'] as const).map((action) =>
      z.object({
        action: z.literal(action),
        sourceSessionId: z.string().min(1).max(200),
        sourceRunId: z.string().min(1).max(200),
        toolCallId: z.string().min(1).max(200),
      }).strict(),
    ),
  ]),
})

type MaterializeServicePortV1 = Pick<WorkDocxTemplateMaterializeServiceV1, 'execute'>

export interface XiaoguiWorkDocxTemplateMaterializeWorkerToolOptionsV1 {
  getService: () => MaterializeServicePortV1
  scopeResolver: SessionScopeResolverV1
}

function failure(code: WorkerHostToolErrorCodeV1, message: string): WorkerHostToolOutcomeV1 {
  return { ok: false, error: { code, message } }
}

function messageForError(code: TemplateMaterializeErrorCodeV1): string {
  switch (code) {
    case 'TEMPLATE_MATERIALIZE_REPORT_NOT_FOUND':
    case 'TEMPLATE_MATERIALIZE_REPORT_NOT_CONFIRMED':
      return '没有找到已人工确认的模板整理报告，请先完成复核确认'
    case 'TEMPLATE_MATERIALIZE_OPERATION_ACTIVE':
      return '当前已有待确认的模板预览，请先确认、继续或取消'
    case 'TEMPLATE_MATERIALIZE_NO_PENDING_OPERATION':
      return '当前没有待处理的模板物化操作'
    case 'TEMPLATE_MATERIALIZE_CONFIRMATION_REQUIRED':
      return '请先查看模板预览，再在下一条消息中明确确认另存正式模板'
    case 'TEMPLATE_MATERIALIZE_SOURCE_MISSING':
      return '原 Word 已找不到，请先恢复对应整理报告并重新选择同摘要文件'
    case 'TEMPLATE_MATERIALIZE_SOURCE_CHANGED':
      return '原 Word 已发生变化，必须重新整理和确认后才能生成模板'
    case 'TEMPLATE_MATERIALIZE_DECISION_CHANGED':
      return '人工确认记录已经变化，请重新准备模板预览'
    case 'TEMPLATE_MATERIALIZE_ANCHOR_NOT_FOUND':
    case 'TEMPLATE_MATERIALIZE_ANCHOR_CONFLICT':
    case 'TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT':
      return '部分确认项无法安全定位或存在冲突，没有生成半成品；请重新整理这些项目'
    case 'TEMPLATE_MATERIALIZE_DYNAMIC_NAME_INVALID':
      return '变量、重复块或条件块名称不符合模板字段规则，请重新命名后再试'
    case 'TEMPLATE_MATERIALIZE_PREVIEW_OPEN_FAILED':
      return '模板预览已受控生成，但系统未能打开 Word；修复文件关联后可继续恢复预览'
    case 'TEMPLATE_MATERIALIZE_TARGET_INVALID':
      return '保存位置无效；正式模板必须另存为全新的 DOCX 文件'
    case 'TEMPLATE_MATERIALIZE_TARGET_EXISTS':
      return '目标文件已经存在，小规不会覆盖；请选择新的文件名'
    case 'TEMPLATE_MATERIALIZE_NO_PUBLISHED_OUTPUT':
      return '没有可打开的已发布模板，或文件已被移动或修改'
    case 'TEMPLATE_MATERIALIZE_LIBRARY_NOT_CONFIGURED':
      return '尚未设置本机模板库；请选择一个非系统盘文件夹后再保存'
    case 'TEMPLATE_MATERIALIZE_LIBRARY_SAVE_FAILED':
      return '正式模板未能保存进本机模板库；没有修改原文档，可稍后重试'
    case 'TEMPLATE_MATERIALIZE_ABORTED':
      return '模板物化已取消'
    case 'TEMPLATE_MATERIALIZE_SCOPE_NOT_FOUND':
    case 'TEMPLATE_MATERIALIZE_SCOPE_MISMATCH':
      return '当前对话与项目范围不一致，请重新进入对应日常工作会话'
    case 'TEMPLATE_MATERIALIZE_MODE_NOT_ALLOWED':
      return '正式模板物化只在日常工作会话中可用'
    default:
      return '模板物化失败，没有修改原 Word，也没有覆盖任何文件'
  }
}

export function createXiaoguiWorkDocxTemplateMaterializeWorkerToolHandlerV1(
  options: XiaoguiWorkDocxTemplateMaterializeWorkerToolOptionsV1,
): WorkerHostToolRequestHandler {
  return async ({ request, sessionFile, fromSessionId, fromCwd, signal }) => {
    const parsed = RequestSchema.safeParse(request)
    if (!parsed.success) {
      return failure('HOST_TOOL_REQUEST_INVALID', '模板物化参数不完整，请重新表达需求')
    }
    if (!sessionFile || !fromSessionId) {
      return failure('SESSION_NOT_READY', '当前对话尚未建立完成，请重新进入会话后再试')
    }
    if (parsed.data.payload.sourceSessionId !== fromSessionId) {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请重新发起模板物化')
    }
    let scope
    try {
      scope = await options.scopeResolver.resolveExisting({ rootPath: fromCwd, sessionFile })
    } catch {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未准备好日常工作能力')
    }
    if (!scope) return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未准备好日常工作能力')
    if (scope.sessionMode !== 'WORK') {
      return failure('TEMPLATE_MATERIALIZE_MODE_NOT_ALLOWED', '正式模板物化只在日常工作会话中可用')
    }
    const address: SessionAddressV1 = { projectId: scope.projectId, sessionKey: scope.sessionKey }
    try {
      const outcome = await options.getService().execute(address, parsed.data.payload, signal)
      if (!outcome.ok) return failure(outcome.error.code, messageForError(outcome.error.code))
      return { ok: true, value: outcome.value }
    } catch {
      return failure('HOST_TOOL_FAILED', '模板物化失败，没有修改原 Word 或覆盖文件')
    }
  }
}
