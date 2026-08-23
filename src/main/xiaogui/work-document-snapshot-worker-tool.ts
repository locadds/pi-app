import { z } from 'zod'

import {
  XIAOGUI_WORK_DOCUMENT_SNAPSHOT_METHOD_V1,
  type WorkerHostToolErrorCodeV1,
  type WorkerHostToolOutcomeV1,
} from '@shared/worker-host-tools'
import type { WorkDocumentSnapshotErrorCodeV1 } from '@shared/xiaogui-document-snapshot'

import type { WorkerHostToolRequestHandler } from '../worker-manager-types'
import type { SessionScopeResolverV1 } from './scope-resolver'
import type { WorkDocumentSnapshotServiceV1 } from './work-document-snapshot-service'

const RequestSchema = z
  .object({
    type: z.literal('host-tool-request'),
    requestId: z.string().min(1).max(200),
    method: z.literal(XIAOGUI_WORK_DOCUMENT_SNAPSHOT_METHOD_V1),
    payload: z
      .object({
        action: z.literal('READ_PDF'),
        startPage: z.number().int().min(1).max(1_000_000).optional(),
        endPage: z.number().int().min(1).max(1_000_000).optional(),
        sourceSessionId: z.string().trim().min(1).max(200),
        sourceRunId: z.string().trim().min(1).max(200),
        toolCallId: z.string().trim().min(1).max(200),
      })
      .strict(),
  })
  .strict()

export type WorkDocumentSnapshotWorkerToolServiceV1 = Pick<WorkDocumentSnapshotServiceV1, 'read'>

export interface XiaoguiWorkDocumentSnapshotWorkerToolOptionsV1 {
  scopeResolver: SessionScopeResolverV1
  getService: () => WorkDocumentSnapshotWorkerToolServiceV1
}

function failure(code: WorkerHostToolErrorCodeV1, message: string): WorkerHostToolOutcomeV1 {
  return { ok: false, error: { code, message } }
}

function messageForWorkDocumentSnapshotError(code: WorkDocumentSnapshotErrorCodeV1): string {
  switch (code) {
    case 'SCOPE_NOT_FOUND':
    case 'SCOPE_MISMATCH':
      return '当前会话尚未准备好日常工作能力，请重新进入会话后再试'
    case 'MODE_NOT_ALLOWED':
      return '读取 PDF 只在日常工作会话中可用'
    case 'INPUT_INVALID':
      return '所选文件不是受支持的 PDF，请重新选择'
    case 'INPUT_TOO_LARGE':
      return '所选 PDF 超过 20 MB 上限，请换一个文件后重试'
    case 'PAGE_RANGE_INVALID':
      return '页码范围无效：最多连续读取 20 页，请调整后重试'
    case 'PDF_ENCRYPTED':
      return '该 PDF 已加密，当前版本暂不支持读取加密文档'
    case 'PDF_CORRUPTED':
      return '该 PDF 已损坏或结构不完整，无法读取'
    case 'PARSE_TIMEOUT':
      return '解析 PDF 超过 60 秒已停止，请换一个文件后重试'
    case 'PARSE_ABORTED':
      return '读取 PDF 已取消'
    case 'PARSE_FAILED':
      return '解析 PDF 失败，请换一个文件后重试'
    case 'SOURCE_CHANGED':
      return '所选 PDF 在读取过程中被修改，请重新选择'
  }
}

function fromServiceFailure(code: WorkDocumentSnapshotErrorCodeV1): WorkerHostToolOutcomeV1 {
  return failure(code, messageForWorkDocumentSnapshotError(code))
}

function scopeKey(projectId: string, sessionKey: string): string {
  return `${projectId}\0${sessionKey}`
}

/**
 * Pi 自然语言工具到 WorkDocumentSnapshotServiceV1 的主进程 Adapter。
 * 模型载荷只表达 READ_PDF 与可选起止页；会话地址只由可信来源派生；
 * DESIGN/CODING 会话在选择文件前就被拒绝。
 */
export function createXiaoguiWorkDocumentSnapshotWorkerToolHandlerV1(
  options: XiaoguiWorkDocumentSnapshotWorkerToolOptionsV1,
): WorkerHostToolRequestHandler {
  const inFlightScopes = new Set<string>()

  return async ({ request, fromCwd, sessionFile, fromSessionId, signal }) => {
    const parsed = RequestSchema.safeParse(request)
    if (!parsed.success) {
      return failure('HOST_TOOL_REQUEST_INVALID', '读取 PDF 的参数不完整，请重新表达需求后再试')
    }
    if (!sessionFile || !fromSessionId) {
      return failure('SESSION_NOT_READY', '当前对话尚未建立完成，请重新进入会话后再试')
    }
    if (parsed.data.payload.sourceSessionId !== fromSessionId) {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请在当前会话中重新发起读取')
    }
    if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '读取 PDF 已取消')

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
      return failure('MODE_NOT_ALLOWED', '读取 PDF 只在日常工作会话中可用')
    }
    if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '读取 PDF 已取消')

    const key = scopeKey(scope.projectId, scope.sessionKey)
    if (inFlightScopes.has(key)) {
      return failure('WORK_DOCUMENT_SNAPSHOT_ACTIVE', '当前会话正在读取另一份 PDF，请稍后再试')
    }
    inFlightScopes.add(key)

    try {
      const { startPage, endPage } = parsed.data.payload
      const service = options.getService()
      const outcome = await service.read(
        {
          address: { projectId: scope.projectId, sessionKey: scope.sessionKey },
          startPage,
          endPage,
        },
        signal,
      )
      if (!outcome.ok) {
        if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '读取 PDF 已取消')
        return fromServiceFailure(outcome.error.code)
      }
      if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '读取 PDF 已取消')
      if (outcome.value.kind === 'CANCELLED') {
        return { ok: true, value: { kind: 'XIAOGUI_WORK_DOCUMENT_SELECTION_CANCELLED' } }
      }
      return {
        ok: true,
        value: {
          kind: 'XIAOGUI_WORK_DOCUMENT_SNAPSHOT_READY',
          snapshot: outcome.value.snapshot,
        },
      }
    } catch {
      return failure('HOST_TOOL_FAILED', '读取 PDF 失败，请稍后重试')
    } finally {
      inFlightScopes.delete(key)
    }
  }
}
