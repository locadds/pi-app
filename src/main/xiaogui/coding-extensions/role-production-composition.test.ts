import { describe, expect, it, vi } from 'vitest'

import type { CodingRoleAgentSnapshotV1 } from '@shared/xiaogui-coding-role-control'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

import { createCodingRoleProductionPortsV1 } from './role-production-ports'

const ADDRESS = {
  projectId: `xgp1_${'a'.repeat(64)}`,
  sessionKey: `xgs1_${'b'.repeat(64)}`,
} as SessionAddressV1

const ROLE = {
  schemaVersion: 1,
  attemptId: 'attempt-1',
  boundAt: '2026-08-31T12:00:00.000Z',
  snapshot: {
    schemaVersion: 1,
    profileId: 'xiaogui.role.research.default',
    role: 'RESEARCH',
    name: '研究',
    description: '只读',
    systemPrompt: 'PRIVATE ROLE PROMPT',
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    requestedToolAllowlist: ['read'],
    effectiveToolAllowlist: ['read'],
    profileDigest: `sha256:${'1'.repeat(64)}`,
  },
  snapshotDigest: `sha256:${'2'.repeat(64)}`,
} satisfies CodingRoleAgentSnapshotV1

describe('CODING role production composition', () => {
  it('只接受已注册 CODING 会话及该会话内的权威 Attempt', async () => {
    const lookup = vi.fn(async () => ({
      kind: 'FOUND' as const,
      scope: { ...ADDRESS, sessionMode: 'CODING' as const },
    }))
    const observe = vi.fn(() => [
      { attemptId: 'attempt-1' },
      { attemptId: 'attempt-2' },
    ])
    const ports = createCodingRoleProductionPortsV1({
      lookup: { lookup },
      plans: { observe },
      ensureSession: vi.fn(),
      workers: {
        inspectCodingRoleSupport: vi.fn(async () => ({})),
        bindCodingAttemptRole: vi.fn(async () => ({})),
      },
    })

    await expect(ports.scope.isCodingSession(ADDRESS)).resolves.toBe(true)
    expect(ports.scope.hasAttempt(ADDRESS, 'attempt-1')).toBe(true)
    expect(ports.scope.hasAttempt(ADDRESS, 'attempt-missing')).toBe(false)
    expect(observe).toHaveBeenCalledWith(ADDRESS)

    lookup.mockResolvedValueOnce({
      kind: 'FOUND',
      scope: { ...ADDRESS, sessionMode: 'WORK' },
    } as never)
    await expect(ports.scope.isCodingSession(ADDRESS)).resolves.toBe(false)
  })

  it('私有角色快照仅通过 Main-to-Worker 端口做预检与绑定', async () => {
    const inspectCodingRoleSupport = vi.fn(async () => ({ model: 'openai/gpt-5.6-sol' }))
    const bindCodingAttemptRole = vi.fn(async () => ({ model: 'openai/gpt-5.6-sol' }))
    const ensureSession = vi.fn(async () => undefined)
    const ports = createCodingRoleProductionPortsV1({
      lookup: { lookup: vi.fn(async () => ({ kind: 'NOT_FOUND' as const })) },
      plans: { observe: vi.fn(() => []) },
      workers: { inspectCodingRoleSupport, bindCodingAttemptRole },
      ensureSession,
    })

    await ports.runtime.ensureSupported(ADDRESS, ROLE)
    await ports.runtime.bind(ADDRESS, ROLE)

    expect(ensureSession).toHaveBeenCalledWith(ADDRESS)
    expect(ensureSession.mock.invocationCallOrder[0])
      .toBeLessThan(inspectCodingRoleSupport.mock.invocationCallOrder[0]!)
    expect(inspectCodingRoleSupport).toHaveBeenCalledWith(ADDRESS, ROLE)
    expect(bindCodingAttemptRole).toHaveBeenCalledWith(ADDRESS, ROLE)
  })
})
