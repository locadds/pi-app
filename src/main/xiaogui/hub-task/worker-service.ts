import { randomUUID } from 'node:crypto'

import type {
  HubAddressV1,
  InitialPlanDraftInputV1,
} from '@shared/xiaogui-collaboration-hub'
import {
  type XiaoguiHubNodePairRequestV1,
  type XiaoguiHubNodePairResponseV1,
  type XiaoguiTaskDeliveryReceiptUnsignedV1,
  type XiaoguiTaskDeliveryReceiptV1,
  type XiaoguiTaskReceiptAckV1,
  type XiaoguiTaskResultAckV1,
  type XiaoguiTaskResultEnvelopeV1,
  type XiaoguiTaskResultSubmissionV1,
} from '@shared/xiaogui-hub-task-contract'
import type { DeliveryBatchProjectionV1 } from '@shared/xiaogui-delivery'
import type { CollaborationHubApplicationV1 } from '../task-hub/application'
import { signXiaoguiTaskDeliveryReceiptV1 } from './receipt-crypto'
import {
  projectHubTaskResultFromDeliveryV1,
  projectHubTaskResultFromExecutionTerminalV1,
} from './task-result-projection'
import {
  type HubTaskWorkerAssignmentDetailV1,
  type HubTaskWorkerAssignmentV1,
  type HubTaskWorkerInboxEntryV1,
  type HubTaskWorkerStateStoreV1,
} from './worker-state'

export interface XiaoguiHubTaskWorkerPortV1 {
  pairOrReplaceNode(input: XiaoguiHubNodePairRequestV1): Promise<XiaoguiHubNodePairResponseV1>
  pollAssignments(cursor: string | null): Promise<{
    cursor: string | null
    assignments: readonly HubTaskWorkerAssignmentV1[]
  }>
  downloadAssignment(assignmentId: string): Promise<HubTaskWorkerAssignmentDetailV1>
  submitDecision(assignmentId: string, decision: 'ACCEPT' | 'REJECT'): Promise<HubTaskWorkerAssignmentDetailV1>
  returnAssignment(assignmentId: string): Promise<HubTaskWorkerAssignmentDetailV1>
  claimOffer(taskId: string): Promise<HubTaskWorkerAssignmentDetailV1>
  /** Main-process-only, signed evidence upload. The Hub returns no task body. */
  submitReceipt(receipt: XiaoguiTaskDeliveryReceiptV1): Promise<XiaoguiTaskReceiptAckV1>
  /** Atomic controlled result + terminal receipt upload; never local bytes or paths. */
  submitResult(submission: XiaoguiTaskResultSubmissionV1): Promise<XiaoguiTaskResultAckV1>
}

export interface HubTaskWorkerCredentialBundleV1 {
  endpoint: string
  accessToken: string
  node: {
    subjectId: string
    nodeId: string
    keyId: string
    deviceToken: string
    privateKeyPem: string
  }
}

export interface HubTaskWorkerCredentialsV1 {
  read(): HubTaskWorkerCredentialBundleV1 | null
  /** Verifies main-process encrypted persistence before a Hub node is replaced. */
  canPersist(): boolean
  /** false means safeStorage was unavailable or rejected the encrypted write. */
  write(value: HubTaskWorkerCredentialBundleV1): boolean
  clear(): void
}

export interface HubTaskWorkerConnectionInputV1 {
  endpoint: string
  accessToken: string
  /** Already one-way hashed by the main process; no installation path crosses this seam. */
  installationIdDigest: string
}

export interface HubTaskWorkerPublicStatusV1 {
  configured: boolean
  state: 'UNCONFIGURED' | 'READY' | 'OFFLINE' | 'AUTHENTICATION_FAILED' | 'NODE_REVOKED'
  lastSyncedAt: string | null
  pendingReceiptCount: number
}

