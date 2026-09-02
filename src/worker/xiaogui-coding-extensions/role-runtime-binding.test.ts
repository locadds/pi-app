import { describe, expect, it } from 'vitest'

import type { CodingRoleAgentSnapshotV1 } from '@shared/xiaogui-coding-role-control'

import { CodingRoleRuntimeBindingV1 } from './role-runtime-binding'

const BASE: CodingRoleAgentSnapshotV1 = {
  schemaVersion: 1,
  attemptId: 'attempt-1',
  boundAt: '2026-08-31T12:00:00.000Z',
  snapshot: {
    schemaVersion: 1,
    profileId: 'role.research.custom',
    role: 'RESEARCH',
    name: '研究',
    description: '只读',
    systemPrompt: '保持只读，不得修改文件。',
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    requestedToolAllowlist: ['read', 'bash', 'edit', 'write'],
    effectiveToolAllowlist: ['read'],
    profileDigest: `sha256:${'1'.repeat(64)}`,
  },
  snapshotDigest: 'sha256:47d237c52a248e6a34c459cae71eca062bec6f4ce5eff7852ae4d5743c806792',
}

describe('CodingRoleRuntimeBindingV1', () => {
  it('同一 Attempt 只接受同一冻结快照，不能在运行中静默换角色', () => {
    const binding = new CodingRoleRuntimeBindingV1()
    const first = binding.bind(BASE)
    expect(binding.bind(BASE)).toBe(first)

    expect(() => binding.bind({
      ...BASE,
      snapshotDigest: `sha256:${'2'.repeat(64)}`,
    })).toThrow('XIAOGUI_CODING_ROLE_SNAPSHOT_INVALID')

    expect(() => binding.bind({ ...BASE, attemptId: 'attempt-2' }))
      .toThrow('XIAOGUI_CODING_ROLE_RUNTIME_ALREADY_BOUND')
    expect(binding.read()).toBe(first)

    binding.release('attempt-1')
    const second = binding.bind({ ...BASE, attemptId: 'attempt-2' })
    expect(second.attemptId).toBe('attempt-2')
    expect(binding.read()).toBe(second)
  })

  it('激活工具只取 Worker 已注册工具与角色有效白名单交集，释放后才可绑定下一 Attempt', () => {
    const binding = new CodingRoleRuntimeBindingV1()
    binding.bind(BASE)
    expect(binding.activeToolNames(['read', 'bash', 'edit', 'write', 'third_party_write']))
      .toEqual(['read'])

    binding.release()
    expect(binding.read()).toBeNull()
    // 释放后无绑定：透传 Worker 已注册工具（绑定只可能属于 CODING Attempt，
    // WORK/DESIGN 不得被角色白名单误伤）。
    expect(binding.activeToolNames(['read', 'bash'])).toEqual(['read', 'bash'])
  })

  it('只有持有当前 Attempt 的调用者才能释放角色绑定', () => {
    const binding = new CodingRoleRuntimeBindingV1()
    binding.bind(BASE)

    expect(() => binding.release('attempt-2'))
      .toThrow('XIAOGUI_CODING_ROLE_RUNTIME_ATTEMPT_MISMATCH')
    expect(binding.read()?.attemptId).toBe('attempt-1')

    binding.release('attempt-1')
    expect(binding.read()).toBeNull()
  })
})
