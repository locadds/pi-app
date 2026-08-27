import type {
  XiaoguiAssignmentEnvelopeV1,
  XiaoguiAssignmentPayloadRefV1,
  XiaoguiNodeCapabilityManifestV1,
  XiaoguiNodeCapabilityV1,
  XiaoguiNodeDataEgressPolicyV1,
  XiaoguiNodeEventV1,
  XiaoguiNodeHealthV1,
} from '@shared/xiaogui-node-contract'

const MAX_CAPABILITY_COUNT = 7

export type XiaoguiLanFailureResponseV1 = { ok: false; reasonCode: string }
export type XiaoguiLanSimpleResponseV1 = { ok: true } | XiaoguiLanFailureResponseV1
export type XiaoguiLanEnvelopeResponseV1 =
  | { ok: true; envelope: XiaoguiAssignmentEnvelopeV1 }
  | XiaoguiLanFailureResponseV1
export type XiaoguiLanReconcileResponseV1 =
  | { ok: true; status: XiaoguiAssignmentEnvelopeV1['status']; resultDigest?: string; reasonCode?: string }
  | XiaoguiLanFailureResponseV1
export type XiaoguiLanEventsResponseV1 =
  | { ok: true; events: XiaoguiNodeEventV1[] }
  | XiaoguiLanFailureResponseV1

export type XiaoguiLanRouteRequestV1 =
  | { route: '/register'; manifest: XiaoguiNodeCapabilityManifestV1 }
  | { route: '/heartbeat'; nodeId: string; health: XiaoguiNodeHealthV1 }
  | {
      route: '/offer'
      taskId: string
      requiredCapabilities: XiaoguiNodeCapabilityV1[]
      dataEgressPolicy: XiaoguiNodeDataEgressPolicyV1
      payloadRef: XiaoguiAssignmentPayloadRefV1
    }
  | { route: '/claim'; nodeId: string }
  | { route: '/approve-local' | '/mark-running'; nodeId: string; assignmentId: string; leaseId: string }
  | { route: '/complete'; nodeId: string; assignmentId: string; leaseId: string; resultDigest: string }
  | { route: '/fail' | '/outcome-unknown'; nodeId: string; assignmentId: string; leaseId: string; reasonCode: string }
  | { route: '/reconcile'; assignmentId: string; nodeId?: string }
  | { route: '/events' }

export function parseXiaoguiLanNodeManifestV1(value: unknown): XiaoguiNodeCapabilityManifestV1 | null {
  const record = snapshotLanRecordV1(value)
  if (!record || !hasOnlyLanKeysV1(record, [
    'identity',
    'capabilities',
    'dataEgressPolicy',
    'health',
    'leaseTtlMs',
    'updatedAt',
    'designReserved',
  ])) return null
  const identity = parseIdentity(record.identity)
  const capabilities = parseXiaoguiLanCapabilitiesV1(record.capabilities)
  if (
    !identity
    || !capabilities
    || !isLanDataEgressPolicyV1(record.dataEgressPolicy)
    || !isLanHealthV1(record.health)
    || typeof record.leaseTtlMs !== 'number'
    || !Number.isSafeInteger(record.leaseTtlMs)
    || record.leaseTtlMs < 1
    || record.leaseTtlMs > 300_000
    || !isLanIsoDateV1(record.updatedAt)
    || record.designReserved !== true
  ) return null
  return {
    identity,
    capabilities,
    dataEgressPolicy: record.dataEgressPolicy,
    health: record.health,
    leaseTtlMs: record.leaseTtlMs,
    updatedAt: record.updatedAt,
    designReserved: true,
  }
}

