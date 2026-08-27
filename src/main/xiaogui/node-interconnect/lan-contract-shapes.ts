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
  | { route: '/register'; nodeId: string; manifest: XiaoguiNodeCapabilityManifestV1 }
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
  if (!isLanRecordV1(value) || !hasOnlyLanKeysV1(value, [
    'identity',
    'capabilities',
    'dataEgressPolicy',
    'health',
    'leaseTtlMs',
    'updatedAt',
    'designReserved',
  ])) return null
  const identity = parseIdentity(value.identity)
  const capabilities = parseXiaoguiLanCapabilitiesV1(value.capabilities)
  if (
    !identity
    || !capabilities
    || !isLanDataEgressPolicyV1(value.dataEgressPolicy)
    || !isLanHealthV1(value.health)
    || typeof value.leaseTtlMs !== 'number'
    || !Number.isSafeInteger(value.leaseTtlMs)
    || value.leaseTtlMs < 1
    || value.leaseTtlMs > 300_000
    || !isLanIsoDateV1(value.updatedAt)
    || value.designReserved !== true
  ) return null
  return {
    identity,
    capabilities,
    dataEgressPolicy: value.dataEgressPolicy,
    health: value.health,
    leaseTtlMs: value.leaseTtlMs,
    updatedAt: value.updatedAt,
    designReserved: true,
  }
}

export function parseXiaoguiLanRouteRequestV1(routeName: string, body: unknown): XiaoguiLanRouteRequestV1 | null {
  if (!isLanRecordV1(body)) return null
  switch (routeName) {
    case '/register': {
      if (!hasOnlyLanKeysV1(body, ['manifest'])) return null
      const manifest = parseXiaoguiLanNodeManifestV1(body.manifest)
      return manifest
        ? { route: '/register', nodeId: String(manifest.identity.nodeId), manifest }
        : null
    }
    case '/heartbeat':
      return hasOnlyLanKeysV1(body, ['nodeId', 'health']) && isLanNodeIdV1(body.nodeId) && isLanHealthV1(body.health)
        ? { route: '/heartbeat', nodeId: body.nodeId, health: body.health }
        : null
    case '/offer': {
      if (!hasOnlyLanKeysV1(body, ['taskId', 'requiredCapabilities', 'dataEgressPolicy', 'payloadRef'])) return null
      const requiredCapabilities = parseXiaoguiLanCapabilitiesV1(body.requiredCapabilities)
      const payloadRef = parseXiaoguiLanAssignmentPayloadRefV1(body.payloadRef)
      if (!isLanOpaqueIdV1(body.taskId) || !requiredCapabilities || !isLanDataEgressPolicyV1(body.dataEgressPolicy) || !payloadRef) {
        return null
      }
      return {
        route: '/offer',
        taskId: body.taskId,
        requiredCapabilities,
        dataEgressPolicy: body.dataEgressPolicy,
        payloadRef,
      }
    }
    case '/claim':
      return hasOnlyLanKeysV1(body, ['nodeId']) && isLanNodeIdV1(body.nodeId)
        ? { route: '/claim', nodeId: body.nodeId }
        : null
    case '/approve-local':
    case '/mark-running':
      return hasOnlyLanKeysV1(body, ['nodeId', 'assignmentId', 'leaseId'])
        && isLanNodeIdV1(body.nodeId)
        && isLanOpaqueIdV1(body.assignmentId)
        && isLanOpaqueIdV1(body.leaseId)
        ? { route: routeName, nodeId: body.nodeId, assignmentId: body.assignmentId, leaseId: body.leaseId }
        : null
    case '/complete':
      return hasOnlyLanKeysV1(body, ['nodeId', 'assignmentId', 'leaseId', 'resultDigest'])
        && isLanNodeIdV1(body.nodeId)
        && isLanOpaqueIdV1(body.assignmentId)
        && isLanOpaqueIdV1(body.leaseId)
        && isLanDigestV1(body.resultDigest)
        ? { route: '/complete', nodeId: body.nodeId, assignmentId: body.assignmentId, leaseId: body.leaseId, resultDigest: body.resultDigest }
        : null
    case '/fail':
    case '/outcome-unknown':
      return hasOnlyLanKeysV1(body, ['nodeId', 'assignmentId', 'leaseId', 'reasonCode'])
        && isLanNodeIdV1(body.nodeId)
        && isLanOpaqueIdV1(body.assignmentId)
        && isLanOpaqueIdV1(body.leaseId)
        && isLanReasonCodeV1(body.reasonCode)
        ? { route: routeName, nodeId: body.nodeId, assignmentId: body.assignmentId, leaseId: body.leaseId, reasonCode: body.reasonCode }
        : null
    case '/reconcile':
      return hasOnlyLanKeysV1(body, ['assignmentId', 'nodeId'])
        && isLanOpaqueIdV1(body.assignmentId)
        && (body.nodeId === undefined || isLanNodeIdV1(body.nodeId))
        ? { route: '/reconcile', assignmentId: body.assignmentId, ...(body.nodeId ? { nodeId: body.nodeId } : {}) }
        : null
    case '/events':
      return hasOnlyLanKeysV1(body, []) ? { route: '/events' } : null
    default:
      return null
  }
}

