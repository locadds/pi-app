import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import type { Sha256Digest } from '@shared/xiaogui-task-verification'

const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()

vi.mock('../../ipc/registry', () => ({
  registerHandler: vi.fn((channel: string, handler: (payload: unknown) => Promise<unknown>) => {
    handlers.set(channel, handler)
  }),
}))

import { registerCodingAttemptHandlersV1 } from './attempt-ipc'

const ADDRESS = {
  projectId: `xgp1_${'a'.repeat(64)}`,
  sessionKey: `xgs1_${'b'.repeat(64)}`,
} as SessionAddressV1
const PLAN = {
  schemaVersion: 1 as const,
  attemptId: 'attempt-1',
  source: 'PI_DRAFT' as const,
  state: 'AWAITING_APPROVAL' as const,
  plan: {
    schemaVersion: 1 as const,
    planId: 'plan-1',
    attemptId: 'attempt-1',
    objective: '实现功能',
    steps: [{ stepId: 'step-1', title: '修改', validation: '聚焦检查', status: 'PENDING' as const }],
    constraints: ['不越界'],
    revision: 1,
  },
  planDigest: `sha256:${'1'.repeat(64)}`,
}

function executableRoles() {
  return {
    readAttemptBinding: vi.fn(() => ({
      snapshot: { role: 'IMPLEMENT' as const },
    })),
  }
}