export function parseXiaoguiLanRouteRequestV1(routeName: string, body: unknown): XiaoguiLanRouteRequestV1 | null {
  const record = snapshotLanRecordV1(body)
  if (!record) return null
  switch (routeName) {
    case '/register': {
      if (!hasOnlyLanKeysV1(record, ['manifest'])) return null
      const manifest = parseXiaoguiLanNodeManifestV1(record.manifest)
      return manifest
        ? { route: '/register', manifest }
        : null
    }
    case '/heartbeat':
      return hasOnlyLanKeysV1(record, ['nodeId', 'health']) && isLanNodeIdV1(record.nodeId) && isLanHealthV1(record.health)
        ? { route: '/heartbeat', nodeId: record.nodeId, health: record.health }
        : null
    case '/offer': {
      if (!hasOnlyLanKeysV1(record, ['taskId', 'requiredCapabilities', 'dataEgressPolicy', 'payloadRef'])) return null
      const requiredCapabilities = parseXiaoguiLanCapabilitiesV1(record.requiredCapabilities)
      const payloadRef = parseXiaoguiLanAssignmentPayloadRefV1(record.payloadRef)
      if (!isLanOpaqueIdV1(record.taskId) || !requiredCapabilities || !isLanDataEgressPolicyV1(record.dataEgressPolicy) || !payloadRef) {
        return null
      }
      return {
        route: '/offer',
        taskId: record.taskId,
        requiredCapabilities,
        dataEgressPolicy: record.dataEgressPolicy,
        payloadRef,
      }
    }
    case '/claim':
      return hasOnlyLanKeysV1(record, ['nodeId']) && isLanNodeIdV1(record.nodeId)
        ? { route: '/claim', nodeId: record.nodeId }
        : null
    case '/approve-local':
    case '/mark-running':
      return hasOnlyLanKeysV1(record, ['nodeId', 'assignmentId', 'leaseId'])
        && isLanNodeIdV1(record.nodeId)
        && isLanOpaqueIdV1(record.assignmentId)
        && isLanOpaqueIdV1(record.leaseId)
        ? { route: routeName, nodeId: record.nodeId, assignmentId: record.assignmentId, leaseId: record.leaseId }
        : null
    case '/complete':
      return hasOnlyLanKeysV1(record, ['nodeId', 'assignmentId', 'leaseId', 'resultDigest'])
        && isLanNodeIdV1(record.nodeId)
        && isLanOpaqueIdV1(record.assignmentId)
        && isLanOpaqueIdV1(record.leaseId)
        && isLanDigestV1(record.resultDigest)
        ? { route: '/complete', nodeId: record.nodeId, assignmentId: record.assignmentId, leaseId: record.leaseId, resultDigest: record.resultDigest }
        : null
    case '/fail':
    case '/outcome-unknown':
      return hasOnlyLanKeysV1(record, ['nodeId', 'assignmentId', 'leaseId', 'reasonCode'])
        && isLanNodeIdV1(record.nodeId)
        && isLanOpaqueIdV1(record.assignmentId)
        && isLanOpaqueIdV1(record.leaseId)
        && isLanReasonCodeV1(record.reasonCode)
        ? { route: routeName, nodeId: record.nodeId, assignmentId: record.assignmentId, leaseId: record.leaseId, reasonCode: record.reasonCode }
        : null
    case '/reconcile':
      return hasOnlyLanKeysV1(record, ['assignmentId', 'nodeId'])
        && isLanOpaqueIdV1(record.assignmentId)
        && (record.nodeId === undefined || isLanNodeIdV1(record.nodeId))
        ? { route: '/reconcile', assignmentId: record.assignmentId, ...(record.nodeId ? { nodeId: record.nodeId } : {}) }
        : null
    case '/events':
      return hasOnlyLanKeysV1(record, []) ? { route: '/events' } : null
    default:
      return null
  }
}

