import { z } from 'zod'

import {
  XIAOGUI_WORK_DOCX_TEMPLATE_DATA_METHOD_V1,
  type XiaoguiWorkDocxTemplateDataResultV1,
  type WorkerHostToolErrorCodeV1,
  type WorkerHostToolOutcomeV1,
} from '@shared/worker-host-tools'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import type { WorkDocxErrorCodeV1, WorkDocxOperationIdV1 } from '@shared/xiaogui-work-docx'

import type { WorkerHostToolRequestHandler } from '../worker-manager-types'
import type { SessionScopeResolverV1 } from './scope-resolver'
import type { WorkDocxServiceV1, WorkDocxTemplateSelectionIdV1 } from './work-docx-service'

const FieldSchema = z.discriminatedUnion('status', [
  z
    .object({
      name: z.string().min(1).max(64),
      status: z.literal('READY'),
      value: z.union([z.string().max(20_000), z.number().finite(), z.boolean()]),
      sourceSummary: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1).max(64),
      status: z.literal('UNRESOLVED'),
      sourceSummary: z.string().max(500).optional(),
    })
    .strict(),
])

const RequestSchema = z
  .object({
    type: z.literal('host-tool-request'),
    requestId: z.string().min(1).max(200),
    method: z.literal(XIAOGUI_WORK_DOCX_TEMPLATE_DATA_METHOD_V1),
    payload: z
      .object({
        action: z.enum(['SELECT_TEMPLATE', 'PREPARE', 'CONFIRM', 'CANCEL', 'OPEN', 'REVEAL']),
        fields: z.array(FieldSchema).max(200).optional(),
        sourceSessionId: z.string().trim().min(1).max(200),
        sourceRunId: z.string().trim().min(1).max(200),
        toolCallId: z.string().trim().min(1).max(200),
      })
      .strict()
      .superRefine((payload, context) => {
        if ((payload.action === 'PREPARE') !== (payload.fields !== undefined)) {
          context.addIssue({ code: 'custom', message: 'PREPARE 必须且只能携带字段清单' })
        }
      }),
  })
  .strict()

type WorkDocxTemplateDataWorkerToolServiceV1 = Pick<
  WorkDocxServiceV1,
  | 'selectTemplate'
  | 'prepareTemplateData'
  | 'cancelTemplateSelection'
  | 'confirmTemplateData'
  | 'cancel'
  | 'accessOutput'
>

export interface XiaoguiWorkDocxTemplateDataWorkerToolOptionsV1 {
  scopeResolver: SessionScopeResolverV1
  getService: () => WorkDocxTemplateDataWorkerToolServiceV1
}

