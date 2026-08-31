import { z } from 'zod'

import {
  XIAOGUI_WORK_MATERIALS_METHOD_V1,
  type WorkerHostToolErrorCodeV1,
  type WorkerHostToolOutcomeV1,
} from '@shared/worker-host-tools'

import type { WorkerHostToolRequestHandler } from '../worker-manager-types'
import type { SessionScopeResolverV1 } from './scope-resolver'
import type { WorkMaterialsServiceV1 } from './work-materials-service'

const RequestSchema = z
  .object({
    type: z.literal('host-tool-request'),
    requestId: z.string().min(1).max(200),
    method: z.literal(XIAOGUI_WORK_MATERIALS_METHOD_V1),
    payload: z
      .object({
        paths: z.array(z.string().trim().min(1).max(32_768)).min(1).max(32).optional(),
        sourceSessionId: z.string().trim().min(1).max(200),
        sourceRunId: z.string().trim().min(1).max(200),
        toolCallId: z.string().trim().min(1).max(200),
      })
      .strict(),
  })
  .strict()

export interface XiaoguiWorkMaterialsWorkerToolOptionsV1 {
  scopeResolver: SessionScopeResolverV1
  getService: () => Pick<WorkMaterialsServiceV1, 'read'>
}

function failure(code: WorkerHostToolErrorCodeV1, message: string): WorkerHostToolOutcomeV1 {
  return { ok: false, error: { code, message } }
}

function scopeKey(projectId: string, sessionKey: string): string {
  return `${projectId}\0${sessionKey}`
}

export function createXiaoguiWorkMaterialsWorkerToolHandlerV1(
  options: XiaoguiWorkMaterialsWorkerToolOptionsV1,
): WorkerHostToolRequestHandler {
  const inFlightScopes = new Set<string>()

  return async ({ request, fromCwd, sessionFile, fromSessionId, signal }) => {
    const parsed = RequestSchema.safeParse(request)
    if (!parsed.success) return failure('HOST_TOOL_REQUEST_INVALID', '读取资料的参数不完整，请重试')
    if (!sessionFile || !fromSessionId) {
      return failure('SESSION_NOT_READY', '当前对话尚未建立完成，请重新进入会话后再试')
    }
    if (parsed.data.payload.sourceSessionId !== fromSessionId) {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话已经切换，请在当前会话中重新发起读取')
    }
    if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '读取资料已取消')

    let scope
    try {
      scope = await options.scopeResolver.resolveExisting({ rootPath: fromCwd, sessionFile })
    } catch {
      return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未准备好 WORK 能力，请重新进入会话后再试')
    }
    if (!scope) return failure('SESSION_SCOPE_MISMATCH', '当前会话尚未准备好 WORK 能力，请重新进入会话后再试')
    if (scope.sessionMode !== 'WORK') return failure('MODE_NOT_ALLOWED', '读取资料只在 WORK 模式中可用')

    const key = scopeKey(scope.projectId, scope.sessionKey)
    if (inFlightScopes.has(key)) {
      return failure('WORK_DOCUMENT_SNAPSHOT_ACTIVE', '当前会话正在读取另一批资料，请稍后再试')
    }
    inFlightScopes.add(key)
    try {
      const snapshot = await options.getService().read(
        { cwd: fromCwd, paths: parsed.data.payload.paths },
        signal ?? new AbortController().signal,
      )
      if (signal?.aborted) return failure('HOST_TOOL_ABORTED', '读取资料已取消')
      return { ok: true, value: { kind: 'XIAOGUI_WORK_MATERIALS_READY', snapshot } }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return failure('HOST_TOOL_ABORTED', '读取资料已取消')
      }
      return failure('HOST_TOOL_FAILED', '读取资料失败，请检查路径或文件权限后重试')
    } finally {
      inFlightScopes.delete(key)
    }
  }
}
