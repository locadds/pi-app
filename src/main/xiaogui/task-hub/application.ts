import { randomUUID } from 'node:crypto'

import type {
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

export interface CollaborationHubApplicationOptionsV1 {
  lookup: SessionScopeLookupV1
  storeFactory: () => CollaborationHubSqliteStoreV1
  now?: () => string
  idFactory?: (prefix: string) => string
}

export interface CollaborationHubApplicationV1 {
  execute(request: HubCommandRequestV1): Promise<HubOutcomeV1<PerformReceiptV1>>
  executeSystem(request: HubSystemCommandRequestM2BV1): Promise<HubOutcomeV1<PerformReceiptV1>>
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

  async executeSystem(request: HubSystemCommandRequestM2BV1): Promise<HubOutcomeV1<PerformReceiptV1>> {
    try {
      if (request.contractVersion !== 'm2b.v1' || request.trustedActor.kind !== 'main-process-system') return hubError('IPC_VERSION_UNSUPPORTED')
      const scope = await this.resolve(request.address)
      if (!scope.ok) return scope
      if (scope.value.mode === 'DESIGN') return hubError('DESIGN_RESERVED')
      switch (request.intent.type) {
        case 'system.schedule':
          return this.schedule(request.address, scope.value.mode, request as HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.schedule' }> })
        case 'system.workspace.prepare.result.record':
          return this.recordWorkspaceResult(request.address, request as HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.workspace.prepare.result.record' }> })
        case 'system.agent.report.record':
          return this.recordAgentReport(request.address, request as HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.report.record' }> })
        case 'system.agent.outcome.record':
          return this.recordAgentOutcome(request.address, request as HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.outcome.record' }> })
        case 'system.agent.reconcile':
          return this.reconcileAgent(request.address, request as HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.reconcile' }> })
        default:
          return hubError('INTENT_DISABLED')
      }
    } catch {
      return hubError('INTERNAL')
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

  private schedule(address: HubAddressV1, mode: SessionMode, request: HubSystemCommandRequestM2BV1 & { intent: { type: 'system.schedule'; flowId: FlowId } }): HubOutcomeV1<PerformReceiptV1> {
    const store = this.getStore()
    const replay = this.checkIdempotency(store, address, request)
    if (replay) return replay
    if (this.hasStaleExpectedVersion(store, address, request)) return hubError('STALE_SESSION_VERSION')
    const projection = store.readProjection(address) ?? emptyProjection(address, mode)
    if (!projection.activeFlow || projection.activeFlow.flowId !== request.intent.flowId || projection.activeFlow.status !== 'PLAN_ACTIVE') {
      return hubError('FLOW_NOT_FOUND')
    }
    if (store.hasActiveExternalAttempt()) return hubError('ILLEGAL_TRANSITION')
    const task = store.taskRuns(request.intent.flowId).find((candidate) => {
      if (candidate.status !== 'PENDING_DISABLED') return false
      const dependsOn = JSON.parse(candidate.depends_json) as string[]
      return dependsOn.length === 0
    })
    if (!task) return hubError('ILLEGAL_TRANSITION')
    const attemptId = this.id('xhba') as AttemptId
    const receipt = {
      requestId: request.requestId,
      intentType: request.intent.type,
      sessionVersion: 0,
      flowId: request.intent.flowId,
      taskRunId: task.task_run_id,
      attemptId,
    }
    store.writeSchedule(address, this.idempotency(request), {
      flowId: request.intent.flowId,
      taskRunId: task.task_run_id,
      attemptId,
      attemptDigest: payloadDigest({ flowId: request.intent.flowId, taskRunId: task.task_run_id, attemptId }),
      projection,
      receipt,
      now: this.now(),
    })
    return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
  }

  private recordWorkspaceResult(
    address: HubAddressV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.workspace.prepare.result.record' }> },
  ): HubOutcomeV1<PerformReceiptV1> {
    const store = this.getStore()
    const replay = this.checkIdempotency(store, address, request)
    if (replay) return replay
    if (this.hasStaleExpectedVersion(store, address, request)) return hubError('STALE_SESSION_VERSION')
    const attempt = store.attempt(request.intent.attemptId)
    if (!attempt || attempt.status !== 'WORKSPACE_PREPARING' || attempt.task_run_id !== request.intent.taskRunId) return hubError('ILLEGAL_TRANSITION')
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

  private recordAgentReport(
    address: HubAddressV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.report.record' }> },
  ): HubOutcomeV1<PerformReceiptV1> {
    const store = this.getStore()
    const replay = this.checkIdempotency(store, address, request)
    if (replay) return replay
    if (this.hasStaleExpectedVersion(store, address, request)) return hubError('STALE_SESSION_VERSION')
    const attempt = store.attempt(request.intent.attemptId)
    if (!attempt || attempt.task_run_id !== request.intent.taskRunId) return hubError('ILLEGAL_TRANSITION')
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
        payloadDigest: request.intent.reportDigest,
        now: this.now(),
      })
    }
    const startingAttempt = store.attempt(request.intent.attemptId)
    if (!startingAttempt || startingAttempt.status !== 'STARTING') return hubError('ILLEGAL_TRANSITION')
    store.writeAgentReport(address, this.idempotency(request), {
      attemptId: request.intent.attemptId,
      taskRunId: request.intent.taskRunId,
      requestId: request.requestId,
      payloadDigest: request.intent.reportDigest,
      runtimeSessionId: request.intent.runtimeSessionId,
      receipt,
      now: this.now(),
    })
    return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
  }

  private recordAgentOutcome(
    address: HubAddressV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.outcome.record' }> },
  ): HubOutcomeV1<PerformReceiptV1> {
    const store = this.getStore()
    const replay = this.checkIdempotency(store, address, request)
    if (replay) return replay
    if (this.hasStaleExpectedVersion(store, address, request)) return hubError('STALE_SESSION_VERSION')
    const attempt = store.attempt(request.intent.attemptId)
    if (!attempt || attempt.task_run_id !== request.intent.taskRunId) return hubError('ILLEGAL_TRANSITION')
    if (!['STARTING', 'RUNNING'].includes(attempt.status)) return hubError('ILLEGAL_TRANSITION')
    if (attempt.runtime_session_id && attempt.runtime_session_id !== request.intent.runtimeSessionId) return hubError('ILLEGAL_TRANSITION')
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
      receipt,
      now: this.now(),
    })
    return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
  }

  private reconcileAgent(
    address: HubAddressV1,
    request: HubSystemCommandRequestM2BV1 & { intent: Extract<HubSystemCommandRequestM2BV1['intent'], { type: 'system.agent.reconcile' }> },
  ): HubOutcomeV1<PerformReceiptV1> {
    const store = this.getStore()
    const replay = this.checkIdempotency(store, address, request)
    if (replay) return replay
    if (this.hasStaleExpectedVersion(store, address, request)) return hubError('STALE_SESSION_VERSION')
    const attempt = store.attempt(request.intent.attemptId)
    if (!attempt || attempt.status !== 'OUTCOME_UNKNOWN' || attempt.runtime_session_id !== request.intent.runtimeSessionId) return hubError('ILLEGAL_TRANSITION')
    const receipt = {
      requestId: request.requestId,
      intentType: request.intent.type,
      sessionVersion: 0,
      attemptId: request.intent.attemptId,
    }
    store.writeAgentReconcile(address, this.idempotency(request), {
      attemptId: request.intent.attemptId,
      runtimeSessionId: request.intent.runtimeSessionId,
      expectedReceiptDigest: request.intent.expectedReceiptDigest,
      receipt,
      now: this.now(),
    })
    return { ok: true, value: JSON.parse(store.idempotency(address, request.requestId)!.receipt_json) as PerformReceiptV1 }
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
