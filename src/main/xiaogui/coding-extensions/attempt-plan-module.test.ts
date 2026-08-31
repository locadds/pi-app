import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  CodingPlanBodyV1,
  CodingPlanPendingDraftV1,
} from '@shared/xiaogui-coding-extension-pack'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import { CodingAttemptPlanModuleV1 } from './attempt-plan-module'

const roots: string[] = []

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

const OTHER_ADDRESS = {
  projectId: `xgp1_${'3'.repeat(64)}`,
  sessionKey: `xgs1_${'4'.repeat(64)}`,
} as SessionAddressV1

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-coding-plan-'))
  roots.push(root)
  return join(root, 'plans.sqlite')
}

function body(objective = '修复登录错误'): CodingPlanBodyV1 {
  return {
    objective,
    steps: [
      { stepId: 'inspect', title: '定位错误来源', validation: '记录可复现原因' },
      { stepId: 'implement', title: '完成最小修复', validation: '聚焦测试通过' },
    ],
    constraints: ['只修改已批准文件'],
  }
}

function pending(address = ADDRESS): CodingPlanPendingDraftV1 {
  return { schemaVersion: 1, address, body: body() }
}

function moduleAt(dbPath: string, ids: string[] = ['plan_1', 'plan_2']): CodingAttemptPlanModuleV1 {
  return new CodingAttemptPlanModuleV1({
    dbPath,
    idFactory: () => ids.shift() ?? 'plan_fallback',
    now: () => '2026-08-31T10:00:00.000Z',
  })
}

