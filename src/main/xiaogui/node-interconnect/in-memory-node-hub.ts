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
import {
  createInMemoryHubAssignmentStoreV1,
  createXiaoguiLanHubAssignmentStoreForUserDataV1,
  xiaoguiTaskIdentityDigestV1,
  type HubAssignmentLedgerRecordV1,
  type HubAssignmentStoreV1,
} from './hub-assignment-store'

export interface InMemoryXiaoguiNodeHubOptionsV1 {
  hubId?: string
  now?: () => string
  idFactory?: (prefix: string) => string
  assignmentStore?: HubAssignmentStoreV1
  /** Electron composition passes app.getPath('userData'); tests may inject a store. */
  userDataDir?: string
  /** Static capability and egress authority; registration may only report liveness fields. */
  trustedManifests?: ReadonlyMap<string, XiaoguiNodeCapabilityManifestV1>
  onDegraded?: (reasonCode: 'HUB_ASSIGNMENT_STORE_FAILED') => void
}

type XiaoguiNodeEventInputV1 = {
  [Event in XiaoguiNodeEventV1 as Event['type']]: Omit<Event, 'eventId' | 'createdAt'>
}[XiaoguiNodeEventV1['type']]

export function createInMemoryXiaoguiNodeHubV1(options: InMemoryXiaoguiNodeHubOptionsV1 = {}): XiaoguiNodePortV1 {
  return new InMemoryXiaoguiNodeHubV1(options)
}

class InMemoryXiaoguiNodeHubV1 implements XiaoguiNodePortV1 {
  private readonly manifests = new Map<string, XiaoguiNodeCapabilityManifestV1>()
  private readonly assignments = new Map<string, HubAssignmentLedgerRecordV1>()
  private readonly taskAssignments = new Map<string, string>()
  private readonly eventLog: XiaoguiNodeEventV1[] = []
  private readonly trustedManifests: ReadonlyMap<string, XiaoguiNodeCapabilityManifestV1>
  private readonly hubId: string
  private readonly assignmentStore: HubAssignmentStoreV1
  private loadPromise?: Promise<boolean>
  private storeFailed = false

  constructor(private readonly options: InMemoryXiaoguiNodeHubOptionsV1) {
    this.hubId = options.hubId ?? 'xiaogui-local-hub'
    this.trustedManifests = new Map(options.trustedManifests ?? [])
    this.assignmentStore = options.assignmentStore
      ?? (options.userDataDir
        ? createXiaoguiLanHubAssignmentStoreForUserDataV1(options.userDataDir)
        : createInMemoryHubAssignmentStoreV1())
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
    const nodeId = String(manifest.identity.nodeId)
    const trusted = this.trustedManifests.get(nodeId)
    if (!trusted) return { ok: false as const, reasonCode: 'NODE_NOT_APPROVED' }
    if (!sameApprovedManifest(trusted, manifest)) {
      return { ok: false as const, reasonCode: 'NODE_MANIFEST_NOT_APPROVED' }
    }
    this.manifests.set(nodeId, {
      ...trusted,
      health: manifest.health,
      updatedAt: manifest.updatedAt,
    })
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
    if (!await this.ensureLoaded() || !await this.expireLeases()) return this.storeFailure()
    const valid = validateXiaoguiNodePublicDtoV1(input)
    if (!valid.ok) return valid
    if (!isSafeOpaqueId(input.taskId) || !isSafeOpaqueId(input.payloadRef.artifactId)) {
      return { ok: false as const, reasonCode: 'ASSIGNMENT_OPAQUE_ID_INVALID' }
    }
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
    this.assignments.set(assignmentId, {
      taskIdentityDigest: xiaoguiTaskIdentityDigestV1(input.taskId),
      envelope,
      claimed: false,
    })
    this.taskAssignments.set(input.taskId, assignmentId)
    if (!await this.persist()) return this.storeFailure()
    this.push({ type: 'ASSIGNMENT_OFFERED', nodeId: String(target.identity.nodeId), assignmentId, leaseId })
    return { ok: true as const, envelope }
  }

