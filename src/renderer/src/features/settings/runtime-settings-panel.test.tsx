import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { XiaoguiKimiRuntimeStatusSnapshotV1, XiaoguiKimiRuntimeStatusV1 } from '@shared/xiaogui-kimi-runtime'
import type { SettingsDraft } from './settings-draft'
import { RuntimeSettingsPanel } from './runtime-settings-panel'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
const setAgentRuntime = vi.fn()
const setXiaoguiKimiProductionEnabled = vi.fn()

let draft: Pick<SettingsDraft, 'agentRuntime' | 'xiaoguiKimiProductionEnabled'>

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings:runtime.xiaoguiKimiStatusDisabled': '当前未启用。保存启用设置并重启小规后生效。',
        'settings:runtime.xiaoguiKimiStatusCliNotFound': '未发现 Kimi 命令行工具。',
        'settings:runtime.xiaoguiKimiStatusVersionUnapproved': 'Kimi 命令行工具版本不符合要求。',
        'settings:runtime.xiaoguiKimiStatusLoginRequired': '需要登录。',
        'settings:runtime.xiaoguiKimiStatusCredentialPresent': '已发现本地凭据（执行时验证）。',
        'settings:runtime.xiaoguiKimiStatusLoginInProgress': '正在登录。请在打开的终端中完成操作。',
        'settings:runtime.xiaoguiKimiStatusUnavailable': '状态暂不可用。',
        'settings:runtime.xiaoguiKimiStatusRefresh': '刷新状态',
        'settings:runtime.xiaoguiKimiLogin': '登录',
        'settings:runtime.xiaoguiKimiRelogin': '重新登录',
        'settings:runtime.xiaoguiKimiLoginInProgress': '正在登录',
      })[key] ?? key,
  }),
}))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: mocks.invoke },
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
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue(kimiStatus('DISABLED'))
    window.piDesktop = { platform: 'linux' } as Window['piDesktop']
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('does not change the draft until enablement is confirmed', async () => {
    render(<RuntimeSettingsPanel />)
    await screen.findByText('当前未启用。保存启用设置并重启小规后生效。')

    fireEvent.click(screen.getByRole('switch'))
    expect(setXiaoguiKimiProductionEnabled).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveTextContent('settings:runtime.xiaoguiKimiEnableConfirmMessage')

    fireEvent.click(screen.getByRole('button', { name: 'common:cancel' }))
    expect(setXiaoguiKimiProductionEnabled).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByRole('button', { name: 'common:confirm' }))
    expect(setXiaoguiKimiProductionEnabled).toHaveBeenCalledOnce()
    expect(setXiaoguiKimiProductionEnabled).toHaveBeenCalledWith(true)
  })

  it('disables immediately without confirmation', async () => {
    draft.xiaoguiKimiProductionEnabled = true
    render(<RuntimeSettingsPanel />)
    await screen.findByText('当前未启用。保存启用设置并重启小规后生效。')

    fireEvent.click(screen.getByRole('switch'))

    expect(setXiaoguiKimiProductionEnabled).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders every public Kimi status without claiming that credentials prove login', async () => {
    const cases: readonly [XiaoguiKimiRuntimeStatusV1, string][] = [
      ['DISABLED', '当前未启用。保存启用设置并重启小规后生效。'],
      ['CLI_NOT_FOUND', '未发现 Kimi 命令行工具。'],
      ['VERSION_UNAPPROVED', 'Kimi 命令行工具版本不符合要求。'],
      ['LOGIN_REQUIRED', '需要登录。'],
      ['CREDENTIAL_PRESENT_UNVERIFIED', '已发现本地凭据（执行时验证）。'],
      ['LOGIN_IN_PROGRESS', '正在登录。请在打开的终端中完成操作。'],
      ['STATUS_UNAVAILABLE', '状态暂不可用。'],
    ]

    for (const [status, text] of cases) {
      mocks.invoke.mockResolvedValue(kimiStatus(status))
      const view = render(<RuntimeSettingsPanel />)
      expect(await screen.findByText(text)).toBeInTheDocument()
      view.unmount()
    }
  })

  it('starts sign-in with an empty request and disables the action while login is active', async () => {
    mocks.invoke.mockImplementation((method: string) => {
      if (method === 'xiaogui.kimi.login.start') {
        return Promise.resolve(kimiStatus('LOGIN_IN_PROGRESS'))
      }
      return Promise.resolve(kimiStatus('CREDENTIAL_PRESENT_UNVERIFIED'))
    })
    render(<RuntimeSettingsPanel />)

    await screen.findByText('已发现本地凭据（执行时验证）。')
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }))

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('xiaogui.kimi.login.start', {})
    })
    expect(await screen.findByRole('button', { name: '正在登录' })).toBeDisabled()
  })

  it('polls every two seconds only while login is in progress and stops after unmount', async () => {
    vi.useFakeTimers()
    mocks.invoke.mockResolvedValue(kimiStatus('LOGIN_IN_PROGRESS'))
    const view = render(<RuntimeSettingsPanel />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '正在登录' })).toBeDisabled()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.invoke).toHaveBeenCalledTimes(2)

    view.unmount()
    act(() => vi.advanceTimersByTime(4_000))
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })
})

function kimiStatus(status: XiaoguiKimiRuntimeStatusV1): XiaoguiKimiRuntimeStatusSnapshotV1 {
  return { status, reasonCode: KIMI_REASON_BY_STATUS[status], approvedVersion: '0.34.0' }
}

const KIMI_REASON_BY_STATUS: Record<
  XiaoguiKimiRuntimeStatusV1,
  XiaoguiKimiRuntimeStatusSnapshotV1['reasonCode']
> = {
  DISABLED: 'PRODUCTION_DISABLED',
  CLI_NOT_FOUND: 'KIMI_CLI_NOT_FOUND',
  VERSION_UNAPPROVED: 'KIMI_VERSION_UNAPPROVED',
  LOGIN_REQUIRED: 'KIMI_CREDENTIAL_MISSING',
  CREDENTIAL_PRESENT_UNVERIFIED: 'KIMI_CREDENTIAL_PRESENT_UNVERIFIED',
  LOGIN_IN_PROGRESS: 'KIMI_LOGIN_IN_PROGRESS',
  STATUS_UNAVAILABLE: 'KIMI_PROBE_UNAVAILABLE',
}