export type HubTaskWorkerServiceErrorCodeV1 =
  | 'HUB_WORKER_UNCONFIGURED'
  | 'HUB_WORKER_AUTHENTICATION_FAILED'
  | 'HUB_WORKER_NODE_REVOKED'
  | 'HUB_WORKER_STATE_CONFLICT'
  | 'HUB_WORKER_CONNECTION_FAILED'
  | 'HUB_WORKER_CREDENTIAL_STORAGE_UNAVAILABLE'
  | 'HUB_ASSIGNMENT_NOT_READY'
  | 'HUB_LOCAL_PLAN_DRAFT_FAILED'

export type HubTaskWorkerServiceResultV1<T> =
  | { ok: true; value: T }
  | {
      ok: false
      code: HubTaskWorkerServiceErrorCodeV1
    }

export interface HubTaskWorkerServiceV1 {
  connect(input: HubTaskWorkerConnectionInputV1): Promise<HubTaskWorkerServiceResultV1<HubTaskWorkerPublicStatusV1>>
  status(): HubTaskWorkerPublicStatusV1
  refresh(): Promise<HubTaskWorkerServiceResultV1<HubTaskWorkerPublicStatusV1>>
  listInbox(): readonly HubTaskWorkerInboxEntryV1[]
  openAssignment(assignmentId: string): Promise<HubTaskWorkerServiceResultV1<HubTaskWorkerInboxEntryV1>>
  decideAssignment(assignmentId: string, decision: 'ACCEPT' | 'REJECT'): Promise<HubTaskWorkerServiceResultV1<HubTaskWorkerInboxEntryV1>>
  returnAssignment(assignmentId: string): Promise<HubTaskWorkerServiceResultV1<HubTaskWorkerInboxEntryV1>>
  createPlanDraft(assignmentId: string, address: HubAddressV1): Promise<
    HubTaskWorkerServiceResultV1<{ flowId: string; revisionId: string }>
  >
  /** Trusted main-process lifecycle hook; it is deliberately not a Renderer IPC. */
  recordExecutionStarted(address: HubAddressV1, flowId: string): Promise<void>
  /** Main-process-only bindings used by startup lifecycle reconciliation. */
  listExecutionBindings(): readonly HubTaskExecutionBindingV1[]
  /** Trusted post-verification hook; it reuses Delivery/Evidence and does not apply changes. */
  reportDeliveryOutcome(address: HubAddressV1, delivery: DeliveryBatchProjectionV1): Promise<void>
  /** Trusted terminal hook for authoritative failures or unknown outcomes with no Delivery. */
  reportExecutionOutcome(
    address: HubAddressV1,
    flowId: string,
    outcome: HubTaskExecutionTerminalOutcomeV1,
  ): Promise<void>
  startPolling(intervalMs?: number): void
  close(): void
}

export interface HubTaskExecutionBindingV1 {
  address: HubAddressV1
  flowId: string
}

export interface HubTaskExecutionTerminalOutcomeV1 {
  verificationState: 'NOT_RUN' | 'FAIL' | 'UNKNOWN'
}

export type HubTaskWorkerLifecycleReporterV1 = Pick<
  HubTaskWorkerServiceV1,
  | 'listExecutionBindings'
  | 'recordExecutionStarted'
  | 'reportDeliveryOutcome'
  | 'reportExecutionOutcome'
>

export interface CreateHubTaskWorkerServiceOptionsV1 {
  state: HubTaskWorkerStateStoreV1
  credentials: HubTaskWorkerCredentialsV1
  createPort(credentials: HubTaskWorkerCredentialBundleV1 | { endpoint: string; accessToken: string }): XiaoguiHubTaskWorkerPortV1
  application: Pick<CollaborationHubApplicationV1, 'perform'>
  now?: () => string
  idFactory?: (prefix: string) => string
  signReceipt?: (
    receipt: XiaoguiTaskDeliveryReceiptUnsignedV1,
    privateKeyPem: string,
  ) => XiaoguiTaskDeliveryReceiptV1
}

export function createInMemoryHubTaskWorkerCredentialsV1(options: { canPersist?: boolean } = {}): HubTaskWorkerCredentialsV1 & {
  snapshot(): HubTaskWorkerCredentialBundleV1 | null
} {
  let value: HubTaskWorkerCredentialBundleV1 | null = null
  return {
    read: () => value ? cloneCredentials(value) : null,
    canPersist: () => options.canPersist ?? true,
    write: (next) => {
      if (options.canPersist === false) return false
      value = cloneCredentials(next)
      return true
    },
    clear: () => {
      value = null
    },
    snapshot: () => value ? cloneCredentials(value) : null,
  }
}

