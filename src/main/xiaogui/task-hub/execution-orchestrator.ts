import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import type {
  AgentFailureSignalV1,
  AttemptId,
  FlowId,
  HubAddressV1,
  HubSystemErrorCodeM2BV1,
  SessionCollaborationProjectionM2BV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import type {
  XiaoguiTaskExecutionErrorCodeV1,
  XiaoguiTaskExecutionFileSelectionV1,
  XiaoguiTaskExecutionStartOutcomeV1,
  XiaoguiTaskExecutionStartRequestV1,
  XiaoguiTaskExecutionStartResultV1,
} from '@shared/xiaogui-task-execution'

import type { CollaborationHubApplicationV1 } from './application'
import type { StageAttemptExecutionInputV1 } from './attempt-execution-input'
import type {
  AttemptFileGrantV1,
  AttemptFileScopeResolverV1,
} from './attempt-workspace'
import { PRIVATE_RUNTIME_PAYLOAD_MAX_BYTES } from './private-payload-vault'
import type { RuntimeOutcomeMonitorV1 } from './runtime-outcome-monitor'
import type {
  RuntimePermissionDecisionFactoryV1,
  RuntimePermissionRequestEventV1,
} from './runtime-outcome-monitor'
import type { TaskVerificationCoordinatorV1 } from './task-verification-coordinator'
import type { RuntimeOutcomeV1 } from '@shared/xiaogui-agent-runtime'

type ExecutionSagaPhaseV1 =
  | 'ACCEPTED'
  | 'SCHEDULED'
  | 'INPUT_STAGED'
  | 'WORKSPACE_READY'
  | 'DISPATCHING'
  | 'RUNTIME_ACTIVE'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN'
  | 'SETTLED'

interface ExecutionSagaRowV1 {
  operation_id: string
  project_id: HubAddressV1['projectId']
  session_key: HubAddressV1['sessionKey']
  flow_id: FlowId
  input_digest: string
  prompt_blob: Uint8Array | null
  grants_json: string | null
  phase: ExecutionSagaPhaseV1
  task_run_id: TaskRunId | null
  attempt_id: AttemptId | null
  last_safe_code: string | null
}

interface CanonicalExecutionInputV1 {
  readonly address: HubAddressV1
  readonly flowId: FlowId
  readonly prompt: string
  readonly files: readonly XiaoguiTaskExecutionFileSelectionV1[]
  readonly inputDigest: string
}

export interface TaskExecutionInputStageV1 {
  stageAttemptInput(input: StageAttemptExecutionInputV1): unknown
}

export interface XiaoguiTaskExecutionOrchestratorOptionsV1 {
  readonly dbPath: string
  readonly application: CollaborationHubApplicationV1
  readonly inputStage: TaskExecutionInputStageV1
  readonly fileScopeResolver: AttemptFileScopeResolverV1
  readonly runtimeMonitor?: RuntimeOutcomeMonitorV1
  readonly runtimeBindingRestorer?: (input: { attemptId: AttemptId; runtimeSessionId: string }) => Promise<{ ok: true } | { ok: false; reasonCode: string }>
  readonly verificationCoordinator?: TaskVerificationCoordinatorV1
  readonly now?: () => string
  readonly idFactory?: (prefix: string) => string
}

/**
 * Main-process-only deep Module for one user-confirmed CODING execution.
 * Its single product Interface hides system intents, private input staging,
 * worktree preparation, dispatch, persistence, and restart fail-closed rules.
 */
export class XiaoguiTaskExecutionOrchestratorV1 {
  private readonly saga: SqliteTaskExecutionSagaStoreV1
  private readonly inFlight = new Map<
    string,
    { inputDigest: string; outcome: Promise<XiaoguiTaskExecutionStartOutcomeV1> }
  >()
  private recovery: Promise<void> | undefined
  private closed = false

  constructor(private readonly options: XiaoguiTaskExecutionOrchestratorOptionsV1) {
    if ((options.runtimeMonitor === undefined) !== (options.verificationCoordinator === undefined)) {
      throw new Error('XIAOGUI_TASK_EXECUTION_RUNTIME_VERIFICATION_PAIR_REQUIRED')
    }
    this.saga = new SqliteTaskExecutionSagaStoreV1(options.dbPath, () => this.now())
  }

  async start(input: XiaoguiTaskExecutionStartRequestV1): Promise<XiaoguiTaskExecutionStartOutcomeV1> {
    if (this.closed) return executionError('INTERNAL')
    const canonical = canonicalExecutionInput(input)
    if (!canonical.ok) return canonical.outcome
    await this.recover()
    if (this.closed) return executionError('INTERNAL')

    const key = flowKey(canonical.value.address, canonical.value.flowId)
    const running = this.inFlight.get(key)
    if (running) {
      return running.inputDigest === canonical.value.inputDigest
        ? running.outcome
        : executionError('EXECUTION_IN_PROGRESS')
    }
    const outcome = this.startOnce(canonical.value)
    this.inFlight.set(key, { inputDigest: canonical.value.inputDigest, outcome })
    try {
      return await outcome
    } finally {
      if (this.inFlight.get(key)?.outcome === outcome) this.inFlight.delete(key)
    }
  }

  recover(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.recovery ??= this.recoverOnce()
    return this.recovery
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.allSettled([
      ...(this.recovery ? [this.recovery] : []),
      ...[...this.inFlight.values()].map(({ outcome }) => outcome),
    ])
    await this.options.runtimeMonitor?.close()
    await this.options.verificationCoordinator?.close()
    this.saga.close()
  }

  private async startOnce(input: CanonicalExecutionInputV1): Promise<XiaoguiTaskExecutionStartOutcomeV1> {
    const projection = await this.options.application.observeM2B(input.address)
    if (!projection.ok) return executionError('SESSION_SCOPE_MISMATCH')
    if (projection.value.authoritativeMode === 'DESIGN') return executionError('DESIGN_RESERVED')
    if (projection.value.authoritativeMode === 'WORK') return executionError('WORK_NOT_SUPPORTED')
    if (
      projection.value.activeFlow?.flowId !== input.flowId ||
      projection.value.activeFlow.status !== 'PLAN_ACTIVE'
    ) return executionError('FLOW_NOT_READY')

    let existing = this.saga.active(input.address, input.flowId)
    if (existing && existing.input_digest !== input.inputDigest) {
      this.settleFromAuthoritativeTerminal(existing, projection.value)
      existing = this.saga.active(input.address, input.flowId)
    }
    if (existing) {
      if (existing.input_digest !== input.inputDigest) return executionError('EXECUTION_IN_PROGRESS')
      return this.run(existing, false)
    }
    if (!projection.value.availableActions.includes('execution.next.confirm')) {
      return executionError('FLOW_NOT_READY')
    }

    let grants: readonly AttemptFileGrantV1[]
    try {
      grants = await this.options.fileScopeResolver.resolveApprovedFiles(
        input.address.projectId,
        input.files,
      )
    } catch {
      return executionError('EXECUTION_INPUT_INVALID')
    }
    let operation: ExecutionSagaRowV1
    try {
      operation = this.saga.acquire(input, grants, this.id('xhbe'))
    } catch (error) {
      return error instanceof ActiveExecutionConflict
        ? executionError('EXECUTION_IN_PROGRESS')
        : executionError('INTERNAL')
    }
    return this.run(operation, false)
  }

  private settleFromAuthoritativeTerminal(
    operation: ExecutionSagaRowV1,
    projection: SessionCollaborationProjectionM2BV1,
  ): void {
    if (!operation.task_run_id || !operation.attempt_id) return
    const attempt = projection.attempts.find(
      (candidate) =>
        candidate.attemptId === operation.attempt_id &&
        candidate.taskRunId === operation.task_run_id,
    )
    switch (attempt?.status) {
      case 'SUCCEEDED':
        this.saga.advance(operation.operation_id, 'SETTLED')
        return
      case 'FAILED':
      case 'INTERRUPTED':
      case 'CANCELLED':
        this.saga.advance(operation.operation_id, 'FAILED', { lastSafeCode: attempt.status })
        return
      case 'OUTCOME_UNKNOWN':
        this.saga.advance(operation.operation_id, 'OUTCOME_UNKNOWN', {
          lastSafeCode: 'OUTCOME_UNKNOWN',
        })
    }
  }

  private async run(
    initial: ExecutionSagaRowV1,
    recovering: boolean,
  ): Promise<XiaoguiTaskExecutionStartOutcomeV1> {
    let operation = this.saga.byId(initial.operation_id) ?? initial
    if (operation.phase === 'OUTCOME_UNKNOWN') return executionError('OUTCOME_UNKNOWN')
    if (operation.phase === 'FAILED') return executionError('WORKSPACE_PREPARATION_FAILED')

    if (operation.attempt_id) {
      const authority = await this.authority(operation)
      if (!authority.ok) return authority.outcome
      const status = authority.result.attempt.status
      if (status === 'OUTCOME_UNKNOWN') {
        this.saga.advance(operation.operation_id, 'OUTCOME_UNKNOWN', { lastSafeCode: 'OUTCOME_UNKNOWN' })
        return executionError('OUTCOME_UNKNOWN')
      }
      if (status === 'FAILED' || status === 'INTERRUPTED' || status === 'CANCELLED') {
        this.saga.advance(operation.operation_id, 'FAILED', { lastSafeCode: status })
        return executionError(operation.phase === 'DISPATCHING' || operation.phase === 'RUNTIME_ACTIVE'
          ? 'AGENT_UNAVAILABLE'
          : 'WORKSPACE_PREPARATION_FAILED')
      }
      if (status === 'SUCCEEDED') {
        this.saga.advance(operation.operation_id, 'SETTLED')
        return { ok: true, value: authority.result }
      }
      if (status === 'VERIFYING') {
        this.saga.advance(operation.operation_id, 'RUNTIME_ACTIVE')
        return { ok: true, value: authority.result }
      }
      if (status === 'STARTING' || status === 'RUNNING') {
        if (await this.registerRuntimeWatcher(operation, authority.result)) {
          this.saga.advance(operation.operation_id, 'RUNTIME_ACTIVE')
          return { ok: true, value: authority.result }
        }
        if (recovering || operation.phase === 'DISPATCHING') {
          return this.markOutcomeUnknown(operation, authority.result)
        }
        this.saga.advance(operation.operation_id, 'RUNTIME_ACTIVE')
        return { ok: true, value: authority.result }
      }
      if (status === 'READY') {
        this.saga.advance(operation.operation_id, 'WORKSPACE_READY')
        operation = this.saga.byId(operation.operation_id) ?? operation
      }
    }

    if (operation.phase === 'ACCEPTED') {
      const scheduled = await this.options.application.executeSystem({
        contractVersion: 'm2b.v1',
        address: addressOf(operation),
        trustedActor: { kind: 'main-process-system' },
        requestId: stageRequestId(operation.operation_id, 'schedule'),
        intent: { type: 'system.schedule', flowId: operation.flow_id },
      })
      if (!scheduled.ok) {
        this.saga.noteFailure(operation.operation_id, scheduled.error.code)
        return executionError(mapSystemError(scheduled.error.code))
      }
      if (!scheduled.value.taskRunId || !scheduled.value.attemptId) return executionError('INTERNAL')
      this.saga.advance(operation.operation_id, 'SCHEDULED', {
        taskRunId: scheduled.value.taskRunId,
        attemptId: scheduled.value.attemptId,
      })
      operation = this.saga.byId(operation.operation_id)!
    }

    if (operation.phase === 'SCHEDULED') {
      if (!operation.attempt_id) return executionError('INTERNAL')
      try {
        const stagedProjection = await this.options.application.observeM2B(addressOf(operation))
        if (!stagedProjection.ok) throw new Error('TASK_EXECUTION_PLAN_CONTEXT_MISSING')
        this.options.inputStage.stageAttemptInput({
          attemptId: operation.attempt_id,
          projectId: operation.project_id,
          sessionKey: operation.session_key,
          promptBytes: composePrivateExecutionPrompt(operation, stagedProjection.value),
          grants: privateGrants(operation),
        })
      } catch {
        await this.closeWorkspaceFailure(operation)
        this.saga.advance(operation.operation_id, 'FAILED', { lastSafeCode: 'ATTEMPT_INPUT_STAGE_FAILED' })
        return executionError('WORKSPACE_PREPARATION_FAILED')
      }
      this.saga.advance(operation.operation_id, 'INPUT_STAGED', { clearPrivateInput: true })
      operation = this.saga.byId(operation.operation_id)!
    }

    if (operation.phase === 'INPUT_STAGED') {
      if (!operation.attempt_id) return executionError('INTERNAL')
      const prepared = await this.options.application.prepareNextWorkspace(addressOf(operation), {
        requestId: stageRequestId(operation.operation_id, 'workspace'),
        attemptId: operation.attempt_id,
      })
      if (!prepared.ok) {
        this.saga.noteFailure(operation.operation_id, prepared.error.code)
        return executionError(mapSystemError(prepared.error.code))
      }
      const authority = await this.authority(operation)
      if (!authority.ok) return authority.outcome
      if (authority.result.attempt.status !== 'READY') {
        this.saga.advance(operation.operation_id, 'FAILED', {
          lastSafeCode: authority.result.attempt.status,
        })
        return executionError('WORKSPACE_PREPARATION_FAILED')
      }
      this.saga.advance(operation.operation_id, 'WORKSPACE_READY')
      operation = this.saga.byId(operation.operation_id)!
    }

    if (operation.phase === 'WORKSPACE_READY') {
      if (!operation.task_run_id || !operation.attempt_id) return executionError('INTERNAL')
      const taskRunId = operation.task_run_id
      const attemptId = operation.attempt_id
      this.saga.advance(operation.operation_id, 'DISPATCHING')
      operation = this.saga.byId(operation.operation_id)!
      const dispatched = await this.options.application.executeSystem({
        contractVersion: 'm2b.v1',
        address: addressOf(operation),
        trustedActor: { kind: 'main-process-system' },
        requestId: stageRequestId(operation.operation_id, 'dispatch'),
        intent: {
          type: 'system.agent.report.record',
          flowId: operation.flow_id,
          taskRunId,
          attemptId,
        },
      })
      if (!dispatched.ok) {
        const authority = await this.authority(operation)
        if (authority.ok && ['STARTING', 'RUNNING'].includes(authority.result.attempt.status)) {
          return this.markOutcomeUnknown(operation, authority.result)
        }
        this.saga.advance(operation.operation_id, 'WORKSPACE_READY', {
          lastSafeCode: dispatched.error.code,
        })
        return executionError(mapSystemError(dispatched.error.code))
      }
    }

    const authority = await this.authority(operation)
    if (!authority.ok) return authority.outcome
    switch (authority.result.attempt.status) {
      case 'RUNNING':
        await this.registerRuntimeWatcher(operation, authority.result)
        this.saga.advance(operation.operation_id, 'RUNTIME_ACTIVE')
        return { ok: true, value: authority.result }
      case 'VERIFYING':
        this.saga.advance(operation.operation_id, 'RUNTIME_ACTIVE')
        return { ok: true, value: authority.result }
      case 'SUCCEEDED':
        this.saga.advance(operation.operation_id, 'SETTLED')
        return { ok: true, value: authority.result }
      case 'OUTCOME_UNKNOWN':
        this.saga.advance(operation.operation_id, 'OUTCOME_UNKNOWN', { lastSafeCode: 'OUTCOME_UNKNOWN' })
        return executionError('OUTCOME_UNKNOWN')
      case 'FAILED':
      case 'INTERRUPTED':
      case 'CANCELLED':
        this.saga.advance(operation.operation_id, 'FAILED', {
          lastSafeCode: authority.result.attempt.status,
        })
        return executionError('AGENT_UNAVAILABLE')
      case 'STARTING':
        return this.markOutcomeUnknown(operation, authority.result)
      default:
        return executionError('INTERNAL')
    }
  }

  private async closeWorkspaceFailure(operation: ExecutionSagaRowV1): Promise<void> {
    if (!operation.attempt_id) return
    await this.options.application.prepareNextWorkspace(addressOf(operation), {
      requestId: stageRequestId(operation.operation_id, 'workspace'),
      attemptId: operation.attempt_id,
    })
  }

  private async markOutcomeUnknown(
    operation: ExecutionSagaRowV1,
    current: XiaoguiTaskExecutionStartResultV1,
  ): Promise<XiaoguiTaskExecutionStartOutcomeV1> {
    const receiptDigest = digestJson({
      operationId: operation.operation_id,
      attemptId: current.attempt.attemptId,
      reasonCode: 'MAIN_PROCESS_RESTART_RUNTIME_UNBOUND',
    })
    const outcome = await this.options.application.executeSystem({
      contractVersion: 'm2b.v1',
      address: addressOf(operation),
      trustedActor: { kind: 'main-process-system' },
      requestId: stageRequestId(operation.operation_id, 'restart-outcome-unknown'),
      intent: {
        type: 'system.agent.outcome.record',
        flowId: operation.flow_id,
        taskRunId: current.taskRun.taskRunId,
        attemptId: current.attempt.attemptId,
        runtimeSessionId: 'runtime-unbound',
        outcome: 'OUTCOME_UNKNOWN',
        receiptDigest,
      },
    })
    this.saga.advance(operation.operation_id, 'OUTCOME_UNKNOWN', {
      lastSafeCode: outcome.ok ? 'OUTCOME_UNKNOWN' : outcome.error.code,
    })
    return executionError('OUTCOME_UNKNOWN')
  }

  private async authority(operation: ExecutionSagaRowV1): Promise<
    | { ok: true; result: XiaoguiTaskExecutionStartResultV1 }
    | { ok: false; outcome: XiaoguiTaskExecutionStartOutcomeV1 }
  > {
    const projection = await this.options.application.observeM2B(addressOf(operation))
    if (!projection.ok) return { ok: false, outcome: executionError('SESSION_SCOPE_MISMATCH') }
    const result = executionResult(projection.value, operation.task_run_id, operation.attempt_id)
    return result
      ? { ok: true, result }
      : { ok: false, outcome: executionError('INTERNAL') }
  }

  private async recoverOnce(): Promise<void> {
    try {
      await this.options.verificationCoordinator?.recoverPending()
    } catch {
      // Saga recovery remains fail-closed if verification recovery itself fails.
    }
    for (const operation of this.saga.activeOperations()) {
      if (this.closed || !operation.attempt_id) continue
      try {
        await this.run(operation, true)
      } catch {
        this.saga.noteFailure(operation.operation_id, 'RECOVERY_FAILED')
      }
    }
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  private id(prefix: string): string {
    return this.options.idFactory?.(prefix) ?? `${prefix}_${randomUUID()}`
  }

  private async registerRuntimeWatcher(
    operation: ExecutionSagaRowV1,
    current: XiaoguiTaskExecutionStartResultV1,
  ): Promise<boolean> {
    const runtimeSessionId = current.attempt.runtimeSessionId
    if (!runtimeSessionId || !this.options.runtimeMonitor) return false
    const restored = await this.restoreRuntimeBinding(current.attempt.attemptId, runtimeSessionId)
    if (!restored) return false
    const address = addressOf(operation)
    const flowId = operation.flow_id
    const taskRunId = current.taskRun.taskRunId
    const attemptId = current.attempt.attemptId
    this.options.runtimeMonitor.watch(runtimeSessionId, async (outcome) => {
      if (this.closed) return
      if (outcome.state === 'SUCCEEDED') {
        const coordinator = this.options.verificationCoordinator
        if (!coordinator) return
        const verified = await coordinator.handleSucceeded({
          address,
          flowId,
          taskRunId,
          attemptId,
          outcome,
          createdAt: this.now(),
        })
        if (!verified.ok) {
          await this.recordVerificationStartFailure(address, flowId, taskRunId, attemptId, outcome, verified.reasonCode)
        }
      } else {
        await this.recordRuntimeTerminal(address, flowId, taskRunId, attemptId, outcome)
      }
      await this.settleOperationFromAuthority(operation.operation_id)
    }, this.runtimePermissionDecisionFactory(operation, current, runtimeSessionId))
    return true
  }

  private async restoreRuntimeBinding(attemptId: AttemptId, runtimeSessionId: string): Promise<boolean> {
    if (!this.options.runtimeBindingRestorer) return true
    try {
      const restored = await this.options.runtimeBindingRestorer({ attemptId, runtimeSessionId })
      return restored.ok
    } catch {
      return false
    }
  }

  private runtimePermissionDecisionFactory(
    operation: ExecutionSagaRowV1,
    current: XiaoguiTaskExecutionStartResultV1,
    runtimeSessionId: string,
  ): RuntimePermissionDecisionFactoryV1 {
    return (event) => {
      assertPermissionEventScope(operation, current, runtimeSessionId, event)
      const binding = {
        domain: 'xiaogui.task-execution.scope-approval-proof.v1',
        operationId: operation.operation_id,
        inputDigest: operation.input_digest,
        runtimeSessionId,
        permissionRequestId: event.permissionRequestId,
        challengeDigest: event.challengeDigest,
        scope: event.scope,
      }
      const decisionKey = hashHex(JSON.stringify(binding))
      if (event.permissionPurpose !== 'APPROVED_FILE_TOOL' && event.permissionPurpose !== 'FILE_WRITE') {
        return {
          type: 'DENY',
          permissionRequestId: event.permissionRequestId,
          challengeDigest: event.challengeDigest,
          decisionRequestId: `xhbrpd_${decisionKey.slice(0, 48)}`,
          scope: event.scope,
          runtimeSessionId,
          reasonCode: 'UNAPPROVED_PERMISSION_PURPOSE',
        }
      }
      return {
        type: 'ALLOW_ONCE',
        permissionRequestId: event.permissionRequestId,
        challengeDigest: event.challengeDigest,
        decisionRequestId: `xhbrpd_${decisionKey.slice(0, 48)}`,
        scope: event.scope,
        runtimeSessionId,
        proofId: `xhbrpp_${decisionKey.slice(0, 48)}`,
        proofDigest: digestJson(binding),
      }
    }
  }

  private async recordRuntimeTerminal(
    address: HubAddressV1,
    flowId: FlowId,
    taskRunId: TaskRunId,
    attemptId: AttemptId,
    outcome: Exclude<RuntimeOutcomeV1, { state: 'SUCCEEDED' }>,
  ): Promise<void> {
    const mapped = mapRuntimeTerminalOutcome(outcome)
    const base = {
      type: 'system.agent.outcome.record' as const,
      flowId,
      taskRunId,
      attemptId,
      runtimeSessionId: outcome.runtimeSessionId,
      receiptDigest: mapped.receiptDigest,
    }
    await this.options.application.executeSystem({
      contractVersion: 'm2b.v1',
      address,
      trustedActor: { kind: 'main-process-system' },
      requestId: stageRequestId(`${attemptId}:${mapped.receiptDigest}`, 'runtime-terminal'),
      intent: mapped.outcome === 'FAILED'
        ? { ...base, outcome: 'FAILED', failure: mapped.failure! }
        : { ...base, outcome: mapped.outcome },
    })
  }

  private async recordVerificationStartFailure(
    address: HubAddressV1,
    flowId: FlowId,
    taskRunId: TaskRunId,
    attemptId: AttemptId,
    outcome: Extract<RuntimeOutcomeV1, { state: 'SUCCEEDED' }>,
    reasonCode: string,
  ): Promise<void> {
    const current = await this.options.application.observeM2B(address)
    if (!current.ok) return
    const attempt = current.value.attempts.find((candidate) => candidate.attemptId === attemptId)
    if (!attempt || attempt.status !== 'RUNNING') return

    const receiptDigest = reasonCode === 'TASK_VERIFICATION_CAPTURE_FAILED'
      ? outcome.receiptDigest
      : digestJson({
          runtimeSessionId: outcome.runtimeSessionId,
          runtimeReceiptDigest: outcome.receiptDigest,
          reasonCode,
          purpose: 'task-verification-start-failed.v1',
        })
    const intent = reasonCode === 'TASK_VERIFICATION_CAPTURE_FAILED'
      ? {
          type: 'system.agent.outcome.record' as const,
          flowId,
          taskRunId,
          attemptId,
          runtimeSessionId: outcome.runtimeSessionId,
          outcome: 'FAILED' as const,
          receiptDigest,
          failure: {
            kind: 'AGENT_FAILURE' as const,
            failureClass: 'PROTOCOL' as const,
            safeCode: 'CANDIDATE_AUDIT_FAILED' as const,
            receiptDigest,
          },
        }
      : {
          type: 'system.agent.outcome.record' as const,
          flowId,
          taskRunId,
          attemptId,
          runtimeSessionId: outcome.runtimeSessionId,
          outcome: 'OUTCOME_UNKNOWN' as const,
          receiptDigest,
        }
    await this.options.application.executeSystem({
      contractVersion: 'm2b.v1',
      address,
      trustedActor: { kind: 'main-process-system' },
      requestId: stageRequestId(`${attemptId}:${receiptDigest}`, 'verification-start-failed'),
      intent,
    })
  }

  private async settleOperationFromAuthority(operationId: string): Promise<void> {
    const operation = this.saga.byId(operationId)
    if (!operation || !operation.attempt_id || !operation.task_run_id || this.closed) return
    const authority = await this.authority(operation)
    if (!authority.ok) return
    const status = authority.result.attempt.status
    if (status === 'SUCCEEDED') {
      this.saga.advance(operation.operation_id, 'SETTLED')
    } else if (status === 'FAILED' || status === 'INTERRUPTED' || status === 'CANCELLED') {
      this.saga.advance(operation.operation_id, 'FAILED', { lastSafeCode: status })
    } else if (status === 'OUTCOME_UNKNOWN') {
      this.saga.advance(operation.operation_id, 'OUTCOME_UNKNOWN', { lastSafeCode: 'OUTCOME_UNKNOWN' })
    }
  }
}

class SqliteTaskExecutionSagaStoreV1 {
  private readonly db: DatabaseSync

  constructor(dbPath: string, private readonly now: () => string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('pragma foreign_keys = on')
    this.db.exec('pragma journal_mode = WAL')
    this.db.exec('pragma busy_timeout = 5000')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  active(address: HubAddressV1, flowId: FlowId): ExecutionSagaRowV1 | undefined {
    return this.db
      .prepare(`
        select operation_id, project_id, session_key, flow_id, input_digest,
               prompt_blob, grants_json, phase, task_run_id, attempt_id, last_safe_code
          from task_execution_sagas
         where project_id = ? and session_key = ? and flow_id = ?
           and phase not in ('FAILED', 'SETTLED')
         order by rowid desc limit 1
      `)
      .get(address.projectId, address.sessionKey, flowId) as ExecutionSagaRowV1 | undefined
  }

  activeOperations(): ExecutionSagaRowV1[] {
    return this.db
      .prepare(`
        select operation_id, project_id, session_key, flow_id, input_digest,
               prompt_blob, grants_json, phase, task_run_id, attempt_id, last_safe_code
          from task_execution_sagas
         where phase not in ('FAILED', 'SETTLED')
         order by rowid
      `)
      .all() as unknown as ExecutionSagaRowV1[]
  }

  byId(operationId: string): ExecutionSagaRowV1 | undefined {
    return this.db
      .prepare(`
        select operation_id, project_id, session_key, flow_id, input_digest,
               prompt_blob, grants_json, phase, task_run_id, attempt_id, last_safe_code
          from task_execution_sagas where operation_id = ?
      `)
      .get(operationId) as ExecutionSagaRowV1 | undefined
  }

  acquire(
    input: CanonicalExecutionInputV1,
    grants: readonly AttemptFileGrantV1[],
    operationId: string,
  ): ExecutionSagaRowV1 {
    this.db.exec('begin immediate')
    try {
      const existing = this.active(input.address, input.flowId)
      if (existing) {
        this.db.exec('commit')
        if (existing.input_digest !== input.inputDigest) throw new ActiveExecutionConflict()
        return existing
      }
      const now = this.now()
      this.db.prepare(`
        insert into task_execution_sagas (
          operation_id, project_id, session_key, flow_id, input_digest,
          prompt_blob, grants_json, phase, task_run_id, attempt_id,
          last_safe_code, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', null, null, null, ?, ?)
      `).run(
        operationId,
        input.address.projectId,
        input.address.sessionKey,
        input.flowId,
        input.inputDigest,
        Buffer.from(input.prompt, 'utf8'),
        JSON.stringify(grants),
        now,
        now,
      )
      this.db.exec('commit')
      return this.byId(operationId)!
    } catch (error) {
      rollbackQuietly(this.db)
      throw error
    }
  }

  advance(
    operationId: string,
    phase: ExecutionSagaPhaseV1,
    update: {
      taskRunId?: TaskRunId
      attemptId?: AttemptId
      lastSafeCode?: string
      clearPrivateInput?: boolean
    } = {},
  ): void {
    this.db.prepare(`
      update task_execution_sagas
         set phase = ?,
             task_run_id = coalesce(?, task_run_id),
             attempt_id = coalesce(?, attempt_id),
             last_safe_code = ?,
             prompt_blob = case when ? then null else prompt_blob end,
             grants_json = case when ? then null else grants_json end,
             updated_at = ?
       where operation_id = ?
    `).run(
      phase,
      update.taskRunId ?? null,
      update.attemptId ?? null,
      update.lastSafeCode ?? null,
      update.clearPrivateInput ? 1 : 0,
      update.clearPrivateInput ? 1 : 0,
      this.now(),
      operationId,
    )
  }

  noteFailure(operationId: string, safeCode: string): void {
    this.db
      .prepare('update task_execution_sagas set last_safe_code = ?, updated_at = ? where operation_id = ?')
      .run(safeCode, this.now(), operationId)
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists task_execution_sagas (
        operation_id text primary key,
        project_id text not null,
        session_key text not null,
        flow_id text not null,
        input_digest text not null,
        prompt_blob blob,
        grants_json text,
        phase text not null,
        task_run_id text,
        attempt_id text,
        last_safe_code text,
        created_at text not null,
        updated_at text not null
      );
      create unique index if not exists task_execution_sagas_one_active_flow
        on task_execution_sagas(project_id, session_key, flow_id)
        where phase not in ('FAILED', 'SETTLED');
    `)
  }
}

class ActiveExecutionConflict extends Error {}

function canonicalExecutionInput(
  input: XiaoguiTaskExecutionStartRequestV1,
):
  | { ok: true; value: CanonicalExecutionInputV1 }
  | { ok: false; outcome: XiaoguiTaskExecutionStartOutcomeV1 } {
  if (
    typeof input !== 'object' ||
    input === null ||
    !isExactKeySet(input as unknown as Record<string, unknown>, ['address', 'flowId', 'prompt', 'files']) ||
    typeof input.address !== 'object' ||
    input.address === null ||
    !isExactKeySet(input.address as unknown as Record<string, unknown>, ['projectId', 'sessionKey']) ||
    !/^xgp1_[0-9a-f]{64}$/.test(input.address.projectId) ||
    !/^xgs1_[0-9a-f]{64}$/.test(input.address.sessionKey) ||
    typeof input.flowId !== 'string' ||
    input.flowId.length === 0 ||
    input.flowId.length > 256 ||
    input.flowId !== input.flowId.trim() ||
    typeof input.prompt !== 'string' ||
    input.prompt.trim().length === 0 ||
    Buffer.byteLength(input.prompt, 'utf8') > PRIVATE_RUNTIME_PAYLOAD_MAX_BYTES ||
    !Array.isArray(input.files) ||
    input.files.length === 0 ||
    input.files.length > 256
  ) return { ok: false, outcome: executionError('EXECUTION_INPUT_INVALID') }

  const files: XiaoguiTaskExecutionFileSelectionV1[] = []
  for (const file of input.files) {
    if (
      typeof file !== 'object' ||
      file === null ||
      !isExactKeySet(file as unknown as Record<string, unknown>, ['operation', 'relativePath']) ||
      (file.operation !== 'MODIFY' && file.operation !== 'CREATE') ||
      typeof file.relativePath !== 'string' ||
      file.relativePath.length === 0 ||
      file.relativePath.length > 1024 ||
      file.relativePath !== file.relativePath.trim()
    ) return { ok: false, outcome: executionError('EXECUTION_INPUT_INVALID') }
    files.push({ operation: file.operation, relativePath: file.relativePath })
  }
  const canonicalFiles = [...files].sort(
    (left, right) =>
      left.relativePath.localeCompare(right.relativePath) ||
      left.operation.localeCompare(right.operation),
  )
  const inputDigest = digestJson({
    address: input.address,
    flowId: input.flowId,
    promptDigest: digestBytes(Buffer.from(input.prompt, 'utf8')),
    files: canonicalFiles,
  })
  return {
    ok: true,
    value: {
      address: input.address,
      flowId: input.flowId,
      prompt: input.prompt,
      files: canonicalFiles,
      inputDigest,
    },
  }
}

function executionResult(
  projection: SessionCollaborationProjectionM2BV1,
  taskRunId: TaskRunId | null,
  attemptId: AttemptId | null,
): XiaoguiTaskExecutionStartResultV1 | undefined {
  if (!taskRunId || !attemptId) return undefined
  const taskRun = projection.taskRuns.find((candidate) => candidate.taskRunId === taskRunId)
  const attempt = projection.attempts.find((candidate) => candidate.attemptId === attemptId)
  return taskRun && attempt ? { taskRun, attempt } : undefined
}

function addressOf(operation: ExecutionSagaRowV1): HubAddressV1 {
  return { projectId: operation.project_id, sessionKey: operation.session_key }
}

function privatePrompt(operation: ExecutionSagaRowV1): Buffer {
  if (!operation.prompt_blob) throw new Error('TASK_EXECUTION_PRIVATE_INPUT_MISSING')
  return Buffer.from(operation.prompt_blob)
}

function composePrivateExecutionPrompt(
  operation: ExecutionSagaRowV1,
  projection: SessionCollaborationProjectionM2BV1,
): Buffer {
  if (
    projection.authoritativeMode !== 'CODING' ||
    projection.activeFlow?.flowId !== operation.flow_id ||
    !operation.task_run_id
  ) throw new Error('TASK_EXECUTION_PLAN_CONTEXT_MISSING')

  const taskRun = projection.taskRuns.find((candidate) => candidate.taskRunId === operation.task_run_id)
  const taskSpec = taskRun
    ? projection.taskSpecs.find((candidate) => candidate.taskSpecId === taskRun.taskSpecId)
    : undefined
  if (!taskRun || !taskSpec) throw new Error('TASK_EXECUTION_PLAN_CONTEXT_MISSING')

  const userPrompt = privatePrompt(operation).toString('utf8')
  const grants = privateGrants(operation)
  const approvedFiles = grants.map((grant) => (
    `- ${grant.operation === 'MODIFY' ? '修改' : '新建'}：${JSON.stringify(grant.relativePath)}`
  ))
  const prompt = [
    '你正在小规的受控 CODING 执行环境中完成一个已经由用户批准的任务。',
    '',
    `总目标：${projection.activeFlow.objective}`,
    `当前任务：${taskSpec.title}`,
    ...(taskSpec.summary ? [`任务说明：${taskSpec.summary}`] : []),
    `用户补充指令：${userPrompt}`,
    '',
    '已批准的文件范围（相对路径以当前任务工作树根目录为基准）：',
    ...approvedFiles,
    '',
    '执行要求：',
    '1. 请实际完成文件修改，不要只回复说明、建议或计划。',
    '2. 读取文件时使用 fs/read_text_file；写入文件时使用 fs/write_text_file。',
    '3. 只能修改或新建上面列出的文件，不得删除文件，也不得操作清单外文件。',
    '4. 不得调用终端命令，不得启动子智能体。',
    '5. 保持现有项目结构和未要求改变的行为；完成写入后结束本次任务。',
  ].join('\n')
  const bytes = Buffer.from(prompt, 'utf8')
  if (bytes.length > PRIVATE_RUNTIME_PAYLOAD_MAX_BYTES) {
    throw new Error('TASK_EXECUTION_PRIVATE_INPUT_TOO_LARGE')
  }
  return bytes
}

function privateGrants(operation: ExecutionSagaRowV1): readonly AttemptFileGrantV1[] {
  if (!operation.grants_json) throw new Error('TASK_EXECUTION_PRIVATE_INPUT_MISSING')
  return JSON.parse(operation.grants_json) as readonly AttemptFileGrantV1[]
}

function assertPermissionEventScope(
  operation: ExecutionSagaRowV1,
  current: XiaoguiTaskExecutionStartResultV1,
  runtimeSessionId: string,
  event: RuntimePermissionRequestEventV1,
): void {
  if (
    event.runtimeSessionId !== runtimeSessionId ||
    event.scope.projectId !== operation.project_id ||
    event.scope.sessionKey !== operation.session_key ||
    event.scope.sessionMode !== 'CODING' ||
    event.scope.flowId !== operation.flow_id ||
    event.scope.taskRunId !== current.taskRun.taskRunId ||
    event.scope.attemptId !== current.attempt.attemptId ||
    (current.attempt.workspaceReceiptId !== undefined &&
      event.scope.workspaceReceiptId !== current.attempt.workspaceReceiptId)
  ) throw new Error('RUNTIME_PERMISSION_SCOPE_MISMATCH')
}

function mapSystemError(code: HubSystemErrorCodeM2BV1): XiaoguiTaskExecutionErrorCodeV1 {
  switch (code) {
    case 'SESSION_SCOPE_MISMATCH':
      return 'SESSION_SCOPE_MISMATCH'
    case 'DESIGN_RESERVED':
      return 'DESIGN_RESERVED'
    case 'AGENT_UNAVAILABLE':
      return 'AGENT_UNAVAILABLE'
    case 'BASELINE_UNAVAILABLE':
    case 'BASELINE_CONFLICT':
      return 'BASELINE_UNAVAILABLE'
    case 'FLOW_NOT_FOUND':
    case 'ILLEGAL_TRANSITION':
    case 'STALE_SESSION_VERSION':
      return 'FLOW_NOT_READY'
    default:
      return 'INTERNAL'
  }
}

function executionError(code: XiaoguiTaskExecutionErrorCodeV1): XiaoguiTaskExecutionStartOutcomeV1 {
  return {
    ok: false,
    error: {
      code,
      messageKey: `xiaogui.hub.execution.${code.toLowerCase()}`,
      traceId: `xhbet_${randomUUID()}`,
    },
  }
}

function mapRuntimeTerminalOutcome(outcome: Exclude<RuntimeOutcomeV1, { state: 'SUCCEEDED' }>): {
  outcome: 'FAILED' | 'INTERRUPTED' | 'OUTCOME_UNKNOWN'
  receiptDigest: string
  failure?: AgentFailureSignalV1
} {
  if (outcome.state === 'FAILED') {
    const safeCode = outcome.reasonCode === 'RUNTIME_ADAPTER_ERROR'
      ? 'RUNTIME_ADAPTER_ERROR'
      : outcome.reasonCode === 'RUNTIME_SESSION_NOT_FOUND'
        ? 'RUNTIME_SESSION_NOT_FOUND'
        : outcome.reasonCode === 'RUNTIME_OUTCOME_SESSION_MISMATCH'
          ? 'RUNTIME_OUTCOME_SESSION_MISMATCH'
          : outcome.reasonCode.startsWith('RUNTIME_')
            ? 'RUNTIME_FAILED'
            : 'UNKNOWN_RUNTIME_FAILURE'
    return {
      outcome: 'FAILED',
      receiptDigest: outcome.receiptDigest,
      failure: { kind: 'AGENT_FAILURE', failureClass: safeCode === 'UNKNOWN_RUNTIME_FAILURE' ? 'UNKNOWN' : 'RUNTIME', safeCode, receiptDigest: outcome.receiptDigest },
    }
  }
  if (outcome.state === 'INTERRUPTED') {
    return { outcome: 'INTERRUPTED', receiptDigest: outcome.receiptDigest }
  }
  return { outcome: 'OUTCOME_UNKNOWN', receiptDigest: outcome.inspectHandleDigest }
}

function stageRequestId(operationId: string, stage: string): string {
  return `xhber_${hashHex(`${operationId}:${stage}`).slice(0, 48)}`
}

function flowKey(address: HubAddressV1, flowId: FlowId): string {
  return `${address.projectId}:${address.sessionKey}:${flowId}`
}

function digestJson(value: unknown): string {
  return digestBytes(Buffer.from(JSON.stringify(value), 'utf8'))
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function hashHex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isExactKeySet(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('rollback')
  } catch {
    // Preserve the original SQLite failure.
  }
}
