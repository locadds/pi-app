import { describe, expect, it, vi } from 'vitest'

import type { CodingRoleAgentSnapshotV1 } from '@shared/xiaogui-coding-role-control'

import {
  createXiaoguiCodingRoleGuardExtensionV1,
  freezeCodingRoleAgentSnapshotV1,
} from './role-guard-extension'

const RESEARCH_SNAPSHOT: CodingRoleAgentSnapshotV1 = {
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

function registeredHandlers(snapshot: CodingRoleAgentSnapshotV1 | null) {
  const handlers = new Map<string, (event: never, context: never) => unknown>()
  const extension = createXiaoguiCodingRoleGuardExtensionV1(() => snapshot)
  extension.factory({
    on: vi.fn((event: string, handler: (event: never, context: never) => unknown) => {
      handlers.set(event, handler)
    }),
  } as never)
  return handlers
}

describe('Xiaogui CODING role guard extension', () => {
  it('在 Provider 前私下叠加角色提示，并在 EXECUTE 中硬性阻止研究角色写入', async () => {
    const snapshot = freezeCodingRoleAgentSnapshotV1(RESEARCH_SNAPSHOT)
    const handlers = registeredHandlers(snapshot)

    const promptResult = await handlers.get('before_agent_start')!({
      systemPrompt: 'Pi base prompt',
    } as never, {} as never)
    expect(promptResult).toEqual({
      systemPrompt: 'Pi base prompt\n\n【小规受控角色：研究】\n保持只读，不得修改文件。',
    })

    expect(handlers.get('tool_call')!({ toolName: 'read' } as never, {} as never))
      .toBeUndefined()
    expect(handlers.get('tool_call')!({ toolName: 'write' } as never, {} as never))
      .toEqual({
        block: true,
        reason: 'XIAOGUI_CODING_ROLE_TOOL_BLOCKED',
        terminate: true,
      })
  })

  it('拒绝已绑定只读角色的白名单外工具，未绑定普通会话保持透明', async () => {
    const guarded = registeredHandlers(freezeCodingRoleAgentSnapshotV1(RESEARCH_SNAPSHOT))
    expect(guarded.get('tool_call')!({ toolName: 'third_party_write' } as never, {} as never))
      .toEqual({
        block: true,
        reason: 'XIAOGUI_CODING_ROLE_TOOL_BLOCKED',
        terminate: true,
      })

    const unbound = registeredHandlers(null)
    expect(unbound.get('tool_call')!({ toolName: 'read' } as never, {} as never)).toBeUndefined()
    expect(unbound.get('tool_call')!({ toolName: 'third_party_write' } as never, {} as never))
      .toBeUndefined()
    expect(unbound.get('before_agent_start')!({ systemPrompt: 'Pi base prompt' } as never, {} as never))
      .toBeUndefined()
  })

  it('验证 Main 冻结快照的摘要与只读上限，拒绝篡改或非法放权', () => {
    expect(() => freezeCodingRoleAgentSnapshotV1({
      ...RESEARCH_SNAPSHOT,
      snapshotDigest: `sha256:${'2'.repeat(64)}`,
    })).toThrow('XIAOGUI_CODING_ROLE_SNAPSHOT_INVALID')

    expect(() => freezeCodingRoleAgentSnapshotV1({
      ...RESEARCH_SNAPSHOT,
      snapshot: {
        ...RESEARCH_SNAPSHOT.snapshot,
        effectiveToolAllowlist: ['read', 'write'],
      },
    })).toThrow('XIAOGUI_CODING_ROLE_SNAPSHOT_INVALID')
  })
})
