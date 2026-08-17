import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeRuntimeComposition: vi.fn(),
  registerCollaborationHubHandlers: vi.fn(),
  registerWorkDocxHandlers: vi.fn(),
  registerXiaoguiHandlers: vi.fn(),
  shutdownSidecar: vi.fn(),
}))

vi.mock('./ipc-handlers', () => ({
  registerXiaoguiHandlers: mocks.registerXiaoguiHandlers,
}))

vi.mock('./sidecar-bridge', () => ({
  xiaogui: { shutdown: mocks.shutdownSidecar },
}))

vi.mock('./task-hub/ipc', () => ({
  closeDefaultCollaborationHubRuntimeComposition: mocks.closeRuntimeComposition,
  registerCollaborationHubHandlers: mocks.registerCollaborationHubHandlers,
}))

vi.mock('./work-docx-ipc', () => ({
  registerWorkDocxHandlers: mocks.registerWorkDocxHandlers,
}))

import { shutdownXiaoguiSidecar } from './index'

afterEach(() => {
  vi.clearAllMocks()
})

describe('xiaogui shutdown lifecycle', () => {
  it('starts both owned shutdowns and waits until both have settled', async () => {
    const sidecar = deferred<void>()
    const runtime = deferred<void>()
    mocks.shutdownSidecar.mockReturnValueOnce(sidecar.promise)
    mocks.closeRuntimeComposition.mockReturnValueOnce(runtime.promise)

    let settled = false
    const shutdown = shutdownXiaoguiSidecar().then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(mocks.shutdownSidecar).toHaveBeenCalledOnce()
    expect(mocks.closeRuntimeComposition).toHaveBeenCalledOnce()

    sidecar.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    runtime.resolve()
    await shutdown
    expect(settled).toBe(true)
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
