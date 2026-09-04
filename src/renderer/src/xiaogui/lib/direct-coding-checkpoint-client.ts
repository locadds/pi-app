import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import {
  XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2,
  type DirectCodingCheckpointConfirmOutcomeV2,
  type DirectCodingCheckpointListOutcomeV2,
  type DirectCodingCheckpointPreviewOutcomeV2,
  type DirectCodingFileCheckpointV2,
  type DirectCodingCheckpointRestorePreviewV2,
} from '@shared/xiaogui-direct-coding'
import { ipcClient } from '@renderer/lib/ipc-client'

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string }

export const directCodingCheckpointClientV2 = Object.freeze({
  async list(address: SessionAddressV1): Promise<Outcome<readonly DirectCodingFileCheckpointV2[]>> {
    try {
      const outcome = await ipcClient.invoke('xiaogui.coding.direct.checkpoint.list', {
        contractVersion: XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2,
        address,
      }) as DirectCodingCheckpointListOutcomeV2
      return outcome.ok ? { ok: true, value: outcome.value.checkpoints } : { ok: false, error: outcome.error.code }
    } catch {
      return { ok: false, error: 'CHECKPOINT_RUNTIME_UNAVAILABLE' }
    }
  },
  async preview(address: SessionAddressV1, checkpointToken: string): Promise<Outcome<DirectCodingCheckpointRestorePreviewV2>> {
    try {
      const outcome = await ipcClient.invoke('xiaogui.coding.direct.checkpoint.restore.preview', {
        contractVersion: XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2,
        address,
        checkpointToken,
      }) as DirectCodingCheckpointPreviewOutcomeV2
      return outcome.ok ? { ok: true, value: outcome.value.preview } : { ok: false, error: outcome.error.code }
    } catch {
      return { ok: false, error: 'CHECKPOINT_RUNTIME_UNAVAILABLE' }
    }
  },
  async confirm(address: SessionAddressV1, preview: DirectCodingCheckpointRestorePreviewV2): Promise<Outcome<DirectCodingFileCheckpointV2>> {
    try {
      const outcome = await ipcClient.invoke('xiaogui.coding.direct.checkpoint.restore.confirm', {
        contractVersion: XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2,
        address,
        checkpointToken: preview.checkpointToken,
        previewToken: preview.previewToken,
        previewDigest: preview.previewDigest,
      }) as DirectCodingCheckpointConfirmOutcomeV2
      return outcome.ok ? { ok: true, value: outcome.value.checkpoint } : { ok: false, error: outcome.error.code }
    } catch {
      return { ok: false, error: 'CHECKPOINT_RUNTIME_UNAVAILABLE' }
    }
  },
})
