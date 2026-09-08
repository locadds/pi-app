import Store from 'electron-store'

import {
  createHubTaskWorkerStateStoreV1,
  type HubTaskWorkerStatePersistenceV1,
  type HubTaskWorkerStateStoreV1,
  type HubTaskWorkerStateV1,
} from './worker-state'

const STATE_KEY = 'state'

export interface HubTaskWorkerStateBackingV1 {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

/**
 * State lives in a private main-process electron-store file. It may contain a
 * task package and signed outbox receipts, but never node private keys,
 * tokens, endpoints, absolute paths, or Agent session identifiers.
 */
export function createHubTaskWorkerStatePersistenceV1(
  backing: HubTaskWorkerStateBackingV1,
): HubTaskWorkerStatePersistenceV1 {
  return {
    read: () => {
      const candidate = backing.get(STATE_KEY)
      return isRecord(candidate) ? candidate as unknown as HubTaskWorkerStateV1 : undefined
    },
    write: (state) => {
      backing.set(STATE_KEY, state)
    },
  }
}

export function createPersistentHubTaskWorkerStateStoreV1(): HubTaskWorkerStateStoreV1 {
  const backing = new Store<Record<string, unknown>>({
    name: 'xiaogui-hub-task-worker',
  })
  return createHubTaskWorkerStateStoreV1({
    read: () => {
      const candidate = backing.get(STATE_KEY)
      return isRecord(candidate) ? candidate as unknown as HubTaskWorkerStateV1 : undefined
    },
    write: (state) => {
      backing.set(STATE_KEY, state)
    },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
