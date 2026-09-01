import { app } from 'electron'

import { workerManager } from '../../worker-manager'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import { getDefaultCollaborationHubApplication } from '../task-hub/ipc'
import type { CheckpointSessionAddressRecordV1 } from './checkpoint-session-binding-registry'
import {
  createDefaultCodingCheckpointProductionCompositionV1,
  type CodingCheckpointProductionCompositionV1,
  type CodingCheckpointProductionStatusV1,
} from './checkpoint-production-composition'

let defaultComposition: CodingCheckpointProductionCompositionV1 | null = null
let initialization: Promise<void> | null = null

export function registerDefaultCodingCheckpointHandlersV1(): void {
  const composition = getDefaultCodingCheckpointProductionCompositionV1()
  composition.register()
  initialization ??= composition.initialize().catch(() => undefined)
}

export function recordDefaultCodingCheckpointSessionAddressV1(
  input: CheckpointSessionAddressRecordV1,
): void {
  getDefaultCodingCheckpointProductionCompositionV1().recordTrustedSessionAddress(input)
}

export function defaultCodingCheckpointStatusV1(): CodingCheckpointProductionStatusV1 {
  return getDefaultCodingCheckpointProductionCompositionV1().status()
}

/**
 * Revives the exact Pi Worker behind an opaque CODING address. The private
 * session path remains inside Main and is never returned to Renderer.
 */
export async function ensureDefaultCodingRoleWorkerSessionV1(
  address: SessionAddressV1,
): Promise<void> {
  const record = getDefaultCodingCheckpointProductionCompositionV1()
    .readTrustedSessionAddress(address)
  await workerManager.loadSession(record.sessionFile)
}

export async function closeDefaultCodingCheckpointProductionCompositionV1(): Promise<void> {
  const current = defaultComposition
  const pending = initialization
  defaultComposition = null
  initialization = null
  await pending?.catch(() => undefined)
  await current?.close()
}

function getDefaultCodingCheckpointProductionCompositionV1(): CodingCheckpointProductionCompositionV1 {
  if (defaultComposition) return defaultComposition
  defaultComposition = createDefaultCodingCheckpointProductionCompositionV1({
    userDataDir: app.getPath('userData'),
    worker: workerManager,
    authority: getDefaultCollaborationHubApplication(),
  })
  return defaultComposition
}