export function parseXiaoguiLanAssignmentEnvelopeV1(value: unknown): XiaoguiAssignmentEnvelopeV1 | null {
  const record = snapshotLanRecordV1(value)
  if (!record || !hasOnlyLanKeysV1(record, [
    'assignmentId',
    'taskId',
    'hubId',
    'targetNodeId',
    'leaseId',
    'requiredCapabilities',
    'dataEgressPolicy',
    'payloadRef',
    'humanApproval',
    'status',
    'issuedAt',
    'leaseExpiresAt',
  ])) return null
  const requiredCapabilities = parseXiaoguiLanCapabilitiesV1(record.requiredCapabilities)
  const payloadRef = parseXiaoguiLanAssignmentPayloadRefV1(record.payloadRef)
  if (
    !isLanOpaqueIdV1(record.assignmentId)
    || !isLanOpaqueIdV1(record.taskId)
    || !isLanOpaqueIdV1(record.hubId)
    || !isLanNodeIdV1(record.targetNodeId)
    || !isLanOpaqueIdV1(record.leaseId)
    || !requiredCapabilities
    || !isLanDataEgressPolicyV1(record.dataEgressPolicy)
    || !payloadRef
    || record.humanApproval !== 'REQUIRED'
    || !isLanAssignmentStatusV1(record.status)
    || !isLanIsoDateV1(record.issuedAt)
    || !isLanIsoDateV1(record.leaseExpiresAt)
  ) return null
  return {
    assignmentId: record.assignmentId,
    taskId: record.taskId,
    hubId: record.hubId,
    targetNodeId: record.targetNodeId,
    leaseId: record.leaseId,
    requiredCapabilities,
    dataEgressPolicy: record.dataEgressPolicy,
    payloadRef,
    humanApproval: 'REQUIRED',
    status: record.status,
    issuedAt: record.issuedAt,
    leaseExpiresAt: record.leaseExpiresAt,
  }
}

export function parseXiaoguiLanAssignmentPayloadRefV1(value: unknown): XiaoguiAssignmentPayloadRefV1 | null {
  const record = snapshotLanRecordV1(value)
  if (!record || !hasOnlyLanKeysV1(record, ['mediaType', 'artifactId', 'digest'])) return null
  if (
    record.mediaType !== 'application/vnd.xiaogui.assignment-payload+json'
    || !isLanOpaqueIdV1(record.artifactId)
    || !isLanDigestV1(record.digest)
  ) return null
  return { mediaType: record.mediaType, artifactId: record.artifactId, digest: record.digest }
}

export function parseXiaoguiLanCapabilitiesV1(value: unknown): XiaoguiNodeCapabilityV1[] | null {
  const snapshot = snapshotLanArrayV1(value)
  if (!snapshot || snapshot.length < 1 || snapshot.length > MAX_CAPABILITY_COUNT) return null
  const capabilities = snapshot.filter(isCapability)
  return capabilities.length === snapshot.length && new Set(capabilities).size === capabilities.length
    ? capabilities
    : null
}

export function parseXiaoguiLanSimpleResponseV1(value: unknown): XiaoguiLanSimpleResponseV1 | null {
  const record = snapshotLanRecordV1(value)
  if (!record) return null
  const failure = parseFailureRecord(record)
  if (failure) return failure
  return hasOnlyLanKeysV1(record, ['ok']) && record.ok === true
    ? { ok: true }
    : null
}

export function parseXiaoguiLanEnvelopeResponseV1(
  value: unknown,
  options: { expectedNodeId?: string } = {},
): XiaoguiLanEnvelopeResponseV1 | null {
  const record = snapshotLanRecordV1(value)
  if (!record) return null
  const failure = parseFailureRecord(record)
  if (failure) return failure
  if (!hasOnlyLanKeysV1(record, ['ok', 'envelope']) || record.ok !== true) return null
  const envelope = parseXiaoguiLanAssignmentEnvelopeV1(record.envelope)
  if (
    !envelope
    || envelope.status !== 'AWAITING_LOCAL_APPROVAL'
    || (options.expectedNodeId !== undefined && String(envelope.targetNodeId) !== options.expectedNodeId)
  ) return null
  return { ok: true, envelope }
}

export function parseXiaoguiLanReconcileResponseV1(value: unknown): XiaoguiLanReconcileResponseV1 | null {
  const record = snapshotLanRecordV1(value)
  if (!record) return null
  const failure = parseFailureRecord(record)
  if (failure) return failure
  if (
    !hasOnlyLanKeysV1(record, ['ok', 'status', 'resultDigest', 'reasonCode'])
    || record.ok !== true
    || !isLanAssignmentStatusV1(record.status)
  ) return null
  if (record.status === 'COMPLETED') {
    if (!isLanDigestV1(record.resultDigest) || record.reasonCode !== undefined) return null
    return { ok: true, status: record.status, resultDigest: record.resultDigest }
  }
  if (record.status === 'FAILED' || record.status === 'OUTCOME_UNKNOWN') {
    if (!isLanReasonCodeV1(record.reasonCode) || record.resultDigest !== undefined) return null
    return { ok: true, status: record.status, reasonCode: record.reasonCode }
  }
  if (record.resultDigest !== undefined || record.reasonCode !== undefined) return null
  return { ok: true, status: record.status }
}