type SelectedTemplate = {
  selectionId: WorkDocxTemplateSelectionIdV1
  sourceSessionId: string
  summary: Extract<
    XiaoguiWorkDocxTemplateDataResultV1,
    { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_SELECTED' }
  >
}

type PendingOperation = {
  operationId: WorkDocxOperationIdV1
  sourceSessionId: string
  preparedRunId: string
  summary: Extract<XiaoguiWorkDocxTemplateDataResultV1, { kind: 'XIAOGUI_WORK_DOCX_PREPARED' }>
}

type PublishedOperation = {
  operationId: WorkDocxOperationIdV1
  sourceSessionId: string
}

function failure(code: WorkerHostToolErrorCodeV1, message: string): WorkerHostToolOutcomeV1 {
  return { ok: false, error: { code, message } }
}

function messageForWorkDocxError(code: WorkDocxErrorCodeV1): string {
  switch (code) {
    case 'SCOPE_NOT_FOUND':
    case 'SCOPE_MISMATCH':
      return '当前会话尚未准备好日常工作能力，请重新进入会话后再试'
    case 'MODE_NOT_ALLOWED':
      return '模板生成只在日常工作会话中可用'
    case 'INPUT_INVALID':
      return '模板字段或保存位置不符合要求，请检查后重试'
    case 'INPUT_TOO_LARGE':
      return '模板或字段内容超过处理上限，请精简后重试'
    case 'UNSAFE_DOCX':
      return '所选模板包含不安全或不受支持的内容，请更换模板'
    case 'PLACEHOLDER_MISSING':
      return '提交的字段与模板不一致，请按字段清单重新补齐'
    case 'TARGET_EXISTS':
      return '保存位置已有同名文件，请选择一个新的文件名'
    case 'SOURCE_CHANGED':
      return '模板在填写期间发生了变化，请重新选择模板'
    case 'OUTPUT_ACCESS_FAILED':
      return '文档已生成，但系统暂时无法打开或显示它'
    case 'OPERATION_NOT_FOUND':
    case 'OPERATION_SCOPE_MISMATCH':
      return '当前会话没有可继续的模板操作，请重新发起'
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
 * 模型只提交字段状态；模板路径、选择编号和发布编号始终由主进程绑定到可信会话。
 */
export function createXiaoguiWorkDocxTemplateDataWorkerToolHandlerV1(
  options: XiaoguiWorkDocxTemplateDataWorkerToolOptionsV1,
): WorkerHostToolRequestHandler {
  const selectedByScope = new Map<string, SelectedTemplate>()
  const pendingByScope = new Map<string, PendingOperation>()
  const publishedByScope = new Map<string, PublishedOperation>()
  const inFlightScopes = new Set<string>()

  return async ({ request, fromCwd, sessionFile, fromSessionId, signal }) => {
    const parsed = RequestSchema.safeParse(request)
    if (!parsed.success) {
      return failure('HOST_TOOL_REQUEST_INVALID', '模板操作参数不完整，请重新表达需求后再试')
    }
    if (!sessionFile || !fromSessionId) {
      return failure('SESSION_NOT_READY', '当前对话尚未建立完成，请重新进入会话后再试')
    }
    if (parsed.data.payload.sourceSessionId !== fromSessionId) {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请在当前会话中重新发起模板操作')
    }
    if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '模板操作已取消')

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
      return failure('MODE_NOT_ALLOWED', '模板生成只在日常工作会话中可用')
    }
    if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '模板操作已取消')

    const address: SessionAddressV1 = { projectId: scope.projectId, sessionKey: scope.sessionKey }
    const key = scopeKey(address)
    if (inFlightScopes.has(key)) {
      return failure('WORK_DOCX_OPERATION_ACTIVE', '当前会话正在处理另一项模板操作，请稍后再试')
    }
    inFlightScopes.add(key)

    try {
      const { action, fields, sourceSessionId, sourceRunId } = parsed.data.payload
      const service = options.getService()

      if (action === 'SELECT_TEMPLATE') {
        if (pendingByScope.has(key)) {
          return failure('WORK_DOCX_OPERATION_ACTIVE', '已有文档等待确认，请先确认或取消')
        }
        const existing = selectedByScope.get(key)
        if (existing) {
          if (existing.sourceSessionId !== sourceSessionId) {
            return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请重新发起模板操作')
          }
          return { ok: true, value: existing.summary }
        }
        const outcome = await service.selectTemplate({ address })
        if (!outcome.ok) return fromServiceFailure(outcome.error.code)
        if (outcome.value.kind === 'CANCELLED') {
          return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED' } }
        }
        if (outcome.value.kind === 'TEMPLATE_PREPARATION_REQUIRED') {
          return {
            ok: true,
            value: {
              kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_PREPARATION_REQUIRED',
              templateDisplayName: outcome.value.templateDisplayName,
              templateSha256: outcome.value.templateSha256,
              profile: outcome.value.profile,
            },
          }
        }
        const summary: SelectedTemplate['summary'] = {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_SELECTED',
          templateDisplayName: outcome.value.templateDisplayName,
          templateSha256: outcome.value.templateSha256,
          fields: outcome.value.fields,
          profile: outcome.value.profile,
        }
        const selected: SelectedTemplate = {
          selectionId: outcome.value.selectionId,
          sourceSessionId,
          summary,
        }
        if (signal?.aborted) {
          const cleanup = await service.cancelTemplateSelection({
            address,
            selectionId: selected.selectionId,
          })
          if (!cleanup.ok) selectedByScope.set(key, selected)
          return failure('HOST_TOOL_ABORTED', '模板选择已取消')
        }
        selectedByScope.set(key, selected)
        return { ok: true, value: summary }
      }

      if (action === 'PREPARE') {
        const pending = pendingByScope.get(key)
        if (pending) {
          if (pending.sourceSessionId !== sourceSessionId) {
            return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请重新发起模板操作')
          }
          return failure(
            'WORK_DOCX_OPERATION_ACTIVE',
            '已有文档等待确认；如需修改，请先取消当前文档，再重新选择模板并准备',
          )
        }
        const selected = selectedByScope.get(key)
        if (!selected || !fields) {
          return failure('WORK_DOCX_NO_PENDING_OPERATION', '当前会话尚未选择模板，请先选择模板')
        }
        if (selected.sourceSessionId !== sourceSessionId) {
          return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请重新发起模板操作')
        }
        const outcome = await service.prepareTemplateData({
          address,
          selectionId: selected.selectionId,
          fields,
        })
        if (!outcome.ok) {
          if (outcome.error.code === 'SOURCE_CHANGED' || outcome.error.code === 'OPERATION_NOT_FOUND') {
            selectedByScope.delete(key)
          }
          return fromServiceFailure(outcome.error.code)
        }
        if (outcome.value.kind === 'INPUT_REQUIRED') {
          return {
            ok: true,
            value: {
              kind: 'XIAOGUI_WORK_DOCX_INPUT_REQUIRED',
              unresolvedFields: outcome.value.unresolvedFields,
            },
          }
        }
        if (outcome.value.kind === 'CANCELLED') {
          return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_TARGET_SELECTION_CANCELLED' } }
        }
        selectedByScope.delete(key)
        const summary: PendingOperation['summary'] = {
          kind: 'XIAOGUI_WORK_DOCX_PREPARED',
          templateDisplayName: outcome.value.templateDisplayName,
          fields: outcome.value.fields,
          templateSha256: outcome.value.templateSha256,
          dataSha256: outcome.value.dataSha256,
        }
        const prepared: PendingOperation = {
          operationId: outcome.value.operationId,
          sourceSessionId,
          preparedRunId: sourceRunId,
          summary,
        }
        if (signal?.aborted) {
          const cleanup = await service.cancel({ address, operationId: prepared.operationId })
          if (!cleanup.ok) pendingByScope.set(key, prepared)
          return failure('HOST_TOOL_ABORTED', '模板生成准备已取消')
        }
        pendingByScope.set(key, prepared)
        return { ok: true, value: summary }
      }

      if (action === 'CONFIRM') {
        const pending = pendingByScope.get(key)
        if (!pending) {
          return failure('WORK_DOCX_NO_PENDING_OPERATION', '当前会话没有等待确认的文档，请先补齐模板字段')
        }
        if (pending.sourceSessionId !== sourceSessionId) {
          return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请重新发起模板操作')
        }
        if (pending.preparedRunId === sourceRunId) {
          return failure('WORK_DOCX_CONFIRMATION_REQUIRED', '文档尚未生成，请等待用户下一条消息明确确认')
        }
        const outcome = await service.confirmTemplateData({ address, operationId: pending.operationId })
        pendingByScope.delete(key)
        if (!outcome.ok) return fromServiceFailure(outcome.error.code)
        publishedByScope.set(key, { operationId: outcome.value.operationId, sourceSessionId })
        return {
          ok: true,
          value: {
            kind: 'XIAOGUI_WORK_DOCX_PUBLISHED',
            outputSha256: outcome.value.outputSha256,
            templateSha256: outcome.value.templateSha256,
            dataSha256: outcome.value.dataSha256,
            originalInputsUnchanged: true,
          },
        }
      }

      if (action === 'CANCEL') {
        const pending = pendingByScope.get(key)
        if (pending) {
          if (pending.sourceSessionId !== sourceSessionId) {
            return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请重新发起模板操作')
          }
          const outcome = await service.cancel({ address, operationId: pending.operationId })
          if (!outcome.ok) return fromServiceFailure(outcome.error.code)
          pendingByScope.delete(key)
          return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_CANCELLED' } }
        }
        const selected = selectedByScope.get(key)
        if (!selected) {
          return failure('WORK_DOCX_NO_PENDING_OPERATION', '当前会话没有可取消的模板操作')
        }
        if (selected.sourceSessionId !== sourceSessionId) {
          return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请重新发起模板操作')
        }
        const outcome = await service.cancelTemplateSelection({
          address,
          selectionId: selected.selectionId,
        })
        if (!outcome.ok) return fromServiceFailure(outcome.error.code)
        selectedByScope.delete(key)
        return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_CANCELLED' } }
      }

      const published = publishedByScope.get(key)
      if (!published) return failure('WORK_DOCX_NO_PUBLISHED_OUTPUT', '当前会话还没有已生成的文档')
      if (published.sourceSessionId !== sourceSessionId) {
        return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，不能访问其他会话的文档')
      }
      const accessAction = action === 'OPEN' ? 'OPEN' : 'REVEAL'
      const outcome = await service.accessOutput({
        address,
        operationId: published.operationId,
        action: accessAction,
      })
      if (!outcome.ok) return fromServiceFailure(outcome.error.code)
      return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_ACCESSED', action: outcome.value.action } }
    } catch {
      return failure('HOST_TOOL_FAILED', '模板操作失败，请稍后重试')
    } finally {
      inFlightScopes.delete(key)
    }
  }
}

export type { WorkDocxTemplateDataWorkerToolServiceV1 }
