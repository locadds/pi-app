import {
  validateRuntimePublicDto,
  type RuntimeDataEgressPolicyV1,
  type RuntimeTaskCapabilityV1,
} from './xiaogui-agent-runtime'

export type XiaoguiNodeIdV1 = string & { readonly __brand: 'XiaoguiNodeIdV1' }
export type XiaoguiNodeProtocolVersionV1 = 'xiaogui-node.v1'
export type XiaoguiNodeCapabilityV1 = RuntimeTaskCapabilityV1
export type XiaoguiNodeDataEgressPolicyV1 = RuntimeDataEgressPolicyV1
export type XiaoguiNodeHealthV1 = 'ONLINE' | 'DEGRADED' | 'OFFLINE'
export type XiaoguiAssignmentStatusV1 =
  | 'OFFERED'
  | 'LEASED'
  | 'AWAITING_LOCAL_APPROVAL'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN'
  | 'LEASE_EXPIRED'

export interface XiaoguiNodeIdentityV1 {
  nodeId: XiaoguiNodeIdV1 | string
  protocolVersion: XiaoguiNodeProtocolVersionV1
  product: 'XIAOGUI_DESKTOP'
  displayName?: string
  publicKeyDigest?: string
}

export interface XiaoguiNodeCapabilityManifestV1 {
  identity: XiaoguiNodeIdentityV1
  capabilities: readonly XiaoguiNodeCapabilityV1[]
  dataEgressPolicy: XiaoguiNodeDataEgressPolicyV1
  health: XiaoguiNodeHealthV1
  leaseTtlMs: number
  updatedAt: string
  designReserved: true
}

export interface XiaoguiAssignmentPayloadRefV1 {
  mediaType: 'application/vnd.xiaogui.assignment-payload+json'
  artifactId: string
  digest: string
}

export interface XiaoguiAssignmentEnvelopeV1 {
  assignmentId: string
  taskId: string
  hubId: string
  targetNodeId: XiaoguiNodeIdV1 | string
  leaseId: string
  requiredCapabilities: readonly XiaoguiNodeCapabilityV1[]
  dataEgressPolicy: XiaoguiNodeDataEgressPolicyV1
  payloadRef: XiaoguiAssignmentPayloadRefV1
  humanApproval: 'REQUIRED'
  status: XiaoguiAssignmentStatusV1
  issuedAt: string
  leaseExpiresAt: string
}

export type XiaoguiNodeEventV1 =
  | { type: 'NODE_REGISTERED'; nodeId: string; eventId: string; createdAt: string }
  | { type: 'NODE_HEARTBEAT'; nodeId: string; eventId: string; createdAt: string; health: XiaoguiNodeHealthV1 }
  | { type: 'ASSIGNMENT_OFFERED'; nodeId: string; eventId: string; createdAt: string; assignmentId: string; leaseId: string }
  | { type: 'ASSIGNMENT_APPROVED'; nodeId: string; eventId: string; createdAt: string; assignmentId: string; leaseId: string }
  | { type: 'ASSIGNMENT_RUNNING'; nodeId: string; eventId: string; createdAt: string; assignmentId: string; leaseId: string }
  | { type: 'ASSIGNMENT_COMPLETED'; nodeId: string; eventId: string; createdAt: string; assignmentId: string; leaseId: string; resultDigest: string }
  | { type: 'ASSIGNMENT_FAILED'; nodeId: string; eventId: string; createdAt: string; assignmentId: string; leaseId: string; reasonCode: string }
  | { type: 'ASSIGNMENT_OUTCOME_UNKNOWN'; nodeId: string; eventId: string; createdAt: string; assignmentId: string; leaseId: string; reasonCode: string }
  | { type: 'ASSIGNMENT_LEASE_EXPIRED'; nodeId: string; eventId: string; createdAt: string; assignmentId: string; leaseId: string }

export interface XiaoguiNodePortV1 {
  register(manifest: XiaoguiNodeCapabilityManifestV1): Promise<{ ok: true } | { ok: false; reasonCode: string }>
  heartbeat(nodeId: XiaoguiNodeIdV1 | string, health: XiaoguiNodeHealthV1): Promise<{ ok: true } | { ok: false; reasonCode: string }>
  offer(input: {
    taskId: string
    requiredCapabilities: readonly XiaoguiNodeCapabilityV1[]
    dataEgressPolicy: XiaoguiNodeDataEgressPolicyV1
    payloadRef: XiaoguiAssignmentPayloadRefV1
  }): Promise<{ ok: true; envelope: XiaoguiAssignmentEnvelopeV1 } | { ok: false; reasonCode: string }>
  claim(nodeId: XiaoguiNodeIdV1 | string): Promise<{ ok: true; envelope: XiaoguiAssignmentEnvelopeV1 } | { ok: false; reasonCode: string }>
  approveLocal(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string): Promise<{ ok: true } | { ok: false; reasonCode: string }>
  markRunning(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string): Promise<{ ok: true } | { ok: false; reasonCode: string }>
  complete(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string, resultDigest: string): Promise<{ ok: true } | { ok: false; reasonCode: string }>
  fail(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string, reasonCode: string): Promise<{ ok: true } | { ok: false; reasonCode: string }>
  outcomeUnknown(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string, reasonCode: string): Promise<{ ok: true } | { ok: false; reasonCode: string }>
  reconcile(assignmentId: string, nodeId?: XiaoguiNodeIdV1 | string): Promise<
    | { ok: true; status: XiaoguiAssignmentStatusV1; resultDigest?: string; reasonCode?: string }
    | { ok: false; reasonCode: string }
  >
  events(): readonly XiaoguiNodeEventV1[]
}

export function validateXiaoguiNodePublicDtoV1(value: unknown): { ok: true } | { ok: false; reasonCode: string } {
  const runtimeSafe = validateRuntimePublicDto(value)
  if (!runtimeSafe.ok) return runtimeSafe
  return scanForbiddenNodeDto(value) ? { ok: false, reasonCode: 'NODE_PUBLIC_DTO_LEAK' } : { ok: true }
}

function scanForbiddenNodeDto(value: unknown, key = ''): boolean {
  if (value == null) return false
  if (typeof value === 'string') {
    if (/(kimi|qoder|codex|adapter|runtimeSession|prompt|token|secret|password)/i.test(value)) return true
    return false
  }
  if (typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((item) => scanForbiddenNodeDto(item, key))
  for (const [nestedKey, nested] of Object.entries(value)) {
    if (/(adapter|runtimeSession|credential|token|secret|password|prompt|path|database)/i.test(nestedKey)) return true
    if (scanForbiddenNodeDto(nested, nestedKey)) return true
  }
  return false
}
