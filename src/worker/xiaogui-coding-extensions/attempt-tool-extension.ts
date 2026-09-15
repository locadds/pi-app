import type {
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type, type Static, type TSchema } from 'typebox'
import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { requestWorkerHostTool } from '../worker-host-tool-channel.js'

const PI_ATTEMPT_TOOL_BEGIN_METHOD = 'xiaogui.taskhub.pi.tool.begin' as const
const PI_ATTEMPT_TOOL_SETTLE_METHOD = 'xiaogui.taskhub.pi.tool.settle' as const

type PiAttemptToolName = 'read' | 'edit' | 'write' | 'delete' | 'rename'

const DeleteParameters = Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false })
const RenameParameters = Type.Object({
  sourcePath: Type.String({ minLength: 1, maxLength: 4096 }),
  targetPath: Type.String({ minLength: 1, maxLength: 4096 }),
}, { additionalProperties: false })

export function createPiAttemptDeleteToolDefinitionV1(root: string): ToolDefinition<typeof DeleteParameters> {
  return {
    name: 'delete', label: '删除文件', description: '删除当前 TaskHub Attempt 工作树内的一个普通文件。',
    parameters: DeleteParameters, executionMode: 'sequential',
    async execute(_toolCallId, params: Static<typeof DeleteParameters>) {
      await assertSafeExistingParent(root, params.path)
      const target = resolve(root, params.path)
      const stat = await lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || resolve(await realpath(target)) !== target) {
        throw new Error('PI_ATTEMPT_DELETE_TARGET_INVALID')
      }
      await rm(target)
      return { content: [{ type: 'text' as const, text: `已删除 ${params.path}` }], details: undefined }
    },
  }
}

export function createPiAttemptRenameToolDefinitionV1(root: string): ToolDefinition<typeof RenameParameters> {
  return {
    name: 'rename', label: '重命名文件', description: '重命名当前 TaskHub Attempt 工作树内的一个普通文件。',
    parameters: RenameParameters, executionMode: 'sequential',
    async execute(_toolCallId, params: Static<typeof RenameParameters>) {
      await assertSafeExistingParent(root, params.sourcePath)
      await assertSafeParent(root, params.targetPath, true)
      const source = resolve(root, params.sourcePath)
      const target = resolve(root, params.targetPath)
      const stat = await lstat(source)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || resolve(await realpath(source)) !== source) {
        throw new Error('PI_ATTEMPT_RENAME_SOURCE_INVALID')
      }
      try {
        await lstat(target)
        throw new Error('PI_ATTEMPT_RENAME_TARGET_EXISTS')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rename(source, target)
      return { content: [{ type: 'text' as const, text: `已重命名为 ${params.targetPath}` }], details: undefined }
    },
  }
}

async function assertSafeExistingParent(root: string, relativePath: string): Promise<void> {
  return assertSafeParent(root, relativePath, false)
}

async function assertSafeParent(root: string, relativePath: string, createMissing: boolean): Promise<void> {
  const parent = dirname(resolve(root, relativePath))
  const relativeParent = parent === resolve(root) ? '' : parent.slice(resolve(root).length + 1)
  let cursor = resolve(root)
  for (const part of relativeParent.split(/[\\/]/).filter(Boolean)) {
    cursor = resolve(cursor, part)
    let stat
    try {
      stat = await lstat(cursor)
    } catch (error) {
      if (!createMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(cursor)
      stat = await lstat(cursor)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(cursor)) !== cursor) {
      throw new Error('PI_ATTEMPT_PARENT_INVALID')
    }
  }
}

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

          const authorized = allowedPathsFromBegin(beginOutcome, toolCallId)
          if (authorized === null || (definition.name === 'rename' && !authorized.targetPath)) {
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

          const executionParams = (definition.name === 'rename'
            ? { ...(params as Record<string, unknown>), sourcePath: authorized.path, targetPath: authorized.targetPath }
            : { ...(params as Record<string, unknown>), path: authorized.path }) as typeof params

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
  return value === 'read' || value === 'edit' || value === 'write' || value === 'delete' || value === 'rename'
}

function allowedPathsFromBegin(
  outcome: Awaited<ReturnType<typeof requestWorkerHostTool>>,
  toolCallId: string,
): { path: string; targetPath?: string } | null {
  if (!outcome.ok || outcome.value.kind !== 'PI_ATTEMPT_TOOL_ALLOWED') return null
  if (outcome.value.toolCallId !== toolCallId) return null
  if (!isNormalizedRelativePath(outcome.value.authorizedRelativePath)) return null
  if (outcome.value.authorizedTargetRelativePath !== undefined
    && !isNormalizedRelativePath(outcome.value.authorizedTargetRelativePath)) return null
  return { path: outcome.value.authorizedRelativePath,
    ...(outcome.value.authorizedTargetRelativePath ? { targetPath: outcome.value.authorizedTargetRelativePath } : {}) }
}

function isNormalizedRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || value.includes(':')) return false
  if (value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value)) return false
  return value.split('/').every((part) => {
    const base = part.split('.')[0].toUpperCase()
    return part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'
      && !/[\u0000-\u001f<>"|?*]/.test(part) && !/[. ]$/.test(part)
      && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)
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
