import { z } from 'zod'

import {
  XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2,
  XIAOGUI_DIRECT_CODING_SUBJECT_V2,
  type DirectCodingCheckpointConfirmOutcomeV2,
  type DirectCodingCheckpointListOutcomeV2,
  type DirectCodingCheckpointPreviewOutcomeV2,
} from '@shared/xiaogui-direct-coding'
import type { SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

import { registerHandler } from '../../ipc/registry'
import type { DirectCodingModuleV2 } from './direct-coding-module'

const AddressSchema = z.object({
  projectId: z.string().regex(/^xgp1_[0-9a-f]{64}$/),
  sessionKey: z.string().regex(/^xgs1_[0-9a-f]{64}$/),
}).strict()
const BaseSchema = {
  contractVersion: z.literal(XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2),
  address: AddressSchema,
}
const ListSchema = z.object(BaseSchema).strict()
const PreviewSchema = z.object({
  ...BaseSchema,
  checkpointToken: z.string().regex(/^xdcp_[a-z0-9-]{8,80}$/i),
}).strict()
const ConfirmSchema = z.object({
  ...BaseSchema,
  checkpointToken: z.string().regex(/^xdcp_[a-z0-9-]{8,80}$/i),
  previewToken: z.string().regex(/^xdpv_[a-z0-9-]{8,80}$/i),
  previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict()

export function registerDirectCodingCheckpointHandlersV2(options: {
  readonly module: Pick<DirectCodingModuleV2, 'list' | 'prepareRestore' | 'confirmRestore'>
  readonly scope: SessionScopeLookupV1
  readonly resolveCurrentRoot: (address: SessionAddressV1) => Promise<string | null>
}): void {
  registerHandler('ipc:xiaogui.coding.direct.checkpoint.list', async (payload): Promise<DirectCodingCheckpointListOutcomeV2> => {
    const parsed = ListSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const address = parsed.data.address as SessionAddressV1
    const subject = await codingSubject(options.scope, address)
    if (!subject) return failure('SESSION_SCOPE_MISMATCH')
    try {
      return options.module.list(subject)
    } catch {
      return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
    }
  })
  registerHandler('ipc:xiaogui.coding.direct.checkpoint.restore.preview', async (payload): Promise<DirectCodingCheckpointPreviewOutcomeV2> => {
    const parsed = PreviewSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const address = parsed.data.address as SessionAddressV1
    const subject = await codingSubject(options.scope, address)
    if (!subject) return failure('SESSION_SCOPE_MISMATCH')
    const currentRoot = await trustedCurrentRoot(options.resolveCurrentRoot, address)
    if (!currentRoot) return failure('SESSION_SCOPE_MISMATCH')
    try {
      return options.module.prepareRestore(subject, currentRoot, parsed.data.checkpointToken)
    } catch {
      return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
    }
  })
  registerHandler('ipc:xiaogui.coding.direct.checkpoint.restore.confirm', async (payload): Promise<DirectCodingCheckpointConfirmOutcomeV2> => {
    const parsed = ConfirmSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const address = parsed.data.address as SessionAddressV1
    const subject = await codingSubject(options.scope, address)
    if (!subject) return failure('SESSION_SCOPE_MISMATCH')
    const currentRoot = await trustedCurrentRoot(options.resolveCurrentRoot, address)
    if (!currentRoot) return failure('SESSION_SCOPE_MISMATCH')
    try {
      return options.module.confirmRestore(subject, currentRoot, {
        checkpointToken: parsed.data.checkpointToken,
        previewToken: parsed.data.previewToken,
        previewDigest: parsed.data.previewDigest,
      })
    } catch {
      return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
    }
  })
}

async function trustedCurrentRoot(
  resolveCurrentRoot: (address: SessionAddressV1) => Promise<string | null>,
  address: SessionAddressV1,
): Promise<string | null> {
  try {
    const root = await resolveCurrentRoot(address)
    return typeof root === 'string' && root.trim() ? root : null
  } catch {
    return null
  }
}

async function codingSubject(scope: SessionScopeLookupV1, address: SessionAddressV1) {
  try {
    const result = await scope.lookup(address)
    if (result.kind !== 'FOUND' || result.scope.sessionMode !== 'CODING') return null
    return {
      schemaVersion: 2 as const,
      kind: XIAOGUI_DIRECT_CODING_SUBJECT_V2,
      address: result.scope,
    }
  } catch {
    return null
  }
}

function failure(code: import('@shared/xiaogui-direct-coding').DirectCodingCheckpointErrorCodeV2) {
  return {
    ok: false as const,
    error: { code, messageKey: `xiaogui.coding.direct.checkpoint.${code.toLowerCase()}` },
  }
}
