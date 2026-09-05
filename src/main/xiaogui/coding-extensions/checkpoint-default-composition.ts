import { app } from 'electron'

import { workerManager } from '../../worker-manager'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import { getDefaultCollaborationHubApplication } from '../task-hub/ipc'
import type { CheckpointSessionAddressRecordV1 } from './checkpoint-session-binding-registry'
import { trustedSessionAccessV1 } from '../../trusted-session-access'
import { trustedWorkerCapabilityAuthorityV1 } from '../../trusted-worker-capability'
import { normalizeSessionKey } from '../../worker-session-key'
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
  input: Pick<CheckpointSessionAddressRecordV1, 'address' | 'sourceSessionId' | 'sessionFile'>,
): void {
  const binding = workerManager.resolveRegisteredSessionBinding(input.sessionFile)
  if (!binding) throw new Error('TRUSTED_SESSION_BINDING_REQUIRED')
  const snapshot = trustedWorkerCapabilityAuthorityV1.inspectSession(binding)
  if (normalizeSessionKey(snapshot.canonicalSessionFile) !== normalizeSessionKey(input.sessionFile)) {
    throw new Error('SESSION_SCOPE_MISMATCH')
  }
  getDefaultCodingCheckpointProductionCompositionV1().recordTrustedSessionAddress({
    ...input,
    authorizedRoot: snapshot.authorizedRoot,
    projectIdentityDigest: snapshot.projectIdentityDigest,
  })
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
  const access = await trustedSessionAccessV1.reissuePersisted(record)
  await workerManager.loadSession(access.binding)
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
