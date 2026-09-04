import { BrowserWindow } from 'electron'

import type {
  DirectCodingPermissionChoiceV2,
  DirectCodingPermissionPromptV2,
} from '@shared/xiaogui-direct-coding'
import { requestDirectExtensionUI } from '../../direct-extension-ui'

export interface DirectCodingPermissionUIPortV2 {
  request(prompt: DirectCodingPermissionPromptV2): Promise<DirectCodingPermissionChoiceV2>
}

const DEFAULT_TIMEOUT_MS = 60_000

/** Renderer Adapter only. Policy and path authority remain in the deep Module. */
export class MainProcessDirectCodingPermissionUIAdapterV2
  implements DirectCodingPermissionUIPortV2 {
  constructor(
    private readonly options: {
      readonly timeoutMs?: number
      readonly windowProvider?: () => BrowserWindow | undefined
    } = {},
  ) {}

  async request(prompt: DirectCodingPermissionPromptV2): Promise<DirectCodingPermissionChoiceV2> {
    const win = this.options.windowProvider?.()
      ?? BrowserWindow.getFocusedWindow()
      ?? BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return 'DENY'
    const response = await requestDirectExtensionUI(
      win,
      { method: 'custom', kind: 'coding_permission', payload: prompt },
      { timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    )
    if (response.cancelled) return 'DENY'
    return (response.result as { choice?: unknown } | undefined)?.choice === 'ALLOW_ONCE'
      ? 'ALLOW_ONCE'
      : 'DENY'
  }
}
