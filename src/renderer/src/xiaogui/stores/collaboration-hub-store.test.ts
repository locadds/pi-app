import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FlowId, HubAddressV1, PlanRevisionId, SessionCollaborationProjectionM2BV1 } from '@shared/xiaogui-collaboration-hub'

const observeMock = vi.fn()
const performMock = vi.fn()
let requestCounter = 0
vi.mock('../lib/collaboration-hub-client', () => ({
  HUB_CONTRACT_VERSION: 'm2a.v1',
  HUB_OBSERVE_CONTRACT_VERSION: 'm2b.v1',
  observeCollaborationHub: (address: HubAddressV1) => observeMock(address),
  performHubIntent: (address: HubAddressV1, request: unknown) => performMock(address, request),
  newHubRequestId: () => `test-req-${++requestCounter}`,
}))

import {
  emptyPlanDraftForm,
  parseDependsOnText,
  toInitialPlanDraft,
  useCollaborationHubStore,
  validatePlanDraftForm,
} from './collaboration-hub-store'

const addressA: HubAddressV1 = {
  projectId: `xgp1_${'a'.repeat(64)}` as HubAddressV1['projectId'],
  sessionKey: `xgs1_${'1'.repeat(64)}` as HubAddressV1['sessionKey'],
}
const addressB: HubAddressV1 = {
  projectId: `xgp1_${'a'.repeat(64)}` as HubAddressV1['projectId'],
  sessionKey: `xgs1_${'2'.repeat(64)}` as HubAddressV1['sessionKey'],
}

function projectionFixture(patch: Partial<SessionCollaborationProjectionM2BV1> = {}): SessionCollaborationProjectionM2BV1 {
  return {
    kind: 'SESSION_COLLABORATION_PROJECTION',
    version: 'm2b.v1',
    address: addressA,
    sessionVersion: 3,
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
    ...patch,
  }
}

function awaitingProjection(): SessionCollaborationProjectionM2BV1 {
  const flowId = 'xhbf_flow1' as FlowId
  const revisionId = 'xhbr_rev1' as PlanRevisionId
  return projectionFixture({
    sessionVersion: 4,
    activeFlow: {
      flowId,
      status: 'AWAITING_PLAN_APPROVAL',
      activeRevisionId: revisionId,
      objective: '目标X',
    },
    activeRevision: {
      revisionId,
      status: 'DRAFT',
      digest: 'digest-1',
      draft: {
        objective: '目标X',
        tasks: [{ taskKey: 't1', title: '投影任务' }],
      },
    },
    availableActions: ['plan.revision.submit', 'flow.cancel'],
  })
}

beforeEach(() => {
  observeMock.mockReset()
  performMock.mockReset()
  requestCounter = 0
  useCollaborationHubStore.getState().setAddress(null)
})

describe('validatePlanDraftForm', () => {
  it('空目标 / 空任务被拦截', () => {
    const form = emptyPlanDraftForm()
    expect(validatePlanDraftForm(form)).toContain('目标不能为空')
    expect(validatePlanDraftForm({ objective: 'x', tasks: [] })).toContain('至少需要一个任务')
  })

  it('重复 key / 空标题被拦截', () => {
    const errors = validatePlanDraftForm({
      objective: 'o',
      tasks: [
        { taskKey: 'a', title: 'A', summary: '', dependsOnText: '' },
        { taskKey: 'a', title: '', summary: '', dependsOnText: '' },
      ],
    })
    expect(errors.some((e) => e.includes('任务标识重复'))).toBe(true)
    expect(errors.some((e) => e.includes('标题不能为空'))).toBe(true)
  })

  it('未知依赖与环依赖被拦截', () => {
    expect(
      validatePlanDraftForm({
        objective: 'o',
        tasks: [{ taskKey: 'a', title: 'A', summary: '', dependsOnText: 'ghost' }],
      }).some((e) => e.includes('未知任务')),
    ).toBe(true)
    expect(
      validatePlanDraftForm({
        objective: 'o',
        tasks: [
          { taskKey: 'a', title: 'A', summary: '', dependsOnText: 'b' },
          { taskKey: 'b', title: 'B', summary: '', dependsOnText: 'a' },
        ],
      }),
    ).toContain('任务依赖存在循环')
  })

  it('合法表单通过且 DTO 只含契约字段', () => {
    const form = {
      objective: '  目标  ',
      tasks: [
        { taskKey: ' t1 ', title: ' 任务一 ', summary: '', dependsOnText: '' },
        {
          taskKey: 't2',
          title: '任务二',
          summary: ' 摘要 ',
          dependsOnText: 't1, t3',
        },
        { taskKey: 't3', title: '任务三', summary: '', dependsOnText: '' },
      ],
    }
    expect(validatePlanDraftForm(form)).toEqual([])
    const dto = toInitialPlanDraft(form)
    expect(dto).toEqual({
      objective: '目标',
      tasks: [
        { taskKey: 't1', title: '任务一' },
        {
          taskKey: 't2',
          title: '任务二',
          summary: '摘要',
          dependsOn: ['t1', 't3'],
        },
        { taskKey: 't3', title: '任务三' },
      ],
    })
    expect(parseDependsOnText('a，b  c')).toEqual(['a', 'b', 'c'])
  })
})