export function parseXiaoguiLanEventsResponseV1(value: unknown): XiaoguiLanEventsResponseV1 | null {
  const record = snapshotLanRecordV1(value)
  if (!record) return null
  const failure = parseFailureRecord(record)
  if (failure) return failure
  if (!hasOnlyLanKeysV1(record, ['ok', 'events']) || record.ok !== true) {
    return null
  }
  const eventValues = snapshotLanArrayV1(record.events)
  if (!eventValues) return null
  const events = eventValues.map(parseNodeEvent)
  return events.every((event): event is XiaoguiNodeEventV1 => event !== null)
    ? { ok: true, events }
    : null
}

export function parseXiaoguiLanFailureResponseV1(value: unknown): XiaoguiLanFailureResponseV1 | null {
  const record = snapshotLanRecordV1(value)
  return record ? parseFailureRecord(record) : null
}

function parseFailureRecord(record: Readonly<Record<string, unknown>>): XiaoguiLanFailureResponseV1 | null {
  return hasOnlyLanKeysV1(record, ['ok', 'reasonCode'])
    && record.ok === false
    && isLanReasonCodeV1(record.reasonCode)
    ? { ok: false, reasonCode: record.reasonCode }
    : null
}

export function isLanRecordV1(value: unknown): value is Record<string, unknown> {
  return snapshotLanRecordV1(value) !== null
}

export function hasOnlyLanKeysV1(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function snapshotLanRecordV1(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const descriptorKeys = Reflect.ownKeys(descriptors)
    if (descriptorKeys.some((key) => typeof key !== 'string')) return null
    const snapshot: Record<string, unknown> = Object.create(null)
    for (const key of descriptorKeys) {
      if (typeof key !== 'string') return null
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      snapshot[key] = descriptor.value
    }
    return Object.freeze(snapshot)
  } catch {
    return null
  }
}

function snapshotLanArrayV1(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const keys = Reflect.ownKeys(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    const lengthValue: unknown = lengthDescriptor?.value
    if (
      !lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || typeof lengthValue !== 'number'
      || !Number.isSafeInteger(lengthValue)
      || lengthValue < 0
    ) return null
    const length = lengthValue
    if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) return null
    const snapshot: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      snapshot.push(descriptor.value)
    }
    if (keys.length !== length + 1) return null
    return Object.freeze(snapshot)
  } catch {
    return null
  }
}

export function isLanOpaqueIdV1(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

export function isLanNodeIdV1(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{2,63}$/.test(value)
}

export function isLanDigestV1(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[A-Za-z0-9._-]+$/.test(value)
}

export function isLanReasonCodeV1(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value)
}

