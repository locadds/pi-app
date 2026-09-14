import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsDraft } from './settings-draft'
import { RuntimeSettingsPanel } from './runtime-settings-panel'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
const setAgentRuntime = vi.fn()

let draft: Pick<SettingsDraft, 'agentRuntime'>

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: mocks.invoke },
}))

vi.mock('./settings-draft-context', () => ({
  useSettingsDraft: () => ({
    draft,
    setAgentRuntime,
  }),
}))

describe('RuntimeSettingsPanel', () => {
  beforeEach(() => {
    draft = {
      agentRuntime: { mode: 'host', distro: null },
    }
    setAgentRuntime.mockReset()
    mocks.invoke.mockReset()
    window.piDesktop = { platform: 'linux' } as Window['piDesktop']
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('keeps agent runtime settings without a Kimi task execution entry', () => {
    render(<RuntimeSettingsPanel />)
    expect(screen.getByText('settings:runtime.sectionAgentRuntime')).toBeInTheDocument()
    expect(screen.queryByText('settings:runtime.sectionXiaoguiTaskExecution')).not.toBeInTheDocument()
    expect(screen.queryByText('settings:runtime.xiaoguiKimiProductionEnabled')).not.toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalledWith('xiaogui.kimi.status', {})
  })
})
