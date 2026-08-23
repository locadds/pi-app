import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  HubSystemCommandRequestM2BV1,
  SessionCollaborationProjectionM2BV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import type { XiaoguiTaskExecutionStartRequestV1 } from '@shared/xiaogui-task-execution'
import type { RuntimeEventV1, RuntimeOutcomeV1 } from '@shared/xiaogui-agent-runtime'

import type { CollaborationHubApplicationV1 } from './application'
import {
  XiaoguiTaskExecutionOrchestratorV1,
  type TaskExecutionInputStageV1,
} from './execution-orchestrator'
import type {
  AttemptFileScopeResolverV1,
  UserApprovedFileSelectionV1,
} from './attempt-workspace'
import type {
  RuntimeOutcomeCallbackV1,
  RuntimeOutcomeMonitorV1,
  RuntimePermissionDecisionFactoryV1,
} from './runtime-outcome-monitor'
import type {
  TaskVerificationCoordinatorResultV1,
  TaskVerificationCoordinatorV1,
  TaskVerificationSucceededInputV1,
} from './task-verification-coordinator'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as HubAddressV1
const FLOW_ID = 'xhbf_flow' as FlowId
const TASK_RUN_ID = 'xhbtr_task' as TaskRunId
const ATTEMPT_ID = 'xhba_attempt' as AttemptId
const NEXT_TASK_RUN_ID = 'xhbtr_next' as TaskRunId
const NEXT_ATTEMPT_ID = 'xhba_next' as AttemptId
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('XiaoguiTaskExecutionOrchestratorV1', () => {
  it('owns the fixed resolve -> schedule -> stage -> prepare -> dispatch sequence and returns the authoritative Attempt', async () => {
    const events: string[] = []
    const hub = fakeHub(events)
    const orchestrator = await createOrchestrator(hub.application, events)

    await expect(orchestrator.start(request())).resolves.toMatchObject({
      ok: true,
      value: {
        taskRun: { taskRunId: TASK_RUN_ID, status: 'RUNNING' },
        attempt: { attemptId: ATTEMPT_ID, status: 'RUNNING' },
      },
    })
    expect(events).toEqual(['resolve', 'schedule', 'stage', 'prepare', 'dispatch'])
    expect(hub.scheduleCount()).toBe(1)
    await orchestrator.close()
  })

  it('stages a self-contained private prompt with plan context, approved files, and controlled-tool instructions', async () => {
    const events: string[] = []
    const hub = fakeHub(events)
    const staged: Parameters<TaskExecutionInputStageV1['stageAttemptInput']>[0][] = []
    const inputStage: TaskExecutionInputStageV1 = {
      stageAttemptInput(input) {
        events.push('stage')
        staged.push(input)
        return {}
      },
    }
    const orchestrator = await createOrchestrator(
      hub.application,
      events,
      undefined,
      undefined,
      undefined,
      inputStage,
    )

    await expect(orchestrator.start(request())).resolves.toMatchObject({ ok: true })

    const prompt = Buffer.from(staged[0].promptBytes).toString('utf8')
    expect(prompt).toContain('总目标：执行任务')
    expect(prompt).toContain('当前任务：当前任务')
    expect(prompt).toContain('任务说明：只调整受控文件中的实现')
    expect(prompt).toContain('用户补充指令：完成当前任务')
    expect(prompt).toContain('- 修改："src/task.ts"')
    expect(prompt).toContain('fs/read_text_file')
    expect(prompt).toContain('fs/write_text_file')
    expect(prompt).toContain('不得调用终端命令')
    await orchestrator.close()
  })

  it('rejects unresolvable approved files before schedule and before private input staging', async () => {
    const events: string[] = []
    const hub = fakeHub(events)
    const orchestrator = await createOrchestrator(hub.application, events, {
      resolveApprovedFiles: vi.fn(async () => {
        events.push('resolve')
        throw new Error('PATH_FORBIDDEN')
      }),
    })

    await expect(orchestrator.start(request({ relativePath: '../outside.ts' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'EXECUTION_INPUT_INVALID' },
    })
    expect(events).toEqual(['resolve'])
    expect(hub.scheduleCount()).toBe(0)
    await orchestrator.close()
  })

  it('coalesces identical confirmation and rejects different content while one operation is active', async () => {
    const events: string[] = []
    const hub = fakeHub(events)
    const orchestrator = await createOrchestrator(hub.application, events)

    const [first, replay] = await Promise.all([
      orchestrator.start(request()),
      orchestrator.start(request()),
    ])
    expect(first).toMatchObject({ ok: true, value: { attempt: { attemptId: ATTEMPT_ID } } })
    expect(replay).toEqual(first)
    expect(hub.scheduleCount()).toBe(1)
    await expect(orchestrator.start({ ...request(), prompt: '另一份执行内容' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'EXECUTION_IN_PROGRESS' },
    })
    expect(hub.scheduleCount()).toBe(1)
    await orchestrator.close()
  })

  it('turns a cross-restart RUNNING Attempt into runtime-unbound OUTCOME_UNKNOWN without redispatch', async () => {
    const events: string[] = []
    const hub = fakeHub(events)
    const dbPath = await tempDb()
    const first = await createOrchestrator(hub.application, events, undefined, dbPath)
    await expect(first.start(request())).resolves.toMatchObject({ ok: true })
    await first.close()

    const restarted = await createOrchestrator(hub.application, events, undefined, dbPath)
    await restarted.recover()

    expect(events.filter((event) => event === 'dispatch')).toHaveLength(1)
    expect(events.filter((event) => event === 'outcome-unknown')).toHaveLength(1)
    expect(hub.runtimeSessionId()).toBe('runtime-unbound')
    await expect(restarted.start(request())).resolves.toMatchObject({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN' },
    })
    await restarted.close()
  })

  it('registers runtime monitoring for RUNNING Attempts and routes SUCCEEDED to task verification', async () => {
    const events: string[] = []
    const hub = fakeHub(events)
    const monitor = fakeRuntimeMonitor()
    const coordinator = fakeVerificationCoordinator()
    const orchestrator = await createOrchestrator(hub.application, events, undefined, undefined, {
      runtimeMonitor: monitor,
      verificationCoordinator: coordinator,
    })

    await expect(orchestrator.start(request())).resolves.toMatchObject({ ok: true })
    expect(monitor.watched()).toEqual(['runtime-1'])

    await monitor.emit('runtime-1', {
      state: 'SUCCEEDED',
      runtimeSessionId: 'runtime-1',
      receiptDigest: 'sha256:runtime-success',
      candidateDigest: 'sha256:runtime-candidate',
    })

    expect(coordinator.inputs()).toMatchObject([{
      flowId: FLOW_ID,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      outcome: { state: 'SUCCEEDED', runtimeSessionId: 'runtime-1' },
    }])
    expect(hub.systemCommands().filter((command) => command.intent.type === 'system.agent.outcome.record')).toHaveLength(0)
    await orchestrator.close()
  })

  it('binds deterministic ALLOW_ONCE decisions to the confirmed execution scope', async () => {
    const events: string[] = []
    const hub = fakeHub(events)
    const monitor = fakeRuntimeMonitor()
    const coordinator = fakeVerificationCoordinator()
    const orchestrator = await createOrchestrator(hub.application, events, undefined, undefined, {
      runtimeMonitor: monitor,
      verificationCoordinator: coordinator,
    })

    await expect(orchestrator.start(request())).resolves.toMatchObject({ ok: true })
    const permission = permissionRequestedEvent()
    const first = await monitor.decide('runtime-1', permission)
    const replay = await monitor.decide('runtime-1', permission)

    expect(first).toEqual(replay)
    expect(first).toMatchObject({
      type: 'ALLOW_ONCE',
      permissionRequestId: permission.permissionRequestId,
      challengeDigest: permission.challengeDigest,
      runtimeSessionId: 'runtime-1',
      scope: permission.scope,
    })
    expect(first).toHaveProperty('proofDigest', expect.stringMatching(/^sha256:[0-9a-f]{64}$/))

    const { permissionPurpose: _permissionPurpose, ...unclassified } = permission
    expect(await monitor.decide('runtime-1', unclassified)).toMatchObject({
      type: 'DENY',
      reasonCode: 'UNAPPROVED_PERMISSION_PURPOSE',
    })
    await expect(Promise.resolve().then(() => monitor.decide('runtime-1', {
      ...permission,
      scope: { ...permission.scope, workspaceReceiptId: 'workspace-receipt-other' },
    }))).rejects.toThrow('RUNTIME_PERMISSION_SCOPE_MISMATCH')
    await orchestrator.close()
  })

  it('writes CANDIDATE_AUDIT_FAILED when verification cannot capture the task candidate', async () => {
    const events: string[] = []
    const hub = fakeHub(events)
    const monitor = fakeRuntimeMonitor()
    const coordinator = fakeVerificationCoordinator({ ok: false, reasonCode: 'TASK_VERIFICATION_CAPTURE_FAILED' })
    const orchestrator = await createOrchestrator(hub.application, events, undefined, undefined, {
      runtimeMonitor: monitor,
      verificationCoordinator: coordinator,
    })

    await expect(orchestrator.start(request())).resolves.toMatchObject({ ok: true })
    await monitor.emit('runtime-1', {
      state: 'SUCCEEDED',
      runtimeSessionId: 'runtime-1',
      receiptDigest: 'sha256:runtime-success',
      candidateDigest: 'sha256:runtime-candidate',
    })

    const outcome = hub.systemCommands().find((command) => command.intent.type === 'system.agent.outcome.record')
    expect(outcome?.intent).toMatchObject({
      outcome: 'FAILED',
      failure: {
        failureClass: 'PROTOCOL',
        safeCode: 'CANDIDATE_AUDIT_FAILED',
        receiptDigest: 'sha256:runtime-success',
      },
    })
    await orchestrator.close()
  })

  it('requires runtime monitor and verification coordinator to be configured together', async () => {
    const events: string[] = []
    const hub = fakeHub(events)

    await expect(createOrchestrator(hub.application, events, undefined, undefined, {
      runtimeMonitor: fakeRuntimeMonitor(),
    })).rejects.toThrow('XIAOGUI_TASK_EXECUTION_RUNTIME_VERIFICATION_PAIR_REQUIRED')
  })

  it('settles a stale active Saga from authoritative terminal state before accepting different input without redispatching the old task', async () => {
    const events: string[] = []
    const hub = terminalThenNextHub(events)
    const orchestrator = await createOrchestrator(hub.application, events)

    await expect(orchestrator.start(request())).resolves.toMatchObject({
      ok: true,
      value: { attempt: { attemptId: ATTEMPT_ID } },
    })
    hub.finishOldAndOfferNext()
    await expect(orchestrator.start({ ...request(), prompt: '执行下一项任务' })).resolves.toMatchObject({
      ok: true,
      value: { attempt: { attemptId: NEXT_ATTEMPT_ID } },
    })

    expect(events.filter((event) => event === `dispatch:${ATTEMPT_ID}`)).toHaveLength(1)
    expect(events.filter((event) => event === `dispatch:${NEXT_ATTEMPT_ID}`)).toHaveLength(1)
    await orchestrator.close()
  })
})

async function createOrchestrator(
  application: CollaborationHubApplicationV1,
  events: string[],
  resolver?: AttemptFileScopeResolverV1,
  existingDbPath?: string,
  runtime?: {
    runtimeMonitor?: RuntimeOutcomeMonitorV1
    verificationCoordinator?: TaskVerificationCoordinatorV1
  },
  inputStageOverride?: TaskExecutionInputStageV1,
): Promise<XiaoguiTaskExecutionOrchestratorV1> {
  const fileScopeResolver = resolver ?? {
    resolveApprovedFiles: vi.fn(async (
      _projectId: string,
      selections: readonly UserApprovedFileSelectionV1[],
    ) => {
      events.push('resolve')
      return selections.map((selection) => selection.operation === 'MODIFY'
        ? { ...selection, baselineDigest: 'sha256:baseline' }
        : selection)
    }),
  }
  const inputStage: TaskExecutionInputStageV1 = inputStageOverride ?? {
    stageAttemptInput: vi.fn(() => {
      events.push('stage')
      return {}
    }),
  }
  let operationSequence = 0
  return new XiaoguiTaskExecutionOrchestratorV1({
    dbPath: existingDbPath ?? await tempDb(),
    application,
    inputStage,
    fileScopeResolver,
    ...runtime,
    now: () => '2026-08-17T00:00:00.000Z',
    idFactory: () => `xhbe_operation_${++operationSequence}`,
  })
}

function fakeRuntimeMonitor(): RuntimeOutcomeMonitorV1 & {
  emit(runtimeSessionId: string, outcome: RuntimeOutcomeV1): Promise<void>
  decide(
    runtimeSessionId: string,
    event: Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }>,
  ): ReturnType<RuntimePermissionDecisionFactoryV1>
  watched(): string[]
} {
  const callbacks = new Map<string, RuntimeOutcomeCallbackV1>()
  const decisionFactories = new Map<string, RuntimePermissionDecisionFactoryV1>()
  const watched: string[] = []
  return {
    watch(runtimeSessionId, callback, decisionFactory) {
      if (callbacks.has(runtimeSessionId)) return
      watched.push(runtimeSessionId)
      callbacks.set(runtimeSessionId, callback)
      if (decisionFactory) decisionFactories.set(runtimeSessionId, decisionFactory)
    },
    async emit(runtimeSessionId, outcome) {
      const callback = callbacks.get(runtimeSessionId)
      if (!callback) throw new Error('runtime session was not watched')
      await callback(outcome)
    },
    decide(runtimeSessionId, event) {
      const decisionFactory = decisionFactories.get(runtimeSessionId)
      if (!decisionFactory) throw new Error('runtime session has no permission decision factory')
      return decisionFactory(event)
    },
    watched: () => [...watched],
    close: vi.fn(async () => undefined),
  }
}