export function isLanIsoDateV1(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

export function isLanDataEgressPolicyV1(value: unknown): value is XiaoguiNodeDataEgressPolicyV1 {
  return value === 'LOCAL_ONLY' || value === 'EXTERNAL_ALLOWED'
}

export function isLanAssignmentStatusV1(value: unknown): value is XiaoguiAssignmentEnvelopeV1['status'] {
  return value === 'OFFERED'
    || value === 'LEASED'
    || value === 'AWAITING_LOCAL_APPROVAL'
    || value === 'RUNNING'
    || value === 'COMPLETED'
    || value === 'FAILED'
    || value === 'OUTCOME_UNKNOWN'
    || value === 'LEASE_EXPIRED'
}

function parseIdentity(value: unknown): XiaoguiNodeCapabilityManifestV1['identity'] | null {
  const record = snapshotLanRecordV1(value)
  if (!record || !hasOnlyLanKeysV1(record, ['nodeId', 'protocolVersion', 'product', 'displayName', 'publicKeyDigest'])) return null
  if (!isLanNodeIdV1(record.nodeId) || record.protocolVersion !== 'xiaogui-node.v1' || record.product !== 'XIAOGUI_DESKTOP') return null
  if (record.displayName !== undefined && (typeof record.displayName !== 'string' || record.displayName.length < 1 || record.displayName.length > 64)) return null
  if (record.publicKeyDigest !== undefined && !isLanDigestV1(record.publicKeyDigest)) return null
  return {
    nodeId: record.nodeId,
    protocolVersion: 'xiaogui-node.v1',
    product: 'XIAOGUI_DESKTOP',
    ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
    ...(typeof record.publicKeyDigest === 'string' ? { publicKeyDigest: record.publicKeyDigest } : {}),
  }
}

export function isLanHealthV1(value: unknown): value is XiaoguiNodeHealthV1 {
  return value === 'ONLINE' || value === 'DEGRADED' || value === 'OFFLINE'
}

function isCapability(value: unknown): value is XiaoguiNodeCapabilityV1 {
  return value === 'WORK.DOCX.TEMPLATE'
    || value === 'WORK.PDF.READ'
    || value === 'CODING.GIT.CHANGESET'
    || value === 'CODING.TYPESCRIPT'
    || value === 'EXECUTION.LOCAL_ONLY'
    || value === 'EXECUTION.EXTERNAL_ALLOWED'
    || value === 'DESIGN.RESERVED'
}

function parseNodeEvent(value: unknown): XiaoguiNodeEventV1 | null {
  const record = snapshotLanRecordV1(value)
  if (
    !record
    || typeof record.type !== 'string'
    || !isLanNodeIdV1(record.nodeId)
    || !isLanOpaqueIdV1(record.eventId)
    || !isLanIsoDateV1(record.createdAt)
  ) return null
  const common = { type: record.type, nodeId: record.nodeId, eventId: record.eventId, createdAt: record.createdAt }
  switch (record.type) {
    case 'NODE_REGISTERED':
      return hasOnlyLanKeysV1(record, ['type', 'nodeId', 'eventId', 'createdAt'])
        ? { ...common, type: record.type }
        : null
    case 'NODE_HEARTBEAT':
      return hasOnlyLanKeysV1(record, ['type', 'nodeId', 'eventId', 'createdAt', 'health']) && isLanHealthV1(record.health)
        ? { ...common, type: record.type, health: record.health }
        : null
    case 'ASSIGNMENT_OFFERED':
    case 'ASSIGNMENT_APPROVED':
    case 'ASSIGNMENT_RUNNING':
    case 'ASSIGNMENT_LEASE_EXPIRED':
      return hasOnlyLanKeysV1(record, ['type', 'nodeId', 'eventId', 'createdAt', 'assignmentId', 'leaseId'])
        && isLanOpaqueIdV1(record.assignmentId)
        && isLanOpaqueIdV1(record.leaseId)
        ? { ...common, type: record.type, assignmentId: record.assignmentId, leaseId: record.leaseId }
        : null
    case 'ASSIGNMENT_COMPLETED':
      return hasOnlyLanKeysV1(record, ['type', 'nodeId', 'eventId', 'createdAt', 'assignmentId', 'leaseId', 'resultDigest'])
        && isLanOpaqueIdV1(record.assignmentId)
        && isLanOpaqueIdV1(record.leaseId)
        && isLanDigestV1(record.resultDigest)
        ? { ...common, type: record.type, assignmentId: record.assignmentId, leaseId: record.leaseId, resultDigest: record.resultDigest }
        : null
    case 'ASSIGNMENT_FAILED':
    case 'ASSIGNMENT_OUTCOME_UNKNOWN':
      return hasOnlyLanKeysV1(record, ['type', 'nodeId', 'eventId', 'createdAt', 'assignmentId', 'leaseId', 'reasonCode'])
        && isLanOpaqueIdV1(record.assignmentId)
        && isLanOpaqueIdV1(record.leaseId)
        && isLanReasonCodeV1(record.reasonCode)
        ? { ...common, type: record.type, assignmentId: record.assignmentId, leaseId: record.leaseId, reasonCode: record.reasonCode }
        : null
    default:
      return null
  }
}
