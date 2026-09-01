import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
  type CodingCheckpointCaptureOutcomeV1,
  type CodingCheckpointCaptureRequestV1,
  type CodingCheckpointConfirmOutcomeV1,
  type CodingCheckpointConfirmRequestV1,
  type CodingCheckpointControlErrorCodeV1,
  type CodingCheckpointPreviewOutcomeV1,
  type CodingCheckpointPreviewRequestV1,
  type CodingCheckpointListOutcomeV1,
  type CodingCheckpointListRequestV1,
  type CodingCheckpointRestorePreviewProjectionV1,
  type CodingCheckpointSummaryV1,
} from '@shared/xiaogui-coding-checkpoint-control'
import type { CodingCheckpointV1 } from '@shared/xiaogui-coding-extension-pack'
import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'

import { registerHandler } from '../../ipc/registry'
import type {
  CodingCheckpointErrorCodeV1,
  CodingCheckpointModuleV1,
} from './checkpoint-module'

export interface CodingCheckpointScopePortV1 {
  isCodingSession(address: HubAddressV1): boolean | Promise<boolean>
  hasAttempt(address: HubAddressV1, attemptId: string): boolean | Promise<boolean>
}

type CheckpointPortV1 = Pick<CodingCheckpointModuleV1, 'list' | 'capture' | 'prepareRestore' | 'restore'>

const AddressSchema = z.object({
  projectId: z.string().regex(/^xgp1_[0-9a-f]{64}$/),
  sessionKey: z.string().regex(/^xgs1_[0-9a-f]{64}$/),
}).strict()
const SafeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/i)
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const BaseFields = {
  contractVersion: z.literal(XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1),
  address: AddressSchema,
  attemptId: SafeIdSchema,
}
const CaptureSchema = z.object(BaseFields).strict()
const PreviewSchema = z.object({
  ...BaseFields,
  checkpointId: SafeIdSchema,
}).strict()
const ConfirmSchema = z.object({
  ...BaseFields,
  checkpointId: SafeIdSchema,
  previewId: SafeIdSchema,
  previewDigest: DigestSchema,
}).strict()

/**
 * Renderer-facing checkpoint adapter. It deliberately reconstructs every DTO
 * so private session files, worktree roots and opaque snapshot refs cannot
 * escape even if a future Main Port accidentally returns extra properties.
 */
export function registerCodingCheckpointHandlersV1(options: {
  readonly checkpoint?: CheckpointPortV1
  readonly scope: CodingCheckpointScopePortV1
  readonly checkpointIdFactory?: () => string
}): void {
  const checkpointIdFactory = options.checkpointIdFactory
    ?? (() => `checkpoint_${randomUUID()}`)

  registerHandler('ipc:xiaogui.coding.checkpoint.list', async (payload): Promise<CodingCheckpointListOutcomeV1> => {
    const parsed = CaptureSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const request = parsed.data as CodingCheckpointListRequestV1
    const address = request.address as HubAddressV1
    if (!(await inScope(options.scope, address, request.attemptId))) return failure('SESSION_SCOPE_MISMATCH')
    if (!options.checkpoint) return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
    try {
      return success({
        checkpoints: options.checkpoint.list(request.attemptId).map(publicCheckpoint),
      })
    } catch {
      return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
    }
  })

  registerHandler('ipc:xiaogui.coding.checkpoint.capture', async (payload): Promise<CodingCheckpointCaptureOutcomeV1> => {
    const parsed = CaptureSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const request = parsed.data as CodingCheckpointCaptureRequestV1
    const address = request.address as HubAddressV1
    if (!(await inScope(options.scope, address, request.attemptId))) return failure('SESSION_SCOPE_MISMATCH')
    if (!options.checkpoint) return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
    let checkpointId: string
    try {
      checkpointId = checkpointIdFactory()
      if (!SafeIdSchema.safeParse(checkpointId).success) return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
      const result = await options.checkpoint.capture({
        attemptId: request.attemptId,
        checkpointId,
      })
      if (!result.ok) return mappedFailure(result.error.code)
      return success({ checkpoint: publicCheckpoint(result.checkpoint) })
    } catch {
      return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
    }
  })

  registerHandler('ipc:xiaogui.coding.checkpoint.restore.preview', async (payload): Promise<CodingCheckpointPreviewOutcomeV1> => {
    const parsed = PreviewSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const request = parsed.data as CodingCheckpointPreviewRequestV1
    const address = request.address as HubAddressV1
    if (!(await inScope(options.scope, address, request.attemptId))) return failure('SESSION_SCOPE_MISMATCH')
    if (!options.checkpoint) return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
    try {
      const result = await options.checkpoint.prepareRestore({
        attemptId: request.attemptId,
        checkpointId: request.checkpointId,
      })
      if (!result.ok) return mappedFailure(result.error.code)
      return success({ preview: publicPreview(result.preview) })
    } catch {
      return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
    }
  })

  registerHandler('ipc:xiaogui.coding.checkpoint.restore.confirm', async (payload): Promise<CodingCheckpointConfirmOutcomeV1> => {
    const parsed = ConfirmSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const request = parsed.data as CodingCheckpointConfirmRequestV1
    const address = request.address as HubAddressV1
    if (!(await inScope(options.scope, address, request.attemptId))) return failure('SESSION_SCOPE_MISMATCH')
    if (!options.checkpoint) return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
    try {
      const result = await options.checkpoint.restore({
        attemptId: request.attemptId,
        checkpointId: request.checkpointId,
        previewId: request.previewId,
        previewDigest: request.previewDigest,
      })
      if (!result.ok) return mappedFailure(result.error.code)
      return success({
        outcome: 'RESTORED' as const,
        checkpoint: publicCheckpoint(result.checkpoint),
      })
    } catch {
      return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
    }
  })
}

