import { existsSync } from 'node:fs'
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWriteToolDefinition, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import { Type } from 'typebox'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { requestWorkerHostTool } from '../worker-host-tool-channel'
import type { WorkerHostToolOutcomeV1 } from '@shared/worker-host-tools'

import { createPiAttemptToolLifecycleV1 } from './attempt-tool-extension'

type HostRequest = Parameters<typeof requestWorkerHostTool>[0]
type HostOutcome = WorkerHostToolOutcomeV1

// The request stub below models the Main/provider port only; it is not a full Runtime acceptance.
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Pi Attempt native tool wrapper', () => {
  it('runs the native SDK write with Main’s copied path and settles', async () => {
    const root = await tempRoot()
    const requests: HostRequest[] = []
    const request = async (hostRequest: HostRequest): Promise<HostOutcome> => {
      requests.push(hostRequest)
      if (hostRequest.method === 'xiaogui.taskhub.pi.tool.begin') {
        return allowed(hostRequest.payload.toolCallId, 'authorized/output.txt')
      }
      return settled(hostRequest.payload.toolCallId)
    }
    const lifecycle = createPiAttemptToolLifecycleV1({
      attemptId: 'attempt-1',
      sourceSessionId: () => 'session-1',
      request,
    })
    const wrapped = lifecycle.wrapDefinition(createWriteToolDefinition(root))
    const input = { path: 'requested.txt', content: 'written by Attempt\n' }

    await wrapped.execute('call-1', input, undefined, undefined, {} as never)

    await expect(readFile(join(root, 'authorized', 'output.txt'), 'utf8')).resolves.toBe('written by Attempt\n')
    expect(existsSync(join(root, 'requested.txt'))).toBe(false)
    expect(input).toEqual({ path: 'requested.txt', content: 'written by Attempt\n' })
    expect(wrapped.executionMode).toBe('sequential')
    expect(requests).toEqual([
      {
        method: 'xiaogui.taskhub.pi.tool.begin',
        payload: {
          attemptId: 'attempt-1',
          sourceSessionId: 'session-1',
          toolCallId: 'call-1',
          toolName: 'write',
          input,
        },
      },
      {
        method: 'xiaogui.taskhub.pi.tool.settle',
        payload: {
          attemptId: 'attempt-1',
          sourceSessionId: 'session-1',
          toolCallId: 'call-1',
          isError: false,
        },
      },
    ])
  })

  it('does not execute or settle when Main denies begin', async () => {
    const root = await tempRoot()
    const requests: HostRequest[] = []
    const request = async (hostRequest: HostRequest): Promise<HostOutcome> => {
      requests.push(hostRequest)
      return {
        ok: false,
        error: { code: 'HOST_TOOL_FAILED', message: 'denied' },
      }
    }
    const lifecycle = createPiAttemptToolLifecycleV1({
      attemptId: 'attempt-1',
      sourceSessionId: () => 'session-1',
      request,
    })
    const wrapped = lifecycle.wrapDefinition(createWriteToolDefinition(root))

    await expect(wrapped.execute(
      'denied-call',
      { path: 'denied.txt', content: 'must not write' },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow('PI_ATTEMPT_TOOL_NOT_AUTHORIZED')

    expect(existsSync(join(root, 'denied.txt'))).toBe(false)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('xiaogui.taskhub.pi.tool.begin')
  })

  it.each([
    '/absolute.txt',
    'C:/absolute.txt',
    '../escape.txt',
    '.git/config',
    'nested/../escape.txt',
    'nested\\escape.txt',
  ])('rejects non-normalized authorized path %s without writing', async (authorizedRelativePath) => {
    const root = await tempRoot()
    const requests: HostRequest[] = []
    const request = async (hostRequest: HostRequest): Promise<HostOutcome> => {
      requests.push(hostRequest)
      return hostRequest.method === 'xiaogui.taskhub.pi.tool.begin'
        ? allowed(hostRequest.payload.toolCallId, authorizedRelativePath)
        : settled(hostRequest.payload.toolCallId)
    }
    const lifecycle = createPiAttemptToolLifecycleV1({
      attemptId: 'attempt-1',
      sourceSessionId: () => 'session-1',
      request,
    })
    const wrapped = lifecycle.wrapDefinition(createWriteToolDefinition(root))

    await expect(wrapped.execute(
      'invalid-path-call',
      { path: 'requested.txt', content: 'must not write' },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow('PI_ATTEMPT_TOOL_NOT_AUTHORIZED')

    expect(existsSync(join(root, 'requested.txt'))).toBe(false)
    expect(requests.map((entry) => entry.method)).toEqual(['xiaogui.taskhub.pi.tool.begin'])
  })

  it('reports an unknown outcome when settle is not acknowledged', async () => {
    const root = await tempRoot()
    const requests: HostRequest[] = []
    const request = async (hostRequest: HostRequest): Promise<HostOutcome> => {
      requests.push(hostRequest)
      if (hostRequest.method === 'xiaogui.taskhub.pi.tool.begin') {
        return allowed(hostRequest.payload.toolCallId, 'written.txt')
      }
      return settled('different-call')
    }
    const lifecycle = createPiAttemptToolLifecycleV1({
      attemptId: 'attempt-1',
      sourceSessionId: () => 'session-1',
      request,
    })
    const wrapped = lifecycle.wrapDefinition(createWriteToolDefinition(root))

    await expect(wrapped.execute(
      'settle-fails',
      { path: 'requested.txt', content: 'written before unknown' },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow('PI_ATTEMPT_TOOL_OUTCOME_UNKNOWN')

    await expect(readFile(join(root, 'written.txt'), 'utf8')).resolves.toBe('written before unknown')
    expect(requests.map((entry) => entry.method)).toEqual([
      'xiaogui.taskhub.pi.tool.begin',
      'xiaogui.taskhub.pi.tool.settle',
    ])
  })

  it('settles native tool exceptions as errors before rethrowing them', async () => {
    const root = await tempRoot()
    const requests: HostRequest[] = []
    const request = async (hostRequest: HostRequest): Promise<HostOutcome> => {
      requests.push(hostRequest)
      return hostRequest.method === 'xiaogui.taskhub.pi.tool.begin'
        ? allowed(hostRequest.payload.toolCallId, 'failed.txt')
        : settled(hostRequest.payload.toolCallId)
    }
    const lifecycle = createPiAttemptToolLifecycleV1({
      attemptId: 'attempt-1',
      sourceSessionId: () => 'session-1',
      request,
    })
    const definition: ToolDefinition<ReturnType<typeof Type.Object>> = {
      name: 'write',
      label: 'write',
      description: 'write',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute() {
        throw new Error('native failure')
      },
    }

    await expect(lifecycle.wrapDefinition(definition).execute(
      'native-fails',
      { path: 'requested.txt', content: 'must not write' },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow('native failure')
    expect(requests[1]).toMatchObject({
      method: 'xiaogui.taskhub.pi.tool.settle',
      payload: { toolCallId: 'native-fails', isError: true },
    })
  })

  it('settles an authorized cancellation without invoking the native tool', async () => {
    const root = await tempRoot()
    const requests: HostRequest[] = []
    let resolveBegin: ((outcome: HostOutcome) => void) | undefined
    const begin = new Promise<HostOutcome>((resolve) => { resolveBegin = resolve })
    const request = async (hostRequest: HostRequest): Promise<HostOutcome> => {
      requests.push(hostRequest)
      if (hostRequest.method === 'xiaogui.taskhub.pi.tool.begin') return begin
      return settled(hostRequest.payload.toolCallId)
    }
    const lifecycle = createPiAttemptToolLifecycleV1({
      attemptId: 'attempt-1',
      sourceSessionId: () => 'session-1',
      request,
    })
    const wrapped = lifecycle.wrapDefinition(createWriteToolDefinition(root))
    const controller = new AbortController()
    const execution = wrapped.execute(
      'cancel-after-allow',
      { path: 'requested.txt', content: 'must not write' },
      controller.signal,
      undefined,
      {} as never,
    )

    await vi.waitFor(() => expect(requests).toHaveLength(1))
    resolveBegin!(allowed('cancel-after-allow', 'authorized/cancelled.txt'))
    controller.abort()

    await expect(execution).rejects.toThrow('PI_ATTEMPT_TOOL_ABORTED')
    expect(existsSync(join(root, 'authorized', 'cancelled.txt'))).toBe(false)
    expect(requests.map((entry) => entry.method)).toEqual([
      'xiaogui.taskhub.pi.tool.begin',
      'xiaogui.taskhub.pi.tool.settle',
    ])
    expect(requests[1]).toMatchObject({
      payload: {
        attemptId: 'attempt-1',
        sourceSessionId: 'session-1',
        toolCallId: 'cancel-after-allow',
        isError: true,
      },
    })
  })

  it('serializes begin, native execution, and settle across wrapped file tools', async () => {
    const root = await tempRoot()
    const requests: HostRequest[] = []
    let resolveFirstBegin: ((outcome: HostOutcome) => void) | undefined
    const firstBegin = new Promise<HostOutcome>((resolve) => { resolveFirstBegin = resolve })
    const request = async (hostRequest: HostRequest): Promise<HostOutcome> => {
      requests.push(hostRequest)
      if (hostRequest.method === 'xiaogui.taskhub.pi.tool.begin' && hostRequest.payload.toolCallId === 'first') {
        return firstBegin
      }
      if (hostRequest.method === 'xiaogui.taskhub.pi.tool.begin') {
        return allowed(hostRequest.payload.toolCallId, `${hostRequest.payload.toolCallId}.txt`)
      }
      return settled(hostRequest.payload.toolCallId)
    }
    const lifecycle = createPiAttemptToolLifecycleV1({
      attemptId: 'attempt-1',
      sourceSessionId: () => 'session-1',
      request,
    })
    const wrapped = lifecycle.wrapDefinition(createWriteToolDefinition(root))
    const first = wrapped.execute('first', { path: 'first-request.txt', content: 'first' }, undefined, undefined, {} as never)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    const second = wrapped.execute('second', { path: 'second-request.txt', content: 'second' }, undefined, undefined, {} as never)
    await Promise.resolve()
    expect(requests).toHaveLength(1)

    resolveFirstBegin!(allowed('first', 'first.txt'))
    await Promise.all([first, second])

    expect(requests.map((entry) => entry.method)).toEqual([
      'xiaogui.taskhub.pi.tool.begin',
      'xiaogui.taskhub.pi.tool.settle',
      'xiaogui.taskhub.pi.tool.begin',
      'xiaogui.taskhub.pi.tool.settle',
    ])
  })

  it('rejects bash and other non-file tools instead of wrapping them', () => {
    const lifecycle = createPiAttemptToolLifecycleV1({
      attemptId: 'attempt-1',
      sourceSessionId: () => 'session-1',
    })
    const definition: ToolDefinition<TSchema> = {
      name: 'bash',
      label: 'bash',
      description: 'bash',
      parameters: Type.Object({}),
      async execute() {
        return { content: [], details: undefined }
      },
    }

    expect(() => lifecycle.wrapDefinition(definition)).toThrow('PI_ATTEMPT_TOOL_UNSUPPORTED')
  })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-pi-attempt-tool-'))
  roots.push(root)
  return root
}

function allowed(toolCallId: string, authorizedRelativePath: string): HostOutcome {
  return {
    ok: true,
    value: { kind: 'PI_ATTEMPT_TOOL_ALLOWED', toolCallId, authorizedRelativePath },
  }
}

function settled(toolCallId: string): HostOutcome {
  return {
    ok: true,
    value: { kind: 'PI_ATTEMPT_TOOL_SETTLED', toolCallId },
  }
}
