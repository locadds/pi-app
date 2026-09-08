import { describe, expect, it, vi } from 'vitest'

import {
  createHubTaskWorkerServiceV1,
  createInMemoryHubTaskWorkerCredentialsV1,
  type XiaoguiHubTaskWorkerPortV1,
} from './worker-service'
import { createInMemoryHubTaskWorkerStateStoreV1 } from './worker-state'
import { HubTaskWorkerHttpErrorV1 } from './http-task-worker-port'

describe('H1 Hub connection lifecycle', () => {
  it('pairs, persists credentials, and immediately restores the inbox poll', async () => {
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
      pollAssignments: vi.fn(async () => ({ cursor: null, assignments: [] })),
    } as unknown as XiaoguiHubTaskWorkerPortV1
    const service = createHubTaskWorkerServiceV1({
      state: createInMemoryHubTaskWorkerStateStoreV1(),
      credentials,
      application: { perform: vi.fn() } as never,
      createPort: () => port,
    })

    await expect(service.connect({
      endpoint: 'http://hub.intranet:3000', accessToken: 'a'.repeat(20),
      installationIdDigest: `sha256:${'a'.repeat(64)}`,
    })).resolves.toMatchObject({ ok: true, value: { configured: true, state: 'READY' } })
    expect(port.pairOrReplaceNode).toHaveBeenCalledTimes(1)
    expect(port.pollAssignments).toHaveBeenCalledOnce()
    expect(credentials.snapshot()).toMatchObject({ endpoint: 'http://hub.intranet:3000', node: { nodeId: 'node-1' } })
    service.close()
  })

  it.each(['AUTHENTICATION_FAILED', 'NODE_REVOKED'] as const)(
    'retains signed pending evidence and requires explicit re-login after %s',
    async (failureCode) => {
      const state = createInMemoryHubTaskWorkerStateStoreV1()
      state.upsertAssignment({
        assignment: {
          assignmentId: 'assignment-1', taskId: 'task-1', decisionState: 'PENDING', deliveryState: 'NODE_STORED',
          executionState: 'NOT_STARTED', createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
        },
        offer: { taskId: 'task-1', mode: 'DIRECT', title: 'task', taskContent: 'content', constraints: [], acceptanceRequirements: [], attachmentRefs: [], packageSha256: `sha256:${'c'.repeat(64)}` },
      })
      const credentials = createInMemoryHubTaskWorkerCredentialsV1()
      credentials.write({
        endpoint: 'http://hub.intranet:3000', accessToken: 'a'.repeat(20),
        node: { subjectId: 'subject-1', nodeId: 'node-1', keyId: 'key-1', deviceToken: 'device-token-0123456789', privateKeyPem: 'private-key' },
      })
      let signedJson = ''
      const submitReceipt = vi.fn(async (receipt: unknown) => {
        expect(JSON.stringify(receipt)).toBe(signedJson)
        throw new HubTaskWorkerHttpErrorV1(failureCode)
      })
      const service = createHubTaskWorkerServiceV1({
        state,
        credentials,
        application: { perform: vi.fn() } as never,
        createPort: () => ({ submitReceipt }) as never,
        signReceipt: (unsigned) => {
          const signed = { ...unsigned, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
          signedJson = JSON.stringify(signed)
          return signed
        },
      })

      await expect(service.openAssignment('assignment-1')).resolves.toMatchObject({ ok: true })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(credentials.snapshot()).toBeNull()
      expect(state.pendingEvidence()).toHaveLength(1)
      expect(state.pendingEvidence()[0]).toMatchObject({ kind: 'RECEIPT', receipt: { eventType: 'USER_OPENED' } })
      const pending = state.pendingEvidence()[0]
      expect(pending?.kind).toBe('RECEIPT')
      if (pending?.kind === 'RECEIPT') expect(JSON.stringify(pending.receipt)).toBe(signedJson)
      expect(submitReceipt).toHaveBeenCalledOnce()
      expect(service.status()).toMatchObject({ configured: false, state: failureCode, pendingReceiptCount: 1 })
      service.close()
    },
  )
})
