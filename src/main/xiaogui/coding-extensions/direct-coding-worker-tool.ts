import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import {
  XIAOGUI_DIRECT_CODING_BEGIN_METHOD_V2,
  XIAOGUI_DIRECT_CODING_PREFLIGHT_METHOD_V3,
  XIAOGUI_DIRECT_CODING_SETTLE_METHOD_V2,
  type WorkerHostToolOutcomeV1,
} from '@shared/worker-host-tools'
import {
  DIRECT_CODING_OPERATIONS_V2,
  XIAOGUI_DIRECT_CODING_SUBJECT_V2,
  type DirectCodingBeginPayloadV2,
  type DirectCodingPermissionOriginV3,
  type DirectCodingPreflightPayloadV3,
  type DirectCodingSettlePayloadV2,
} from '@shared/xiaogui-direct-coding'
import type { CodingPermissionModeV1 } from '@shared/xiaogui-coding-permission'
import type { XiaoguiExecutionPhase } from '@shared/xiaogui-prompt-contract'

import type { WorkerHostToolRequestHandler } from '../../worker-manager-types'
import type { SessionScopeResolverV1 } from '../scope-resolver'
import type { DirectCodingModuleV2 } from './direct-coding-module'
import { resolveSessionListTitle } from '../../session-display-names'

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,255}$/i
const DIGEST = /^sha256:[0-9a-f]{64}$/

export interface DirectCodingWorkerToolOptionsV2 {
  readonly module: Pick<DirectCodingModuleV2, 'preflight' | 'begin' | 'settle'>
  readonly scopeResolver: SessionScopeResolverV1
  readonly readPhase: () => XiaoguiExecutionPhase
  readonly readMode: () => CodingPermissionModeV1
}

/** Main Adapter: binds untrusted Worker payloads to the trusted canonical session scope. */
export function createDirectCodingWorkerToolHandlerV2(
  options: DirectCodingWorkerToolOptionsV2,
): WorkerHostToolRequestHandler {
  return async ({ request, fromCwd, fromPoolKey, sessionFile, fromSessionId }) => {
    if (!sessionFile || !fromSessionId) return failed('SESSION_NOT_READY', '当前编程会话尚未准备好')
    let scope
    try {
      scope = await options.scopeResolver.resolveExisting({ rootPath: fromCwd, sessionFile })
    } catch {
      return failed('SESSION_SCOPE_MISMATCH', '当前会话与项目身份不一致')
    }
    if (!scope || scope.sessionMode !== 'CODING') {
      return failed('SESSION_SCOPE_MISMATCH', '该能力只允许当前编程会话使用')
    }
    const subject = {
      schemaVersion: 2 as const,
      kind: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
      address: { projectId: scope.projectId, sessionKey: scope.sessionKey },
    }

    try {
      if (request.method === XIAOGUI_DIRECT_CODING_PREFLIGHT_METHOD_V3) {
        const payload = parsePreflight(request.payload)
        if (payload.sourceSessionId !== fromSessionId) return failed('SESSION_SCOPE_MISMATCH', '会话已切换，操作已停止')
        const trustedPhase = options.readPhase()
        if (payload.phase !== trustedPhase) return failed('SESSION_SCOPE_MISMATCH', '执行阶段已变化，请重新发起操作')
        if (payload.operation !== 'READ' && trustedPhase !== 'EXECUTE') {
          return failed('DIRECT_CODING_PERMISSION_DENIED', '当前阶段保持只读')
        }
        const value = await options.module.preflight({
          subject,
          rootPath: scope.rootPath,
          sourceSessionId: payload.sourceSessionId,
          toolCallId: payload.toolCallId,
          requestDigest: payload.requestDigest,
          operation: payload.operation,
          path: payload.path,
          commandText: payload.commandText,
          commandDigest: payload.commandDigest,
          mode: options.readMode(),
          origin: permissionOrigin(scope.rootPath, fromPoolKey, sessionFile, fromSessionId),
        })
        return { ok: true, value }
      }
      if (request.method === XIAOGUI_DIRECT_CODING_BEGIN_METHOD_V2) {
        const payload = parseBegin(request.payload)
        if (payload.sourceSessionId !== fromSessionId) return failed('SESSION_SCOPE_MISMATCH', '会话已切换，操作已停止')
        return {
          ok: true,
          value: await options.module.begin({
            subject,
            rootPath: scope.rootPath,
            sourceSessionId: payload.sourceSessionId,
            toolCallId: payload.toolCallId,
            requestDigest: payload.requestDigest,
          }),
        }
      }
      if (request.method === XIAOGUI_DIRECT_CODING_SETTLE_METHOD_V2) {
        const payload = parseSettle(request.payload)
        if (payload.sourceSessionId !== fromSessionId) return failed('SESSION_SCOPE_MISMATCH', '会话已切换，结果未入账')
        return {
          ok: true,
          value: await options.module.settle({
            subject,
            rootPath: scope.rootPath,
            sourceSessionId: payload.sourceSessionId,
            toolCallId: payload.toolCallId,
            requestDigest: payload.requestDigest,
            isError: payload.isError,
            exitCode: payload.exitCode,
          }),
        }
      }
      return failed('HOST_TOOL_REQUEST_INVALID', '直接编程工具方法无效')
    } catch {
      return failed('DIRECT_CODING_REQUEST_INVALID', '直接编程工具请求无效')
    }
  }
}

