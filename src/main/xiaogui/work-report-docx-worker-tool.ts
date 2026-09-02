import { z } from 'zod'

import {
  XIAOGUI_WORK_REPORT_DOCX_METHOD_V1,
  type WorkerHostToolErrorCodeV1,
  type WorkerHostToolOutcomeV1,
} from '@shared/worker-host-tools'
import type { WorkReportDocxErrorCodeV1 } from '@shared/xiaogui-work-report-docx'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

import type { WorkerHostToolRequestHandler } from '../worker-manager-types'
import type { SessionScopeResolverV1 } from './scope-resolver'
import type { WorkReportDocxServiceV1 } from './work-report-docx-service'

const TextSchema = z.string().min(1).max(4_000)
const DraftSchema = z
  .object({
    title: z.string().min(1).max(120),
    sections: z
      .array(
        z
          .object({
            heading: z.string().min(1).max(120),
            paragraphs: z.array(TextSchema).max(20),
            bullets: z.array(TextSchema).max(30),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine(
    (draft) =>
      draft.title.length +
        draft.sections.reduce(
          (total, section) =>
            total +
            section.heading.length +
            section.paragraphs.reduce((sum, item) => sum + item.length, 0) +
            section.bullets.reduce((sum, item) => sum + item.length, 0),
          0,
        ) <=
      30_000,
  )

const Common = {
  sourceSessionId: z.string().min(1).max(200),
  sourceRunId: z.string().min(1).max(200),
  toolCallId: z.string().min(1).max(200),
}

const RequestSchema = z
  .object({
    type: z.literal('host-tool-request'),
    requestId: z.string().min(1).max(240),
    method: z.literal(XIAOGUI_WORK_REPORT_DOCX_METHOD_V1),
    payload: z.discriminatedUnion('action', [
      z.object({ action: z.literal('PREPARE'), draft: DraftSchema, ...Common }).strict(),
      ...(['CONFIRM', 'CANCEL', 'OPEN', 'REVEAL'] as const).map((action) =>
        z.object({ action: z.literal(action), ...Common }).strict(),
      ),
    ]),
  })
  .strict()

type ServicePort = Pick<WorkReportDocxServiceV1, 'execute'>

export interface XiaoguiWorkReportDocxWorkerToolOptionsV1 {
  getService: () => ServicePort
  scopeResolver: SessionScopeResolverV1
}

function failure(
  code: WorkerHostToolErrorCodeV1,
  message: string,
): WorkerHostToolOutcomeV1 {
  return { ok: false, error: { code, message } }
}

function messageForError(code: WorkReportDocxErrorCodeV1): string {
  switch (code) {
    case 'REPORT_DOCX_OPERATION_ACTIVE':
      return '当前已有不同的标准报告预览，请先确认或取消'
    case 'REPORT_DOCX_NO_PENDING_OPERATION':
      return '当前没有待处理的标准报告草稿'
    case 'REPORT_DOCX_CONFIRMATION_REQUIRED':
      return '请先查看 Word 预览，再在下一条消息中明确确认另存'
    case 'REPORT_DOCX_DRAFT_INVALID':
      return '报告草稿结构不完整；请整理标题、章节、段落和项目符号后重试'
    case 'REPORT_DOCX_DRAFT_TOO_LARGE':
      return '报告草稿超过 30000 字符，请精简后重试'
    case 'REPORT_DOCX_PREVIEW_MISSING':
    case 'REPORT_DOCX_PREVIEW_CHANGED':
      return '受控 Word 预览已丢失或变化，请用相同草稿重新准备并查看预览'
    case 'REPORT_DOCX_PREVIEW_OPEN_FAILED':
      return '标准 Word 预览已生成，但系统未能打开；修复 Word 文件关联后可恢复预览'
    case 'REPORT_DOCX_TARGET_EXISTS':
      return '目标文件已存在，小规不会覆盖；请选择新的文件名'
    case 'REPORT_DOCX_TARGET_INVALID':
      return '保存位置无效；标准报告只能另存为全新的 DOCX 文件'
    case 'REPORT_DOCX_NO_PUBLISHED_OUTPUT':
      return '没有可打开的已发布标准报告，或文件已移动或变化'
    case 'REPORT_DOCX_ABORTED':
      return '标准报告生成已取消'
    case 'REPORT_DOCX_SCOPE_NOT_FOUND':
    case 'REPORT_DOCX_SCOPE_MISMATCH':
      return '当前对话与项目范围不一致，请重新进入对应日常工作会话'
    case 'REPORT_DOCX_MODE_NOT_ALLOWED':
      return '标准报告生成只在日常工作会话中可用'
    default:
      return '标准报告生成失败；没有覆盖或修改已有文件'
  }
}

export function createXiaoguiWorkReportDocxWorkerToolHandlerV1(
  options: XiaoguiWorkReportDocxWorkerToolOptionsV1,
): WorkerHostToolRequestHandler {
  return async ({ request, sessionFile, fromSessionId, fromCwd, signal }) => {
    const parsed = RequestSchema.safeParse(request)
    if (!parsed.success) {
      return failure('HOST_TOOL_REQUEST_INVALID', '标准报告参数不完整，请重新表达需求')
    }
    if (!sessionFile || !fromSessionId) {
      return failure('SESSION_NOT_READY', '当前对话尚未建立完成，请重新进入会话后再试')
    }
    if (parsed.data.payload.sourceSessionId !== fromSessionId) {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请重新发起标准报告生成')
    }
    if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '标准报告生成已取消')
    let scope
    try {
      scope = await options.scopeResolver.resolveExisting({ rootPath: fromCwd, sessionFile })
    } catch {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未准备好日常工作能力')
    }
    if (!scope) return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未准备好日常工作能力')
    if (scope.sessionMode !== 'WORK') {
      return failure('REPORT_DOCX_MODE_NOT_ALLOWED', '标准报告生成只在日常工作会话中可用')
    }
    const address: SessionAddressV1 = {
      projectId: scope.projectId,
      sessionKey: scope.sessionKey,
    }
    try {
      const outcome = await options.getService().execute(address, parsed.data.payload, signal)
      if (!outcome.ok) return failure(outcome.error.code, messageForError(outcome.error.code))
      return { ok: true, value: outcome.value }
    } catch {
      return failure('HOST_TOOL_FAILED', '标准报告生成失败；没有覆盖或修改已有文件')
    }
  }
}