function fakeVerificationCoordinator(
  result: TaskVerificationCoordinatorResultV1 = {
    ok: true,
    verificationAttemptId: 'xhbva_test' as never,
    verdict: 'PASS',
  },
): TaskVerificationCoordinatorV1 & { inputs(): TaskVerificationSucceededInputV1[] } {
  const inputs: TaskVerificationSucceededInputV1[] = []
  return {
    handleSucceeded: vi.fn(async (input) => {
      inputs.push(input)
      return result
    }),
    recoverPending: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
    inputs: () => [...inputs],
  }
}

function terminalThenNextHub(events: string[]) {
  type Phase = 'OLD_PENDING' | 'OLD_PREPARING' | 'OLD_READY' | 'OLD_RUNNING' | 'OLD_SUCCEEDED' | 'NEW_PREPARING' | 'NEW_READY' | 'NEW_RUNNING'
  let phase: Phase = 'OLD_PENDING'

  const projection = (): SessionCollaborationProjectionM2BV1 => {
    const oldAttemptStatus = phase === 'OLD_PENDING'
      ? undefined
      : phase === 'OLD_PREPARING'
        ? 'WORKSPACE_PREPARING' as const
        : phase === 'OLD_READY'
          ? 'READY' as const
          : phase === 'OLD_RUNNING'
            ? 'RUNNING' as const
            : 'SUCCEEDED' as const
    const hasNext = ['OLD_SUCCEEDED', 'NEW_PREPARING', 'NEW_READY', 'NEW_RUNNING'].includes(phase)
    const nextAttemptStatus = phase === 'NEW_PREPARING'
      ? 'WORKSPACE_PREPARING' as const
      : phase === 'NEW_READY'
        ? 'READY' as const
        : phase === 'NEW_RUNNING'
          ? 'RUNNING' as const
          : undefined
    return {
      kind: 'SESSION_COLLABORATION_PROJECTION',
      version: 'm2b.v1',
      address: ADDRESS,
      sessionVersion: 1,
      sessionMode: 'CODING',
      authoritativeMode: 'CODING',
      reserved: false,
      activeFlow: { flowId: FLOW_ID, status: 'PLAN_ACTIVE', activeRevisionId: null, objective: '执行任务' },
      activeRevision: null,
      taskSpecs: [
        { taskSpecId: 'xhbts_task' as never, taskKey: 'task', title: '旧任务', dependsOn: [], unavailableReason: 'AGENT_DISABLED_M2A' },
        ...(hasNext ? [{ taskSpecId: 'xhbts_next' as never, taskKey: 'next', title: '新任务', dependsOn: [], unavailableReason: 'AGENT_DISABLED_M2A' as const }] : []),
      ],
      taskRuns: [
        {
          taskRunId: TASK_RUN_ID,
          taskSpecId: 'xhbts_task' as never,
          taskKey: 'task',
          status: oldAttemptStatus === 'SUCCEEDED' ? 'DONE' : oldAttemptStatus ? 'RUNNING' : 'BLOCKED',
          ...(oldAttemptStatus ? { attemptId: ATTEMPT_ID } : {}),
        },
        ...(hasNext ? [{
          taskRunId: NEXT_TASK_RUN_ID,
          taskSpecId: 'xhbts_next' as never,
          taskKey: 'next',
          status: nextAttemptStatus ? 'RUNNING' as const : 'BLOCKED' as const,
          ...(nextAttemptStatus ? { attemptId: NEXT_ATTEMPT_ID } : {}),
        }] : []),
      ],
      attempts: [
        ...(oldAttemptStatus ? [{ attemptId: ATTEMPT_ID, taskRunId: TASK_RUN_ID, status: oldAttemptStatus }] : []),
        ...(nextAttemptStatus ? [{ attemptId: NEXT_ATTEMPT_ID, taskRunId: NEXT_TASK_RUN_ID, status: nextAttemptStatus }] : []),
      ],
      history: [],
      availableActions: phase === 'OLD_PENDING' || phase === 'OLD_SUCCEEDED'
        ? ['flow.cancel', 'execution.next.confirm']
        : ['flow.cancel'],
    }
  }

  const application = {
    observeM2B: vi.fn(async () => ({ ok: true as const, value: projection() })),
    executeSystem: vi.fn(async (command: HubSystemCommandRequestM2BV1) => {
      if (command.intent.type === 'system.schedule') {
        if (phase === 'OLD_PENDING') {
          phase = 'OLD_PREPARING'
          events.push('schedule')
          return { ok: true as const, value: { requestId: command.requestId, intentType: command.intent.type, sessionVersion: 2, flowId: FLOW_ID, taskRunId: TASK_RUN_ID, attemptId: ATTEMPT_ID } }
        }
        if (phase === 'OLD_SUCCEEDED') {
          phase = 'NEW_PREPARING'
          events.push('schedule')
          return { ok: true as const, value: { requestId: command.requestId, intentType: command.intent.type, sessionVersion: 5, flowId: FLOW_ID, taskRunId: NEXT_TASK_RUN_ID, attemptId: NEXT_ATTEMPT_ID } }
        }
      }
      if (command.intent.type === 'system.agent.report.record') {
        if (command.intent.attemptId === ATTEMPT_ID && phase === 'OLD_READY') phase = 'OLD_RUNNING'
        else if (command.intent.attemptId === NEXT_ATTEMPT_ID && phase === 'NEW_READY') phase = 'NEW_RUNNING'
        else throw new Error('unexpected dispatch')
        events.push(`dispatch:${command.intent.attemptId}`)
        return { ok: true as const, value: { requestId: command.requestId, intentType: command.intent.type, sessionVersion: 4, flowId: FLOW_ID, taskRunId: command.intent.taskRunId, attemptId: command.intent.attemptId } }
      }
      throw new Error(`unexpected ${command.intent.type}`)
    }),
    prepareNextWorkspace: vi.fn(async (_address, preparation) => {
      if (preparation.attemptId === ATTEMPT_ID && phase === 'OLD_PREPARING') phase = 'OLD_READY'
      else if (preparation.attemptId === NEXT_ATTEMPT_ID && phase === 'NEW_PREPARING') phase = 'NEW_READY'
      else throw new Error('unexpected prepare')
      events.push('prepare')
      return { ok: true as const, value: { requestId: preparation.requestId, intentType: 'system.workspace.prepare.result.record' as const, sessionVersion: 3, flowId: FLOW_ID, taskRunId: preparation.attemptId === ATTEMPT_ID ? TASK_RUN_ID : NEXT_TASK_RUN_ID, attemptId: preparation.attemptId } }
    }),
  } as unknown as CollaborationHubApplicationV1

  return {
    application,
    finishOldAndOfferNext() {
      if (phase !== 'OLD_RUNNING') throw new Error('old task is not running')
      phase = 'OLD_SUCCEEDED'
    },
  }
}