export function parseXiaoguiLanAssignmentEnvelopeV1(value: unknown): XiaoguiAssignmentEnvelopeV1 | null {
  if (!isLanRecordV1(value) || !hasOnlyLanKeysV1(value, [
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
  const requiredCapabilities = parseXiaoguiLanCapabilitiesV1(value.requiredCapabilities)
  const payloadRef = parseXiaoguiLanAssignmentPayloadRefV1(value.payloadRef)
  if (
    !isLanOpaqueIdV1(value.assignmentId)
    || !isLanOpaqueIdV1(value.taskId)
    || !isLanOpaqueIdV1(value.hubId)
    || !isLanNodeIdV1(value.targetNodeId)
    || !isLanOpaqueIdV1(value.leaseId)
    || !requiredCapabilities
    || !isLanDataEgressPolicyV1(value.dataEgressPolicy)
    || !payloadRef
    || value.humanApproval !== 'REQUIRED'
    || !isLanAssignmentStatusV1(value.status)
    || !isLanIsoDateV1(value.issuedAt)
    || !isLanIsoDateV1(value.leaseExpiresAt)
  ) return null
  return {
    assignmentId: value.assignmentId,
    taskId: value.taskId,
    hubId: value.hubId,
    targetNodeId: value.targetNodeId,
    leaseId: value.leaseId,
    requiredCapabilities,
    dataEgressPolicy: value.dataEgressPolicy,
    payloadRef,
    humanApproval: 'REQUIRED',
    status: value.status,
    issuedAt: value.issuedAt,
    leaseExpiresAt: value.leaseExpiresAt,
  }
}

export function parseXiaoguiLanAssignmentPayloadRefV1(value: unknown): XiaoguiAssignmentPayloadRefV1 | null {
  if (!isLanRecordV1(value) || !hasOnlyLanKeysV1(value, ['mediaType', 'artifactId', 'digest'])) return null
  if (
    value.mediaType !== 'application/vnd.xiaogui.assignment-payload+json'
    || !isLanOpaqueIdV1(value.artifactId)
    || !isLanDigestV1(value.digest)
  ) return null
  return { mediaType: value.mediaType, artifactId: value.artifactId, digest: value.digest }
}

export function parseXiaoguiLanCapabilitiesV1(value: unknown): XiaoguiNodeCapabilityV1[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CAPABILITY_COUNT) return null
  const capabilities = value.filter(isCapability)
  return capabilities.length === value.length && new Set(capabilities).size === capabilities.length
    ? capabilities
    : null
}

export function parseXiaoguiLanSimpleResponseV1(value: unknown): XiaoguiLanSimpleResponseV1 | null {
  const failure = parseXiaoguiLanFailureResponseV1(value)
  if (failure) return failure
  return isLanRecordV1(value) && hasOnlyLanKeysV1(value, ['ok']) && value.ok === true
    ? { ok: true }
    : null
}

export function parseXiaoguiLanEnvelopeResponseV1(
  value: unknown,
  options: { expectedNodeId?: string } = {},
): XiaoguiLanEnvelopeResponseV1 | null {
  const failure = parseXiaoguiLanFailureResponseV1(value)
  if (failure) return failure
  if (!isLanRecordV1(value) || !hasOnlyLanKeysV1(value, ['ok', 'envelope']) || value.ok !== true) return null
  const envelope = parseXiaoguiLanAssignmentEnvelopeV1(value.envelope)
  if (
    !envelope
    || envelope.status !== 'AWAITING_LOCAL_APPROVAL'
    || (options.expectedNodeId !== undefined && String(envelope.targetNodeId) !== options.expectedNodeId)
  ) return null
  return { ok: true, envelope }
}

export function parseXiaoguiLanReconcileResponseV1(value: unknown): XiaoguiLanReconcileResponseV1 | null {
  const failure = parseXiaoguiLanFailureResponseV1(value)
  if (failure) return failure
  if (
    !isLanRecordV1(value)
    || !hasOnlyLanKeysV1(value, ['ok', 'status', 'resultDigest', 'reasonCode'])
    || value.ok !== true
    || !isLanAssignmentStatusV1(value.status)
  ) return null
  if (value.status === 'COMPLETED') {
    if (!isLanDigestV1(value.resultDigest) || value.reasonCode !== undefined) return null
    return { ok: true, status: value.status, resultDigest: value.resultDigest }
  }
  if (value.status === 'FAILED' || value.status === 'OUTCOME_UNKNOWN') {
    if (!isLanReasonCodeV1(value.reasonCode) || value.resultDigest !== undefined) return null
    return { ok: true, status: value.status, reasonCode: value.reasonCode }
  }
  if (value.resultDigest !== undefined || value.reasonCode !== undefined) return null
  return { ok: true, status: value.status }
}

export function parseXiaoguiLanEventsResponseV1(value: unknown): XiaoguiLanEventsResponseV1 | null {
  const failure = parseXiaoguiLanFailureResponseV1(value)
  if (failure) return failure
  if (!isLanRecordV1(value) || !hasOnlyLanKeysV1(value, ['ok', 'events']) || value.ok !== true || !Array.isArray(value.events)) {
    return null
  }
  const events = value.events.map(parseNodeEvent)
  return events.every((event): event is XiaoguiNodeEventV1 => event !== null)
    ? { ok: true, events }
    : null
}

export function parseXiaoguiLanFailureResponseV1(value: unknown): XiaoguiLanFailureResponseV1 | null {
  return isLanRecordV1(value)
    && hasOnlyLanKeysV1(value, ['ok', 'reasonCode'])
    && value.ok === false
    && isLanReasonCodeV1(value.reasonCode)
    ? { ok: false, reasonCode: value.reasonCode }
    : null
}

export function isLanRecordV1(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasOnlyLanKeysV1(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
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
  if (!isLanRecordV1(value) || !hasOnlyLanKeysV1(value, ['nodeId', 'protocolVersion', 'product', 'displayName', 'publicKeyDigest'])) return null
  if (!isLanNodeIdV1(value.nodeId) || value.protocolVersion !== 'xiaogui-node.v1' || value.product !== 'XIAOGUI_DESKTOP') return null
  if (value.displayName !== undefined && (typeof value.displayName !== 'string' || value.displayName.length < 1 || value.displayName.length > 64)) return null
  if (value.publicKeyDigest !== undefined && !isLanDigestV1(value.publicKeyDigest)) return null
  return {
    nodeId: value.nodeId,
    protocolVersion: 'xiaogui-node.v1',
    product: 'XIAOGUI_DESKTOP',
    ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
    ...(typeof value.publicKeyDigest === 'string' ? { publicKeyDigest: value.publicKeyDigest } : {}),
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
  if (
    !isLanRecordV1(value)
    || typeof value.type !== 'string'
    || !isLanNodeIdV1(value.nodeId)
    || !isLanOpaqueIdV1(value.eventId)
    || !isLanIsoDateV1(value.createdAt)
  ) return null
  const common = { type: value.type, nodeId: value.nodeId, eventId: value.eventId, createdAt: value.createdAt }
  switch (value.type) {
    case 'NODE_REGISTERED':
      return hasOnlyLanKeysV1(value, ['type', 'nodeId', 'eventId', 'createdAt'])
        ? { ...common, type: value.type }
        : null
    case 'NODE_HEARTBEAT':
      return hasOnlyLanKeysV1(value, ['type', 'nodeId', 'eventId', 'createdAt', 'health']) && isLanHealthV1(value.health)
        ? { ...common, type: value.type, health: value.health }
        : null
    case 'ASSIGNMENT_OFFERED':
    case 'ASSIGNMENT_APPROVED':
    case 'ASSIGNMENT_RUNNING':
    case 'ASSIGNMENT_LEASE_EXPIRED':
      return hasOnlyLanKeysV1(value, ['type', 'nodeId', 'eventId', 'createdAt', 'assignmentId', 'leaseId'])
        && isLanOpaqueIdV1(value.assignmentId)
        && isLanOpaqueIdV1(value.leaseId)
        ? { ...common, type: value.type, assignmentId: value.assignmentId, leaseId: value.leaseId }
        : null
    case 'ASSIGNMENT_COMPLETED':
      return hasOnlyLanKeysV1(value, ['type', 'nodeId', 'eventId', 'createdAt', 'assignmentId', 'leaseId', 'resultDigest'])
        && isLanOpaqueIdV1(value.assignmentId)
        && isLanOpaqueIdV1(value.leaseId)
        && isLanDigestV1(value.resultDigest)
        ? { ...common, type: value.type, assignmentId: value.assignmentId, leaseId: value.leaseId, resultDigest: value.resultDigest }
        : null
    case 'ASSIGNMENT_FAILED':
    case 'ASSIGNMENT_OUTCOME_UNKNOWN':
      return hasOnlyLanKeysV1(value, ['type', 'nodeId', 'eventId', 'createdAt', 'assignmentId', 'leaseId', 'reasonCode'])
        && isLanOpaqueIdV1(value.assignmentId)
        && isLanOpaqueIdV1(value.leaseId)
        && isLanReasonCodeV1(value.reasonCode)
        ? { ...common, type: value.type, assignmentId: value.assignmentId, leaseId: value.leaseId, reasonCode: value.reasonCode }
        : null
    default:
      return null
  }
}
