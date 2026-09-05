import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import type { SessionScopeResolverV1 } from '../scope-resolver'
import { createDirectCodingWorkerToolHandlerV2 } from './direct-coding-worker-tool'

vi.mock('../../session-display-names', () => ({
  resolveSessionListTitle: vi.fn((_path: string, fallback: string) => fallback),
}))

const digest = `sha256:${'a'.repeat(64)}`

function setup(phase: 'ASK' | 'PLAN' | 'EXECUTE' = 'EXECUTE', sessionMode = 'CODING') {
  const module = {
    preflight: vi.fn(async (input) => ({
      kind: 'XIAOGUI_DIRECT_CODING_PREFLIGHT' as const,
      subject: 'DIRECT_SESSION' as const,
      decision: 'ALLOW' as const,
      state: 'ALLOWED' as const,
      requestDigest: input.requestDigest,
      reasonCode: 'USER_ALLOWED_ONCE',
    })),
    begin: vi.fn((input) => ({
      kind: 'XIAOGUI_DIRECT_CODING_BEGIN' as const,
      subject: 'DIRECT_SESSION' as const,
      decision: 'ALLOW' as const,
      state: 'EXECUTING' as const,
      requestDigest: input.requestDigest,
      reasonCode: 'EXECUTION_STARTED',
    })),
    settle: vi.fn((input) => ({
      kind: 'XIAOGUI_DIRECT_CODING_SETTLED' as const,
      subject: 'DIRECT_SESSION' as const,
      state: 'SETTLED' as const,
      requestDigest: input.requestDigest,
    })),
  }
  const resolveExisting = vi.fn(async () => ({
    projectId: `xgp1_${'1'.repeat(64)}`,
    sessionKey: `xgs1_${'2'.repeat(64)}`,
    sessionMode,
    rootPath: 'D:/project',
    sessionFile: 'D:/session.jsonl',
  }))
  const handler = createDirectCodingWorkerToolHandlerV2({
    module: module as never,
    scopeResolver: { resolveExisting } as unknown as SessionScopeResolverV1,
    readPhase: () => phase,
    readMode: () => 'AUTO_APPROVE',
  })
  return { handler, module, resolveExisting }
}

const metadata = (request: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  request,
  fromCwd: 'D:/project',
  fromPoolKey: 'D:/session.jsonl',
  sessionFile: 'D:/session.jsonl',
  fromSessionId: 'session-1',
  ...overrides,
})

describe('Direct CODING Worker-to-Main Adapter V2', () => {
  it('derives the canonical direct subject and ignores model-supplied project identity', async () => {
    const { handler, module } = setup()
    const request = {
      type: 'host-tool-request',
      requestId: 'request-1',
      method: 'xiaogui.coding.direct.preflight.v3',
      payload: {
        sourceSessionId: 'session-1',
        toolCallId: 'write-1',
        requestDigest: digest,
        phase: 'EXECUTE',
        operation: 'WRITE',
        path: 'D:/project/src/a.ts',
      },
    }
    await expect(handler(metadata(request) as never)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'XIAOGUI_DIRECT_CODING_PREFLIGHT' },
    })
    expect(module.preflight).toHaveBeenCalledWith(expect.objectContaining({
      subject: {
        schemaVersion: 2,
        kind: 'DIRECT_SESSION',
        address: {
          projectId: `xgp1_${'1'.repeat(64)}`,
          sessionKey: `xgs1_${'2'.repeat(64)}`,
        },
      },
      rootPath: 'D:/project',
      operation: 'WRITE',
      path: 'D:/project/src/a.ts',
      mode: 'AUTO_APPROVE',
      origin: expect.objectContaining({
        projectLabel: 'project',
        sourceSessionId: 'session-1',
      }),
    }))
  })

  it('rejects mutation outside EXECUTE and a stale/non-CODING session before Module access', async () => {
    const ask = setup('ASK')
    const request = {
      type: 'host-tool-request',
      requestId: 'request-2',
      method: 'xiaogui.coding.direct.preflight.v3',
      payload: {
        sourceSessionId: 'session-1',
        toolCallId: 'write-ask',
        requestDigest: digest,
        phase: 'ASK',
        operation: 'WRITE',
        path: './src/a.ts',
      },
    }
    await expect(ask.handler(metadata(request) as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'DIRECT_CODING_PERMISSION_DENIED' },
    })
    expect(ask.module.preflight).not.toHaveBeenCalled()

    const wrongMode = setup('EXECUTE', 'WORK')
    await expect(wrongMode.handler(metadata(request, { fromSessionId: 'session-2' }) as never))
      .resolves.toMatchObject({ ok: false, error: { code: 'SESSION_SCOPE_MISMATCH' } })
    expect(wrongMode.module.preflight).not.toHaveBeenCalled()
  })

  it('routes begin/settle by the same session and rejects added path or Attempt fields', async () => {
    const { handler, module } = setup()
    const base = {
      sourceSessionId: 'session-1',
      toolCallId: 'write-1',
      requestDigest: digest,
    }
    await handler(metadata({
      type: 'host-tool-request',
      requestId: 'begin-1',
      method: 'xiaogui.coding.direct.begin.v2',
      payload: base,
    }) as never)
    await handler(metadata({
      type: 'host-tool-request',
      requestId: 'settle-1',
      method: 'xiaogui.coding.direct.settle.v2',
      payload: { ...base, isError: false },
    }) as never)
    expect(module.begin).toHaveBeenCalledOnce()
    expect(module.settle).toHaveBeenCalledOnce()

    await expect(handler(metadata({
      type: 'host-tool-request',
      requestId: 'unsafe-1',
      method: 'xiaogui.coding.direct.begin.v2',
      payload: { ...base, attemptId: 'forged', rootPath: 'D:/secret' },
    }) as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'DIRECT_CODING_REQUEST_INVALID' },
    })
  })

  it('rejects a Bash request without the exact command and full-command digest', async () => {
    const { handler, module } = setup()
    await expect(handler(metadata({
      type: 'host-tool-request',
      requestId: 'bash-invalid',
      method: 'xiaogui.coding.direct.preflight.v3',
      payload: {
        sourceSessionId: 'session-1',
        toolCallId: 'bash-1',
        requestDigest: digest,
        phase: 'EXECUTE',
        operation: 'BASH',
      },
    }) as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'DIRECT_CODING_REQUEST_INVALID' },
    })
    expect(module.preflight).not.toHaveBeenCalled()
  })

  it('preserves the complete multiline Bash command and binds its source labels', async () => {
    const { handler, module } = setup()
    const commandText = 'Write-Output first\nWrite-Output second\t# visible'
    const commandDigest = `sha256:${createHash('sha256').update(commandText, 'utf8').digest('hex')}`
    await expect(handler(metadata({
      type: 'host-tool-request',
      requestId: 'bash-complete',
      method: 'xiaogui.coding.direct.preflight.v3',
      payload: {
        sourceSessionId: 'session-1',
        toolCallId: 'bash-complete',
        requestDigest: digest,
        phase: 'EXECUTE',
        operation: 'BASH',
        commandText,
        commandDigest,
      },
    }) as never)).resolves.toMatchObject({ ok: true })
    expect(module.preflight).toHaveBeenCalledWith(expect.objectContaining({
      commandText,
      commandDigest,
      origin: expect.objectContaining({
        projectLabel: 'project',
        sessionLabel: expect.any(String),
        fromPoolKey: 'D:/session.jsonl',
      }),
    }))
  })
})
