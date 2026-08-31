import { describe, expect, it, vi } from 'vitest'

import type { WorkerHostToolRequestV1 } from '@shared/worker-host-tools'
import type { SessionScopeResolverV1 } from '../scope-resolver'
import type { PiSessionScopeV1 } from '../scope-derive'
import { createXiaoguiCodingPlanWorkerToolHandlerV1 } from './plan-worker-tool'

const body = {
  objective: '修复登录错误并验证',
  steps: [{ stepId: 'inspect', title: '定位错误', validation: '聚焦测试复现并通过' }],
  constraints: ['不修改 WORK 模式'],
}

const request: WorkerHostToolRequestV1 = {
  type: 'host-tool-request',
  requestId: 'host-tool-1',
  method: 'xiaogui.coding.plan-draft.v1',
  payload: {
    sourceSessionId: 'session-1',
    sourceTurnId: 'turn-1',
    toolCallId: 'call-1',
    body,
  },
}

function setup(sessionMode: 'WORK' | 'DESIGN' | 'CODING' = 'CODING') {
  const resolveExisting = vi.fn(async (): Promise<PiSessionScopeV1 | null> => ({
    projectId: `xgp1_${'1'.repeat(64)}` as never,
    sessionKey: `xgs1_${'2'.repeat(64)}` as never,
    sessionMode,
    rootPath: 'D:/project',
    sessionFile: 'D:/session.jsonl',
  }))
  const publishPendingDraft = vi.fn(() => ({
    ok: true as const,
    draftDigest: `sha256:${'3'.repeat(64)}`,
  }))
  const handler = createXiaoguiCodingPlanWorkerToolHandlerV1({
    scopeResolver: { resolveExisting } as unknown as SessionScopeResolverV1,
    publishPendingDraft,
  })
  return { handler, resolveExisting, publishPendingDraft }
}

const metadata = (overrides: Record<string, unknown> = {}) => ({
  request,
  fromCwd: 'D:/project',
  fromPoolKey: 'D:/session.jsonl',
  sessionFile: 'D:/session.jsonl',
  fromSessionId: 'session-1',
  ...overrides,
})

describe('CODING plan Worker host adapter', () => {
  it('derives the trusted CODING SessionAddress and hides the stored digest', async () => {
    const { handler, resolveExisting, publishPendingDraft } = setup()

    const outcome = await handler(metadata())

    expect(resolveExisting).toHaveBeenCalledWith({
      rootPath: 'D:/project',
      sessionFile: 'D:/session.jsonl',
    })
    expect(publishPendingDraft).toHaveBeenCalledWith({
      schemaVersion: 1,
      address: {
        projectId: `xgp1_${'1'.repeat(64)}`,
        sessionKey: `xgs1_${'2'.repeat(64)}`,
      },
      body,
    })
    expect(outcome).toEqual({ ok: true, value: { kind: 'XIAOGUI_CODING_PLAN_DRAFT_SAVED' } })
    expect(JSON.stringify(outcome)).not.toMatch(/sha256|digest|D:\/project/i)
  })

  it('rejects non-CODING sessions and stale Worker ownership before persistence', async () => {
    const work = setup('WORK')
    await expect(work.handler(metadata())).resolves.toMatchObject({
      ok: false,
      error: { code: 'CODING_PLAN_MODE_REQUIRED' },
    })
    expect(work.publishPendingDraft).not.toHaveBeenCalled()

    const stale = setup()
    await expect(stale.handler(metadata({ fromSessionId: 'session-2' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'SESSION_SCOPE_MISMATCH' },
    })
    expect(stale.resolveExisting).not.toHaveBeenCalled()
    expect(stale.publishPendingDraft).not.toHaveBeenCalled()
  })

  it('rejects model-supplied path, address or Attempt identifiers', async () => {
    const { handler, resolveExisting, publishPendingDraft } = setup()
    const unsafe = {
      ...request,
      payload: {
        ...request.payload,
        path: 'D:/secret',
        attemptId: 'attempt-1',
        address: { projectId: 'forged', sessionKey: 'forged' },
      },
    }

    const outcome = await handler(metadata({ request: unsafe }))

    expect(outcome).toMatchObject({ ok: false, error: { code: 'HOST_TOOL_REQUEST_INVALID' } })
    expect(resolveExisting).not.toHaveBeenCalled()
    expect(publishPendingDraft).not.toHaveBeenCalled()
  })
})
