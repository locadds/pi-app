import { z } from 'zod'

import {
  XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_METHOD_V1,
  type WorkerHostToolErrorCodeV1,
  type WorkerHostToolOutcomeV1,
} from '@shared/worker-host-tools'
import type { TemplateIntakeErrorCodeV1 } from '@shared/xiaogui-work-docx-template-intake'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

import type { WorkerHostToolRequestHandler } from '../worker-manager-types'
import type { SessionScopeResolverV1 } from './scope-resolver'
import type { WorkDocxTemplateIntakeServiceV1 } from './work-docx-template-intake-service'

const CommonSchema = z.object({
  sourceSessionId: z.string().trim().min(1).max(200),
  sourceRunId: z.string().trim().min(1).max(200),
  toolCallId: z.string().trim().min(1).max(200),
})

const CandidateKindSchema = z.enum([
  'FIXED',
  'VARIABLE',
  'REPEAT',
  'CONDITIONAL',
  'EXCLUDE',
  'UNRESOLVED',
])
const RiskFlagSchema = z.enum([
  'SIGNATURE',
  'SEAL',
  'CONTACT_INFORMATION',
  'OLD_PROJECT_DRAWING',
  'SCANNED_ATTACHMENT',
  'FLOATING_OBJECT',
  'TEXT_BOX',
  'OTHER',
])
const FinalDecisionSchema = CandidateKindSchema.exclude(['UNRESOLVED'])
const WarningCodeSchema = z.enum([
  'PAGE_COUNT_UNKNOWN',
  'SCAN_COUNT_UNKNOWN',
  'SEMANTIC_ALIGNMENT_FAILED',
  'SEMANTIC_COUNT_MISMATCH',
  'FLOATING_CONTENT_REQUIRES_REVIEW',
  'TEXT_BOX_REQUIRES_REVIEW',
  'MODEL_UNAVAILABLE',
  'MODEL_OUTPUT_INVALID',
  'ANALYSIS_LIMIT_EXCEEDED',
  'CANDIDATE_LIMIT_EXCEEDED',
  'REPORT_SIZE_LIMIT_EXCEEDED',
  'SOURCE_CHANGED',
  'OTHER',
])
const ReviewRangeSchema = z
  .object({
    startUtf16: z.number().int().nonnegative(),
    endUtf16Exclusive: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.endUtf16Exclusive > range.startUtf16, '文字范围无效')
const ReviewActionBaseSchema = {
  targetId: z.string().min(1).max(160),
  range: ReviewRangeSchema.optional(),
  highRiskOverrideReason: z.string().trim().min(1).max(1_000).optional(),
  highRiskOverrideConfirmed: z.literal(true).optional(),
}
const ReviewActionSchema = z.discriminatedUnion('kind', [
  z.object({ ...ReviewActionBaseSchema, kind: z.literal('KEEP') }).strict(),
  z.object({ ...ReviewActionBaseSchema, kind: z.literal('REMOVE') }).strict(),
  z.object({ ...ReviewActionBaseSchema, kind: z.literal('REPLACE_TEXT'), replacementText: z.string().max(20_000) }).strict(),
  z.object({ ...ReviewActionBaseSchema, kind: z.literal('FIELD'), fieldName: z.string().trim().min(1).max(120) }).strict(),
  z.object({ ...ReviewActionBaseSchema, kind: z.literal('REPLACE_IMAGE'), replacementImageToken: z.string().min(1).max(240) }).strict(),
  z.object({ ...ReviewActionBaseSchema, kind: z.literal('REPEAT'), blockName: z.string().trim().min(1).max(120) }).strict(),
  z.object({ ...ReviewActionBaseSchema, kind: z.literal('CONDITIONAL'), conditionName: z.string().trim().min(1).max(120) }).strict(),
])
const ModelSuggestionSchema = z
  .object({
    fragmentIds: z.array(z.string().min(1).max(160)).min(1).max(200),
    kind: CandidateKindSchema,
    reason: z.string().min(1).max(1_000),
    confidence: z.number().min(0).max(1).nullable(),
    suggestedName: z.string().min(1).max(120).optional(),
  })
  .strict()
const ModelAnalysisSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('COMPLETE'),
      modelVersion: z.string().min(1).max(300),
      suggestions: z.array(ModelSuggestionSchema).max(2_000),
    })
    .strict(),
  z
    .object({
      status: z.literal('DEGRADED'),
      modelVersion: z.string().min(1).max(300).nullable(),
      warning: z
        .object({ code: WarningCodeSchema, message: z.string().min(1).max(1_000) })
        .strict(),
    })
    .strict(),
])
const UpdateFieldsSchema = {
    decision: CandidateKindSchema,
    fieldName: z.string().trim().min(1).max(120).optional(),
    reason: z.string().trim().min(1).max(1_000).optional(),
    reviewActionsV2: z.array(ReviewActionSchema).max(400).optional(),
}
const UpdateOperationSchema = z.union([
  z
    .object({
      candidateIds: z.array(z.string().min(1).max(160)).min(1).max(200),
      ...UpdateFieldsSchema,
    })
    .strict(),
  z
    .object({
      match: z
        .object({
          kinds: z.array(CandidateKindSchema).min(1).max(6).optional(),
          riskFlags: z.array(RiskFlagSchema).min(1).max(8).optional(),
          keywords: z.array(z.string().trim().min(1).max(120)).min(1).max(20).optional(),
        })
        .strict()
        .refine(
          (match) => match.kinds !== undefined || match.riskFlags !== undefined || match.keywords !== undefined,
          '至少需要一个批量匹配条件',
        ),
      ...UpdateFieldsSchema,
    })
    .strict(),
])
const FinalDecisionItemSchema = z
  .object({
    candidateId: z.string().min(1).max(160),
    decision: FinalDecisionSchema,
    fieldName: z.string().trim().min(1).max(120).optional(),
    highRiskOverrideReason: z.string().trim().min(1).max(1_000).optional(),
    highRiskOverrideConfirmed: z.literal(true).optional(),
  })
  .strict()

