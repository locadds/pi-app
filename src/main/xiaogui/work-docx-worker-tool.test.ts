import { describe, expect, it, vi } from 'vitest'

import type { WorkerHostToolRequestV1 } from '@shared/worker-host-tools'
import type { WorkDocxOperationIdV1 } from '@shared/xiaogui-work-docx'

import type { SessionScopeResolverV1 } from './scope-resolver'
import type { PiSessionScopeV1 } from './scope-derive'
import {
  createXiaoguiWorkDocxWorkerToolHandlerV1,
  type WorkDocxWorkerToolServiceV1,
} from './work-docx-worker-tool'

const PROJECT_1 = `xgp1_${'1'.repeat(64)}`
const PROJECT_2 = `xgp1_${'3'.repeat(64)}`
const SESSION_1 = `xgs1_${'2'.repeat(64)}`
const SESSION_2 = `xgs1_${'4'.repeat(64)}`
const OPERATION = 'xgw1_00000000-0000-4000-8000-000000000001' as WorkDocxOperationIdV1

function request(
  action: 'PREPARE' | 'CONFIRM' | 'CANCEL' | 'OPEN' | 'REVEAL',
  overrides?: { sourceSessionId?: string; sourceRunId?: string },
): WorkerHostToolRequestV1 {
  return {
    type: 'host-tool-request',
    requestId: `host-${action}`,
    method: 'xiaogui.work.docx.v1',
    payload: {
      action,
      sourceSessionId: overrides?.sourceSessionId ?? 'pi-session-1',
      sourceRunId: overrides?.sourceRunId ?? 'run-prepare',
      toolCallId: `call-${action}`,
    },
  }
}

function scope(
  sessionMode: 'WORK' | 'DESIGN' | 'CODING' = 'WORK',
  second = false,
): PiSessionScopeV1 {
  return {
    projectId: (second ? PROJECT_2 : PROJECT_1) as never,
    sessionKey: (second ? SESSION_2 : SESSION_1) as never,
    sessionMode,
    rootPath: second ? 'D:/other' : 'D:/project',
    sessionFile: second ? 'D:/other-session.jsonl' : 'D:/session.jsonl',
  }
}

function setup(initialScope: PiSessionScopeV1 | null = scope()) {
  const resolveExisting = vi.fn(async () => initialScope)
  const prepare = vi.fn(async () => ({
    ok: true as const,
    value: {
      kind: 'PREPARED' as const,
      operationId: OPERATION,
      templateDisplayName: '模板.docx',
      payloadDisplayName: '数据.json',
      placeholders: ['title'],
      templateSha256: 'a'.repeat(64),
      payloadSha256: 'b'.repeat(64),
    },
  }))
  const confirm = vi.fn(async () => ({
    ok: true as const,
    value: {
      kind: 'PUBLISHED' as const,
      operationId: OPERATION,
      outputSha256: 'c'.repeat(64),
      templateSha256: 'a'.repeat(64),
      payloadSha256: 'b'.repeat(64),
      originalInputsUnchanged: true as const,
    },
  }))
  const cancel = vi.fn(async () => ({
    ok: true as const,
    value: { kind: 'CANCELLED' as const, operationId: OPERATION },
  }))
  const accessOutput = vi.fn(async (input: { action: 'OPEN' | 'REVEAL' }) => ({
    ok: true as const,
    value: { kind: 'ACCESSED' as const, operationId: OPERATION, action: input.action },
  }))
  const service = { prepare, confirm, cancel, accessOutput } as unknown as WorkDocxWorkerToolServiceV1
  const getService = vi.fn(() => service)
  const handler = createXiaoguiWorkDocxWorkerToolHandlerV1({
    scopeResolver: { resolveExisting } as unknown as SessionScopeResolverV1,
    getService,
  })
  const metadata = (toolRequest: WorkerHostToolRequestV1, second = false) => ({
    request: toolRequest,
    fromCwd: second ? 'D:/other' : 'D:/project',
    fromPoolKey: second ? 'D:/other-session.jsonl' : 'D:/session.jsonl',
    sessionFile: second ? 'D:/other-session.jsonl' : 'D:/session.jsonl',
    fromSessionId: second ? 'pi-session-2' : 'pi-session-1',
  })
  return {
    handler,
    metadata,
    resolveExisting,
    getService,
    prepare,
    confirm,
    cancel,
    accessOutput,
  }
}

