import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

import { isWslWindowsPath } from '@shared/wsl-path'

import type { WorkerResponsePayload } from '@shared/worker-rpc-types'
import type { WorkerSlot } from './worker-manager-types'
import { normalizeSessionKey } from './worker-session-key'

export interface WorkerSessionCreationOperationV1 {
  readonly nonce: string
  acceptTarget(response: WorkerResponsePayload): string
  acceptCancellation(response: WorkerResponsePayload): void
}

function portableAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || isWslWindowsPath(value)
}

/**
 * Main-only, one-shot proof for New/Fork/Clone output. It captures the exact
 * source Worker and slot before dispatch; a response cannot be replayed or
 * transplanted to another live Worker even when it echoes the same nonce.
 */
export function createWorkerSessionCreationOperationV1(input: {
  readonly slot: WorkerSlot
  readonly pool: ReadonlyMap<string, WorkerSlot>
}): WorkerSessionCreationOperationV1 {
  const sourcePoolKey = input.slot.poolKey
  const sourceWorker = input.slot.worker
  const sourceSlotBindingDigest = input.slot.slotBindingDigest
  const sourceProjectBinding = input.slot.projectBinding
  const sourceProjectIdentityDigest = input.slot.projectIdentityDigest
  const sourceCwd = input.slot.cwd
  const sourceSessionFile = normalizeSessionKey(input.slot.sessionFile ?? '')
  if (!sourceSessionFile) throw new Error('SESSION_CREATION_SOURCE_REQUIRED')
  const nonce = randomUUID()
  let consumed = false

  const consume = (response: WorkerResponsePayload): void => {
    if (consumed) throw new Error('SESSION_CREATION_RECEIPT_REPLAYED')
    consumed = true
    if (
      response.creationOperationNonce !== nonce
      || input.slot.worker !== sourceWorker
      || input.slot.slotBindingDigest !== sourceSlotBindingDigest
      || input.slot.projectBinding !== sourceProjectBinding
      || input.slot.projectIdentityDigest !== sourceProjectIdentityDigest
      || input.slot.cwd !== sourceCwd
      || input.pool.get(sourcePoolKey) !== input.slot
      || input.slot.stopping
    ) {
      throw new Error('SESSION_CREATION_RECEIPT_INVALID')
    }
  }

  return Object.freeze({
    nonce,
    acceptTarget(response: WorkerResponsePayload): string {
      consume(response)
      const rawTarget = String(response.sessionFile || '').trim()
      if (!portableAbsolutePath(rawTarget) || !/\.jsonl$/i.test(rawTarget)) {
        throw new Error('SESSION_CREATION_RECEIPT_INVALID')
      }
      const target = normalizeSessionKey(rawTarget)
      if (
        !target
        || target === sourceSessionFile
        || dirname(target) !== dirname(sourceSessionFile)
      ) {
        throw new Error('SESSION_CREATION_RECEIPT_INVALID')
      }
      return target
    },
    acceptCancellation(response: WorkerResponsePayload): void {
      consume(response)
    },
  })
}
