import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import {
  XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1,
  type CodingRoleProfileEditorDraftV1,
} from '@shared/xiaogui-coding-role-control'

const invokeMock = vi.fn()
vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: (method: string, request?: unknown) => invokeMock(method, request) },
}))

import {
  bindCodingAttemptRole,
  copyCodingRole,
  listCodingRoles,
  readCodingAttemptRole,
  readCodingRoleForEdit,
  resetDefaultCodingRole,
  saveCodingRole,
} from './coding-role-client'

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

describe('coding-role-client', () => {
  beforeEach(() => invokeMock.mockReset())

  it('通过角色窄通道读取不含系统提示的摘要列表', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: { contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1, profiles: [summary] },
    })
    await expect(listCodingRoles(address)).resolves.toMatchObject({ ok: true })
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.coding.roles.list', {
      contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1,
      address,
    })
    expect(JSON.stringify(invokeMock.mock.results)).not.toContain('systemPrompt')
  })

  it('只有显式编辑动作才读取系统提示并可保存', async () => {
    const profile = { ...summary, systemPrompt: '只在工作树中修改。' }
    invokeMock
      .mockResolvedValueOnce({
        ok: true,
        value: { contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1, profile },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1, profile: summary },
      })

    await expect(readCodingRoleForEdit(address, summary.profileId)).resolves.toMatchObject({ ok: true })
    const draft: CodingRoleProfileEditorDraftV1 = {
      schemaVersion: 1,
      profileId: summary.profileId,
      role: 'IMPLEMENT',
      name: '实现',
      description: '受控实现',
      systemPrompt: '只在工作树中修改。',
      modelSelector: 'configured',
      runtimePolicyId: 'local-approved',
      toolAllowlist: ['read', 'edit'],
    }
    await expect(saveCodingRole(address, draft)).resolves.toMatchObject({ ok: true })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'xiaogui.coding.roles.upsert', {
      contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1,
      address,
      profile: draft,
    })
  })

  it('按精确 profile digest 绑定角色，并可读取 Attempt 绑定', async () => {
    const binding = {
      schemaVersion: 1 as const,
      attemptId: 'xhba_1',
      profileId: summary.profileId,
      role: 'IMPLEMENT' as const,
      name: '实现',
      description: '受控实现',
      modelSelector: 'configured',
      runtimePolicyId: 'local-approved',
      effectiveToolAllowlist: ['read', 'edit'],
      profileDigest: summary.profileDigest,
      snapshotDigest: `sha256:${'2'.repeat(64)}`,
      boundAt: '2026-08-31T00:00:00.000Z',
    }
    invokeMock
      .mockResolvedValueOnce({
        ok: true,
        value: { contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1, binding },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1, binding },
      })
    await expect(bindCodingAttemptRole(address, 'xhba_1', summary)).resolves.toMatchObject({ ok: true })
    await expect(readCodingAttemptRole(address, 'xhba_1')).resolves.toMatchObject({ ok: true })
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'xiaogui.coding.roles.attempt.bind', {
      contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1,
      address,
      attemptId: 'xhba_1',
      profileId: summary.profileId,
      expectedProfileDigest: summary.profileDigest,
    })
  })

  it('复制和重置只调用已登记窄通道并验证返回角色', async () => {
    const copied = { ...summary, profileId: 'role-implement-copy' }
    invokeMock
      .mockResolvedValueOnce({
        ok: true,
        value: { contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1, profile: copied },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1, profile: summary },
      })
    await expect(copyCodingRole(address, summary.profileId, copied.profileId)).resolves.toMatchObject({ ok: true })
    await expect(resetDefaultCodingRole(address, summary.profileId)).resolves.toMatchObject({ ok: true })
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'xiaogui.coding.roles.copy', {
      contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1,
      address,
      sourceProfileId: summary.profileId,
      newProfileId: copied.profileId,
    })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'xiaogui.coding.roles.resetDefault', {
      contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1,
      address,
      profileId: summary.profileId,
    })
  })

  it.each([
    { unexpected: true },
    {
      ok: true,
      value: {
        contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1,
        profiles: [{ ...summary, systemPrompt: '不应出现在摘要' }],
      },
    },
  ])('契约未注册或响应越界时 fail closed：%j', async (response) => {
    invokeMock.mockResolvedValueOnce(response)
    await expect(listCodingRoles(address)).resolves.toEqual({
      ok: false,
      error: { code: 'ROLE_STORE_UNAVAILABLE', messageKey: 'xiaogui.coding.roles.ipc' },
    })
  })

  it('IPC 异常不泄露绝对路径', async () => {
    invokeMock.mockRejectedValueOnce(new Error('C:\\Users\\secret'))
    const result = await listCodingRoles(address)
    expect(result).toEqual({
      ok: false,
      error: { code: 'ROLE_STORE_UNAVAILABLE', messageKey: 'xiaogui.coding.roles.ipc' },
    })
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})
