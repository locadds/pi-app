/**
 * Versioned contract for the institutional Xiaogui Hub control plane.
 *
 * This module intentionally contains only controlled, cross-machine data.
 * Ordinary task and node DTOs exclude local paths, runtime session ids, agent
 * credentials, prompt bodies, and node private keys. The single exception is
 * the one-time pairing envelope, which is main-process-only and must never be
 * exposed to a Renderer DTO or persisted by the Hub.
 */

export const XIAOGUI_HUB_TASK_RECEIPT_SCHEMA_V1 = 'xiaogui.task-receipt.v1' as const

export type XiaoguiHubSubjectIdV1 = string & { readonly __brand: 'XiaoguiHubSubjectIdV1' }
export type XiaoguiHubNodeIdV1 = string & { readonly __brand: 'XiaoguiHubNodeIdV1' }

export type XiaoguiHubNodeBindingStateV1 = 'ACTIVE' | 'REVOKED'
export type XiaoguiHubTaskDispatchModeV1 = 'DIRECT' | 'POOL'
export type XiaoguiHubTaskDecisionStateV1 = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'RETURNED'
export type XiaoguiHubTaskDeliveryStateV1 = 'QUEUED' | 'NODE_STORED' | 'OPENED'
export type XiaoguiHubTaskExecutionStateV1 =
  | 'NOT_STARTED'
  | 'RUNNING'
  | 'RESULT_READY'
  | 'COMPLETED'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN'

export type XiaoguiTaskDeliveryReceiptEventTypeV1 =
  | 'NODE_STORED'
  | 'USER_OPENED'
  | 'DIRECT_ACCEPTED'
  | 'DIRECT_REJECTED'
  | 'EXECUTION_STARTED'
  | 'RESULT_READY'
  | 'EXECUTION_FAILED'
  | 'OUTCOME_UNKNOWN'

export interface XiaoguiNodeBindingV1 {
  nodeId: XiaoguiHubNodeIdV1 | string
  subjectId: XiaoguiHubSubjectIdV1 | string
  installationIdDigest: string
  keyId: string
  publicKeyPem: string
  publicKeyDigest: string
  state: XiaoguiHubNodeBindingStateV1
  pairedAt: string
  revokedAt: string | null
  lastSeenAt: string | null
}

export interface XiaoguiTaskOfferV1 {
  offerId: string
  publisherSubjectId: XiaoguiHubSubjectIdV1 | string
  dispatchMode: XiaoguiHubTaskDispatchModeV1
  targetSubjectId: (XiaoguiHubSubjectIdV1 | string) | null
  title: string
  taskContent: string
  constraints: readonly string[]
  acceptanceRequirements: readonly string[]
  attachmentRefs: readonly XiaoguiTaskAttachmentRefV1[]
  packageSha256: string
  createdAt: string
}

export interface XiaoguiTaskAttachmentRefV1 {
  artifactId: string
  mediaType: string
  sha256: string
}

export interface XiaoguiTaskAssignmentV2 {
  assignmentId: string
  taskId: string
  assigneeSubjectId: XiaoguiHubSubjectIdV1 | string
  nodeId: XiaoguiHubNodeIdV1 | string
  decisionState: XiaoguiHubTaskDecisionStateV1
  deliveryState: XiaoguiHubTaskDeliveryStateV1
  executionState: XiaoguiHubTaskExecutionStateV1
  packageSha256: string
  createdAt: string
  updatedAt: string
}

export interface XiaoguiTaskResultEnvelopeV1 {
  assignmentId: string
  taskId: string
  resultSummary: string
  artifactRefs: readonly XiaoguiTaskAttachmentRefV1[]
  verificationSummary: string
  resultSha256: string
  createdAt: string
}

export interface XiaoguiTaskDeliveryReceiptUnsignedV1 {
  schemaVersion: typeof XIAOGUI_HUB_TASK_RECEIPT_SCHEMA_V1
  eventId: string
  assignmentId: string
  taskId: string
  subjectId: XiaoguiHubSubjectIdV1 | string
  nodeId: XiaoguiHubNodeIdV1 | string
  keyId: string
  eventType: XiaoguiTaskDeliveryReceiptEventTypeV1
  packageSha256: string
  occurredAt: string
  sequence: number
  resultSha256: string | null
}

export interface XiaoguiTaskDeliveryReceiptV1 extends XiaoguiTaskDeliveryReceiptUnsignedV1 {
  signature: string
}

export interface XiaoguiTaskReceiptAckV1 {
  receiptId: string
  eventId: string
  verified: true
  duplicate: boolean
  occurredAt: string
  receivedAt: string
}

export type XiaoguiHubTaskContractErrorCodeV1 =
  | 'HUB_CONTRACT_INVALID'
  | 'HUB_RECEIPT_SCHEMA_UNSUPPORTED'
  | 'HUB_RECEIPT_DIGEST_INVALID'
  | 'HUB_RECEIPT_SIGNATURE_INVALID'
  | 'HUB_RECEIPT_IDEMPOTENCY_CONFLICT'
  | 'HUB_RECEIPT_SEQUENCE_REPLAYED'
  | 'HUB_NODE_BINDING_UNKNOWN'
  | 'HUB_NODE_BINDING_REVOKED'
  | 'HUB_NODE_BINDING_MISMATCH'
  | 'HUB_SUBJECT_UNKNOWN'

export type XiaoguiHubTaskContractResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; reasonCode: XiaoguiHubTaskContractErrorCodeV1 }

/**
 * The signature payload is a fixed-position array. JSON object key ordering
 * must never affect a receipt signature.
 */
