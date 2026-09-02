import { z } from 'zod'

import {
  XIAOGUI_WORK_DOCX_METHOD_V1,
  type XiaoguiWorkDocxResultV1,
  type WorkerHostToolErrorCodeV1,
  type WorkerHostToolOutcomeV1,
} from '@shared/worker-host-tools'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import type {
  WorkDocxErrorCodeV1,
  WorkDocxOperationIdV1,
} from '@shared/xiaogui-work-docx'

import type { WorkerHostToolRequestHandler } from '../worker-manager-types'
import type { SessionScopeResolverV1 } from './scope-resolver'
import type { WorkDocxServiceV1 } from './work-docx-service'

const RequestSchema = z
  .object({
    type: z.literal('host-tool-request'),
    requestId: z.string().min(1).max(200),
    method: z.literal(XIAOGUI_WORK_DOCX_METHOD_V1),
    payload: z
      .object({
        action: z.enum(['PREPARE', 'CONFIRM', 'CANCEL', 'OPEN', 'REVEAL']),
        sourceSessionId: z.string().trim().min(1).max(200),
        sourceRunId: z.string().trim().min(1).max(200),
        toolCallId: z.string().trim().min(1).max(200),
      })
      .strict(),
  })
  .strict()

type WorkDocxWorkerToolServiceV1 = Pick<
  WorkDocxServiceV1,
  'prepare' | 'confirm' | 'cancel' | 'accessOutput'
>

export interface XiaoguiWorkDocxWorkerToolOptionsV1 {
  scopeResolver: SessionScopeResolverV1
  getService: () => WorkDocxWorkerToolServiceV1
}

type PendingOperation = {
  operationId: WorkDocxOperationIdV1
  sourceSessionId: string
  preparedRunId: string
  summary: Extract<XiaoguiWorkDocxResultV1, { kind: 'XIAOGUI_WORK_DOCX_PREPARED' }>
}

type PublishedOperation = {
  operationId: WorkDocxOperationIdV1
  sourceSessionId: string
}

function failure(
  code: WorkerHostToolErrorCodeV1,
  message: string,
): WorkerHostToolOutcomeV1 {
  return { ok: false, error: { code, message } }
}

function messageForWorkDocxError(code: WorkDocxErrorCodeV1): string {
  switch (code) {
    case 'SCOPE_NOT_FOUND':
    case 'SCOPE_MISMATCH':
      return '当前会话尚未准备好日常工作能力，请重新进入会话后再试'
    case 'MODE_NOT_ALLOWED':
      return '文档生成只在日常工作会话中可用'
    case 'INPUT_INVALID':
      return '所选模板、数据或保存位置不符合要求，请重新选择'
    case 'INPUT_TOO_LARGE':
      return '所选模板或数据文件过大，请换一个文件后重试'
    case 'UNSAFE_DOCX':
      return '所选模板包含不安全或不受支持的内容，请更换模板'
    case 'PLACEHOLDER_MISSING':
      return '模板字段与数据不匹配，请检查后重新选择'
    case 'TARGET_EXISTS':
      return '保存位置已有同名文件，请选择一个新的文件名'
    case 'SOURCE_CHANGED':
      return '模板或数据在确认前发生了变化，请重新准备'
    case 'OUTPUT_ACCESS_FAILED':
      return '文档已生成，但系统暂时无法打开或显示它'
    case 'OPERATION_NOT_FOUND':
    case 'OPERATION_SCOPE_MISMATCH':
      return '当前会话没有可继续的文档操作，请重新发起'
    case 'GENERATION_FAILED':
    case 'PUBLISH_FAILED':
      return '文档生成失败，没有完成发布，请重新准备后再试'
  }
}

function fromServiceFailure(code: WorkDocxErrorCodeV1): WorkerHostToolOutcomeV1 {
  return failure(code, messageForWorkDocxError(code))
}

function scopeKey(address: SessionAddressV1): string {
  return `${address.projectId}\0${address.sessionKey}`
}

/**
 * Pi 自然语言工具到既有 WorkDocxServiceV1 的主进程 Adapter。
 * operationId 只保存在这里，Worker/模型只表达动作；会话地址只由可信来源派生。
 */
