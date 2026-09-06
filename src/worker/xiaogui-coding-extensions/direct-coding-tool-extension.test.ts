import { Type } from 'typebox'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createWriteToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { XiaoguiPromptContextV1 } from '@shared/xiaogui-prompt-contract'
import {
  activeToolNamesForPromptContextV1,
  selectXiaoguiTurnCapabilitiesV1,
} from '@shared/xiaogui-prompt-capabilities'
import type { DirectCodingAuthorizationSubjectV2 } from '@shared/xiaogui-direct-coding'
import type { ProjectId, SessionKey } from '@shared/xiaogui-session-scope'
import { DirectCodingModuleV2 } from '../../main/xiaogui/coding-extensions/direct-coding-module'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())
vi.mock('../worker-host-tool-channel.js', () => ({
  requestWorkerHostTool: requestWorkerHostToolMock,
}))

import { createXiaoguiDirectCodingToolLifecycleV2 } from './direct-coding-tool-extension'

type Handler = (event: never, context: never) => unknown
const roots: string[] = []

beforeEach(() => {
  requestWorkerHostToolMock.mockReset()
})
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Xiaogui direct CODING Pi tool lifecycle', () => {
  it('blocks ASK/PLAN mutations before Main and runs EXECUTE write as preflight -> begin -> tool -> settle', async () => {
    let phase: XiaoguiPromptContextV1['phase'] = 'ASK'
    const trace: string[] = []
    const handlers = new Map<string, Handler[]>()
    const lifecycle = createXiaoguiDirectCodingToolLifecycleV2({
      context: () => context(phase),
      sourceSessionId: () => 'pi-session-1',
    })
    await lifecycle.factory({
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      }),
    } as unknown as ExtensionAPI)

    const toolCall = handlers.get('tool_call')![0]
    await expect(toolCall({
      toolName: 'write',
      toolCallId: 'write-ask',
      input: { path: 'src/a.ts', content: 'x' },
    } as never, {} as never)).resolves.toEqual({
      block: true,
      reason: 'XIAOGUI_CODING_PHASE_READ_ONLY',
      terminate: true,
    })
    expect(requestWorkerHostToolMock).not.toHaveBeenCalled()

    requestWorkerHostToolMock.mockImplementation(async (request) => {
      trace.push(request.method)
      if (request.method.endsWith('preflight.v4')) {
        return {
          ok: true,
          value: {
            kind: 'XIAOGUI_DIRECT_CODING_PREFLIGHT',
            subject: 'DIRECT_SESSION',
            decision: 'ALLOW',
            state: 'ALLOWED',
            requestDigest: request.payload.requestDigest,
            reasonCode: 'USER_ALLOWED_ONCE',
            authorizedRelativePath: 'src/a.ts',
          },
        }
      }
      if (request.method.endsWith('begin.v4')) {
        return {
          ok: true,
          value: {
            kind: 'XIAOGUI_DIRECT_CODING_BEGIN',
            subject: 'DIRECT_SESSION',
            decision: 'ALLOW',
            state: 'EXECUTING',
            requestDigest: request.payload.requestDigest,
            reasonCode: 'EXECUTION_STARTED',
            authorizedRelativePath: 'src/a.ts',
          },
        }
      }
      return {
        ok: true,
        value: {
          kind: 'XIAOGUI_DIRECT_CODING_SETTLED',
          subject: 'DIRECT_SESSION',
          state: 'SETTLED',
          requestDigest: request.payload.requestDigest,
        },
      }
    })

    phase = 'EXECUTE'
    await expect(toolCall({
      toolName: 'write',
      toolCallId: 'write-execute',
      input: { path: './src/a.ts', content: 'after' },
    } as never, {} as never)).resolves.toBeUndefined()

    const executedParams: Array<Record<string, unknown>> = []
    const wrapped = lifecycle.wrapDefinition(writeDefinition(trace, executedParams))
    expect(wrapped.executionMode).toBe('sequential')
    await expect(wrapped.execute(
      'write-execute',
      { path: './src/a.ts', content: 'after' },
      undefined,
      undefined,
      {} as never,
    )).resolves.toMatchObject({ content: [{ type: 'text', text: 'wrote' }] })
    expect(executedParams).toEqual([{ path: 'src/a.ts', content: 'after' }])
    await expect(handlers.get('tool_result')![0]({
      toolCallId: 'write-execute',
      toolName: 'write',
      input: { path: './src/a.ts', content: 'after' },
      content: [{ type: 'text', text: 'wrote' }],
      details: undefined,
      isError: false,
    } as never, {} as never)).resolves.toBeUndefined()

    expect(trace).toEqual([
      'xiaogui.coding.direct.preflight.v4',
      'xiaogui.coding.direct.begin.v4',
      'tool.execute',
      'xiaogui.coding.direct.settle.v2',
    ])
  })

  it('forwards raw Pi paths to Main for canonical project-bound validation and leaves read parallel', async () => {
    const handlers = new Map<string, Handler[]>()
    const lifecycle = createXiaoguiDirectCodingToolLifecycleV2({
      context: () => context('EXECUTE'),
      sourceSessionId: () => 'pi-session-1',
    })
    await lifecycle.factory({
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      }),
    } as unknown as ExtensionAPI)
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: {
        kind: 'XIAOGUI_DIRECT_CODING_PREFLIGHT',
        subject: 'DIRECT_SESSION',
        decision: 'DENY',
        state: 'SETTLED',
        requestDigest: `sha256:${'a'.repeat(64)}`,
        reasonCode: 'PATH_OUTSIDE_PROJECT',
      },
    })
    await expect(handlers.get('tool_call')![0]({
      toolName: 'write',
      toolCallId: 'write-outside',
      input: { path: '../outside.txt', content: 'x' },
    } as never, {} as never)).resolves.toMatchObject({
      block: true,
      reason: 'PATH_OUTSIDE_PROJECT',
    })
    expect(requestWorkerHostToolMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'xiaogui.coding.direct.preflight.v4',
      payload: expect.objectContaining({ path: '../outside.txt' }),
    }))
    expect(lifecycle.wrapDefinition(readDefinition()).executionMode).toBeUndefined()
  })

  it('keeps bound research/review roles read-only even during EXECUTE', async () => {
    const handlers = new Map<string, Handler[]>()
    const lifecycle = createXiaoguiDirectCodingToolLifecycleV2({
      context: () => context('EXECUTE'),
      sourceSessionId: () => 'pi-session-1',
      readOnlyRole: () => true,
    })
    await lifecycle.factory({
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      }),
    } as unknown as ExtensionAPI)
    await expect(handlers.get('tool_call')![0]({
      toolName: 'bash',
      toolCallId: 'research-bash',
      input: { command: 'git status' },
    } as never, {} as never)).resolves.toMatchObject({
      block: true,
      reason: 'XIAOGUI_CODING_ROLE_TOOL_BLOCKED',
    })
    expect(requestWorkerHostToolMock).not.toHaveBeenCalled()
  })

  it('sends the exact multiline Bash command and its digest without truncation', async () => {
    const handlers = new Map<string, Handler[]>()
    const lifecycle = createXiaoguiDirectCodingToolLifecycleV2({
      context: () => context('EXECUTE'),
      sourceSessionId: () => 'pi-session-1',
    })
    await lifecycle.factory({
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      }),
    } as unknown as ExtensionAPI)
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: {
        kind: 'XIAOGUI_DIRECT_CODING_PREFLIGHT',
        subject: 'DIRECT_SESSION',
        decision: 'DENY',
        state: 'SETTLED',
        requestDigest: `sha256:${'a'.repeat(64)}`,
        reasonCode: 'USER_OR_POLICY_DENIED',
      },
    })
    const command = `echo first\n${'x'.repeat(500)}`
    await handlers.get('tool_call')![0]({
      toolName: 'bash',
      toolCallId: 'bash-preview',
      input: { command },
    } as never, {} as never)
    const payload = requestWorkerHostToolMock.mock.calls[0][0].payload
    expect(payload.commandText).toBe(command)
    expect(payload.commandDigest).toBe(digestForTest(command))
  })

  it('rejects a Bash command larger than 64 KiB before opening a permission request', async () => {
    const handlers = new Map<string, Handler[]>()
    const lifecycle = createXiaoguiDirectCodingToolLifecycleV2({
      context: () => context('EXECUTE'),
      sourceSessionId: () => 'pi-session-1',
    })
    await lifecycle.factory({
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      }),
    } as unknown as ExtensionAPI)

    await expect(handlers.get('tool_call')![0]({
      toolName: 'bash',
      toolCallId: 'bash-too-large',
      input: { command: 'x'.repeat(64 * 1024 + 1) },
    } as never, {} as never)).resolves.toEqual({
      block: true,
      reason: 'XIAOGUI_CODING_COMMAND_REJECTED',
      terminate: true,
    })
    expect(requestWorkerHostToolMock).not.toHaveBeenCalled()
  })

  it.each(['\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069'])(
    'rejects Unicode direction control %s before Main',
    async (control) => {
      const handlers = new Map<string, Handler[]>()
      const lifecycle = createXiaoguiDirectCodingToolLifecycleV2({
        context: () => context('EXECUTE'),
        sourceSessionId: () => 'pi-session-1',
      })
      await lifecycle.factory({
        on: vi.fn((event: string, handler: Handler) => {
          handlers.set(event, [...(handlers.get(event) ?? []), handler])
        }),
      } as unknown as ExtensionAPI)

      await expect(handlers.get('tool_call')![0]({
        toolName: 'bash',
        toolCallId: `bash-bidi-${control.codePointAt(0)}`,
        input: { command: `echo safe${control}dangerous` },
      } as never, {} as never)).resolves.toEqual({
        block: true,
        reason: 'XIAOGUI_CODING_COMMAND_REJECTED',
        terminate: true,
      })
      expect(requestWorkerHostToolMock).not.toHaveBeenCalled()
    },
  )

  it('refuses execution when begin returns a different authorized path', async () => {
    const handlers = new Map<string, Handler[]>()
    const lifecycle = createXiaoguiDirectCodingToolLifecycleV2({
      context: () => context('EXECUTE'),
      sourceSessionId: () => 'pi-session-1',
    })
    await lifecycle.factory({
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      }),
    } as unknown as ExtensionAPI)
    requestWorkerHostToolMock.mockImplementation(async (request) => ({
      ok: true,
      value: request.method.endsWith('preflight.v4')
        ? {
            kind: 'XIAOGUI_DIRECT_CODING_PREFLIGHT',
            subject: 'DIRECT_SESSION',
            decision: 'ALLOW',
            state: 'ALLOWED',
            requestDigest: request.payload.requestDigest,
            reasonCode: 'USER_ALLOWED_ONCE',
            authorizedRelativePath: 'src/a.ts',
          }
        : {
            kind: 'XIAOGUI_DIRECT_CODING_BEGIN',
            subject: 'DIRECT_SESSION',
            decision: 'ALLOW',
            state: 'EXECUTING',
            requestDigest: request.payload.requestDigest,
            reasonCode: 'EXECUTION_STARTED',
            authorizedRelativePath: 'src/other.ts',
          },
    }))
    const input = { path: './src/a.ts', content: 'after' }
    await expect(handlers.get('tool_call')![0]({
      toolName: 'write',
      toolCallId: 'write-path-mismatch',
      input,
    } as never, {} as never)).resolves.toBeUndefined()
    const execute = vi.fn()
    const wrapped = lifecycle.wrapDefinition({
      ...writeDefinition([]),
      execute,
    })
    await expect(wrapped.execute('write-path-mismatch', input, undefined, undefined, {} as never))
      .rejects.toThrow('XIAOGUI_CODING_AUTHORIZED_PATH_MISMATCH')
    expect(execute).not.toHaveBeenCalled()
    expect(input).toEqual({ path: './src/a.ts', content: 'after' })
  })

  it('keeps CODING workspace tools active for a neutral EXECUTE turn and runs its real Pi write call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaogui-pi-write-smoke-'))
    roots.push(root)
    writeFileSync(join(root, 'unrelated.txt'), 'keep me')
    const selection = selectXiaoguiTurnCapabilitiesV1({
      mode: 'CODING',
      enabledCapabilities: [],
    }, '做一个单文件 HTML 贪吃蛇，直接写到项目中')
    const turnContext = {
      ...context('EXECUTE'),
      enabledCapabilities: selection.capabilityIds,
      availableToolNames: activeToolNamesForPromptContextV1({
        ...context('EXECUTE'),
        enabledCapabilities: selection.capabilityIds,
      }, ['read', 'bash', 'edit', 'write']),
    }
    expect(selection).toMatchObject({
      decision: 'DEFAULT_ONLY',
      capabilityIds: ['coding.workspace'],
      reasonCodes: expect.arrayContaining(['MODE_DEFAULT']),
    })
    expect(turnContext.availableToolNames).toEqual(['bash', 'edit', 'read', 'write'])
    const directSubject = {
      schemaVersion: 2 as const,
      kind: 'DIRECT_SESSION' as const,
      address: {
        projectId: `xgp1_${'c'.repeat(64)}` as ProjectId,
        sessionKey: `xgs1_${'d'.repeat(64)}` as SessionKey,
      },
    } satisfies DirectCodingAuthorizationSubjectV2
    const module = new DirectCodingModuleV2({
      dbPath: join(root, 'direct.sqlite'),
      authorization: {
        decideDirect: vi.fn(async () => ({
          decision: 'ALLOW_ONCE' as const,
          reasonCode: 'MODE_POLICY_AUTO_ALLOWED' as const,
        })),
      },
    })
    requestWorkerHostToolMock.mockImplementation(async (request) => {
      if (request.method.endsWith('preflight.v4')) {
        return {
          ok: true,
          value: await module.preflight({
            subject: directSubject,
            rootPath: root,
            sourceSessionId: request.payload.sourceSessionId,
            toolCallId: request.payload.toolCallId,
            requestDigest: request.payload.requestDigest,
            operation: request.payload.operation,
            path: request.payload.path,
            commandText: request.payload.commandText,
            commandDigest: request.payload.commandDigest,
            mode: 'FULL_AUTONOMY',
            origin: {
              projectLabel: 'Pi smoke',
              sessionLabel: 'Pi lifecycle',
              fromCwd: root,
              fromPoolKey: 'D:/session.jsonl',
              sessionFile: 'D:/session.jsonl',
              sourceSessionId: request.payload.sourceSessionId,
            },
          }),
        }
      }
      if (request.method.endsWith('begin.v4')) {
        return {
          ok: true,
          value: await module.begin({
            subject: directSubject,
            rootPath: root,
            ...request.payload,
          }),
        }
      }
      return {
        ok: true,
        value: await module.settle({
          subject: directSubject,
          rootPath: root,
          ...request.payload,
        }),
      }
    })

    const handlers = new Map<string, Handler[]>()
    const lifecycle = createXiaoguiDirectCodingToolLifecycleV2({
      context: () => turnContext,
      sourceSessionId: () => 'pi-session-1',
    })
    await lifecycle.factory({
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      }),
    } as unknown as ExtensionAPI)
    const event = {
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'real-pi-write',
      input: { path: 'generated.txt', content: 'written by Pi\n' },
    }
    await expect(handlers.get('tool_call')![0](event as never, {} as never)).resolves.toBeUndefined()
    const wrapped = lifecycle.wrapDefinition(createWriteToolDefinition(root))
    const result = await wrapped.execute(
      event.toolCallId,
      event.input,
      undefined,
      undefined,
      {} as never,
    )
    await handlers.get('tool_result')![0]({
      type: 'tool_result',
      toolName: 'write',
      toolCallId: event.toolCallId,
      input: event.input,
      content: result.content,
      details: result.details,
      isError: false,
    } as never, {} as never)

    expect(readFileSync(join(root, 'generated.txt'), 'utf8')).toBe('written by Pi\n')
    expect(readFileSync(join(root, 'unrelated.txt'), 'utf8')).toBe('keep me')
    expect(module.list(directSubject)).toMatchObject({
      ok: true,
      value: {
        checkpoints: [expect.objectContaining({
          relativePath: 'generated.txt',
          existedBefore: false,
          status: 'AVAILABLE',
        })],
      },
    })
    module.close()
  })
})

