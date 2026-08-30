import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  navigateToModeHome: vi.fn(),
  refreshWorkspaceSessionLists: vi.fn(async () => {}),
}))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: mocks.invoke },
}))
vi.mock('@renderer/xiaogui/lib/navigate-mode-home', () => ({
  navigateToModeHome: mocks.navigateToModeHome,
}))
vi.mock('@renderer/lib/refresh-workspace-session-lists', () => ({
  refreshWorkspaceSessionLists: mocks.refreshWorkspaceSessionLists,
}))

import { useXiaoguiStore } from './xiaogui-store'

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.navigateToModeHome.mockReset()
  mocks.refreshWorkspaceSessionLists.mockReset().mockResolvedValue(undefined)
  useXiaoguiStore.setState({ mode: 'WORK' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useXiaoguiStore.switchMode', () => {
  it('returns true only for an acknowledged matching target mode', async () => {
    mocks.invoke.mockResolvedValue({ ok: true, mode: 'CODING' })

    await expect(useXiaoguiStore.getState().switchMode('CODING')).resolves.toBe(true)
    expect(useXiaoguiStore.getState().mode).toBe('CODING')
    expect(mocks.invoke).toHaveBeenCalledOnce()
  })

  it.each([
    ['an unacknowledged response', { ok: false, mode: 'CODING' }],
    ['a mismatched mode', { ok: true, mode: 'DESIGN' }],
  ])('returns false and restores the real mode for %s', async (_label, response) => {
    mocks.invoke.mockImplementation((method: string) =>
      Promise.resolve(method === 'xiaogui.mode.switch' ? response : { mode: 'WORK' }),
    )

    await expect(useXiaoguiStore.getState().switchMode('CODING')).resolves.toBe(false)
    expect(useXiaoguiStore.getState().mode).toBe('WORK')
  })

  it('waits for the real mode to be restored and returns false after IPC failure', async () => {
    let resolveModeGet!: (value: { mode: 'WORK' }) => void
    const modeGet = new Promise<{ mode: 'WORK' }>((resolve) => {
      resolveModeGet = resolve
    })
    mocks.invoke.mockImplementation((method: string) => {
      if (method === 'xiaogui.mode.switch') return Promise.reject(new Error('ipc unavailable'))
      if (method === 'xiaogui.mode.get') return modeGet
      return Promise.resolve({})
    })

    let settled = false
    const resultPromise = useXiaoguiStore.getState().switchMode('CODING')
    void resultPromise.then(() => {
      settled = true
    })

    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('xiaogui.mode.get')
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveModeGet({ mode: 'WORK' })
    await expect(resultPromise).resolves.toBe(false)
    expect(useXiaoguiStore.getState().mode).toBe('WORK')
  })
})
