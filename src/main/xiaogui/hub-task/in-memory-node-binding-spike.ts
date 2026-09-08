import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  canonicalizeXiaoguiTaskDeliveryReceiptV1,
  parseXiaoguiTaskDeliveryReceiptV1,
  type XiaoguiHubNodePairRequestV1,
  type XiaoguiHubNodePairResponseV1,
  type XiaoguiHubReceiptSubmitResultV1,
  type XiaoguiNodeBindingV1,
  type XiaoguiTaskDeliveryReceiptV1,
} from '@shared/xiaogui-hub-task-contract'
import {
  issueXiaoguiHubNodeKeyPairV1,
  verifyXiaoguiTaskDeliveryReceiptV1,
  type XiaoguiHubIssuedNodeKeyPairV1,
} from './receipt-crypto'

export interface InMemoryHubNodeBindingSpikeOptionsV1 {
  now?: () => string
  idFactory?: (prefix: string) => string
  tokenFactory?: () => string
  issueKeyPair?: () => XiaoguiHubIssuedNodeKeyPairV1
}

export interface InMemoryHubNodeBindingSpikeV1 {
  registerSubject(subjectId: string): void
  pairOrReplaceNode(subjectId: string, request: XiaoguiHubNodePairRequestV1): XiaoguiHubNodePairResponseV1 | { ok: false; reasonCode: 'HUB_SUBJECT_UNKNOWN' | 'HUB_CONTRACT_INVALID' }
  submitReceipt(receipt: XiaoguiTaskDeliveryReceiptV1): XiaoguiHubReceiptSubmitResultV1
  bindings(): readonly XiaoguiNodeBindingV1[]
}

/**
 * H1-0 only: an isolated control-plane spike that proves node replacement and
 * signed/idempotent receipts without a network adapter or persisted private key.
 */
export function createInMemoryHubNodeBindingSpikeV1(
  options: InMemoryHubNodeBindingSpikeOptionsV1 = {},
): InMemoryHubNodeBindingSpikeV1 {
  return new InMemoryHubNodeBindingSpikeServiceV1(options)
}

class InMemoryHubNodeBindingSpikeServiceV1 implements InMemoryHubNodeBindingSpikeV1 {
  private readonly subjects = new Set<string>()
  private readonly bindingsByNodeId = new Map<string, StoredNodeBinding>()
  private readonly activeNodeBySubjectId = new Map<string, string>()
  private readonly receiptsByEventId = new Map<string, StoredReceipt>()
  private readonly lastSequenceByKeyId = new Map<string, number>()

  constructor(private readonly options: InMemoryHubNodeBindingSpikeOptionsV1) {}

  registerSubject(subjectId: string): void {
    if (!isOpaqueId(subjectId)) throw new Error('HUB_CONTRACT_INVALID')
    this.subjects.add(subjectId)
  }

  pairOrReplaceNode(
    subjectId: string,
    request: XiaoguiHubNodePairRequestV1,
  ): XiaoguiHubNodePairResponseV1 | { ok: false; reasonCode: 'HUB_SUBJECT_UNKNOWN' | 'HUB_CONTRACT_INVALID' } {
    if (!this.subjects.has(subjectId)) return { ok: false, reasonCode: 'HUB_SUBJECT_UNKNOWN' }
    if (!isSha256(request.installationIdDigest)) return { ok: false, reasonCode: 'HUB_CONTRACT_INVALID' }

    const previousNodeId = this.activeNodeBySubjectId.get(subjectId)
    if (previousNodeId) {
      const previous = this.bindingsByNodeId.get(previousNodeId)
      if (previous) {
        previous.binding = { ...previous.binding, state: 'REVOKED', revokedAt: this.now() }
      }
    }

    const keyPair = (this.options.issueKeyPair ?? issueXiaoguiHubNodeKeyPairV1)()
    const nodeId = this.id('xgh_node')
    const binding: XiaoguiNodeBindingV1 = {
      nodeId,
      subjectId,
      installationIdDigest: request.installationIdDigest,
      keyId: keyPair.keyId,
      publicKeyPem: keyPair.publicKeyPem,
      publicKeyDigest: keyPair.publicKeyDigest,
      state: 'ACTIVE',
      pairedAt: this.now(),
      revokedAt: null,
      lastSeenAt: this.now(),
    }
    const deviceToken = (this.options.tokenFactory ?? defaultDeviceToken)()
    this.bindingsByNodeId.set(nodeId, {
      binding,
      deviceTokenHash: sha256(deviceToken),
    })
    this.activeNodeBySubjectId.set(subjectId, nodeId)

    return { binding: { ...binding }, deviceToken, privateKeyPem: keyPair.privateKeyPem }
  }

