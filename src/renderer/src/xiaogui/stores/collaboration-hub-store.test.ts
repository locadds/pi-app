import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  PlanRevisionId,
  SessionCollaborationProjectionM2BV1,
  TaskRunId,
  TaskSpecId,
} from '@shared/xiaogui-collaboration-hub'
import type { DeliveryBatchProjectionV1 } from '@shared/xiaogui-delivery'
import type { TaskVerificationSummaryV1 } from '@shared/xiaogui-task-verification'

const observeMock = vi.fn()
const performMock = vi.fn()
const executeMock = vi.fn()
const submitDeliveryMock = vi.fn()
const approveDeliveryMock = vi.fn()
const returnDeliveryMock = vi.fn()
const reconcileDeliveryMock = vi.fn()
const retryDeliveryMock = vi.fn()
let requestCounter = 0
vi.mock('../lib/collaboration-hub-client', () => ({
  HUB_CONTRACT_VERSION: 'm2a.v1',
  HUB_OBSERVE_CONTRACT_VERSION: 'm2b.v1',
  DELIVERY_CONTRACT_VERSION: 'm4d.v1',
  observeCollaborationHub: (address: HubAddressV1) => observeMock(address),
  performHubIntent: (address: HubAddressV1, request: unknown) => performMock(address, request),
  startTaskExecution: (request: unknown) => executeMock(request),
  submitDeliverySelection: (address: HubAddressV1, request: unknown) => submitDeliveryMock(address, request),
  approveDeliveryGate: (address: HubAddressV1, request: unknown) => approveDeliveryMock(address, request),
  returnDeliveryBatch: (address: HubAddressV1, request: unknown) => returnDeliveryMock(address, request),
  reconcileDeliveryApply: (address: HubAddressV1, request: unknown) => reconcileDeliveryMock(address, request),
  retryDeliveryApply: (address: HubAddressV1, request: unknown) => retryDeliveryMock(address, request),
  newHubRequestId: () => `test-req-${++requestCounter}`,
}))

