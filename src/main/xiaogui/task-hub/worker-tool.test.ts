import { describe, expect, it, vi } from 'vitest'

import type { WorkerHostToolRequestV1 } from '@shared/worker-host-tools'

import type { SessionScopeResolverV1 } from '../scope-resolver'
import type { PiSessionScopeV1 } from '../scope-derive'
import type { CollaborationHubApplicationV1 } from './application'
import { createXiaoguiWorkerToolHandlerV1 } from './worker-tool'

const request: WorkerHostToolRequestV1 = {
  type: 'host-tool-request',
  requestId: 'host-tool-1',
  method: 'xiaogui.collaboration.create-plan-draft',
  payload: {
    toolCallId: 'call-1',
    sourceSessionId: 'session-1',
    sourceTurnId: 'turn-1',
    draft: {
      objective: '完成项目汇报',
      tasks: [
        { taskKey: 'collect', title: '整理材料' },
        { taskKey: 'draft', title: '编写初稿', dependsOn: ['collect'] },
      ],
    },
  },
}

function setup(sessionMode: 'WORK' | 'DESIGN' | 'CODING' = 'WORK') {
  const resolveExisting = vi.fn(async (): Promise<PiSessionScopeV1 | null> => ({
    projectId: `xgp1_${'1'.repeat(64)}` as never,
    sessionKey: `xgs1_${'2'.repeat(64)}` as never,
    sessionMode,
    rootPath: 'D:/project',
    sessionFile: 'D:/session.jsonl',
  }))
  const perform = vi.fn(async () => ({
    ok: true as const,
    value: {
      requestId: 'pi-tool:call-1',
      intentType: 'flow.start.with_draft' as const,
      sessionVersion: 1,
    },
  }))
  const handler = createXiaoguiWorkerToolHandlerV1({
    scopeResolver: { resolveExisting } as unknown as SessionScopeResolverV1,
    application: { perform } as unknown as CollaborationHubApplicationV1,
  })
  return { handler, resolveExisting, perform }
}

describe('xiaogui worker collaboration tool adapter', () => {
  it('derives the trusted session address and creates an awaiting-approval draft', async () => {
    const { handler, resolveExisting, perform } = setup()
    const outcome = await handler({
      request,
      fromCwd: 'D:/project',
      fromPoolKey: 'D:/session.jsonl',
      sessionFile: 'D:/session.jsonl',
      fromSessionId: 'session-1',
    })

    expect(resolveExisting).toHaveBeenCalledWith({
      rootPath: 'D:/project',
      sessionFile: 'D:/session.jsonl',
    })
    expect(perform).toHaveBeenCalledWith(
      { projectId: `xgp1_${'1'.repeat(64)}`, sessionKey: `xgs1_${'2'.repeat(64)}` },
      {
        requestId: 'pi-tool:call-1',
        intent: {
          type: 'flow.start.with_draft',
          draft: request.payload.draft,
          sourceTurnId: 'turn-1',
        },
      },
    )
    expect(outcome).toEqual({
      ok: true,
      value: {
        kind: 'XIAOGUI_COLLABORATION_DRAFT_CREATED',
        taskCount: 2,
        sessionVersion: 1,
      },
    })
  })

  it('fails closed before persistence when no session file is bound', async () => {
    const { handler, perform } = setup()
    const outcome = await handler({
      request,
      fromCwd: 'D:/project',
      fromPoolKey: 'ws:D:/project',
      sessionFile: null,
      fromSessionId: 'session-1',
    })

    expect(perform).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ ok: false, error: { code: 'SESSION_NOT_READY' } })
  })

  it('rejects a request from a session that no longer owns the worker slot', async () => {
    const { handler, resolveExisting, perform } = setup()
    const outcome = await handler({
      request,
      fromCwd: 'D:/project',
      fromPoolKey: 'D:/other-session.jsonl',
      sessionFile: 'D:/other-session.jsonl',
      fromSessionId: 'session-2',
    })

    expect(resolveExisting).not.toHaveBeenCalled()
    expect(perform).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ ok: false, error: { code: 'SESSION_SCOPE_MISMATCH' } })
  })

  it('keeps unbound and DESIGN sessions read-only before the Hub application', async () => {
    const unbound = setup()
    unbound.resolveExisting.mockResolvedValueOnce(null)
    const metadata = {
      request,
      fromCwd: 'D:/project',
      fromPoolKey: 'D:/session.jsonl',
      sessionFile: 'D:/session.jsonl',
      fromSessionId: 'session-1',
    }
    await expect(unbound.handler(metadata)).resolves.toMatchObject({
      ok: false,
      error: { code: 'SESSION_SCOPE_MISMATCH' },
    })
    expect(unbound.perform).not.toHaveBeenCalled()

    const design = setup('DESIGN')
    await expect(design.handler(metadata)).resolves.toMatchObject({
      ok: false,
      error: { code: 'DESIGN_RESERVED' },
    })
    expect(design.perform).not.toHaveBeenCalled()
  })
})
