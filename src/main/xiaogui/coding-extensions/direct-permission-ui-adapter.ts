import type { BrowserWindow } from 'electron'

import type {
  DirectCodingPermissionChoiceV2,
  DirectCodingPermissionOriginV3,
  DirectCodingPermissionPromptV3,
  DirectCodingPermissionResponseV3,
} from '@shared/xiaogui-direct-coding'
import { requestDirectExtensionUI } from '../../direct-extension-ui'

export interface DirectCodingPermissionUIPortV3 {
  request(
    prompt: DirectCodingPermissionPromptV3,
    origin: DirectCodingPermissionOriginV3,
  ): Promise<DirectCodingPermissionChoiceV2>
}

const DEFAULT_TIMEOUT_MS = 60_000

/** Renderer Adapter only. Policy and path authority remain in the deep Module. */
export class MainProcessDirectCodingPermissionUIAdapterV3
  implements DirectCodingPermissionUIPortV3 {
  constructor(
    private readonly options: {
      readonly timeoutMs?: number
      readonly windowProvider: (origin: DirectCodingPermissionOriginV3) => BrowserWindow | undefined
    },
  ) {}

  async request(
    prompt: DirectCodingPermissionPromptV3,
    origin: DirectCodingPermissionOriginV3,
  ): Promise<DirectCodingPermissionChoiceV2> {
    const win = this.options.windowProvider(origin)
    if (!win || win.isDestroyed()) return 'DENY'
    const response = await requestDirectExtensionUI(
      win,
      { method: 'custom', kind: 'coding_permission', payload: prompt },
      { timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    )
    if (response.cancelled) return 'DENY'
    const result = response.result as DirectCodingPermissionResponseV3 | undefined
    return result?.choice === 'ALLOW_ONCE'
      && result.requestDigest === prompt.requestDigest
      && result.originDigest === prompt.originDigest
      ? 'ALLOW_ONCE'
      : 'DENY'
  }
}
