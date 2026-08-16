import type { SessionAddressV1, SessionMode } from './xiaogui-session-scope'

export type HubAddressV1 = SessionAddressV1
export type CollaborationHubContractVersionV1 = 'm2a.v1' | 'm2b.v1'

export type FlowId = string & { readonly __brand: 'FlowId' }
export type PlanRevisionId = string & { readonly __brand: 'PlanRevisionId' }
export type TaskSpecId = string & { readonly __brand: 'TaskSpecId' }
export type TaskRunId = string & { readonly __brand: 'TaskRunId' }

export type CollaborationHubActionV1 =
  | 'flow.start.with_draft'
  | 'plan.revision.submit'
  | 'flow.cancel'

export type CollaborationFlowStatusV1 = 'AWAITING_PLAN_APPROVAL' | 'PLAN_ACTIVE' | 'CANCELLED'
export type PlanRevisionStatusV1 = 'DRAFT' | 'ACTIVE'
export type TaskRunStatusV1 = 'PENDING_DISABLED'
export type TaskRunStatusM2BV1 =
  | 'BLOCKED'
  | 'DEPENDENCY_ELIGIBLE'
  | 'READY'
  | 'RUNNING'
  | 'VERIFYING'
  | 'FAILED'
  | 'VERIFIED'
  | 'DELIVERY_PENDING'
  | 'APPLYING'
  | 'CANCEL_REQUESTED'
  | 'DONE'
  | 'INTERRUPT_REQUESTED'
  | 'OUTCOME_UNKNOWN'
  | 'CANCELLED'
  | 'INVALIDATED'
  | 'SUPERSEDED'

export interface InitialPlanTaskInputV1 {
  taskKey: string
  title: string
  summary?: string
  dependsOn?: string[]
}

export interface InitialPlanDraftInputV1 {
  objective: string
  tasks: InitialPlanTaskInputV1[]
}

export type EditablePlanDraftV1 = InitialPlanDraftInputV1

export interface FlowStartWithDraftIntentV1 {
  type: 'flow.start.with_draft'
  draft: InitialPlanDraftInputV1
  sourceTurnId?: string
}

export interface PlanRevisionSubmitIntentV1 {
  type: 'plan.revision.submit'
  flowId: FlowId
  baseRevisionId: PlanRevisionId
  draft: EditablePlanDraftV1
}

export interface FlowCancelIntentV1 {
  type: 'flow.cancel'
  flowId: FlowId
  reason: string
}

export type M2ADisabledIntentTypeV1 =
  | 'flow.start'
  | 'agent.revision.proposal.record'
  | 'task.run.guide'
  | 'task.run.cancel'
  | 'attempt.interrupt'
  | 'delivery.selection.submit'
  | 'gate.decide'
  | 'apply.reconcile.request'
  | 'apply.retry.request'
  | 'correction.create'
  | 'system.schedule'
  | 'system.workspace.prepare.result.record'
  | 'system.agent.report.record'
  | 'system.agent.outcome.record'
  | 'system.agent.reconcile'
  | 'system.verification.complete'
  | 'system.verification.reconcile'

/**
 * M2A deliberately recognises later-phase intents so callers receive the
 * stable INTENT_DISABLED outcome instead of a schema/internal error. Their
 * payloads are intentionally not modelled until the owning slice is frozen.
 */
export interface M2ADisabledIntentV1 {
  type: M2ADisabledIntentTypeV1
}

export type M2AEnabledUserIntentV1 =
  | FlowStartWithDraftIntentV1
  | PlanRevisionSubmitIntentV1
  | FlowCancelIntentV1

export type M2AUserIntentV1 = M2AEnabledUserIntentV1 | M2ADisabledIntentV1

export interface UserIntentRequestV1 {
  requestId: string
  expectedSessionVersion?: number
  intent: M2AUserIntentV1
}

export interface HubTrustedActorV1 {
  kind: 'main-process-user'
}

export interface HubCommandRequestV1 extends UserIntentRequestV1 {
  contractVersion: CollaborationHubContractVersionV1
  address: HubAddressV1
  trustedActor: HubTrustedActorV1
}

export interface CollaborationFlowSummaryV1 {
  flowId: FlowId
  status: CollaborationFlowStatusV1
  activeRevisionId: PlanRevisionId | null
  objective: string
}

export interface PlanRevisionProjectionV1 {
  revisionId: PlanRevisionId
  status: PlanRevisionStatusV1
  digest: string
  draft: EditablePlanDraftV1
}

export interface TaskSpecProjectionV1 {
  taskSpecId: TaskSpecId
  taskKey: string
  title: string
  summary?: string
  dependsOn: string[]
  unavailableReason: 'AGENT_DISABLED_M2A'
}

