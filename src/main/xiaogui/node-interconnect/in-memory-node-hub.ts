import { createHash, randomUUID } from 'node:crypto'

import {
  validateXiaoguiNodePublicDtoV1,
  type XiaoguiAssignmentEnvelopeV1,
  type XiaoguiAssignmentPayloadRefV1,
  type XiaoguiNodeCapabilityManifestV1,
  type XiaoguiNodeCapabilityV1,
  type XiaoguiNodeDataEgressPolicyV1,
  type XiaoguiNodeEventV1,
  type XiaoguiNodeHealthV1,
  type XiaoguiNodeIdV1,
  type XiaoguiNodePortV1,
} from '@shared/xiaogui-node-contract'

export interface InMemoryXiaoguiNodeHubOptionsV1 {
  hubId?: string
  now?: () => string
  idFactory?: (prefix: string) => string
}

interface StoredAssignmentV1 {
  envelope: XiaoguiAssignmentEnvelopeV1
}

type XiaoguiNodeEventInputV1 = {
  [Event in XiaoguiNodeEventV1 as Event['type']]: Omit<Event, 'eventId' | 'createdAt'>
}[XiaoguiNodeEventV1['type']]

export function createInMemoryXiaoguiNodeHubV1(options: InMemoryXiaoguiNodeHubOptionsV1 = {}): XiaoguiNodePortV1 {
  return new InMemoryXiaoguiNodeHubV1(options)
}

class InMemoryXiaoguiNodeHubV1 implements XiaoguiNodePortV1 {
  private readonly manifests = new Map<string, XiaoguiNodeCapabilityManifestV1>()
  private readonly assignments = new Map<string, StoredAssignmentV1>()
  private readonly taskAssignments = new Map<string, string>()
  private readonly eventLog: XiaoguiNodeEventV1[] = []
  private readonly hubId: string

  constructor(private readonly options: InMemoryXiaoguiNodeHubOptionsV1) {
    this.hubId = options.hubId ?? 'xiaogui-local-hub'
  }

  async register(manifest: XiaoguiNodeCapabilityManifestV1) {
    const valid = validateXiaoguiNodePublicDtoV1(manifest)
    if (!valid.ok) return valid
    if (manifest.identity.protocolVersion !== 'xiaogui-node.v1' || manifest.identity.product !== 'XIAOGUI_DESKTOP') {
      return { ok: false as const, reasonCode: 'NODE_PROTOCOL_UNSUPPORTED' }
    }
    if (manifest.designReserved !== true || manifest.leaseTtlMs <= 0) {
      return { ok: false as const, reasonCode: 'NODE_MANIFEST_INVALID' }
    }
    this.manifests.set(String(manifest.identity.nodeId), manifest)
    this.push({ type: 'NODE_REGISTERED', nodeId: String(manifest.identity.nodeId) })
    return { ok: true as const }
  }

  async heartbeat(nodeId: XiaoguiNodeIdV1 | string, health: XiaoguiNodeHealthV1) {
    const manifest = this.manifests.get(String(nodeId))
    if (!manifest) return { ok: false as const, reasonCode: 'NODE_NOT_REGISTERED' }
    this.manifests.set(String(nodeId), { ...manifest, health, updatedAt: this.now() })
    this.push({ type: 'NODE_HEARTBEAT', nodeId: String(nodeId), health })
    return { ok: true as const }
  }

  async offer(input: {
    taskId: string
    requiredCapabilities: readonly XiaoguiNodeCapabilityV1[]
    dataEgressPolicy: XiaoguiNodeDataEgressPolicyV1
    payloadRef: XiaoguiAssignmentPayloadRefV1
  }) {
    this.expireLeases()
    const valid = validateXiaoguiNodePublicDtoV1(input)
    if (!valid.ok) return valid
    if (this.taskAssignments.has(input.taskId)) return { ok: false as const, reasonCode: 'ASSIGNMENT_ALREADY_EXISTS' }
    const target = this.pickNode(input.requiredCapabilities, input.dataEgressPolicy)
    if (!target) return { ok: false as const, reasonCode: 'NO_NODE_CAPABILITY' }
    const assignmentId = this.id('xgn_asg')
    const leaseId = this.id('xgn_lease')
    const issuedAt = this.now()
    const envelope: XiaoguiAssignmentEnvelopeV1 = {
      assignmentId,
      taskId: input.taskId,
      hubId: this.hubId,
      targetNodeId: target.identity.nodeId,
      leaseId,
      requiredCapabilities: input.requiredCapabilities,
      dataEgressPolicy: input.dataEgressPolicy,
      payloadRef: input.payloadRef,
      humanApproval: 'REQUIRED',
      status: 'AWAITING_LOCAL_APPROVAL',
      issuedAt,
      leaseExpiresAt: new Date(Date.parse(issuedAt) + target.leaseTtlMs).toISOString(),
    }
    this.assignments.set(assignmentId, { envelope })
    this.taskAssignments.set(input.taskId, assignmentId)
    this.push({ type: 'ASSIGNMENT_OFFERED', nodeId: String(target.identity.nodeId), assignmentId, leaseId })
    return { ok: true as const, envelope }
  }

