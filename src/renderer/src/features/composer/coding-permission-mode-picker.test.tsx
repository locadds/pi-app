import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcClient } from '@renderer/lib/ipc-client'
import { CodingPermissionModePicker } from './coding-permission-mode-picker'

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

beforeEach(() => {
  vi.mocked(ipcClient.invoke).mockReset()
})

afterEach(() => cleanup())

describe('CodingPermissionModePicker', () => {
  it('renders the direct-session three choices and saves the selection', async () => {
    vi.mocked(ipcClient.invoke)
      .mockResolvedValueOnce({ settings: { xiaoguiCodingPermissionMode: 'CONFIRM_EACH' } })
      .mockResolvedValueOnce({ key: 'xiaoguiCodingPermissionMode', value: 'AUTO_APPROVE' })

    render(<CodingPermissionModePicker disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: /逐条确认/ }))

    expect(screen.getByRole('menu', { name: 'permissionMode.title' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /逐条确认/ })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /^自动通过/ })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /^完全自主/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /^自动通过/ }))
    await waitFor(() => expect(ipcClient.invoke).toHaveBeenCalledWith('settings.set', {
      key: 'xiaoguiCodingPermissionMode',
      value: 'AUTO_APPROVE',
    }))
    expect(await screen.findByRole('button', { name: /自动通过/ })).toBeTruthy()
  })

  it('cannot be changed while the current turn is active', async () => {
    vi.mocked(ipcClient.invoke).mockResolvedValue({
      settings: { xiaoguiCodingPermissionMode: 'FULL_AUTONOMY' },
    })
    render(<CodingPermissionModePicker disabled />)

    const button = await screen.findByRole('button', { name: /完全自主/ })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(vi.mocked(ipcClient.invoke).mock.calls.filter(([name]) => name === 'settings.set')).toEqual([])
  })
})