import {
  emptyPlanDraftForm,
  emptyTaskExecutionForm,
  parseDependsOnText,
  parseTaskExecutionPaths,
  toTaskExecutionStartRequest,
  toInitialPlanDraft,
  useCollaborationHubStore,
  validatePlanDraftForm,
  validateTaskExecutionForm,
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

function executableProjection(flowId = 'xhbf_flow1' as FlowId): SessionCollaborationProjectionM2BV1 {
  return projectionFixture({
    sessionMode: 'CODING',
    authoritativeMode: 'CODING',
    activeFlow: {
      flowId,
      status: 'PLAN_ACTIVE',
      activeRevisionId: null,
      objective: '目标X',
    },
    availableActions: ['flow.cancel', 'execution.next.confirm'],
  })
}

function deliveryProjection(): DeliveryBatchProjectionV1 {
  return {
    batchId: 'xhbd_batch1' as DeliveryBatchProjectionV1['batchId'],
    flowId: 'xhbf_flow1' as FlowId,
    state: 'READY_FOR_REVIEW',
    selectionDigest: `sha256:${'1'.repeat(64)}` as DeliveryBatchProjectionV1['selectionDigest'],
    selectedTaskRunIds: ['xhbtr_delivery'] as unknown as DeliveryBatchProjectionV1['selectedTaskRunIds'],
    taskChangeSetIds: ['xhbtcs_delivery'] as unknown as DeliveryBatchProjectionV1['taskChangeSetIds'],
    targetFingerprint: `sha256:${'2'.repeat(64)}` as DeliveryBatchProjectionV1['targetFingerprint'],
    deliveryChangeSetId: 'xhbdcs_delivery' as DeliveryBatchProjectionV1['deliveryChangeSetId'],
    deliveryChangeSetDigest: `sha256:${'3'.repeat(64)}` as DeliveryBatchProjectionV1['deliveryChangeSetDigest'],
    fileChangeSummaries: [
      {
        operation: 'MODIFY',
        relativePath: 'src/a.ts',
        baselineDigest: `sha256:${'4'.repeat(64)}` as never,
        contentDigest: `sha256:${'5'.repeat(64)}` as never,
        contentArtifactId: 'xhbartifact_hidden' as never,
        sourceTaskChangeSetIds: ['xhbtcs_delivery'] as never,
      },
    ],
    evidenceArtifactIds: ['xhbartifact_evidence' as never],
    gate: {
      gateId: 'xhbdg_delivery' as never,
      batchId: 'xhbd_batch1' as never,
      subject: {
        deliveryChangeSetId: 'xhbdcs_delivery' as never,
        version: 1,
        digest: `sha256:${'3'.repeat(64)}` as never,
      },
      state: 'OPEN',
      createdAt: '2026-08-18T00:00:00.000Z' as never,
    },
  }
}

beforeEach(() => {
  observeMock.mockReset()
  performMock.mockReset()
  executeMock.mockReset()
  submitDeliveryMock.mockReset()
  approveDeliveryMock.mockReset()
  returnDeliveryMock.mockReset()
  reconcileDeliveryMock.mockReset()
  retryDeliveryMock.mockReset()
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

describe('task execution form', () => {
  it('按行生成最小执行请求，不产生内部字段', () => {
    const form = {
      prompt: '  完成任务  ',
      modifyPathsText: 'src/a.ts\r\nsrc/b.ts',
      createPathsText: 'src/new.ts',
    }
    expect(validateTaskExecutionForm(form)).toEqual([])
    expect(parseTaskExecutionPaths(form.modifyPathsText)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(toTaskExecutionStartRequest(addressA, 'xhbf_flow1' as FlowId, form)).toEqual({
      address: addressA,
      flowId: 'xhbf_flow1',
      prompt: '完成任务',
      files: [
        { operation: 'MODIFY', relativePath: 'src/a.ts' },
        { operation: 'MODIFY', relativePath: 'src/b.ts' },
        { operation: 'CREATE', relativePath: 'src/new.ts' },
      ],
    })
  })

  it('本地拦截空内容、绝对路径、路径穿越和重复范围', () => {
    const errors = validateTaskExecutionForm({
      prompt: '',
      modifyPathsText: 'C:\\secret.ts\nsrc/../secret.ts\nsrc/same.ts',
      createPathsText: 'src\\same.ts',
    })
    expect(errors).toContain('任务说明不能为空')
    expect(errors.some((error) => error.includes('只允许项目内相对路径'))).toBe(true)
    expect(errors.some((error) => error.includes('不能包含空段、. 或 ..'))).toBe(true)
    expect(errors).toContain('文件范围重复：src\\same.ts')
  })

  it('非空路径行保留原文，首尾空白必须显式修正', () => {
    const form = {
      prompt: '任务',
      modifyPathsText: ' src/a.ts \n   \nsrc/b.ts',
      createPathsText: '',
    }
    expect(parseTaskExecutionPaths(form.modifyPathsText)).toEqual([' src/a.ts ', 'src/b.ts'])
    expect(validateTaskExecutionForm(form)).toContain('修改文件路径不能带首尾空白：src/a.ts')
    expect(toTaskExecutionStartRequest(addressA, 'xhbf_flow1' as FlowId, form).files[0]).toEqual({
      operation: 'MODIFY',
      relativePath: ' src/a.ts ',
    })
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

  it('验证摘要只随权威投影保存，切换会话时一并清空', async () => {
    const verificationSummary: TaskVerificationSummaryV1 = {
      scope: 'TASK',
      verificationAttemptId: 'xhbva_store' as TaskVerificationSummaryV1['verificationAttemptId'],
      candidateId: 'xhbcandidate_store' as TaskVerificationSummaryV1['candidateId'],
      changeSetDigest: `sha256:${'e'.repeat(64)}` as TaskVerificationSummaryV1['changeSetDigest'],
      qaConfigVersion: 'task-fixed-typecheck.v1',
      diagnosticArtifacts: [],
      state: 'STARTED',
    }
    observeMock.mockResolvedValueOnce({
      ok: true,
      value: projectionFixture({
        taskRuns: [
          {
            taskRunId: 'xhbtr_store' as TaskRunId,
            taskSpecId: 'xhbts_store' as TaskSpecId,
            taskKey: 'store',
            status: 'VERIFYING',
            attemptId: 'xhba_store' as AttemptId,
          },
        ],
        attempts: [
          {
            attemptId: 'xhba_store' as AttemptId,
            taskRunId: 'xhbtr_store' as TaskRunId,
            status: 'VERIFYING',
            verificationSummary,
          },
        ],
      }),
    })

    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    expect(useCollaborationHubStore.getState().projection?.attempts[0]?.verificationSummary).toEqual(verificationSummary)

    useCollaborationHubStore.getState().setAddress(addressB)
    expect(useCollaborationHubStore.getState().projection).toBeNull()
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

  it('核对执行范围不调用 IPC，最终确认提交一次并刷新投影', async () => {
    let resolveExecution!: (value: unknown) => void
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    executeMock.mockReturnValue(new Promise((resolve) => (resolveExecution = resolve)))
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()

    const executionForm = {
      prompt: '完成当前任务',
      modifyPathsText: 'src/a.ts',
      createPathsText: 'src/new.ts',
    }
    useCollaborationHubStore.getState().setExecutionForm(executionForm)
    expect(useCollaborationHubStore.getState().reviewTaskExecution()).toBe(true)
    expect(executeMock).not.toHaveBeenCalled()

    const first = useCollaborationHubStore.getState().startNextTaskExecution()
    const duplicate = useCollaborationHubStore.getState().startNextTaskExecution()
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1))
    expect(executeMock.mock.calls[0]![0]).toEqual({
      address: addressA,
      flowId: 'xhbf_flow1',
      prompt: '完成当前任务',
      files: [
        { operation: 'MODIFY', relativePath: 'src/a.ts' },
        { operation: 'CREATE', relativePath: 'src/new.ts' },
      ],
    })

    resolveExecution({
      ok: true,
      value: {
        taskRun: {
          taskRunId: 'xhbtr_1' as TaskRunId,
          taskSpecId: 'xhbts_1' as TaskSpecId,
          taskKey: 't1',
          status: 'RUNNING',
          attemptId: 'xhba_1' as AttemptId,
        },
        attempt: { attemptId: 'xhba_1' as AttemptId, taskRunId: 'xhbtr_1' as TaskRunId, status: 'RUNNING' },
      },
    })
    await Promise.all([first, duplicate])

    expect(observeMock).toHaveBeenCalledTimes(2)
    expect(useCollaborationHubStore.getState().executionForm).toEqual(emptyTaskExecutionForm())
    expect(useCollaborationHubStore.getState().executionReviewing).toBe(false)
  })

  it('执行失败保留核对内容；结果未知仍刷新投影', async () => {
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    executeMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN', messageKey: 'xiaogui.execution.outcome_unknown', traceId: '' },
    })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    const executionForm = { prompt: '保留我', modifyPathsText: 'src/a.ts', createPathsText: '' }
    useCollaborationHubStore.getState().setExecutionForm(executionForm)
    useCollaborationHubStore.getState().reviewTaskExecution()

    await useCollaborationHubStore.getState().startNextTaskExecution()

    expect(observeMock).toHaveBeenCalledTimes(2)
    expect(useCollaborationHubStore.getState().executionForm).toEqual(executionForm)
    expect(useCollaborationHubStore.getState().executionReviewing).toBe(true)
    expect(useCollaborationHubStore.getState().executionError?.code).toBe('OUTCOME_UNKNOWN')
  })

  it('权威 flow 变化时清空旧执行表单', async () => {
    observeMock
      .mockResolvedValueOnce({ ok: true, value: executableProjection('xhbf_flow1' as FlowId) })
      .mockResolvedValueOnce({ ok: true, value: executableProjection('xhbf_flow2' as FlowId) })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.getState().setExecutionForm({
      prompt: '旧任务',
      modifyPathsText: 'src/old.ts',
      createPathsText: '',
    })
    useCollaborationHubStore.getState().reviewTaskExecution()

    await useCollaborationHubStore.getState().refresh()

    expect(useCollaborationHubStore.getState().executionFlowId).toBe('xhbf_flow2')
    expect(useCollaborationHubStore.getState().executionForm).toEqual(emptyTaskExecutionForm())
    expect(useCollaborationHubStore.getState().executionReviewing).toBe(false)
  })

  it('执行等待中切换 flow 会解除提交锁并丢弃晚到响应', async () => {
    let resolveExecution!: (value: unknown) => void
    observeMock
      .mockResolvedValueOnce({ ok: true, value: executableProjection('xhbf_flow1' as FlowId) })
      .mockResolvedValueOnce({ ok: true, value: executableProjection('xhbf_flow2' as FlowId) })
    executeMock.mockReturnValue(new Promise((resolve) => (resolveExecution = resolve)))
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.getState().setExecutionForm({
      prompt: '旧任务',
      modifyPathsText: 'src/old.ts',
      createPathsText: '',
    })
    useCollaborationHubStore.getState().reviewTaskExecution()
    const pending = useCollaborationHubStore.getState().startNextTaskExecution()
    await vi.waitFor(() => expect(useCollaborationHubStore.getState().submitting).toBe(true))

    await useCollaborationHubStore.getState().refresh()
    expect(useCollaborationHubStore.getState().submitting).toBe(false)
    expect(useCollaborationHubStore.getState().executionFlowId).toBe('xhbf_flow2')

    resolveExecution({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'old', traceId: '' },
    })
    await pending
    expect(useCollaborationHubStore.getState().submitting).toBe(false)
    expect(useCollaborationHubStore.getState().executionError).toBeNull()
    expect(useCollaborationHubStore.getState().executionForm).toEqual(emptyTaskExecutionForm())
  })

  it('执行等待中切换 address 会解除提交锁并丢弃晚到响应', async () => {
    let resolveExecution!: (value: unknown) => void
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    executeMock.mockReturnValue(new Promise((resolve) => (resolveExecution = resolve)))
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.getState().setExecutionForm({
      prompt: '旧会话任务',
      modifyPathsText: 'src/old.ts',
      createPathsText: '',
    })
    useCollaborationHubStore.getState().reviewTaskExecution()
    const pending = useCollaborationHubStore.getState().startNextTaskExecution()
    await vi.waitFor(() => expect(useCollaborationHubStore.getState().submitting).toBe(true))

    useCollaborationHubStore.getState().setAddress(addressB)
    expect(useCollaborationHubStore.getState().submitting).toBe(false)

    resolveExecution({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'old', traceId: '' },
    })
    await pending
    expect(useCollaborationHubStore.getState().address).toEqual(addressB)
    expect(useCollaborationHubStore.getState().submitting).toBe(false)
    expect(useCollaborationHubStore.getState().executionError).toBeNull()
  })

  it('交付审阅零 IPC，确认应用只提交当前 gate subject 一次', async () => {
    const delivery = deliveryProjection()
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    approveDeliveryMock.mockResolvedValue({ ok: true, value: { ...delivery, state: 'APPLYING' } })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.setState({
      projection: {
        ...useCollaborationHubStore.getState().projection!,
        activeDelivery: delivery,
        availableActions: ['flow.cancel', 'delivery.gate.approve', 'delivery.gate.reject'],
      },
    })

    expect(useCollaborationHubStore.getState().reviewActiveDelivery()).toBe(true)
    expect(approveDeliveryMock).not.toHaveBeenCalled()

    const first = useCollaborationHubStore.getState().approveActiveDelivery()
    const duplicate = useCollaborationHubStore.getState().approveActiveDelivery()
    await Promise.all([first, duplicate])

    expect(approveDeliveryMock).toHaveBeenCalledTimes(1)
    expect(approveDeliveryMock.mock.calls[0]![0]).toEqual(addressA)
    expect(approveDeliveryMock.mock.calls[0]![1]).toEqual({
      requestId: 'test-req-1',
      gateId: delivery.gate!.gateId,
      subject: delivery.gate!.subject,
    })
  })

  it('从已验证任务创建交付：本地复选后只提交一次 selection intent', async () => {
    const delivery = deliveryProjection()
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    submitDeliveryMock.mockResolvedValue({ ok: true, value: delivery })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.setState({
      projection: {
        ...useCollaborationHubStore.getState().projection!,
        availableActions: ['flow.cancel', 'delivery.selection.submit'],
      },
    })

    expect(await useCollaborationHubStore.getState().createDeliveryFromSelection()).toBe(false)
    useCollaborationHubStore.getState().toggleDeliveryTaskSelection('xhbtr_delivery' as TaskRunId)
    const first = useCollaborationHubStore.getState().createDeliveryFromSelection()
    const duplicate = useCollaborationHubStore.getState().createDeliveryFromSelection()
    await Promise.all([first, duplicate])

    expect(submitDeliveryMock).toHaveBeenCalledTimes(1)
    expect(submitDeliveryMock.mock.calls[0]![1]).toEqual({
      requestId: 'test-req-1',
      flowId: 'xhbf_flow1',
      taskRunIds: ['xhbtr_delivery'],
    })
    expect(useCollaborationHubStore.getState().selectedDeliveryTaskRunIds).toEqual([])
  })

  it('退回交付是独立动作，不要求确认应用二次态', async () => {
    const delivery = deliveryProjection()
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    returnDeliveryMock.mockResolvedValue({ ok: true, value: { ...delivery, state: 'REJECTED' } })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.setState({
      projection: {
        ...useCollaborationHubStore.getState().projection!,
        activeDelivery: delivery,
        availableActions: ['flow.cancel', 'delivery.gate.reject'],
      },
    })

    await useCollaborationHubStore.getState().rejectActiveDelivery('  需要调整  ')

    expect(returnDeliveryMock).toHaveBeenCalledTimes(1)
    expect(returnDeliveryMock.mock.calls[0]![1]).toEqual({
      requestId: 'test-req-1',
      gateId: delivery.gate!.gateId,
      subject: delivery.gate!.subject,
      rejectionReason: '需要调整',
    })
    expect(approveDeliveryMock).not.toHaveBeenCalled()
  })
})