function fakeHub(events: string[]) {
  let attemptStatus: 'WORKSPACE_PREPARING' | 'READY' | 'RUNNING' | 'FAILED' | 'OUTCOME_UNKNOWN' | undefined
  let runtimeSession: string | undefined
  let schedules = 0

  const projection = (): SessionCollaborationProjectionM2BV1 => ({
    kind: 'SESSION_COLLABORATION_PROJECTION',
    version: 'm2b.v1',
    address: ADDRESS,
    sessionVersion: attemptStatus ? 2 : 1,
    sessionMode: 'CODING',
    authoritativeMode: 'CODING',
    reserved: false,
    activeFlow: { flowId: FLOW_ID, status: 'PLAN_ACTIVE', activeRevisionId: null, objective: '执行任务' },
    activeRevision: null,
    taskSpecs: [{
      taskSpecId: 'xhbts_task' as never,
      taskKey: 'task',
      title: '当前任务',
      summary: '只调整受控文件中的实现',
      dependsOn: [],
      unavailableReason: 'AGENT_DISABLED_M2A',
    }],
    taskRuns: [{
      taskRunId: TASK_RUN_ID,
      taskSpecId: 'xhbts_task' as never,
      taskKey: 'task',
      status: attemptStatus
        ? attemptStatus === 'OUTCOME_UNKNOWN' || attemptStatus === 'FAILED'
          ? attemptStatus
          : 'RUNNING'
        : 'BLOCKED',
      ...(attemptStatus ? { attemptId: ATTEMPT_ID } : {}),
    }],
    attempts: attemptStatus ? [{
      attemptId: ATTEMPT_ID,
      taskRunId: TASK_RUN_ID,
      status: attemptStatus,
      ...(runtimeSession ? { runtimeSessionId: runtimeSession } : {}),
      workspaceReceiptId: 'workspace-receipt-1' as never,
    }] : [],
    history: [],
    availableActions: attemptStatus ? ['flow.cancel'] : ['flow.cancel', 'execution.next.confirm'],
  })

  const executeSystem = vi.fn(async (command: HubSystemCommandRequestM2BV1) => {
    switch (command.intent.type) {
      case 'system.schedule':
        events.push('schedule')
        schedules += 1
        attemptStatus = 'WORKSPACE_PREPARING'
        return { ok: true as const, value: {
          requestId: command.requestId,
          intentType: command.intent.type,
          sessionVersion: 2,
          flowId: FLOW_ID,
          taskRunId: TASK_RUN_ID,
          attemptId: ATTEMPT_ID,
        } }
      case 'system.agent.report.record':
        events.push('dispatch')
        attemptStatus = 'RUNNING'
        runtimeSession = 'runtime-1'
        return { ok: true as const, value: {
          requestId: command.requestId,
          intentType: command.intent.type,
          sessionVersion: 4,
          flowId: FLOW_ID,
          taskRunId: TASK_RUN_ID,
          attemptId: ATTEMPT_ID,
        } }
      case 'system.agent.outcome.record':
        events.push('outcome-unknown')
        attemptStatus = command.intent.outcome === 'FAILED' ? 'FAILED' : 'OUTCOME_UNKNOWN'
        runtimeSession = command.intent.runtimeSessionId
        return { ok: true as const, value: {
          requestId: command.requestId,
          intentType: command.intent.type,
          sessionVersion: 5,
          flowId: FLOW_ID,
          taskRunId: TASK_RUN_ID,
          attemptId: ATTEMPT_ID,
        } }
      default:
        throw new Error(`unexpected ${command.intent.type}`)
    }
  })
  const application = {
    observeM2B: vi.fn(async () => ({ ok: true as const, value: projection() })),
    executeSystem,
    prepareNextWorkspace: vi.fn(async (_address, request) => {
      events.push('prepare')
      attemptStatus = 'READY'
      return { ok: true as const, value: {
        requestId: request.requestId,
        intentType: 'system.workspace.prepare.result.record' as const,
        sessionVersion: 3,
        flowId: FLOW_ID,
        taskRunId: TASK_RUN_ID,
        attemptId: ATTEMPT_ID,
      } }
    }),
  } as unknown as CollaborationHubApplicationV1

  return {
    application,
    scheduleCount: () => schedules,
    runtimeSessionId: () => runtimeSession,
    systemCommands: () => executeSystem.mock.calls.map(([command]) => command),
  }
}

function permissionRequestedEvent(): Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> {
  return {
    type: 'PERMISSION_REQUESTED',
    permissionRequestId: 'write-perm-1',
    runtimeSessionId: 'runtime-1',
    sequence: 2,
    challengeDigest: 'sha256:challenge',
    decisionRequired: 'ALLOW_ONCE_OR_DENY',
    permissionPurpose: 'FILE_WRITE',
    scope: {
      projectId: ADDRESS.projectId,
      sessionKey: ADDRESS.sessionKey,
      sessionMode: 'CODING',
      flowId: FLOW_ID,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      attemptDigest: 'sha256:attempt',
      workspaceReceiptId: 'workspace-receipt-1',
      workspaceReceiptDigest: 'sha256:workspace-receipt',
    },
  }
}

function request(file: { relativePath: string } = { relativePath: 'src/task.ts' }): XiaoguiTaskExecutionStartRequestV1 {
  return {
    address: ADDRESS,
    flowId: FLOW_ID,
    prompt: '完成当前任务',
    files: [{ operation: 'MODIFY', relativePath: file.relativePath }],
  }
}

async function tempDb(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-task-execution-'))
  roots.push(root)
  return join(root, 'hub.sqlite')
}