export function canonicalizeXiaoguiTaskDeliveryReceiptV1(
  receipt: XiaoguiTaskDeliveryReceiptUnsignedV1,
): string {
  return JSON.stringify([
    receipt.schemaVersion,
    receipt.eventId,
    receipt.assignmentId,
    receipt.taskId,
    receipt.subjectId,
    receipt.nodeId,
    receipt.keyId,
    receipt.eventType,
    receipt.packageSha256,
    receipt.occurredAt,
    receipt.sequence,
    receipt.resultSha256,
  ])
}

export function parseXiaoguiTaskDeliveryReceiptV1(value: unknown): XiaoguiHubTaskContractResultV1<XiaoguiTaskDeliveryReceiptV1> {
  if (!isRecord(value) || !hasOnlyKeys(value, RECEIPT_KEYS)) return invalidContract()
  if (value.schemaVersion !== XIAOGUI_HUB_TASK_RECEIPT_SCHEMA_V1) {
    return { ok: false, reasonCode: 'HUB_RECEIPT_SCHEMA_UNSUPPORTED' }
  }
  if (
    !isOpaqueId(value.eventId)
    || !isOpaqueId(value.assignmentId)
    || !isOpaqueId(value.taskId)
    || !isOpaqueId(value.subjectId)
    || !isOpaqueId(value.nodeId)
    || !isOpaqueId(value.keyId)
    || !isReceiptEventType(value.eventType)
    || !isSha256(value.packageSha256)
    || !isCanonicalIsoTimestamp(value.occurredAt)
    || !isPositiveSafeInteger(value.sequence)
    || (value.resultSha256 !== null && !isSha256(value.resultSha256))
    || !isBase64(value.signature)
  ) {
    return invalidContract()
  }
  return {
    ok: true,
    value: {
      schemaVersion: value.schemaVersion,
      eventId: value.eventId,
      assignmentId: value.assignmentId,
      taskId: value.taskId,
      subjectId: value.subjectId,
      nodeId: value.nodeId,
      keyId: value.keyId,
      eventType: value.eventType,
      packageSha256: value.packageSha256,
      occurredAt: value.occurredAt,
      sequence: value.sequence,
      resultSha256: value.resultSha256,
      signature: value.signature,
    },
  }
}

export interface XiaoguiHubTaskPortV1 {
  pairOrReplaceNode(input: XiaoguiHubNodePairRequestV1): Promise<XiaoguiHubNodePairResponseV1>
  pollAssignments(cursor: string | null): Promise<XiaoguiHubAssignmentPollV1>
  downloadAssignment(assignmentId: string): Promise<XiaoguiHubAssignmentDownloadV1>
  submitDecision(assignmentId: string, decision: XiaoguiHubTaskDecisionStateV1): Promise<XiaoguiHubDecisionResultV1>
  submitReceipt(receipt: XiaoguiTaskDeliveryReceiptV1): Promise<XiaoguiHubReceiptSubmitResultV1>
  submitResult(result: XiaoguiTaskResultEnvelopeV1): Promise<XiaoguiHubResultSubmitResultV1>
  reconcile(): Promise<XiaoguiHubReconcileResultV1>
}

export interface XiaoguiHubNodePairRequestV1 {
  installationIdDigest: string
}

export interface XiaoguiHubNodePairResponseV1 {
  binding: XiaoguiNodeBindingV1
  /** Main-process-only one-time pairing material. The Hub must never persist either value. */
  deviceToken: string
  privateKeyPem: string
}

export interface XiaoguiHubAssignmentPollV1 {
  cursor: string | null
  assignments: readonly Pick<XiaoguiTaskAssignmentV2, 'assignmentId' | 'taskId' | 'deliveryState' | 'executionState'>[]
}

export interface XiaoguiHubAssignmentDownloadV1 {
  assignment: XiaoguiTaskAssignmentV2
  offer: XiaoguiTaskOfferV1
}

export interface XiaoguiHubDecisionResultV1 {
  assignment: XiaoguiTaskAssignmentV2
}

export type XiaoguiHubReceiptSubmitResultV1 =
  | { ok: true; ack: XiaoguiTaskReceiptAckV1 }
  | { ok: false; reasonCode: XiaoguiHubTaskContractErrorCodeV1 }

export interface XiaoguiHubResultSubmitResultV1 {
  assignment: XiaoguiTaskAssignmentV2
}

export interface XiaoguiHubReconcileResultV1 {
  pendingReceiptCount: number
  assignments: readonly Pick<XiaoguiTaskAssignmentV2, 'assignmentId' | 'deliveryState' | 'executionState'>[]
}

const RECEIPT_KEYS = new Set([
  'schemaVersion',
  'eventId',
  'assignmentId',
  'taskId',
  'subjectId',
  'nodeId',
  'keyId',
  'eventType',
  'packageSha256',
  'occurredAt',
  'sequence',
  'resultSha256',
  'signature',
])

const RECEIPT_EVENT_TYPES = new Set<XiaoguiTaskDeliveryReceiptEventTypeV1>([
  'NODE_STORED',
  'USER_OPENED',
  'DIRECT_ACCEPTED',
  'DIRECT_REJECTED',
  'EXECUTION_STARTED',
  'RESULT_READY',
  'EXECUTION_FAILED',
  'OUTCOME_UNKNOWN',
])

function invalidContract(): XiaoguiHubTaskContractResultV1<never> {
  return { ok: false, reasonCode: 'HUB_CONTRACT_INVALID' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value)
  return keys.length === allowed.size && keys.every((key) => allowed.has(key))
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isReceiptEventType(value: unknown): value is XiaoguiTaskDeliveryReceiptEventTypeV1 {
  return typeof value === 'string' && RECEIPT_EVENT_TYPES.has(value as XiaoguiTaskDeliveryReceiptEventTypeV1)
}

function isBase64(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length >= 32
}
