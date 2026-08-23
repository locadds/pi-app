import { randomUUID } from 'node:crypto'

import {
  runtimeSelectionKey,
  type PromptEnvelopeRefV1,
  type RuntimeAdapterSelectionV1,
  type RuntimeCapabilityV1,
  type RuntimeCreateOrResumeOutcomeV1,
  type RuntimeCreateOrResumeRequestV1,
  type RuntimeOutcomeV1,
  type RuntimeScopeBindingV1,
  type RuntimeWorkspaceBindingV1,
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
  WorkspacePreparedReceiptM2BV1,
  WorkspaceReceiptId,
} from '@shared/xiaogui-collaboration-hub'
import type { DeliveryBatchProjectionV1 } from '@shared/xiaogui-delivery'
import type { SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { canonicalizePlanDraft, payloadDigest, type CanonicalPlanDraftV1 } from './digest'
import { hubError } from './errors'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'
import type { TaskVerificationCoordinatorV1 } from './task-verification-coordinator'
import type { AgentRuntimeHostV1 } from '../agent-runtime/runtime-host'

export interface CollaborationHubApplicationOptionsV1 {
  lookup: SessionScopeLookupV1
  storeFactory: () => CollaborationHubSqliteStoreV1
  agentRuntime?: AgentRuntimeHostV1
  agentSelection?: RuntimeAdapterSelectionV1
  baselineProvider?: ExecutionBaselineProviderV1
  workspaceBridge?: ExecutionWorkspaceBridgeV1
  runtimePromptVault?: RuntimePromptVaultV1
  taskVerificationCoordinator?: TaskVerificationCoordinatorV1
  afterAgentDispatchStart?: (requestId: string) => void
  now?: () => string
  idFactory?: (prefix: string) => string
}

export interface ExecutionBaselineV1 {
  baselineId: string
  baseRevision?: string
  baselineTreeHash: string
  initialTargetFingerprint: string
  baselineDigest: string
}

export interface ExecutionBaselineProviderV1 {
  capture(input: { address: HubAddressV1; flowId: FlowId; planRevisionId: PlanRevisionId | null }): Promise<ExecutionBaselineV1>
}

export interface ExecutionWorkspaceBridgeV1 {
  prepare(input: {
    address: HubAddressV1
    attempt: NonNullable<ReturnType<CollaborationHubSqliteStoreV1['attempt']>>
    composition: NonNullable<ReturnType<CollaborationHubSqliteStoreV1['compositionAttempt']>>
    baseline: NonNullable<ReturnType<CollaborationHubSqliteStoreV1['flowExecutionBaseline']>>
  }): Promise<import('@shared/xiaogui-collaboration-hub').WorkspacePreparedReceiptM2BV1>
  runtimeWorkspace(
    attemptId: AttemptId,
  ): RuntimeWorkspaceBindingV1 | undefined | Promise<RuntimeWorkspaceBindingV1 | undefined>
}

export interface RuntimePromptVaultV1 {
  promptRefForAttempt(attemptId: string): PromptEnvelopeRefV1
}

export interface CollaborationHubApplicationV1 {
  execute(request: HubCommandRequestV1): Promise<HubOutcomeV1<PerformReceiptV1>>
  executeSystem(request: HubSystemCommandRequestM2BV1): Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>>
  prepareNextWorkspace(address: HubAddressV1, request: { requestId: string; attemptId: AttemptId; expectedSessionVersion?: number }): Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>>
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
  private readonly workspacePreparationInFlight = new Map<
    AttemptId,
    { requestIdentity: string; outcome: Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>> }
  >()

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
      const store = this.getStore()
      const projection = store.readProjectionM2B(address) ?? {
        ...emptyProjection(address, scope.value.mode),
        version: 'm2b.v1' as const,
        taskRuns: [],
        attempts: [],
        availableActions: ['flow.start.with_draft'],
      }
      const activeDelivery = projection.activeFlow
        ? store.readActiveDelivery(address, projection.activeFlow.flowId)
        : null
      return {
        ok: true,
        value: withAuthoritativeM2BActions(
          withAuthoritativeDeliveryActions(projection, activeDelivery),
          this.options.agentRuntime !== undefined,
        ),
      }
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

  async prepareNextWorkspace(
    address: HubAddressV1,
    request: { requestId: string; attemptId: AttemptId; expectedSessionVersion?: number },
  ): Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>> {
    const requestIdentity = payloadDigest({ address, request })
    const inFlight = this.workspacePreparationInFlight.get(request.attemptId)
    if (inFlight) return inFlight.requestIdentity === requestIdentity ? inFlight.outcome : systemError('ILLEGAL_TRANSITION')
    const preparation = this.prepareNextWorkspaceOnce(address, request)
    this.workspacePreparationInFlight.set(request.attemptId, { requestIdentity, outcome: preparation })
    try {
      return await preparation
    } finally {
      if (this.workspacePreparationInFlight.get(request.attemptId)?.outcome === preparation) {
        this.workspacePreparationInFlight.delete(request.attemptId)
      }
    }
  }

  private async prepareNextWorkspaceOnce(
    address: HubAddressV1,
    request: { requestId: string; attemptId: AttemptId; expectedSessionVersion?: number },
  ): Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>> {
    try {
      const scope = await this.resolve(address)
      if (!scope.ok) return systemError(scope.error.code === 'SESSION_SCOPE_MISMATCH' ? 'SESSION_SCOPE_MISMATCH' : 'INTERNAL')
      if (scope.value.mode === 'DESIGN') return systemError('DESIGN_RESERVED')
      const bridge = this.options.workspaceBridge
      if (!bridge) return systemError('INTERNAL', { reason: 'NO_WORKSPACE_BRIDGE' })
      const store = this.getStore()
      if (this.hasStaleExpectedVersion(store, address, request)) return systemError('STALE_SESSION_VERSION')
      const attempt = store.attempt(request.attemptId)
      if (!attempt || attempt.status !== 'WORKSPACE_PREPARING') return systemError('ILLEGAL_TRANSITION')
      const composition = store.compositionAttempt(request.attemptId)
      if (!composition) return systemError('ILLEGAL_TRANSITION')
      const baseline = store.flowExecutionBaseline(attempt.flow_id)
      if (!baseline) return systemError('BASELINE_UNAVAILABLE')
      const claimOwnerId = 'xiaogui-main-process'
      const claim = store.claimWorkspacePrepareOutbox({
        attemptId: request.attemptId,
        ownerId: claimOwnerId,
        claimDigest: payloadDigest({
          attemptId: request.attemptId,
          requestDigest: composition.requestDigest,
          ownerId: claimOwnerId,
          purpose: 'workspace.prepare.claim.v1',
        }),
        now: this.now(),
      })
      if (!claim) return systemError('ILLEGAL_TRANSITION')
      if (claim.requestDigest !== composition.requestDigest) return systemError('INTERNAL', { reason: 'WORKSPACE_CLAIM_BINDING_MISMATCH' })
      let receipt: WorkspacePreparedReceiptM2BV1
      try {
        receipt = await bridge.prepare({ address, attempt, composition, baseline })
      } catch (error) {
        receipt = failedWorkspaceReceipt(attempt.attempt_id, composition, error)
      }
      return this.executeSystem({
        contractVersion: 'm2b.v1',
        address,
        trustedActor: { kind: 'main-process-system' },
        requestId: request.requestId,
        expectedSessionVersion: request.expectedSessionVersion,
        intent: {
          type: 'system.workspace.prepare.result.record',
          flowId: attempt.flow_id,
          taskRunId: attempt.task_run_id,
          attemptId: request.attemptId,
          receipt,
        },
      })
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
          ...(persistedBaseline.base_revision ? { baseRevision: persistedBaseline.base_revision } : {}),
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
        baseRevision: effectiveBaseline.baseRevision,
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
    const workspaceOutboxStatus = store.workspacePrepareOutboxStatus(request.intent.attemptId)
    const workspaceResultIsClaimed = this.options.workspaceBridge
      ? workspaceOutboxStatus === 'CLAIMED'
      : ['READY', 'CLAIMED'].includes(workspaceOutboxStatus ?? '')
    if (!workspaceResultIsClaimed) return systemError('ILLEGAL_TRANSITION')
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
    let currentRuntimeRequest: RuntimeCreateOrResumeRequestV1
    try {
      currentRuntimeRequest = await this.runtimeRequest(address, agent.selection, request, attempt, workspaceReceipt.receipt_digest)
    } catch {
      return systemError('AGENT_UNAVAILABLE', { reason: 'RUNTIME_PRIVATE_BINDING_MISSING' })
    }
    const dispatchDigest = payloadDigest(currentRuntimeRequest)
    let runtimeRequest = currentRuntimeRequest
    if (existingOutbox?.runtime_request_json) {
      let persistedRuntimeRequest: RuntimeCreateOrResumeRequestV1
      try {
        persistedRuntimeRequest = JSON.parse(existingOutbox.runtime_request_json) as RuntimeCreateOrResumeRequestV1
      } catch {
        return systemError('IDEMPOTENCY_CONFLICT')
      }
      if (payloadDigest(persistedRuntimeRequest) !== dispatchDigest) return systemError('IDEMPOTENCY_CONFLICT')
      runtimeRequest = persistedRuntimeRequest
    }
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
    if (outcome.state === 'SUCCEEDED') {
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
      const coordinator = this.options.taskVerificationCoordinator
      if (!coordinator) {
        this.closeDirectSucceededStartFailure(address, request, outcome, 'TASK_VERIFICATION_COORDINATOR_MISSING')
        return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
      }
      const verified = await this.coordinateSucceededTaskVerification(coordinator, {
        address,
        flowId: request.intent.flowId,
        taskRunId: request.intent.taskRunId,
        attemptId: request.intent.attemptId,
        outcome,
        createdAt: this.now(),
      })
      if (!verified.ok) {
        this.closeDirectSucceededStartFailure(address, request, outcome, verified.reasonCode)
      }
      return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
    }
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

  private async recordAgentOutcome(
    address: HubAddressV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.outcome.record' }> },
  ): Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>> {
    const store = this.getStore()
    const replay = this.checkSystemIdempotency(store, address, request)
    if (replay) return replay
    if (this.hasStaleExpectedVersion(store, address, request)) return systemError('STALE_SESSION_VERSION')
    if (!isValidAgentOutcomeIntent(request.intent)) return systemError('ILLEGAL_TRANSITION')
    const attempt = store.attempt(request.intent.attemptId)
    if (!attempt || attempt.task_run_id !== request.intent.taskRunId) return systemError('ILLEGAL_TRANSITION')
    if (!['STARTING', 'RUNNING'].includes(attempt.status)) return systemError('ILLEGAL_TRANSITION')
    const restartOutcomeUnknown =
      request.intent.outcome === 'OUTCOME_UNKNOWN' &&
      request.intent.runtimeSessionId === 'runtime-unbound'
    if (
      attempt.runtime_session_id &&
      attempt.runtime_session_id !== request.intent.runtimeSessionId &&
      !restartOutcomeUnknown
    ) return systemError('ILLEGAL_TRANSITION')
    const receipt = {
      requestId: request.requestId,
      intentType: request.intent.type,
      sessionVersion: 0,
      flowId: request.intent.flowId,
      taskRunId: request.intent.taskRunId,
      attemptId: request.intent.attemptId,
    }
    if (request.intent.outcome === 'SUCCEEDED') {
      const coordinator = this.options.taskVerificationCoordinator
      if (!coordinator) return systemError('INTERNAL', { reason: 'TASK_VERIFICATION_COORDINATOR_MISSING' })
      if (!attempt.runtime_session_id || attempt.runtime_session_id !== request.intent.runtimeSessionId) {
        return systemError('ILLEGAL_TRANSITION')
      }
      const verified = await this.coordinateSucceededTaskVerification(coordinator, {
        address,
        flowId: request.intent.flowId,
        taskRunId: request.intent.taskRunId,
        attemptId: request.intent.attemptId,
        outcome: {
          state: 'SUCCEEDED',
          runtimeSessionId: request.intent.runtimeSessionId,
          receiptDigest: request.intent.receiptDigest,
          candidateDigest: request.intent.runtimeCandidateDigest,
        },
        createdAt: this.now(),
      })
      if (!verified.ok) return systemError('INTERNAL', { reason: verified.reasonCode })
      return {
        ok: true,
        value: { ...receipt, sessionVersion: store.currentVersion(address) },
      }
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
    if (outcome.state === 'SUCCEEDED') {
      const coordinator = this.options.taskVerificationCoordinator
      if (!coordinator) return systemError('INTERNAL', { reason: 'TASK_VERIFICATION_COORDINATOR_MISSING' })
      const verified = await this.coordinateSucceededTaskVerification(coordinator, {
        address,
        flowId: attempt.flow_id,
        taskRunId: attempt.task_run_id,
        attemptId: request.intent.attemptId,
        outcome,
        createdAt: this.now(),
        reconcileStart: {
          idempotency: this.idempotency(request),
          receipt,
          expectedReceiptDigest: request.intent.expectedReceiptDigest ?? attempt.outcome_receipt_digest ?? undefined,
        },
      })
      if (!verified.ok) {
        this.closeReconcileSucceededStartFailure(address, request, outcome, receipt, verified.reasonCode)
      }
      const stored = store.idempotency(address, request.requestId)
      return stored
        ? { ok: true, value: JSON.parse(stored.receipt_json) as PerformReceiptV1 }
        : systemError('INTERNAL', { reason: verified.ok ? 'TASK_VERIFICATION_RECEIPT_MISSING' : verified.reasonCode })
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

  private async coordinateSucceededTaskVerification(
    coordinator: TaskVerificationCoordinatorV1,
    input: Parameters<TaskVerificationCoordinatorV1['handleSucceeded']>[0],
  ): ReturnType<TaskVerificationCoordinatorV1['handleSucceeded']> {
    try {
      return await coordinator.handleSucceeded(input)
    } catch {
      return { ok: false, reasonCode: 'TASK_VERIFICATION_STORE_REJECTED' }
    }
  }

  private closeDirectSucceededStartFailure(
    address: HubAddressV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.report.record' }> },
    outcome: Extract<RuntimeCreateOrResumeOutcomeV1, { state: 'SUCCEEDED' }>,
    reasonCode: string,
  ): void {
    const store = this.getStore()
    const current = store.attempt(request.intent.attemptId)
    if (!current || current.status !== 'RUNNING') return
    const requestId = `${request.requestId}:task-verification-start-fallback`
    const receiptDigest = payloadDigest({
      role: 'direct-succeeded-task-verification-start-fallback',
      requestId,
      attemptId: request.intent.attemptId,
      runtimeSessionId: outcome.runtimeSessionId,
      runtimeReceiptDigest: outcome.receiptDigest,
      reasonCode,
    })
    const failed = reasonCode === 'TASK_VERIFICATION_CAPTURE_FAILED'
    store.writeAgentOutcome(address, {
      requestId,
      commandType: 'system.agent.outcome.record',
      payloadHash: payloadDigest({ requestId, reasonCode, outcome: failed ? 'FAILED' : 'OUTCOME_UNKNOWN' }),
    }, {
      attemptId: request.intent.attemptId,
      taskRunId: request.intent.taskRunId,
      runtimeSessionId: outcome.runtimeSessionId,
      outcome: failed ? 'FAILED' : 'OUTCOME_UNKNOWN',
      receiptDigest,
      failure: failed ? failureSignal('CANDIDATE_AUDIT_FAILED', receiptDigest) : undefined,
      receipt: {
        requestId,
        intentType: 'system.agent.outcome.record',
        sessionVersion: 0,
        flowId: request.intent.flowId,
        taskRunId: request.intent.taskRunId,
        attemptId: request.intent.attemptId,
      },
      now: this.now(),
    })
  }

  private closeReconcileSucceededStartFailure(
    address: HubAddressV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.reconcile' }> },
    outcome: Extract<RuntimeOutcomeV1, { state: 'SUCCEEDED' }>,
    receipt: PerformReceiptV1,
    reasonCode: string,
  ): void {
    const store = this.getStore()
    const current = store.attempt(request.intent.attemptId)
    if (!current || current.status !== 'OUTCOME_UNKNOWN') return
    const receiptDigest = payloadDigest({
      role: 'reconcile-succeeded-task-verification-start-fallback',
      requestId: request.requestId,
      attemptId: request.intent.attemptId,
      runtimeSessionId: outcome.runtimeSessionId,
      runtimeReceiptDigest: outcome.receiptDigest,
      reasonCode,
    })
    const failed = reasonCode === 'TASK_VERIFICATION_CAPTURE_FAILED'
    store.writeAgentReconcile(address, this.idempotency(request), {
      attemptId: request.intent.attemptId,
      runtimeSessionId: outcome.runtimeSessionId,
      expectedReceiptDigest: request.intent.expectedReceiptDigest,
      outcome: failed ? 'FAILED' : 'OUTCOME_UNKNOWN',
      receiptDigest,
      failure: failed ? failureSignal('CANDIDATE_AUDIT_FAILED', receiptDigest) : undefined,
      receipt,
      now: this.now(),
    })
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
        ...(baseline.baseRevision ? { baseRevision: baseline.baseRevision } : {}),
        baselineTreeHash: baseline.baselineTreeHash,
        initialTargetFingerprint: baseline.initialTargetFingerprint,
      })
      return baseline.baselineDigest === expected ? { ok: true, value: baseline } : { ok: false, reasonCode: 'BASELINE_DIGEST_MISMATCH' }
    } catch {
      return { ok: false, reasonCode: 'BASELINE_PROVIDER_ERROR' }
    }
  }

  private async runtimeRequest(
    address: HubAddressV1,
    selection: RuntimeAdapterSelectionV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.report.record' }> },
    attempt: NonNullable<ReturnType<CollaborationHubSqliteStoreV1['attempt']>>,
    workspaceReceiptDigest: string,
  ): Promise<RuntimeCreateOrResumeRequestV1> {
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
    const bridgedWorkspace = await this.options.workspaceBridge?.runtimeWorkspace(request.intent.attemptId)
    const bridgedPromptRef = this.options.runtimePromptVault?.promptRefForAttempt(request.intent.attemptId)
    if (!bridgedWorkspace || !bridgedPromptRef) {
      throw new Error('RUNTIME_PRIVATE_BINDING_MISSING')
    }
    return {
      requestId: request.requestId,
      scope,
      workspace: bridgedWorkspace,
      selection,
      productionPolicy: { allowedSelections: [selection], rejectDiagnosticOnly: true },
      promptEnvelopeRef: bridgedPromptRef,
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

function failedWorkspaceReceipt(
  attemptId: AttemptId,
  composition: {
    attemptId: AttemptId
    compositionAttemptId: string
    requestDigest: string
    baselineBindingDigest: string
    compositionDigest: string
  },
  error: unknown,
): WorkspacePreparedReceiptM2BV1 {
  const reasonCode = safeReasonCode(error)
  const failure = {
    kind: reasonCode === 'BASE_REVISION_UNAVAILABLE'
      ? 'BASE_REVISION_UNAVAILABLE' as const
      : 'WORKTREE_CREATE_FAILED' as const,
    failureDigest: payloadDigest({ attemptId, reasonCode, purpose: 'workspace.prepare.failed.v1' }),
  }
  const binding = {
    compositionAttemptId: composition.compositionAttemptId,
    attemptId,
    requestDigest: composition.requestDigest,
    baselineBindingDigest: composition.baselineBindingDigest,
    compositionDigest: composition.compositionDigest,
  }
  const receiptDigest = payloadDigest({ status: 'FAILED', binding, failure })
  return {
    status: 'FAILED',
    workspaceReceiptId: `xhbw_failed_${receiptDigest.slice(-32)}` as WorkspaceReceiptId,
    receiptDigest,
    failure,
    ...binding,
  }
}

function safeReasonCode(error: unknown): string {
  const candidate =
    typeof error === 'object' && error !== null && 'reasonCode' in error
      ? (error as { reasonCode?: unknown }).reasonCode
      : undefined
  return typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate)
    ? candidate
    : 'WORKSPACE_BRIDGE_FAILED'
}

function withAuthoritativeM2BActions(
  projection: SessionCollaborationProjectionM2BV1,
  runtimeConfigured: boolean,
): SessionCollaborationProjectionM2BV1 {
  const baseActions = projection.availableActions.filter(
    (action) => action !== 'execution.next.confirm',
  )
  if (
    !runtimeConfigured ||
    projection.authoritativeMode !== 'CODING' ||
    projection.activeFlow?.status !== 'PLAN_ACTIVE' ||
    projection.attempts.some((attempt) =>
      [
        'CREATED',
        'WORKSPACE_PREPARING',
        'READY',
        'STARTING',
        'RUNNING',
        'VERIFYING',
        'INTERRUPT_REQUESTED',
        'OUTCOME_UNKNOWN',
      ].includes(attempt.status),
    )
  ) {
    return { ...projection, availableActions: baseActions }
  }
  const executable = projection.taskRuns.some((run) => {
    if (run.status !== 'BLOCKED' || run.attemptId) return false
    const spec = projection.taskSpecs.find((candidate) => candidate.taskSpecId === run.taskSpecId)
    return spec?.dependsOn.length === 0
  })
  return executable
    ? { ...projection, availableActions: [...baseActions, 'execution.next.confirm'] }
    : { ...projection, availableActions: baseActions }
}

const DELIVERY_ACTIONS = new Set([
  'delivery.selection.submit',
  'delivery.gate.approve',
  'delivery.gate.reject',
  'apply.reconcile.request',
  'apply.retry.request',
  'apply.recovery.prepare',
])

const DELIVERY_TARGET_INTEGRITY_FAILURES = new Set([
  'TARGET_BASELINE_DRIFT',
])
const DELIVERY_NON_RETRYABLE_INTEGRITY_FAILURES = new Set([
  'TARGET_BASELINE_DRIFT',
  'TARGET_STATUS_DIRTY',
  'TARGET_FILE_DRIFT',
])

function withAuthoritativeDeliveryActions(
  projection: SessionCollaborationProjectionM2BV1,
  activeDelivery: DeliveryBatchProjectionV1 | null,
): SessionCollaborationProjectionM2BV1 {
  const availableActions = projection.availableActions.filter((action) => !DELIVERY_ACTIONS.has(action))
  const base = { ...projection, activeDelivery, availableActions }
  if (projection.authoritativeMode !== 'CODING' || projection.activeFlow?.status !== 'PLAN_ACTIVE') return base

  if (!activeDelivery) {
    return projection.taskRuns.some((run) => run.status === 'VERIFIED')
      ? { ...base, availableActions: [...availableActions, 'delivery.selection.submit'] }
      : base
  }

  if (activeDelivery.state === 'READY_FOR_REVIEW' && activeDelivery.gate?.state === 'OPEN') {
    return {
      ...base,
      availableActions: [...availableActions, 'delivery.gate.approve', 'delivery.gate.reject'],
    }
  }
  if (activeDelivery.state === 'OUTCOME_UNKNOWN' || activeDelivery.applyAttempt?.state === 'OUTCOME_UNKNOWN') {
    return { ...base, availableActions: [...availableActions, 'apply.reconcile.request'] }
  }
  if (
    activeDelivery.state === 'APPROVED' &&
    (activeDelivery.applyAttempt?.state === 'FAILED' || activeDelivery.applyAttempt?.state === 'FAILED_ROLLED_BACK') &&
    DELIVERY_TARGET_INTEGRITY_FAILURES.has(activeDelivery.applyAttempt.safeCode ?? '') &&
    (activeDelivery.applyAttempt.changedRelativePaths ?? []).length === 0
  ) {
    return { ...base, availableActions: [...availableActions, 'apply.recovery.prepare'] }
  }
  if (
    activeDelivery.state === 'APPROVED' &&
    (activeDelivery.applyAttempt?.state === 'FAILED' || activeDelivery.applyAttempt?.state === 'FAILED_ROLLED_BACK') &&
    !DELIVERY_NON_RETRYABLE_INTEGRITY_FAILURES.has(activeDelivery.applyAttempt.safeCode ?? '')
  ) {
    return { ...base, availableActions: [...availableActions, 'apply.retry.request'] }
  }
  return base
}

function matchesCapturedFlowBaseline(
  persisted: NonNullable<ReturnType<CollaborationHubSqliteStoreV1['flowExecutionBaseline']>>,
  captured: ExecutionBaselineV1,
  capturedBaselineBindingDigest: string,
): boolean {
  return (
    persisted.baseline_id === captured.baselineId &&
    (persisted.base_revision ?? undefined) === captured.baseRevision &&
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
  if (value.safeCode === 'CANDIDATE_AUDIT_FAILED') return value.failureClass === 'PROTOCOL'
  if (value.safeCode === 'UNKNOWN_RUNTIME_FAILURE') return value.failureClass === 'UNKNOWN'
  return value.failureClass === 'RUNTIME' &&
    ['RUNTIME_FAILED', 'RUNTIME_ADAPTER_ERROR', 'RUNTIME_SESSION_NOT_FOUND', 'RUNTIME_OUTCOME_SESSION_MISMATCH'].includes(value.safeCode)
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
  const failureClass = safeCode === 'UNKNOWN_RUNTIME_FAILURE'
    ? 'UNKNOWN'
    : safeCode === 'CANDIDATE_AUDIT_FAILED'
      ? 'PROTOCOL'
      : 'RUNTIME'
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