  async claim(nodeId: XiaoguiNodeIdV1 | string) {
    if (!await this.ensureLoaded() || !await this.expireLeases()) return this.storeFailure()
    const assignment = [...this.assignments.values()]
      .filter((candidate) => String(candidate.envelope.targetNodeId) === String(nodeId))
      .filter((candidate) => candidate.envelope.status === 'AWAITING_LOCAL_APPROVAL' && !candidate.claimed)
      .sort((left, right) => left.envelope.issuedAt.localeCompare(right.envelope.issuedAt))[0]
    if (!assignment) return { ok: false as const, reasonCode: 'NO_CLAIMABLE_ASSIGNMENT' }
    this.assignments.set(assignment.envelope.assignmentId, { ...assignment, claimed: true })
    if (!await this.persist()) return this.storeFailure()
    return { ok: true as const, envelope: assignment.envelope }
  }

  async approveLocal(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string) {
    if (!await this.ensureLoaded() || !await this.expireLeases()) return this.storeFailure()
    const assignment = this.assignments.get(assignmentId)
    if (!assignment) return { ok: false as const, reasonCode: 'ASSIGNMENT_NOT_FOUND' }
    const checked = this.checkLease(assignment.envelope, nodeId, leaseId, ['AWAITING_LOCAL_APPROVAL'])
    if (!checked.ok) return checked
    this.assignments.set(assignmentId, { ...assignment, envelope: { ...assignment.envelope, status: 'LEASED' } })
    if (!await this.persist()) return this.storeFailure()
    this.push({ type: 'ASSIGNMENT_APPROVED', nodeId: String(nodeId), assignmentId, leaseId })
    return { ok: true as const }
  }

  async markRunning(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string) {
    if (!await this.ensureLoaded() || !await this.expireLeases()) return this.storeFailure()
    const assignment = this.assignments.get(assignmentId)
    if (!assignment) return { ok: false as const, reasonCode: 'ASSIGNMENT_NOT_FOUND' }
    const checked = this.checkLease(assignment.envelope, nodeId, leaseId, ['LEASED'])
    if (!checked.ok) return checked
    this.assignments.set(assignmentId, { ...assignment, envelope: { ...assignment.envelope, status: 'RUNNING' } })
    if (!await this.persist()) return this.storeFailure()
    this.push({ type: 'ASSIGNMENT_RUNNING', nodeId: String(nodeId), assignmentId, leaseId })
    return { ok: true as const }
  }

  async complete(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string, resultDigest: string) {
    if (!await this.ensureLoaded() || !await this.expireLeases()) return this.storeFailure()
    const assignment = this.assignments.get(assignmentId)
    if (!assignment) return { ok: false as const, reasonCode: 'ASSIGNMENT_NOT_FOUND' }
    const checked = this.checkLease(assignment.envelope, nodeId, leaseId, ['RUNNING'])
    if (!checked.ok) return checked
    if (!/^sha256:[A-Za-z0-9._-]+$/.test(resultDigest)) return { ok: false as const, reasonCode: 'RESULT_DIGEST_INVALID' }
    this.assignments.set(assignmentId, {
      ...assignment,
      envelope: { ...assignment.envelope, status: 'COMPLETED' },
      resultDigest,
    })
    if (!await this.persist()) return this.storeFailure()
    this.push({ type: 'ASSIGNMENT_COMPLETED', nodeId: String(nodeId), assignmentId, leaseId, resultDigest })
    return { ok: true as const }
  }

