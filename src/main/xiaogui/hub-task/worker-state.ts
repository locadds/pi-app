import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import type { XiaoguiTaskDeliveryReceiptV1 } from '@shared/xiaogui-hub-task-contract'

/**
 * Worker-only projections are intentionally narrower than Hub publication
 * contracts. The desktop needs the assigned package, but not publisher,
 * recipient, node, token, key, or runtime identity fields.
 */
export interface HubTaskWorkerAssignmentV1 {
  assignmentId: string
  taskId: string
  decisionState: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'RETURNED'
  deliveryState: 'QUEUED' | 'NODE_STORED' | 'OPENED'
  executionState: 'NOT_STARTED' | 'RUNNING' | 'RESULT_READY' | 'COMPLETED' | 'FAILED' | 'OUTCOME_UNKNOWN'
  createdAt: string
  updatedAt: string
}

export interface HubTaskWorkerOfferV1 {
  taskId: string
  mode: 'DIRECT' | 'POOL'
  title: string
  taskContent: string
  constraints: readonly string[]
  acceptanceRequirements: readonly string[]
  attachmentRefs: readonly string[]
  packageSha256: string
}

export interface HubTaskWorkerAssignmentDetailV1 {
  assignment: HubTaskWorkerAssignmentV1
  offer: HubTaskWorkerOfferV1
}

export type HubTaskWorkerLocalDeliveryStateV1 = 'NOT_OPENED' | 'PENDING_H1_4_RECEIPT'

export interface HubTaskWorkerPlanDraftBindingV1 extends HubAddressV1 {
  flowId: string
  revisionId: string
  createdAt: string
}

export interface HubTaskWorkerInboxEntryV1 extends HubTaskWorkerAssignmentDetailV1 {
  openedAt: string | null
  localDeliveryState: HubTaskWorkerLocalDeliveryStateV1
  localPlanDraft: HubTaskWorkerPlanDraftBindingV1 | null
}

export interface HubTaskWorkerPendingReceiptV1 {
  receipt: XiaoguiTaskDeliveryReceiptV1
  queuedAt: string
}

export interface HubTaskWorkerStateV1 {
  version: 1
  assignments: Record<string, HubTaskWorkerInboxEntryV1>
  receipts: Record<string, HubTaskWorkerPendingReceiptV1>
  lastReceiptSequence: number
  cursor: string | null
}

export interface HubTaskWorkerStatePersistenceV1 {
  read(): HubTaskWorkerStateV1 | undefined
  write(state: HubTaskWorkerStateV1): void
}

export interface HubTaskWorkerStateStoreV1 {
  snapshot(): HubTaskWorkerStateV1
  cursor(): string | null
  setCursor(cursor: string | null): void
  hasAssignment(assignmentId: string): boolean
  listAssignments(): readonly HubTaskWorkerInboxEntryV1[]
  requireAssignment(assignmentId: string): HubTaskWorkerInboxEntryV1
  upsertAssignment(detail: HubTaskWorkerAssignmentDetailV1): void
  /**
   * The H1-3 Worker endpoint returns a complete active-node snapshot. Remove
   * stale local package projections only after a successful authoritative poll.
   * Pending signed evidence is intentionally retained for H1-4 reconciliation.
   */
  reconcileAssignments(authoritativeAssignmentIds: readonly string[]): void
  markOpened(assignmentId: string, openedAt: string): HubTaskWorkerInboxEntryV1
  enqueueReceipt(receipt: XiaoguiTaskDeliveryReceiptV1, queuedAt: string): void
  pendingReceipts(): readonly HubTaskWorkerPendingReceiptV1[]
  nextReceiptSequence(): number
  bindPlanDraft(assignmentId: string, binding: HubTaskWorkerPlanDraftBindingV1): void
}

const EMPTY_STATE: HubTaskWorkerStateV1 = {
  version: 1,
  assignments: {},
  receipts: {},
  lastReceiptSequence: 0,
  cursor: null,
}

export function createInMemoryHubTaskWorkerStateStoreV1(
  initial?: HubTaskWorkerStateV1,
): HubTaskWorkerStateStoreV1 {
  let persisted = initial ? cloneState(initial) : undefined
  return new HubTaskWorkerStateStoreImpl({
    read: () => persisted,
    write: (state) => {
      persisted = cloneState(state)
    },
  })
}