export function createHubTaskWorkerServiceV1(
  options: CreateHubTaskWorkerServiceOptionsV1,
): HubTaskWorkerServiceV1 {
  return new HubTaskWorkerServiceImpl(options)
}

class HubTaskWorkerServiceImpl implements HubTaskWorkerServiceV1 {
  private state: HubTaskWorkerPublicStatusV1
  private timer: NodeJS.Timeout | null = null
  private evidenceFlush: Promise<void> | null = null

  constructor(private readonly options: CreateHubTaskWorkerServiceOptionsV1) {
    const configured = Boolean(options.credentials.read())
    this.state = {
      configured,
      state: configured ? 'READY' : 'UNCONFIGURED',
      lastSyncedAt: null,
      pendingReceiptCount: options.state.pendingEvidence().length,
    }
  }

  async connect(input: HubTaskWorkerConnectionInputV1): Promise<HubTaskWorkerServiceResultV1<HubTaskWorkerPublicStatusV1>> {
    const endpoint = normalizeEndpoint(input.endpoint)
    if (!endpoint || !isSha256(input.installationIdDigest) || !isNonemptyText(input.accessToken, 20)) {
      return { ok: false, code: 'HUB_WORKER_CONNECTION_FAILED' }
    }
    // Pairing revokes the previous active node. Verify that this machine can
    // persist the one-time private response before making that irreversible
    // Hub-side replacement request.
    if (!this.options.credentials.canPersist()) {
      return { ok: false, code: 'HUB_WORKER_CREDENTIAL_STORAGE_UNAVAILABLE' }
    }
    try {
      const port = this.options.createPort({ endpoint, accessToken: input.accessToken.trim() })
      const paired = await port.pairOrReplaceNode({ installationIdDigest: input.installationIdDigest })
      if (paired.binding.state !== 'ACTIVE' || !isOpaqueId(paired.binding.nodeId) || !isOpaqueId(paired.binding.subjectId)) {
        return { ok: false, code: 'HUB_WORKER_CONNECTION_FAILED' }
      }
      const persisted = this.options.credentials.write({
        endpoint,
        accessToken: input.accessToken.trim(),
        node: {
          subjectId: paired.binding.subjectId,
          nodeId: paired.binding.nodeId,
          keyId: paired.binding.keyId,
          deviceToken: paired.deviceToken,
          privateKeyPem: paired.privateKeyPem,
        },
      })
      if (!persisted) {
        this.options.credentials.clear()
        this.options.state.clear()
        this.state = { ...this.state, configured: false, state: 'UNCONFIGURED', pendingReceiptCount: 0 }
        return { ok: false, code: 'HUB_WORKER_CREDENTIAL_STORAGE_UNAVAILABLE' }
      }
      this.state = {
        configured: true,
        state: 'READY',
        lastSyncedAt: this.state.lastSyncedAt,
        pendingReceiptCount: this.options.state.pendingEvidence().length,
      }
      this.startPolling()
      // Pairing is already durable at this point. Do one immediate best-effort
      // fetch so a newly connected user sees assigned work without waiting for
      // the periodic poll; a transient network failure remains retryable.
      await this.refresh()
      return { ok: true, value: this.status() }
    } catch (error) {
      const nextState = unavailableStateFor(error)
      if (nextState === 'NODE_REVOKED' || nextState === 'AUTHENTICATION_FAILED') {
        this.recordPortFailure(error)
      } else {
        // A first pairing has not yielded any durable credentials yet. Keep the
        // connection form available rather than pretending this machine is an
        // already configured Worker after a transient network failure.
        this.state = {
          ...this.state,
          configured: this.options.credentials.read() !== null,
          state: nextState,
          pendingReceiptCount: this.options.state.pendingEvidence().length,
        }
      }
      return { ok: false, code: this.portFailureCode(error) }
    }
  }

