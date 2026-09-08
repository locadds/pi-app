import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { C2ArtifactReceiptV1 } from '@shared/xiaogui-c2-artifact'
import { C2ArtifactReceiptOutboxV1 } from './receipt-outbox'

const roots: string[] = []
const receipt = (eventId: string): C2ArtifactReceiptV1 => ({
  eventId,
  installIntentId: '123e4567-e89b-12d3-a456-426614174000',
  releaseId: 'release-1',
  eventType: 'INSTALL_SUCCEEDED',
  occurredAt: '2026-09-07T01:00:00.000Z',
  mode: 'WORK',
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('C2ArtifactReceiptOutboxV1', () => {
  it('persists receipts in insertion order and deletes only an exact ACK for the submitted queue head', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaogui-c2-outbox-'))
    roots.push(root)
    const path = join(root, 'artifact-receipts-v1.json')
    const outbox = new C2ArtifactReceiptOutboxV1(path)
    await outbox.enqueue(receipt('event-1'))
    await outbox.enqueue(receipt('event-2'))

    const reloaded = new C2ArtifactReceiptOutboxV1(path)
    await expect(reloaded.list()).resolves.toEqual([receipt('event-1'), receipt('event-2')])

    await expect(reloaded.acknowledge('event-1', {
      data: {
        schemaVersion: 'xiaogui.artifact-receipt-ack.v1',
        ok: true,
        eventId: 'event-2',
        duplicate: false,
        receivedAt: '2026-09-07T01:00:01.000Z',
      },
    })).resolves.toBe(false)
    await expect(reloaded.list()).resolves.toEqual([receipt('event-1'), receipt('event-2')])

    await expect(reloaded.acknowledge('event-1', {
      data: {
        schemaVersion: 'xiaogui.artifact-receipt-ack.v1',
        ok: true,
        eventId: 'event-1',
        duplicate: true,
        receivedAt: '2026-09-07T01:00:02.000Z',
      },
    })).resolves.toBe(true)
    await expect(reloaded.list()).resolves.toEqual([receipt('event-2')])
  })

  it('rejects conflicting event reuse and preserves the queue when ACK shape is not exact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaogui-c2-outbox-'))
    roots.push(root)
    const outbox = new C2ArtifactReceiptOutboxV1(join(root, 'artifact-receipts-v1.json'))
    await outbox.enqueue(receipt('event-1'))
    await expect(outbox.enqueue({ ...receipt('event-1'), eventType: 'INSTALL_FAILED', errorCategory: 'VERIFY_FAILED' }))
      .rejects.toThrow(/conflict/i)
    await expect(outbox.acknowledge('event-1', {
      data: {
        schemaVersion: 'xiaogui.artifact-receipt-ack.v1',
        ok: true,
        eventId: 'event-1',
        duplicate: false,
        receivedAt: '2026-09-07T01:00:02.000Z',
        queueSize: 0,
      },
    })).rejects.toThrow(/unknown field/i)
    await expect(outbox.list()).resolves.toEqual([receipt('event-1')])
  })
})