  submitReceipt(receipt: XiaoguiTaskDeliveryReceiptV1): XiaoguiHubReceiptSubmitResultV1 {
    const parsed = parseXiaoguiTaskDeliveryReceiptV1(receipt)
    if (!parsed.ok) return parsed
    const canonicalReceipt = canonicalizeXiaoguiTaskDeliveryReceiptV1(parsed.value)
    const duplicate = this.receiptsByEventId.get(parsed.value.eventId)
    if (duplicate) {
      if (duplicate.canonicalReceipt !== canonicalReceipt) {
        return { ok: false, reasonCode: 'HUB_RECEIPT_IDEMPOTENCY_CONFLICT' }
      }
      if (!verifyXiaoguiTaskDeliveryReceiptV1(parsed.value, duplicate.publicKeyPem)) {
        return { ok: false, reasonCode: 'HUB_RECEIPT_SIGNATURE_INVALID' }
      }
      return { ok: true, ack: { ...duplicate.ack, duplicate: true } }
    }

    const storedBinding = this.bindingsByNodeId.get(String(parsed.value.nodeId))
    if (!storedBinding) return { ok: false, reasonCode: 'HUB_NODE_BINDING_UNKNOWN' }
    if (storedBinding.binding.state !== 'ACTIVE') return { ok: false, reasonCode: 'HUB_NODE_BINDING_REVOKED' }
    if (
      storedBinding.binding.subjectId !== parsed.value.subjectId
      || storedBinding.binding.keyId !== parsed.value.keyId
    ) {
      return { ok: false, reasonCode: 'HUB_NODE_BINDING_MISMATCH' }
    }
    if (!verifyXiaoguiTaskDeliveryReceiptV1(parsed.value, storedBinding.binding.publicKeyPem)) {
      return { ok: false, reasonCode: 'HUB_RECEIPT_SIGNATURE_INVALID' }
    }
    const lastSequence = this.lastSequenceByKeyId.get(parsed.value.keyId) ?? 0
    if (parsed.value.sequence <= lastSequence) {
      return { ok: false, reasonCode: 'HUB_RECEIPT_SEQUENCE_REPLAYED' }
    }

    const ack = {
      receiptId: this.id('xgh_receipt'),
      eventId: parsed.value.eventId,
      verified: true as const,
      duplicate: false,
      occurredAt: parsed.value.occurredAt,
      receivedAt: this.now(),
    }
    this.receiptsByEventId.set(parsed.value.eventId, {
      canonicalReceipt,
      publicKeyPem: storedBinding.binding.publicKeyPem,
      ack,
    })
    this.lastSequenceByKeyId.set(parsed.value.keyId, parsed.value.sequence)
    storedBinding.binding = { ...storedBinding.binding, lastSeenAt: this.now() }
    return { ok: true, ack }
  }

  bindings(): readonly XiaoguiNodeBindingV1[] {
    return [...this.bindingsByNodeId.values()].map(({ binding }) => ({ ...binding }))
  }

  private id(prefix: string): string {
    return this.options.idFactory?.(prefix) ?? `${prefix}_${randomUUID()}`
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }
}

interface StoredNodeBinding {
  binding: XiaoguiNodeBindingV1
  /** The in-memory stand-in for the Hub's persisted token digest. */
  deviceTokenHash: string
}

interface StoredReceipt {
  canonicalReceipt: string
  publicKeyPem: string
  ack: {
    receiptId: string
    eventId: string
    verified: true
    duplicate: boolean
    occurredAt: string
    receivedAt: string
  }
}

function defaultDeviceToken(): string {
  return randomBytes(32).toString('base64url')
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function isSha256(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value)
}
