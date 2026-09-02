import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CanonicalSessionAddressScopeV1, ProjectId, SessionKey } from '@shared/xiaogui-session-scope'

const mocks = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({}) }))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: (...args: unknown[]) => mocks.invoke(...args) },
}))

import { prepareCanonicalSessionOpen } from './canonical-session-open'
import { useXiaoguiStore } from '../stores/xiaogui-store'

const scope: CanonicalSessionAddressScopeV1 = {
  projectId: `xgp1_${'1'.repeat(64)}` as ProjectId,
  sessionKey: `xgs1_${'2'.repeat(64)}` as SessionKey,
  sessionMode: 'CODING',
}

describe('prepare canonical session open', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    useXiaoguiStore.setState({ mode: 'WORK' })
  })

  it('looks up the opaque address and synchronizes mode before returning', async () => {
    mocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'xiaogui.scope.lookup') return { kind: 'FOUND', scope }
      if (method === 'xiaogui.mode.switch') return { ok: true, mode: 'CODING' }
      return {}
    })

    await expect(prepareCanonicalSessionOpen(scope)).resolves.toEqual(scope)
    expect(mocks.invoke.mock.calls).toEqual([
      ['xiaogui.scope.lookup', { projectId: scope.projectId, sessionKey: scope.sessionKey }],
      ['xiaogui.mode.switch', { mode: 'CODING' }],
    ])
    expect(useXiaoguiStore.getState().mode).toBe('CODING')
  })

  it.each(['NOT_FOUND', 'PROJECT_MISMATCH'] as const)('fails closed on %s without changing mode', async (kind) => {
    mocks.invoke.mockResolvedValueOnce({ kind })

    await expect(prepareCanonicalSessionOpen(scope)).rejects.toThrow(`canonical_session_scope_${kind.toLowerCase()}`)
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(useXiaoguiStore.getState().mode).toBe('WORK')
  })
})
