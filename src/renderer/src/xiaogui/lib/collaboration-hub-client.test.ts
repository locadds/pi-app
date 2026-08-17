import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  HubOutcomeV1,
  SessionCollaborationProjectionM2BV1,
  TaskRunId,
  TaskSpecId,
} from '@shared/xiaogui-collaboration-hub'

const invokeMock = vi.fn()
vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: {
    invoke: (method: string, req?: unknown) => invokeMock(method, req),
  },
}))

import {
  HUB_CONTRACT_VERSION,
  HUB_OBSERVE_CONTRACT_VERSION,
  newHubRequestId,
  observeCollaborationHub,
  performHubIntent,
} from './collaboration-hub-client'

const address: HubAddressV1 = {
  projectId: `xgp1_${'a'.repeat(64)}` as HubAddressV1['projectId'],
  sessionKey: `xgs1_${'b'.repeat(64)}` as HubAddressV1['sessionKey'],
}

const otherAddress: HubAddressV1 = {
  projectId: address.projectId,
  sessionKey: `xgs1_${'c'.repeat(64)}` as HubAddressV1['sessionKey'],
}

function projectionFixture(): SessionCollaborationProjectionM2BV1 {
  return {
    kind: 'SESSION_COLLABORATION_PROJECTION',
    version: 'm2b.v1',
    address,
    sessionVersion: 0,
    sessionMode: 'WORK',
    authoritativeMode: 'WORK',
    reserved: false,
    activeFlow: null,
    activeRevision: null,
    taskSpecs: [],
    taskRuns: [],
    attempts: [],
    history: [],
    availableActions: ['flow.start.with_draft'],
  }
}

beforeEach(() => invokeMock.mockReset())

