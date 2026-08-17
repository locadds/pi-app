import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsDraft } from './settings-draft'
import { RuntimeSettingsPanel } from './runtime-settings-panel'

const setAgentRuntime = vi.fn()
const setXiaoguiKimiProductionEnabled = vi.fn()

let draft: Pick<SettingsDraft, 'agentRuntime' | 'xiaoguiKimiProductionEnabled'>

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn() },
}))

vi.mock('./settings-draft-context', () => ({
  useSettingsDraft: () => ({
    draft,
    setAgentRuntime,
    setXiaoguiKimiProductionEnabled,
  }),
}))

describe('RuntimeSettingsPanel Kimi task execution setting', () => {
  beforeEach(() => {
    draft = {
      agentRuntime: { mode: 'host', distro: null },
      xiaoguiKimiProductionEnabled: false,
    }
    setAgentRuntime.mockReset()
    setXiaoguiKimiProductionEnabled.mockReset()
    window.piDesktop = { platform: 'linux' } as Window['piDesktop']
  })

  afterEach(() => cleanup())

  it('does not change the draft until enablement is confirmed', () => {
    render(<RuntimeSettingsPanel />)

    fireEvent.click(screen.getByRole('switch'))
    expect(setXiaoguiKimiProductionEnabled).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'settings:runtime.xiaoguiKimiEnableConfirmMessage',
    )

    fireEvent.click(screen.getByRole('button', { name: 'common:cancel' }))
    expect(setXiaoguiKimiProductionEnabled).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByRole('button', { name: 'common:confirm' }))
    expect(setXiaoguiKimiProductionEnabled).toHaveBeenCalledOnce()
    expect(setXiaoguiKimiProductionEnabled).toHaveBeenCalledWith(true)
  })

  it('disables immediately without confirmation', () => {
    draft.xiaoguiKimiProductionEnabled = true
    render(<RuntimeSettingsPanel />)

    fireEvent.click(screen.getByRole('switch'))

    expect(setXiaoguiKimiProductionEnabled).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
