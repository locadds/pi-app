import { describe, expect, it, vi } from 'vitest'

import type { WorkerResponsePayload } from '@shared/worker-rpc-types'
import type { WorkerSlot } from './worker-manager-types'
import { createWorkerSessionCreationOperationV1 } from './worker-session-creation-operation'

function fakeSlot(): WorkerSlot {
  return {
    poolKey: 'D:/sessions/source.jsonl',
    cwd: 'D:/project',
    worker: { postMessage: vi.fn() },
    slotBindingDigest: 'slot-binding-a',
    sessionFile: 'D:/sessions/source.jsonl',
    stopping: false,
  } as unknown as WorkerSlot
}

function response(
  operationNonce: string,
  sessionFile = 'D:/sessions/target.jsonl',
): WorkerResponsePayload {
  return {
    type: 'fork-done',
    creationOperationNonce: operationNonce,
    sessionFile,
  }
}

describe('Worker session creation operation', () => {
  it('accepts the exact Main-bound receipt once and rejects replay', () => {
    const slot = fakeSlot()
    const pool = new Map([[slot.poolKey, slot]])
    const operation = createWorkerSessionCreationOperationV1({ slot, pool })
    const receipt = response(operation.nonce)

    expect(operation.acceptTarget(receipt)).toBe('D:\\sessions\\target.jsonl')
    expect(() => operation.acceptTarget(receipt)).toThrow('SESSION_CREATION_RECEIPT_REPLAYED')
  })

  it('rejects a forged nonce, replaced Worker, or replaced slot', () => {
    const forgedNonceSlot = fakeSlot()
    const forgedNoncePool = new Map([[forgedNonceSlot.poolKey, forgedNonceSlot]])
    const forgedNonce = createWorkerSessionCreationOperationV1({
      slot: forgedNonceSlot,
      pool: forgedNoncePool,
    })
    expect(() => forgedNonce.acceptTarget(response('forged-nonce')))
      .toThrow('SESSION_CREATION_RECEIPT_INVALID')

    const replacedWorkerSlot = fakeSlot()
    const replacedWorkerPool = new Map([[replacedWorkerSlot.poolKey, replacedWorkerSlot]])
    const replacedWorker = createWorkerSessionCreationOperationV1({
      slot: replacedWorkerSlot,
      pool: replacedWorkerPool,
    })
    replacedWorkerSlot.worker = { postMessage: vi.fn() } as never
    expect(() => replacedWorker.acceptTarget(response(replacedWorker.nonce)))
      .toThrow('SESSION_CREATION_RECEIPT_INVALID')

    const replacedSlot = fakeSlot()
    const replacedSlotPool = new Map([[replacedSlot.poolKey, replacedSlot]])
    const replacedSlotOperation = createWorkerSessionCreationOperationV1({
      slot: replacedSlot,
      pool: replacedSlotPool,
    })
    replacedSlotPool.set(replacedSlot.poolKey, fakeSlot())
    expect(() => replacedSlotOperation.acceptTarget(response(replacedSlotOperation.nonce)))
      .toThrow('SESSION_CREATION_RECEIPT_INVALID')
  })

  it.each([
    ['project capability', (slot: WorkerSlot) => {
      slot.projectBinding = Object.freeze({}) as never
    }],
    ['project identity', (slot: WorkerSlot) => {
      slot.projectIdentityDigest = 'project-identity-b'
    }],
    ['project cwd', (slot: WorkerSlot) => {
      slot.cwd = 'D:/other-project'
    }],
  ])('rejects a receipt after the source %s changes', (_label, mutate) => {
    const slot = fakeSlot()
    const pool = new Map([[slot.poolKey, slot]])
    const operation = createWorkerSessionCreationOperationV1({ slot, pool })

    mutate(slot)

    expect(() => operation.acceptTarget(response(operation.nonce)))
      .toThrow('SESSION_CREATION_RECEIPT_INVALID')
  })

  it.each([
    ['relative target', 'relative.jsonl'],
    ['wrong directory', 'D:/other/target.jsonl'],
    ['source replay', 'D:/sessions/source.jsonl'],
    ['wrong extension', 'D:/sessions/target.txt'],
  ])('rejects a %s before a session binding can be issued', (_label, target) => {
    const slot = fakeSlot()
    const pool = new Map([[slot.poolKey, slot]])
    const operation = createWorkerSessionCreationOperationV1({ slot, pool })

    expect(() => operation.acceptTarget(response(operation.nonce, target)))
      .toThrow('SESSION_CREATION_RECEIPT_INVALID')
  })

  it('validates cancellation provenance and consumes its nonce', () => {
    const slot = fakeSlot()
    const pool = new Map([[slot.poolKey, slot]])
    const operation = createWorkerSessionCreationOperationV1({ slot, pool })
    const cancelled = {
      type: 'fork-done',
      cancelled: true,
      creationOperationNonce: operation.nonce,
    } as WorkerResponsePayload

    expect(() => operation.acceptCancellation(cancelled)).not.toThrow()
    expect(() => operation.acceptCancellation(cancelled))
      .toThrow('SESSION_CREATION_RECEIPT_REPLAYED')
  })
})