  status(): HubTaskWorkerPublicStatusV1 {
    return { ...this.state, pendingReceiptCount: this.options.state.pendingEvidence().length }
  }

  async refresh(): Promise<HubTaskWorkerServiceResultV1<HubTaskWorkerPublicStatusV1>> {
    const credentials = this.options.credentials.read()
    if (!credentials) {
      const terminalCode = this.terminalActionCode()
      if (terminalCode) return { ok: false, code: terminalCode }
      this.state = { ...this.state, configured: false, state: 'UNCONFIGURED' }
      return { ok: false, code: 'HUB_WORKER_UNCONFIGURED' }
    }
    try {
      const port = this.options.createPort(credentials)
      let receiptFailure: unknown = null
      try {
        await this.flushPendingEvidence(port)
      } catch (error) {
        receiptFailure = error
        this.recordPortFailure(error)
        if (this.terminalActionCode()) return { ok: false, code: this.portFailureCode(error) }
      }
      const snapshot = await port.pollAssignments(this.options.state.cursor())
      for (const assignment of snapshot.assignments) {
        const isNew = !this.options.state.hasAssignment(assignment.assignmentId)
        const detail = await port.downloadAssignment(assignment.assignmentId)
        this.options.state.upsertAssignment(detail)
        if (isNew) this.enqueueReceipt('NODE_STORED', detail, credentials)
      }
      // H1-3 polling is a full active-node snapshot, not a delta feed. A task
      // reassigned during node replacement must not remain actionable locally.
      this.options.state.reconcileAssignments(snapshot.assignments.map((assignment) => assignment.assignmentId))
      this.options.state.setCursor(snapshot.cursor)
      if (!receiptFailure) {
        try {
          // New packages add NODE_STORED evidence during this poll. Submit it
          // in the same online turn, but never delete a record before its ACK.
          await this.flushPendingEvidence(port)
        } catch (error) {
          receiptFailure = error
          this.recordPortFailure(error)
        }
      }
      if (receiptFailure) return { ok: false, code: this.portFailureCode(receiptFailure) }
      this.state = {
        configured: true,
        state: 'READY',
        lastSyncedAt: this.now(),
        pendingReceiptCount: this.options.state.pendingEvidence().length,
      }
      return { ok: true, value: this.status() }
    } catch (error) {
      this.recordPortFailure(error)
      return { ok: false, code: this.portFailureCode(error) }
    }
  }

  listInbox(): readonly HubTaskWorkerInboxEntryV1[] {
    if (this.terminalActionCode() || !this.options.credentials.read()) return []
    return this.options.state.listAssignments()
  }

  async openAssignment(assignmentId: string): Promise<HubTaskWorkerServiceResultV1<HubTaskWorkerInboxEntryV1>> {
    const terminalCode = this.terminalActionCode()
    if (terminalCode) return { ok: false, code: terminalCode }
    const credentials = this.options.credentials.read()
    if (!credentials) return { ok: false, code: 'HUB_WORKER_UNCONFIGURED' }
    let before: HubTaskWorkerInboxEntryV1
    try {
      before = this.options.state.requireAssignment(assignmentId)
    } catch {
      return { ok: false, code: 'HUB_ASSIGNMENT_NOT_READY' }
    }
    const opened = this.options.state.markOpened(assignmentId, this.now())
    if (!before.openedAt) {
      this.enqueueReceipt('USER_OPENED', opened, credentials)
      // Opening is immediately durable even when offline. An online Worker
      // starts a best-effort upload without making the local open wait on the
      // network; refresh remains the authoritative reconciliation action.
      this.requestEvidenceFlush(credentials)
    }
    return { ok: true, value: opened }
  }