describe('CodingAttemptPlanModuleV1', () => {
  it('按 SessionAddress 保存 Pi 草稿，绑定到 Attempt 后消费草稿且不串会话', () => {
    const module = moduleAt(databasePath())
    const saved = module.savePendingDraft(pending())
    expect(saved).toMatchObject({ ok: true, draftDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) })

    const bound = module.bindAttempt({
      schemaVersion: 1,
      address: ADDRESS,
      attemptId: 'attempt_1',
      taskObjective: 'TaskHub 的任务目标',
    })
    expect(bound).toMatchObject({
      ok: true,
      projection: {
        source: 'PI_DRAFT',
        state: 'AWAITING_APPROVAL',
        plan: {
          planId: 'plan_1',
          attemptId: 'attempt_1',
          objective: '修复登录错误',
          revision: 1,
          steps: [
            expect.objectContaining({ stepId: 'inspect', status: 'PENDING' }),
            expect.objectContaining({ stepId: 'implement', status: 'PENDING' }),
          ],
        },
      },
    })

    const other = module.bindAttempt({
      schemaVersion: 1,
      address: OTHER_ADDRESS,
      attemptId: 'attempt_2',
      taskObjective: '另一个任务',
    })
    expect(other).toMatchObject({ ok: true, projection: { source: 'TASK_OBJECTIVE_FALLBACK' } })

    const consumed = module.bindAttempt({
      schemaVersion: 1,
      address: ADDRESS,
      attemptId: 'attempt_3',
      taskObjective: '后续任务',
    })
    expect(consumed).toMatchObject({ ok: true, projection: { source: 'TASK_OBJECTIVE_FALLBACK' } })
    module.close()
  })

  it('没有 Pi 草稿时从 Task objective 生成显式 fallback，并保持幂等绑定', () => {
    const module = moduleAt(databasePath())
    const first = module.bindAttempt({
      schemaVersion: 1,
      address: ADDRESS,
      attemptId: 'attempt_1',
      taskObjective: '整理真实工作树变更',
    })
    expect(first).toMatchObject({
      ok: true,
      projection: {
        source: 'TASK_OBJECTIVE_FALLBACK',
        plan: {
          objective: '整理真实工作树变更',
          steps: [{
            status: 'PENDING',
            title: '完成任务目标',
            validation: '按任务验收要求检查真实结果',
          }],
          constraints: ['此计划由任务目标生成，执行前必须人工确认。'],
        },
      },
    })
    expect(module.bindAttempt({
      schemaVersion: 1,
      address: ADDRESS,
      attemptId: 'attempt_1',
      taskObjective: '不应覆盖原计划',
    })).toEqual(first)
    module.close()
  })

  it('用 revision 与 digest 做乐观并发，批准后仍可修改但会重新要求批准', () => {
    const module = moduleAt(databasePath())
    const bound = module.bindAttempt({
      schemaVersion: 1,
      address: ADDRESS,
      attemptId: 'attempt_1',
      taskObjective: '目标',
    })
    if (!bound.ok) throw new Error('bind failed')

    const staleDigest = bound.projection.planDigest
    const revised = module.revise({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: 1,
      expectedPlanDigest: staleDigest,
      body: body('用户修改后的目标'),
    })
    expect(revised).toMatchObject({
      ok: true,
      projection: { state: 'AWAITING_APPROVAL', plan: { revision: 2, objective: '用户修改后的目标' } },
    })
    expect(revised.ok && revised.projection.planDigest).not.toBe(staleDigest)

    expect(module.approve({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: 1,
      expectedPlanDigest: staleDigest,
    })).toEqual({ ok: false, error: 'VERSION_CONFLICT' })

    if (!revised.ok) throw new Error('revise failed')
    const approved = module.approve({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: revised.projection.plan.revision,
      expectedPlanDigest: revised.projection.planDigest,
    })
    expect(approved).toMatchObject({ ok: true, projection: { state: 'APPROVED', plan: { revision: 3 } } })

    if (!approved.ok) throw new Error('approve failed')
    const reopened = module.revise({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: approved.projection.plan.revision,
      expectedPlanDigest: approved.projection.planDigest,
      body: body('再次调整'),
    })
    expect(reopened).toMatchObject({
      ok: true,
      projection: { state: 'AWAITING_APPROVAL', plan: { revision: 4, objective: '再次调整' } },
    })
    module.close()
  })

  it('批准并开始执行后锁定计划正文，只允许合法 Todo 状态迁移', () => {
    const module = moduleAt(databasePath())
    const bound = module.bindAttempt({
      schemaVersion: 1,
      address: ADDRESS,
      attemptId: 'attempt_1',
      taskObjective: '目标',
    })
    if (!bound.ok) throw new Error('bind failed')

    expect(module.startExecution({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: bound.projection.plan.revision,
      expectedPlanDigest: bound.projection.planDigest,
    })).toEqual({ ok: false, error: 'PLAN_NOT_APPROVED' })

    const approved = module.approve({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: bound.projection.plan.revision,
      expectedPlanDigest: bound.projection.planDigest,
    })
    if (!approved.ok) throw new Error('approve failed')
    const started = module.startExecution({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: approved.projection.plan.revision,
      expectedPlanDigest: approved.projection.planDigest,
    })
    expect(started).toMatchObject({ ok: true, projection: { state: 'EXECUTING', plan: { revision: 3 } } })
    if (!started.ok) throw new Error('start failed')

    expect(module.revise({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: started.projection.plan.revision,
      expectedPlanDigest: started.projection.planDigest,
      body: body('执行中偷改正文'),
    })).toEqual({ ok: false, error: 'PLAN_BODY_LOCKED' })

    const inProgress = module.transitionTodo({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: started.projection.plan.revision,
      expectedPlanDigest: started.projection.planDigest,
      stepId: 'fallback_execute',
      nextStatus: 'IN_PROGRESS',
    })
    expect(inProgress).toMatchObject({
      ok: true,
      projection: { plan: { revision: 4, steps: [expect.objectContaining({ status: 'IN_PROGRESS' })] } },
    })
    if (!inProgress.ok) throw new Error('todo failed')
    expect(module.transitionTodo({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: inProgress.projection.plan.revision,
      expectedPlanDigest: inProgress.projection.planDigest,
      stepId: 'fallback_execute',
      nextStatus: 'PENDING',
    })).toEqual({ ok: false, error: 'INVALID_TODO_TRANSITION' })

    const completed = module.transitionTodo({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: inProgress.projection.plan.revision,
      expectedPlanDigest: inProgress.projection.planDigest,
      stepId: 'fallback_execute',
      nextStatus: 'COMPLETED',
    })
    expect(completed).toMatchObject({ ok: true, projection: { plan: { revision: 5 } } })
    module.close()
  })

  it('SQLite 重启后恢复 Attempt 计划、批准状态、Todo 和 digest', () => {
    const dbPath = databasePath()
    const first = moduleAt(dbPath)
    const bound = first.bindAttempt({
      schemaVersion: 1,
      address: ADDRESS,
      attemptId: 'attempt_1',
      taskObjective: '恢复目标',
    })
    if (!bound.ok) throw new Error('bind failed')
    const approved = first.approve({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: bound.projection.plan.revision,
      expectedPlanDigest: bound.projection.planDigest,
    })
    if (!approved.ok) throw new Error('approve failed')
    first.close()

    const restored = moduleAt(dbPath)
    expect(restored.getProjection('attempt_1')).toEqual(approved.projection)
    restored.close()
  })

  it('直接提供调度 Gate、Pi 发布和按会话观察接口', async () => {
    const module = moduleAt(databasePath())
    expect(module.publishPendingDraft(pending(OTHER_ADDRESS))).toMatchObject({ ok: true })
    await module.ensureAttemptPlan({
      address: ADDRESS,
      attemptId: 'attempt_1',
      objective: '整个 Flow 的泛化目标',
      taskTitle: '修复登录错误',
      taskSummary: '只修改认证模块',
    })
    expect(module.observe(ADDRESS)).toEqual([
      expect.objectContaining({
        attemptId: 'attempt_1',
        source: 'TASK_OBJECTIVE_FALLBACK',
        plan: expect.objectContaining({ objective: '修复登录错误：只修改认证模块' }),
      }),
    ])
    await expect(module.isAttemptPlanApproved('attempt_1')).resolves.toBe(false)

    const projection = module.getProjection('attempt_1')!
    const approved = module.approve({
      schemaVersion: 1,
      attemptId: 'attempt_1',
      expectedRevision: projection.plan.revision,
      expectedPlanDigest: projection.planDigest,
    })
    expect(approved.ok).toBe(true)
    await expect(module.isAttemptPlanApproved('attempt_1')).resolves.toBe(true)
    await expect(module.markAttemptExecutionStarted('attempt_1')).resolves.toBeUndefined()
    expect(module.getProjection('attempt_1')?.state).toBe('EXECUTING')
    module.close()
  })
})
