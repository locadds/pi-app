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
import type { DeliveryBatchProjectionV1 } from '@shared/xiaogui-delivery'
import type { XiaoguiTaskExecutionStartBatchRequestV1 } from '@shared/xiaogui-task-execution'
import type { TaskVerificationSummaryV1 } from '@shared/xiaogui-task-verification'

const invokeMock = vi.fn()
vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: {
    invoke: (method: string, req?: unknown) => invokeMock(method, req),
  },
}))

import {
  HUB_CONTRACT_VERSION,
  HUB_OBSERVE_CONTRACT_VERSION,
  DELIVERY_CONTRACT_VERSION,
  approveDeliveryGate,
  newHubRequestId,
  observeCollaborationHub,
  prepareDeliveryRecovery,
  performHubIntent,
  startTaskExecution,
  startTaskExecutionBatch,
  submitDeliverySelection,
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

function deliveryFixture(): DeliveryBatchProjectionV1 {
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

function verifiedSummaryFixture(): TaskVerificationSummaryV1 {
  return {
    scope: 'TASK',
    verificationAttemptId: 'xhbva_1' as TaskVerificationSummaryV1['verificationAttemptId'],
    candidateId: 'xhbcandidate_1' as TaskVerificationSummaryV1['candidateId'],
    changeSetDigest: `sha256:${'1'.repeat(64)}` as TaskVerificationSummaryV1['changeSetDigest'],
    qaConfigVersion: 'task-fixed-typecheck.v1',
    diagnosticArtifacts: [
      {
        artifactId: 'xhbartifact_diag_1' as TaskVerificationSummaryV1['diagnosticArtifacts'][number]['artifactId'],
        digest: `sha256:${'2'.repeat(64)}` as TaskVerificationSummaryV1['diagnosticArtifacts'][number]['digest'],
        kind: 'QA_DIAGNOSTIC',
      },
    ],
    state: 'SUCCEEDED',
    verdict: 'PASS',
    checks: [
      { checkId: 'typescript.web', verdict: 'PASS', summary: '界面类型检查通过' },
      { checkId: 'typescript.node', verdict: 'PASS', summary: '主进程类型检查通过' },
    ],
    evidenceBundleId: 'xhbevidence_1' as Extract<TaskVerificationSummaryV1, { state: 'SUCCEEDED' }>['evidenceBundleId'],
    qaResultId: 'xhbqa_1' as Extract<TaskVerificationSummaryV1, { state: 'SUCCEEDED' }>['qaResultId'],
    taskChangeSetId: 'xhbtcs_1' as Extract<TaskVerificationSummaryV1, { state: 'SUCCEEDED' }>['taskChangeSetId'],
    evidenceArtifacts: [
      {
        artifactId: 'xhbartifact_evidence_1' as TaskVerificationSummaryV1['diagnosticArtifacts'][number]['artifactId'],
        digest: `sha256:${'3'.repeat(64)}` as TaskVerificationSummaryV1['diagnosticArtifacts'][number]['digest'],
        kind: 'QA_EVIDENCE',
      },
    ],
  }
}

function batchExecutionResultValue(n: number) {
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

function batchRequestFixture(): XiaoguiTaskExecutionStartBatchRequestV1 {
  return {
    contractVersion: 'xiaogui.task-execution.batch.v1',
    address,
    flowId: 'xhbf_flow1' as FlowId,
    items: [
      { taskRunId: 'xhbtr_1' as TaskRunId, prompt: '任务一', files: [{ operation: 'MODIFY', relativePath: 'src/a.ts' }] },
      { taskRunId: 'xhbtr_2' as TaskRunId, prompt: '任务二', files: [{ operation: 'CREATE', relativePath: 'src/new.ts' }] },
    ],
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
      availableActions: ['flow.cancel', 'execution.next.confirm'],
    }
    invokeMock.mockResolvedValueOnce({ ok: true, value: valid })

    const res = await observeCollaborationHub(address)

    expect(res).toEqual({ ok: true, value: valid })
  })

  it('observe 接受严格脱敏的任务验证摘要', async () => {
    const valid: SessionCollaborationProjectionM2BV1 = {
      ...projectionFixture(),
      sessionMode: 'CODING',
      authoritativeMode: 'CODING',
      taskRuns: [
        {
          taskRunId: 'xhbtr_verified' as TaskRunId,
          taskSpecId: 'xhbts_verified' as TaskSpecId,
          taskKey: 'verified',
          status: 'VERIFIED',
          attemptId: 'xhba_verified' as AttemptId,
        },
      ],
      attempts: [
        {
          attemptId: 'xhba_verified' as AttemptId,
          taskRunId: 'xhbtr_verified' as TaskRunId,
          status: 'SUCCEEDED',
          verificationSummary: verifiedSummaryFixture(),
        },
      ],
    }
    invokeMock.mockResolvedValueOnce({ ok: true, value: valid })

    await expect(observeCollaborationHub(address)).resolves.toEqual({ ok: true, value: valid })
  })

  it('observe 接受 activeDelivery 公开摘要和交付动作，但拒绝绝对路径', async () => {
    const valid = {
      ...projectionFixture(),
      activeDelivery: deliveryFixture(),
      availableActions: ['flow.cancel', 'delivery.gate.approve', 'delivery.gate.reject'],
    }
    invokeMock.mockResolvedValueOnce({ ok: true, value: valid })
    await expect(observeCollaborationHub(address)).resolves.toEqual({ ok: true, value: valid })

    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        ...valid,
        activeDelivery: {
          ...deliveryFixture(),
          fileChangeSummaries: [{ ...deliveryFixture().fileChangeSummaries![0], relativePath: 'C:\\secret.ts' }],
        },
      },
    })
    await expect(observeCollaborationHub(address)).resolves.toEqual({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.error.ipc', traceId: '' },
    })
  })

  it('observe 接受恢复交付投影与 SUPERSEDED，但拒绝未知 apply safeCode', async () => {
    const recoveredDelivery: DeliveryBatchProjectionV1 = {
      ...deliveryFixture(),
      state: 'SUPERSEDED',
      recoverySourceBatchId: 'xhbd_source' as DeliveryBatchProjectionV1['recoverySourceBatchId'],
      recoveryLineage: {
        sourceBatchId: 'xhbd_source' as never,
        sourceDeliveryChangeSetId: 'xhbdcs_source' as never,
        sourceDeliveryChangeSetDigest: `sha256:${'7'.repeat(64)}` as never,
        sourceTargetFingerprint: `sha256:${'8'.repeat(64)}` as never,
        currentTargetFingerprint: `sha256:${'9'.repeat(64)}` as never,
      },
      applyAttempt: {
        applyAttemptId: 'xhbdapp_failed' as never,
        batchId: 'xhbd_batch1' as never,
        deliveryChangeSetId: 'xhbdcs_delivery' as never,
        requestDigest: `sha256:${'a'.repeat(64)}` as never,
        targetFingerprintBefore: `sha256:${'b'.repeat(64)}` as never,
        state: 'FAILED_ROLLED_BACK',
        receiptDigest: `sha256:${'c'.repeat(64)}` as never,
        safeCode: 'TARGET_BASELINE_DRIFT',
        changedRelativePaths: [],
        startedAt: '2026-08-18T00:00:00.000Z' as never,
        finishedAt: '2026-08-18T00:00:01.000Z' as never,
      },
    }
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        ...projectionFixture(),
        activeDelivery: recoveredDelivery,
        availableActions: ['apply.recovery.prepare'],
      },
    })
    await expect(observeCollaborationHub(address)).resolves.toMatchObject({ ok: true })

    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        ...projectionFixture(),
        activeDelivery: {
          ...recoveredDelivery,
          applyAttempt: { ...recoveredDelivery.applyAttempt!, safeCode: 'SECRET_DRIFT' },
        },
      },
    })
    await expect(observeCollaborationHub(address)).resolves.toEqual({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.error.ipc', traceId: '' },
    })
  })

  it.each([
    ['摘要未知字段', (summary: TaskVerificationSummaryV1) => ({ ...summary, prompt: '不得公开的指令' })],
    [
      '工件敏感路径',
      (summary: TaskVerificationSummaryV1) => ({
        ...summary,
        diagnosticArtifacts: [{ ...summary.diagnosticArtifacts[0], path: 'C:\\private\\result.log' }],
      }),
    ],
    [
      '检查原始输出',
      (summary: TaskVerificationSummaryV1) => ({
        ...summary,
        checks: [{ checkId: 'typescript.web', verdict: 'PASS', summary: '通过', stdout: 'raw output' }],
      }),
    ],
    ['Attempt 敏感验证载荷', (summary: TaskVerificationSummaryV1) => summary],
  ])('敏感或未知验证字段被映射为安全 INTERNAL：%s', async (label, mutate) => {
    const attempt: Record<string, unknown> = {
      attemptId: 'xhba_verified',
      taskRunId: 'xhbtr_verified',
      status: 'SUCCEEDED',
      verificationSummary: mutate(verifiedSummaryFixture()),
      ...(label === 'Attempt 敏感验证载荷' ? { verificationPayload: { content: 'secret' } } : {}),
    }
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        ...projectionFixture(),
        taskRuns: [
          {
            taskRunId: 'xhbtr_verified',
            taskSpecId: 'xhbts_verified',
            taskKey: 'verified',
            status: 'VERIFIED',
            attemptId: 'xhba_verified',
          },
        ],
        attempts: [attempt],
      },
    })

    await expect(observeCollaborationHub(address)).resolves.toEqual({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.error.ipc', traceId: '' },
    })
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

  it.each(['system.verification.complete', 'system.verification.reconcile'] as const)(
    '验证写入名称 %s 仍按 M2A 禁用意图返回 INTENT_DISABLED',
    async (intentType) => {
      const traceId = 'xhbt_00000000-0000-4000-8000-000000000000'
      invokeMock.mockResolvedValueOnce({
        ok: false,
        error: { code: 'INTENT_DISABLED', messageKey: 'xiaogui.hub.intent_disabled', traceId },
      })

      const res = await performHubIntent(address, {
        requestId: `r-${intentType}`,
        intent: { type: intentType },
      })

      expect(res).toEqual({
        ok: false,
        error: { code: 'INTENT_DISABLED', messageKey: 'xiaogui.hub.intent_disabled', traceId },
      })
    },
  )

  it.each(['system.verification.complete', 'system.verification.reconcile'] as const)(
    '拒绝把未实现验证写入 %s 伪装成成功的 perform receipt',
    async (intentType) => {
      invokeMock.mockResolvedValueOnce({
        ok: true,
        value: { requestId: `r-${intentType}`, intentType, sessionVersion: 1 },
      })

      const res = await performHubIntent(address, {
        requestId: `r-${intentType}`,
        intent: { type: intentType },
      })

      expect(res).toEqual({
        ok: false,
        error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.error.ipc', traceId: '' },
      })
    },
  )

  it('最终执行只调用窄通道，载荷只含 address、flowId、prompt、files', async () => {
    const request = {
      address,
      flowId: 'xhbf_flow1' as FlowId,
      prompt: '完成当前任务',
      files: [
        { operation: 'MODIFY' as const, relativePath: 'src/a.ts' },
        { operation: 'CREATE' as const, relativePath: 'src/new.ts' },
      ],
    }
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        taskRun: {
          taskRunId: 'xhbtr_1' as TaskRunId,
          taskSpecId: 'xhbts_1' as TaskSpecId,
          taskKey: 't1',
          status: 'RUNNING',
          attemptId: 'xhba_1' as AttemptId,
        },
        attempt: {
          attemptId: 'xhba_1' as AttemptId,
          taskRunId: 'xhbtr_1' as TaskRunId,
          status: 'RUNNING',
        },
      },
    })

    const result = await startTaskExecution(request)

    expect(result.ok).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.hub.execution.start', request)
    expect(Object.keys(invokeMock.mock.calls[0]![1]).sort()).toEqual(['address', 'files', 'flowId', 'prompt'])
    expect(JSON.stringify(invokeMock.mock.calls[0]![1])).not.toMatch(/requestId|version|actor|adapter|digest|absolute/i)
  })

  it('交付批准只调用 M4D 窄通道，载荷不含 actor、bytes 或命令', async () => {
    const delivery = deliveryFixture()
    invokeMock.mockResolvedValueOnce({ ok: true, value: delivery })

    const result = await approveDeliveryGate(address, {
      requestId: 'req-delivery-approve',
      gateId: delivery.gate!.gateId,
      subject: delivery.gate!.subject,
    })

    expect(result).toEqual({ ok: true, value: delivery })
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.delivery.gate.approve', {
      contractVersion: DELIVERY_CONTRACT_VERSION,
      address,
      request: {
        requestId: 'req-delivery-approve',
        gateId: delivery.gate!.gateId,
        subject: delivery.gate!.subject,
      },
    })
    expect(JSON.stringify(invokeMock.mock.calls[0]![1])).not.toMatch(/actor|trusted|artifactBytes|command|absolute/i)
  })

  it('交付选择只调用 M4D selection 窄通道', async () => {
    const delivery = deliveryFixture()
    invokeMock.mockResolvedValueOnce({ ok: true, value: delivery })

    const result = await submitDeliverySelection(address, {
      requestId: 'req-delivery-selection',
      flowId: 'xhbf_flow1' as FlowId,
      taskRunIds: ['xhbtr_delivery'] as never,
    })

    expect(result).toEqual({ ok: true, value: delivery })
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.delivery.selection.submit', {
      contractVersion: DELIVERY_CONTRACT_VERSION,
      address,
      request: {
        requestId: 'req-delivery-selection',
        flowId: 'xhbf_flow1',
        taskRunIds: ['xhbtr_delivery'],
      },
    })
  })

  it('基准恢复只调用 M4F 窄通道，载荷不含路径、字节或命令', async () => {
    const delivery = deliveryFixture()
    invokeMock.mockResolvedValueOnce({ ok: true, value: delivery })

    const result = await prepareDeliveryRecovery(address, {
      requestId: 'req-recovery',
      batchId: delivery.batchId,
      failedApplyAttemptId: 'xhbdapp_failed' as never,
    })

    expect(result).toEqual({ ok: true, value: delivery })
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.delivery.apply.recovery.prepare', {
      contractVersion: DELIVERY_CONTRACT_VERSION,
      address,
      request: {
        requestId: 'req-recovery',
        batchId: delivery.batchId,
        failedApplyAttemptId: 'xhbdapp_failed',
      },
    })
    expect(Object.keys((invokeMock.mock.calls[0]![1] as { request: Record<string, unknown> }).request).sort()).toEqual([
      'batchId',
      'failedApplyAttemptId',
      'requestId',
    ])
    expect(JSON.stringify(invokeMock.mock.calls[0]![1])).not.toMatch(/path|bytes|content|command|trusted|absolute/i)
  })

  it('最终执行拒绝关系不一致的结果并映射为安全 INTERNAL', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        taskRun: {
          taskRunId: 'xhbtr_1',
          taskSpecId: 'xhbts_1',
          taskKey: 't1',
          status: 'RUNNING',
          attemptId: 'xhba_1',
        },
        attempt: { attemptId: 'xhba_other', taskRunId: 'xhbtr_1', status: 'RUNNING' },
      },
    })

    await expect(
      startTaskExecution({
        address,
        flowId: 'xhbf_flow1' as FlowId,
        prompt: 'x',
        files: [{ operation: 'MODIFY', relativePath: 'src/a.ts' }],
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.execution.error.ipc', traceId: '' },
    })
  })

  it('最终执行仅接受约定的安全错误', async () => {
    const executionTraceId = 'xhbet_00000000-0000-4000-8000-000000000000'
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN', messageKey: 'xiaogui.execution.outcome_unknown', traceId: executionTraceId },
    })
    const request = {
      address,
      flowId: 'xhbf_flow1' as FlowId,
      prompt: 'x',
      files: [{ operation: 'CREATE' as const, relativePath: 'src/new.ts' }],
    }

    await expect(startTaskExecution(request)).resolves.toEqual({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN', messageKey: 'xiaogui.execution.outcome_unknown', traceId: executionTraceId },
    })

    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'SECRET_PATH', messageKey: 'x', traceId: 'C:\\secret' },
    })
    await expect(startTaskExecution(request)).resolves.toEqual({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.execution.error.ipc', traceId: '' },
    })
  })

  it('批量执行只调用窄通道，载荷含契约版本与逐项明确 taskRunId，逐项结果原样保留', async () => {
    const request = batchRequestFixture()
    const value = {
      contractVersion: 'xiaogui.task-execution.batch.v1',
      items: [
        { ok: true, taskRunId: 'xhbtr_1', value: batchExecutionResultValue(1) },
        {
          ok: false,
          taskRunId: 'xhbtr_2',
          error: { code: 'EXECUTION_IN_PROGRESS', messageKey: 'xiaogui.execution.in_progress', traceId: '' },
        },
      ],
    }
    invokeMock.mockResolvedValueOnce({ ok: true, value })

    const result = await startTaskExecutionBatch(request)

    expect(result).toEqual({ ok: true, value })
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.hub.execution.startBatch', request)
    const payload = invokeMock.mock.calls[0]![1] as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['address', 'contractVersion', 'flowId', 'items'])
    expect(JSON.stringify(payload)).not.toMatch(/requestId|actor|adapter|runtimeSession|absolute/i)
  })

  it.each([
    [
      '逐项顺序与请求不一致',
      (value: { items: unknown[] }) => ({ ...value, items: [...value.items].reverse() }),
    ],
    [
      '契约版本不符',
      (value: { items: unknown[] }) => ({ ...value, contractVersion: 'xiaogui.task-execution.batch.v0' }),
    ],
    [
      '结果 taskRun 与 item 绑定不符',
      (value: { items: { ok: true; taskRunId: string; value: unknown }[] }) => ({
        ...value,
        items: [{ ...value.items[0]!, value: batchExecutionResultValue(9) }, value.items[1]!],
      }),
    ],
    [
      '成功项携带额外字段',
      (value: { items: unknown[] }) => ({
        ...value,
        items: [{ ...(value.items[0] as Record<string, unknown>), runtimeSessionId: 'rs-secret' }, value.items[1]!],
      }),
    ],
    [
      '成功载荷携带额外字段',
      (value: { items: { ok: true; taskRunId: string; value: Record<string, unknown> }[] }) => ({
        ...value,
        items: [{ ...value.items[0]!, value: { ...value.items[0]!.value, command: 'rm -rf /' } }, value.items[1]!],
      }),
    ],
    [
      '成功载荷 taskRun 携带绝对路径等额外字段',
      (value: { items: { ok: true; taskRunId: string; value: { taskRun: Record<string, unknown> } }[] }) => ({
        ...value,
        items: [
          {
            ...value.items[0]!,
            value: {
              ...value.items[0]!.value,
              taskRun: { ...value.items[0]!.value.taskRun, absolutePath: 'C:\\private\\a.ts' },
            },
          },
          value.items[1]!,
        ],
      }),
    ],
    [
      '失败项 error 携带额外字段',
      (value: { items: unknown[] }) => ({
        ...value,
        items: [
          value.items[0]!,
          {
            ...(value.items[1] as Record<string, unknown>),
            error: {
              code: 'EXECUTION_IN_PROGRESS',
              messageKey: 'xiaogui.execution.in_progress',
              traceId: '',
              command: 'rm -rf /',
            },
          },
        ],
      }),
    ],
    [
      '失败项携带额外字段',
      (value: { items: unknown[] }) => ({
        ...value,
        items: [value.items[0]!, { ...(value.items[1] as Record<string, unknown>), command: 'rm -rf /' }],
      }),
    ],
    [
      '批量结果携带额外字段',
      (value: { items: unknown[] }) => ({ ...value, runtime: { session: 'secret' } }),
    ],
    [
      '成功项携带私有运行时字段',
      (value: { items: { ok: true; taskRunId: string; value: { attempt: Record<string, unknown> } }[] }) => ({
        ...value,
        items: [
          {
            ...value.items[0]!,
            value: {
              ...value.items[0]!.value,
              attempt: { ...value.items[0]!.value.attempt, command: 'rm -rf /', runtimeBinding: { secret: true } },
            },
          },
          value.items[1]!,
        ],
      }),
    ],
  ])('批量结果%s时映射为安全 INTERNAL', (_label, mutate) => {
    const value = {
      contractVersion: 'xiaogui.task-execution.batch.v1',
      items: [
        { ok: true, taskRunId: 'xhbtr_1', value: batchExecutionResultValue(1) },
        {
          ok: false,
          taskRunId: 'xhbtr_2',
          error: { code: 'EXECUTION_IN_PROGRESS', messageKey: 'xiaogui.execution.in_progress', traceId: '' },
        },
      ],
    }
    invokeMock.mockResolvedValueOnce({ ok: true, value: mutate(value as never) })

    return expect(startTaskExecutionBatch(batchRequestFixture())).resolves.toEqual({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.execution.error.ipc', traceId: '' },
    })
  })

  it.each([
    [
      '顶层失败 error 携带额外字段',
      { ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: '', absolutePath: 'C:\\secret' } },
    ],
    [
      '顶层响应携带额外字段',
      { ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: '' }, session: 'private' },
    ],
    [
      '顶层成功响应携带额外字段',
      {
        ok: true,
        value: {
          contractVersion: 'xiaogui.task-execution.batch.v1',
          items: [{ ok: true, taskRunId: 'xhbtr_1', value: batchExecutionResultValue(1) }],
        },
        runtime: 'secret',
      },
    ],
  ])('批量顶层%s时映射为安全 INTERNAL', async (_label, res) => {
    invokeMock.mockResolvedValueOnce(res)

    const request = batchRequestFixture()
    await expect(startTaskExecutionBatch({ ...request, items: [request.items[0]!] })).resolves.toEqual({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.execution.error.ipc', traceId: '' },
    })
  })

  it('批量 IPC 抛异常时映射为安全 INTERNAL 且不泄露异常内容', async () => {
    invokeMock.mockRejectedValueOnce(new Error('secret path C:\\Users\\x\\secret'))

    const request = batchRequestFixture()
    const res = await startTaskExecutionBatch({ ...request, items: [request.items[0]!] })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('INTERNAL')
      expect(JSON.stringify(res.error)).not.toContain('secret')
      expect(JSON.stringify(res.error)).not.toContain('C:\\')
    }
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
