import type {
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'

import { requestWorkerHostTool } from '../worker-host-tool-channel.js'

const PI_ATTEMPT_TOOL_BEGIN_METHOD = 'xiaogui.taskhub.pi.tool.begin' as const
const PI_ATTEMPT_TOOL_SETTLE_METHOD = 'xiaogui.taskhub.pi.tool.settle' as const

type PiAttemptToolName = 'read' | 'edit' | 'write'

export interface PiAttemptToolLifecycleV1 {
  wrapDefinition<TParams extends TSchema, TDetails, TState>(
    definition: ToolDefinition<TParams, TDetails, TState>,
  ): ToolDefinition<TParams, TDetails, TState>
}

/**
 * Gates the native Pi file tools through the Main-owned TaskHub Attempt.
 * This adapter deliberately has no DIRECT_SESSION or checkpoint behavior.
 */
export function createPiAttemptToolLifecycleV1(options: {
  readonly attemptId: string
  readonly sourceSessionId: () => string | undefined
  readonly request?: typeof requestWorkerHostTool
}): PiAttemptToolLifecycleV1 {
  const request = options.request ?? requestWorkerHostTool
  let serial: Promise<void> = Promise.resolve()

  function wrapDefinition<TParams extends TSchema, TDetails, TState>(
    definition: ToolDefinition<TParams, TDetails, TState>,
  ): ToolDefinition<TParams, TDetails, TState> {
    if (!isPiAttemptToolName(definition.name)) {
      throw new Error('PI_ATTEMPT_TOOL_UNSUPPORTED')
    }

    const execute = definition.execute.bind(definition)
    const wrapped: ToolDefinition<TParams, TDetails, TState> = {
      ...definition,
      executionMode: 'sequential',
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const run = serial.then(async () => {
          if (signal?.aborted) throw new Error('PI_ATTEMPT_TOOL_ABORTED')
          const sourceSessionId = options.sourceSessionId()
          if (!sourceSessionId) throw new Error('PI_ATTEMPT_SESSION_NOT_READY')

          let beginOutcome
          try {
            beginOutcome = await request({
              method: PI_ATTEMPT_TOOL_BEGIN_METHOD,
              payload: {
                attemptId: options.attemptId,
                sourceSessionId,
                toolCallId,
                toolName: definition.name,
                input: params,
              },
            })
          } catch {
            throw new Error('PI_ATTEMPT_TOOL_NOT_AUTHORIZED')
          }

          const authorizedRelativePath = allowedPathFromBegin(beginOutcome, toolCallId)
          if (authorizedRelativePath === null) {
            throw new Error('PI_ATTEMPT_TOOL_NOT_AUTHORIZED')
          }

          if (signal?.aborted) {
            await settleOrThrowUnknown({
              request,
              attemptId: options.attemptId,
              sourceSessionId,
              toolCallId,
              isError: true,
            })
            throw new Error('PI_ATTEMPT_TOOL_ABORTED')
          }

          const executionParams = {
            ...(params as Record<string, unknown>),
            path: authorizedRelativePath,
          } as typeof params

          let result
          try {
            result = await execute(toolCallId, executionParams, signal, onUpdate, ctx)
          } catch (error) {
            await settleOrThrowUnknown({
              request,
              attemptId: options.attemptId,
              sourceSessionId,
              toolCallId,
              isError: true,
            })
            throw error
          }
          await settleOrThrowUnknown({
            request,
            attemptId: options.attemptId,
            sourceSessionId,
            toolCallId,
            isError: false,
          })
          return result
        })
        serial = run.then(() => undefined, () => undefined)
        return run
      },
    }
    return wrapped
  }

  return Object.freeze({ wrapDefinition })
}

function isPiAttemptToolName(value: string): value is PiAttemptToolName {
  return value === 'read' || value === 'edit' || value === 'write'
}

function allowedPathFromBegin(
  outcome: Awaited<ReturnType<typeof requestWorkerHostTool>>,
  toolCallId: string,
): string | null {
  if (!outcome.ok || outcome.value.kind !== 'PI_ATTEMPT_TOOL_ALLOWED') return null
  if (outcome.value.toolCallId !== toolCallId) return null
  return isNormalizedRelativePath(outcome.value.authorizedRelativePath)
    ? outcome.value.authorizedRelativePath
    : null
}

function isNormalizedRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) return false
  if (value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value)) return false
  return value.split('/').every((part) => {
    return part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'
  })
}

async function settleOrThrowUnknown(input: {
  readonly request: typeof requestWorkerHostTool
  readonly attemptId: string
  readonly sourceSessionId: string
  readonly toolCallId: string
  readonly isError: boolean
}): Promise<void> {
  let outcome
  try {
    outcome = await input.request({
      method: PI_ATTEMPT_TOOL_SETTLE_METHOD,
      payload: {
        attemptId: input.attemptId,
        sourceSessionId: input.sourceSessionId,
        toolCallId: input.toolCallId,
        isError: input.isError,
      },
    })
  } catch {
    throw new Error('PI_ATTEMPT_TOOL_OUTCOME_UNKNOWN')
  }
  if (
    !outcome.ok ||
    outcome.value.kind !== 'PI_ATTEMPT_TOOL_SETTLED' ||
    outcome.value.toolCallId !== input.toolCallId
  ) {
    throw new Error('PI_ATTEMPT_TOOL_OUTCOME_UNKNOWN')
  }
}
