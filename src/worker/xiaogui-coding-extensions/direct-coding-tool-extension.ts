import { createHash } from 'node:crypto'

import type {
  ExtensionFactory,
  ToolDefinition,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import type { XiaoguiPromptContextV1 } from '@shared/xiaogui-prompt-contract'
import type {
  DirectCodingBeginResultV4,
  DirectCodingOperationV2,
  DirectCodingPreflightResultV4,
  DirectCodingSettleResultV2,
} from '@shared/xiaogui-direct-coding'
import { hasUnsafeDirectCodingCommandTextV1 } from '@shared/xiaogui-direct-coding'
import {
  XIAOGUI_DIRECT_CODING_BEGIN_METHOD_V4,
  XIAOGUI_DIRECT_CODING_PREFLIGHT_METHOD_V4,
  XIAOGUI_DIRECT_CODING_SETTLE_METHOD_V2,
} from '@shared/worker-host-tools'

import { requestWorkerHostTool } from '../worker-host-tool-channel.js'
import { toMainToolPath } from '../worker-path-bridge.js'

interface PendingCallV2 {
  readonly requestDigest: string
  readonly operation: DirectCodingOperationV2
  readonly authorizedRelativePath?: string
  exitCode?: number | null
}

export interface XiaoguiDirectCodingToolLifecycleV2 {
  readonly name: 'xiaogui-direct-coding-tool-lifecycle-v2'
  readonly hidden: true
  readonly factory: ExtensionFactory
  wrapDefinition<TParams extends TSchema, TDetails, TState>(
    definition: ToolDefinition<TParams, TDetails, TState>,
  ): ToolDefinition<TParams, TDetails, TState>
}

/**
 * Pi Adapter for the Main-owned direct-CODING Module. It contains no approval
 * policy; it only pauses the real Pi tool lifecycle at preflight/begin/settle.
 */
export function createXiaoguiDirectCodingToolLifecycleV2(options: {
  readonly context: () => XiaoguiPromptContextV1 | null
  readonly sourceSessionId: () => string | undefined
  readonly readOnlyRole?: () => boolean
}): XiaoguiDirectCodingToolLifecycleV2 {
  const calls = new Map<string, PendingCallV2>()

  const factory: ExtensionFactory = (pi) => {
    pi.on('tool_call', async (event) => {
      const context = options.context()
      const operation = operationFor(event.toolName)
      if (!context || context.mode !== 'CODING' || !operation) return undefined
      if (operation !== 'READ' && context.phase !== 'EXECUTE') {
        return { block: true, reason: 'XIAOGUI_CODING_PHASE_READ_ONLY', terminate: true }
      }
      if (operation !== 'READ' && options.readOnlyRole?.() === true) {
        return { block: true, reason: 'XIAOGUI_CODING_ROLE_TOOL_BLOCKED', terminate: true }
      }
      const sourceSessionId = options.sourceSessionId()
      if (!sourceSessionId) return { block: true, reason: 'XIAOGUI_CODING_SESSION_NOT_READY', terminate: true }
      let toolPath: string | undefined
      try {
        toolPath = operation === 'READ' || operation === 'EDIT' || operation === 'WRITE'
          ? rawToolPath(String((event.input as { path?: unknown }).path ?? ''))
          : undefined
      } catch {
        return { block: true, reason: 'XIAOGUI_CODING_PATH_REJECTED', terminate: true }
      }
      const requestDigest = digestRequest({
        domain: 'xiaogui.direct-coding.tool-call.v2',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
      })
      const command = operation === 'BASH'
        ? String((event.input as { command?: unknown }).command ?? '')
        : undefined
      if (
        operation === 'BASH' &&
        (!command?.trim() || unsafeCommandControl(command) || Buffer.byteLength(command, 'utf8') > 64 * 1024)
      ) {
        return { block: true, reason: 'XIAOGUI_CODING_COMMAND_REJECTED', terminate: true }
      }
      const outcome = await requestWorkerHostTool({
        method: XIAOGUI_DIRECT_CODING_PREFLIGHT_METHOD_V4,
        payload: {
          sourceSessionId,
          toolCallId: event.toolCallId,
          requestDigest,
          phase: context.phase,
          operation,
          ...(toolPath ? { path: toolPath } : {}),
          ...(command
            ? {
                commandText: command,
                commandDigest: digestText(command),
              }
            : {}),
        },
      })
      const value = outcome.ok ? outcome.value as DirectCodingPreflightResultV4 : null
      if (
        !value ||
        value.kind !== 'XIAOGUI_DIRECT_CODING_PREFLIGHT' ||
        value.requestDigest !== requestDigest ||
        value.decision !== 'ALLOW' ||
        value.state !== 'ALLOWED'
      ) {
        return { block: true, reason: value?.reasonCode ?? 'XIAOGUI_CODING_PERMISSION_DENIED', terminate: true }
      }
      const authorizedRelativePath = authorizedPath(value.authorizedRelativePath, operation)
      if (authorizedRelativePath === null) {
        return { block: true, reason: 'XIAOGUI_CODING_AUTHORIZED_PATH_INVALID', terminate: true }
      }
      calls.set(event.toolCallId, {
        requestDigest,
        operation,
        ...(authorizedRelativePath ? { authorizedRelativePath } : {}),
      })
      return undefined
    })

    pi.on('tool_result', async (event) => {
      const call = calls.get(event.toolCallId)
      if (!call) return undefined
      calls.delete(event.toolCallId)
      const sourceSessionId = options.sourceSessionId()
      if (!sourceSessionId) return appendUnknown(event)
      const outcome = await requestWorkerHostTool({
        method: XIAOGUI_DIRECT_CODING_SETTLE_METHOD_V2,
        payload: {
          sourceSessionId,
          toolCallId: event.toolCallId,
          requestDigest: call.requestDigest,
          isError: event.isError,
          ...(call.operation === 'BASH' ? { exitCode: call.exitCode ?? (event.isError ? null : 0) } : {}),
        },
      })
      const value = outcome.ok ? outcome.value as DirectCodingSettleResultV2 : null
      if (!value || value.kind !== 'XIAOGUI_DIRECT_CODING_SETTLED' || value.state !== 'SETTLED') {
        return appendUnknown(event)
      }
      return undefined
    })
  }

  function wrapDefinition<TParams extends TSchema, TDetails, TState>(
    definition: ToolDefinition<TParams, TDetails, TState>,
  ): ToolDefinition<TParams, TDetails, TState> {
    const operation = operationFor(definition.name)
    if (!operation) return definition
    const execute = definition.execute.bind(definition)
    const wrapped: ToolDefinition<TParams, TDetails, TState> = {
      ...definition,
      ...(operation === 'READ' ? {} : { executionMode: 'sequential' as const }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const call = calls.get(toolCallId)
        if (!call) throw new Error('XIAOGUI_CODING_PREFLIGHT_MISSING')
        const sourceSessionId = options.sourceSessionId()
        if (!sourceSessionId) {
          calls.delete(toolCallId)
          throw new Error('XIAOGUI_CODING_SESSION_NOT_READY')
        }
        const outcome = await requestWorkerHostTool({
          method: XIAOGUI_DIRECT_CODING_BEGIN_METHOD_V4,
          payload: { sourceSessionId, toolCallId, requestDigest: call.requestDigest },
        })
        const value = outcome.ok ? outcome.value as DirectCodingBeginResultV4 : null
        if (
          !value ||
          value.kind !== 'XIAOGUI_DIRECT_CODING_BEGIN' ||
          value.requestDigest !== call.requestDigest ||
          value.decision !== 'ALLOW' ||
          value.state !== 'EXECUTING'
        ) {
          calls.delete(toolCallId)
          throw new Error(value?.reasonCode ?? 'XIAOGUI_CODING_EXECUTION_NOT_AUTHORIZED')
        }
        const beginAuthorizedPath = authorizedPath(value.authorizedRelativePath, operation)
        if (beginAuthorizedPath === null || beginAuthorizedPath !== call.authorizedRelativePath) {
          calls.delete(toolCallId)
          throw new Error('XIAOGUI_CODING_AUTHORIZED_PATH_MISMATCH')
        }
        const executionParams = beginAuthorizedPath
          ? { ...(params as Record<string, unknown>), path: beginAuthorizedPath } as typeof params
          : params
        try {
          const result = await execute(toolCallId, executionParams, signal, onUpdate, ctx)
          if (operation === 'BASH') call.exitCode = 0
          return result
        } catch (error) {
          if (operation === 'BASH') call.exitCode = exitCodeFromError(error)
          throw error
        }
      },
    }
    return wrapped
  }

  return Object.freeze({
    name: 'xiaogui-direct-coding-tool-lifecycle-v2' as const,
    hidden: true as const,
    factory,
    wrapDefinition,
  })
}

function operationFor(toolName: string): DirectCodingOperationV2 | null {
  if (toolName === 'read') return 'READ'
  if (toolName === 'edit') return 'EDIT'
  if (toolName === 'write') return 'WRITE'
  if (toolName === 'bash') return 'BASH'
  return null
}

function rawToolPath(value: string): string {
  if (!value || value !== value.trim() || value.includes('\0') || value.length > 4096) {
    throw new Error('PATH_INVALID')
  }
  // Preserve Pi's native relative/absolute path contract while translating a
  // WSL absolute path into the Main process' Windows view. Main remains the
  // authority that decides whether the resulting target is inside the project.
  return toMainToolPath(value)
}

function digestRequest(value: unknown): string {
  return digestText(canonicalJson(value))
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

const unsafeCommandControl = hasUnsafeDirectCodingCommandTextV1

function authorizedPath(
  value: string | undefined,
  operation: DirectCodingOperationV2,
): string | undefined | null {
  const isFileOperation = operation === 'READ' || operation === 'EDIT' || operation === 'WRITE'
  if (!isFileOperation) return value === undefined ? undefined : null
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[a-z]:/i.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  ) return null
  return value
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function exitCodeFromError(error: unknown): number | null {
  const match = error instanceof Error ? /Command exited with code (\d+)/.exec(error.message) : null
  return match ? Number(match[1]) : null
}

function appendUnknown(event: ToolResultEvent) {
  return {
    content: [
      ...event.content,
      {
        type: 'text' as const,
        text: '\n\n[小规：工具已经结束，但结果入账状态未知。请勿自动重试；请先查看真实文件差异。]',
      },
    ],
  }
}
