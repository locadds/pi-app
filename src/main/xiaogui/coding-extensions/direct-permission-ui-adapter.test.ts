import { describe, expect, it, vi } from 'vitest'

const requestDirectExtensionUI = vi.hoisted(() => vi.fn())
vi.mock('../../direct-extension-ui', () => ({ requestDirectExtensionUI }))

import { MainProcessDirectCodingPermissionUIAdapterV3 } from './direct-permission-ui-adapter'

const origin = {
  projectLabel: 'alpha',
  sessionLabel: '修复权限',
  fromCwd: 'D:/projects/alpha',
  fromPoolKey: 'D:/sessions/alpha.jsonl',
  sessionFile: 'D:/sessions/alpha.jsonl',
  sourceSessionId: 'pi-session-1',
} as const

const prompt = {
  schemaVersion: 3 as const,
  subject: 'DIRECT_SESSION' as const,
  requestDigest: `sha256:${'a'.repeat(64)}`,
  originDigest: `sha256:${'b'.repeat(64)}`,
  projectLabel: origin.projectLabel,
  sessionLabel: origin.sessionLabel,
  operation: 'WRITE' as const,
  mode: 'CONFIRM_EACH' as const,
  relativePath: 'src/a.ts',
  choices: ['ALLOW_ONCE', 'DENY'] as const,
}

describe('MainProcessDirectCodingPermissionUIAdapterV3', () => {
  it('fails closed when the exact source window is unavailable', async () => {
    requestDirectExtensionUI.mockReset()
    const adapter = new MainProcessDirectCodingPermissionUIAdapterV3({
      windowProvider: () => undefined,
    })
    await expect(adapter.request(prompt, origin)).resolves.toBe('DENY')
    expect(requestDirectExtensionUI).not.toHaveBeenCalled()
  })

  it('accepts only a response echoing both request and origin digests', async () => {
    requestDirectExtensionUI.mockReset()
    const win = { isDestroyed: () => false }
    const adapter = new MainProcessDirectCodingPermissionUIAdapterV3({
      windowProvider: () => win as never,
    })
    requestDirectExtensionUI.mockResolvedValueOnce({
      id: 'permission-1',
      result: {
        choice: 'ALLOW_ONCE',
        requestDigest: prompt.requestDigest,
        originDigest: prompt.originDigest,
      },
    })
    await expect(adapter.request(prompt, origin)).resolves.toBe('ALLOW_ONCE')

    requestDirectExtensionUI.mockResolvedValueOnce({
      id: 'permission-2',
      result: {
        choice: 'ALLOW_ONCE',
        requestDigest: prompt.requestDigest,
        originDigest: `sha256:${'c'.repeat(64)}`,
      },
    })
    await expect(adapter.request(prompt, origin)).resolves.toBe('DENY')
  })
})
