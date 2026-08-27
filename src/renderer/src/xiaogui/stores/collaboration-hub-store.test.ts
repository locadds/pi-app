import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AttemptId,
  ExecutionReadinessSnapshotV1,
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
const batchExecuteMock = vi.fn()
const submitDeliveryMock = vi.fn()
const approveDeliveryMock = vi.fn()
const returnDeliveryMock = vi.fn()
const reconcileDeliveryMock = vi.fn()
const retryDeliveryMock = vi.fn()
const prepareRecoveryMock = vi.fn()
let requestCounter = 0
vi.mock('../lib/collaboration-hub-client', () => ({
  HUB_CONTRACT_VERSION: 'm2a.v1',
  HUB_OBSERVE_CONTRACT_VERSION: 'm2b.v1',
  DELIVERY_CONTRACT_VERSION: 'm4d.v1',
  observeCollaborationHub: (address: HubAddressV1) => observeMock(address),
  performHubIntent: (address: HubAddressV1, request: unknown) => performMock(address, request),
  startTaskExecutionBatch: (request: unknown) => batchExecuteMock(request),
  submitDeliverySelection: (address: HubAddressV1, request: unknown) => submitDeliveryMock(address, request),
  approveDeliveryGate: (address: HubAddressV1, request: unknown) => approveDeliveryMock(address, request),
  returnDeliveryBatch: (address: HubAddressV1, request: unknown) => returnDeliveryMock(address, request),
  reconcileDeliveryApply: (address: HubAddressV1, request: unknown) => reconcileDeliveryMock(address, request),
  retryDeliveryApply: (address: HubAddressV1, request: unknown) => retryDeliveryMock(address, request),
  prepareDeliveryRecovery: (address: HubAddressV1, request: unknown) => prepareRecoveryMock(address, request),
  newHubRequestId: () => `test-req-${++requestCounter}`,
}))

