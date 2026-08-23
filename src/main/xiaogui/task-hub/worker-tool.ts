import { z } from 'zod'

import {
  XIAOGUI_CREATE_COLLABORATION_PLAN_METHOD_V1,
  type WorkerHostToolErrorCodeV1,
  type WorkerHostToolOutcomeV1,
} from '@shared/worker-host-tools'

import type { WorkerHostToolRequestHandler } from '../../worker-manager-types'
import type { SessionScopeResolverV1 } from '../scope-resolver'
import type { CollaborationHubApplicationV1 } from './application'

const TaskSchema = z
  .object({
    taskKey: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(1200).optional(),
    dependsOn: z.array(z.string().trim().min(1).max(80)).max(32).optional(),
  })
  .strict()

const RequestSchema = z
  .object({
    type: z.literal('host-tool-request'),
    requestId: z.string().min(1).max(200),
    method: z.literal(XIAOGUI_CREATE_COLLABORATION_PLAN_METHOD_V1),
    payload: z
      .object({
        draft: z
          .object({
            objective: z.string().trim().min(1).max(4000),
            tasks: z.array(TaskSchema).min(1).max(32),
          })
          .strict(),
        sourceSessionId: z.string().trim().min(1).max(200),
        sourceTurnId: z.string().min(1).max(200).optional(),
        toolCallId: z.string().min(1).max(200),
      })
      .strict(),
  })
  .strict()

export interface XiaoguiWorkerToolHandlerOptionsV1 {
  application: CollaborationHubApplicationV1
  scopeResolver: SessionScopeResolverV1
}

function failure(
  code: WorkerHostToolErrorCodeV1,
  message: string,
  traceId?: string,
): WorkerHostToolOutcomeV1 {
  return { ok: false, error: { code, message, ...(traceId ? { traceId } : {}) } }
}

function messageForHubError(code: string): string {
  switch (code) {
    case 'DESIGN_RESERVED':
      return '规划设计模式目前只保留接口，不能创建执行计划'
    case 'DRAFT_INVALID':
      return '协作计划的任务或依赖关系不完整，请重新整理后再试'
    case 'ACTIVE_FLOW_EXISTS':
      return '当前会话已有一份进行中的协作计划，请先完成或取消它'
    case 'SESSION_SCOPE_MISMATCH':
      return '当前会话尚未完成小规作用域绑定，请重新进入会话后再试'
    default:
      return '协作计划草稿创建失败，请稍后重试'
  }
}

function errorCodeForHubError(code: string): WorkerHostToolErrorCodeV1 {
  switch (code) {
    case 'DESIGN_RESERVED':
    case 'DRAFT_INVALID':
    case 'ACTIVE_FLOW_EXISTS':
    case 'SESSION_SCOPE_MISMATCH':
      return code
    default:
      return 'HOST_TOOL_FAILED'
  }
}

/**
 * Pi 工具到任务中枢的唯一主进程 Adapter。
 * 会话地址始终由可信的 cwd + sessionFile 推导，不接受模型传入地址。
 */
export function createXiaoguiWorkerToolHandlerV1(
  options: XiaoguiWorkerToolHandlerOptionsV1,
): WorkerHostToolRequestHandler {
  return async ({ request, fromCwd, sessionFile, fromSessionId }) => {
    const parsed = RequestSchema.safeParse(request)
    if (!parsed.success) {
      return failure('HOST_TOOL_REQUEST_INVALID', '协作计划参数不完整，请重新整理后再试')
    }
    if (!sessionFile) {
      return failure('SESSION_NOT_READY', '当前对话尚未建立完成，请重新进入会话后再试')
    }
    if (!fromSessionId || parsed.data.payload.sourceSessionId !== fromSessionId) {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请在当前会话中重新发起协作计划')
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
    if (scope.sessionMode === 'DESIGN') {
      return failure('DESIGN_RESERVED', '规划设计模式目前只保留接口，不能创建执行计划')
    }

    const outcome = await options.application.perform(
      { projectId: scope.projectId, sessionKey: scope.sessionKey },
      {
        requestId: `pi-tool:${parsed.data.payload.toolCallId}`,
        intent: {
          type: 'flow.start.with_draft',
          draft: parsed.data.payload.draft,
          ...(parsed.data.payload.sourceTurnId
            ? { sourceTurnId: parsed.data.payload.sourceTurnId }
            : {}),
        },
      },
    )
    if (!outcome.ok) {
      return failure(
        errorCodeForHubError(outcome.error.code),
        messageForHubError(outcome.error.code),
        outcome.error.traceId,
      )
    }
    return {
      ok: true,
      value: {
        kind: 'XIAOGUI_COLLABORATION_DRAFT_CREATED',
        taskCount: parsed.data.payload.draft.tasks.length,
        sessionVersion: outcome.value.sessionVersion,
      },
    }
  }
}