export function createXiaoguiWorkDocxWorkerToolHandlerV1(
  options: XiaoguiWorkDocxWorkerToolOptionsV1,
): WorkerHostToolRequestHandler {
  const pendingByScope = new Map<string, PendingOperation>()
  const publishedByScope = new Map<string, PublishedOperation>()
  const inFlightScopes = new Set<string>()

  return async ({ request, fromCwd, sessionFile, fromSessionId, signal }) => {
    const parsed = RequestSchema.safeParse(request)
    if (!parsed.success) {
      return failure('HOST_TOOL_REQUEST_INVALID', '文档操作参数不完整，请重新表达需求后再试')
    }
    if (!sessionFile || !fromSessionId) {
      return failure('SESSION_NOT_READY', '当前对话尚未建立完成，请重新进入会话后再试')
    }
    if (parsed.data.payload.sourceSessionId !== fromSessionId) {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请在当前会话中重新发起文档操作')
    }
    if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '文档操作已取消')

    let scope
    try {
      scope = await options.scopeResolver.resolveExisting({ rootPath: fromCwd, sessionFile })
    } catch {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未准备好日常工作能力，请重新进入会话后再试')
    }
    if (!scope) {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未准备好日常工作能力，请重新进入会话后再试')
    }
    if (scope.sessionMode !== 'WORK') {
      return failure('MODE_NOT_ALLOWED', '文档生成只在日常工作会话中可用')
    }
    if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '文档操作已取消')

    const address: SessionAddressV1 = {
      projectId: scope.projectId,
      sessionKey: scope.sessionKey,
    }
    const key = scopeKey(address)
    if (inFlightScopes.has(key)) {
      return failure('WORK_DOCX_OPERATION_ACTIVE', '当前会话正在处理另一项文档操作，请稍后再试')
    }
    inFlightScopes.add(key)

    try {
      const { action, sourceSessionId, sourceRunId } = parsed.data.payload

      if (action === 'PREPARE') {
        const existing = pendingByScope.get(key)
        if (existing) {
          if (existing.sourceSessionId !== sourceSessionId) {
            return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请重新发起文档操作')
          }
          // 重新展示同一安全摘要，并从本次用户 run 重新开始确认门。
          existing.preparedRunId = sourceRunId
          return { ok: true, value: existing.summary }
        }
        const service = options.getService()
        const outcome = await service.prepare({ address })
        if (!outcome.ok) return fromServiceFailure(outcome.error.code)
        if (outcome.value.kind === 'CANCELLED') {
          return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED' } }
        }
        const summary: Extract<
          XiaoguiWorkDocxResultV1,
          { kind: 'XIAOGUI_WORK_DOCX_PREPARED' }
        > = {
          kind: 'XIAOGUI_WORK_DOCX_PREPARED',
          templateDisplayName: outcome.value.templateDisplayName,
          payloadDisplayName: outcome.value.payloadDisplayName,
          placeholders: outcome.value.placeholders,
          templateSha256: outcome.value.templateSha256,
          payloadSha256: outcome.value.payloadSha256,
        }
        const pending: PendingOperation = {
          operationId: outcome.value.operationId,
          sourceSessionId,
          preparedRunId: sourceRunId,
          summary,
        }
        if (signal?.aborted) {
          const cleanup = await service.cancel({ address, operationId: pending.operationId })
          if (!cleanup.ok) pendingByScope.set(key, pending)
          return failure('HOST_TOOL_ABORTED', '文件选择已取消；如仍有待确认文档，可重新发起以查看摘要')
        }
        pendingByScope.set(key, pending)
        return { ok: true, value: summary }
      }

      if (action === 'CONFIRM' || action === 'CANCEL') {
        const pending = pendingByScope.get(key)
        if (!pending) {
          return failure('WORK_DOCX_NO_PENDING_OPERATION', '当前会话没有等待确认的文档，请先发起生成需求')
        }
        if (pending.sourceSessionId !== sourceSessionId) {
          return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请重新发起文档操作')
        }
        if (pending.preparedRunId === sourceRunId) {
          return failure(
            'WORK_DOCX_CONFIRMATION_REQUIRED',
            '文档尚未生成，请等待用户下一条消息明确确认或取消',
          )
        }

        if (action === 'CANCEL') {
          const service = options.getService()
          const outcome = await service.cancel({ address, operationId: pending.operationId })
          if (!outcome.ok) {
            if (outcome.error.code !== 'PUBLISH_FAILED') pendingByScope.delete(key)
            return fromServiceFailure(outcome.error.code)
          }
          pendingByScope.delete(key)
          return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_CANCELLED' } }
        }

        const service = options.getService()
        const outcome = await service.confirm({ address, operationId: pending.operationId })
        pendingByScope.delete(key)
        if (!outcome.ok) return fromServiceFailure(outcome.error.code)
        publishedByScope.set(key, {
          operationId: outcome.value.operationId,
          sourceSessionId,
        })
        return {
          ok: true,
          value: {
            kind: 'XIAOGUI_WORK_DOCX_PUBLISHED',
            outputSha256: outcome.value.outputSha256,
            templateSha256: outcome.value.templateSha256,
            payloadSha256: outcome.value.payloadSha256,
            originalInputsUnchanged: outcome.value.originalInputsUnchanged,
          },
        }
      }

      const published = publishedByScope.get(key)
      if (!published) {
        return failure('WORK_DOCX_NO_PUBLISHED_OUTPUT', '当前会话还没有已生成的文档')
      }
      if (published.sourceSessionId !== sourceSessionId) {
        return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，不能访问其他会话的文档')
      }
      const accessAction = action === 'OPEN' ? 'OPEN' : 'REVEAL'
      const service = options.getService()
      const outcome = await service.accessOutput({
        address,
        operationId: published.operationId,
        action: accessAction,
      })
      if (!outcome.ok) return fromServiceFailure(outcome.error.code)
      return {
        ok: true,
        value: { kind: 'XIAOGUI_WORK_DOCX_ACCESSED', action: outcome.value.action },
      }
    } catch {
      return failure('HOST_TOOL_FAILED', '文档操作失败，请稍后重试')
    } finally {
      inFlightScopes.delete(key)
    }
  }
}

export type { WorkDocxWorkerToolServiceV1 }