describe('collaboration-hub-store', () => {
  it('无 address 时不发起任何 IPC', async () => {
    await useCollaborationHubStore.getState().refresh()
    expect(observeMock).not.toHaveBeenCalled()
  })

  it('refresh 成功后保存主进程投影', async () => {
    observeMock.mockResolvedValueOnce({ ok: true, value: projectionFixture() })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    expect(useCollaborationHubStore.getState().projection?.sessionVersion).toBe(3)
    expect(observeMock).toHaveBeenCalledWith(addressA)
  })

  it('切换 address 清空旧投影与表单，并丢弃晚到的旧结果', async () => {
    let resolveOld!: (v: unknown) => void
    observeMock.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
    observeMock.mockResolvedValue({
      ok: true,
      value: projectionFixture({ address: addressB }),
    })

    const store = useCollaborationHubStore.getState()
    store.setAddress(addressA)
    store.setForm({ objective: '旧表单', tasks: [] })
    const pending = useCollaborationHubStore.getState().refresh()

    // 旧请求未返回时切换到会话 B
    useCollaborationHubStore.getState().setAddress(addressB)
    expect(useCollaborationHubStore.getState().projection).toBeNull()
    expect(useCollaborationHubStore.getState().form).toEqual(emptyPlanDraftForm())

    // 晚到的旧结果必须被丢弃
    resolveOld({ ok: true, value: projectionFixture() })
    await pending
    expect(useCollaborationHubStore.getState().projection).toBeNull()
  })

  it('availableActions 不含动作时不发起 perform', async () => {
    observeMock.mockResolvedValue({
      ok: true,
      value: projectionFixture({ availableActions: [] }),
    })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.getState().setForm({
      objective: 'o',
      tasks: [{ taskKey: 't1', title: 'T', summary: '', dependsOnText: '' }],
    })
    await useCollaborationHubStore.getState().startWithDraft()
    await useCollaborationHubStore.getState().approveActiveRevision()
    await useCollaborationHubStore.getState().cancelActiveFlow('r')
    expect(performMock).not.toHaveBeenCalled()
  })

  it('建稿请求带唯一 requestId 与当前 expectedSessionVersion，成功后重新 observe', async () => {
    observeMock.mockResolvedValue({ ok: true, value: projectionFixture() })
    performMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: 'x',
        intentType: 'flow.start.with_draft',
        sessionVersion: 4,
      },
    })

    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.getState().setForm({
      objective: '目标',
      tasks: [{ taskKey: 't1', title: '任务一', summary: '', dependsOnText: '' }],
    })
    await useCollaborationHubStore.getState().startWithDraft()

    expect(performMock).toHaveBeenCalledTimes(1)
    const [addr, request] = performMock.mock.calls[0]!
    expect(addr).toEqual(addressA)
    expect(request.expectedSessionVersion).toBe(3)
    expect(request.requestId).toMatch(/^test-req-/)
    expect(request.intent).toEqual({
      type: 'flow.start.with_draft',
      draft: { objective: '目标', tasks: [{ taskKey: 't1', title: '任务一' }] },
    })
    // 成功后重新 observe（初始 1 次 + 动作后 1 次）
    expect(observeMock).toHaveBeenCalledTimes(2)
    // 表单已清空
    expect(useCollaborationHubStore.getState().form).toEqual(emptyPlanDraftForm())
  })

  it('动作后的刷新晚到时不会清空新会话正在填写的表单', async () => {
    let resolvePostPerformObserve!: (value: unknown) => void
    observeMock
      .mockResolvedValueOnce({ ok: true, value: projectionFixture() })
      .mockImplementationOnce(() => new Promise((resolve) => (resolvePostPerformObserve = resolve)))
    performMock.mockResolvedValueOnce({
      ok: true,
      value: { requestId: 'x', intentType: 'flow.start.with_draft', sessionVersion: 4 },
    })

    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.getState().setForm({
      objective: '会话 A',
      tasks: [{ taskKey: 'a', title: 'A', summary: '', dependsOnText: '' }],
    })
    const pending = useCollaborationHubStore.getState().startWithDraft()
    await vi.waitFor(() => expect(observeMock).toHaveBeenCalledTimes(2))

    useCollaborationHubStore.getState().setAddress(addressB)
    const newSessionForm = {
      objective: '会话 B 正在填写',
      tasks: [{ taskKey: 'b', title: 'B', summary: '', dependsOnText: '' }],
    }
    useCollaborationHubStore.getState().setForm(newSessionForm)
    resolvePostPerformObserve({ ok: true, value: awaitingProjection() })
    await pending

    expect(useCollaborationHubStore.getState().address).toEqual(addressB)
    expect(useCollaborationHubStore.getState().form).toEqual(newSessionForm)
  })

  it('同一动作提交中拒绝重复提交', async () => {
    let resolvePerform!: (value: unknown) => void
    const pendingPerform = new Promise((resolve) => (resolvePerform = resolve))
    observeMock.mockResolvedValue({ ok: true, value: projectionFixture() })
    performMock.mockReturnValue(pendingPerform)

    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.getState().setForm({
      objective: '目标',
      tasks: [{ taskKey: 't1', title: '任务一', summary: '', dependsOnText: '' }],
    })

    const first = useCollaborationHubStore.getState().startWithDraft()
    const duplicate = useCollaborationHubStore.getState().startWithDraft()
    await vi.waitFor(() => expect(performMock).toHaveBeenCalled())
    const callCountBeforeResolve = performMock.mock.calls.length
    resolvePerform({ ok: true, value: { requestId: 'x', intentType: 'flow.start.with_draft', sessionVersion: 4 } })
    await Promise.all([first, duplicate])

    expect(callCountBeforeResolve).toBe(1)
  })

  it('前端校验失败时不发起 perform', async () => {
    observeMock.mockResolvedValue({ ok: true, value: projectionFixture() })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.getState().setForm(emptyPlanDraftForm())
    await useCollaborationHubStore.getState().startWithDraft()
    expect(performMock).not.toHaveBeenCalled()
    expect(useCollaborationHubStore.getState().formErrors.length).toBeGreaterThan(0)
  })

  it('批准使用投影携带的 canonical draft，而非内存表单', async () => {
    observeMock.mockResolvedValue({ ok: true, value: awaitingProjection() })
    performMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: 'x',
        intentType: 'plan.revision.submit',
        sessionVersion: 5,
      },
    })

    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    // 内存表单填入与投影不同的内容，不得被使用
    useCollaborationHubStore.getState().setForm({
      objective: '内存伪造目标',
      tasks: [{ taskKey: 'fake', title: 'fake', summary: '', dependsOnText: '' }],
    })
    await useCollaborationHubStore.getState().approveActiveRevision()

    expect(performMock).toHaveBeenCalledTimes(1)
    const [, request] = performMock.mock.calls[0]!
    expect(request.expectedSessionVersion).toBe(4)
    expect(request.intent).toEqual({
      type: 'plan.revision.submit',
      flowId: 'xhbf_flow1',
      baseRevisionId: 'xhbr_rev1',
      draft: {
        objective: '目标X',
        tasks: [{ taskKey: 't1', title: '投影任务' }],
      },
    })
  })

  it('取消 Flow 使用默认固定文案并可被用户原因覆盖', async () => {
    observeMock.mockResolvedValue({ ok: true, value: awaitingProjection() })
    performMock.mockResolvedValue({
      ok: true,
      value: { requestId: 'x', intentType: 'flow.cancel', sessionVersion: 5 },
    })

    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    await useCollaborationHubStore.getState().cancelActiveFlow('')
    expect(performMock.mock.calls[0]![1].intent).toEqual({
      type: 'flow.cancel',
      flowId: 'xhbf_flow1',
      reason: '用户取消当前协作计划',
    })

    await useCollaborationHubStore.getState().cancelActiveFlow('需求变更')
    expect(performMock.mock.calls[1]![1].intent.reason).toBe('需求变更')
  })

  it('perform 失败只保存脱敏错误', async () => {
    observeMock.mockResolvedValue({ ok: true, value: awaitingProjection() })
    performMock.mockResolvedValue({
      ok: false,
      error: {
        code: 'REVISION_CONFLICT',
        messageKey: 'xiaogui.hub.revision_conflict',
        traceId: 'tr-1',
      },
    })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    await useCollaborationHubStore.getState().approveActiveRevision()
    const error = useCollaborationHubStore.getState().error
    expect(error?.code).toBe('REVISION_CONFLICT')
    expect(error?.traceId).toBe('tr-1')
  })
})
