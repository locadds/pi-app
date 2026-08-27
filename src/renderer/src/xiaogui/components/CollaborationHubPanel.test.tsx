import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AttemptId,
  AttemptRuntimeBindingV1,
  ExecutionReadinessSnapshotV1,
  ExecutionWaveId,
  ExecutionWaveV1,
  FlowId,
  HubAddressV1,
  PlanRevisionId,
  SessionCollaborationProjectionM2BV1,
  TaskDependencyStateV1,
  TaskRunId,
  TaskSpecId,
} from '@shared/xiaogui-collaboration-hub'
import type { AppEvent } from '@shared/app-events'
import type { DeliveryBatchProjectionV1 } from '@shared/xiaogui-delivery'
import type { CanonicalSessionAddressScopeV1 } from '@shared/xiaogui-session-scope'
import type { TaskVerificationSummaryV1 } from '@shared/xiaogui-task-verification'

import { useUIStore } from '@renderer/stores/ui-store'
import type { SessionItem } from '@renderer/stores/ui-store-types'

const observeMock = vi.fn()
const performMock = vi.fn()
const executeMock = vi.fn()
const submitDeliveryMock = vi.fn()
const approveDeliveryMock = vi.fn()
const returnDeliveryMock = vi.fn()
const reconcileDeliveryMock = vi.fn()
const retryDeliveryMock = vi.fn()
const prepareRecoveryMock = vi.fn()
let requestCounter = 0
let appEventHandler: ((event: AppEvent) => void) | null = null
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
  prepareDeliveryRecovery: (address: HubAddressV1, request: unknown) => prepareRecoveryMock(address, request),
  newHubRequestId: () => `test-req-${++requestCounter}`,
}))

import { useCollaborationHubStore } from '../stores/collaboration-hub-store'
import { CollaborationHubPanel } from './CollaborationHubPanel'

function scopeOf(sessionKeyHex: string, mode: 'WORK' | 'DESIGN' | 'CODING'): CanonicalSessionAddressScopeV1 {
  return {
    projectId: `xgp1_${'a'.repeat(64)}` as CanonicalSessionAddressScopeV1['projectId'],
    sessionKey: `xgs1_${sessionKeyHex.repeat(64)}` as CanonicalSessionAddressScopeV1['sessionKey'],
    sessionMode: mode,
  }
}

const scopeWork = scopeOf('1', 'WORK')
const scopeCoding = scopeOf('2', 'CODING')
const scopeDesign = scopeOf('3', 'DESIGN')

function sessionWith(id: string, scope?: CanonicalSessionAddressScopeV1): SessionItem {
  return {
    sessionId: id,
    title: id,
    updatedAt: 0,
    modelId: 'm',
    ...(scope ? { canonicalScope: scope } : {}),
  }
}

function baseProjection(
  address: HubAddressV1,
  patch: Partial<SessionCollaborationProjectionM2BV1> = {},
): SessionCollaborationProjectionM2BV1 {
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
    ...patch,
  }
}

function reservedProjection(address: HubAddressV1): SessionCollaborationProjectionM2BV1 {
  return baseProjection(address, {
    sessionMode: 'DESIGN',
    authoritativeMode: 'DESIGN',
    reserved: {
      code: 'DESIGN_RESERVED',
      messageKey: 'xiaogui.hub.design_reserved',
    },
    availableActions: [],
  })
}