const PayloadBaseSchema = z.discriminatedUnion('action', [
  CommonSchema.extend({
    action: z.literal('START'),
    analysis: ModelAnalysisSchema.optional(),
    reportId: z.string().min(1).max(160).optional(),
  })
    .strict(),
  CommonSchema.extend({
    action: z.literal('UPDATE'),
    operations: z.array(UpdateOperationSchema).min(1).max(200),
  }).strict(),
  CommonSchema.extend({
    action: z.literal('REOPEN'),
    operations: z.array(UpdateOperationSchema).min(1).max(200),
  }).strict(),
  CommonSchema.extend({
    action: z.literal('REVIEW'),
    submission: z
      .object({
        decisions: z.array(FinalDecisionItemSchema).max(200),
        reviewActionsV2: z.array(ReviewActionSchema).max(400).optional(),
      })
      .strict()
      .optional(),
  }).strict(),
  CommonSchema.extend({
    action: z.literal('RESUME'),
    reportId: z.string().min(1).max(160).optional(),
  }).strict(),
  CommonSchema.extend({
    action: z.literal('DELETE'),
    reportId: z.string().min(1).max(160),
    confirmed: z.literal(true),
  }).strict(),
  CommonSchema.extend({ action: z.literal('CANCEL') }).strict(),
])
const PayloadSchema = PayloadBaseSchema.superRefine((payload, context) => {
  if (
    payload.action === 'START' &&
    ((payload.analysis === undefined) !== (payload.reportId === undefined))
  ) {
    context.addIssue({ code: 'custom', message: '分析结果必须绑定报告编号' })
  }
})

const RequestSchema = z
  .object({
    type: z.literal('host-tool-request'),
    requestId: z.string().min(1).max(200),
    method: z.literal(XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_METHOD_V1),
    payload: PayloadSchema,
  })
  .strict()

type TemplateIntakeWorkerToolServiceV1 = Pick<WorkDocxTemplateIntakeServiceV1, 'execute'>

export interface XiaoguiWorkDocxTemplateIntakeWorkerToolOptionsV1 {
  scopeResolver: SessionScopeResolverV1
  getService: () => TemplateIntakeWorkerToolServiceV1
}

function failure(code: WorkerHostToolErrorCodeV1, message: string): WorkerHostToolOutcomeV1 {
  return { ok: false, error: { code, message } }
}

