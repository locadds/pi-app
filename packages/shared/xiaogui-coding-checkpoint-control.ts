import type { HubAddressV1 } from './xiaogui-collaboration-hub'

export const XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1 =
  'xiaogui.coding-checkpoint-control.v1' as const

export const XIAOGUI_CODING_CHECKPOINT_SESSION_IMPACT_V1 =
  '对话将回到此检查点' as const

export type CodingCheckpointPublicStatusV1 = 'AVAILABLE' | 'RESTORED' | 'INVALIDATED'

/** Renderer-safe checkpoint identity. All private state digests remain in Main. */
export interface CodingCheckpointSummaryV1 {
  readonly schemaVersion: 1
  readonly checkpointId: string
  readonly attemptId: string
  readonly status: CodingCheckpointPublicStatusV1
}

/**
 * Renderer-safe restore preview. `previewDigest` is an opaque, one-time
 * confirmation token; it must not be interpreted as a public state digest.
 */
export interface CodingCheckpointRestorePreviewProjectionV1 {
  readonly schemaVersion: 1
  readonly previewId: string
  readonly checkpointId: string
  readonly attemptId: string
  readonly changedRelativePaths: readonly string[]
  readonly changeCount: number
  readonly truncated: boolean
  readonly sessionImpact: typeof XIAOGUI_CODING_CHECKPOINT_SESSION_IMPACT_V1
  readonly previewDigest: string
  readonly expiresAt: number
}

export interface CodingCheckpointCaptureRequestV1 {
  readonly contractVersion: typeof XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1
  readonly address: HubAddressV1
  readonly attemptId: string
}

export type CodingCheckpointListRequestV1 = CodingCheckpointCaptureRequestV1

export interface CodingCheckpointPreviewRequestV1 {
  readonly contractVersion: typeof XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1
  readonly address: HubAddressV1
  readonly attemptId: string
  readonly checkpointId: string
}

export interface CodingCheckpointConfirmRequestV1 extends CodingCheckpointPreviewRequestV1 {
  readonly previewId: string
  readonly previewDigest: string
}

export type CodingCheckpointControlErrorCodeV1 =
  | 'INVALID_REQUEST'
  | 'SESSION_SCOPE_MISMATCH'
  | 'CHECKPOINT_RUNTIME_UNAVAILABLE'
  | 'ATTEMPT_BUSY'
  | 'CHECKPOINT_CONFLICT'
  | 'CHECKPOINT_NOT_FOUND'
  | 'CHECKPOINT_UNAVAILABLE'
  | 'PREVIEW_NOT_FOUND'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_DIGEST_MISMATCH'
  | 'PREVIEW_STALE'
  | 'RESTORE_FAILED'
  | 'OUTCOME_UNKNOWN'

export interface CodingCheckpointControlErrorV1 {
  readonly code: CodingCheckpointControlErrorCodeV1
  readonly messageKey: string
}

export type CodingCheckpointCaptureOutcomeV1 =
  | {
      readonly ok: true
      readonly value: {
        readonly contractVersion: typeof XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1
        readonly checkpoint: CodingCheckpointSummaryV1
      }
    }
  | { readonly ok: false; readonly error: CodingCheckpointControlErrorV1 }

export type CodingCheckpointListOutcomeV1 =
  | {
      readonly ok: true
      readonly value: {
        readonly contractVersion: typeof XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1
        readonly checkpoints: readonly CodingCheckpointSummaryV1[]
      }
    }
  | { readonly ok: false; readonly error: CodingCheckpointControlErrorV1 }

export type CodingCheckpointPreviewOutcomeV1 =
  | {
      readonly ok: true
      readonly value: {
        readonly contractVersion: typeof XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1
        readonly preview: CodingCheckpointRestorePreviewProjectionV1
      }
    }
  | { readonly ok: false; readonly error: CodingCheckpointControlErrorV1 }

export type CodingCheckpointConfirmOutcomeV1 =
  | {
      readonly ok: true
      readonly value: {
        readonly contractVersion: typeof XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1
        readonly outcome: 'RESTORED'
        readonly checkpoint: CodingCheckpointSummaryV1
      }
    }
  | { readonly ok: false; readonly error: CodingCheckpointControlErrorV1 }
