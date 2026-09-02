import { z } from 'zod'

import {
  XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_METHOD_V1,
  type WorkerHostToolErrorCodeV1,
  type WorkerHostToolOutcomeV1,
} from '@shared/worker-host-tools'
import type { AdvancedGenerationErrorCodeV1 } from '@shared/xiaogui-work-docx-advanced-generation'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

import type { WorkerHostToolRequestHandler } from '../worker-manager-types'
import type { SessionScopeResolverV1 } from './scope-resolver'
import type { WorkDocxAdvancedGenerationServiceV1 } from './work-docx-advanced-generation-service'

const ValueSchema = z.union([z.string().max(20_000), z.number().finite(), z.boolean()])
const DataSchema = z.object({
  dataVersion: z.literal(1),
  variables: z.array(z.object({ name: z.string().min(1).max(64), status: z.enum(['RESOLVED', 'UNRESOLVED']), value: ValueSchema.optional() }).strict()).max(200),
  repeatBlocks: z.array(z.object({
    name: z.string().min(1).max(64),
    status: z.enum(['RESOLVED', 'UNRESOLVED']),
    records: z.array(z.object({ slots: z.array(z.object({ slotId: z.string().min(1).max(40), value: ValueSchema }).strict()).max(50) }).strict()).max(500).optional(),
  }).strict()).max(50),
  conditionalBlocks: z.array(z.object({ name: z.string().min(1).max(64), status: z.enum(['RESOLVED', 'UNRESOLVED']), value: z.boolean().optional() }).strict()).max(50),
}).strict()

const Common = { sourceSessionId: z.string().min(1).max(200), sourceRunId: z.string().min(1).max(200), toolCallId: z.string().min(1).max(200) }
const RequestSchema = z.object({
  type: z.literal('host-tool-request'), requestId: z.string().min(1).max(240), method: z.literal(XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_METHOD_V1),
  payload: z.discriminatedUnion('action', [
    z.object({ action: z.literal('START'), ...Common }).strict(),
    z.object({ action: z.literal('PREPARE'), data: DataSchema, ...Common }).strict(),
    ...(['CONFIRM', 'RESUME', 'CANCEL', 'OPEN', 'REVEAL'] as const).map((action) => z.object({ action: z.literal(action), ...Common }).strict()),
  ]),
})

type ServicePort = Pick<WorkDocxAdvancedGenerationServiceV1, 'execute'>
export interface XiaoguiWorkDocxAdvancedGenerationWorkerToolOptionsV1 { getService: () => ServicePort; scopeResolver: SessionScopeResolverV1 }

function failure(code: WorkerHostToolErrorCodeV1, message: string): WorkerHostToolOutcomeV1 { return { ok: false, error: { code, message } } }

function messageForError(code: AdvancedGenerationErrorCodeV1): string {
  switch (code) {
    case 'ADVANCED_GENERATION_OPERATION_ACTIVE': return '已有高级 Word 生成操作，请先继续或取消'
    case 'ADVANCED_GENERATION_NO_PENDING_OPERATION': return '当前没有待处理的高级 Word 生成操作'
    case 'ADVANCED_GENERATION_CONFIRMATION_REQUIRED': return '请先查看成品预览，再在下一条消息中明确确认另存'
    case 'ADVANCED_GENERATION_TEMPLATE_MISSING': return '正式模板已找不到，请重新选择'
    case 'ADVANCED_GENERATION_TEMPLATE_CHANGED': return '正式模板已发生变化，必须重新开始生成'
    case 'ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED': return '该模板的重复块或条件块包含首期不支持的结构，没有生成半成品'
    case 'ADVANCED_GENERATION_STRUCTURE_INVALID': return '模板结构标记损坏、重名或冲突，请重新物化模板'
    case 'ADVANCED_GENERATION_INPUT_REQUIRED': return '仍有普通字段、重复块槽位或条件决定没有解决，请补齐后再生成'
    case 'ADVANCED_GENERATION_DATA_INVALID': return '成品数据不符合模板结构，请按结构摘要重新整理'
    case 'ADVANCED_GENERATION_TARGET_EXISTS': return '目标文件已存在，小规不会覆盖；请选择新文件名'
    case 'ADVANCED_GENERATION_TARGET_INVALID': return '保存位置无效；成品文档只能另存为全新的 DOCX 文件'
    case 'ADVANCED_GENERATION_PREVIEW_OPEN_FAILED': return '预览已生成，但系统未能打开 Word；可稍后恢复'
    case 'ADVANCED_GENERATION_NO_PUBLISHED_OUTPUT': return '没有可打开的已发布成品，或文件已移动或变化'
    case 'ADVANCED_GENERATION_ABORTED': return '高级 Word 生成已取消'
    case 'ADVANCED_GENERATION_SCOPE_NOT_FOUND': case 'ADVANCED_GENERATION_SCOPE_MISMATCH': return '当前对话与项目范围不一致，请重新进入对应日常工作会话'
    case 'ADVANCED_GENERATION_MODE_NOT_ALLOWED': return '高级 Word 生成只在日常工作会话中可用'
    default: return '高级 Word 生成失败；没有修改原模板，也没有覆盖文件'
  }
}

export function createXiaoguiWorkDocxAdvancedGenerationWorkerToolHandlerV1(options: XiaoguiWorkDocxAdvancedGenerationWorkerToolOptionsV1): WorkerHostToolRequestHandler {
  return async ({ request, sessionFile, fromSessionId, fromCwd, signal }) => {
    const parsed = RequestSchema.safeParse(request)
    if (!parsed.success) return failure('HOST_TOOL_REQUEST_INVALID', '高级 Word 生成参数不完整，请重新表达需求')
    if (!sessionFile || !fromSessionId) return failure('SESSION_NOT_READY', '当前对话尚未建立完成，请重新进入会话后再试')
    if (parsed.data.payload.sourceSessionId !== fromSessionId) return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请重新发起生成')
    let scope
    try { scope = await options.scopeResolver.resolveExisting({ rootPath: fromCwd, sessionFile }) } catch { return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未准备好日常工作能力') }
    if (!scope || scope.sessionMode !== 'WORK') return failure('ADVANCED_GENERATION_MODE_NOT_ALLOWED', '高级 Word 生成只在日常工作会话中可用')
    const address: SessionAddressV1 = { projectId: scope.projectId, sessionKey: scope.sessionKey }
    try {
      const outcome = await options.getService().execute(address, parsed.data.payload, signal)
      if (!outcome.ok) return failure(outcome.error.code, messageForError(outcome.error.code))
      return { ok: true, value: outcome.value }
    } catch { return failure('HOST_TOOL_FAILED', '高级 Word 生成失败；没有修改原模板或覆盖文件') }
  }
}
