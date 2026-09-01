import { describe, expect, it } from 'vitest'

import {
  XIAOGUI_HUB_TASK_RECEIPT_SCHEMA_V1,
  type XiaoguiTaskDeliveryReceiptUnsignedV1,
} from '@shared/xiaogui-hub-task-contract'
import { createInMemoryHubNodeBindingSpikeV1 } from './in-memory-node-binding-spike'
import { signXiaoguiTaskDeliveryReceiptV1 } from './receipt-crypto'

describe('H1-0 in-memory node binding and signed delivery receipt spike', () => {
  it('accepts a signed USER_OPENED receipt with the actual and Hub receipt timestamps', () => {
    let id = 0
    const hub = createInMemoryHubNodeBindingSpikeV1({
      now: () => '2026-09-01T01:02:03.000Z',
      idFactory: (prefix) => `${prefix}_${++id}`,
      tokenFactory: () => 'one-time-device-token',
    })
    hub.registerSubject('subject-b')
    const paired = hub.pairOrReplaceNode('subject-b', { installationIdDigest: digest('b-first-installation') })
    if ('ok' in paired) throw new Error('pairing failed')

    const receipt = signXiaoguiTaskDeliveryReceiptV1(
      unsignedReceipt(paired.binding, { eventId: 'evt-opened-1', occurredAt: '2026-09-01T01:00:00.000Z' }),
      paired.privateKeyPem,
    )
    expect(hub.submitReceipt(receipt)).toEqual({
      ok: true,
      ack: {
        receiptId: 'xgh_receipt_2',
        eventId: 'evt-opened-1',
        verified: true,
        duplicate: false,
        occurredAt: '2026-09-01T01:00:00.000Z',
        receivedAt: '2026-09-01T01:02:03.000Z',
      },
    })
  })

  it('replaces the active node, rejects a newly signed old-node receipt, and keeps completed receipt retries idempotent', () => {
    let id = 0
    const hub = createInMemoryHubNodeBindingSpikeV1({
      now: () => '2026-09-01T02:00:00.000Z',
      idFactory: (prefix) => `${prefix}_${++id}`,
    })
    hub.registerSubject('subject-b')
    const first = hub.pairOrReplaceNode('subject-b', { installationIdDigest: digest('first') })
    if ('ok' in first) throw new Error('first pairing failed')

    const opened = signXiaoguiTaskDeliveryReceiptV1(
      unsignedReceipt(first.binding, { eventId: 'evt-opened-1', sequence: 1 }),
      first.privateKeyPem,
    )
    const accepted = hub.submitReceipt(opened)
    expect(accepted).toMatchObject({ ok: true, ack: { duplicate: false } })
    expect(hub.submitReceipt(opened)).toMatchObject({ ok: true, ack: { duplicate: true } })

    const replacement = hub.pairOrReplaceNode('subject-b', { installationIdDigest: digest('second') })
    if ('ok' in replacement) throw new Error('replacement pairing failed')
    expect(hub.bindings()).toEqual([
      expect.objectContaining({ nodeId: first.binding.nodeId, state: 'REVOKED' }),
      expect.objectContaining({ nodeId: replacement.binding.nodeId, state: 'ACTIVE' }),
    ])

    const oldNodeNewEvent = signXiaoguiTaskDeliveryReceiptV1(
      unsignedReceipt(first.binding, { eventId: 'evt-old-node-new', sequence: 2 }),
      first.privateKeyPem,
    )
    expect(hub.submitReceipt(oldNodeNewEvent)).toEqual({ ok: false, reasonCode: 'HUB_NODE_BINDING_REVOKED' })

    const replacementReceipt = signXiaoguiTaskDeliveryReceiptV1(
      unsignedReceipt(replacement.binding, { eventId: 'evt-new-node-1', sequence: 1 }),
      replacement.privateKeyPem,
    )
    expect(hub.submitReceipt(replacementReceipt)).toMatchObject({ ok: true, ack: { duplicate: false } })
  })

  it('rejects altered event IDs, old sequences, invalid signatures, and private material from the public binding snapshot', () => {
    const hub = createInMemoryHubNodeBindingSpikeV1({ now: () => '2026-09-01T03:00:00.000Z' })
    hub.registerSubject('subject-b')
    const paired = hub.pairOrReplaceNode('subject-b', { installationIdDigest: digest('installation') })
    if ('ok' in paired) throw new Error('pairing failed')

    const original = signXiaoguiTaskDeliveryReceiptV1(
      unsignedReceipt(paired.binding, { eventId: 'evt-1', sequence: 2 }),
      paired.privateKeyPem,
    )
    expect(hub.submitReceipt(original)).toMatchObject({ ok: true })
    expect(hub.submitReceipt({ ...original, taskId: 'task-altered' })).toEqual({
      ok: false,
      reasonCode: 'HUB_RECEIPT_IDEMPOTENCY_CONFLICT',
    })

    const replay = signXiaoguiTaskDeliveryReceiptV1(
      unsignedReceipt(paired.binding, { eventId: 'evt-replay', sequence: 1 }),
      paired.privateKeyPem,
    )
    expect(hub.submitReceipt(replay)).toEqual({ ok: false, reasonCode: 'HUB_RECEIPT_SEQUENCE_REPLAYED' })
    expect(hub.submitReceipt({ ...original, eventId: 'evt-invalid-signature', signature: original.signature.slice(0, -2) + 'AA' })).toEqual({
      ok: false,
      reasonCode: 'HUB_RECEIPT_SIGNATURE_INVALID',
    })

    const publicSnapshot = JSON.stringify(hub.bindings())
    expect(publicSnapshot).not.toContain(paired.privateKeyPem)
    expect(publicSnapshot).not.toContain(paired.deviceToken)
    expect(publicSnapshot).not.toMatch(/token|secret|password/i)
  })
})

function unsignedReceipt(
  binding: { subjectId: string; nodeId: string; keyId: string },
  overrides: Partial<XiaoguiTaskDeliveryReceiptUnsignedV1> = {},
): XiaoguiTaskDeliveryReceiptUnsignedV1 {
  return {
    schemaVersion: XIAOGUI_HUB_TASK_RECEIPT_SCHEMA_V1,
    eventId: 'evt-default',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    subjectId: binding.subjectId,
    nodeId: binding.nodeId,
    keyId: binding.keyId,
    eventType: 'USER_OPENED',
    packageSha256: digest('task-package'),
    occurredAt: '2026-09-01T00:00:00.000Z',
    sequence: 1,
    resultSha256: null,
    ...overrides,
  }
}

function digest(value: string): string {
  // Fixed 64 hexadecimal characters are sufficient for contract-level tests.
  return `sha256:${value.padEnd(64, 'a').slice(0, 64).replace(/[^a-f0-9]/g, 'a')}`
}