async function inScope(scope: CodingCheckpointScopePortV1, address: HubAddressV1, attemptId: string): Promise<boolean> {
  try {
    if (!(await scope.isCodingSession(address))) return false
    return await scope.hasAttempt(address, attemptId)
  } catch {
    return false
  }
}

function publicCheckpoint(checkpoint: CodingCheckpointV1): CodingCheckpointSummaryV1 {
  return Object.freeze({
    schemaVersion: 1,
    checkpointId: checkpoint.checkpointId,
    attemptId: checkpoint.attemptId,
    status: checkpoint.status,
  })
}

function publicPreview(
  preview: CodingCheckpointRestorePreviewProjectionV1,
): CodingCheckpointRestorePreviewProjectionV1 {
  return Object.freeze({
    schemaVersion: 1,
    previewId: preview.previewId,
    checkpointId: preview.checkpointId,
    attemptId: preview.attemptId,
    changedRelativePaths: Object.freeze([...preview.changedRelativePaths]),
    changeCount: preview.changeCount,
    truncated: preview.truncated,
    sessionImpact: preview.sessionImpact,
    previewDigest: preview.previewDigest,
    expiresAt: preview.expiresAt,
  })
}

function success<T extends object>(value: T) {
  return {
    ok: true as const,
    value: {
      contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
      ...value,
    },
  }
}

function mappedFailure(code: CodingCheckpointErrorCodeV1) {
  switch (code) {
    case 'ATTEMPT_NOT_FOUND':
    case 'BINDING_MISMATCH':
      return failure('SESSION_SCOPE_MISMATCH')
    case 'ATTEMPT_BUSY':
      return failure('ATTEMPT_BUSY')
    case 'CHECKPOINT_CONFLICT':
      return failure('CHECKPOINT_CONFLICT')
    case 'CHECKPOINT_NOT_FOUND':
      return failure('CHECKPOINT_NOT_FOUND')
    case 'CHECKPOINT_UNAVAILABLE':
      return failure('CHECKPOINT_UNAVAILABLE')
    case 'PREVIEW_NOT_FOUND':
      return failure('PREVIEW_NOT_FOUND')
    case 'PREVIEW_EXPIRED':
      return failure('PREVIEW_EXPIRED')
    case 'PREVIEW_DIGEST_MISMATCH':
      return failure('PREVIEW_DIGEST_MISMATCH')
    case 'PREVIEW_STALE':
      return failure('PREVIEW_STALE')
    case 'RESTORE_FAILED':
      return failure('RESTORE_FAILED')
    case 'OUTCOME_UNKNOWN':
      return failure('OUTCOME_UNKNOWN')
    case 'ATTEMPT_UNAVAILABLE':
    case 'CAPTURE_FAILED':
    case 'PREVIEW_FAILED':
      return failure('CHECKPOINT_RUNTIME_UNAVAILABLE')
  }
}

function failure(code: CodingCheckpointControlErrorCodeV1) {
  return {
    ok: false as const,
    error: {
      code,
      messageKey: `xiaogui.coding.checkpoint.${code.toLowerCase()}`,
    },
  }
}