describe('collaboration-hub-client', () => {
  it('observe 走白名单通道且载荷只含 contractVersion(m2b.v1) + address', async () => {
    const outcome: HubOutcomeV1<SessionCollaborationProjectionM2BV1> = {
      ok: true,
      value: projectionFixture(),
    }
    invokeMock.mockResolvedValueOnce(outcome)

    const res = await observeCollaborationHub(address)

    expect(res).toEqual(outcome)
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.hub.observe', {
      contractVersion: HUB_OBSERVE_CONTRACT_VERSION,
      address,
    })
    expect(HUB_OBSERVE_CONTRACT_VERSION).toBe('m2b.v1')
    const payload = invokeMock.mock.calls[0]![1] as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['address', 'contractVersion'])
    expect(payload.address).toEqual({
      projectId: address.projectId,
      sessionKey: address.sessionKey,
    })
    // 不得携带 path / mode / actor / sessionFile
    expect(JSON.stringify(payload)).not.toMatch(/path|mode|actor|sessionFile/i)
  })

  it('observe 接受携带真实状态 taskRuns 与 attempts 的 m2b.v1 投影', async () => {
    const valid: SessionCollaborationProjectionM2BV1 = {
      ...projectionFixture(),
      sessionMode: 'CODING',
      authoritativeMode: 'CODING',
      activeFlow: {
        flowId: 'xhbf_flow1' as FlowId,
        status: 'PLAN_ACTIVE',
        activeRevisionId: null,
        objective: '目标',
      },
      taskRuns: [
        {
          taskRunId: 'xhbtr_1' as TaskRunId,
          taskSpecId: 'xhbts_1' as TaskSpecId,
          taskKey: 't1',
          status: 'RUNNING',
          attemptId: 'xhba_1' as AttemptId,
        },
        { taskRunId: 'xhbtr_2' as TaskRunId, taskSpecId: 'xhbts_2' as TaskSpecId, taskKey: 't2', status: 'BLOCKED' },
      ],
      attempts: [
        { attemptId: 'xhba_1' as AttemptId, taskRunId: 'xhbtr_1' as TaskRunId, status: 'RUNNING', runtimeSessionId: 'rs-1' },
        { attemptId: 'xhba_0' as AttemptId, taskRunId: 'xhbtr_1' as TaskRunId, status: 'FAILED' },
      ],
      availableActions: ['flow.cancel'],
    }
    invokeMock.mockResolvedValueOnce({ ok: true, value: valid })

    const res = await observeCollaborationHub(address)

    expect(res).toEqual({ ok: true, value: valid })
  })

  it.each([
    ['未知 TaskRun 状态', { taskRuns: [{ taskRunId: 'r1', taskSpecId: 's1', taskKey: 't1', status: 'PENDING_DISABLED' }] }],
    ['未知 Attempt 状态', { attempts: [{ attemptId: 'a1', taskRunId: 'r1', status: 'EXPLODED' }] }],
    ['attempts 缺失', { attempts: undefined }],
    ['attemptId 非字符串', { attempts: [{ attemptId: 1, taskRunId: 'r1', status: 'RUNNING' }] }],
    [
      '孤儿 attempt（taskRunId 不存在）',
      {
        taskRuns: [{ taskRunId: 'r1', taskSpecId: 's1', taskKey: 't1', status: 'RUNNING' }],
        attempts: [{ attemptId: 'a1', taskRunId: 'ghost-run', status: 'RUNNING' }],
      },
    ],
    [
      'taskRun.attemptId 指向属于另一个 taskRun 的 attempt',
      {
        taskRuns: [
          { taskRunId: 'r1', taskSpecId: 's1', taskKey: 't1', status: 'RUNNING', attemptId: 'a1' },
          { taskRunId: 'r2', taskSpecId: 's2', taskKey: 't2', status: 'BLOCKED' },
        ],
        attempts: [{ attemptId: 'a1', taskRunId: 'r2', status: 'FAILED' }],
      },
    ],
    [
      'taskRun.attemptId 悬空（attempt 不存在）',
      {
        taskRuns: [{ taskRunId: 'r1', taskSpecId: 's1', taskKey: 't1', status: 'RUNNING', attemptId: 'ghost-attempt' }],
      },
    ],
    [
      'taskRunId 重复',
      {
        taskRuns: [
          { taskRunId: 'r1', taskSpecId: 's1', taskKey: 't1', status: 'RUNNING' },
          { taskRunId: 'r1', taskSpecId: 's2', taskKey: 't2', status: 'BLOCKED' },
        ],
      },
    ],
    [
      'attemptId 重复',
      {
        taskRuns: [{ taskRunId: 'r1', taskSpecId: 's1', taskKey: 't1', status: 'RUNNING' }],
        attempts: [
          { attemptId: 'a1', taskRunId: 'r1', status: 'RUNNING' },
          { attemptId: 'a1', taskRunId: 'r1', status: 'FAILED' },
        ],
      },
    ],
  ])('m2b.v1 投影结构非法时映射为安全 INTERNAL：%s', async (_label, patch) => {
    invokeMock.mockResolvedValueOnce({ ok: true, value: { ...projectionFixture(), ...patch } })

    const res = await observeCollaborationHub(address)

    expect(res).toEqual({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.error.ipc', traceId: '' },
    })
  })

  it('perform 载荷只含 contractVersion(m2a.v1) + address + request', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: { requestId: 'r1', intentType: 'flow.cancel', sessionVersion: 1 },
    })

    await performHubIntent(address, {
      requestId: 'r1',
      expectedSessionVersion: 1,
      intent: { type: 'flow.cancel', flowId: 'xhbf_1' as never, reason: 'x' },
    })

    expect(invokeMock).toHaveBeenCalledWith('xiaogui.hub.perform', {
      contractVersion: HUB_CONTRACT_VERSION,
      address,
      request: {
        requestId: 'r1',
        expectedSessionVersion: 1,
        intent: { type: 'flow.cancel', flowId: 'xhbf_1', reason: 'x' },
      },
    })
    const payload = invokeMock.mock.calls[0]![1] as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['address', 'contractVersion', 'request'])
  })

  it('IPC 抛异常时映射为安全 INTERNAL 错误且不泄露异常内容', async () => {
    invokeMock.mockRejectedValueOnce(new Error('secret path C:\\Users\\x\\secret'))

    const res = await observeCollaborationHub(address)

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('INTERNAL')
      expect(JSON.stringify(res.error)).not.toContain('secret')
      expect(JSON.stringify(res.error)).not.toContain('C:\\')
    }
  })

  it('非约定返回（非 HubOutcome）映射为安全 INTERNAL 错误', async () => {
    invokeMock.mockResolvedValueOnce({ unexpected: true })

    const res = await observeCollaborationHub(address)

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('INTERNAL')
  })

  it('observe 拒绝与请求 canonical address 不一致的投影', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: { ...projectionFixture(), address: otherAddress },
    })

    const res = await observeCollaborationHub(address)

    expect(res).toEqual({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.error.ipc', traceId: '' },
    })
  })

  it.each([{ ok: true }, { ok: true, value: {} }, { ok: false }, { ok: false, error: { code: 'UNKNOWN', messageKey: 'x', traceId: '' } }])(
    '结构不完整的 HubOutcome 不得进入 Renderer：%j',
    async (malformed) => {
      invokeMock.mockResolvedValueOnce(malformed)

      const res = await observeCollaborationHub(address)

      expect(res).toEqual({
        ok: false,
        error: {
          code: 'INTERNAL',
          messageKey: 'xiaogui.hub.error.ipc',
          traceId: '',
        },
      })
    },
  )

  it('结构不完整的 perform receipt 映射为安全 INTERNAL', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, value: { requestId: 'r1' } })

    const res = await performHubIntent(address, {
      requestId: 'r1',
      expectedSessionVersion: 0,
      intent: { type: 'flow.cancel', flowId: 'xhbf_1' as never, reason: 'x' },
    })

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('INTERNAL')
  })

  it.each([
    { requestId: 'other', intentType: 'flow.cancel', sessionVersion: 1 },
    { requestId: 'r1', intentType: 'flow.start.with_draft', sessionVersion: 1 },
  ])('perform 拒绝与请求不一致的 receipt：%j', async (receipt) => {
    invokeMock.mockResolvedValueOnce({ ok: true, value: receipt })

    const res = await performHubIntent(address, {
      requestId: 'r1',
      expectedSessionVersion: 0,
      intent: { type: 'flow.cancel', flowId: 'xhbf_1' as never, reason: 'x' },
    })

    expect(res).toEqual({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.error.ipc', traceId: '' },
    })
  })

  it.each(['C:\\Users\\alice\\secret.txt', 'token-secret', 'xhbt_not-a-uuid'])(
    '拒绝不安全 traceId，避免主进程文本进入界面：%s',
    async (traceId) => {
      invokeMock.mockResolvedValueOnce({
        ok: false,
        error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.internal', traceId },
      })

      const res = await observeCollaborationHub(address)

      expect(res).toEqual({
        ok: false,
        error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.error.ipc', traceId: '' },
      })
    },
  )

  it('保留主进程签发的安全 Hub traceId', async () => {
    const traceId = 'xhbt_00000000-0000-4000-8000-000000000000'
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'REVISION_CONFLICT', messageKey: 'xiaogui.hub.revision_conflict', traceId },
    })

    await expect(observeCollaborationHub(address)).resolves.toEqual({
      ok: false,
      error: { code: 'REVISION_CONFLICT', messageKey: 'xiaogui.hub.revision_conflict', traceId },
    })
  })

  it('requestId 全局唯一', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newHubRequestId()))
    expect(ids.size).toBe(200)
  })
})
