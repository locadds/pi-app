import { BrowserWindow } from 'electron'

import type {
  CodingPermissionPromptV1,
  CodingPermissionUserChoiceV1,
} from '@shared/xiaogui-coding-extension-pack'
import { requestDirectExtensionUI } from '../../direct-extension-ui'
import type { CodingPermissionUIPortV1 } from './permission-module'

const DEFAULT_PERMISSION_UI_TIMEOUT_MS = 60_000

export class MainProcessCodingPermissionUIAdapterV1 implements CodingPermissionUIPortV1 {
  constructor(
    private readonly options: {
      readonly timeoutMs?: number
      readonly windowProvider?: () => BrowserWindow | undefined
    } = {},
  ) {}

  async request(prompt: CodingPermissionPromptV1): Promise<CodingPermissionUserChoiceV1> {
    const win = this.options.windowProvider?.()
      ?? BrowserWindow.getFocusedWindow()
      ?? BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return 'DENY'
    const response = await requestDirectExtensionUI(
      win,
      { method: 'custom', kind: 'coding_permission', payload: prompt },
      { timeoutMs: this.options.timeoutMs ?? DEFAULT_PERMISSION_UI_TIMEOUT_MS },
    )
    if (response.cancelled) return 'DENY'
    const choice = (response.result as { choice?: unknown } | undefined)?.choice
    return choice === 'ALLOW_ONCE' || choice === 'ALLOW_TASK_RULE' || choice === 'DENY'
      ? choice
      : 'DENY'
  }
}
