import { describe, expect, it, vi } from 'vitest'
import { createWorkerExecutionIdentityDigestV1 } from '../worker-execution-identity'

vi.mock('../config-store', () => ({
  configStore: { get: vi.fn(() => undefined) },
}))

const HOST_RUNTIME = { mode: 'host' as const, distro: null }

describe('worker execution identity', () => {
  it('is stable across resource record insertion order', () => {
    const first = createWorkerExecutionIdentityDigestV1({
      cwd: '/workspace',
      runtime: HOST_RUNTIME,
      resources: {
        extensionOverrides: { beta: false, alpha: true },
        skillOverrides: { second: false, first: true },
        skillPresentation: {
          second: { icon: 'two', alias: 'B' },
          first: { alias: 'A' },
        },
      },
    })
    const second = createWorkerExecutionIdentityDigestV1({
      cwd: '/workspace',
      runtime: HOST_RUNTIME,
      resources: {
        extensionOverrides: { alpha: true, beta: false },
        skillOverrides: { first: true, second: false },
        skillPresentation: {
          first: { alias: 'A' },
          second: { alias: 'B', icon: 'two' },
        },
      },
    })

    expect(first).toBe(second)
  })

  it('changes when project root, runtime, or resource configuration changes', () => {
    const base = {
      cwd: '/workspace',
      runtime: HOST_RUNTIME,
      resources: {
        extensionOverrides: {},
        skillOverrides: {},
        skillPresentation: {},
      },
    }
    const digest = createWorkerExecutionIdentityDigestV1(base)

    expect(createWorkerExecutionIdentityDigestV1({ ...base, cwd: '/other' })).not.toBe(digest)
    expect(createWorkerExecutionIdentityDigestV1({
      ...base,
      runtime: { mode: 'wsl', distro: 'Ubuntu' },
    })).not.toBe(digest)
    expect(createWorkerExecutionIdentityDigestV1({
      ...base,
      resources: { ...base.resources, skillOverrides: { reviewer: false } },
    })).not.toBe(digest)
  })
})
