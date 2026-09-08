import { describe, expect, it, vi } from 'vitest'

import {
  createHubTaskWorkerServiceV1,
  createInMemoryHubTaskWorkerCredentialsV1,
  type XiaoguiHubTaskWorkerPortV1,
} from './worker-service'
import { createInMemoryHubTaskWorkerStateStoreV1 } from './worker-state'

describe('C2 Hub connection gate', () => {
  it('pairs and persists credentials without starting H1 polling or refreshing tasks', async () => {
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    const port = {
      pairOrReplaceNode: vi.fn(async () => ({
        binding: {
          nodeId: 'node-1', subjectId: 'subject-1', keyId: 'key-1',
          installationIdDigest: `sha256:${'a'.repeat(64)}`,
          publicKeyPem: 'public-key', publicKeyDigest: `sha256:${'b'.repeat(64)}`,
          state: 'ACTIVE' as const, pairedAt: '2026-09-08T00:00:00.000Z', revokedAt: null,
          lastSeenAt: '2026-09-08T00:00:00.000Z',
        },
        deviceToken: 'device-token-0123456789', privateKeyPem: 'private-key-012345678901234567890123456789',
      })),
      pollAssignments: vi.fn(),
    } as unknown as XiaoguiHubTaskWorkerPortV1
    const service = createHubTaskWorkerServiceV1({
      state: createInMemoryHubTaskWorkerStateStoreV1(),
      credentials,
      application: { perform: vi.fn() } as never,
      createPort: () => port,
      taskInboxEnabled: false,
    })

    await expect(service.connect({
      endpoint: 'http://hub.intranet:3000', accessToken: 'a'.repeat(20),
      installationIdDigest: `sha256:${'a'.repeat(64)}`,
    })).resolves.toMatchObject({ ok: true, value: { configured: true, state: 'READY' } })
    expect(port.pairOrReplaceNode).toHaveBeenCalledTimes(1)
    expect(port.pollAssignments).not.toHaveBeenCalled()
    expect(credentials.snapshot()).toMatchObject({ endpoint: 'http://hub.intranet:3000', node: { nodeId: 'node-1' } })
  })
})
