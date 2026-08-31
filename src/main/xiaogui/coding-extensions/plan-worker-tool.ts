import { z } from 'zod'

import type {
  CodingPlanPendingDraftReceiptV1,
  CodingPlanPendingDraftV1,
} from '@shared/xiaogui-coding-extension-pack'
import {
  XIAOGUI_CODING_PLAN_DRAFT_METHOD_V1,
  type WorkerHostToolErrorCodeV1,
  type WorkerHostToolOutcomeV1,
} from '@shared/worker-host-tools'

import type { WorkerHostToolRequestHandler } from '../../worker-manager-types'
import type { SessionScopeResolverV1 } from '../scope-resolver'

const StepSchema = z
  .object({
    stepId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    title: z.string().trim().min(1).max(1000),
    validation: z.string().trim().min(1).max(2000),
  })
  .strict()

const BodySchema = z
  .object({
    objective: z.string().trim().min(1).max(8000),
    steps: z.array(StepSchema).min(1).max(128),
    constraints: z.array(z.string().trim().min(1).max(2000)).max(128),
  })
  .strict()
  .superRefine((body, context) => {
    const ids = new Set<string>()
    for (const [index, step] of body.steps.entries()) {
      if (ids.has(step.stepId)) {
        context.addIssue({
          code: 'custom',
          path: ['steps', index, 'stepId'],
          message: 'stepId must be unique',
        })
      }
      ids.add(step.stepId)
    }
  })

const RequestSchema = z
  .object({
    type: z.literal('host-tool-request'),
    requestId: z.string().min(1).max(200),
    method: z.literal(XIAOGUI_CODING_PLAN_DRAFT_METHOD_V1),
    payload: z
      .object({
        sourceSessionId: z.string().trim().min(1).max(200),
        sourceTurnId: z.string().trim().min(1).max(200).optional(),
        toolCallId: z.string().trim().min(1).max(200),
        body: BodySchema,
      })
      .strict(),
  })
  .strict()

export interface XiaoguiCodingPlanWorkerToolHandlerOptionsV1 {
  readonly scopeResolver: SessionScopeResolverV1
  readonly publishPendingDraft: (
    input: CodingPlanPendingDraftV1,
  ) => CodingPlanPendingDraftReceiptV1 | Promise<CodingPlanPendingDraftReceiptV1>
}

function failure(
  code: WorkerHostToolErrorCodeV1,
  message: string,
): WorkerHostToolOutcomeV1 {
  return { ok: false, error: { code, message } }
}

/**
 * Trusted Worker-to-TaskHub adapter for CODING PLAN drafts. The model request
 * never supplies a SessionAddress; Main derives it from the bound session.
 */
export function createXiaoguiCodingPlanWorkerToolHandlerV1(
  options: XiaoguiCodingPlanWorkerToolHandlerOptionsV1,
): WorkerHostToolRequestHandler {
  return async ({ request, fromCwd, sessionFile, fromSessionId }) => {
    const parsed = RequestSchema.safeParse(request)
    if (!parsed.success) {
      return failure('HOST_TOOL_REQUEST_INVALID', '编程计划内容不完整，请重新整理后再试')
    }
    if (!sessionFile) {
      return failure('SESSION_NOT_READY', '当前对话尚未建立完成，请重新进入会话后再试')
    }
    if (!fromSessionId || parsed.data.payload.sourceSessionId !== fromSessionId) {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请在当前会话中重新提交计划')
    }

    let scope
    try {
      scope = await options.scopeResolver.resolveExisting({ rootPath: fromCwd, sessionFile })
    } catch {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未完成小规作用域绑定，请重新进入会话后再试')
    }
    if (!scope) {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未完成小规作用域绑定，请重新进入会话后再试')
    }
    if (scope.sessionMode !== 'CODING') {
      return failure('CODING_PLAN_MODE_REQUIRED', '编程计划草稿只能在编程模式的计划阶段提交')
    }

    let receipt: CodingPlanPendingDraftReceiptV1
    try {
      receipt = await options.publishPendingDraft({
        schemaVersion: 1,
        address: { projectId: scope.projectId, sessionKey: scope.sessionKey },
        body: parsed.data.payload.body,
      })
    } catch {
      return failure('HOST_TOOL_FAILED', '编程计划草稿保存失败，请稍后重试')
    }
    if (!receipt.ok) {
      return failure('CODING_PLAN_DRAFT_INVALID', '编程计划内容不完整，请重新整理后再试')
    }
    return { ok: true, value: { kind: 'XIAOGUI_CODING_PLAN_DRAFT_SAVED' } }
  }
}
