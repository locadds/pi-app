/**
 * WORK DOCX 模板生成强类型薄客户端。
 *
 * 只封装 discover / prepare / confirm / cancel 四个 IPC 通道：
 * - 入参只携带当前会话的 canonical WORK 地址与不透明 operationId，
 *   前端不提交、也不接收任何真实路径、命令或临时目录。
 * - 返回值严格按共享契约（packages/shared/xiaogui-work-docx.ts）做闭集解析；
 *   任何非约定报文、未知错误码或 IPC 异常统一映射为安全中文文案，
 *   绝不把路径、临时目录或原始异常抛给上层展示。
 */

import type {
  WorkDocxCancelRequestV1,
  WorkDocxCancelledResultV1,
  WorkDocxConfirmRequestV1,
  WorkDocxDiscoverResultV1,
  WorkDocxErrorCodeV1,
  WorkDocxOperationIdV1,
  WorkDocxPrepareResultV1,
  WorkDocxPublishedResultV1,
} from '@shared/xiaogui-work-docx'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

import { ipcClient } from '@renderer/lib/ipc-client'

/** 前端本地补充的失败码：IPC 层失败或非约定返回，不属于后端错误闭集。 */
export type WorkDocxClientErrorCodeV1 = WorkDocxErrorCodeV1 | 'IPC_FAILURE'

/** 面向界面的安全结果：错误已经是可直接展示的中文，不含任何路径或原始异常。 */
export type WorkDocxClientOutcomeV1<T> =
  | { ok: true; value: T }
  | { ok: false; code: WorkDocxClientErrorCodeV1; message: string }

const PROJECT_ID = /^xgp1_[0-9a-f]{64}$/
const SESSION_KEY = /^xgs1_[0-9a-f]{64}$/
const OPERATION_ID = /^xgw1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const PLACEHOLDER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const UNSAFE_DISPLAY_NAME = /[\/\\\u0000-\u001f\u007f-\u009f]/

const ERROR_CODES = new Set<WorkDocxErrorCodeV1>([
  'SCOPE_NOT_FOUND',
  'SCOPE_MISMATCH',
  'MODE_NOT_ALLOWED',
  'INPUT_INVALID',
  'INPUT_TOO_LARGE',
  'UNSAFE_DOCX',
  'PLACEHOLDER_MISSING',
  'TARGET_EXISTS',
  'OPERATION_NOT_FOUND',
  'OPERATION_SCOPE_MISMATCH',
  'SOURCE_CHANGED',
  'GENERATION_FAILED',
  'PUBLISH_FAILED',
])

/** 错误闭集对应的大白话文案；只描述用户能理解和处理的事，不含技术细节。 */
const SAFE_MESSAGES: Record<WorkDocxClientErrorCodeV1, string> = {
  SCOPE_NOT_FOUND: '当前会话信息不完整，请重新进入 WORK 会话后再试。',
  SCOPE_MISMATCH: '当前会话与项目不匹配，请切换回原来的会话再试。',
  MODE_NOT_ALLOWED: '只能在 WORK 会话里生成文档。',
  INPUT_INVALID: '选择的文件不符合要求：模板需要是 .docx，数据需要是 .json。',
  INPUT_TOO_LARGE: '文件太大了，请换一个小一些的模板或数据文件。',
  UNSAFE_DOCX: '这个模板文件不安全或已损坏，无法使用。',
  PLACEHOLDER_MISSING: '模板里没有可填写的占位内容，或者数据里缺少对应的字段。',
  TARGET_EXISTS: '保存位置已经有同名文件了，请换一个新文件名。',
  OPERATION_NOT_FOUND: '这次准备已经失效，请重新选择文件。',
  OPERATION_SCOPE_MISMATCH: '这次操作不属于当前会话，已忽略。',
  SOURCE_CHANGED: '模板或数据文件在准备之后被改动过，请重新选择。',
  GENERATION_FAILED: '生成文档失败，请检查模板和数据内容后再试。',
  PUBLISH_FAILED: '保存新文件失败，请换一个保存位置再试。',
  IPC_FAILURE: '文档功能暂时不可用，请稍后再试。',
}

function failure<T>(code: WorkDocxClientErrorCodeV1): WorkDocxClientOutcomeV1<T> {
  return { ok: false, code, message: SAFE_MESSAGES[code] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => key in value)
}

function isAddress(value: unknown): value is SessionAddressV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['projectId', 'sessionKey']) &&
    typeof value.projectId === 'string' &&
    PROJECT_ID.test(value.projectId) &&
    typeof value.sessionKey === 'string' &&
    SESSION_KEY.test(value.sessionKey)
  )
}

function isOperationId(value: unknown): value is WorkDocxOperationIdV1 {
  return typeof value === 'string' && OPERATION_ID.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value)
}

function isDisplayName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 160 &&
    !UNSAFE_DISPLAY_NAME.test(value)
  )
}

function isPlaceholders(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return false
  if (!value.every((item) => typeof item === 'string' && PLACEHOLDER.test(item))) return false
  return new Set(value).size === value.length
}

function isSafeError(value: unknown): value is { code: WorkDocxErrorCodeV1; messageKey: string } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['code', 'messageKey']) &&
    typeof value.code === 'string' &&
    ERROR_CODES.has(value.code as WorkDocxErrorCodeV1) &&
    typeof value.messageKey === 'string'
  )
}