export interface TaskRunProjectionV1 {
  taskRunId: TaskRunId
  taskSpecId: TaskSpecId
  taskKey: string
  status: TaskRunStatusV1
  unavailableReason: 'AGENT_DISABLED_M2A'
}

export interface TaskRunProjectionM2BV1 extends Omit<TaskRunProjectionV1, 'status' | 'unavailableReason'> {
  status: TaskRunStatusM2BV1
  unavailableReason?: 'AGENT_DISABLED_M2A'
  attemptId?: AttemptId
}

export type AttemptId = string & { readonly __brand: 'AttemptId' }
export type WorkspaceReceiptId = string & { readonly __brand: 'WorkspaceReceiptId' }

export type AttemptStatusM2BV1 =
  | 'CREATED'
  | 'WORKSPACE_PREPARING'
  | 'READY'
  | 'STARTING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'INTERRUPT_REQUESTED'
  | 'OUTCOME_UNKNOWN'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'INTERRUPTED'
  | 'CANCELLED'

export interface AttemptProjectionM2BV1 {
  attemptId: AttemptId
  taskRunId: TaskRunId
  status: AttemptStatusM2BV1
  runtimeSessionId?: string
  workspaceReceiptId?: WorkspaceReceiptId
}

export type CollaborationHubActionM2BV1 =
  CollaborationHubActionV1

export interface SessionCollaborationProjectionV1 {
  kind: 'SESSION_COLLABORATION_PROJECTION'
  version: 'm2a.v1'
  address: HubAddressV1
  sessionVersion: number
  sessionMode: SessionMode
  authoritativeMode: SessionMode
  reserved: false | { code: 'DESIGN_RESERVED'; messageKey: 'xiaogui.hub.design_reserved' }
  activeFlow: CollaborationFlowSummaryV1 | null
  activeRevision: PlanRevisionProjectionV1 | null
  taskSpecs: TaskSpecProjectionV1[]
  taskRuns: TaskRunProjectionV1[]
  history: CollaborationFlowSummaryV1[]
  availableActions: CollaborationHubActionV1[]
}

export interface SessionCollaborationProjectionM2BV1
  extends Omit<SessionCollaborationProjectionV1, 'version' | 'taskRuns' | 'availableActions'> {
  version: 'm2b.v1'
  taskRuns: TaskRunProjectionM2BV1[]
  attempts: AttemptProjectionM2BV1[]
  availableActions: CollaborationHubActionM2BV1[]
}

export interface PerformReceiptV1 {
  requestId: string
  intentType: M2AUserIntentV1['type'] | M2BSystemIntentV1['type']
  sessionVersion: number
  flowId?: FlowId
  revisionId?: PlanRevisionId
  taskRunId?: TaskRunId
  attemptId?: AttemptId
}

export type HubErrorCodeV1 =
  | 'SESSION_SCOPE_MISMATCH'
  | 'DESIGN_RESERVED'
  | 'DRAFT_INVALID'
  | 'ACTIVE_FLOW_EXISTS'
  | 'FLOW_NOT_FOUND'
  | 'REVISION_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'STALE_SESSION_VERSION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTENT_DISABLED'
  | 'IPC_VERSION_UNSUPPORTED'
  | 'ILLEGAL_TRANSITION'
  | 'RUNTIME_SELECTION_NOT_APPROVED'
  | 'INTERNAL'

export interface HubSafeErrorV1 {
  code: HubErrorCodeV1
  messageKey: string
  safeArgs?: Record<string, string | number | boolean>
  traceId: string
}

export type HubOutcomeV1<T> = { ok: true; value: T } | { ok: false; error: HubSafeErrorV1 }

export interface HubEventEnvelopeV1 {
  eventId: number
  sessionVersion: number
  sessionSequence: number
  eventType: string
  createdAt: string
}

export type HubReadRequestV1 =
  | { type: 'session.current' }
  | { type: 'flow.by_id'; flowId: FlowId }

export interface HubReadEventsRequestV1 {
  afterSessionSequence?: number
  limit?: number
}

export interface HubObserveIpcRequestV1 {
  contractVersion: CollaborationHubContractVersionV1
  address: HubAddressV1
}

export interface HubPerformIpcRequestV1 {
  contractVersion: CollaborationHubContractVersionV1
  address: HubAddressV1
  request: UserIntentRequestV1
}

export interface HubReadIpcRequestV1 {
  contractVersion: CollaborationHubContractVersionV1
  address: HubAddressV1
  request: HubReadRequestV1
}

export interface HubReadEventsIpcRequestV1 {
  contractVersion: CollaborationHubContractVersionV1
  address: HubAddressV1
  request?: HubReadEventsRequestV1
}

