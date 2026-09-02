import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import {
  XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
  type CodingCheckpointCaptureOutcomeV1,
  type CodingCheckpointConfirmOutcomeV1,
  type CodingCheckpointControlErrorCodeV1,
  type CodingCheckpointPreviewOutcomeV1,
  type CodingCheckpointListOutcomeV1,
} from '@shared/xiaogui-coding-checkpoint-control'

import { ipcClient } from '@renderer/lib/ipc-client'

export interface CodingCheckpointSummaryUiV1 {
  /** Opaque request value; never render it. */
  readonly checkpointRef: string
  readonly status: 'AVAILABLE' | 'RESTORED' | 'INVALIDATED'
}

export interface CodingCheckpointRestorePreviewUiV1 {
  /** Opaque confirmation values; never render them. */
  readonly previewRef: string
  readonly previewDigest: string
  readonly checkpointRef: string
  readonly expiresAt: string
  readonly impact: {
    readonly changedRelativePaths: readonly string[]
    readonly workspaceChangeCount: number
    readonly sessionEffect: string
    readonly warning: string
  }
}

export type CodingCheckpointUiOutcomeV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: 'CHECKPOINT_UNAVAILABLE' | 'PREVIEW_STALE' | 'RESTORE_FAILED' | 'OUTCOME_UNKNOWN' }

export interface CodingCheckpointClientPortV1 {
  readonly availability:
    | { readonly available: true }
    | { readonly available: false; readonly reason: 'IPC_UNREGISTERED' | 'IMPACT_SUMMARY_UNAVAILABLE' }
  capture(address: HubAddressV1, attemptId: string): Promise<CodingCheckpointUiOutcomeV1<CodingCheckpointSummaryUiV1>>
  list(address: HubAddressV1, attemptId: string): Promise<CodingCheckpointUiOutcomeV1<readonly CodingCheckpointSummaryUiV1[]>>
  prepareRestore(
    address: HubAddressV1,
    attemptId: string,
    checkpointRef: string,
  ): Promise<CodingCheckpointUiOutcomeV1<CodingCheckpointRestorePreviewUiV1>>
  confirmRestore(
    address: HubAddressV1,
    attemptId: string,
    preview: CodingCheckpointRestorePreviewUiV1,
  ): Promise<CodingCheckpointUiOutcomeV1<CodingCheckpointSummaryUiV1>>
}

export const codingCheckpointClient: CodingCheckpointClientPortV1 = Object.freeze({
  availability: Object.freeze({ available: true as const }),
  async list(
    address: HubAddressV1,
    attemptId: string,
  ): Promise<CodingCheckpointUiOutcomeV1<readonly CodingCheckpointSummaryUiV1[]>> {
    try {
      const outcome = await ipcClient.invoke('xiaogui.coding.checkpoint.list', {
        contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
        address,
        attemptId,
      }) as CodingCheckpointListOutcomeV1
      if (!outcome.ok) return uiFailure(outcome.error.code)
      return {
        ok: true,
        value: outcome.value.checkpoints.map((checkpoint) => ({
          checkpointRef: checkpoint.checkpointId,
          status: checkpoint.status,
        })),
      }
    } catch {
      return { ok: false, error: 'CHECKPOINT_UNAVAILABLE' }
    }
  },
  async capture(
    address: HubAddressV1,
    attemptId: string,
  ): Promise<CodingCheckpointUiOutcomeV1<CodingCheckpointSummaryUiV1>> {
    try {
      const outcome = await ipcClient.invoke('xiaogui.coding.checkpoint.capture', {
        contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
        address,
        attemptId,
      }) as CodingCheckpointCaptureOutcomeV1
      if (!outcome.ok) return uiFailure(outcome.error.code)
      return {
        ok: true,
        value: {
          checkpointRef: outcome.value.checkpoint.checkpointId,
          status: outcome.value.checkpoint.status,
        },
      }
    } catch {
      return { ok: false, error: 'CHECKPOINT_UNAVAILABLE' }
    }
  },
  async prepareRestore(
    address: HubAddressV1,
    attemptId: string,
    checkpointRef: string,
  ): Promise<CodingCheckpointUiOutcomeV1<CodingCheckpointRestorePreviewUiV1>> {
    try {
      const outcome = await ipcClient.invoke('xiaogui.coding.checkpoint.restore.preview', {
        contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
        address,
        attemptId,
        checkpointId: checkpointRef,
      }) as CodingCheckpointPreviewOutcomeV1
      if (!outcome.ok) return uiFailure(outcome.error.code)
      const preview = outcome.value.preview
      return {
        ok: true,
        value: {
          previewRef: preview.previewId,
          previewDigest: preview.previewDigest,
          checkpointRef: preview.checkpointId,
          expiresAt: new Date(preview.expiresAt).toISOString(),
          impact: {
            changedRelativePaths: [...preview.changedRelativePaths],
            workspaceChangeCount: preview.changeCount,
            sessionEffect: preview.sessionImpact,
            warning: preview.truncated
              ? '仅显示部分受影响文件；确认后仍会恢复全部变更。'
              : '检查点之后尚未交付的修改将被撤销。',
          },
        },
      }
    } catch {
      return { ok: false, error: 'CHECKPOINT_UNAVAILABLE' }
    }
  },
  async confirmRestore(
    address: HubAddressV1,
    attemptId: string,
    preview: CodingCheckpointRestorePreviewUiV1,
  ): Promise<CodingCheckpointUiOutcomeV1<CodingCheckpointSummaryUiV1>> {
    try {
      const outcome = await ipcClient.invoke('xiaogui.coding.checkpoint.restore.confirm', {
        contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
        address,
        attemptId,
        checkpointId: preview.checkpointRef,
        previewId: preview.previewRef,
        previewDigest: preview.previewDigest,
      }) as CodingCheckpointConfirmOutcomeV1
      if (!outcome.ok) return uiFailure(outcome.error.code)
      return {
        ok: true,
        value: {
          checkpointRef: outcome.value.checkpoint.checkpointId,
          status: outcome.value.checkpoint.status,
        },
      }
    } catch {
      return { ok: false, error: 'CHECKPOINT_UNAVAILABLE' }
    }
  },
})

function uiFailure(code: CodingCheckpointControlErrorCodeV1): CodingCheckpointUiOutcomeV1<never> {
  if (code === 'PREVIEW_STALE' || code === 'PREVIEW_EXPIRED' || code === 'PREVIEW_DIGEST_MISMATCH') {
    return { ok: false, error: 'PREVIEW_STALE' }
  }
  if (code === 'OUTCOME_UNKNOWN') return { ok: false, error: 'OUTCOME_UNKNOWN' }
  if (code === 'RESTORE_FAILED') return { ok: false, error: 'RESTORE_FAILED' }
  return { ok: false, error: 'CHECKPOINT_UNAVAILABLE' }
}
