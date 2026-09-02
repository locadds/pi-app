import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import type { CodingPlanBodyV1, CodingPlanProjectionV1 } from '@shared/xiaogui-coding-extension-pack'
import { XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1 } from '@shared/xiaogui-coding-extension-control'

const observeMock = vi.fn()
const performMock = vi.fn()
const reviewMock = vi.fn()
vi.mock('../lib/coding-attempt-client', () => ({
  observeCodingAttemptPlans: (address: HubAddressV1) => observeMock(address),
  performCodingAttemptPlan: (address: HubAddressV1, action: unknown) => performMock(address, action),
  readCodingAttemptReview: (address: HubAddressV1, attemptId: string) => reviewMock(address, attemptId),
}))

import { useCodingAttemptStore } from './coding-attempt-store'

const addressA: HubAddressV1 = {
  projectId: `xgp1_${'a'.repeat(64)}` as HubAddressV1['projectId'],
  sessionKey: `xgs1_${'1'.repeat(64)}` as HubAddressV1['sessionKey'],
}
const addressB: HubAddressV1 = {
  projectId: addressA.projectId,
  sessionKey: `xgs1_${'2'.repeat(64)}` as HubAddressV1['sessionKey'],
}

function plan(state: CodingPlanProjectionV1['state'] = 'AWAITING_APPROVAL', revision = 1): CodingPlanProjectionV1 {
  return {
    schemaVersion: 1,
    attemptId: 'xhba_1',
    source: 'PI_DRAFT',
    state,
    plan: {
      schemaVersion: 1,
      planId: 'xhbplan_1',
      attemptId: 'xhba_1',
      objective: '实现登录页',
      steps: [{ stepId: 's1', title: '修改界面', status: 'PENDING', validation: '组件测试通过' }],
      constraints: ['只改前端'],
      revision,
    },
    planDigest: `sha256:${String(revision).repeat(64)}`,
  }
}

describe('coding-attempt-store', () => {
  beforeEach(() => {
    observeMock.mockReset()
    performMock.mockReset()
    reviewMock.mockReset()
    useCodingAttemptStore.getState().setAddress(null)
  })

  it('按当前 canonical address 读取计划并丢弃切换后的晚到响应', async () => {
    let resolve!: (value: unknown) => void
    observeMock.mockReturnValueOnce(new Promise((done) => (resolve = done)))
    useCodingAttemptStore.getState().setAddress(addressA)
    const pending = useCodingAttemptStore.getState().refreshPlans()
    useCodingAttemptStore.getState().setAddress(addressB)
    resolve({
      ok: true,
      value: { contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1, plans: [plan()] },
    })
    await pending
    expect(useCodingAttemptStore.getState().address).toEqual(addressB)
    expect(useCodingAttemptStore.getState().plansByAttempt).toEqual({})
  })

  it('修改计划只提交当前 revision/digest 与新的可编辑正文', async () => {
    const current = plan()
    const revised = plan('AWAITING_APPROVAL', 2)
    observeMock.mockResolvedValueOnce({
      ok: true,
      value: { contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1, plans: [current] },
    })
    performMock.mockResolvedValueOnce({
      ok: true,
      value: {
        contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
        projection: revised,
        executionResume: 'NOT_REQUESTED',
      },
    })
    useCodingAttemptStore.getState().setAddress(addressA)
    await useCodingAttemptStore.getState().refreshPlans()
    const body: CodingPlanBodyV1 = {
      objective: '优化登录页',
      steps: [{ stepId: 's1', title: '更新界面', validation: '组件测试通过' }],
      constraints: ['只改前端'],
    }
    await useCodingAttemptStore.getState().revisePlan('xhba_1', body)

    expect(performMock).toHaveBeenCalledWith(addressA, {
      type: 'REVISE',
      attemptId: 'xhba_1',
      expectedRevision: 1,
      expectedPlanDigest: current.planDigest,
      body,
    })
    expect(useCodingAttemptStore.getState().plansByAttempt.xhba_1?.plan.revision).toBe(2)
  })

  it('批准已落库但启动失败时保留可重试状态，继续执行成功后收敛', async () => {
    const current = plan()
    const approved = plan('APPROVED')
    const executing = plan('EXECUTING')
    observeMock.mockResolvedValueOnce({
      ok: true,
      value: { contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1, plans: [current] },
    })
    performMock
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'EXECUTION_RESUME_FAILED', messageKey: 'xiaogui.coding.extension.execution_resume_failed' },
        projection: approved,
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
          projection: executing,
          executionResume: 'RESUMED',
        },
      })
    useCodingAttemptStore.getState().setAddress(addressA)
    await useCodingAttemptStore.getState().refreshPlans()

    await expect(useCodingAttemptStore.getState().approveAndStart('xhba_1')).resolves.toBe(false)
    expect(useCodingAttemptStore.getState().plansByAttempt.xhba_1?.state).toBe('APPROVED')
    expect(useCodingAttemptStore.getState().resumeRequiredByAttempt.xhba_1).toBe(true)

    await expect(useCodingAttemptStore.getState().resumeExecution('xhba_1')).resolves.toBe(true)
    expect(performMock.mock.calls[1]![1]).toMatchObject({ type: 'RESUME', attemptId: 'xhba_1' })
    expect(useCodingAttemptStore.getState().plansByAttempt.xhba_1?.state).toBe('EXECUTING')
    expect(useCodingAttemptStore.getState().resumeRequiredByAttempt.xhba_1).toBeUndefined()
  })

  it('按需读取真实 Diff/验证投影，不把它混入计划正文', async () => {
    const review = {
      contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
      bundle: {
        schemaVersion: 1 as const,
        attemptId: 'xhba_1',
        changeSetDigest: `sha256:${'a'.repeat(64)}`,
        changedRelativePaths: ['src/login.tsx'],
        verifications: [{
          label: '组件测试',
          commandDigest: `sha256:${'b'.repeat(64)}`,
          exitCode: 0,
          status: 'PASSED' as const,
        }],
        unresolvedIssues: [],
      },
      unifiedDiff: '--- a/src/login.tsx\n+++ b/src/login.tsx',
      unifiedDiffDigest: `sha256:${'c'.repeat(64)}`,
    }
    reviewMock.mockResolvedValueOnce({ ok: true, value: review })
    useCodingAttemptStore.getState().setAddress(addressA)
    await expect(useCodingAttemptStore.getState().loadReview('xhba_1')).resolves.toBe(true)
    expect(reviewMock).toHaveBeenCalledWith(addressA, 'xhba_1')
    expect(useCodingAttemptStore.getState().reviewsByAttempt.xhba_1).toEqual(review)
  })
})
