import type { SessionAddressV1, SessionMode } from './xiaogui-session-scope'

export type HubAddressV1 = SessionAddressV1
export type CollaborationHubContractVersionV1 = 'm2a.v1'

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

export interface PerformReceiptV1 {
  requestId: string
  intentType: M2AUserIntentV1['type']
  sessionVersion: number
  flowId?: FlowId
  revisionId?: PlanRevisionId
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
