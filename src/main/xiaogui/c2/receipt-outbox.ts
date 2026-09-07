import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  parseC2ArtifactReceiptAckV1,
  parseC2ArtifactReceiptV1,
  type C2ArtifactReceiptV1,
} from '@shared/xiaogui-c2-artifact'

const OUTBOX_SCHEMA = 'xiaogui.desktop-c2.artifact-receipt-outbox.v1'

interface StoredOutboxV1 {
  schemaVersion: typeof OUTBOX_SCHEMA
  receipts: C2ArtifactReceiptV1[]
}

/** Durable C2-only FIFO. It never reads or writes the H1 receipt queue. */
export class C2ArtifactReceiptOutboxV1 {
  private operation: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  list(): Promise<C2ArtifactReceiptV1[]> {
    return this.serial(async () => (await this.read()).map(cloneReceipt))
  }

  enqueue(value: C2ArtifactReceiptV1): Promise<void> {
    return this.serial(async () => {
      const receipt = parseC2ArtifactReceiptV1(value)
      const receipts = await this.read()
      const existing = receipts.find((candidate) => candidate.eventId === receipt.eventId)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(receipt)) throw new Error('C2 receipt eventId conflict')
        return
      }
      receipts.push(cloneReceipt(receipt))
      await this.write(receipts)
    })
  }

  /**
   * Deletes one item only if the submitted id, exact ACK id and current queue
   * head all agree. A valid ACK naming a later local event is intentionally
   * treated as non-acknowledgement and cannot reorder or truncate the FIFO.
   */
  acknowledge(submittedEventId: string, envelope: unknown): Promise<boolean> {
    return this.serial(async () => {
      const ack = parseC2ArtifactReceiptAckV1(envelope)
      const receipts = await this.read()
      const head = receipts[0]
      if (!head || head.eventId !== submittedEventId || ack.eventId !== submittedEventId) return false
      await this.write(receipts.slice(1))
      return true
    })
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.operation.then(action, action)
    this.operation = run.then(() => undefined, () => undefined)
    return run
  }

  private async read(): Promise<C2ArtifactReceiptV1[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (isCode(error, 'ENOENT')) return []
      throw error
    }
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('C2 receipt outbox is invalid')
    const record = value as Record<string, unknown>
    if (
      Object.keys(record).sort().join(',') !== 'receipts,schemaVersion' ||
      record.schemaVersion !== OUTBOX_SCHEMA ||
      !Array.isArray(record.receipts)
    ) {
      throw new Error('C2 receipt outbox is invalid')
    }
    return record.receipts.map(parseC2ArtifactReceiptV1)
  }

  private async write(receipts: readonly C2ArtifactReceiptV1[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    const stored: StoredOutboxV1 = {
      schemaVersion: OUTBOX_SCHEMA,
      receipts: receipts.map(cloneReceipt),
    }
    try {
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

function cloneReceipt(value: C2ArtifactReceiptV1): C2ArtifactReceiptV1 {
  return { ...value }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code)
}