  async decideAssignment(
    assignmentId: string,
    decision: 'ACCEPT' | 'REJECT',
  ): Promise<HubTaskWorkerServiceResultV1<HubTaskWorkerInboxEntryV1>> {
    const terminalCode = this.terminalActionCode()
    if (terminalCode) return { ok: false, code: terminalCode }
    const credentials = this.options.credentials.read()
    if (!credentials) return { ok: false, code: 'HUB_WORKER_UNCONFIGURED' }
    try {
      if (!this.options.state.requireAssignment(assignmentId).openedAt) {
        return { ok: false, code: 'HUB_ASSIGNMENT_NOT_READY' }
      }
    } catch {
      return { ok: false, code: 'HUB_ASSIGNMENT_NOT_READY' }
    }
    try {
      const detail = await this.options.createPort(credentials).submitDecision(assignmentId, decision)
      this.options.state.upsertAssignment(detail)
      this.enqueueReceipt(decision === 'ACCEPT' ? 'DIRECT_ACCEPTED' : 'DIRECT_REJECTED', detail, credentials)
      this.requestEvidenceFlush(credentials)
      return { ok: true, value: this.options.state.requireAssignment(assignmentId) }
    } catch (error) {
      this.recordPortFailure(error)
      return { ok: false, code: this.portFailureCode(error) }
    }
  }

  async returnAssignment(assignmentId: string): Promise<HubTaskWorkerServiceResultV1<HubTaskWorkerInboxEntryV1>> {
    const terminalCode = this.terminalActionCode()
    if (terminalCode) return { ok: false, code: terminalCode }
    const credentials = this.options.credentials.read()
    if (!credentials) return { ok: false, code: 'HUB_WORKER_UNCONFIGURED' }
    try {
      const detail = await this.options.createPort(credentials).returnAssignment(assignmentId)
      this.options.state.upsertAssignment(detail)
      return { ok: true, value: this.options.state.requireAssignment(assignmentId) }
    } catch (error) {
      this.recordPortFailure(error)
      return { ok: false, code: this.portFailureCode(error) }
    }
  }

  async createPlanDraft(
    assignmentId: string,
    address: HubAddressV1,
  ): Promise<HubTaskWorkerServiceResultV1<{ flowId: string; revisionId: string }>> {
    const terminalCode = this.terminalActionCode()
    if (terminalCode) return { ok: false, code: terminalCode }
    let entry: HubTaskWorkerInboxEntryV1
    try {
      entry = this.options.state.requireAssignment(assignmentId)
    } catch {
      return { ok: false, code: 'HUB_ASSIGNMENT_NOT_READY' }
    }
    if (
      !entry.openedAt ||
      entry.assignment.decisionState !== 'ACCEPTED' ||
      entry.assignment.executionState !== 'NOT_STARTED'
    ) {
      return { ok: false, code: 'HUB_ASSIGNMENT_NOT_READY' }
    }
    if (entry.localPlanDraft) {
      return {
        ok: true,
        value: {
          flowId: entry.localPlanDraft.flowId,
          revisionId: entry.localPlanDraft.revisionId,
        },
      }
    }

    const outcome = await this.options.application.perform(address, {
      requestId: `hub-assignment:${assignmentId}`,
      intent: { type: 'flow.start.with_draft', draft: toPlanDraft(entry) },
    })
    if (!outcome.ok || !outcome.value.flowId || !outcome.value.revisionId) {
      return { ok: false, code: 'HUB_LOCAL_PLAN_DRAFT_FAILED' }
    }
    this.options.state.bindPlanDraft(assignmentId, {
      projectId: address.projectId,
      sessionKey: address.sessionKey,
      flowId: outcome.value.flowId,
      revisionId: outcome.value.revisionId,
      createdAt: this.now(),
    })
    return { ok: true, value: { flowId: outcome.value.flowId, revisionId: outcome.value.revisionId } }
  }

  async recordExecutionStarted(address: HubAddressV1, flowId: string): Promise<void> {
    const terminalCode = this.terminalActionCode()
    const credentials = this.options.credentials.read()
    if (terminalCode || !credentials) return
    const entry = this.findBoundAssignment(address, flowId)
    if (!entry || entry.assignment.executionState !== 'NOT_STARTED') return
    if (this.hasPendingEvent(entry.assignment.assignmentId, 'EXECUTION_STARTED')) return
    this.enqueueReceipt('EXECUTION_STARTED', entry, credentials)
    this.requestEvidenceFlush(credentials)
  }