  async fail(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string, reasonCode: string) {
    if (!await this.ensureLoaded() || !await this.expireLeases()) return this.storeFailure()
    const assignment = this.assignments.get(assignmentId)
    if (!assignment) return { ok: false as const, reasonCode: 'ASSIGNMENT_NOT_FOUND' }
    const checked = this.checkLease(assignment.envelope, nodeId, leaseId, ['RUNNING'])
    if (!checked.ok) return checked
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(reasonCode)) return { ok: false as const, reasonCode: 'ASSIGNMENT_REASON_INVALID' }
    this.assignments.set(assignmentId, {
      ...assignment,
      envelope: { ...assignment.envelope, status: 'FAILED' },
      reasonCode,
    })
    if (!await this.persist()) return this.storeFailure()
    this.push({ type: 'ASSIGNMENT_FAILED', nodeId: String(nodeId), assignmentId, leaseId, reasonCode })
    return { ok: true as const }
  }

  async outcomeUnknown(nodeId: XiaoguiNodeIdV1 | string, assignmentId: string, leaseId: string, reasonCode: string) {
    if (!await this.ensureLoaded() || !await this.expireLeases()) return this.storeFailure()
    const assignment = this.assignments.get(assignmentId)
    if (!assignment) return { ok: false as const, reasonCode: 'ASSIGNMENT_NOT_FOUND' }
    const checked = this.checkLease(assignment.envelope, nodeId, leaseId, ['AWAITING_LOCAL_APPROVAL', 'LEASED', 'RUNNING'])
    if (!checked.ok) return checked
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(reasonCode)) return { ok: false as const, reasonCode: 'ASSIGNMENT_REASON_INVALID' }
    this.assignments.set(assignmentId, {
      ...assignment,
      envelope: { ...assignment.envelope, status: 'OUTCOME_UNKNOWN' },
      reasonCode,
    })
    if (!await this.persist()) return this.storeFailure()
    this.push({ type: 'ASSIGNMENT_OUTCOME_UNKNOWN', nodeId: String(nodeId), assignmentId, leaseId, reasonCode })
    return { ok: true as const }
  }

  async reconcile(assignmentId: string, nodeId?: XiaoguiNodeIdV1 | string) {
    if (!await this.ensureLoaded() || !await this.expireLeases()) return this.storeFailure()
    const assignment = this.assignments.get(assignmentId)
    if (!assignment) return { ok: false as const, reasonCode: 'ASSIGNMENT_NOT_FOUND' }
    if (nodeId && String(assignment.envelope.targetNodeId) !== String(nodeId)) {
      return { ok: false as const, reasonCode: 'ASSIGNMENT_NODE_MISMATCH' }
    }
    return {
      ok: true as const,
      status: assignment.envelope.status,
      ...(assignment.resultDigest ? { resultDigest: assignment.resultDigest } : {}),
      ...(assignment.reasonCode ? { reasonCode: assignment.reasonCode } : {}),
    }
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

  private async expireLeases(): Promise<boolean> {
    const nowMs = Date.parse(this.now())
    let changed = false
    for (const [assignmentId, assignment] of this.assignments) {
      if (
        ['AWAITING_LOCAL_APPROVAL', 'LEASED', 'RUNNING'].includes(assignment.envelope.status) &&
        Date.parse(assignment.envelope.leaseExpiresAt) <= nowMs
      ) {
        this.assignments.set(assignmentId, {
          ...assignment,
          envelope: { ...assignment.envelope, status: 'LEASE_EXPIRED' },
        })
        changed = true
        this.push({
          type: 'ASSIGNMENT_LEASE_EXPIRED',
          nodeId: String(assignment.envelope.targetNodeId),
          assignmentId: assignment.envelope.assignmentId,
          leaseId: assignment.envelope.leaseId,
        })
      }
    }
    return !changed || this.persist()
  }

  private ensureLoaded(): Promise<boolean> {
    if (this.storeFailed) return Promise.resolve(false)
    this.loadPromise ??= this.assignmentStore.load().then((records) => {
      for (const record of records) {
        this.assignments.set(record.envelope.assignmentId, record)
        this.taskAssignments.set(record.envelope.taskId, record.envelope.assignmentId)
      }
      return true
    }).catch(() => {
      this.storeFailed = true
      return false
    })
    return this.loadPromise
  }

  private async persist(): Promise<boolean> {
    if (this.storeFailed) return false
    try {
      await this.assignmentStore.replace([...this.assignments.values()])
      return true
    } catch {
      this.storeFailed = true
      return false
    }
  }

  private storeFailure(): { ok: false; reasonCode: 'HUB_ASSIGNMENT_STORE_FAILED' } {
    this.options.onDegraded?.('HUB_ASSIGNMENT_STORE_FAILED')
    return { ok: false, reasonCode: 'HUB_ASSIGNMENT_STORE_FAILED' }
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

function isSafeOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function sameApprovedManifest(
  trusted: XiaoguiNodeCapabilityManifestV1,
  reported: XiaoguiNodeCapabilityManifestV1,
): boolean {
  return JSON.stringify({ ...trusted, health: undefined, updatedAt: undefined })
    === JSON.stringify({ ...reported, health: undefined, updatedAt: undefined })
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
