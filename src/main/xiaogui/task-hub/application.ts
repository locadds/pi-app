import { randomUUID } from 'node:crypto'

import {
  runtimeSelectionKey,
  type RuntimeAdapterSelectionV1,
  type RuntimeCapabilityV1,
  type RuntimeCreateOrResumeOutcomeV1,
  type RuntimeCreateOrResumeRequestV1,
  type RuntimeOutcomeV1,
  type RuntimeScopeBindingV1,
} from '@shared/xiaogui-agent-runtime'
import type {
  AgentFailureSignalV1,
  AttemptId,
  CollaborationHubActionV1,
  FlowId,
  HubAddressV1,
  HubCommandRequestV1,
  HubEventEnvelopeV1,
  HubOutcomeV1,
  HubReadEventsRequestV1,
  HubReadRequestV1,
  HubSystemCommandRequestM2BV1,
  HubSystemErrorCodeM2BV1,
  HubSystemOutcomeM2BV1,
  M2AUserIntentV1,
  PerformReceiptV1,
  PlanRevisionId,
  SessionCollaborationProjectionM2BV1,
  SessionCollaborationProjectionV1,
  TaskRunProjectionV1,
  TaskSpecId,
  TaskSpecProjectionV1,
  UserIntentRequestV1,
} from '@shared/xiaogui-collaboration-hub'
import type { SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { canonicalizePlanDraft, payloadDigest, type CanonicalPlanDraftV1 } from './digest'
import { hubError } from './errors'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'
import type { AgentRuntimeHostV1 } from '../agent-runtime/runtime-host'

export interface CollaborationHubApplicationOptionsV1 {
  lookup: SessionScopeLookupV1
  storeFactory: () => CollaborationHubSqliteStoreV1
  agentRuntime?: AgentRuntimeHostV1
  agentSelection?: RuntimeAdapterSelectionV1
  baselineProvider?: ExecutionBaselineProviderV1
  afterAgentDispatchStart?: (requestId: string) => void
  now?: () => string
  idFactory?: (prefix: string) => string
}

export interface ExecutionBaselineV1 {
  baselineId: string
  baselineTreeHash: string
  initialTargetFingerprint: string
  baselineDigest: string
}

export interface ExecutionBaselineProviderV1 {
  capture(input: { address: HubAddressV1; flowId: FlowId; planRevisionId: PlanRevisionId | null }): Promise<ExecutionBaselineV1>
}

export interface CollaborationHubApplicationV1 {
  execute(request: HubCommandRequestV1): Promise<HubOutcomeV1<PerformReceiptV1>>
  executeSystem(request: HubSystemCommandRequestM2BV1): Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>>
  read(address: HubAddressV1, request: HubReadRequestV1): Promise<HubOutcomeV1<SessionCollaborationProjectionV1>>
  readEvents(address: HubAddressV1, request?: HubReadEventsRequestV1): Promise<HubOutcomeV1<HubEventEnvelopeV1[]>>
  observe(address: HubAddressV1): Promise<HubOutcomeV1<SessionCollaborationProjectionV1>>
  observeM2B(address: HubAddressV1): Promise<HubOutcomeV1<SessionCollaborationProjectionM2BV1>>
  perform(address: HubAddressV1, request: UserIntentRequestV1): Promise<HubOutcomeV1<PerformReceiptV1>>
  close(): void
}

type ResolvedScope = HubOutcomeV1<{ mode: SessionMode }>

export class SqliteCollaborationHubApplicationV1 implements CollaborationHubApplicationV1 {
  private store: CollaborationHubSqliteStoreV1 | null = null

  constructor(private readonly options: CollaborationHubApplicationOptionsV1) {}

  async observe(address: HubAddressV1): Promise<HubOutcomeV1<SessionCollaborationProjectionV1>> {
    return this.read(address, { type: 'session.current' })
  }

  async observeM2B(address: HubAddressV1): Promise<HubOutcomeV1<SessionCollaborationProjectionM2BV1>> {
    try {
      const scope = await this.resolve(address)
      if (!scope.ok) return scope
      if (scope.value.mode === 'DESIGN') {
        return {
          ok: true,
          value: {
            ...reservedProjection(address, scope.value.mode),
            version: 'm2b.v1',
            taskRuns: [],
            attempts: [],
            availableActions: [],
          },
        }
      }
      const projection = this.getStore().readProjectionM2B(address) ?? {
        ...emptyProjection(address, scope.value.mode),
        version: 'm2b.v1' as const,
        taskRuns: [],
        attempts: [],
        availableActions: ['flow.start.with_draft'],
      }
      return { ok: true, value: projection }
    } catch {
      return hubError('INTERNAL')
    }
  }

  async read(address: HubAddressV1, request: HubReadRequestV1): Promise<HubOutcomeV1<SessionCollaborationProjectionV1>> {
    try {
    const scope = await this.resolve(address)
    if (!scope.ok) return scope
    if (scope.value.mode === 'DESIGN') {
      if (request.type === 'session.current') return { ok: true, value: reservedProjection(address, scope.value.mode) }
      return hubError('DESIGN_RESERVED')
    }
    const projection = this.getStore().readProjection(address) ?? emptyProjection(address, scope.value.mode)
    if (request.type === 'flow.by_id' && projection.activeFlow?.flowId !== request.flowId) {
      const history = projection.history.find((flow) => flow.flowId === request.flowId)
      if (!history) return hubError('FLOW_NOT_FOUND')
    }
    return { ok: true, value: projection }
    } catch {
      return hubError('INTERNAL')
    }
  }

  async readEvents(address: HubAddressV1, request: HubReadEventsRequestV1 = {}): Promise<HubOutcomeV1<HubEventEnvelopeV1[]>> {
    try {
    const scope = await this.resolve(address)
    if (!scope.ok) return scope
    if (scope.value.mode === 'DESIGN') return hubError('DESIGN_RESERVED')
    return { ok: true, value: this.getStore().readEvents(address, request) }
    } catch {
      return hubError('INTERNAL')
    }
  }

  async perform(address: HubAddressV1, request: UserIntentRequestV1): Promise<HubOutcomeV1<PerformReceiptV1>> {
    return this.execute({
      ...request,
      contractVersion: 'm2a.v1',
      address,
      trustedActor: { kind: 'main-process-user' },
    })
  }

  async execute(request: HubCommandRequestV1): Promise<HubOutcomeV1<PerformReceiptV1>> {
    try {
    if (request.contractVersion !== 'm2a.v1') return hubError('IPC_VERSION_UNSUPPORTED')
    const scope = await this.resolve(request.address)
    if (!scope.ok) return scope
    if (scope.value.mode === 'DESIGN') return hubError('DESIGN_RESERVED')
    switch (request.intent.type) {
      case 'flow.start.with_draft':
        return this.startWithDraft(request.address, scope.value.mode, request as HubCommandRequestV1 & { intent: Extract<M2AUserIntentV1, { type: 'flow.start.with_draft' }> })
      case 'plan.revision.submit':
        return this.submitRevision(request.address, scope.value.mode, request as HubCommandRequestV1 & { intent: Extract<M2AUserIntentV1, { type: 'plan.revision.submit' }> })
      case 'flow.cancel':
        return this.cancelFlow(request.address, scope.value.mode, request as HubCommandRequestV1 & { intent: Extract<M2AUserIntentV1, { type: 'flow.cancel' }> })
      default:
        return hubError('INTENT_DISABLED')
    }
    } catch {
      return hubError('INTERNAL')
    }
  }

  async executeSystem(request: HubSystemCommandRequestM2BV1): Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>> {
    try {
      if (request.contractVersion !== 'm2b.v1' || request.trustedActor.kind !== 'main-process-system') return systemError('IPC_VERSION_UNSUPPORTED')
      const scope = await this.resolve(request.address)
      if (!scope.ok) return systemError(scope.error.code === 'SESSION_SCOPE_MISMATCH' ? 'SESSION_SCOPE_MISMATCH' : 'INTERNAL')
      if (scope.value.mode === 'DESIGN') return systemError('DESIGN_RESERVED')
      switch (request.intent.type) {
        case 'system.schedule':
          return await this.schedule(request.address, scope.value.mode, request as HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.schedule' }> })
        case 'system.workspace.prepare.result.record':
          return await this.recordWorkspaceResult(request.address, request as HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.workspace.prepare.result.record' }> })
        case 'system.agent.report.record':
          return await this.recordAgentReport(request.address, request as HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.report.record' }> })
        case 'system.agent.outcome.record':
          return await this.recordAgentOutcome(request.address, request as HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.outcome.record' }> })
        case 'system.agent.reconcile':
          return await this.reconcileAgent(request.address, request as HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.reconcile' }> })
        default:
          return systemError('INTERNAL')
      }
    } catch {
      return systemError('INTERNAL')
    }
  }

  close(): void {
    this.store?.close()
    this.store = null
  }

  private async resolve(address: HubAddressV1): Promise<ResolvedScope> {
    const result = await this.options.lookup.lookup(address)
    if (result.kind !== 'FOUND') return hubError('SESSION_SCOPE_MISMATCH')
    return { ok: true, value: { mode: result.scope.sessionMode } }
  }

  private startWithDraft(
    address: HubAddressV1,
    mode: SessionMode,
    request: HubCommandRequestV1 & { intent: Extract<M2AUserIntentV1, { type: 'flow.start.with_draft' }> },
  ): HubOutcomeV1<PerformReceiptV1> {
    const store = this.getStore()
    const replay = this.checkIdempotency(store, address, request)
    if (replay) return replay
    const canonical = canonicalizePlanDraft(request.intent.draft)
    if (!canonical.ok) return hubError('DRAFT_INVALID', { reason: canonical.reason })
    if (this.hasStaleExpectedVersion(store, address, request)) return hubError('STALE_SESSION_VERSION')
    if (store.activeFlow(address)) return hubError('ACTIVE_FLOW_EXISTS')

    const flowId = this.id('xhbf') as FlowId
    const revisionId = this.id('xhbr') as PlanRevisionId
    const projection = projectionForDraft(address, mode, flowId, revisionId, canonical.draft, canonical.digest)
    const receipt = {
      requestId: request.requestId,
      intentType: request.intent.type,
      sessionVersion: 0,
      flowId,
      revisionId,
    }
    store.writeStart(address, this.idempotency(request), {
      flowId,
      revisionId,
      draft: canonical.draft,
      digest: canonical.digest,
      projection,
      receipt,
      eventType: 'flow.started.with_draft',
      now: this.now(),
    })
    return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
  }

  private submitRevision(
    address: HubAddressV1,
    mode: SessionMode,
    request: HubCommandRequestV1 & { intent: Extract<M2AUserIntentV1, { type: 'plan.revision.submit' }> },
  ): HubOutcomeV1<PerformReceiptV1> {
    const store = this.getStore()
    const replay = this.checkIdempotency(store, address, request)
    if (replay) return replay
    const canonical = canonicalizePlanDraft(request.intent.draft)
    if (!canonical.ok) return hubError('DRAFT_INVALID', { reason: canonical.reason })
    if (this.hasStaleExpectedVersion(store, address, request)) return hubError('STALE_SESSION_VERSION')
    const active = store.activeFlow(address)
    if (!active || active.flow_id !== request.intent.flowId) return hubError('FLOW_NOT_FOUND')
    const revision = store.revision(request.intent.baseRevisionId)
    if (!revision || revision.revision_id !== active.active_revision_id || revision.status !== 'DRAFT') {
      return hubError('REVISION_NOT_FOUND')
    }
    if (revision.digest !== canonical.digest) return hubError('REVISION_CONFLICT')

    const projection = projectionForActivePlan(
      address,
      mode,
      request.intent.flowId,
      request.intent.baseRevisionId,
      canonical.draft,
      canonical.digest,
      (prefix) => this.id(prefix),
    )
    const receipt = {
      requestId: request.requestId,
      intentType: request.intent.type,
      sessionVersion: 0,
      flowId: request.intent.flowId,
      revisionId: request.intent.baseRevisionId,
    }
    store.writeSubmit(address, this.idempotency(request), {
      flowId: request.intent.flowId,
      revisionId: request.intent.baseRevisionId,
      draft: canonical.draft,
      projection,
      receipt,
      now: this.now(),
    })
    return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
  }

  private cancelFlow(
    address: HubAddressV1,
    mode: SessionMode,
    request: HubCommandRequestV1 & { intent: Extract<M2AUserIntentV1, { type: 'flow.cancel' }> },
  ): HubOutcomeV1<PerformReceiptV1> {
    const store = this.getStore()
    const replay = this.checkIdempotency(store, address, request)
    if (replay) return replay
    if (this.hasStaleExpectedVersion(store, address, request)) return hubError('STALE_SESSION_VERSION')
    const projection = store.readProjection(address) ?? emptyProjection(address, mode)
    if (!projection.activeFlow || projection.activeFlow.flowId !== request.intent.flowId) return hubError('FLOW_NOT_FOUND')
    const cancelled = { ...projection.activeFlow, status: 'CANCELLED' as const }
    const next = {
      ...projection,
      activeFlow: null,
      activeRevision: null,
      taskSpecs: [],
      taskRuns: [],
      history: [cancelled, ...projection.history],
      availableActions: ['flow.start.with_draft'] as CollaborationHubActionV1[],
    }
    const receipt = {
      requestId: request.requestId,
      intentType: request.intent.type,
      sessionVersion: 0,
      flowId: request.intent.flowId,
    }
    store.writeCancel(address, this.idempotency(request), {
      flowId: request.intent.flowId,
      projection: next,
      receipt,
      reason: 'USER_CANCELLED',
      now: this.now(),
    })
    return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
  }

  private async schedule(address: HubAddressV1, mode: SessionMode, request: HubSystemCommandRequestM2BV1 & { intent: { type: 'system.schedule'; flowId: FlowId } }): Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>> {
    const store = this.getStore()
    const replay = this.checkSystemIdempotency(store, address, request)
    if (replay) return replay
    const agent = await this.preflightAgent()
    if (!agent.ok) return systemError('AGENT_UNAVAILABLE', { reason: agent.reasonCode })
    if (this.hasStaleExpectedVersion(store, address, request)) return systemError('STALE_SESSION_VERSION')
    const projection = store.readProjection(address) ?? emptyProjection(address, mode)
    if (!projection.activeFlow || projection.activeFlow.flowId !== request.intent.flowId || projection.activeFlow.status !== 'PLAN_ACTIVE') {
      return systemError('FLOW_NOT_FOUND')
    }
    if (store.hasActiveExternalAttempt()) return systemError('ILLEGAL_TRANSITION')
    const persistedBaseline = store.flowExecutionBaseline(request.intent.flowId)
    const baseline = await this.captureBaseline(address, request.intent.flowId, projection.activeRevision?.revisionId ?? null)
    if (!baseline.ok) return systemError('BASELINE_UNAVAILABLE', { reason: baseline.reasonCode })
    const capturedBaselineBindingDigest = payloadDigest({ flowId: request.intent.flowId, baseline: baseline.value })
    if (persistedBaseline && !matchesCapturedFlowBaseline(persistedBaseline, baseline.value, capturedBaselineBindingDigest)) {
      return systemError('BASELINE_CONFLICT')
    }
    const task = store.taskRuns(request.intent.flowId).find((candidate) => {
      if (candidate.status !== 'PENDING_DISABLED') return false
      const dependsOn = JSON.parse(candidate.depends_json) as string[]
      return dependsOn.length === 0
    })
    if (!task) return systemError('ILLEGAL_TRANSITION')
    const attemptId = this.id('xhba') as AttemptId
    const effectiveBaseline = persistedBaseline
      ? {
          baselineId: persistedBaseline.baseline_id,
          baselineTreeHash: persistedBaseline.baseline_tree_hash,
          initialTargetFingerprint: persistedBaseline.initial_target_fingerprint,
          baselineDigest: persistedBaseline.baseline_digest,
        }
      : baseline.value
    const baselineBindingDigest = persistedBaseline?.baseline_binding_digest ?? capturedBaselineBindingDigest
    const receipt = {
      requestId: request.requestId,
      intentType: request.intent.type,
      sessionVersion: 0,
      flowId: request.intent.flowId,
      taskRunId: task.task_run_id,
      attemptId,
    }
    const compositionDigest = payloadDigest({ flowId: request.intent.flowId, taskRunId: task.task_run_id, attemptId, attemptKind: 'INITIAL', baselineDigest: effectiveBaseline.baselineDigest })
    try {
      store.writeSchedule(address, this.idempotency(request), {
        flowId: request.intent.flowId,
        taskRunId: task.task_run_id,
        attemptId,
        attemptDigest: payloadDigest({ flowId: request.intent.flowId, taskRunId: task.task_run_id, attemptId, baselineDigest: effectiveBaseline.baselineDigest }),
        compositionDigest,
        baselineBindingDigest,
        baselineId: effectiveBaseline.baselineId,
        baselineTreeHash: effectiveBaseline.baselineTreeHash,
        initialTargetFingerprint: effectiveBaseline.initialTargetFingerprint,
        baselineDigest: effectiveBaseline.baselineDigest,
        workspacePrepareRequestDigest: payloadDigest({ flowId: request.intent.flowId, taskRunId: task.task_run_id, attemptId, purpose: 'workspace.prepare', compositionDigest, baselineBindingDigest }),
        projection,
        receipt,
        now: this.now(),
      })
    } catch (error) {
      if (isBaselineConflictError(error)) return systemError('BASELINE_CONFLICT')
      throw error
    }
    return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
  }

  private recordWorkspaceResult(
    address: HubAddressV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.workspace.prepare.result.record' }> },
  ): HubSystemOutcomeM2BV1<PerformReceiptV1> {
    const store = this.getStore()
    const replay = this.checkSystemIdempotency(store, address, request)
    if (replay) return replay
    if (this.hasStaleExpectedVersion(store, address, request)) return systemError('STALE_SESSION_VERSION')
    const attempt = store.attempt(request.intent.attemptId)
    if (!attempt || attempt.status !== 'WORKSPACE_PREPARING' || attempt.task_run_id !== request.intent.taskRunId) return systemError('ILLEGAL_TRANSITION')
    if (store.workspacePrepareOutboxStatus(request.intent.attemptId) !== 'READY') return systemError('ILLEGAL_TRANSITION')
    const composition = store.compositionAttempt(request.intent.attemptId)
    if (!composition || !matchesWorkspaceBinding(request.intent.receipt, composition)) return systemError('WORKSPACE_RECEIPT_MISMATCH')
    const receipt = {
      requestId: request.requestId,
      intentType: request.intent.type,
      sessionVersion: 0,
      flowId: request.intent.flowId,
      taskRunId: request.intent.taskRunId,
      attemptId: request.intent.attemptId,
    }
    store.writeWorkspacePrepared(address, this.idempotency(request), {
      flowId: request.intent.flowId,
      taskRunId: request.intent.taskRunId,
      attemptId: request.intent.attemptId,
      workspaceReceipt: request.intent.receipt,
      receipt,
      now: this.now(),
    })
    return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
  }

  private async recordAgentReport(
    address: HubAddressV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.report.record' }> },
  ): Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>> {
    const store = this.getStore()
    const replay = this.checkSystemIdempotency(store, address, request)
    if (replay) return replay
    const attempt = store.attempt(request.intent.attemptId)
    if (!attempt || attempt.task_run_id !== request.intent.taskRunId || attempt.flow_id !== request.intent.flowId) return systemError('ILLEGAL_TRANSITION')
    if (!['READY', 'STARTING'].includes(attempt.status) || !attempt.workspace_receipt_id) return systemError('ILLEGAL_TRANSITION')
    const existingOutbox = store.agentDispatchOutbox(request.intent.attemptId)
    const isDispatchReplay = attempt.status === 'STARTING' && existingOutbox?.request_id === request.requestId
    if (!isDispatchReplay && this.hasStaleExpectedVersion(store, address, request)) return systemError('STALE_SESSION_VERSION')
    const workspaceReceipt = store.workspaceReceiptForAttempt(request.intent.attemptId)
    if (!workspaceReceipt || workspaceReceipt.status !== 'PREPARED' || workspaceReceipt.workspace_receipt_id !== attempt.workspace_receipt_id) {
      return systemError('ILLEGAL_TRANSITION')
    }
    const agent = await this.preflightAgent()
    if (!agent.ok) return systemError('AGENT_UNAVAILABLE', { reason: agent.reasonCode })
    const baseline = store.flowExecutionBaseline(request.intent.flowId)
    if (!baseline) return systemError('BASELINE_UNAVAILABLE')
    const runtimeRequest = existingOutbox?.runtime_request_json
      ? (JSON.parse(existingOutbox.runtime_request_json) as RuntimeCreateOrResumeRequestV1)
      : this.runtimeRequest(address, agent.selection, request, attempt, workspaceReceipt.receipt_digest, baseline)
    const dispatchDigest = payloadDigest(runtimeRequest)
    if (existingOutbox && (existingOutbox.request_id !== request.requestId || existingOutbox.runtime_request_digest !== dispatchDigest)) {
      return systemError('IDEMPOTENCY_CONFLICT')
    }
    const receipt = {
      requestId: request.requestId,
      intentType: request.intent.type,
      sessionVersion: 0,
      flowId: request.intent.flowId,
      taskRunId: request.intent.taskRunId,
      attemptId: request.intent.attemptId,
    }
    if (attempt.status === 'READY') {
      store.writeAgentDispatchStart(address, {
        attemptId: request.intent.attemptId,
        taskRunId: request.intent.taskRunId,
        requestId: request.requestId,
        payloadDigest: dispatchDigest,
        runtimeRequestDigest: dispatchDigest,
        runtimeRequestJson: JSON.stringify(runtimeRequest),
        selectionDigest: payloadDigest(runtimeRequest.selection),
        now: this.now(),
      })
      this.options.afterAgentDispatchStart?.(request.requestId)
    }
    const outcome = await agent.runtime.createOrResume(runtimeRequest)
    const startingAttempt = store.attempt(request.intent.attemptId)
    if (!startingAttempt || startingAttempt.status !== 'STARTING') return systemError('ILLEGAL_TRANSITION')
    if (outcome.state !== 'READY') {
      store.writeAgentOutcome(address, this.idempotency(request), this.agentOutcomeRecord(request, outcome, receipt))
      return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
    }
    store.writeAgentReport(address, this.idempotency(request), {
      attemptId: request.intent.attemptId,
      taskRunId: request.intent.taskRunId,
      requestId: request.requestId,
      payloadDigest: dispatchDigest,
      runtimeRequestDigest: dispatchDigest,
      runtimeRequestJson: JSON.stringify(runtimeRequest),
      selectionDigest: payloadDigest(runtimeRequest.selection),
      runtimeSessionId: outcome.runtimeSessionId,
      reportDigest: payloadDigest({ state: outcome.state, runtimeSessionId: outcome.runtimeSessionId, requestId: request.requestId }),
      receipt,
      now: this.now(),
    })
    return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
  }

  private recordAgentOutcome(
    address: HubAddressV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.outcome.record' }> },
  ): HubSystemOutcomeM2BV1<PerformReceiptV1> {
    const store = this.getStore()
    const replay = this.checkSystemIdempotency(store, address, request)
    if (replay) return replay
    if (this.hasStaleExpectedVersion(store, address, request)) return systemError('STALE_SESSION_VERSION')
    if (!isValidAgentOutcomeIntent(request.intent)) return systemError('ILLEGAL_TRANSITION')
    const attempt = store.attempt(request.intent.attemptId)
    if (!attempt || attempt.task_run_id !== request.intent.taskRunId) return systemError('ILLEGAL_TRANSITION')
    if (!['STARTING', 'RUNNING'].includes(attempt.status)) return systemError('ILLEGAL_TRANSITION')
    if (attempt.runtime_session_id && attempt.runtime_session_id !== request.intent.runtimeSessionId) return systemError('ILLEGAL_TRANSITION')
    const receipt = {
      requestId: request.requestId,
      intentType: request.intent.type,
      sessionVersion: 0,
      flowId: request.intent.flowId,
      taskRunId: request.intent.taskRunId,
      attemptId: request.intent.attemptId,
    }
    store.writeAgentOutcome(address, this.idempotency(request), {
      attemptId: request.intent.attemptId,
      taskRunId: request.intent.taskRunId,
      runtimeSessionId: request.intent.runtimeSessionId,
      outcome: request.intent.outcome,
      receiptDigest: request.intent.receiptDigest,
      failure: request.intent.outcome === 'FAILED' ? request.intent.failure : undefined,
      receipt,
      now: this.now(),
    })
    return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
  }

  private async reconcileAgent(
    address: HubAddressV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.reconcile' }> },
  ): Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>> {
    const store = this.getStore()
    const replay = this.checkSystemIdempotency(store, address, request)
    if (replay) return replay
    if (this.hasStaleExpectedVersion(store, address, request)) return systemError('STALE_SESSION_VERSION')
    const attempt = store.attempt(request.intent.attemptId)
    if (!attempt || attempt.status !== 'OUTCOME_UNKNOWN' || attempt.runtime_session_id !== request.intent.runtimeSessionId) return systemError('ILLEGAL_TRANSITION')
    if (request.intent.expectedReceiptDigest && attempt.outcome_receipt_digest && request.intent.expectedReceiptDigest !== attempt.outcome_receipt_digest) {
      return systemError('IDEMPOTENCY_CONFLICT')
    }
    const agent = this.options.agentRuntime
    if (!agent) return systemError('AGENT_UNAVAILABLE', { reason: 'NO_AGENT_RUNTIME' })
    const outcome = await agent.reconcile(request.intent.runtimeSessionId, request.intent.expectedReceiptDigest)
    const receipt = {
      requestId: request.requestId,
      intentType: request.intent.type,
      sessionVersion: 0,
      attemptId: request.intent.attemptId,
    }
    const mapped = mapRuntimeOutcome(outcome)
    store.writeAgentReconcile(address, this.idempotency(request), {
      attemptId: request.intent.attemptId,
      runtimeSessionId: request.intent.runtimeSessionId,
      expectedReceiptDigest: request.intent.expectedReceiptDigest,
      outcome: mapped.outcome,
      receiptDigest: mapped.receiptDigest,
      failure: mapped.failure,
      receipt,
      now: this.now(),
    })
    return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
  }

  private async preflightAgent(): Promise<
    { ok: true; runtime: AgentRuntimeHostV1; selection: RuntimeAdapterSelectionV1 } | { ok: false; reasonCode: string }
  > {
    const runtime = this.options.agentRuntime
    if (!runtime) return { ok: false, reasonCode: 'NO_AGENT_RUNTIME' }
    try {
      const capabilities = await runtime.discover()
      const candidate = this.options.agentSelection ?? capabilities.find(isProductionCapability)
      if (!candidate || !isProductionCapability(candidate)) return { ok: false, reasonCode: 'NO_APPROVED_RUNTIME' }
      const health = await runtime.health(candidate.adapterId)
      if (!isProductionCapability(health) || runtimeSelectionKey(health) !== runtimeSelectionKey(candidate) || health.health !== 'AVAILABLE') {
        return { ok: false, reasonCode: health.reasonCode ?? 'RUNTIME_NOT_AVAILABLE' }
      }
      return { ok: true, runtime, selection: toRuntimeSelection(candidate) }
    } catch {
      return { ok: false, reasonCode: 'RUNTIME_ADAPTER_ERROR' }
    }
  }

  private async captureBaseline(
    address: HubAddressV1,
    flowId: FlowId,
    planRevisionId: PlanRevisionId | null,
  ): Promise<{ ok: true; value: ExecutionBaselineV1 } | { ok: false; reasonCode: string }> {
    const provider = this.options.baselineProvider
    if (!provider) return { ok: false, reasonCode: 'NO_BASELINE_PROVIDER' }
    try {
      const baseline = await provider.capture({ address, flowId, planRevisionId })
      const expected = payloadDigest({
        baselineId: baseline.baselineId,
        baselineTreeHash: baseline.baselineTreeHash,
        initialTargetFingerprint: baseline.initialTargetFingerprint,
      })
      return baseline.baselineDigest === expected ? { ok: true, value: baseline } : { ok: false, reasonCode: 'BASELINE_DIGEST_MISMATCH' }
    } catch {
      return { ok: false, reasonCode: 'BASELINE_PROVIDER_ERROR' }
    }
  }

  private runtimeRequest(
    address: HubAddressV1,
    selection: RuntimeAdapterSelectionV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.report.record' }> },
    attempt: NonNullable<ReturnType<CollaborationHubSqliteStoreV1['attempt']>>,
    workspaceReceiptDigest: string,
    baseline: NonNullable<ReturnType<CollaborationHubSqliteStoreV1['flowExecutionBaseline']>>,
  ): RuntimeCreateOrResumeRequestV1 {
    const scope: RuntimeScopeBindingV1 = {
      projectId: address.projectId,
      sessionKey: address.sessionKey,
      sessionMode: 'CODING',
      flowId: request.intent.flowId,
      taskRunId: request.intent.taskRunId,
      attemptId: request.intent.attemptId,
      attemptDigest: attempt.attempt_digest,
      workspaceReceiptId: attempt.workspace_receipt_id ?? '',
      workspaceReceiptDigest,
    }
    return {
      requestId: request.requestId,
      scope,
      workspace: {
        attemptWorktreeId: `xhbwt_${baseline.baseline_id}`,
        worktreeRootDigest: payloadDigest({ baselineDigest: baseline.baseline_digest, workspaceReceiptDigest, role: 'worktree-root' }),
        baseRevisionDigest: baseline.baseline_tree_hash,
        targetProjectRootDigest: baseline.initial_target_fingerprint,
        writePolicy: 'ATTEMPT_WORKTREE_ONLY',
      },
      selection,
      productionPolicy: { allowedSelections: [selection], rejectDiagnosticOnly: true },
      promptEnvelopeRef: {
        refId: `xhbprompt_${request.intent.attemptId}`,
        digest: payloadDigest({ flowId: request.intent.flowId, taskRunId: request.intent.taskRunId, attemptId: request.intent.attemptId, role: 'runtime-prompt' }),
        mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
      },
    }
  }

  private agentOutcomeRecord(
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.report.record' }> },
    outcome: RuntimeCreateOrResumeOutcomeV1,
    receipt: PerformReceiptV1,
  ) {
    const mapped = mapRuntimeOutcome(outcome)
    return {
      attemptId: request.intent.attemptId,
      taskRunId: request.intent.taskRunId,
      runtimeSessionId: 'runtimeSessionId' in outcome ? outcome.runtimeSessionId : 'runtime-unbound',
      outcome: mapped.outcome,
      receiptDigest: mapped.receiptDigest,
      failure: mapped.failure,
      succeededAudit: mapped.succeededAudit ? { ...mapped.succeededAudit, attemptId: request.intent.attemptId } : undefined,
      receipt,
      now: this.now(),
    }
  }

  private checkIdempotency(
    store: CollaborationHubSqliteStoreV1,
    address: HubAddressV1,
    request: { requestId: string; expectedSessionVersion?: number; intent: { type: string } },
  ): HubOutcomeV1<PerformReceiptV1> | null {
    const existing = store.idempotency(address, request.requestId)
    if (!existing) return null
    const current = this.idempotency(request)
    if (existing.command_type !== current.commandType || existing.payload_hash !== current.payloadHash) {
      return hubError('IDEMPOTENCY_CONFLICT')
    }
    return { ok: true, value: JSON.parse(existing.receipt_json) as PerformReceiptV1 }
  }

  private checkSystemIdempotency(
    store: CollaborationHubSqliteStoreV1,
    address: HubAddressV1,
    request: { requestId: string; expectedSessionVersion?: number; intent: { type: string } },
  ): HubSystemOutcomeM2BV1<PerformReceiptV1> | null {
    const existing = store.idempotency(address, request.requestId)
    if (!existing) return null
    const current = this.idempotency(request)
    if (existing.command_type !== current.commandType || existing.payload_hash !== current.payloadHash) {
      return systemError('IDEMPOTENCY_CONFLICT')
    }
    return { ok: true, value: JSON.parse(existing.receipt_json) as PerformReceiptV1 }
  }

  private idempotency(request: { requestId: string; expectedSessionVersion?: number; intent: { type: string } }) {
    return {
      requestId: request.requestId,
      commandType: request.intent.type,
      payloadHash: payloadDigest({ expectedSessionVersion: request.expectedSessionVersion ?? null, intent: request.intent }),
    }
  }

  private hasStaleExpectedVersion(
    store: CollaborationHubSqliteStoreV1,
    address: HubAddressV1,
    request: { expectedSessionVersion?: number },
  ): boolean {
    return typeof request.expectedSessionVersion === 'number' && request.expectedSessionVersion !== store.currentVersion(address)
  }

  private getStore(): CollaborationHubSqliteStoreV1 {
    this.store ??= this.options.storeFactory()
    return this.store
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  private id(prefix: string): string {
    return this.options.idFactory?.(prefix) ?? `${prefix}_${randomUUID()}`
  }
}

function isProductionCapability(value: RuntimeCapabilityV1 | RuntimeAdapterSelectionV1): value is RuntimeCapabilityV1 | RuntimeAdapterSelectionV1 {
  return (
    value.approvalStatus === 'APPROVED_FOR_PRODUCTION' &&
    value.diagnosticOnly === false &&
    value.stream !== 'NONE' &&
    value.interrupt !== 'NONE' &&
    value.inspect !== 'NONE' &&
    ('health' in value ? value.health === 'AVAILABLE' && value.canCreateSession === true : true)
  )
}

function systemError(
  code: HubSystemErrorCodeM2BV1,
  safeArgs?: Record<string, string | number | boolean>,
): HubSystemOutcomeM2BV1<never> {
  return {
    ok: false,
    error: {
      code,
      messageKey: `xiaogui.hub.system.${code.toLowerCase()}`,
      ...(safeArgs ? { safeArgs } : {}),
      traceId: `xhbs_${randomUUID()}`,
    },
  }
}

function matchesWorkspaceBinding(
  receipt: { attemptId: AttemptId; compositionAttemptId: string; requestDigest: string; baselineBindingDigest: string; compositionDigest: string },
  composition: { attemptId: AttemptId; compositionAttemptId: string; requestDigest: string; baselineBindingDigest: string; compositionDigest: string },
): boolean {
  return (
    receipt.attemptId === composition.attemptId &&
    receipt.compositionAttemptId === composition.compositionAttemptId &&
    receipt.requestDigest === composition.requestDigest &&
    receipt.baselineBindingDigest === composition.baselineBindingDigest &&
    receipt.compositionDigest === composition.compositionDigest
  )
}

function matchesCapturedFlowBaseline(
  persisted: NonNullable<ReturnType<CollaborationHubSqliteStoreV1['flowExecutionBaseline']>>,
  captured: ExecutionBaselineV1,
  capturedBaselineBindingDigest: string,
): boolean {
  return (
    persisted.baseline_id === captured.baselineId &&
    persisted.baseline_tree_hash === captured.baselineTreeHash &&
    persisted.initial_target_fingerprint === captured.initialTargetFingerprint &&
    persisted.baseline_digest === captured.baselineDigest &&
    persisted.baseline_binding_digest === capturedBaselineBindingDigest
  )
}

function isBaselineConflictError(error: unknown): boolean {
  return error instanceof Error && (error.message === 'BASELINE_CONFLICT' || (error as { code?: string }).code === 'BASELINE_CONFLICT')
}

function isValidAgentOutcomeIntent(intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.outcome.record' }>): boolean {
  if (intent.outcome === 'FAILED') return isClosedFailureSignal(intent.failure, intent.receiptDigest)
  return !('failure' in intent) || intent.failure == null
}

function isClosedFailureSignal(value: AgentFailureSignalV1 | undefined, receiptDigest: string): value is AgentFailureSignalV1 {
  if (!value || value.kind !== 'AGENT_FAILURE' || value.receiptDigest !== receiptDigest) return false
  if (!['RUNTIME', 'PROTOCOL', 'UNKNOWN'].includes(value.failureClass)) return false
  return ['RUNTIME_FAILED', 'RUNTIME_ADAPTER_ERROR', 'RUNTIME_SESSION_NOT_FOUND', 'RUNTIME_OUTCOME_SESSION_MISMATCH', 'UNKNOWN_RUNTIME_FAILURE'].includes(value.safeCode)
}

function toRuntimeSelection(value: RuntimeCapabilityV1 | RuntimeAdapterSelectionV1): RuntimeAdapterSelectionV1 {
  if (value.stream === 'NONE' || value.interrupt === 'NONE' || value.inspect === 'NONE') {
    throw new Error('invalid runtime selection')
  }
  return {
    adapterId: value.adapterId,
    runtimeKind: value.runtimeKind,
    protocol: value.protocol,
    capabilityDigest: value.capabilityDigest,
    approvalStatus: 'APPROVED_FOR_PRODUCTION',
    diagnosticOnly: false,
    stream: value.stream,
    interrupt: value.interrupt,
    inspect: value.inspect,
  }
}

function mapRuntimeOutcome(outcome: RuntimeCreateOrResumeOutcomeV1 | RuntimeOutcomeV1): {
  outcome: 'FAILED' | 'INTERRUPTED' | 'OUTCOME_UNKNOWN'
  receiptDigest: string
  failure?: AgentFailureSignalV1
  succeededAudit?: { runtimeSessionId: string; attemptId: AttemptId; receiptDigest: string; candidateDigest: string }
} {
  if (outcome.state === 'FAILED') {
    const safeCode = classifyRuntimeFailure(outcome.reasonCode)
    if (!safeCode) {
      return {
        outcome: 'OUTCOME_UNKNOWN',
        receiptDigest: outcome.receiptDigest,
      }
    }
    return {
      outcome: 'FAILED',
      receiptDigest: outcome.receiptDigest,
      failure: failureSignal(safeCode, outcome.receiptDigest),
    }
  }
  if (outcome.state === 'INTERRUPTED') {
    return {
      outcome: 'INTERRUPTED',
      receiptDigest: outcome.receiptDigest,
    }
  }
  if (outcome.state === 'SUCCEEDED') {
    return {
      outcome: 'OUTCOME_UNKNOWN',
      receiptDigest: outcome.receiptDigest,
      succeededAudit: {
        runtimeSessionId: outcome.runtimeSessionId,
        attemptId: '' as AttemptId,
        receiptDigest: outcome.receiptDigest,
        candidateDigest: outcome.candidateDigest,
      },
    }
  }
  if (outcome.state === 'READY') {
    return {
      outcome: 'OUTCOME_UNKNOWN',
      receiptDigest: payloadDigest({ state: 'READY', runtimeSessionId: outcome.runtimeSessionId }),
    }
  }
  return {
    outcome: 'OUTCOME_UNKNOWN',
    receiptDigest: outcome.inspectHandleDigest,
  }
}

function classifyRuntimeFailure(reasonCode: string): AgentFailureSignalV1['safeCode'] | null {
  if (reasonCode === 'RUNTIME_ADAPTER_ERROR') return 'RUNTIME_ADAPTER_ERROR'
  if (reasonCode === 'RUNTIME_SESSION_NOT_FOUND') return 'RUNTIME_SESSION_NOT_FOUND'
  if (reasonCode === 'RUNTIME_OUTCOME_SESSION_MISMATCH') return 'RUNTIME_OUTCOME_SESSION_MISMATCH'
  if (reasonCode.startsWith('RUNTIME_')) return 'RUNTIME_FAILED'
  return null
}

function failureSignal(safeCode: AgentFailureSignalV1['safeCode'], receiptDigest: string): AgentFailureSignalV1 {
  const failureClass = safeCode === 'UNKNOWN_RUNTIME_FAILURE' ? 'UNKNOWN' : 'RUNTIME'
  return { kind: 'AGENT_FAILURE', failureClass, safeCode, receiptDigest }
}

function emptyProjection(address: HubAddressV1, mode: SessionMode): SessionCollaborationProjectionV1 {
  return {
    kind: 'SESSION_COLLABORATION_PROJECTION',
    version: 'm2a.v1',
    address,
    sessionVersion: 0,
    sessionMode: mode,
    authoritativeMode: mode,
    reserved: false,
    activeFlow: null,
    activeRevision: null,
    taskSpecs: [],
    taskRuns: [],
    history: [],
    availableActions: mode === 'DESIGN' ? [] : ['flow.start.with_draft'],
  }
}

function reservedProjection(address: HubAddressV1, mode: SessionMode): SessionCollaborationProjectionV1 {
  return {
    ...emptyProjection(address, mode),
    reserved: { code: 'DESIGN_RESERVED', messageKey: 'xiaogui.hub.design_reserved' },
    availableActions: [],
  }
}

function projectionForDraft(
  address: HubAddressV1,
  mode: SessionMode,
  flowId: FlowId,
  revisionId: PlanRevisionId,
  draft: CanonicalPlanDraftV1,
  digest: string,
): SessionCollaborationProjectionV1 {
  return {
    ...emptyProjection(address, mode),
    activeFlow: { flowId, status: 'AWAITING_PLAN_APPROVAL', activeRevisionId: revisionId, objective: draft.objective },
    activeRevision: { revisionId, status: 'DRAFT', digest, draft },
    availableActions: ['plan.revision.submit', 'flow.cancel'],
  }
}

function projectionForActivePlan(
  address: HubAddressV1,
  mode: SessionMode,
  flowId: FlowId,
  revisionId: PlanRevisionId,
  draft: CanonicalPlanDraftV1,
  digest: string,
  idFactory: (prefix: string) => string,
): SessionCollaborationProjectionV1 {
  const taskSpecs: TaskSpecProjectionV1[] = draft.tasks.map((task) => ({
    taskSpecId: idFactory('xhbts') as TaskSpecId,
    taskKey: task.taskKey,
    title: task.title,
    ...(task.summary ? { summary: task.summary } : {}),
    dependsOn: task.dependsOn,
    unavailableReason: 'AGENT_DISABLED_M2A',
  }))
  const taskRuns: TaskRunProjectionV1[] = taskSpecs.map((task) => ({
    taskRunId: idFactory('xhbtr') as never,
    taskSpecId: task.taskSpecId,
    taskKey: task.taskKey,
    status: 'PENDING_DISABLED',
    unavailableReason: 'AGENT_DISABLED_M2A',
  }))
  return {
    ...emptyProjection(address, mode),
    activeFlow: { flowId, status: 'PLAN_ACTIVE', activeRevisionId: revisionId, objective: draft.objective },
    activeRevision: { revisionId, status: 'ACTIVE', digest, draft },
    taskSpecs,
    taskRuns,
    availableActions: ['flow.cancel'],
  }
}

export function createCollaborationHubApplicationV1(options: CollaborationHubApplicationOptionsV1): CollaborationHubApplicationV1 {
  return new SqliteCollaborationHubApplicationV1(options)
}