  listExecutionBindings(): readonly HubTaskExecutionBindingV1[] {
    return this.options.state.listAssignments().flatMap((entry) => {
      const binding = entry.localPlanDraft
      if (
        !binding
        || !entry.openedAt
        || entry.assignment.decisionState !== 'ACCEPTED'
        || !['NOT_STARTED', 'RUNNING'].includes(entry.assignment.executionState)
      ) return []
      return [{
        address: {
          projectId: binding.projectId,
          sessionKey: binding.sessionKey,
        },
        flowId: binding.flowId,
      }]
    })
  }

  async reportDeliveryOutcome(address: HubAddressV1, delivery: DeliveryBatchProjectionV1): Promise<void> {
    const terminalCode = this.terminalActionCode()
    const credentials = this.options.credentials.read()
    if (terminalCode || !credentials) return
    const entry = this.findBoundAssignment(address, delivery.flowId)
    // The terminal event must never leap over an actual local execution start.
    // An offline queued EXECUTION_STARTED is adequate evidence; its sequence
    // is flushed ahead of the result submission below.
    if (!entry || this.options.state.hasTerminalEvidenceForAssignment(entry.assignment.assignmentId)) return
    if (
      entry.assignment.executionState !== 'RUNNING'
      && !this.hasPendingEvent(entry.assignment.assignmentId, 'EXECUTION_STARTED')
    ) return

    const occurredAt = this.now()
    const result = projectHubTaskResultFromDeliveryV1({
      resultId: this.id('xgh_result'),
      assignmentId: entry.assignment.assignmentId,
      taskId: entry.assignment.taskId,
      occurredAt,
      delivery,
    })
    if (!result) return
    this.enqueueResult(entry, credentials, result, occurredAt)
  }

  async reportExecutionOutcome(
    address: HubAddressV1,
    flowId: string,
    outcome: HubTaskExecutionTerminalOutcomeV1,
  ): Promise<void> {
    const terminalCode = this.terminalActionCode()
    const credentials = this.options.credentials.read()
    if (terminalCode || !credentials) return
    const entry = this.findBoundAssignment(address, flowId)
    if (!entry || this.options.state.hasTerminalEvidenceForAssignment(entry.assignment.assignmentId)) return
    if (
      entry.assignment.executionState !== 'RUNNING'
      && !this.hasPendingEvent(entry.assignment.assignmentId, 'EXECUTION_STARTED')
    ) return

    const occurredAt = this.now()
    const result = projectHubTaskResultFromExecutionTerminalV1({
      resultId: this.id('xgh_result'),
      assignmentId: entry.assignment.assignmentId,
      taskId: entry.assignment.taskId,
      occurredAt,
      verificationState: outcome.verificationState,
    })
    this.enqueueResult(entry, credentials, result, occurredAt)
  }

  private enqueueResult(
    entry: HubTaskWorkerInboxEntryV1,
    credentials: HubTaskWorkerCredentialBundleV1,
    result: XiaoguiTaskResultEnvelopeV1,
    occurredAt: string,
  ): void {
    const unsigned: XiaoguiTaskDeliveryReceiptUnsignedV1 = {
      schemaVersion: 'xiaogui.task-receipt.v1',
      eventId: this.id('xgh_event'),
      assignmentId: entry.assignment.assignmentId,
      taskId: entry.assignment.taskId,
      subjectId: credentials.node.subjectId,
      nodeId: credentials.node.nodeId,
      keyId: credentials.node.keyId,
      eventType: result.outcome,
      packageSha256: entry.offer.packageSha256,
      occurredAt,
      sequence: this.options.state.nextReceiptSequence(),
      resultSha256: result.resultSha256,
    }
    const receipt = (this.options.signReceipt ?? signXiaoguiTaskDeliveryReceiptV1)(unsigned, credentials.node.privateKeyPem)
    this.options.state.enqueueResult({ result, receipt: receipt as XiaoguiTaskResultSubmissionV1['receipt'] }, this.now())
    this.requestEvidenceFlush(credentials)
  }