export function createHubTaskWorkerStateStoreV1(
  persistence: HubTaskWorkerStatePersistenceV1,
): HubTaskWorkerStateStoreV1 {
  return new HubTaskWorkerStateStoreImpl(persistence)
}

class HubTaskWorkerStateStoreImpl implements HubTaskWorkerStateStoreV1 {
  private state: HubTaskWorkerStateV1

  constructor(private readonly persistence: HubTaskWorkerStatePersistenceV1) {
    this.state = normalizeState(persistence.read())
  }

  snapshot(): HubTaskWorkerStateV1 {
    return cloneState(this.state)
  }

  cursor(): string | null {
    return this.state.cursor
  }

  setCursor(cursor: string | null): void {
    this.state = { ...this.state, cursor }
    this.persist()
  }

  hasAssignment(assignmentId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.state.assignments, assignmentId)
  }

  listAssignments(): readonly HubTaskWorkerInboxEntryV1[] {
    return Object.values(this.state.assignments)
      .map(cloneEntry)
      .sort((left, right) => right.assignment.updatedAt.localeCompare(left.assignment.updatedAt))
  }

  requireAssignment(assignmentId: string): HubTaskWorkerInboxEntryV1 {
    const entry = this.state.assignments[assignmentId]
    if (!entry) throw new Error('HUB_ASSIGNMENT_NOT_IN_LOCAL_INBOX')
    return cloneEntry(entry)
  }

  upsertAssignment(detail: HubTaskWorkerAssignmentDetailV1): void {
    assertDetail(detail)
    const assignmentId = detail.assignment.assignmentId
    const previous = this.state.assignments[assignmentId]
    const packageChanged = previous && (
      previous.assignment.taskId !== detail.assignment.taskId ||
      previous.offer.packageSha256 !== detail.offer.packageSha256
    )
    const next: HubTaskWorkerInboxEntryV1 = {
      assignment: cloneAssignment(detail.assignment),
      offer: cloneOffer(detail.offer),
      openedAt: packageChanged ? null : previous?.openedAt ?? null,
      localDeliveryState: packageChanged ? 'NOT_OPENED' : previous?.localDeliveryState ?? 'NOT_OPENED',
      localPlanDraft: packageChanged ? null : previous?.localPlanDraft ?? null,
    }
    this.state = {
      ...this.state,
      assignments: { ...this.state.assignments, [assignmentId]: next },
    }
    this.persist()
  }

  reconcileAssignments(authoritativeAssignmentIds: readonly string[]): void {
    const allowed = new Set(authoritativeAssignmentIds)
    const assignments = Object.fromEntries(
      Object.entries(this.state.assignments).filter(([assignmentId]) => allowed.has(assignmentId)),
    )
    if (Object.keys(assignments).length === Object.keys(this.state.assignments).length) return
    this.state = { ...this.state, assignments }
    this.persist()
  }

  markOpened(assignmentId: string, openedAt: string): HubTaskWorkerInboxEntryV1 {
    const existing = this.state.assignments[assignmentId]
    if (!existing) throw new Error('HUB_ASSIGNMENT_NOT_IN_LOCAL_INBOX')
    const next: HubTaskWorkerInboxEntryV1 = {
      ...existing,
      openedAt: existing.openedAt ?? openedAt,
      // This is deliberately local evidence only. Hub delivery remains the
      // server value until H1-4 verifies a signed receipt.
      localDeliveryState: 'PENDING_H1_4_RECEIPT',
    }
    this.state = {
      ...this.state,
      assignments: { ...this.state.assignments, [assignmentId]: next },
    }
    this.persist()
    return cloneEntry(next)
  }

  enqueueReceipt(receipt: XiaoguiTaskDeliveryReceiptV1, queuedAt: string): void {
    const existing = this.state.receipts[receipt.eventId]
    if (existing) {
      if (canonicalReceipt(existing.receipt) !== canonicalReceipt(receipt)) {
        throw new Error('HUB_LOCAL_RECEIPT_IDEMPOTENCY_CONFLICT')
      }
      return
    }
    this.state = {
      ...this.state,
      receipts: {
        ...this.state.receipts,
        [receipt.eventId]: { receipt: cloneReceipt(receipt), queuedAt },
      },
      lastReceiptSequence: Math.max(this.state.lastReceiptSequence, receipt.sequence),
    }
    this.persist()
  }

  pendingReceipts(): readonly HubTaskWorkerPendingReceiptV1[] {
    return Object.values(this.state.receipts)
      .map((entry) => ({ receipt: cloneReceipt(entry.receipt), queuedAt: entry.queuedAt }))
      .sort((left, right) => left.receipt.sequence - right.receipt.sequence)
  }

  nextReceiptSequence(): number {
    const next = this.state.lastReceiptSequence + 1
    this.state = { ...this.state, lastReceiptSequence: next }
    this.persist()
    return next
  }

  bindPlanDraft(assignmentId: string, binding: HubTaskWorkerPlanDraftBindingV1): void {
    const existing = this.state.assignments[assignmentId]
    if (!existing) throw new Error('HUB_ASSIGNMENT_NOT_IN_LOCAL_INBOX')
    const next: HubTaskWorkerInboxEntryV1 = { ...existing, localPlanDraft: { ...binding } }
    this.state = {
      ...this.state,
      assignments: { ...this.state.assignments, [assignmentId]: next },
    }
    this.persist()
  }

  private persist(): void {
    this.persistence.write(cloneState(this.state))
  }
}