describe('CODING Attempt IPC', () => {
  beforeEach(() => handlers.clear())

  it('按可信 address 观察计划，批准精确版本后才恢复同一 Attempt', async () => {
    const plan = {
      observe: vi.fn(() => [PLAN]),
      revise: vi.fn(),
      approve: vi.fn(() => ({
        ok: true as const,
        projection: {
          ...PLAN,
          state: 'APPROVED' as const,
          plan: { ...PLAN.plan, revision: 2 },
          planDigest: `sha256:${'2'.repeat(64)}`,
        },
      })),
      transitionTodo: vi.fn(),
      getProjection: vi.fn(),
    }
    const resumeAttempt = vi.fn(async () => ({ ok: true as const }))
    registerCodingAttemptHandlersV1({
      plan,
      review: { read: vi.fn() },
      taskExecution: { resumeAttempt },
      roles: executableRoles(),
    })

    const observe = await handlers.get('ipc:xiaogui.coding.plan.observe')!({
      contractVersion: 'xiaogui.coding-extension-control.v1',
      address: ADDRESS,
    })
    expect(observe).toMatchObject({ ok: true, value: { plans: [PLAN] } })

    const approved = await handlers.get('ipc:xiaogui.coding.plan.perform')!({
      contractVersion: 'xiaogui.coding-extension-control.v1',
      address: ADDRESS,
      action: {
        type: 'APPROVE',
        attemptId: PLAN.attemptId,
        expectedRevision: 1,
        expectedPlanDigest: PLAN.planDigest,
      },
    })
    expect(approved).toMatchObject({ ok: true, value: { executionResume: 'RESUMED' } })
    expect(resumeAttempt).toHaveBeenCalledWith(ADDRESS, PLAN.attemptId)
  })

  it('拒绝跨会话 Attempt，并在批准已落库但恢复失败时返回可重试投影', async () => {
    const approvedProjection = {
      ...PLAN,
      state: 'APPROVED' as const,
      plan: { ...PLAN.plan, revision: 2 },
      planDigest: `sha256:${'2'.repeat(64)}`,
    }
    let inScope = false
    const plan = {
      observe: vi.fn(() => inScope ? [PLAN] : []),
      revise: vi.fn(),
      approve: vi.fn(() => ({ ok: true as const, projection: approvedProjection })),
      transitionTodo: vi.fn(),
      getProjection: vi.fn(() => approvedProjection),
    }
    registerCodingAttemptHandlersV1({
      plan,
      review: { read: vi.fn() },
      taskExecution: { resumeAttempt: vi.fn(async () => ({ ok: false as const })) },
      roles: executableRoles(),
    })
    const handler = handlers.get('ipc:xiaogui.coding.plan.perform')!
    const denied = await handler({
      contractVersion: 'xiaogui.coding-extension-control.v1',
      address: ADDRESS,
      action: {
        type: 'APPROVE', attemptId: PLAN.attemptId, expectedRevision: 1, expectedPlanDigest: PLAN.planDigest,
      },
    })
    expect(denied).toMatchObject({ ok: false, error: { code: 'SESSION_SCOPE_MISMATCH' } })

    inScope = true
    const failed = await handler({
      contractVersion: 'xiaogui.coding-extension-control.v1',
      address: ADDRESS,
      action: {
        type: 'APPROVE', attemptId: PLAN.attemptId, expectedRevision: 1, expectedPlanDigest: PLAN.planDigest,
      },
    })
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'EXECUTION_RESUME_FAILED' },
      projection: approvedProjection,
    })
  })

  it('恢复抛错时只返回安全错误和权威的可重试计划', async () => {
    const approvedProjection = { ...PLAN, state: 'APPROVED' as const }
    const plan = {
      observe: vi.fn(() => [approvedProjection]),
      revise: vi.fn(),
      approve: vi.fn(),
      transitionTodo: vi.fn(),
      getProjection: vi.fn(() => approvedProjection),
    }
    registerCodingAttemptHandlersV1({
      plan,
      review: { read: vi.fn() },
      taskExecution: { resumeAttempt: vi.fn(async () => { throw new Error('D:\\private\\workspace') }) },
      roles: executableRoles(),
    })

    const outcome = await handlers.get('ipc:xiaogui.coding.plan.perform')!({
      contractVersion: 'xiaogui.coding-extension-control.v1',
      address: ADDRESS,
      action: {
        type: 'RESUME',
        attemptId: PLAN.attemptId,
        expectedRevision: PLAN.plan.revision,
        expectedPlanDigest: PLAN.planDigest,
      },
    })
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'EXECUTION_RESUME_FAILED',
        messageKey: 'xiaogui.coding.extension.execution_resume_failed',
      },
      projection: approvedProjection,
    })
    expect(JSON.stringify(outcome)).not.toContain('private')
  })

  it('只通过 Attempt 审阅模块返回真实 Diff，并拒绝无效请求', async () => {
    const read = vi.fn(async () => ({
      bundle: {
        schemaVersion: 1 as const,
        attemptId: PLAN.attemptId,
        changeSetDigest: `sha256:${'3'.repeat(64)}`,
        changedRelativePaths: ['src/a.ts'],
        verifications: [],
        unresolvedIssues: ['尚未验证'],
      },
      unifiedDiff: 'diff --git a/src/a.ts b/src/a.ts\n',
      unifiedDiffDigest: `sha256:${'4'.repeat(64)}` as Sha256Digest,
    }))
    registerCodingAttemptHandlersV1({
      plan: { observe: vi.fn(() => [PLAN]), revise: vi.fn(), approve: vi.fn(), transitionTodo: vi.fn(), getProjection: vi.fn() },
      review: { read },
      taskExecution: { resumeAttempt: vi.fn() },
      roles: executableRoles(),
    })
    const handler = handlers.get('ipc:xiaogui.coding.review.read')!
    expect(await handler({ contractVersion: 'bad', address: ADDRESS, attemptId: PLAN.attemptId }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(await handler({
      contractVersion: 'xiaogui.coding-extension-control.v1', address: ADDRESS, attemptId: PLAN.attemptId,
    })).toMatchObject({ ok: true, value: { unifiedDiff: expect.stringContaining('src/a.ts') } })
    expect(read).toHaveBeenCalledWith({ address: ADDRESS, attemptId: PLAN.attemptId })
  })

  it('未绑定角色时拒绝批准且不改变计划或启动运行时', async () => {
    const plan = {
      observe: vi.fn(() => [PLAN]),
      revise: vi.fn(),
      approve: vi.fn(),
      transitionTodo: vi.fn(),
      getProjection: vi.fn(),
    }
    const resumeAttempt = vi.fn()
    registerCodingAttemptHandlersV1({
      plan,
      review: { read: vi.fn() },
      taskExecution: { resumeAttempt },
      roles: { readAttemptBinding: vi.fn(() => null) },
    })

    const outcome = await handlers.get('ipc:xiaogui.coding.plan.perform')!({
      contractVersion: 'xiaogui.coding-extension-control.v1',
      address: ADDRESS,
      action: {
        type: 'APPROVE',
        attemptId: PLAN.attemptId,
        expectedRevision: PLAN.plan.revision,
        expectedPlanDigest: PLAN.planDigest,
      },
    })
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'ROLE_BINDING_REQUIRED',
        messageKey: 'xiaogui.coding.extension.role_binding_required',
      },
    })
    expect(plan.approve).not.toHaveBeenCalled()
    expect(resumeAttempt).not.toHaveBeenCalled()
  })

  it('研究或审阅角色可批准各自计划，实际工具上限由运行时角色接缝执行', async () => {
    const approvedProjection = {
      ...PLAN,
      state: 'APPROVED' as const,
      plan: { ...PLAN.plan, revision: 2 },
      planDigest: `sha256:${'2'.repeat(64)}`,
    }
    const plan = {
      observe: vi.fn(() => [PLAN]),
      revise: vi.fn(),
      approve: vi.fn(() => ({ ok: true as const, projection: approvedProjection })),
      transitionTodo: vi.fn(),
      getProjection: vi.fn(() => approvedProjection),
    }
    const resumeAttempt = vi.fn(async () => ({ ok: true as const }))
    registerCodingAttemptHandlersV1({
      plan,
      review: { read: vi.fn() },
      taskExecution: { resumeAttempt },
      roles: {
        readAttemptBinding: vi.fn(() => ({ snapshot: { role: 'RESEARCH' as const } })),
      },
    })

    await expect(handlers.get('ipc:xiaogui.coding.plan.perform')!({
      contractVersion: 'xiaogui.coding-extension-control.v1',
      address: ADDRESS,
      action: {
        type: 'APPROVE',
        attemptId: PLAN.attemptId,
        expectedRevision: PLAN.plan.revision,
        expectedPlanDigest: PLAN.planDigest,
      },
    })).resolves.toMatchObject({ ok: true, value: { executionResume: 'RESUMED' } })
    expect(plan.approve).toHaveBeenCalledOnce()
    expect(resumeAttempt).toHaveBeenCalledWith(ADDRESS, PLAN.attemptId)
  })
})