  startPolling(intervalMs = 30_000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.refresh()
    }, Math.max(intervalMs, 5_000))
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private findBoundAssignment(address: HubAddressV1, flowId: string): HubTaskWorkerInboxEntryV1 | null {
    return this.options.state.listAssignments().find((entry) => (
      entry.openedAt !== null
      && entry.assignment.decisionState === 'ACCEPTED'
      && entry.localPlanDraft !== null
      && entry.localPlanDraft.projectId === address.projectId
      && entry.localPlanDraft.sessionKey === address.sessionKey
      && entry.localPlanDraft.flowId === flowId
    )) ?? null
  }

  private hasPendingEvent(
    assignmentId: string,
    eventType: XiaoguiTaskDeliveryReceiptUnsignedV1['eventType'],
  ): boolean {
    return this.options.state.pendingEvidence().some((evidence) => (
      evidence.kind === 'RECEIPT'
        ? evidence.receipt.assignmentId === assignmentId && evidence.receipt.eventType === eventType
        : evidence.submission.receipt.assignmentId === assignmentId && evidence.submission.receipt.eventType === eventType
    ))
  }

  private enqueueReceipt(
    eventType: XiaoguiTaskDeliveryReceiptUnsignedV1['eventType'],
    detail: Pick<HubTaskWorkerAssignmentDetailV1, 'assignment' | 'offer'>,
    credentials: HubTaskWorkerCredentialBundleV1,
  ): void {
    const unsigned: XiaoguiTaskDeliveryReceiptUnsignedV1 = {
      schemaVersion: 'xiaogui.task-receipt.v1',
      eventId: this.id('xgh_event'),
      assignmentId: detail.assignment.assignmentId,
      taskId: detail.assignment.taskId,
      subjectId: credentials.node.subjectId,
      nodeId: credentials.node.nodeId,
      keyId: credentials.node.keyId,
      eventType,
      packageSha256: detail.offer.packageSha256,
      occurredAt: this.now(),
      sequence: this.options.state.nextReceiptSequence(),
      resultSha256: null,
    }
    const receipt = (this.options.signReceipt ?? signXiaoguiTaskDeliveryReceiptV1)(unsigned, credentials.node.privateKeyPem)
    this.options.state.enqueueReceipt(receipt, this.now())
  }

  private requestEvidenceFlush(credentials: HubTaskWorkerCredentialBundleV1): void {
    void this.flushPendingEvidence(this.options.createPort(credentials)).catch((error) => {
      // The signed record remains durable. Do not turn a local open/decision
      // into a failed user action merely because the Hub is temporarily away.
      this.recordPortFailure(error)
    })
  }

  private flushPendingEvidence(port: XiaoguiHubTaskWorkerPortV1): Promise<void> {
    if (this.evidenceFlush) return this.evidenceFlush

    const work = this.flushPendingEvidenceSerial(port)
    this.evidenceFlush = work
    void work.finally(() => {
      if (this.evidenceFlush === work) this.evidenceFlush = null
    }).catch(() => undefined)
    return work
  }

  private async flushPendingEvidenceSerial(port: XiaoguiHubTaskWorkerPortV1): Promise<void> {
    // Sequence order is part of the Hub anti-replay contract. Stop at the
    // first non-ACKed item so a later receipt/result never leaps over it.
    for (;;) {
      const pending = this.options.state.pendingEvidence()[0]
      if (!pending) return
      if (pending.kind === 'RECEIPT') {
        const ack = await port.submitReceipt(pending.receipt)
        // A Hub response is not allowed to advance a different queued event.
        // This comparison belongs here, where the submitted queue head is still
        // known, and is duplicated by the state store's expected-event gate.
        if (
          ack.eventId !== pending.receipt.eventId
          || !this.options.state.acknowledgeReceipt(pending.receipt.eventId, ack)
        ) {
          throw new HubTaskWorkerReceiptAckError()
        }
      } else {
        const ack = await port.submitResult(pending.submission)
        if (
          ack.resultId !== pending.submission.result.resultId
          || ack.eventId !== pending.submission.receipt.eventId
          || !this.options.state.acknowledgeResult(
            pending.submission.result.resultId,
            pending.submission.receipt.eventId,
            ack,
          )
        ) {
          throw new HubTaskWorkerResultAckError()
        }
      }
    }
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  private id(prefix: string): string {
    return this.options.idFactory?.(prefix) ?? `${prefix}_${randomUUID()}`
  }

  private recordPortFailure(error: unknown): void {
    if (isStateConflict(error)) {
      // A 409 is returned only after the Hub accepted the current node
      // credential, but it may describe a task-state or receipt conflict
      // (for example a replay or mismatched event payload). Keep the signed
      // evidence and local packages; callers refresh instead of re-pairing or
      // silently dropping the event.
      this.state = { ...this.state, configured: true, state: 'READY' }
      return
    }
    const nextState = unavailableStateFor(error)
    if (nextState === 'NODE_REVOKED' || nextState === 'AUTHENTICATION_FAILED') {
      // A stale worker must not keep acting on cached task packages. Drop the
      // old node's local state and require a fresh explicit login/pairing.
      this.options.credentials.clear()
      this.options.state.clear()
      this.close()
      this.state = {
        configured: false,
        state: nextState,
        lastSyncedAt: this.state.lastSyncedAt,
        pendingReceiptCount: 0,
      }
      return
    }
    this.state = { ...this.state, configured: true, state: nextState }
  }

  private terminalActionCode(): HubTaskWorkerServiceErrorCodeV1 | null {
    if (this.state.state === 'NODE_REVOKED') return 'HUB_WORKER_NODE_REVOKED'
    if (this.state.state === 'AUTHENTICATION_FAILED') return 'HUB_WORKER_AUTHENTICATION_FAILED'
    return null
  }

  private portFailureCode(error: unknown): HubTaskWorkerServiceErrorCodeV1 {
    if (isStateConflict(error)) return 'HUB_WORKER_STATE_CONFLICT'
    const state = unavailableStateFor(error)
    if (state === 'NODE_REVOKED') return 'HUB_WORKER_NODE_REVOKED'
    if (state === 'AUTHENTICATION_FAILED') return 'HUB_WORKER_AUTHENTICATION_FAILED'
    return 'HUB_WORKER_CONNECTION_FAILED'
  }
}