function parsePreflight(value: unknown): DirectCodingPreflightPayloadV3 {
  const input = record(value)
  exactKeys(input, ['sourceSessionId', 'toolCallId', 'requestDigest', 'phase', 'operation', 'path', 'commandText', 'commandDigest'])
  assertBase(input)
  if (!['ASK', 'PLAN', 'EXECUTE'].includes(String(input.phase))) invalid()
  if (!DIRECT_CODING_OPERATIONS_V2.includes(input.operation as never)) invalid()
  optionalString(input.path, 4096)
  if (input.commandDigest !== undefined && !DIGEST.test(String(input.commandDigest))) invalid()
  if (['READ', 'EDIT', 'WRITE'].includes(String(input.operation))) {
    if (typeof input.path !== 'string' || input.path.length === 0) invalid()
    if (input.commandText !== undefined || input.commandDigest !== undefined) invalid()
  }
  if (input.operation === 'BASH') {
    if (
      typeof input.commandText !== 'string' ||
      input.commandText.trim().length === 0 ||
      Buffer.byteLength(input.commandText, 'utf8') > 64 * 1024 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.commandText) ||
      typeof input.commandDigest !== 'string'
    ) invalid()
    if (input.commandDigest !== digestText(input.commandText)) invalid()
    if (input.path !== undefined) invalid()
  }
  return input as unknown as DirectCodingPreflightPayloadV3
}

function permissionOrigin(
  rootPath: string,
  fromPoolKey: string,
  sessionFile: string,
  sourceSessionId: string,
): DirectCodingPermissionOriginV3 {
  const fallback = `对话 ${sourceSessionId.slice(0, 8)}`
  return Object.freeze({
    projectLabel: safeLabel(basename(rootPath) || '当前项目'),
    sessionLabel: safeLabel(resolveSessionListTitle(sessionFile, fallback)),
    fromCwd: rootPath,
    fromPoolKey,
    sessionFile,
    sourceSessionId,
  })
}

function safeLabel(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return (normalized || '未命名').slice(0, 80)
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function parseBegin(value: unknown): DirectCodingBeginPayloadV2 {
  const input = record(value)
  exactKeys(input, ['sourceSessionId', 'toolCallId', 'requestDigest'])
  assertBase(input)
  return input as unknown as DirectCodingBeginPayloadV2
}

function parseSettle(value: unknown): DirectCodingSettlePayloadV2 {
  const input = record(value)
  exactKeys(input, ['sourceSessionId', 'toolCallId', 'requestDigest', 'isError', 'exitCode'])
  assertBase(input)
  if (typeof input.isError !== 'boolean') invalid()
  if (input.exitCode !== undefined && input.exitCode !== null && !Number.isSafeInteger(input.exitCode)) invalid()
  return input as unknown as DirectCodingSettlePayloadV2
}

function assertBase(input: Record<string, unknown>): void {
  if (!SAFE_ID.test(String(input.sourceSessionId)) || !SAFE_ID.test(String(input.toolCallId)) || !DIGEST.test(String(input.requestDigest))) invalid()
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) invalid()
}

function optionalString(value: unknown, max: number): void {
  if (value !== undefined && (typeof value !== 'string' || value.length > max)) invalid()
}

function invalid(): never {
  throw new Error('DIRECT_CODING_REQUEST_INVALID')
}

function failed(code: Parameters<typeof failureCode>[0], message: string): WorkerHostToolOutcomeV1 {
  return { ok: false, error: { code: failureCode(code), message } }
}

function failureCode(code: import('@shared/worker-host-tools').WorkerHostToolErrorCodeV1) {
  return code
}