  async approveLocal(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string) {
    this.expireLeases()
    const assignment = this.assignments.get(assignmentId)
    if (!assignment) return { ok: false as const, reasonCode: 'ASSIGNMENT_NOT_FOUND' }
    const checked = this.checkLease(assignment.envelope, nodeId, leaseId, ['AWAITING_LOCAL_APPROVAL'])
    if (!checked.ok) return checked
    assignment.envelope = { ...assignment.envelope, status: 'LEASED' }
    this.push({ type: 'ASSIGNMENT_APPROVED', nodeId: String(nodeId), assignmentId, leaseId })
    return { ok: true as const }
  }

  async markRunning(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string) {
    this.expireLeases()
    const assignment = this.assignments.get(assignmentId)
    if (!assignment) return { ok: false as const, reasonCode: 'ASSIGNMENT_NOT_FOUND' }
    const checked = this.checkLease(assignment.envelope, nodeId, leaseId, ['LEASED'])
    if (!checked.ok) return checked
    assignment.envelope = { ...assignment.envelope, status: 'RUNNING' }
    this.push({ type: 'ASSIGNMENT_RUNNING', nodeId: String(nodeId), assignmentId, leaseId })
    return { ok: true as const }
  }

  async complete(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string, resultDigest: string) {
    this.expireLeases()
    const assignment = this.assignments.get(assignmentId)
    if (!assignment) return { ok: false as const, reasonCode: 'ASSIGNMENT_NOT_FOUND' }
    const checked = this.checkLease(assignment.envelope, nodeId, leaseId, ['RUNNING'])
    if (!checked.ok) return checked
    if (!/^sha256:[A-Za-z0-9._-]+$/.test(resultDigest)) return { ok: false as const, reasonCode: 'RESULT_DIGEST_INVALID' }
    assignment.envelope = { ...assignment.envelope, status: 'COMPLETED' }
    this.push({ type: 'ASSIGNMENT_COMPLETED', nodeId: String(nodeId), assignmentId, leaseId, resultDigest })
    return { ok: true as const }
  }

  events(): readonly XiaoguiNodeEventV1[] {
    return [...this.eventLog]
  }

  private pickNode(
    requiredCapabilities: readonly XiaoguiNodeCapabilityV1[],
    dataEgressPolicy: XiaoguiNodeDataEgressPolicyV1,
  ): XiaoguiNodeCapabilityManifestV1 | null {
    const candidates = [...this.manifests.values()]
      .filter((manifest) => manifest.health === 'ONLINE')
      .filter((manifest) => requiredCapabilities.every((capability) => manifest.capabilities.includes(capability)))
      .filter((manifest) => dataEgressPolicy !== 'LOCAL_ONLY' || manifest.dataEgressPolicy === 'LOCAL_ONLY')
      .sort((left, right) => String(left.identity.nodeId).localeCompare(String(right.identity.nodeId)))
    return candidates[0] ?? null
  }

  private checkLease(
    envelope: XiaoguiAssignmentEnvelopeV1,
    nodeId: XiaoguiNodeIdV1 | string,
    leaseId: string,
    expectedStatuses: readonly XiaoguiAssignmentEnvelopeV1['status'][],
  ): { ok: true } | { ok: false; reasonCode: string } {
    if (String(envelope.targetNodeId) !== String(nodeId)) return { ok: false, reasonCode: 'ASSIGNMENT_NODE_MISMATCH' }
    if (envelope.leaseId !== leaseId) return { ok: false, reasonCode: 'ASSIGNMENT_LEASE_MISMATCH' }
    if (envelope.status === 'LEASE_EXPIRED') return { ok: false, reasonCode: 'ASSIGNMENT_LEASE_EXPIRED' }
    if (!expectedStatuses.includes(envelope.status)) return { ok: false, reasonCode: 'ASSIGNMENT_STATUS_INVALID' }
    if (Date.parse(envelope.leaseExpiresAt) <= Date.parse(this.now())) return { ok: false, reasonCode: 'ASSIGNMENT_LEASE_EXPIRED' }
    return { ok: true }
  }

  private expireLeases(): void {
    const nowMs = Date.parse(this.now())
    for (const assignment of this.assignments.values()) {
      if (
        ['AWAITING_LOCAL_APPROVAL', 'LEASED', 'RUNNING'].includes(assignment.envelope.status) &&
        Date.parse(assignment.envelope.leaseExpiresAt) <= nowMs
      ) {
        assignment.envelope = { ...assignment.envelope, status: 'LEASE_EXPIRED' }
        this.push({
          type: 'ASSIGNMENT_LEASE_EXPIRED',
          nodeId: String(assignment.envelope.targetNodeId),
          assignmentId: assignment.envelope.assignmentId,
          leaseId: assignment.envelope.leaseId,
        })
      }
    }
  }

  private push(event: XiaoguiNodeEventInputV1): void {
    const next = {
      ...event,
      eventId: this.id('xgn_evt'),
      createdAt: this.now(),
    } as XiaoguiNodeEventV1
    if (!validateXiaoguiNodePublicDtoV1(next).ok) {
      throw new Error('XIAOGUI_NODE_EVENT_PUBLIC_DTO_LEAK')
    }
    this.eventLog.push(next)
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  private id(prefix: string): string {
    return this.options.idFactory?.(prefix) ?? `${prefix}_${randomUUID()}_${digest(prefix).slice(0, 8)}`
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