import {
  eligibleExecutionTaskRunIds,
  emptyPlanDraftForm,
  parseDependsOnText,
  parseTaskExecutionPaths,
  toInitialPlanDraft,
  toTaskExecutionItemPayload,
  toTaskExecutionStartBatchRequest,
  useCollaborationHubStore,
  validatePlanDraftForm,
  validateTaskExecutionBatch,
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
  const readyDepState = (taskRunId: TaskRunId): ExecutionReadinessSnapshotV1['dependencyStates'][number] => ({
    version: 1,
    taskRunId,
    state: 'READY',
    dependencyTaskRunIds: [],
    blockingTaskRunIds: [],
    verifiedAncestorTaskChangeSetIds: [],
  })
  return projectionFixture({
    sessionMode: 'CODING',
    authoritativeMode: 'CODING',
    activeFlow: {
      flowId,
      status: 'PLAN_ACTIVE',
      activeRevisionId: null,
      objective: '目标X',
    },
    taskSpecs: [
      {
        taskSpecId: 'xhbts_1' as TaskSpecId,
        taskKey: 't1',
        title: '投影任务一',
        dependsOn: [],
        unavailableReason: 'AGENT_DISABLED_M2A',
      },
      {
        taskSpecId: 'xhbts_2' as TaskSpecId,
        taskKey: 't2',
        title: '投影任务二',
        dependsOn: [],
        unavailableReason: 'AGENT_DISABLED_M2A',
      },
    ],
    taskRuns: [
      { taskRunId: 'xhbtr_1' as TaskRunId, taskSpecId: 'xhbts_1' as TaskSpecId, taskKey: 't1', status: 'READY' },
      { taskRunId: 'xhbtr_2' as TaskRunId, taskSpecId: 'xhbts_2' as TaskSpecId, taskKey: 't2', status: 'READY' },
    ],
    executionReadiness: {
      version: 1,
      flowId,
      maxParallelism: 2,
      activeAttemptCount: 0,
      availableSlots: 2,
      dependencyStates: [readyDepState('xhbtr_1' as TaskRunId), readyDepState('xhbtr_2' as TaskRunId)],
      readyTaskRunIds: ['xhbtr_1' as TaskRunId, 'xhbtr_2' as TaskRunId],
      capturedAt: '2026-08-27T00:00:00.000Z',
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

function batchExecutionValue(n: number) {
  return {
    taskRun: {
      taskRunId: `xhbtr_${n}` as TaskRunId,
      taskSpecId: `xhbts_${n}` as TaskSpecId,
      taskKey: `t${n}`,
      status: 'RUNNING',
      attemptId: `xhba_${n}` as AttemptId,
    },
    attempt: { attemptId: `xhba_${n}` as AttemptId, taskRunId: `xhbtr_${n}` as TaskRunId, status: 'RUNNING' },
  }
}

beforeEach(() => {
  observeMock.mockReset()
  performMock.mockReset()
  batchExecuteMock.mockReset()
  submitDeliveryMock.mockReset()
  approveDeliveryMock.mockReset()
  returnDeliveryMock.mockReset()
  reconcileDeliveryMock.mockReset()
  retryDeliveryMock.mockReset()
  prepareRecoveryMock.mockReset()
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
  it('按行生成最小执行载荷，不产生内部字段', () => {
    const form = {
      prompt: '  完成任务  ',
      modifyPathsText: 'src/a.ts\r\nsrc/b.ts',
      createPathsText: 'src/new.ts',
    }
    expect(validateTaskExecutionForm(form)).toEqual([])
    expect(parseTaskExecutionPaths(form.modifyPathsText)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(toTaskExecutionItemPayload(form)).toEqual({
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
    expect(toTaskExecutionItemPayload(form).files[0]).toEqual({
      operation: 'MODIFY',
      relativePath: ' src/a.ts ',
    })
  })
})

describe('task execution batch', () => {
  it('未选任务被拦截', () => {
    expect(validateTaskExecutionBatch([])).toEqual(['请至少选择一个要执行的任务'])
  })

  it('两个任务之间路径大小写或斜杠别名重叠被拦截', () => {
    const errors = validateTaskExecutionBatch([
      { taskRunId: 'xhbtr_1' as TaskRunId, title: '任务一', form: { prompt: '一', modifyPathsText: 'SRC/a.ts', createPathsText: '' } },
      { taskRunId: 'xhbtr_2' as TaskRunId, title: '任务二', form: { prompt: '二', modifyPathsText: 'src\\a.ts', createPathsText: 'src/b.ts' } },
    ])
    expect(errors).toContain('两个任务的文件范围重叠：src\\a.ts')
  })

  it('不同 taskRunId 但同标题的任务冲突仍被拦截（标题仅用于文案）', () => {
    const errors = validateTaskExecutionBatch([
      { taskRunId: 'xhbtr_1' as TaskRunId, title: '同名任务', form: { prompt: '一', modifyPathsText: 'SRC/a.ts', createPathsText: '' } },
      { taskRunId: 'xhbtr_2' as TaskRunId, title: '同名任务', form: { prompt: '二', modifyPathsText: 'src\\a.ts', createPathsText: '' } },
    ])
    expect(errors).toContain('两个任务的文件范围重叠：src\\a.ts')
  })

  it('逐任务校验错误带任务标题前缀', () => {
    const errors = validateTaskExecutionBatch([
      { taskRunId: 'xhbtr_1' as TaskRunId, title: '任务一', form: { prompt: '', modifyPathsText: 'src/a.ts', createPathsText: '' } },
      { taskRunId: 'xhbtr_2' as TaskRunId, title: '任务二', form: { prompt: '二', modifyPathsText: 'src/b.ts', createPathsText: '' } },
    ])
    expect(errors).toContain('「任务一」任务说明不能为空')
  })

  it('批量请求只含契约版本、公共 address/flowId 与逐项明确内容', () => {
    const request = toTaskExecutionStartBatchRequest(addressA, 'xhbf_flow1' as FlowId, [
      {
        taskRunId: 'xhbtr_1' as TaskRunId,
        form: { prompt: ' 一 ', modifyPathsText: 'src/a.ts', createPathsText: '' },
      },
      {
        taskRunId: 'xhbtr_2' as TaskRunId,
        form: { prompt: '二', modifyPathsText: '', createPathsText: 'src/new.ts' },
      },
    ])
    expect(request).toEqual({
      contractVersion: 'xiaogui.task-execution.batch.v1',
      address: addressA,
      flowId: 'xhbf_flow1',
      items: [
        { taskRunId: 'xhbtr_1', prompt: '一', files: [{ operation: 'MODIFY', relativePath: 'src/a.ts' }] },
        { taskRunId: 'xhbtr_2', prompt: '二', files: [{ operation: 'CREATE', relativePath: 'src/new.ts' }] },
      ],
    })
  })

  it('可执行任务取自 readyTaskRunIds 并按 availableSlots 截断', () => {
    const projection = executableProjection()
    expect(eligibleExecutionTaskRunIds(projection)).toEqual(['xhbtr_1', 'xhbtr_2'])
    expect(
      eligibleExecutionTaskRunIds({
        ...projection,
        executionReadiness: { ...projection.executionReadiness!, availableSlots: 1 },
      }),
    ).toEqual(['xhbtr_1'])
    expect(
      eligibleExecutionTaskRunIds({
        ...projection,
        executionReadiness: { ...projection.executionReadiness!, availableSlots: 0 },
      }),
    ).toEqual([])
    expect(eligibleExecutionTaskRunIds({ ...projection, executionReadiness: undefined })).toEqual([])
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

  it('批量核对零 IPC，一次确认真实调用 startBatch 一次且含两个明确 taskRunId', async () => {
    let resolveExecution!: (value: unknown) => void
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    batchExecuteMock.mockReturnValue(new Promise((resolve) => (resolveExecution = resolve)))
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()

    // 默认勾选当前最多可执行项
    expect(useCollaborationHubStore.getState().selectedExecutionTaskRunIds).toEqual(['xhbtr_1', 'xhbtr_2'])

    useCollaborationHubStore.getState().setExecutionForm('xhbtr_1' as TaskRunId, {
      prompt: '完成任务一',
      modifyPathsText: 'src/a.ts',
      createPathsText: '',
    })
    useCollaborationHubStore.getState().setExecutionForm('xhbtr_2' as TaskRunId, {
      prompt: '完成任务二',
      modifyPathsText: '',
      createPathsText: 'src/new.ts',
    })
    expect(useCollaborationHubStore.getState().reviewExecutionBatch()).toBe(true)
    expect(batchExecuteMock).not.toHaveBeenCalled()

    const first = useCollaborationHubStore.getState().startExecutionBatch()
    const duplicate = useCollaborationHubStore.getState().startExecutionBatch()
    await vi.waitFor(() => expect(batchExecuteMock).toHaveBeenCalledTimes(1))
    expect(batchExecuteMock.mock.calls[0]![0]).toEqual({
      contractVersion: 'xiaogui.task-execution.batch.v1',
      address: addressA,
      flowId: 'xhbf_flow1',
      items: [
        { taskRunId: 'xhbtr_1', prompt: '完成任务一', files: [{ operation: 'MODIFY', relativePath: 'src/a.ts' }] },
        { taskRunId: 'xhbtr_2', prompt: '完成任务二', files: [{ operation: 'CREATE', relativePath: 'src/new.ts' }] },
      ],
    })

    resolveExecution({
      ok: true,
      value: {
        contractVersion: 'xiaogui.task-execution.batch.v1',
        items: [
          { ok: true, taskRunId: 'xhbtr_1', value: batchExecutionValue(1) },
          { ok: true, taskRunId: 'xhbtr_2', value: batchExecutionValue(2) },
        ],
      },
    })
    await Promise.all([first, duplicate])

    expect(observeMock).toHaveBeenCalledTimes(2)
    expect(useCollaborationHubStore.getState().executionForms).toEqual({})
    expect(useCollaborationHubStore.getState().selectedExecutionTaskRunIds).toEqual([])
    expect(useCollaborationHubStore.getState().executionReviewing).toBe(false)
  })

  it('部分成功只清空成功项表单，失败项保留输入并记录对应安全错误', async () => {
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    batchExecuteMock.mockResolvedValue({
      ok: true,
      value: {
        contractVersion: 'xiaogui.task-execution.batch.v1',
        items: [
          { ok: true, taskRunId: 'xhbtr_1', value: batchExecutionValue(1) },
          {
            ok: false,
            taskRunId: 'xhbtr_2',
            error: { code: 'EXECUTION_IN_PROGRESS', messageKey: 'xiaogui.execution.in_progress', traceId: '' },
          },
        ],
      },
    })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()

    useCollaborationHubStore.getState().setExecutionForm('xhbtr_1' as TaskRunId, {
      prompt: '完成任务一',
      modifyPathsText: 'src/a.ts',
      createPathsText: '',
    })
    const formTwo = { prompt: '保留输入二', modifyPathsText: 'src/b.ts', createPathsText: '' }
    useCollaborationHubStore.getState().setExecutionForm('xhbtr_2' as TaskRunId, formTwo)
    expect(useCollaborationHubStore.getState().reviewExecutionBatch()).toBe(true)

    await useCollaborationHubStore.getState().startExecutionBatch()

    expect(useCollaborationHubStore.getState().executionForms).toEqual({ xhbtr_2: formTwo })
    expect(useCollaborationHubStore.getState().selectedExecutionTaskRunIds).toEqual(['xhbtr_2'])
    expect(useCollaborationHubStore.getState().executionItemErrors.xhbtr_2?.code).toBe('EXECUTION_IN_PROGRESS')
    expect(useCollaborationHubStore.getState().executionError).toBeNull()
    expect(useCollaborationHubStore.getState().executionReviewing).toBe(false)
  })

  it('两个任务路径大小写/斜杠别名重叠时阻止提交', async () => {
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()

    useCollaborationHubStore.getState().setExecutionForm('xhbtr_1' as TaskRunId, {
      prompt: '一',
      modifyPathsText: 'SRC/a.ts',
      createPathsText: '',
    })
    useCollaborationHubStore.getState().setExecutionForm('xhbtr_2' as TaskRunId, {
      prompt: '二',
      modifyPathsText: 'src\\a.ts',
      createPathsText: '',
    })

    expect(useCollaborationHubStore.getState().reviewExecutionBatch()).toBe(false)
    expect(useCollaborationHubStore.getState().executionFormErrors).toContain('两个任务的文件范围重叠：src\\a.ts')
    await useCollaborationHubStore.getState().startExecutionBatch()
    expect(batchExecuteMock).not.toHaveBeenCalled()
  })

  it('不同 taskRunId 但同标题的任务路径冲突同样阻止 review 与 startBatch', async () => {
    const base = executableProjection()
    observeMock.mockResolvedValue({
      ok: true,
      value: { ...base, taskSpecs: base.taskSpecs.map((spec) => ({ ...spec, title: '同名任务' })) },
    })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()

    useCollaborationHubStore.getState().setExecutionForm('xhbtr_1' as TaskRunId, {
      prompt: '一',
      modifyPathsText: 'SRC/a.ts',
      createPathsText: '',
    })
    useCollaborationHubStore.getState().setExecutionForm('xhbtr_2' as TaskRunId, {
      prompt: '二',
      modifyPathsText: 'src\\a.ts',
      createPathsText: '',
    })

    expect(useCollaborationHubStore.getState().reviewExecutionBatch()).toBe(false)
    expect(useCollaborationHubStore.getState().executionFormErrors).toContain('两个任务的文件范围重叠：src\\a.ts')
    await useCollaborationHubStore.getState().startExecutionBatch()
    expect(batchExecuteMock).not.toHaveBeenCalled()
  })

  it('批量结果被客户端拒绝为安全 INTERNAL 时保留全部表单与复核内容', async () => {
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    // client 对错配 envelope fail closed 后只返回安全 INTERNAL（此处直接模拟该结果）
    batchExecuteMock.mockResolvedValue({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.execution.error.ipc', traceId: '' },
    })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    const formOne = { prompt: '一', modifyPathsText: 'src/a.ts', createPathsText: '' }
    const formTwo = { prompt: '二', modifyPathsText: 'src/b.ts', createPathsText: '' }
    useCollaborationHubStore.getState().setExecutionForm('xhbtr_1' as TaskRunId, formOne)
    useCollaborationHubStore.getState().setExecutionForm('xhbtr_2' as TaskRunId, formTwo)
    useCollaborationHubStore.getState().reviewExecutionBatch()

    await useCollaborationHubStore.getState().startExecutionBatch()

    expect(useCollaborationHubStore.getState().executionForms).toEqual({ xhbtr_1: formOne, xhbtr_2: formTwo })
    expect(useCollaborationHubStore.getState().executionReviewing).toBe(true)
    expect(useCollaborationHubStore.getState().executionError?.code).toBe('INTERNAL')
    // INTERNAL 不触发投影刷新，不得按错误 envelope 清理任何表单
    expect(observeMock).toHaveBeenCalledTimes(1)
  })

  it('READY/槽位变化时对选择与表单安全收敛', async () => {
    const full = executableProjection()
    observeMock.mockResolvedValueOnce({ ok: true, value: full })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.getState().setExecutionForm('xhbtr_1' as TaskRunId, {
      prompt: '一',
      modifyPathsText: 'src/a.ts',
      createPathsText: '',
    })
    useCollaborationHubStore.getState().setExecutionForm('xhbtr_2' as TaskRunId, {
      prompt: '二',
      modifyPathsText: 'src/b.ts',
      createPathsText: '',
    })
    expect(useCollaborationHubStore.getState().reviewExecutionBatch()).toBe(true)

    // t2 不再 READY 且只剩 1 个槽位：t2 的表单与选择被移除，复核继续
    observeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        ...full,
        executionReadiness: {
          ...full.executionReadiness!,
          availableSlots: 1,
          readyTaskRunIds: ['xhbtr_1' as TaskRunId],
        },
      },
    })
    await useCollaborationHubStore.getState().refresh()
    expect(useCollaborationHubStore.getState().selectedExecutionTaskRunIds).toEqual(['xhbtr_1'])
    expect(Object.keys(useCollaborationHubStore.getState().executionForms)).toEqual(['xhbtr_1'])
    expect(useCollaborationHubStore.getState().executionReviewing).toBe(true)

    // 槽位归零：清空选择并退出复核
    observeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        ...full,
        executionReadiness: { ...full.executionReadiness!, availableSlots: 0, readyTaskRunIds: [] },
      },
    })
    await useCollaborationHubStore.getState().refresh()
    expect(useCollaborationHubStore.getState().selectedExecutionTaskRunIds).toEqual([])
    expect(useCollaborationHubStore.getState().executionForms).toEqual({})
    expect(useCollaborationHubStore.getState().executionReviewing).toBe(false)
  })

  it('批量整体失败保留核对内容；结果未知仍刷新投影', async () => {
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    batchExecuteMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN', messageKey: 'xiaogui.execution.outcome_unknown', traceId: '' },
    })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    const executionForm = { prompt: '保留我', modifyPathsText: 'src/a.ts', createPathsText: '' }
    useCollaborationHubStore.getState().setExecutionForm('xhbtr_1' as TaskRunId, executionForm)
    useCollaborationHubStore.getState().toggleExecutionTaskSelection('xhbtr_2' as TaskRunId)
    useCollaborationHubStore.getState().reviewExecutionBatch()

    await useCollaborationHubStore.getState().startExecutionBatch()

    expect(observeMock).toHaveBeenCalledTimes(2)
    expect(useCollaborationHubStore.getState().executionForms).toEqual({ xhbtr_1: executionForm })
    expect(useCollaborationHubStore.getState().executionReviewing).toBe(true)
    expect(useCollaborationHubStore.getState().executionError?.code).toBe('OUTCOME_UNKNOWN')
  })

  it('权威 flow 变化时清空旧执行表单并重新默认勾选', async () => {
    observeMock
      .mockResolvedValueOnce({ ok: true, value: executableProjection('xhbf_flow1' as FlowId) })
      .mockResolvedValueOnce({ ok: true, value: executableProjection('xhbf_flow2' as FlowId) })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.getState().setExecutionForm('xhbtr_1' as TaskRunId, {
      prompt: '旧任务',
      modifyPathsText: 'src/old.ts',
      createPathsText: '',
    })
    useCollaborationHubStore.getState().reviewExecutionBatch()

    await useCollaborationHubStore.getState().refresh()

    expect(useCollaborationHubStore.getState().executionFlowId).toBe('xhbf_flow2')
    expect(useCollaborationHubStore.getState().executionForms).toEqual({})
    expect(useCollaborationHubStore.getState().executionReviewing).toBe(false)
    expect(useCollaborationHubStore.getState().selectedExecutionTaskRunIds).toEqual(['xhbtr_1', 'xhbtr_2'])
  })

  it('执行等待中切换 flow 会解除提交锁并丢弃晚到响应', async () => {
    let resolveExecution!: (value: unknown) => void
    observeMock
      .mockResolvedValueOnce({ ok: true, value: executableProjection('xhbf_flow1' as FlowId) })
      .mockResolvedValueOnce({ ok: true, value: executableProjection('xhbf_flow2' as FlowId) })
    batchExecuteMock.mockReturnValue(new Promise((resolve) => (resolveExecution = resolve)))
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.getState().setExecutionForm('xhbtr_1' as TaskRunId, {
      prompt: '旧任务',
      modifyPathsText: 'src/old.ts',
      createPathsText: '',
    })
    useCollaborationHubStore.getState().toggleExecutionTaskSelection('xhbtr_2' as TaskRunId)
    useCollaborationHubStore.getState().reviewExecutionBatch()
    const pending = useCollaborationHubStore.getState().startExecutionBatch()
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
    expect(useCollaborationHubStore.getState().executionForms).toEqual({})
  })

  it('执行等待中切换 address 会解除提交锁并丢弃晚到响应', async () => {
    let resolveExecution!: (value: unknown) => void
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    batchExecuteMock.mockReturnValue(new Promise((resolve) => (resolveExecution = resolve)))
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.getState().setExecutionForm('xhbtr_1' as TaskRunId, {
      prompt: '旧会话任务',
      modifyPathsText: 'src/old.ts',
      createPathsText: '',
    })
    useCollaborationHubStore.getState().toggleExecutionTaskSelection('xhbtr_2' as TaskRunId)
    useCollaborationHubStore.getState().reviewExecutionBatch()
    const pending = useCollaborationHubStore.getState().startExecutionBatch()
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

  it('基准恢复只在失败回滚、safeCode 为基准漂移且未写路径时提交', async () => {
    const delivery = deliveryProjection()
    const failedApplyAttempt = {
      applyAttemptId: 'xhbdapp_failed' as never,
      batchId: delivery.batchId,
      deliveryChangeSetId: delivery.deliveryChangeSetId!,
      requestDigest: `sha256:${'a'.repeat(64)}` as never,
      targetFingerprintBefore: `sha256:${'b'.repeat(64)}` as never,
      state: 'FAILED_ROLLED_BACK' as const,
      receiptDigest: `sha256:${'c'.repeat(64)}` as never,
      safeCode: 'TARGET_BASELINE_DRIFT' as const,
      changedRelativePaths: [] as readonly string[],
      startedAt: '2026-08-18T00:00:00.000Z' as never,
      finishedAt: '2026-08-18T00:00:01.000Z' as never,
    }
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    prepareRecoveryMock.mockResolvedValue({ ok: true, value: { ...delivery, state: 'READY_FOR_REVIEW' } })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.setState({
      deliveryReviewSubjectKey: 'stale-review',
      projection: {
        ...useCollaborationHubStore.getState().projection!,
        activeDelivery: { ...delivery, state: 'APPROVED', applyAttempt: failedApplyAttempt },
        availableActions: ['flow.cancel', 'apply.recovery.prepare', 'apply.retry.request'],
      },
    })

    await useCollaborationHubStore.getState().prepareActiveDeliveryRecovery()

    expect(prepareRecoveryMock).toHaveBeenCalledTimes(1)
    expect(prepareRecoveryMock.mock.calls[0]![1]).toEqual({
      requestId: 'test-req-1',
      batchId: delivery.batchId,
      failedApplyAttemptId: 'xhbdapp_failed',
    })
    expect(useCollaborationHubStore.getState().deliveryReviewSubjectKey).toBeNull()

    for (const patch of [
      { state: 'SUCCEEDED' as const, safeCode: 'TARGET_BASELINE_DRIFT' as const, changedRelativePaths: [] as readonly string[] },
      { state: 'FAILED_ROLLED_BACK' as const, safeCode: 'TARGET_STATUS_DIRTY' as const, changedRelativePaths: [] as readonly string[] },
      { state: 'FAILED_ROLLED_BACK' as const, safeCode: 'TARGET_BASELINE_DRIFT' as const, changedRelativePaths: ['src/a.ts'] as readonly string[] },
      { state: 'FAILED_ROLLED_BACK' as const, safeCode: 'TARGET_BASELINE_DRIFT' as const, changedRelativePaths: undefined },
    ]) {
      prepareRecoveryMock.mockClear()
      useCollaborationHubStore.setState({
        projection: {
          ...useCollaborationHubStore.getState().projection!,
          activeDelivery: { ...delivery, state: 'APPROVED', applyAttempt: { ...failedApplyAttempt, ...patch } },
          availableActions: ['apply.recovery.prepare'],
        },
      })
      await useCollaborationHubStore.getState().prepareActiveDeliveryRecovery()
      expect(prepareRecoveryMock).not.toHaveBeenCalled()
    }
  })

  it('普通重试只允许失败终态且排除结果未知和完整性失败', async () => {
    const delivery = deliveryProjection()
    const failedApplyAttempt = {
      applyAttemptId: 'xhbdapp_failed' as never,
      batchId: delivery.batchId,
      deliveryChangeSetId: delivery.deliveryChangeSetId!,
      requestDigest: `sha256:${'a'.repeat(64)}` as never,
      targetFingerprintBefore: `sha256:${'b'.repeat(64)}` as never,
      state: 'FAILED' as const,
      receiptDigest: `sha256:${'c'.repeat(64)}` as never,
      safeCode: 'TARGET_WRITE_FAILED' as const,
      changedRelativePaths: [] as readonly string[],
      startedAt: '2026-08-18T00:00:00.000Z' as never,
      finishedAt: '2026-08-18T00:00:01.000Z' as never,
    }
    observeMock.mockResolvedValue({ ok: true, value: executableProjection() })
    retryDeliveryMock.mockResolvedValue({ ok: true, value: { ...delivery, state: 'APPROVED' } })
    useCollaborationHubStore.getState().setAddress(addressA)
    await useCollaborationHubStore.getState().refresh()
    useCollaborationHubStore.setState({
      projection: {
        ...useCollaborationHubStore.getState().projection!,
        activeDelivery: { ...delivery, state: 'APPROVED', applyAttempt: failedApplyAttempt },
        availableActions: ['flow.cancel', 'apply.retry.request'],
      },
    })

    await useCollaborationHubStore.getState().retryActiveDelivery()

    expect(retryDeliveryMock).toHaveBeenCalledTimes(1)
    expect(retryDeliveryMock.mock.calls[0]![1]).toEqual({
      requestId: 'test-req-1',
      batchId: delivery.batchId,
      failedApplyAttemptId: 'xhbdapp_failed',
    })

    const blockedPatches = [
      { state: 'OUTCOME_UNKNOWN' as const, safeCode: 'TARGET_WRITE_FAILED' as const },
      { state: 'SUCCEEDED' as const, safeCode: 'TARGET_WRITE_FAILED' as const },
      { state: 'FAILED' as const, safeCode: 'TARGET_BASELINE_DRIFT' as const },
      { state: 'FAILED' as const, safeCode: 'TARGET_STATUS_DIRTY' as const },
      { state: 'FAILED' as const, safeCode: 'TARGET_FILE_DRIFT' as const },
    ]
    for (const patch of blockedPatches) {
      retryDeliveryMock.mockClear()
      useCollaborationHubStore.setState({
        projection: {
          ...useCollaborationHubStore.getState().projection!,
          activeDelivery: { ...delivery, state: 'APPROVED', applyAttempt: { ...failedApplyAttempt, ...patch } },
          availableActions: ['apply.retry.request'],
        },
      })
      await useCollaborationHubStore.getState().retryActiveDelivery()
      expect(retryDeliveryMock).not.toHaveBeenCalled()
    }

    retryDeliveryMock.mockClear()
    useCollaborationHubStore.setState({
      projection: {
        ...useCollaborationHubStore.getState().projection!,
        activeDelivery: { ...delivery, state: 'APPROVED', applyAttempt: failedApplyAttempt },
        availableActions: [],
      },
    })
    await useCollaborationHubStore.getState().retryActiveDelivery()
    expect(retryDeliveryMock).not.toHaveBeenCalled()

    retryDeliveryMock.mockClear()
    useCollaborationHubStore.setState({
      projection: {
        ...useCollaborationHubStore.getState().projection!,
        activeDelivery: { ...delivery, state: 'APPROVED', applyAttempt: undefined },
        availableActions: ['apply.retry.request'],
      },
    })
    await useCollaborationHubStore.getState().retryActiveDelivery()
    expect(retryDeliveryMock).not.toHaveBeenCalled()
  })
})