function normalizeState(value: HubTaskWorkerStateV1 | undefined): HubTaskWorkerStateV1 {
  if (!isStoredState(value)) return cloneState(EMPTY_STATE)
  return cloneState(value)
}

function assertDetail(detail: HubTaskWorkerAssignmentDetailV1): void {
  if (
    !detail ||
    !detail.assignment ||
    !detail.offer ||
    !isOpaqueId(detail.assignment.assignmentId) ||
    !isOpaqueId(detail.assignment.taskId) ||
    detail.assignment.taskId !== detail.offer.taskId ||
    !isSha256(detail.offer.packageSha256)
  ) {
    throw new Error('HUB_ASSIGNMENT_DETAIL_INVALID')
  }
}

function cloneState(state: HubTaskWorkerStateV1): HubTaskWorkerStateV1 {
  return {
    version: 1,
    assignments: Object.fromEntries(Object.entries(state.assignments ?? {}).map(([id, entry]) => [id, cloneEntry(entry)])),
    receipts: Object.fromEntries(Object.entries(state.receipts ?? {}).map(([id, entry]) => [
      id,
      { receipt: cloneReceipt(entry.receipt), queuedAt: entry.queuedAt },
    ])),
    lastReceiptSequence: Number.isSafeInteger(state.lastReceiptSequence) && state.lastReceiptSequence >= 0
      ? state.lastReceiptSequence
      : 0,
    cursor: typeof state.cursor === 'string' ? state.cursor : null,
  }
}

function cloneEntry(entry: HubTaskWorkerInboxEntryV1): HubTaskWorkerInboxEntryV1 {
  return {
    assignment: cloneAssignment(entry.assignment),
    offer: cloneOffer(entry.offer),
    openedAt: entry.openedAt,
    localDeliveryState: entry.localDeliveryState,
    localPlanDraft: entry.localPlanDraft ? { ...entry.localPlanDraft } : null,
  }
}

function cloneAssignment(assignment: HubTaskWorkerAssignmentV1): HubTaskWorkerAssignmentV1 {
  return { ...assignment }
}

function cloneOffer(offer: HubTaskWorkerOfferV1): HubTaskWorkerOfferV1 {
  return {
    ...offer,
    constraints: [...offer.constraints],
    acceptanceRequirements: [...offer.acceptanceRequirements],
    attachmentRefs: [...offer.attachmentRefs],
  }
}

function cloneReceipt(receipt: XiaoguiTaskDeliveryReceiptV1): XiaoguiTaskDeliveryReceiptV1 {
  return { ...receipt }
}

function canonicalReceipt(receipt: XiaoguiTaskDeliveryReceiptV1): string {
  return JSON.stringify(receipt)
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function isStoredState(value: unknown): value is HubTaskWorkerStateV1 {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as HubTaskWorkerStateV1).version === 1 &&
      isRecord((value as HubTaskWorkerStateV1).assignments) &&
      isRecord((value as HubTaskWorkerStateV1).receipts) &&
      Number.isSafeInteger((value as HubTaskWorkerStateV1).lastReceiptSequence) &&
      (value as HubTaskWorkerStateV1).lastReceiptSequence >= 0 &&
      ((value as HubTaskWorkerStateV1).cursor === null || typeof (value as HubTaskWorkerStateV1).cursor === 'string'),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
