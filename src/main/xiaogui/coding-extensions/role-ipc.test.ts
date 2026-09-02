import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
const roots: string[] = []

vi.mock('../../ipc/registry', () => ({
  registerHandler: vi.fn((channel: string, handler: (payload: unknown) => Promise<unknown>) => {
    handlers.set(channel, handler)
  }),
}))

import { CodingRoleProfileModuleV1 } from './role-profile-module'
import {
  type CodingRoleRuntimePortV1,
  privateCodingRoleAgentSnapshotV1,
  registerCodingRoleHandlersV1,
} from './role-ipc'

const ADDRESS = {
  projectId: `xgp1_${'a'.repeat(64)}`,
  sessionKey: `xgs1_${'b'.repeat(64)}`,
} as SessionAddressV1
const VERSION = 'xiaogui.coding-role-control.v1'

function module(): CodingRoleProfileModuleV1 {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-role-ipc-'))
  roots.push(root)
  return new CodingRoleProfileModuleV1({
    dbPath: join(root, 'roles.sqlite'),
    now: () => '2026-08-31T12:00:00.000Z',
  })
}

function runtime(overrides: Partial<CodingRoleRuntimePortV1> = {}): CodingRoleRuntimePortV1 {
  return {
    ensureSupported: vi.fn(async () => {}),
    bind: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('CODING role IPC', () => {
  beforeEach(() => handlers.clear())
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('普通列表不返回 systemPrompt，只有显式编辑读取返回提示正文', async () => {
    const roles = module()
    registerCodingRoleHandlersV1({
      roles,
      runtime: runtime(),
      scope: {
        isCodingSession: vi.fn(() => true),
        hasAttempt: vi.fn(() => true),
      },
    })

    const listed = await handlers.get('ipc:xiaogui.coding.roles.list')!({
      contractVersion: VERSION,
      address: ADDRESS,
    })
    expect(listed).toMatchObject({ ok: true, value: { profiles: expect.any(Array) } })
    expect(JSON.stringify(listed)).not.toContain('systemPrompt')

    const edited = await handlers.get('ipc:xiaogui.coding.roles.readForEdit')!({
      contractVersion: VERSION,
      address: ADDRESS,
      profileId: 'xiaogui.role.research.default',
    })
    expect(edited).toMatchObject({
      ok: true,
      value: { profile: { role: 'RESEARCH', systemPrompt: expect.stringContaining('只读') } },
    })
    roles.close()
  })

  it('保存角色配置时拒绝未知工具，成功响应也不回显 systemPrompt', async () => {
    const roles = module()
    registerCodingRoleHandlersV1({
      roles,
      runtime: runtime(),
      scope: { isCodingSession: () => true, hasAttempt: () => true },
    })
    const save = handlers.get('ipc:xiaogui.coding.roles.upsert')!
    const baseProfile = {
      schemaVersion: 1,
      profileId: 'role.implement.custom',
      role: 'IMPLEMENT',
      name: '实现角色',
      description: '受控实现',
      systemPrompt: '仅在已批准的工作树内实现。',
      modelSelector: 'inherit',
      runtimePolicyId: 'approved.default',
      toolAllowlist: ['read', 'bash', 'edit', 'write'],
    }

    expect(await save({
      contractVersion: VERSION,
      address: ADDRESS,
      profile: { ...baseProfile, toolAllowlist: ['read', 'unknown-tool'] },
    })).toMatchObject({ ok: false, error: { code: 'PROFILE_INVALID' } })

    const saved = await save({ contractVersion: VERSION, address: ADDRESS, profile: baseProfile })
    expect(saved).toMatchObject({
      ok: true,
      value: { profile: { profileId: baseProfile.profileId, toolAllowlist: baseProfile.toolAllowlist } },
    })
    expect(JSON.stringify(saved)).not.toContain('systemPrompt')
    roles.close()
  })

  it('只给当前会话内 Attempt 绑定精确角色版本，绑定后不能静默换角色', async () => {
    const roles = module()
    let inScope = false
    const roleRuntime = runtime()
    registerCodingRoleHandlersV1({
      roles,
      runtime: roleRuntime,
      scope: {
        isCodingSession: () => true,
        hasAttempt: (_address, attemptId) => inScope && attemptId === 'attempt-1',
      },
    })
    const profile = roles.readForEdit('xiaogui.role.implement.default')!
    const bind = handlers.get('ipc:xiaogui.coding.roles.attempt.bind')!
    const command = {
      contractVersion: VERSION,
      address: ADDRESS,
      attemptId: 'attempt-1',
      profileId: profile.profileId,
      expectedProfileDigest: profile.profileDigest,
    }

    expect(await bind(command)).toMatchObject({
      ok: false,
      error: { code: 'SESSION_SCOPE_MISMATCH' },
    })
    inScope = true
    expect(await bind({ ...command, expectedProfileDigest: `sha256:${'9'.repeat(64)}` }))
      .toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } })

    const bound = await bind(command)
    expect(bound).toMatchObject({
      ok: true,
      value: {
        binding: {
          attemptId: 'attempt-1',
          role: 'IMPLEMENT',
          effectiveToolAllowlist: ['read', 'bash', 'edit', 'write'],
        },
      },
    })
    expect(JSON.stringify(bound)).not.toContain('systemPrompt')
    expect(roleRuntime.ensureSupported).toHaveBeenCalledWith(
      ADDRESS,
      expect.objectContaining({
        attemptId: 'attempt-1',
        snapshot: expect.objectContaining({ systemPrompt: expect.stringContaining('实现角色') }),
      }),
    )
    expect(roleRuntime.bind).toHaveBeenCalledWith(
      ADDRESS,
      expect.objectContaining({ attemptId: 'attempt-1' }),
    )

    const privateSnapshot = privateCodingRoleAgentSnapshotV1(
      roles.readAttemptBinding('attempt-1')!,
    )
    expect(privateSnapshot).toMatchObject({
      attemptId: 'attempt-1',
      snapshot: {
        profileId: profile.profileId,
        systemPrompt: expect.stringContaining('实现角色'),
      },
      snapshotDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })

    const review = roles.readForEdit('xiaogui.role.review.default')!
    expect(await bind({
      ...command,
      profileId: review.profileId,
      expectedProfileDigest: review.profileDigest,
    })).toMatchObject({ ok: false, error: { code: 'ATTEMPT_ALREADY_BOUND' } })
    roles.close()
  })

  it('复制和重置通过专用动作完成，普通响应不回显 systemPrompt', async () => {
    const roles = module()
    registerCodingRoleHandlersV1({
      roles,
      runtime: runtime(),
      scope: { isCodingSession: () => true, hasAttempt: () => true },
    })

    const copied = await handlers.get('ipc:xiaogui.coding.roles.copy')!({
      contractVersion: VERSION,
      address: ADDRESS,
      sourceProfileId: 'xiaogui.role.implement.default',
      newProfileId: 'role.implement.copy',
    })
    expect(copied).toMatchObject({
      ok: true,
      value: { profile: { profileId: 'role.implement.copy', role: 'IMPLEMENT' } },
    })
    expect(JSON.stringify(copied)).not.toContain('systemPrompt')

    expect(await handlers.get('ipc:xiaogui.coding.roles.copy')!({
      contractVersion: VERSION,
      address: ADDRESS,
      sourceProfileId: 'xiaogui.role.implement.default',
      newProfileId: 'role.implement.copy',
    })).toMatchObject({ ok: false, error: { code: 'PROFILE_ALREADY_EXISTS' } })

    roles.upsert({
      schemaVersion: 1,
      profileId: 'xiaogui.role.research.default',
      role: 'RESEARCH',
      name: '已修改研究角色',
      description: '待重置',
      systemPrompt: '待重置的私有提示。',
      modelSelector: 'inherit',
      runtimePolicyId: 'approved.default',
      toolAllowlist: ['read'],
    })
    const reset = await handlers.get('ipc:xiaogui.coding.roles.resetDefault')!({
      contractVersion: VERSION,
      address: ADDRESS,
      profileId: 'xiaogui.role.research.default',
    })
    expect(reset).toMatchObject({
      ok: true,
      value: { profile: { profileId: 'xiaogui.role.research.default', name: '研究' } },
    })
    expect(JSON.stringify(reset)).not.toContain('systemPrompt')
    roles.close()
  })

  it('模型或运行时门未通过时不持久化 Attempt 绑定，且返回稳定错误', async () => {
    const roles = module()
    const roleRuntime = runtime({
      ensureSupported: vi.fn(async () => {
        throw new Error('XIAOGUI_CODING_ROLE_MODEL_UNAVAILABLE')
      }),
    })
    registerCodingRoleHandlersV1({
      roles,
      runtime: roleRuntime,
      scope: { isCodingSession: () => true, hasAttempt: () => true },
    })
    const profile = roles.readForEdit('xiaogui.role.implement.default')!

    const result = await handlers.get('ipc:xiaogui.coding.roles.attempt.bind')!({
      contractVersion: VERSION,
      address: ADDRESS,
      attemptId: 'attempt-runtime-rejected',
      profileId: profile.profileId,
      expectedProfileDigest: profile.profileDigest,
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'MODEL_UNAVAILABLE' } })
    expect(roles.readAttemptBinding('attempt-runtime-rejected')).toBeNull()
    expect(roleRuntime.bind).not.toHaveBeenCalled()
    roles.close()
  })
})