function isCapability(value: unknown): boolean {
  const intents = isRecord(value) && Array.isArray(value.intents) ? value.intents : null
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'version', 'status', 'intents']) &&
    value.id === 'docx-template-patch' &&
    value.version === '9.7.1' &&
    value.status === 'AVAILABLE' &&
    Array.isArray(intents) &&
    intents.length === 3 &&
    intents[0] === 'PREPARE' &&
    intents[1] === 'CONFIRM' &&
    intents[2] === 'CANCEL'
  )
}

function isDiscoverResult(value: unknown): value is WorkDocxDiscoverResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['capabilities']) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length === 1 &&
    isCapability(value.capabilities[0])
  )
}

function isPrepareResult(value: unknown): value is WorkDocxPrepareResultV1 {
  if (!isRecord(value)) return false
  if (value.kind === 'CANCELLED') return hasExactKeys(value, ['kind'])
  return (
    value.kind === 'PREPARED' &&
    hasExactKeys(value, [
      'kind',
      'operationId',
      'templateDisplayName',
      'payloadDisplayName',
      'placeholders',
      'templateSha256',
      'payloadSha256',
    ]) &&
    isOperationId(value.operationId) &&
    isDisplayName(value.templateDisplayName) &&
    isDisplayName(value.payloadDisplayName) &&
    isPlaceholders(value.placeholders) &&
    isSha256(value.templateSha256) &&
    isSha256(value.payloadSha256)
  )
}

function isPublishedResult(value: unknown): value is WorkDocxPublishedResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'kind',
      'operationId',
      'outputSha256',
      'templateSha256',
      'payloadSha256',
      'originalInputsUnchanged',
    ]) &&
    value.kind === 'PUBLISHED' &&
    isOperationId(value.operationId) &&
    isSha256(value.outputSha256) &&
    isSha256(value.templateSha256) &&
    isSha256(value.payloadSha256) &&
    value.originalInputsUnchanged === true
  )
}

function isCancelledResult(value: unknown): value is WorkDocxCancelledResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind', 'operationId']) &&
    value.kind === 'CANCELLED' &&
    isOperationId(value.operationId)
  )
}

/** 闭集解析 outcome：成功值过校验，失败码必须在共享契约闭集内。 */
function parseOutcome<T>(
  res: unknown,
  isSuccess: (candidate: unknown) => candidate is T,
): WorkDocxClientOutcomeV1<T> | null {
  if (!isRecord(res)) return null
  if (res.ok === true && hasExactKeys(res, ['ok', 'value']) && isSuccess(res.value)) {
    return { ok: true, value: res.value }
  }
  if (res.ok === false && hasExactKeys(res, ['ok', 'error']) && isSafeError(res.error)) {
    return failure(res.error.code)
  }
  return null
}

async function invokeDocx<T>(
  channel: string,
  request: unknown,
  isSuccess: (candidate: unknown) => candidate is T,
): Promise<WorkDocxClientOutcomeV1<T>> {
  try {
    const res: unknown = await ipcClient.invoke(channel, request)
    return parseOutcome(res, isSuccess) ?? failure('IPC_FAILURE')
  } catch {
    return failure('IPC_FAILURE')
  }
}

/** 第一步之前的能力探测：确认当前 WORK 会话可以使用模板生成。 */
export function discoverWorkDocx(address: SessionAddressV1): Promise<WorkDocxClientOutcomeV1<WorkDocxDiscoverResultV1>> {
  return invokeDocx('xiaogui.work.docx.discover', address, isDiscoverResult)
}

/** 第一步：打开原生窗口选模板、选数据、选新保存位置，完成后进入待确认状态。 */
export function prepareWorkDocx(address: SessionAddressV1): Promise<WorkDocxClientOutcomeV1<WorkDocxPrepareResultV1>> {
  return invokeDocx('xiaogui.work.docx.prepare', { address }, isPrepareResult)
}

/** 第二步：用户确认后才真正生成并另存为新文件。 */
export function confirmWorkDocx(
  address: SessionAddressV1,
  operationId: WorkDocxOperationIdV1,
): Promise<WorkDocxClientOutcomeV1<WorkDocxPublishedResultV1>> {
  const request: WorkDocxConfirmRequestV1 = { address, operationId }
  return invokeDocx('xiaogui.work.docx.confirm', request, isPublishedResult)
}

/** 放弃一次尚未确认的准备；后端会清理对应的临时内容。 */
export async function cancelWorkDocx(
  address: SessionAddressV1,
  operationId: WorkDocxOperationIdV1,
): Promise<WorkDocxClientOutcomeV1<WorkDocxCancelledResultV1>> {
  const request: WorkDocxCancelRequestV1 = { address, operationId }
  const outcome = await invokeDocx('xiaogui.work.docx.cancel', request, isCancelledResult)
  if (!outcome.ok && outcome.code === 'PUBLISH_FAILED') {
    return { ...outcome, message: '没有清理完本次准备内容，请重试取消。' }
  }
  return outcome
}

/** 取摘要前 12 位用于界面核对；输入必须是已校验的 64 位十六进制。 */
export function shortWorkDocxDigest(sha256: string): string {
  return sha256.slice(0, 12)
}

export { isAddress as isWorkDocxAddress }
