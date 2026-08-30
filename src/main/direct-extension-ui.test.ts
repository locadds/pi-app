import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import {
  __test,
  cancelDirectExtensionUI,
  hasPendingDirectExtensionUI,
  requestDirectExtensionUI,
  respondDirectExtensionUI,
} from './direct-extension-ui'

class FakeWindow extends EventEmitter {
  destroyed = false
  webContents = { send: vi.fn() }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

describe('direct extension UI bridge', () => {
  it('发送带直接来源的复核请求，并由 renderer 回包结束等待', async () => {
    const win = new FakeWindow()
    const resultPromise = requestDirectExtensionUI(win as unknown as BrowserWindow, {
      method: 'custom',
      kind: 'template_intake_review',
      payload: { reviewVersion: 2 },
    })

    const request = win.webContents.send.mock.calls[0][1]
    expect(request).toMatchObject({
      method: 'custom',
      kind: 'template_intake_review',
      origin: 'xiaogui-direct',
    })
    expect(__test.pendingCount()).toBe(1)
    expect(hasPendingDirectExtensionUI()).toBe(true)

    expect(respondDirectExtensionUI({ id: request.id, result: { cancelled: false } })).toBe(true)
    await expect(resultPromise).resolves.toEqual({
      id: request.id,
      result: { cancelled: false },
    })
    expect(__test.pendingCount()).toBe(0)
    expect(hasPendingDirectExtensionUI()).toBe(false)
  })

  it('取消直接复核时只结束对应请求', async () => {
    const win = new FakeWindow()
    const resultPromise = requestDirectExtensionUI(win as unknown as BrowserWindow, {
      method: 'custom',
      kind: 'template_intake_review',
    })
    const request = win.webContents.send.mock.calls[0][1]

    expect(cancelDirectExtensionUI(request.id)).toBe(true)
    await expect(resultPromise).resolves.toEqual({ id: request.id, cancelled: true })
    expect(__test.pendingCount()).toBe(0)
  })
})