function context(phase: XiaoguiPromptContextV1['phase']): XiaoguiPromptContextV1 {
  return {
    schemaVersion: 1,
    mode: 'CODING',
    phase,
    workspaceAvailable: true,
    projectTrusted: true,
    enabledCapabilities: ['coding.workspace'],
    availableToolNames: phase === 'EXECUTE' ? ['read', 'bash', 'edit', 'write'] : ['read'],
    sessionKey: `xgs1_${'a'.repeat(64)}`,
    projectId: `xgp1_${'b'.repeat(64)}`,
  }
}

function writeDefinition(
  trace: string[],
  executedParams?: Array<Record<string, unknown>>,
): ToolDefinition<ReturnType<typeof Type.Object>> {
  return {
    name: 'write',
    label: 'write',
    description: 'write',
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute(_toolCallId, params) {
      trace.push('tool.execute')
      executedParams?.push(params as Record<string, unknown>)
      return { content: [{ type: 'text', text: 'wrote' }], details: undefined }
    },
  }
}

function readDefinition(): ToolDefinition<ReturnType<typeof Type.Object>> {
  return {
    name: 'read',
    label: 'read',
    description: 'read',
    parameters: Type.Object({ path: Type.String() }),
    async execute() {
      return { content: [], details: undefined }
    },
  }
}

function digestForTest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}
