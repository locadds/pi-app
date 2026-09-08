import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import {
  parseXiaoguiTaskDeliveryReceiptV1,
  parseXiaoguiTaskResultSubmissionV1,
  type XiaoguiTaskDeliveryReceiptV1,
  type XiaoguiTaskReceiptAckV1,
  type XiaoguiTaskResultAckV1,
  type XiaoguiTaskResultSubmissionV1,
} from '@shared/xiaogui-hub-task-contract'

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

export type HubTaskWorkerLocalDeliveryStateV1 =
  | 'NOT_OPENED'
  | 'PENDING_H1_4_RECEIPT'
  | 'HUB_CONFIRMED'

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

/** A terminal result and its signed terminal receipt are one durable unit. */
export interface HubTaskWorkerPendingResultV1 {
  submission: XiaoguiTaskResultSubmissionV1
  queuedAt: string
}

export type HubTaskWorkerPendingEvidenceV1 =
  | { kind: 'RECEIPT'; receipt: XiaoguiTaskDeliveryReceiptV1; queuedAt: string }
  | { kind: 'RESULT'; submission: XiaoguiTaskResultSubmissionV1; queuedAt: string }

export interface HubTaskWorkerStateV1 {
  version: 1
  assignments: Record<string, HubTaskWorkerInboxEntryV1>
  receipts: Record<string, HubTaskWorkerPendingReceiptV1>
  /** Optional only for H1-4B persisted-record migration; new snapshots always include it. */
  results?: Record<string, HubTaskWorkerPendingResultV1>
  lastReceiptSequence: number
  cursor: string | null
}

export interface HubTaskWorkerStatePersistenceV1 {
  read(): HubTaskWorkerStateV1 | undefined
  write(state: HubTaskWorkerStateV1): void
}

export interface HubTaskWorkerStateStoreV1 {
  snapshot(): HubTaskWorkerStateV1
  /** Clears packages and unsent evidence when this device loses Worker authority. */
  clear(): void
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
  enqueueResult(submission: XiaoguiTaskResultSubmissionV1, queuedAt: string): void
  /**
   * Removes exactly one durable receipt only after the Hub's verified ACK.
   * The event id is the idempotency key; an ACK for any other event is never
   * allowed to advance this local queue.
   */
  acknowledgeReceipt(expectedEventId: string, ack: XiaoguiTaskReceiptAckV1): boolean
  acknowledgeResult(expectedResultId: string, expectedEventId: string, ack: XiaoguiTaskResultAckV1): boolean
  pendingReceipts(): readonly HubTaskWorkerPendingReceiptV1[]
  pendingEvidence(): readonly HubTaskWorkerPendingEvidenceV1[]
  hasPendingResultForAssignment(assignmentId: string): boolean
  hasTerminalEvidenceForAssignment(assignmentId: string): boolean
  nextReceiptSequence(): number
  bindPlanDraft(assignmentId: string, binding: HubTaskWorkerPlanDraftBindingV1): void
}