export type WorkspacePreparationFailureSourceV1 =
  | { kind: 'WORKTREE_CREATE_FAILED'; failureDigest: string }
  | { kind: 'BASE_REVISION_UNAVAILABLE'; failureDigest: string }
  | { kind: 'DEPENDENCY_CHANGESET_UNAVAILABLE'; failureDigest: string }

export type WorkspacePreparedReceiptM2BV1 =
  | ({
      status: 'PREPARED'
      workspaceReceiptId: WorkspaceReceiptId
      receiptDigest: string
    } & WorkspaceReceiptBindingM2BV1)
  | ({
      status: 'CONFLICT'
      workspaceReceiptId: WorkspaceReceiptId
      receiptDigest: string
      conflictDigest: string
    } & WorkspaceReceiptBindingM2BV1)
  | ({
      status: 'FAILED'
      workspaceReceiptId: WorkspaceReceiptId
      receiptDigest: string
      failure: WorkspacePreparationFailureSourceV1
    } & WorkspaceReceiptBindingM2BV1)

export interface WorkspaceReceiptBindingM2BV1 {
  compositionAttemptId: string
  attemptId: AttemptId
  requestDigest: string
  baselineBindingDigest: string
  compositionDigest: string
}

export type AgentFailureSignalV1 = {
  kind: 'AGENT_FAILURE'
  failureClass: 'RUNTIME' | 'PROTOCOL' | 'UNKNOWN'
  safeCode:
    | 'RUNTIME_FAILED'
    | 'RUNTIME_ADAPTER_ERROR'
    | 'RUNTIME_SESSION_NOT_FOUND'
    | 'RUNTIME_OUTCOME_SESSION_MISMATCH'
    | 'UNKNOWN_RUNTIME_FAILURE'
  receiptDigest: string
}

export interface AgentSucceededAuditV1 {
  runtimeSessionId: string
  attemptId: AttemptId
  receiptDigest: string
  candidateDigest: string
}

export interface SystemScheduleIntentM2BV1 {
  type: 'system.schedule'
  flowId: FlowId
}

export interface SystemWorkspacePrepareResultRecordIntentM2BV1 {
  type: 'system.workspace.prepare.result.record'
  flowId: FlowId
  taskRunId: TaskRunId
  attemptId: AttemptId
  receipt: WorkspacePreparedReceiptM2BV1
}

export interface SystemAgentReportRecordIntentM2BV1 {
  type: 'system.agent.report.record'
  flowId: FlowId
  taskRunId: TaskRunId
  attemptId: AttemptId
}

export type SystemAgentOutcomeRecordIntentM2BV1 =
  | {
      type: 'system.agent.outcome.record'
      flowId: FlowId
      taskRunId: TaskRunId
      attemptId: AttemptId
      runtimeSessionId: string
      outcome: 'FAILED'
      receiptDigest: string
      failure: AgentFailureSignalV1
    }
  | {
      type: 'system.agent.outcome.record'
      flowId: FlowId
      taskRunId: TaskRunId
      attemptId: AttemptId
      runtimeSessionId: string
      outcome: 'INTERRUPTED' | 'OUTCOME_UNKNOWN'
      receiptDigest: string
      failure?: never
    }

export interface SystemAgentReconcileIntentM2BV1 {
  type: 'system.agent.reconcile'
  attemptId: AttemptId
  runtimeSessionId: string
  expectedReceiptDigest?: string
}

export type M2BSystemIntentV1 =
  | SystemScheduleIntentM2BV1
  | SystemWorkspacePrepareResultRecordIntentM2BV1
  | SystemAgentReportRecordIntentM2BV1
  | SystemAgentOutcomeRecordIntentM2BV1
  | SystemAgentReconcileIntentM2BV1

export interface HubSystemCommandRequestM2BV1 {
  contractVersion: 'm2b.v1'
  address: HubAddressV1
  requestId: string
  expectedSessionVersion?: number
  intent: M2BSystemIntentV1
  trustedActor: { kind: 'main-process-system' }
}

export type HubSystemErrorCodeM2BV1 =
  | 'AGENT_UNAVAILABLE'
  | 'BASELINE_UNAVAILABLE'
  | 'WORKSPACE_RECEIPT_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STALE_SESSION_VERSION'
  | 'FLOW_NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'DESIGN_RESERVED'
  | 'SESSION_SCOPE_MISMATCH'
  | 'IPC_VERSION_UNSUPPORTED'
  | 'INTERNAL'

export interface HubSystemSafeErrorM2BV1 {
  code: HubSystemErrorCodeM2BV1
  messageKey: string
  safeArgs?: Record<string, string | number | boolean>
  traceId: string
}

export type HubSystemOutcomeM2BV1<T> = { ok: true; value: T } | { ok: false; error: HubSystemSafeErrorM2BV1 }
