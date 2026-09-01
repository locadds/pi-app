import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import { XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1 } from '@shared/xiaogui-coding-role-control'

const listMock = vi.fn()
const readForEditMock = vi.fn()
const saveMock = vi.fn()
const copyMock = vi.fn()
const resetMock = vi.fn()
const bindMock = vi.fn()
const readBindingMock = vi.fn()
vi.mock('../lib/coding-role-client', () => ({
  listCodingRoles: (address: HubAddressV1) => listMock(address),
  readCodingRoleForEdit: (address: HubAddressV1, profileId: string) => readForEditMock(address, profileId),
  saveCodingRole: (address: HubAddressV1, profile: unknown) => saveMock(address, profile),
  copyCodingRole: (address: HubAddressV1, sourceProfileId: string, newProfileId: string) =>
    copyMock(address, sourceProfileId, newProfileId),
  resetDefaultCodingRole: (address: HubAddressV1, profileId: string) => resetMock(address, profileId),
  bindCodingAttemptRole: (address: HubAddressV1, attemptId: string, profile: unknown) =>
    bindMock(address, attemptId, profile),
  readCodingAttemptRole: (address: HubAddressV1, attemptId: string) => readBindingMock(address, attemptId),
}))

import { CodingRoleCard } from './CodingRoleCard'

const address: HubAddressV1 = {
  projectId: `xgp1_${'a'.repeat(64)}` as HubAddressV1['projectId'],
  sessionKey: `xgs1_${'b'.repeat(64)}` as HubAddressV1['sessionKey'],
}
const summary = {
  schemaVersion: 1 as const,
  profileId: 'role-implement',
  role: 'IMPLEMENT' as const,
  name: '实现',
  description: '在受控工作树中修改代码',
  modelSelector: 'configured',
  runtimePolicyId: 'local-approved',
  toolAllowlist: ['read', 'edit'],
  profileDigest: `sha256:${'1'.repeat(64)}`,
  updatedAt: '2026-08-31T00:00:00.000Z',
}

describe('CodingRoleCard', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue({
      ok: true,
      value: { contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1, profiles: [summary] },
    })
    readBindingMock.mockReset().mockResolvedValue({
      ok: true,
      value: { contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1, binding: null },
    })
    readForEditMock.mockReset()
    saveMock.mockReset()
    copyMock.mockReset()
    resetMock.mockReset()
    bindMock.mockReset()
  })
  afterEach(cleanup)

  it('普通视图不读取或展示 system prompt，显式编辑后才显示', async () => {
    const user = userEvent.setup()
    readForEditMock.mockResolvedValueOnce({
      ok: true,
      value: {
        contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1,
        profile: { ...summary, systemPrompt: '只允许在工作树中修改。' },
      },
    })
    const { container } = render(<CodingRoleCard address={address} attemptId="xhba_private" canBind />)
    expect(await screen.findByText('在受控工作树中修改代码')).toBeVisible()
    expect(container.textContent).not.toContain('只允许在工作树中修改')
    await user.click(screen.getByRole('button', { name: '编辑角色' }))
    expect(await screen.findByLabelText('系统提示')).toHaveValue('只允许在工作树中修改。')
    expect(readForEditMock).toHaveBeenCalledWith(address, summary.profileId)
  })

  it('选择角色后按精确摘要绑定，界面不显示 Attempt 编号或 digest', async () => {
    const user = userEvent.setup()
    bindMock.mockResolvedValueOnce({
      ok: true,
      value: {
        contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1,
        binding: {
          schemaVersion: 1,
          attemptId: 'xhba_private',
          profileId: summary.profileId,
          role: 'IMPLEMENT',
          name: '实现',
          description: '在受控工作树中修改代码',
          modelSelector: 'configured',
          runtimePolicyId: 'local-approved',
          effectiveToolAllowlist: ['read', 'edit'],
          profileDigest: summary.profileDigest,
          snapshotDigest: `sha256:${'2'.repeat(64)}`,
          boundAt: '2026-08-31T00:00:00.000Z',
        },
      },
    })
    const { container } = render(<CodingRoleCard address={address} attemptId="xhba_private" canBind />)
    await screen.findByText('在受控工作树中修改代码')
    await user.click(screen.getByRole('button', { name: '使用此角色' }))
    await waitFor(() => expect(bindMock).toHaveBeenCalledWith(address, 'xhba_private', summary))
    expect(await screen.findByText('当前角色：实现')).toBeVisible()
    expect(container.textContent).not.toContain('xhba_private')
    expect(container.textContent).not.toContain('sha256:')
  })

  it('复制角色走窄通道，重置默认角色必须二次确认', async () => {
    copyMock.mockImplementationOnce((_address, _sourceProfileId, newProfileId) => Promise.resolve({
      ok: true,
      value: {
        contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1,
        profile: { ...summary, profileId: newProfileId },
      },
    }))
    resetMock.mockResolvedValueOnce({
      ok: true,
      value: { contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1, profile: summary },
    })
    const user = userEvent.setup()
    render(<CodingRoleCard address={address} attemptId="xhba_private" canBind />)
    await screen.findByText('在受控工作树中修改代码')
    await user.click(screen.getByRole('button', { name: '复制角色' }))
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith(
      address,
      summary.profileId,
      expect.stringMatching(/^role-implement-copy-[a-z0-9]+$/),
    ))
    expect(await screen.findByText('角色副本已创建，可继续编辑。')).toBeVisible()

    await user.selectOptions(screen.getByLabelText('选择角色'), summary.profileId)
    await user.click(screen.getByRole('button', { name: '重置默认角色' }))
    expect(resetMock).not.toHaveBeenCalled()
    expect(screen.getByText(/已绑定的执行不会改变/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '确认重置' }))
    await waitFor(() => expect(resetMock).toHaveBeenCalledWith(address, summary.profileId))
  })

  it('角色 IPC 不可用时 fail closed，不出现绑定按钮', async () => {
    listMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'ROLE_STORE_UNAVAILABLE', messageKey: 'xiaogui.coding.roles.ipc' },
    })
    render(<CodingRoleCard address={address} attemptId="xhba_private" canBind />)
    expect(await screen.findByText('角色配置当前不可用。')).toBeVisible()
    expect(screen.queryByRole('button', { name: '使用此角色' })).toBeNull()
  })

  it('绑定失败时显示稳定中文原因，不回显底层异常', async () => {
    bindMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'MODEL_UNAVAILABLE', messageKey: 'xiaogui.coding.roles.model_unavailable' },
    })
    const user = userEvent.setup()
    render(<CodingRoleCard address={address} attemptId="xhba_private" canBind />)
    await screen.findByText('在受控工作树中修改代码')
    await user.click(screen.getByRole('button', { name: '使用此角色' }))
    expect(await screen.findByText('当前会话尚未选择可用模型，请先选择模型后再试。')).toBeVisible()
    expect(document.body.textContent).not.toContain('XIAOGUI_CODING_ROLE')
  })
})