function messageForError(code: TemplateIntakeErrorCodeV1): string {
  switch (code) {
    case 'TEMPLATE_INTAKE_SCOPE_NOT_FOUND':
    case 'TEMPLATE_INTAKE_SCOPE_MISMATCH':
      return '当前会话尚未准备好文档整理能力，请重新进入会话后再试'
    case 'TEMPLATE_INTAKE_MODE_NOT_ALLOWED':
      return '普通成品文档整理只在日常工作会话中可用'
    case 'TEMPLATE_INTAKE_INPUT_INVALID':
      return '整理操作参数或所选文档不符合要求，请检查后重试'
    case 'TEMPLATE_INTAKE_INPUT_TOO_LARGE':
      return '文档、提取内容或整理报告超过安全上限，未进行静默截断'
    case 'TEMPLATE_INTAKE_UNSAFE_DOCX':
      return '所选文档未通过本地安全检查，请更换文档'
    case 'TEMPLATE_INTAKE_UNSAFE_DOC':
      return '所选旧版 DOC 结构异常、加密或包含不支持的对象，请更换文档'
    case 'TEMPLATE_INTAKE_CONVERSION_FAILED':
      return '旧版 DOC 暂时无法转换为内部 DOCX，请确认小规文档渲染组件可用后重试'
    case 'TEMPLATE_INTAKE_OPERATION_ACTIVE':
      return '当前会话已有一份文档正在分析，请等待完成或先取消'
    case 'TEMPLATE_INTAKE_REPORT_NOT_FOUND':
      return '当前会话没有可继续的模板整理报告，请重新开始'
    case 'TEMPLATE_INTAKE_REPORT_LIMIT_REACHED':
      return '已确认报告达到保存上限，请先明确删除一份旧记录'
    case 'TEMPLATE_INTAKE_SOURCE_MISSING':
      return '源文档已丢失，且没有重新选择摘要相同的文件'
    case 'TEMPLATE_INTAKE_SOURCE_CHANGED':
      return '源文档已变化，原整理报告已失效，必须重新分析'
    case 'TEMPLATE_INTAKE_PARSER_FAILED':
      return '文档解析失败或超时，没有创建不完整报告'
    case 'TEMPLATE_INTAKE_REPORT_NOT_CONFIRMABLE':
      return '仍有未解决候选或决定清单不完整，暂不能提交确认'
    case 'TEMPLATE_INTAKE_HIGH_RISK_REASON_REQUIRED':
      return '高风险内容不再排除时必须填写覆盖理由'
    case 'TEMPLATE_INTAKE_SECOND_CONFIRMATION_REQUIRED':
      return '高风险覆盖尚未完成第二次确认'
    case 'TEMPLATE_INTAKE_DELETE_CONFIRMATION_REQUIRED':
      return '删除历史报告前需要用户明确确认'
    case 'TEMPLATE_INTAKE_STORAGE_FAILED':
      return '整理报告的本地私有存储失败，请稍后重试'
    case 'TEMPLATE_INTAKE_ABORTED':
      return '模板整理已取消，没有修改文档'
  }
}

function scopeKey(address: SessionAddressV1): string {
  return `${address.projectId}\0${address.sessionKey}`
}

export function createXiaoguiWorkDocxTemplateIntakeWorkerToolHandlerV1(
  options: XiaoguiWorkDocxTemplateIntakeWorkerToolOptionsV1,
): WorkerHostToolRequestHandler {
  const inFlightScopes = new Set<string>()

  return async ({ request, fromCwd, sessionFile, fromSessionId, signal }) => {
    const parsed = RequestSchema.safeParse(request)
    if (!parsed.success) {
      return failure('HOST_TOOL_REQUEST_INVALID', '文档整理参数不完整，请重新表达需求后再试')
    }
    if (!sessionFile || !fromSessionId) {
      return failure('SESSION_NOT_READY', '当前对话尚未建立完成，请重新进入会话后再试')
    }
    if (parsed.data.payload.sourceSessionId !== fromSessionId) {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请重新发起文档整理')
    }
    if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '文档整理已取消')

    let scope
    try {
      scope = await options.scopeResolver.resolveExisting({ rootPath: fromCwd, sessionFile })
    } catch {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未准备好日常工作能力')
    }
    if (!scope) return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未准备好日常工作能力')
    if (scope.sessionMode !== 'WORK') {
      return failure('TEMPLATE_INTAKE_MODE_NOT_ALLOWED', '普通成品文档整理只在日常工作会话中可用')
    }
    const address: SessionAddressV1 = {
      projectId: scope.projectId,
      sessionKey: scope.sessionKey,
    }
    const key = scopeKey(address)
    if (inFlightScopes.has(key)) {
      return failure('TEMPLATE_INTAKE_OPERATION_ACTIVE', '当前会话正在处理另一项文档整理操作')
    }
    inFlightScopes.add(key)
    try {
      const outcome = await options.getService().execute(address, parsed.data.payload, signal)
      if (!outcome.ok) return failure(outcome.error.code, messageForError(outcome.error.code))
      if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '文档整理已取消')
      return { ok: true, value: outcome.value }
    } catch {
      return failure('HOST_TOOL_FAILED', '文档整理失败，请稍后重试')
    } finally {
      inFlightScopes.delete(key)
    }
  }
}