class HubTaskWorkerReceiptAckError extends Error {
  readonly code = 'RECEIPT_ACK_INVALID'

  constructor() {
    super('Hub receipt ACK was not valid for the pending local event')
  }
}

class HubTaskWorkerResultAckError extends Error {
  readonly code = 'RESULT_ACK_INVALID'

  constructor() {
    super('Hub result ACK was not valid for the pending local result')
  }
}

function toPlanDraft(entry: HubTaskWorkerInboxEntryV1): InitialPlanDraftInputV1 {
  const sections = [
    entry.offer.taskContent.trim(),
    entry.offer.constraints.length > 0 ? `约束：\n${entry.offer.constraints.map((value) => `- ${value}`).join('\n')}` : '',
    entry.offer.acceptanceRequirements.length > 0
      ? `验收要求：\n${entry.offer.acceptanceRequirements.map((value) => `- ${value}`).join('\n')}`
      : '',
  ].filter(Boolean)
  return {
    objective: entry.offer.title,
    tasks: [{
      taskKey: `hub_${entry.assignment.assignmentId.slice(-60)}`,
      title: entry.offer.title,
      summary: sections.join('\n\n'),
    }],
  }
}

function normalizeEndpoint(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

function cloneCredentials(value: HubTaskWorkerCredentialBundleV1): HubTaskWorkerCredentialBundleV1 {
  return {
    endpoint: value.endpoint,
    accessToken: value.accessToken,
    node: { ...value.node },
  }
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function isNonemptyText(value: unknown, minLength: number): value is string {
  return typeof value === 'string' && value.trim().length >= minLength
}

function unavailableStateFor(error: unknown): HubTaskWorkerPublicStatusV1['state'] {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  if (code === 'AUTHENTICATION_FAILED') return 'AUTHENTICATION_FAILED'
  if (code === 'NODE_REVOKED') return 'NODE_REVOKED'
  return 'OFFLINE'
}

function isStateConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'STATE_CONFLICT',
  )
}