describe('WORK DOCX Worker host-tool adapter', () => {
  it('derives the trusted address and PREPARE never publishes or exposes an operation identifier', async () => {
    const test = setup()

    const outcome = await test.handler(test.metadata(request('PREPARE')))

    expect(test.resolveExisting).toHaveBeenCalledWith({
      rootPath: 'D:/project',
      sessionFile: 'D:/session.jsonl',
    })
    expect(test.prepare).toHaveBeenCalledWith({
      address: { projectId: PROJECT_1, sessionKey: SESSION_1 },
    })
    expect(test.confirm).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_PREPARED',
        templateDisplayName: '模板.docx',
        payloadDisplayName: '数据.json',
      },
    })
    expect(outcome).not.toHaveProperty('value.operationId')
  })

  it('rejects same-turn confirmation before service access and accepts a later user turn', async () => {
    const test = setup()
    await test.handler(test.metadata(request('PREPARE', { sourceRunId: 'run-1' })))

    const sameTurn = await test.handler(
      test.metadata(request('CONFIRM', { sourceRunId: 'run-1' })),
    )
    expect(sameTurn).toMatchObject({
      ok: false,
      error: { code: 'WORK_DOCX_CONFIRMATION_REQUIRED' },
    })
    expect(test.confirm).not.toHaveBeenCalled()

    const laterTurn = await test.handler(
      test.metadata(request('CONFIRM', { sourceRunId: 'run-2' })),
    )
    expect(test.confirm).toHaveBeenCalledWith({
      address: { projectId: PROJECT_1, sessionKey: SESSION_1 },
      operationId: OPERATION,
    })
    expect(laterTurn).toMatchObject({
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCX_PUBLISHED', originalInputsUnchanged: true },
    })
    expect(laterTurn).not.toHaveProperty('value.operationId')
  })

  it('cancels a prepared service operation when the Worker aborts during file selection', async () => {
    const test = setup()
    let finishPrepare!: (value: Awaited<ReturnType<typeof test.prepare>>) => void
    test.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPrepare = resolve
        }),
    )
    const controller = new AbortController()
    const pending = test.handler({
      ...test.metadata(request('PREPARE', { sourceRunId: 'run-1' })),
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(test.prepare).toHaveBeenCalledOnce())

    controller.abort()
    finishPrepare({
      ok: true,
      value: {
        kind: 'PREPARED',
        operationId: OPERATION,
        templateDisplayName: '模板.docx',
        payloadDisplayName: '数据.json',
        placeholders: ['title'],
        templateSha256: 'a'.repeat(64),
        payloadSha256: 'b'.repeat(64),
      },
    })

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'HOST_TOOL_ABORTED' },
    })
    expect(test.cancel).toHaveBeenCalledWith({
      address: { projectId: PROJECT_1, sessionKey: SESSION_1 },
      operationId: OPERATION,
    })

    await test.handler(test.metadata(request('PREPARE', { sourceRunId: 'run-2' })))
    expect(test.prepare).toHaveBeenCalledTimes(2)
  })

  it.each(['DESIGN', 'CODING'] as const)(
    'keeps %s sessions read-only before any service or dialog can run',
    async (mode) => {
      const test = setup(scope(mode))

      const outcome = await test.handler(test.metadata(request('PREPARE')))

      expect(outcome).toMatchObject({ ok: false, error: { code: 'MODE_NOT_ALLOWED' } })
      expect(test.getService).not.toHaveBeenCalled()
      expect(test.prepare).not.toHaveBeenCalled()
    },
  )

  it('fails closed for an unbound scope, missing session file, and a reused Worker session mismatch', async () => {
    const unbound = setup(null)
    await expect(unbound.handler(unbound.metadata(request('PREPARE')))).resolves.toMatchObject({
      ok: false,
      error: { code: 'SESSION_SCOPE_MISMATCH' },
    })
    expect(unbound.getService).not.toHaveBeenCalled()

    const missing = setup()
    await expect(
      missing.handler({ ...missing.metadata(request('PREPARE')), sessionFile: null }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'SESSION_NOT_READY' } })
    expect(missing.resolveExisting).not.toHaveBeenCalled()

    const switched = setup()
    await expect(
      switched.handler(
        switched.metadata(request('PREPARE', { sourceSessionId: 'stale-session' })),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'SESSION_SCOPE_MISMATCH' } })
    expect(switched.resolveExisting).not.toHaveBeenCalled()
  })

  it('does not let another trusted session consume a pending operation', async () => {
    const test = setup()
    await test.handler(test.metadata(request('PREPARE', { sourceRunId: 'run-1' })))
    test.resolveExisting.mockResolvedValueOnce(scope('WORK', true))

    const outcome = await test.handler(
      test.metadata(
        request('CONFIRM', { sourceSessionId: 'pi-session-2', sourceRunId: 'run-2' }),
        true,
      ),
    )

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'WORK_DOCX_NO_PENDING_OPERATION' },
    })
    expect(test.confirm).not.toHaveBeenCalled()
  })

  it('routes cancel, open, and reveal through the operation bound inside the main process', async () => {
    const cancelled = setup()
    await cancelled.handler(cancelled.metadata(request('PREPARE', { sourceRunId: 'run-1' })))
    await expect(
      cancelled.handler(cancelled.metadata(request('CANCEL', { sourceRunId: 'run-2' }))),
    ).resolves.toMatchObject({ ok: true, value: { kind: 'XIAOGUI_WORK_DOCX_CANCELLED' } })
    expect(cancelled.cancel).toHaveBeenCalledWith({
      address: { projectId: PROJECT_1, sessionKey: SESSION_1 },
      operationId: OPERATION,
    })

    const published = setup()
    await published.handler(published.metadata(request('PREPARE', { sourceRunId: 'run-1' })))
    await published.handler(published.metadata(request('CONFIRM', { sourceRunId: 'run-2' })))
    await published.handler(published.metadata(request('OPEN', { sourceRunId: 'run-3' })))
    await published.handler(published.metadata(request('REVEAL', { sourceRunId: 'run-4' })))

    expect(published.accessOutput).toHaveBeenNthCalledWith(1, {
      address: { projectId: PROJECT_1, sessionKey: SESSION_1 },
      operationId: OPERATION,
      action: 'OPEN',
    })
    expect(published.accessOutput).toHaveBeenNthCalledWith(2, {
      address: { projectId: PROJECT_1, sessionKey: SESSION_1 },
      operationId: OPERATION,
      action: 'REVEAL',
    })
  })

  it('retains and safely replays the prepared summary when cancellation cleanup fails', async () => {
    const test = setup()
    test.cancel.mockResolvedValueOnce(
      {
        ok: false,
        error: { code: 'PUBLISH_FAILED', messageKey: 'xiaogui.work.docx.publish_failed' },
      } as never,
    )
    await test.handler(test.metadata(request('PREPARE', { sourceRunId: 'run-1' })))

    await expect(
      test.handler(test.metadata(request('CANCEL', { sourceRunId: 'run-2' }))),
    ).resolves.toMatchObject({ ok: false, error: { code: 'PUBLISH_FAILED' } })
    const replayed = await test.handler(
      test.metadata(request('PREPARE', { sourceRunId: 'run-3' })),
    )

    expect(replayed).toMatchObject({
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCX_PREPARED', templateDisplayName: '模板.docx' },
    })
    expect(test.prepare).toHaveBeenCalledOnce()
    await expect(
      test.handler(test.metadata(request('CONFIRM', { sourceRunId: 'run-3' }))),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'WORK_DOCX_CONFIRMATION_REQUIRED' },
    })
    expect(test.confirm).not.toHaveBeenCalled()
  })
})
