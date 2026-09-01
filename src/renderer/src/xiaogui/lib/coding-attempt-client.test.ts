import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import {
  XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
  type CodingPlanActionV1,
} from '@shared/xiaogui-coding-extension-control'

const invokeMock = vi.fn()
vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: (method: string, request?: unknown) => invokeMock(method, request) },
}))

import {
  observeCodingAttemptPlans,
  performCodingAttemptPlan,
  readCodingAttemptReview,
} from './coding-attempt-client'

const address: HubAddressV1 = {
  projectId: `xgp1_${'a'.repeat(64)}` as HubAddressV1['projectId'],
  sessionKey: `xgs1_${'b'.repeat(64)}` as HubAddressV1['sessionKey'],
}

const plan = {
  schemaVersion: 1 as const,
  attemptId: 'xhba_1',
  source: 'PI_DRAFT' as const,
  state: 'AWAITING_APPROVAL' as const,
  plan: {
    schemaVersion: 1 as const,
    planId: 'xhbplan_1',
    attemptId: 'xhba_1',
    objective: '实现登录页',
    steps: [{ stepId: 's1', title: '修改界面', status: 'PENDING' as const, validation: '组件测试通过' }],
    constraints: ['只改前端'],
    revision: 1,
  },
  planDigest: `sha256:${'1'.repeat(64)}`,
}

describe('coding-attempt-client', () => {
  beforeEach(() => invokeMock.mockReset())

  it('通过版本化窄通道读取和修改 Attempt 计划', async () => {
    invokeMock
      .mockResolvedValueOnce({
        ok: true,
        value: { contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1, plans: [plan] },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
          projection: { ...plan, state: 'EXECUTING' },
          executionResume: 'RESUMED',
        },
      })

    await expect(observeCodingAttemptPlans(address)).resolves.toMatchObject({ ok: true })
    const action: CodingPlanActionV1 = {
      type: 'APPROVE',
      attemptId: plan.attemptId,
      expectedRevision: 1,
      expectedPlanDigest: plan.planDigest,
    }
    await expect(performCodingAttemptPlan(address, action)).resolves.toMatchObject({ ok: true })

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'xiaogui.coding.plan.observe', {
      contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
      address,
    })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'xiaogui.coding.plan.perform', {
      contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
      address,
      action,
    })
  })

  it('只接受相对路径审阅并通过专用通道读取', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
        bundle: {
          schemaVersion: 1,
          attemptId: 'xhba_1',
          changeSetDigest: `sha256:${'2'.repeat(64)}`,
          changedRelativePaths: ['src/login.tsx'],
          verifications: [{
            label: '组件测试',
            commandDigest: `sha256:${'3'.repeat(64)}`,
            exitCode: 0,
            status: 'PASSED',
          }],
          unresolvedIssues: [],
        },
        unifiedDiff: '--- a/src/login.tsx\n+++ b/src/login.tsx\n@@ -1 +1 @@\n-old\n+new',
        unifiedDiffDigest: `sha256:${'4'.repeat(64)}`,
      },
    })

    await expect(readCodingAttemptReview(address, 'xhba_1')).resolves.toMatchObject({ ok: true })
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.coding.review.read', {
      contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
      address,
      attemptId: 'xhba_1',
    })
  })

  it.each([
    {
      ok: true,
      value: { contractVersion: 'wrong', plans: [plan] },
    },
    {
      ok: true,
      value: {
        contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
        plans: [{ ...plan, planDigest: 'C:\\private\\digest' }],
      },
    },
  ])('拒绝非约定计划响应并返回脱敏错误', async (response) => {
    invokeMock.mockResolvedValueOnce(response)
    await expect(observeCodingAttemptPlans(address)).resolves.toEqual({
      ok: false,
      error: { code: 'INVALID_REQUEST', messageKey: 'xiaogui.coding.extension.ipc' },
    })
  })

  it('拒绝审阅中的绝对路径且不回显原始内容', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
        bundle: {
          schemaVersion: 1,
          attemptId: 'xhba_1',
          changeSetDigest: `sha256:${'2'.repeat(64)}`,
          changedRelativePaths: ['C:\\private\\a.ts'],
          verifications: [],
          unresolvedIssues: [],
        },
        unifiedDiff: '',
        unifiedDiffDigest: `sha256:${'4'.repeat(64)}`,
      },
    })
    await expect(readCodingAttemptReview(address, 'xhba_1')).resolves.toEqual({
      ok: false,
      error: { code: 'REVIEW_UNAVAILABLE', messageKey: 'xiaogui.coding.extension.ipc' },
    })
  })

  it('IPC 异常不会把错误文本带入 Renderer', async () => {
    invokeMock.mockRejectedValueOnce(new Error('C:\\Users\\secret'))
    const result = await observeCodingAttemptPlans(address)
    expect(result).toEqual({
      ok: false,
      error: { code: 'INVALID_REQUEST', messageKey: 'xiaogui.coding.extension.ipc' },
    })
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})
