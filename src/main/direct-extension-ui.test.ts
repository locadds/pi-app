import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import {
  __test,
  cancelDirectExtensionUI,
  cancelDirectExtensionUIForSource,
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

  it('直接请求超时后取消并清理 pending，避免权限请求悬挂', async () => {
    vi.useFakeTimers()
    const win = new FakeWindow()
    const resultPromise = requestDirectExtensionUI(
      win as unknown as BrowserWindow,
      { method: 'custom', kind: 'coding_permission' },
      { timeoutMs: 50 },
    )

    await vi.advanceTimersByTimeAsync(60)
    await expect(resultPromise).resolves.toMatchObject({ cancelled: true, reason: 'timeout' })
    expect(__test.pendingCount()).toBe(0)
    expect(win.webContents.send).toHaveBeenLastCalledWith('ipc:extension-ui-dismiss', {
      type: 'extension-ui-dismiss',
      id: expect.any(String),
      reason: 'timeout',
    })
    vi.useRealTimers()
  })

  it('超时通知发送失败时仍先清理 pending 和窗口监听器', async () => {
    vi.useFakeTimers()
    const win = new FakeWindow()
    win.webContents.send
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('renderer gone') })
    const resultPromise = requestDirectExtensionUI(
      win as unknown as BrowserWindow,
      { method: 'custom', kind: 'coding_permission' },
      { timeoutMs: 50 },
    )

    await vi.advanceTimersByTimeAsync(60)
    await expect(resultPromise).resolves.toMatchObject({ cancelled: true, reason: 'timeout' })
    expect(__test.pendingCount()).toBe(0)
    expect(win.listenerCount('closed')).toBe(0)
    vi.useRealTimers()
  })

  it('来源 Worker 结束时只关闭该来源请求，不影响其他来源队列', async () => {
    const win = new FakeWindow()
    const sourceA = requestDirectExtensionUI(
      win as unknown as BrowserWindow,
      { method: 'custom', kind: 'coding_permission' },
      { source: { poolKey: 'pool-a', sessionId: 'session-a' } },
    )
    const sourceB = requestDirectExtensionUI(
      win as unknown as BrowserWindow,
      { method: 'custom', kind: 'coding_permission' },
      { source: { poolKey: 'pool-b', sessionId: 'session-b' } },
    )
    const requestB = win.webContents.send.mock.calls[1][1]

    expect(cancelDirectExtensionUIForSource('pool-a', 'session-a')).toBe(1)
    await expect(sourceA).resolves.toMatchObject({ cancelled: true, reason: 'source-ended' })
    expect(__test.pendingCount()).toBe(1)
    expect(respondDirectExtensionUI({ id: requestB.id, result: { choice: 'DENY' } })).toBe(true)
    await expect(sourceB).resolves.toMatchObject({ id: requestB.id })
    expect(__test.pendingCount()).toBe(0)
  })
})
