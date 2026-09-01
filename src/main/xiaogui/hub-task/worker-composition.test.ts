import { describe, expect, it } from 'vitest'

import { installationIdDigestV1 } from './worker-installation'

describe('HubTaskWorkerCompositionV1', () => {
  it('derives a one-way installation digest without returning the user-data path', () => {
    const digest = installationIdDigestV1('D:/private/user-data')
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(digest).not.toContain('private')
    expect(digest).toBe(installationIdDigestV1('D:/private/user-data'))
    expect(digest).not.toBe(installationIdDigestV1('D:/private/other-user-data'))
  })
})