const EMPTY_STATE: HubTaskWorkerStateV1 = {
  version: 1,
  assignments: {},
  receipts: {},
  results: {},
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

  clear(): void {
    this.state = cloneState(EMPTY_STATE)
    this.persist()
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
    if (Object.values(this.state.results ?? {}).some((entry) => entry.submission.receipt.eventId === receipt.eventId)) {
      throw new Error('HUB_LOCAL_EVIDENCE_EVENT_ID_CONFLICT')
    }
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

  acknowledgeReceipt(expectedEventId: string, ack: XiaoguiTaskReceiptAckV1): boolean {
    const pending = this.state.receipts[ack.eventId]
    if (
      !pending
      || ack.eventId !== expectedEventId
      || ack.verified !== true
      || pending.receipt.eventId !== expectedEventId
    ) return false

    const receipts = { ...this.state.receipts }
    delete receipts[ack.eventId]

    let assignments = this.state.assignments
    if (pending.receipt.eventType === 'USER_OPENED') {
      const entry = assignments[pending.receipt.assignmentId]
      if (
        entry
        && entry.openedAt !== null
        && entry.assignment.taskId === pending.receipt.taskId
        && entry.offer.packageSha256 === pending.receipt.packageSha256
      ) {
        assignments = {
          ...assignments,
          [pending.receipt.assignmentId]: {
            ...entry,
            // The Hub ACK is the first proof that this user-open event was
            // accepted. A later poll remains authoritative for the delivery
            // state itself, but the renderer no longer calls it merely local.
            localDeliveryState: 'HUB_CONFIRMED',
          },
        }
      }
    } else if (pending.receipt.eventType === 'EXECUTION_STARTED') {
      const entry = assignments[pending.receipt.assignmentId]
      if (
        entry
        && entry.assignment.taskId === pending.receipt.taskId
        && entry.offer.packageSha256 === pending.receipt.packageSha256
      ) {
        assignments = {
          ...assignments,
          [pending.receipt.assignmentId]: {
            ...entry,
            assignment: { ...entry.assignment, executionState: 'RUNNING', updatedAt: ack.receivedAt },
          },
        }
      }
    }

    this.state = { ...this.state, assignments, receipts }
    this.persist()
    return true
  }

  pendingReceipts(): readonly HubTaskWorkerPendingReceiptV1[] {
    return Object.values(this.state.receipts)
      .map((entry) => ({ receipt: cloneReceipt(entry.receipt), queuedAt: entry.queuedAt }))
      .sort((left, right) => left.receipt.sequence - right.receipt.sequence)
  }

  enqueueResult(submission: XiaoguiTaskResultSubmissionV1, queuedAt: string): void {
    const parsed = parseXiaoguiTaskResultSubmissionV1(submission)
    if (!parsed.ok) throw new Error('HUB_LOCAL_RESULT_CONTRACT_INVALID')
    const normalized = parsed.value
    if (this.state.receipts[normalized.receipt.eventId]) throw new Error('HUB_LOCAL_EVIDENCE_EVENT_ID_CONFLICT')
    const results = this.state.results ?? {}
    const existing = results[normalized.result.resultId]
    if (existing) {
      if (canonicalResultSubmission(existing.submission) !== canonicalResultSubmission(normalized)) {
        throw new Error('HUB_LOCAL_RESULT_IDEMPOTENCY_CONFLICT')
      }
      return
    }
    if (Object.values(results).some((entry) => entry.submission.receipt.eventId === normalized.receipt.eventId)) {
      throw new Error('HUB_LOCAL_EVIDENCE_EVENT_ID_CONFLICT')
    }
    this.state = {
      ...this.state,
      results: {
        ...results,
        [normalized.result.resultId]: { submission: cloneResultSubmission(normalized), queuedAt },
      },
      lastReceiptSequence: Math.max(this.state.lastReceiptSequence, normalized.receipt.sequence),
    }
    this.persist()
  }

  acknowledgeResult(expectedResultId: string, expectedEventId: string, ack: XiaoguiTaskResultAckV1): boolean {
    const results = this.state.results ?? {}
    const pending = results[ack.resultId]
    if (
      !pending
      || ack.resultId !== expectedResultId
      || ack.eventId !== expectedEventId
      || ack.verified !== true
      || pending.submission.result.resultId !== expectedResultId
      || pending.submission.receipt.eventId !== expectedEventId
      || ack.executionState !== expectedExecutionState(pending.submission.result.outcome)
    ) return false

    const nextResults = { ...results }
    delete nextResults[ack.resultId]
    let assignments = this.state.assignments
    const entry = assignments[pending.submission.result.assignmentId]
    if (
      entry
      && entry.assignment.taskId === pending.submission.result.taskId
      && entry.offer.packageSha256 === pending.submission.receipt.packageSha256
    ) {
      assignments = {
        ...assignments,
        [pending.submission.result.assignmentId]: {
          ...entry,
          assignment: { ...entry.assignment, executionState: ack.executionState, updatedAt: ack.receivedAt },
        },
      }
    }
    this.state = { ...this.state, assignments, results: nextResults }
    this.persist()
    return true
  }

  pendingEvidence(): readonly HubTaskWorkerPendingEvidenceV1[] {
    const receipts: HubTaskWorkerPendingEvidenceV1[] = this.pendingReceipts().map((entry) => ({
      kind: 'RECEIPT',
      receipt: entry.receipt,
      queuedAt: entry.queuedAt,
    }))
    const results: HubTaskWorkerPendingEvidenceV1[] = Object.values(this.state.results ?? {}).map((entry) => ({
      kind: 'RESULT',
      submission: cloneResultSubmission(entry.submission),
      queuedAt: entry.queuedAt,
    }))
    return [...receipts, ...results].sort((left, right) => evidenceSequence(left) - evidenceSequence(right))
  }

  hasPendingResultForAssignment(assignmentId: string): boolean {
    return Object.values(this.state.results ?? {}).some((entry) => entry.submission.result.assignmentId === assignmentId)
  }

  hasTerminalEvidenceForAssignment(assignmentId: string): boolean {
    return this.hasPendingResultForAssignment(assignmentId)
      || Object.values(this.state.assignments).some((entry) => (
        entry.assignment.assignmentId === assignmentId
        && ['RESULT_READY', 'FAILED', 'OUTCOME_UNKNOWN'].includes(entry.assignment.executionState)
      ))
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
    results: Object.fromEntries(Object.entries(state.results ?? {}).map(([id, entry]) => [
      id,
      { submission: cloneResultSubmission(entry.submission), queuedAt: entry.queuedAt },
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

function cloneResultSubmission(submission: XiaoguiTaskResultSubmissionV1): XiaoguiTaskResultSubmissionV1 {
  return {
    result: {
      ...submission.result,
      artifactRefs: submission.result.artifactRefs.map((artifact) => ({ ...artifact })),
      verification: { ...submission.result.verification },
    },
    receipt: { ...submission.receipt },
  }
}

function canonicalReceipt(receipt: XiaoguiTaskDeliveryReceiptV1): string {
  return JSON.stringify(receipt)
}

function canonicalResultSubmission(submission: XiaoguiTaskResultSubmissionV1): string {
  return JSON.stringify(submission)
}

function expectedExecutionState(
  outcome: XiaoguiTaskResultSubmissionV1['result']['outcome'],
): XiaoguiTaskResultAckV1['executionState'] {
  switch (outcome) {
    case 'RESULT_READY': return 'RESULT_READY'
    case 'EXECUTION_FAILED': return 'FAILED'
    case 'OUTCOME_UNKNOWN': return 'OUTCOME_UNKNOWN'
  }
}

function evidenceSequence(evidence: HubTaskWorkerPendingEvidenceV1): number {
  return evidence.kind === 'RECEIPT' ? evidence.receipt.sequence : evidence.submission.receipt.sequence
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function isStoredState(value: unknown): value is HubTaskWorkerStateV1 {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.assignments) || !isRecord(value.receipts)) return false
  const lastReceiptSequence = value.lastReceiptSequence
  if (typeof lastReceiptSequence !== 'number' || !Number.isSafeInteger(lastReceiptSequence) || lastReceiptSequence < 0) return false
  if (value.cursor !== null && (typeof value.cursor !== 'string' || !/^snapshot:[A-Za-z0-9_-]{16,128}$/.test(value.cursor))) return false
  return Object.entries(value.assignments).every(([assignmentId, entry]) => (
    isOpaqueId(assignmentId) && isStoredEntry(entry, assignmentId)
  )) && Object.entries(value.receipts).every(([eventId, entry]) => (
    isOpaqueId(eventId) && isStoredPendingReceipt(entry, eventId)
  )) && (value.results === undefined || (isRecord(value.results) && Object.entries(value.results).every(([resultId, entry]) => (
    isOpaqueId(resultId) && isStoredPendingResult(entry, resultId)
  ))))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStoredEntry(value: unknown, assignmentId: string): value is HubTaskWorkerInboxEntryV1 {
  if (!isRecord(value) || !isStoredAssignment(value.assignment, assignmentId) || !isStoredOffer(value.offer)) return false
  if (value.assignment.taskId !== value.offer.taskId) return false
  if (value.openedAt !== null && !isTimestamp(value.openedAt)) return false
  if (
    value.localDeliveryState !== 'NOT_OPENED'
    && value.localDeliveryState !== 'PENDING_H1_4_RECEIPT'
    && value.localDeliveryState !== 'HUB_CONFIRMED'
  ) return false
  return value.localPlanDraft === null || isStoredPlanDraft(value.localPlanDraft)
}

function isStoredAssignment(value: unknown, assignmentId: string): value is HubTaskWorkerAssignmentV1 {
  return isRecord(value) &&
    value.assignmentId === assignmentId &&
    isOpaqueId(value.taskId) &&
    isOneOf(value.decisionState, ['PENDING', 'ACCEPTED', 'REJECTED', 'RETURNED']) &&
    isOneOf(value.deliveryState, ['QUEUED', 'NODE_STORED', 'OPENED']) &&
    isOneOf(value.executionState, ['NOT_STARTED', 'RUNNING', 'RESULT_READY', 'COMPLETED', 'FAILED', 'OUTCOME_UNKNOWN']) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
}

function isStoredOffer(value: unknown): value is HubTaskWorkerOfferV1 {
  return isRecord(value) &&
    isOpaqueId(value.taskId) &&
    isOneOf(value.mode, ['DIRECT', 'POOL']) &&
    isText(value.title, 1, 200) &&
    isText(value.taskContent, 1, 200_000) &&
    isStringArray(value.constraints, 200, 4_000) &&
    isStringArray(value.acceptanceRequirements, 200, 4_000) &&
    isStringArray(value.attachmentRefs, 200, 4_000) &&
    isSha256(value.packageSha256)
}

function isStoredPlanDraft(value: unknown): value is HubTaskWorkerPlanDraftBindingV1 {
  return isRecord(value) &&
    typeof value.projectId === 'string' && /^xgp1_[0-9a-f]{64}$/.test(value.projectId) &&
    typeof value.sessionKey === 'string' && /^xgs1_[0-9a-f]{64}$/.test(value.sessionKey) &&
    isOpaqueId(value.flowId) &&
    isOpaqueId(value.revisionId) &&
    isTimestamp(value.createdAt)
}

function isStoredPendingReceipt(value: unknown, eventId: string): value is HubTaskWorkerPendingReceiptV1 {
  if (!isRecord(value) || !isTimestamp(value.queuedAt)) return false
  const parsed = parseXiaoguiTaskDeliveryReceiptV1(value.receipt)
  return parsed.ok && parsed.value.eventId === eventId
}

function isStoredPendingResult(value: unknown, resultId: string): value is HubTaskWorkerPendingResultV1 {
  if (!isRecord(value) || !isTimestamp(value.queuedAt)) return false
  const parsed = parseXiaoguiTaskResultSubmissionV1(value.submission)
  return parsed.ok && parsed.value.result.resultId === resultId
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
}

function isText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max
}

function isStringArray(value: unknown, maxItems: number, maxItemLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => isText(item, 1, maxItemLength))
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}