function awaitingProjection(address: HubAddressV1): SessionCollaborationProjectionM2BV1 {
  const flowId = 'xhbf_flow1' as FlowId
  const revisionId = 'xhbr_rev1' as PlanRevisionId
  return baseProjection(address, {
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

function activeProjection(address: HubAddressV1): SessionCollaborationProjectionM2BV1 {
  const flowId = 'xhbf_flow1' as FlowId
  const revisionId = 'xhbr_rev1' as PlanRevisionId
  return baseProjection(address, {
    sessionMode: 'CODING',
    authoritativeMode: 'CODING',
    sessionVersion: 5,
    activeFlow: {
      flowId,
      status: 'PLAN_ACTIVE',
      activeRevisionId: revisionId,
      objective: '目标X',
    },
    activeRevision: {
      revisionId,
      status: 'ACTIVE',
      digest: 'digest-1',
      draft: {
        objective: '目标X',
        tasks: [
          { taskKey: 't1', title: '投影任务一' },
          { taskKey: 't2', title: '投影任务二', dependsOn: ['t1'] },
        ],
      },
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
        dependsOn: ['t1'],
        unavailableReason: 'AGENT_DISABLED_M2A',
      },
    ],
    taskRuns: [
      {
        taskRunId: 'xhbtr_1' as TaskRunId,
        taskSpecId: 'xhbts_1' as TaskSpecId,
        taskKey: 't1',
        status: 'RUNNING',
        attemptId: 'xhba_1' as AttemptId,
      },
      {
        taskRunId: 'xhbtr_2' as TaskRunId,
        taskSpecId: 'xhbts_2' as TaskSpecId,
        taskKey: 't2',
        status: 'BLOCKED',
      },
    ],
    attempts: [
      { attemptId: 'xhba_0' as AttemptId, taskRunId: 'xhbtr_1' as TaskRunId, status: 'FAILED' },
      { attemptId: 'xhba_1' as AttemptId, taskRunId: 'xhbtr_1' as TaskRunId, status: 'RUNNING', runtimeSessionId: 'rs-1' },
    ],
    availableActions: ['flow.cancel'],
  })
}

function executableProjection(address: HubAddressV1): SessionCollaborationProjectionM2BV1 {
  return {
    ...activeProjection(address),
    taskRuns: [],
    attempts: [],
    availableActions: ['flow.cancel', 'execution.next.confirm'],
  }
}

function runtimeBindingFixture(attemptId: AttemptId, taskRunId: TaskRunId): AttemptRuntimeBindingV1 {
  return {
    version: 1,
    attemptId,
    taskRunId,
    executionInputDigest: `sha256:${'e'.repeat(64)}` as AttemptRuntimeBindingV1['executionInputDigest'],
    authorizationScopeDigest: `sha256:${'f'.repeat(64)}` as AttemptRuntimeBindingV1['authorizationScopeDigest'],
    selection: {
      adapterId: 'codex-cli-internal-adapter',
      runtimeKind: 'CODEX',
      protocol: 'HEADLESS',
      capabilityDigest: `sha256:${'7'.repeat(64)}`,
      approvalStatus: 'APPROVED_FOR_PRODUCTION',
      diagnosticOnly: false,
      stream: 'PUSH',
      interrupt: 'ACKED',
      inspect: 'RECONCILE',
    },
    selectionDigest: `sha256:${'8'.repeat(64)}` as AttemptRuntimeBindingV1['selectionDigest'],
    bindingDigest: `sha256:${'9'.repeat(64)}` as AttemptRuntimeBindingV1['bindingDigest'],
    boundAt: '2026-08-18T00:00:00.000Z',
  }
}

/**
 * 满槽分组场景（生产可达）：t1 执行中（IN_FLIGHT，attempt 含 runtimeBinding）、
 * t5 验证中（IN_FLIGHT + attempt VERIFYING）、t6 父任务失败（TERMINAL）、
 * t2 等待 t1、t3 因 t6 失败被阻断、t4 未派发根任务（raw TaskRun=BLOCKED，readiness=READY）。
 * activeAttemptCount=2 占满并行上限 → availableSlots=0，主进程不会授予 execution.next.confirm。
 */
function groupedWaveProjection(address: HubAddressV1): SessionCollaborationProjectionM2BV1 {
  const base = activeProjection(address)
  const spec = (n: number, dependsOn: string[] = []) => ({
    taskSpecId: `xhbts_${n}` as TaskSpecId,
    taskKey: `t${n}`,
    title: `投影任务${['一', '二', '三', '四', '五', '六'][n - 1]}`,
    dependsOn,
    unavailableReason: 'AGENT_DISABLED_M2A' as const,
  })
  const run = (n: number, status: SessionCollaborationProjectionM2BV1['taskRuns'][number]['status']) => ({
    taskRunId: `xhbtr_${n}` as TaskRunId,
    taskSpecId: `xhbts_${n}` as TaskSpecId,
    taskKey: `t${n}`,
    status,
  })
  const depState = (
    n: number,
    state: TaskDependencyStateV1['state'],
    blocking: number[] = [],
  ): TaskDependencyStateV1 => ({
    version: 1,
    taskRunId: `xhbtr_${n}` as TaskRunId,
    state,
    dependencyTaskRunIds: blocking.map((m) => `xhbtr_${m}` as TaskRunId),
    blockingTaskRunIds: blocking.map((m) => `xhbtr_${m}` as TaskRunId),
    verifiedAncestorTaskChangeSetIds: [],
  })
  const executionReadiness: ExecutionReadinessSnapshotV1 = {
    version: 1,
    flowId: 'xhbf_flow1' as FlowId,
    maxParallelism: 2,
    activeAttemptCount: 2,
    availableSlots: 0,
    dependencyStates: [
      depState(1, 'IN_FLIGHT'),
      depState(2, 'WAITING_FOR_DEPENDENCIES', [1]),
      depState(3, 'BLOCKED_BY_FAILED_DEPENDENCY', [6]),
      depState(4, 'READY'),
      depState(5, 'IN_FLIGHT'),
      depState(6, 'TERMINAL'),
    ],
    readyTaskRunIds: ['xhbtr_4' as TaskRunId],
    capturedAt: '2026-08-18T00:00:01.000Z',
  }
  // lastExecutionWave 仅作历史证据：t1 是批前既有 active，t5 是本批新调度，两集合不相交
  const lastExecutionWave: ExecutionWaveV1 = {
    version: 1,
    waveId: 'xhbev_wave1' as ExecutionWaveId,
    flowId: 'xhbf_flow1' as FlowId,
    maxParallelism: 2,
    activeAttemptIds: ['xhba_1' as AttemptId],
    scheduled: [{ taskRunId: 'xhbtr_5' as TaskRunId, attemptId: 'xhba_5' as AttemptId }],
    dependencyStates: [],
    createdAt: '2026-08-18T00:00:00.000Z',
  }
  return {
    ...base,
    activeRevision: {
      ...base.activeRevision!,
      draft: {
        objective: '目标X',
        tasks: [
          { taskKey: 't1', title: '投影任务一' },
          { taskKey: 't2', title: '投影任务二', dependsOn: ['t1'] },
          { taskKey: 't3', title: '投影任务三', dependsOn: ['t6'] },
          { taskKey: 't4', title: '投影任务四' },
          { taskKey: 't5', title: '投影任务五' },
          { taskKey: 't6', title: '投影任务六' },
        ],
      },
    },
    taskSpecs: [spec(1), spec(2, ['t1']), spec(3, ['t6']), spec(4), spec(5), spec(6)],
    taskRuns: [
      { ...run(1, 'RUNNING'), attemptId: 'xhba_1' as AttemptId },
      run(2, 'BLOCKED'),
      run(3, 'BLOCKED'),
      // 真实 observeM2B：未派发根任务的 raw TaskRun 仍为 BLOCKED，readiness 才是 READY
      run(4, 'BLOCKED'),
      { ...run(5, 'VERIFYING'), attemptId: 'xhba_5' as AttemptId },
      { ...run(6, 'FAILED'), attemptId: 'xhba_6' as AttemptId },
    ],
    attempts: [
      {
        attemptId: 'xhba_1' as AttemptId,
        taskRunId: 'xhbtr_1' as TaskRunId,
        status: 'RUNNING',
        runtimeSessionId: 'runtime-secret-session',
        workspaceReceiptId: 'xhbwr_receipt-secret' as never,
        runtimeBinding: runtimeBindingFixture('xhba_1' as AttemptId, 'xhbtr_1' as TaskRunId),
      },
      { attemptId: 'xhba_5' as AttemptId, taskRunId: 'xhbtr_5' as TaskRunId, status: 'VERIFYING' },
      { attemptId: 'xhba_6' as AttemptId, taskRunId: 'xhbtr_6' as TaskRunId, status: 'FAILED' },
    ],
    executionReadiness,
    lastExecutionWave,
    availableActions: ['flow.cancel'],
  }
}

/**
 * 可确认场景（生产可达）：maxParallelism=2，仅 t1 IN_FLIGHT（activeAttemptCount=1），
 * availableSlots=1 且确有 READY 根任务 t4 → 主进程授予 execution.next.confirm。
 */
function confirmableProjection(address: HubAddressV1): SessionCollaborationProjectionM2BV1 {
  const base = activeProjection(address)
  const executionReadiness: ExecutionReadinessSnapshotV1 = {
    version: 1,
    flowId: 'xhbf_flow1' as FlowId,
    maxParallelism: 2,
    activeAttemptCount: 1,
    availableSlots: 1,
    dependencyStates: [
      {
        version: 1,
        taskRunId: 'xhbtr_1' as TaskRunId,
        state: 'IN_FLIGHT',
        dependencyTaskRunIds: [],
        blockingTaskRunIds: [],
        verifiedAncestorTaskChangeSetIds: [],
      },
      {
        version: 1,
        taskRunId: 'xhbtr_2' as TaskRunId,
        state: 'WAITING_FOR_DEPENDENCIES',
        dependencyTaskRunIds: ['xhbtr_1' as TaskRunId],
        blockingTaskRunIds: ['xhbtr_1' as TaskRunId],
        verifiedAncestorTaskChangeSetIds: [],
      },
      {
        version: 1,
        taskRunId: 'xhbtr_4' as TaskRunId,
        state: 'READY',
        dependencyTaskRunIds: [],
        blockingTaskRunIds: [],
        verifiedAncestorTaskChangeSetIds: [],
      },
    ],
    readyTaskRunIds: ['xhbtr_4' as TaskRunId],
    capturedAt: '2026-08-18T00:00:01.000Z',
  }
  // 首波新调度 t1：调度发生前 wave 内没有既有 active，两集合不相交；
  // activeAttemptCount=1 来自调度之后的实时 readiness
  const lastExecutionWave: ExecutionWaveV1 = {
    version: 1,
    waveId: 'xhbev_wave1' as ExecutionWaveId,
    flowId: 'xhbf_flow1' as FlowId,
    maxParallelism: 2,
    activeAttemptIds: [],
    scheduled: [{ taskRunId: 'xhbtr_1' as TaskRunId, attemptId: 'xhba_1' as AttemptId }],
    dependencyStates: [],
    createdAt: '2026-08-18T00:00:00.000Z',
  }
  return {
    ...base,
    activeRevision: {
      ...base.activeRevision!,
      draft: {
        objective: '目标X',
        tasks: [
          { taskKey: 't1', title: '投影任务一' },
          { taskKey: 't2', title: '投影任务二', dependsOn: ['t1'] },
          { taskKey: 't4', title: '投影任务四' },
        ],
      },
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
        dependsOn: ['t1'],
        unavailableReason: 'AGENT_DISABLED_M2A',
      },
      {
        taskSpecId: 'xhbts_4' as TaskSpecId,
        taskKey: 't4',
        title: '投影任务四',
        dependsOn: [],
        unavailableReason: 'AGENT_DISABLED_M2A',
      },
    ],
    taskRuns: [
      {
        taskRunId: 'xhbtr_1' as TaskRunId,
        taskSpecId: 'xhbts_1' as TaskSpecId,
        taskKey: 't1',
        status: 'RUNNING',
        attemptId: 'xhba_1' as AttemptId,
      },
      {
        taskRunId: 'xhbtr_2' as TaskRunId,
        taskSpecId: 'xhbts_2' as TaskSpecId,
        taskKey: 't2',
        status: 'BLOCKED',
      },
      // 未派发根任务：raw TaskRun=BLOCKED，readiness=READY
      {
        taskRunId: 'xhbtr_4' as TaskRunId,
        taskSpecId: 'xhbts_4' as TaskSpecId,
        taskKey: 't4',
        status: 'BLOCKED',
      },
    ],
    attempts: [{ attemptId: 'xhba_1' as AttemptId, taskRunId: 'xhbtr_1' as TaskRunId, status: 'RUNNING' }],
    executionReadiness,
    lastExecutionWave,
    availableActions: ['flow.cancel', 'execution.next.confirm'],
  }
}

function deliveryProjection(address: HubAddressV1): SessionCollaborationProjectionM2BV1 {
  const delivery: DeliveryBatchProjectionV1 = {
    batchId: 'xhbd_batch1' as DeliveryBatchProjectionV1['batchId'],
    flowId: 'xhbf_flow1' as FlowId,
    state: 'READY_FOR_REVIEW',
    selectionDigest: `sha256:${'1'.repeat(64)}` as DeliveryBatchProjectionV1['selectionDigest'],
    selectedTaskRunIds: ['xhbtr_delivery_a', 'xhbtr_delivery_b'] as unknown as DeliveryBatchProjectionV1['selectedTaskRunIds'],
    taskChangeSetIds: ['xhbtcs_delivery_a', 'xhbtcs_delivery_b'] as unknown as DeliveryBatchProjectionV1['taskChangeSetIds'],
    targetFingerprint: `sha256:${'2'.repeat(64)}` as DeliveryBatchProjectionV1['targetFingerprint'],
    deliveryChangeSetId: 'xhbdcs_delivery' as DeliveryBatchProjectionV1['deliveryChangeSetId'],
    deliveryChangeSetDigest: `sha256:${'3'.repeat(64)}` as DeliveryBatchProjectionV1['deliveryChangeSetDigest'],
    fileChangeSummaries: [
      {
        operation: 'MODIFY',
        relativePath: 'src/a.ts',
        baselineDigest: `sha256:${'4'.repeat(64)}` as never,
        contentDigest: `sha256:${'5'.repeat(64)}` as never,
        contentArtifactId: 'xhbartifact_hidden_bytes' as never,
        sourceTaskChangeSetIds: ['xhbtcs_delivery_a'] as never,
      },
      {
        operation: 'CREATE',
        relativePath: 'src/new.ts',
        baselineDigest: null,
        contentDigest: `sha256:${'6'.repeat(64)}` as never,
        contentArtifactId: 'xhbartifact_hidden_new_bytes' as never,
        sourceTaskChangeSetIds: ['xhbtcs_delivery_b'] as never,
      },
    ],
    evidenceArtifactIds: ['xhbartifact_evidence_a' as never, 'xhbartifact_evidence_b' as never],
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
  return {
    ...executableProjection(address),
    activeDelivery: delivery,
    availableActions: ['flow.cancel', 'delivery.gate.approve', 'delivery.gate.reject'],
  }
}

function verificationSummaryFixture(state: TaskVerificationSummaryV1['state']): TaskVerificationSummaryV1 {
  const base = {
    scope: 'TASK' as const,
    verificationAttemptId: 'xhbva_1' as TaskVerificationSummaryV1['verificationAttemptId'],
    candidateId: 'xhbcandidate_1' as TaskVerificationSummaryV1['candidateId'],
    changeSetDigest: `sha256:${'a'.repeat(64)}` as TaskVerificationSummaryV1['changeSetDigest'],
    qaConfigVersion: 'task-fixed-typecheck.v1',
    diagnosticArtifacts: [
      {
        artifactId: 'xhbartifact_diag_1' as TaskVerificationSummaryV1['diagnosticArtifacts'][number]['artifactId'],
        digest: `sha256:${'b'.repeat(64)}` as TaskVerificationSummaryV1['diagnosticArtifacts'][number]['digest'],
        kind: 'QA_DIAGNOSTIC' as const,
      },
    ],
  }
  if (state === 'STARTED') return { ...base, state }
  if (state === 'OUTCOME_UNKNOWN') return { ...base, state, verdict: 'OUTCOME_UNKNOWN' }
  const checks = [
    { checkId: 'typescript.web', verdict: 'PASS' as const, summary: '界面类型检查通过' },
    { checkId: 'typescript.node', verdict: state === 'FAILED' ? ('FAIL' as const) : ('PASS' as const), summary: '主进程类型检查完成' },
  ]
  if (state === 'FAILED') {
    return {
      ...base,
      state,
      verdict: 'FAIL',
      checks,
      failure: {
        source: 'QA_CHECKS_FAILED',
        failureClass: 'TEST_FAILURE',
        disposition: 'REQUIRE_HUMAN_GATE',
        retryOrdinal: 0,
        safeCode: 'QA_CHECK_FAILED',
      },
    }
  }
  return {
    ...base,
    state,
    verdict: 'PASS',
    checks,
    evidenceBundleId: 'xhbevidence_1' as Extract<TaskVerificationSummaryV1, { state: 'SUCCEEDED' }>['evidenceBundleId'],
    qaResultId: 'xhbqa_1' as Extract<TaskVerificationSummaryV1, { state: 'SUCCEEDED' }>['qaResultId'],
    taskChangeSetId: 'xhbtcs_1' as Extract<TaskVerificationSummaryV1, { state: 'SUCCEEDED' }>['taskChangeSetId'],
    evidenceArtifacts: [
      {
        artifactId: 'xhbartifact_evidence_1' as TaskVerificationSummaryV1['diagnosticArtifacts'][number]['artifactId'],
        digest: `sha256:${'c'.repeat(64)}` as TaskVerificationSummaryV1['diagnosticArtifacts'][number]['digest'],
        kind: 'QA_EVIDENCE',
      },
      {
        artifactId: 'xhbartifact_evidence_2' as TaskVerificationSummaryV1['diagnosticArtifacts'][number]['artifactId'],
        digest: `sha256:${'d'.repeat(64)}` as TaskVerificationSummaryV1['diagnosticArtifacts'][number]['digest'],
        kind: 'QA_EVIDENCE',
      },
    ],
  }
}

function projectionWithVerification(
  address: HubAddressV1,
  summary: TaskVerificationSummaryV1,
): SessionCollaborationProjectionM2BV1 {
  return {
    ...activeProjection(address),
    taskRuns: [
      {
        taskRunId: 'xhbtr_verified' as TaskRunId,
        taskSpecId: 'xhbts_1' as TaskSpecId,
        taskKey: 't1',
        status:
          summary.state === 'SUCCEEDED'
            ? 'VERIFIED'
            : summary.state === 'STARTED'
              ? 'VERIFYING'
              : summary.state === 'FAILED'
                ? 'FAILED'
                : 'OUTCOME_UNKNOWN',
        attemptId: 'xhba_verified' as AttemptId,
      },
    ],
    attempts: [
      {
        attemptId: 'xhba_verified' as AttemptId,
        taskRunId: 'xhbtr_verified' as TaskRunId,
        status:
          summary.state === 'SUCCEEDED'
            ? 'SUCCEEDED'
            : summary.state === 'STARTED'
              ? 'VERIFYING'
              : summary.state === 'FAILED'
                ? 'FAILED'
                : 'OUTCOME_UNKNOWN',
        verificationSummary: summary,
      },
    ],
    availableActions: ['flow.cancel'],
  }
}

let uiSnapshot: ReturnType<typeof useUIStore.getState>

beforeEach(() => {
  observeMock.mockReset()
  performMock.mockReset()
  executeMock.mockReset()
  submitDeliveryMock.mockReset()
  approveDeliveryMock.mockReset()
  returnDeliveryMock.mockReset()
  reconcileDeliveryMock.mockReset()
  retryDeliveryMock.mockReset()
  prepareRecoveryMock.mockReset()
  requestCounter = 0
  appEventHandler = null
  window.piDesktop = {
    onEvent: (handler) => {
      appEventHandler = handler
      return () => {
        if (appEventHandler === handler) appEventHandler = null
      }
    },
  } as Window['piDesktop']
  uiSnapshot = useUIStore.getState()
  useCollaborationHubStore.getState().setAddress(null)
})

afterEach(() => {
  cleanup()
  useUIStore.setState(uiSnapshot, true)
  useCollaborationHubStore.getState().setAddress(null)
  delete window.piDesktop
})

function showSession(session: SessionItem) {
  act(() =>
    useUIStore.setState({
      sessions: [session],
      currentSessionId: session.sessionId,
    }),
  )
}

describe('CollaborationHubPanel', () => {
  it('没有 canonical 会话时不调用 Hub IPC 并提示先进入会话', async () => {
    showSession(sessionWith('s-plain'))
    render(<CollaborationHubPanel />)
    expect(await screen.findByTestId('hub-no-session')).toHaveTextContent('请先在左侧打开或新建一个工作或编码会话')
    expect(observeMock).not.toHaveBeenCalled()
  })

  it('DESIGN reserved 不渲染任何 perform 按钮', async () => {
    observeMock.mockResolvedValue({
      ok: true,
      value: reservedProjection(scopeDesign),
    })
    showSession(sessionWith('s-design', scopeDesign))
    render(<CollaborationHubPanel />)
    expect(await screen.findByTestId('hub-design-reserved')).toHaveTextContent('当前是规划设计会话')
    expect(screen.getByTestId('hub-design-reserved')).not.toHaveTextContent('DESIGN_RESERVED')
    expect(screen.queryByRole('button', { name: '建立草稿' })).toBeNull()
    expect(screen.queryByRole('button', { name: '批准计划' })).toBeNull()
    expect(screen.queryByRole('button', { name: '取消协作计划' })).toBeNull()
    expect(performMock).not.toHaveBeenCalled()
  })

  it('availableActions 不含动作时对应按钮不渲染', async () => {
    const p = awaitingProjection(scopeWork)
    p.availableActions = [] // 主进程未授予任何动作
    observeMock.mockResolvedValue({ ok: true, value: p })
    showSession(sessionWith('s-work', scopeWork))
    render(<CollaborationHubPanel />)
    await screen.findByTestId('hub-awaiting-approval')
    expect(screen.queryByRole('button', { name: '批准计划' })).toBeNull()
    expect(screen.queryByRole('button', { name: '取消协作计划' })).toBeNull()
  })

  it('WORK 空状态只提示自然语言入口，不暴露手填任务标识和建稿按钮', async () => {
    observeMock.mockResolvedValue({ ok: true, value: baseProjection(scopeWork) })
    showSession(sessionWith('s-work', scopeWork))
    render(<CollaborationHubPanel />)

    expect(await screen.findByTestId('hub-natural-language-entry')).toHaveTextContent(
      '直接在对话里说出你要完成的事',
    )
    expect(screen.queryByLabelText('协作计划目标')).toBeNull()
    expect(screen.queryByRole('button', { name: '建立草稿' })).toBeNull()
    expect(performMock).not.toHaveBeenCalled()
  })

  it('同一会话成功创建草稿后自动刷新为待批准状态', async () => {
    const sessionFile = 'C:\\sessions\\work.jsonl'
    observeMock
      .mockResolvedValueOnce({ ok: true, value: baseProjection(scopeWork) })
      .mockResolvedValue({ ok: true, value: awaitingProjection(scopeWork) })
    showSession({ ...sessionWith('s-work', scopeWork), sessionFile })
    render(<CollaborationHubPanel />)

    await screen.findByTestId('hub-natural-language-entry')
    expect(appEventHandler).not.toBeNull()
    act(() => {
      appEventHandler?.({
        type: 'tool',
        seq: 1,
        workspaceId: 'workspace',
        sessionFile,
        timestamp: Date.now(),
        toolCallId: 'call-1',
        toolName: 'xiaogui_create_collaboration_plan',
        phase: 'end',
        details: { kind: 'XIAOGUI_COLLABORATION_DRAFT_CREATED' },
        isError: false,
      })
    })

    await screen.findByTestId('hub-awaiting-approval')
    expect(observeMock).toHaveBeenCalledTimes(2)
  })

  it('刷新后仍可批准：审批提交投影携带的 canonical draft', async () => {
    const address: HubAddressV1 = {
      projectId: scopeWork.projectId,
      sessionKey: scopeWork.sessionKey,
    }
    // 直接以待批准投影挂载（模拟刷新/重启后从 M2A 投影恢复）
    observeMock.mockResolvedValue({
      ok: true,
      value: awaitingProjection(address),
    })
    performMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: 'r',
        intentType: 'plan.revision.submit',
        sessionVersion: 5,
      },
    })
    showSession(sessionWith('s-work', scopeWork))
    const user = userEvent.setup()
    render(<CollaborationHubPanel />)

    await screen.findByTestId('hub-awaiting-approval')
    await user.click(screen.getByRole('button', { name: '批准计划' }))

    await waitFor(() => expect(performMock).toHaveBeenCalledTimes(1))
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

  it('取消失败时保留确认表单和用户填写的原因', async () => {
    observeMock.mockResolvedValue({ ok: true, value: awaitingProjection(scopeWork) })
    performMock.mockResolvedValue({
      ok: false,
      error: {
        code: 'STALE_SESSION_VERSION',
        messageKey: 'xiaogui.hub.stale_session_version',
        traceId: 'xhbt_00000000-0000-4000-8000-000000000000',
      },
    })
    showSession(sessionWith('s-cancel-failure', scopeWork))
    const user = userEvent.setup()
    render(<CollaborationHubPanel />)
    await screen.findByTestId('hub-awaiting-approval')

    await user.click(screen.getByRole('button', { name: '取消协作计划' }))
    const reason = screen.getByLabelText('取消原因')
    await user.type(reason, '仍需调整任务')
    await user.click(screen.getByRole('button', { name: '确认取消' }))

    expect(await screen.findByText(/STALE_SESSION_VERSION/)).toBeInTheDocument()
    expect(screen.getByLabelText('取消原因')).toHaveValue('仍需调整任务')
    expect(screen.getByRole('button', { name: '确认取消' })).toBeInTheDocument()
  })

  it('PLAN_ACTIVE 只读展示 m2b.v1 真实状态与 attempts，不渲染执行按钮', async () => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    observeMock.mockResolvedValue({
      ok: true,
      value: activeProjection(address),
    })
    showSession(sessionWith('s-coding', scopeCoding))
    render(<CollaborationHubPanel />)

    const view = await screen.findByTestId('hub-active-plan')
    // 旧契约遗留的 unavailableReason 徽标不得再出现（与真实运行状态矛盾）
    expect(view.textContent).not.toContain('AGENT_DISABLED_M2A')
    // 按状态分组展示：t1 在「执行中」，t2 在「等待依赖」，空组不出现
    expect(screen.getByTestId('hub-task-group-running')).toHaveTextContent('投影任务一')
    expect(screen.getByTestId('hub-task-group-waiting')).toHaveTextContent('投影任务二')
    expect(screen.queryByTestId('hub-task-group-executable')).toBeNull()
    expect(screen.queryByTestId('hub-task-group-verifying')).toBeNull()
    // TaskRun 真实状态（中文短文案）仍正常展示
    expect(screen.getByTestId('hub-taskrun-status-t1')).toHaveTextContent('运行中')
    expect(screen.getByTestId('hub-taskrun-status-t2')).toHaveTextContent('阻塞')
    // attempts 归属到对应 taskRun 下，但不展示 attemptId / runtimeSessionId 等内部标识
    expect(view).toHaveTextContent('执行尝试 · 失败')
    expect(view).toHaveTextContent('执行尝试 · 运行中')
    expect(view.textContent).not.toContain('尝试 xhba')
    expect(view.textContent).not.toContain('xhba_0')
    expect(view.textContent).not.toContain('xhba_1')
    expect(view.textContent).not.toContain('rs-1')
    // 不出现任何执行/领取/交付类按钮
    expect(screen.queryByRole('button', { name: '批准计划' })).toBeNull()
    expect(performMock).not.toHaveBeenCalled()
  })

  it('已验证任务只读展示安全检查、证据数量和任务变更集短摘要', async () => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    observeMock.mockResolvedValue({
      ok: true,
      value: projectionWithVerification(address, verificationSummaryFixture('SUCCEEDED')),
    })
    showSession(sessionWith('s-verified', scopeCoding))
    render(<CollaborationHubPanel />)

    const summary = await screen.findByTestId('hub-verification-summary-xhba_verified')
    expect(summary).toHaveTextContent('已验证')
    expect(summary).toHaveTextContent('界面类型检查通过')
    expect(summary).toHaveTextContent('主进程类型检查完成')
    expect(summary).toHaveTextContent('证据 2 项')
    expect(summary).toHaveTextContent('任务变更集 xhbtcs_1')
    expect(summary).toHaveTextContent('sha256:aaaaaaaaaaaa…')
    expect(summary).not.toHaveTextContent(`sha256:${'a'.repeat(64)}`)
    expect(summary).not.toHaveTextContent('xhbartifact_evidence_1')
    expect(screen.queryByRole('button', { name: '应用变更' })).toBeNull()
    expect(screen.queryByRole('button', { name: '生成交付' })).toBeNull()
    expect(screen.queryByRole('button', { name: '标记完成' })).toBeNull()
  })

  it.each([
    ['STARTED', '验证中'],
    ['FAILED', '验证失败'],
    ['OUTCOME_UNKNOWN', '结果未知'],
  ] as const)('验证摘要状态 %s 使用中文且保持只读', async (state, expectedText) => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    observeMock.mockResolvedValue({
      ok: true,
      value: projectionWithVerification(address, verificationSummaryFixture(state)),
    })
    showSession(sessionWith(`s-verification-${state}`, scopeCoding))
    render(<CollaborationHubPanel />)

    expect(await screen.findByTestId('hub-verification-status-xhba_verified')).toHaveTextContent(expectedText)
    expect(screen.queryByRole('button', { name: /验证|任务变更集/ })).toBeNull()
  })

  it('执行入口先本地核对零 IPC，最终确认只提交一次窄请求', async () => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    let resolveExecution!: (value: unknown) => void
    observeMock.mockResolvedValue({ ok: true, value: executableProjection(address) })
    executeMock.mockReturnValue(new Promise((resolve) => (resolveExecution = resolve)))
    showSession(sessionWith('s-execution', scopeCoding))
    const user = userEvent.setup()
    render(<CollaborationHubPanel />)

    await screen.findByTestId('hub-task-execution-edit')
    await user.type(screen.getByLabelText('本次任务说明'), '完成当前任务')
    await user.type(screen.getByLabelText('允许修改的已有文件'), 'src/a.ts')
    await user.type(screen.getByLabelText('允许新建的文件'), 'src/new.ts')
    await user.click(screen.getByRole('button', { name: '核对执行范围' }))

    expect(executeMock).not.toHaveBeenCalled()
    const review = screen.getByTestId('hub-task-execution-review')
    expect(review).toHaveTextContent('完成当前任务')
    expect(review).toHaveTextContent('src/a.ts')
    expect(review).toHaveTextContent('src/new.ts')
    expect(review).toHaveTextContent('不能删除文件')

    const confirm = screen.getByRole('button', { name: '确认并执行' })
    await user.click(confirm)
    await user.click(confirm)
    expect(executeMock).toHaveBeenCalledTimes(1)
    expect(executeMock.mock.calls[0]![0]).toEqual({
      address,
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
          taskRunId: 'xhbtr_3' as TaskRunId,
          taskSpecId: 'xhbts_1' as TaskSpecId,
          taskKey: 't1',
          status: 'RUNNING',
          attemptId: 'xhba_3' as AttemptId,
        },
        attempt: { attemptId: 'xhba_3' as AttemptId, taskRunId: 'xhbtr_3' as TaskRunId, status: 'RUNNING' },
      },
    })
    await waitFor(() => expect(observeMock).toHaveBeenCalledTimes(2))
  })

  it('任务按状态分组展示，空组不出现；分组与徽标以实时 readiness 为权威', async () => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    observeMock.mockResolvedValue({ ok: true, value: groupedWaveProjection(address) })
    showSession(sessionWith('s-grouped', scopeCoding))
    render(<CollaborationHubPanel />)

    await screen.findByTestId('hub-active-plan')
    // 未派发根任务（raw TaskRun=BLOCKED，readiness=READY）进入可执行组，徽标显示「就绪」而非「阻塞」
    const executable = screen.getByTestId('hub-task-group-executable')
    expect(executable).toHaveTextContent('投影任务四')
    expect(screen.getByTestId('hub-taskrun-status-t4')).toHaveTextContent('就绪')
    expect(screen.getByTestId('hub-taskrun-status-t4')).not.toHaveTextContent('阻塞')
    expect(executable).not.toHaveTextContent('执行尝试')
    // IN_FLIGHT + attempt RUNNING → 执行中；IN_FLIGHT + attempt VERIFYING → 验证中
    expect(screen.getByTestId('hub-task-group-running')).toHaveTextContent('投影任务一')
    expect(screen.getByTestId('hub-task-group-running')).not.toHaveTextContent('投影任务五')
    expect(screen.getByTestId('hub-task-group-verifying')).toHaveTextContent('投影任务五')
    expect(screen.getByTestId('hub-taskrun-status-t1')).toHaveTextContent('执行中')
    expect(screen.getByTestId('hub-taskrun-status-t5')).toHaveTextContent('验证中')
    // 等待依赖 / 前置失败的徽标与 readiness 一致，不显示 raw 的「阻塞」
    expect(screen.getByTestId('hub-taskrun-status-t2')).toHaveTextContent('等待依赖')
    expect(screen.getByTestId('hub-taskrun-status-t3')).toHaveTextContent('前置失败')
    const waiting = screen.getByTestId('hub-task-group-waiting')
    expect(waiting).toHaveTextContent('投影任务二')
    expect(waiting).toHaveTextContent('投影任务三')
    expect(waiting).not.toHaveTextContent('阻塞')
    // TERMINAL 回退 TaskRun 终态
    expect(screen.getByTestId('hub-task-group-failed')).toHaveTextContent('投影任务六')
    expect(screen.getByTestId('hub-taskrun-status-t6')).toHaveTextContent('失败')
    // 没有「待交付 / 已完成」任务时该组不渲染
    expect(screen.queryByTestId('hub-task-group-done')).toBeNull()
    // 满槽（availableSlots=0）时主进程不授予 execution.next.confirm，确认区不出现
    expect(screen.queryByTestId('hub-task-execution')).toBeNull()
  })

  it('等待/阻断原因使用任务标题，不显示内部 ID', async () => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    observeMock.mockResolvedValue({ ok: true, value: groupedWaveProjection(address) })
    showSession(sessionWith('s-reasons', scopeCoding))
    render(<CollaborationHubPanel />)

    const waiting = (await screen.findByTestId('hub-task-group-waiting')).textContent ?? ''
    expect(waiting).toContain('等待前置任务完成：投影任务一')
    // 父任务失败后子任务被阻断，原因是失败父任务的标题
    expect(waiting).toContain('前置任务失败，暂不能继续：投影任务六')
    expect(waiting).not.toContain('xhbtr_')
    expect(waiting).not.toContain('WAITING_FOR_DEPENDENCIES')
    expect(waiting).not.toContain('BLOCKED_BY_FAILED_DEPENDENCY')
  })

  it('有 runtimeBinding 的尝试只显示 Agent 类型与状态，不暴露内部标识', async () => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    observeMock.mockResolvedValue({ ok: true, value: groupedWaveProjection(address) })
    showSession(sessionWith('s-binding', scopeCoding))
    render(<CollaborationHubPanel />)

    const view = await screen.findByTestId('hub-active-plan')
    expect(view).toHaveTextContent('Codex Agent · 运行中')
    expect(view).toHaveTextContent('执行尝试 · 验证中')
    expect(view).toHaveTextContent('执行尝试 · 失败')
    expect(view.textContent).not.toContain('xhba_')
    expect(view.textContent).not.toContain('runtime-secret-session')
    expect(view.textContent).not.toContain('xhbwr_receipt-secret')
    expect(view.textContent).not.toContain('codex-cli-internal-adapter')
    expect(view.textContent).not.toContain(`sha256:${'9'.repeat(64)}`)
    expect(view.textContent).not.toContain(`sha256:${'e'.repeat(64)}`)
  })

  it('可用槽场景显示确认区与本批摘要，一次确认本批只提交一次窄请求', async () => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    observeMock.mockResolvedValue({ ok: true, value: confirmableProjection(address) })
    executeMock.mockResolvedValue({
      ok: true,
      value: {
        taskRun: {
          taskRunId: 'xhbtr_4' as TaskRunId,
          taskSpecId: 'xhbts_4' as TaskSpecId,
          taskKey: 't4',
          status: 'RUNNING',
          attemptId: 'xhba_4' as AttemptId,
        },
        attempt: { attemptId: 'xhba_4' as AttemptId, taskRunId: 'xhbtr_4' as TaskRunId, status: 'RUNNING' },
      },
    })
    showSession(sessionWith('s-wave', scopeCoding))
    const user = userEvent.setup()
    render(<CollaborationHubPanel />)

    const section = await screen.findByTestId('hub-task-execution')
    expect(section).toHaveTextContent('执行本批可执行任务')
    expect(section).toHaveTextContent('同一项目最多并行执行 2 个任务')
    expect(section).toHaveTextContent('文件范围重叠的任务会串行排队')
    expect(section).toHaveTextContent('由主进程按确定性规则选择')

    // 实时 readiness 给出并行上限/执行中/空位；wave 只贡献「本批新调度」，
    // wave.activeAttemptIds 不得被当成新调度数量
    const summary = screen.getByTestId('hub-execution-wave-summary')
    expect(summary).toHaveTextContent('并行上限 2 · 执行中 1 个 · 可再派发 1 个')
    expect(summary).toHaveTextContent('本批新调度 1 个')
    expect(summary).toHaveTextContent('等待依赖 1 个')
    expect(summary.textContent).not.toContain('已调度')
    expect(summary.textContent).not.toContain('xhbev_wave1')
    expect(summary.textContent).not.toContain('xhba_')
    expect(summary.textContent).not.toContain('xhbtr_')

    // 可执行组里的未派发根任务（raw BLOCKED + readiness READY）徽标为「就绪」
    expect(screen.getByTestId('hub-taskrun-status-t4')).toHaveTextContent('就绪')
    expect(screen.getByTestId('hub-taskrun-status-t4')).not.toHaveTextContent('阻塞')

    // 核对执行范围零 IPC；确认并执行只提交一次窄请求
    await user.type(screen.getByLabelText('本次任务说明'), '完成本批任务')
    await user.type(screen.getByLabelText('允许修改的已有文件'), 'src/a.ts')
    await user.click(screen.getByRole('button', { name: '核对执行范围' }))
    expect(executeMock).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: '确认并执行' })
    await user.click(confirm)
    await user.click(confirm)
    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1))
    expect(executeMock.mock.calls[0]![0]).toEqual({
      address,
      flowId: 'xhbf_flow1',
      prompt: '完成本批任务',
      files: [{ operation: 'MODIFY', relativePath: 'src/a.ts' }],
    })
  })

  it.each([
    ['满槽分组', groupedWaveProjection],
    ['可确认', confirmableProjection],
  ] as const)('%s fixture 的 wave activeAttemptIds 与 scheduled 不相交', (_name, factory) => {
    const projection = factory({
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    })
    const wave = projection.lastExecutionWave
    expect(wave).toBeDefined()
    const activeAttemptIds = new Set<string>(wave!.activeAttemptIds)
    expect(wave!.scheduled.length).toBeGreaterThan(0)
    for (const item of wave!.scheduled) {
      expect(activeAttemptIds.has(item.attemptId)).toBe(false)
    }
  })

  it('交付右栏展示公开摘要；审阅零 IPC，确认应用只调用一次 approve', async () => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    observeMock.mockResolvedValue({ ok: true, value: deliveryProjection(address) })
    approveDeliveryMock.mockResolvedValue({
      ok: true,
      value: { ...deliveryProjection(address).activeDelivery!, state: 'APPLYING' },
    })
    showSession(sessionWith('s-delivery', scopeCoding))
    const user = userEvent.setup()
    render(<CollaborationHubPanel />)

    const delivery = await screen.findByTestId('hub-delivery-review')
    expect(delivery).toHaveTextContent('交付审阅')
    expect(delivery).toHaveTextContent('完整任务 2 个')
    expect(delivery).toHaveTextContent('src/a.ts')
    expect(delivery).toHaveTextContent('src/new.ts')
    expect(delivery).toHaveTextContent('证据摘要 2 项')
    expect(delivery).not.toHaveTextContent('xhbartifact_hidden_bytes')
    expect(delivery).not.toHaveTextContent(`sha256:${'3'.repeat(64)}`)

    await user.click(screen.getByRole('button', { name: '审阅' }))
    expect(approveDeliveryMock).not.toHaveBeenCalled()
    expect(await screen.findByTestId('hub-delivery-confirm')).toHaveTextContent('审阅本身不会写入文件')

    const confirm = screen.getByRole('button', { name: '确认应用' })
    await user.click(confirm)
    await user.click(confirm)
    await waitFor(() => expect(approveDeliveryMock).toHaveBeenCalledTimes(1))
    expect(approveDeliveryMock.mock.calls[0]![1]).toMatchObject({
      requestId: 'test-req-1',
      gateId: 'xhbdg_delivery',
      subject: {
        deliveryChangeSetId: 'xhbdcs_delivery',
        version: 1,
        digest: `sha256:${'3'.repeat(64)}`,
      },
    })
  })

  it('没有 activeDelivery 时，可从已验证任务复选创建交付', async () => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    const verified = verificationSummaryFixture('SUCCEEDED')
    const projection = {
      ...projectionWithVerification(address, verified),
      activeDelivery: null,
      availableActions: ['flow.cancel', 'delivery.selection.submit'],
    }
    observeMock.mockResolvedValue({ ok: true, value: projection })
    submitDeliveryMock.mockResolvedValue({ ok: true, value: deliveryProjection(address).activeDelivery! })
    showSession(sessionWith('s-delivery-selection', scopeCoding))
    const user = userEvent.setup()
    render(<CollaborationHubPanel />)

    await screen.findByTestId('hub-delivery-selection')
    const create = screen.getByRole('button', { name: '创建交付' })
    expect(create).toBeDisabled()
    await user.click(screen.getByRole('checkbox'))
    expect(create).toBeEnabled()
    await user.click(create)
    await user.click(create)

    await waitFor(() => expect(submitDeliveryMock).toHaveBeenCalledTimes(1))
    expect(submitDeliveryMock.mock.calls[0]![1]).toEqual({
      requestId: 'test-req-1',
      flowId: 'xhbf_flow1',
      taskRunIds: ['xhbtr_verified'],
    })
  })

  it('退回交付不调用 approve', async () => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    observeMock.mockResolvedValue({ ok: true, value: deliveryProjection(address) })
    returnDeliveryMock.mockResolvedValue({
      ok: true,
      value: { ...deliveryProjection(address).activeDelivery!, state: 'REJECTED' },
    })
    showSession(sessionWith('s-delivery-return', scopeCoding))
    const user = userEvent.setup()
    render(<CollaborationHubPanel />)

    await screen.findByTestId('hub-delivery-review')
    await user.click(screen.getByRole('button', { name: '退回交付' }))

    await waitFor(() => expect(returnDeliveryMock).toHaveBeenCalledTimes(1))
    expect(approveDeliveryMock).not.toHaveBeenCalled()
  })

  it('交付应用失败门禁区分基准恢复、普通重试和结果未知', async () => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    const failedApplyAttempt = {
      applyAttemptId: 'xhbdapp_failed' as never,
      batchId: 'xhbd_batch1' as never,
      deliveryChangeSetId: 'xhbdcs_delivery' as never,
      requestDigest: `sha256:${'a'.repeat(64)}` as never,
      targetFingerprintBefore: `sha256:${'b'.repeat(64)}` as never,
      state: 'FAILED_ROLLED_BACK' as const,
      receiptDigest: `sha256:${'c'.repeat(64)}` as never,
      safeCode: 'TARGET_BASELINE_DRIFT' as const,
      changedRelativePaths: [] as readonly string[],
      startedAt: '2026-08-18T00:00:00.000Z' as never,
      finishedAt: '2026-08-18T00:00:01.000Z' as never,
    }
    const projection = deliveryProjection(address)
    observeMock.mockResolvedValue({
      ok: true,
      value: {
        ...projection,
        activeDelivery: { ...projection.activeDelivery!, state: 'APPROVED', applyAttempt: failedApplyAttempt },
        availableActions: ['flow.cancel', 'apply.recovery.prepare', 'apply.retry.request'],
      },
    })
    prepareRecoveryMock.mockResolvedValue({ ok: true, value: projection.activeDelivery! })
    showSession(sessionWith('s-delivery-recovery', scopeCoding))
    const user = userEvent.setup()
    render(<CollaborationHubPanel />)

    expect(await screen.findByTestId('hub-delivery-integrity-note')).toHaveTextContent('项目代码已变化，旧批准不能继续使用')
    expect(screen.queryByRole('button', { name: '重试应用' })).toBeNull()
    const recoveryButton = screen.getByRole('button', { name: '按当前代码重新准备交付' })
    await user.click(recoveryButton)

    expect(prepareRecoveryMock).toHaveBeenCalledTimes(1)
    expect(prepareRecoveryMock.mock.calls[0]![1]).toEqual({
      requestId: 'test-req-1',
      batchId: 'xhbd_batch1',
      failedApplyAttemptId: 'xhbdapp_failed',
    })

    cleanup()
    prepareRecoveryMock.mockReset()
    retryDeliveryMock.mockReset()
    observeMock.mockResolvedValue({
      ok: true,
      value: {
        ...projection,
        activeDelivery: {
          ...projection.activeDelivery!,
          state: 'APPROVED',
          applyAttempt: { ...failedApplyAttempt, safeCode: 'TARGET_WRITE_FAILED' as const },
        },
        availableActions: ['flow.cancel', 'apply.retry.request'],
      },
    })
    retryDeliveryMock.mockResolvedValue({ ok: true, value: projection.activeDelivery! })
    showSession(sessionWith('s-delivery-retry', scopeCoding))
    render(<CollaborationHubPanel />)
    const retryButton = await screen.findByRole('button', { name: '重试应用' })
    await user.click(retryButton)
    expect(retryDeliveryMock).toHaveBeenCalledTimes(1)
    expect(retryDeliveryMock.mock.calls[0]![1]).toEqual({
      requestId: 'test-req-2',
      batchId: 'xhbd_batch1',
      failedApplyAttemptId: 'xhbdapp_failed',
    })
    expect(screen.queryByRole('button', { name: '按当前代码重新准备交付' })).toBeNull()

    cleanup()
    prepareRecoveryMock.mockReset()
    retryDeliveryMock.mockReset()
    observeMock.mockResolvedValue({
      ok: true,
      value: {
        ...projection,
        activeDelivery: {
          ...projection.activeDelivery!,
          state: 'APPROVED',
          applyAttempt: { ...failedApplyAttempt, changedRelativePaths: undefined },
        },
        availableActions: ['flow.cancel', 'apply.recovery.prepare', 'apply.retry.request'],
      },
    })
    showSession(sessionWith('s-delivery-recovery-missing-paths', scopeCoding))
    render(<CollaborationHubPanel />)
    await screen.findByTestId('hub-delivery-integrity-note')
    expect(screen.queryByRole('button', { name: '按当前代码重新准备交付' })).toBeNull()
    expect(screen.queryByRole('button', { name: '重试应用' })).toBeNull()

    cleanup()
    retryDeliveryMock.mockReset()
    observeMock.mockResolvedValue({
      ok: true,
      value: {
        ...projection,
        activeDelivery: {
          ...projection.activeDelivery!,
          state: 'APPROVED',
          applyAttempt: { ...failedApplyAttempt, state: 'OUTCOME_UNKNOWN' as const, safeCode: 'TARGET_WRITE_FAILED' as const },
        },
        availableActions: ['flow.cancel', 'apply.retry.request'],
      },
    })
    showSession(sessionWith('s-delivery-unknown', scopeCoding))
    render(<CollaborationHubPanel />)
    await screen.findByTestId('hub-delivery-review')
    expect(screen.queryByRole('button', { name: '重试应用' })).toBeNull()
    expect(screen.queryByRole('button', { name: '按当前代码重新准备交付' })).toBeNull()

    cleanup()
    prepareRecoveryMock.mockReset()
    retryDeliveryMock.mockReset()
    observeMock.mockResolvedValue({
      ok: true,
      value: {
        ...projection,
        activeDelivery: {
          ...projection.activeDelivery!,
          state: 'APPROVED',
          applyAttempt: { ...failedApplyAttempt, safeCode: 'TARGET_STATUS_DIRTY' as const },
        },
        availableActions: ['flow.cancel', 'apply.retry.request'],
      },
    })
    showSession(sessionWith('s-delivery-dirty', scopeCoding))
    render(<CollaborationHubPanel />)
    expect(await screen.findByTestId('hub-delivery-integrity-note')).toHaveTextContent(
      '项目存在未提交改动，请先自行处理并刷新；小规不会覆盖这些改动',
    )
    expect(screen.queryByRole('button', { name: '重试应用' })).toBeNull()
    expect(screen.queryByRole('button', { name: '按当前代码重新准备交付' })).toBeNull()

    cleanup()
    observeMock.mockResolvedValue({
      ok: true,
      value: {
        ...projection,
        activeDelivery: {
          ...projection.activeDelivery!,
          state: 'APPROVED',
          applyAttempt: { ...failedApplyAttempt, safeCode: 'TARGET_FILE_DRIFT' as const },
        },
        availableActions: ['flow.cancel', 'apply.retry.request'],
      },
    })
    showSession(sessionWith('s-delivery-file-drift', scopeCoding))
    render(<CollaborationHubPanel />)
    expect(await screen.findByTestId('hub-delivery-integrity-note')).toHaveTextContent(
      '交付文件已变化，当前交付不能直接重试',
    )
    expect(screen.queryByRole('button', { name: '重试应用' })).toBeNull()
  })

  it('切换会话后旧投影不串到新会话', async () => {
    const addrWork: HubAddressV1 = {
      projectId: scopeWork.projectId,
      sessionKey: scopeWork.sessionKey,
    }
    const addrCoding: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    observeMock.mockImplementation((address: HubAddressV1) => {
      if (address.sessionKey === addrWork.sessionKey) {
        return Promise.resolve({
          ok: true,
          value: awaitingProjection(addrWork),
        })
      }
      return Promise.resolve({ ok: true, value: baseProjection(addrCoding) })
    })
    showSession(sessionWith('s-work', scopeWork))
    render(<CollaborationHubPanel />)
    await screen.findByTestId('hub-awaiting-approval')

    // 切换到 CODING 会话（空投影）→ 待批准视图必须消失
    showSession(sessionWith('s-coding', scopeCoding))
    await screen.findByTestId('hub-natural-language-entry')
    expect(screen.queryByTestId('hub-awaiting-approval')).toBeNull()
  })

  it('同一 canonical address 的权威模式变化后重新读取投影', async () => {
    const designAtSameAddress: CanonicalSessionAddressScopeV1 = {
      ...scopeWork,
      sessionMode: 'DESIGN',
    }
    observeMock
      .mockResolvedValueOnce({ ok: true, value: baseProjection(scopeWork) })
      .mockResolvedValueOnce({ ok: true, value: reservedProjection(scopeWork) })

    showSession(sessionWith('s-mode-change', scopeWork))
    render(<CollaborationHubPanel />)
    await screen.findByTestId('hub-natural-language-entry')

    showSession(sessionWith('s-mode-change', designAtSameAddress))

    expect(await screen.findByTestId('hub-design-reserved')).toHaveTextContent('当前是规划设计会话')
    expect(observeMock).toHaveBeenCalledTimes(2)
  })

  it('错误默认只显示中文短文案，内部信息折叠供反馈使用', async () => {
    observeMock.mockResolvedValue({
      ok: false,
      error: {
        code: 'STALE_SESSION_VERSION',
        messageKey: 'xiaogui.hub.stale',
        traceId: 'tr-9',
      },
    })
    showSession(sessionWith('s-work', scopeWork))
    render(<CollaborationHubPanel />)
    expect(await screen.findByText('会话状态已变化，请刷新后重试')).toBeInTheDocument()
    const details = screen.getByText('错误详情（供反馈使用）').closest('details')
    expect(details).not.toHaveAttribute('open')
    expect(details).toHaveTextContent('STALE_SESSION_VERSION')
    expect(details).toHaveTextContent('tr-9')
  })
})
