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

  it('flushes the current node queue behind retained evidence from a replaced node', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    state.enqueueReceipt(receipt('old-event', 1, 'old-subject', 'old-node', 'old-key'), '2026-09-09T00:00:00.000Z')
    state.enqueueReceipt(receipt('new-event', 2, 'new-subject', 'new-node', 'new-key'), '2026-09-09T00:00:01.000Z')
    const oldBytes = JSON.stringify(state.pendingEvidence()[0])
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    credentials.write(credentialsFor('new-subject', 'new-node', 'new-key'))
    const submitReceipt = vi.fn(async (submitted) => {
      if (submitted.nodeId !== 'new-node') throw new HubTaskWorkerHttpErrorV1('STATE_CONFLICT')
      return receiptAck(submitted)
    })
    const service = createHubTaskWorkerServiceV1({
      state, credentials, application: { perform: vi.fn() } as never,
      createPort: () => ({ submitReceipt, pollAssignments: vi.fn(async () => ({ cursor: null, assignments: [] })) }) as never,
    })

    await expect(service.refresh()).resolves.toMatchObject({ ok: true })

    expect(submitReceipt).toHaveBeenCalledOnce()
    expect(submitReceipt).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'new-event', nodeId: 'new-node' }))
    expect(state.pendingEvidence()).toEqual([expect.objectContaining({ kind: 'RECEIPT', receipt: expect.objectContaining({ eventId: 'old-event', nodeId: 'old-node' }) })])
    expect(JSON.stringify(state.pendingEvidence()[0])).toBe(oldBytes)
    service.close()
  })

  it('keeps unacknowledged evidence when newly paired credentials cannot be persisted', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    state.enqueueReceipt(receipt('old-event', 1, 'old-subject', 'old-node', 'old-key'), '2026-09-09T00:00:00.000Z')
    const oldBytes = JSON.stringify(state.pendingEvidence()[0])
    const credentials = {
      read: vi.fn(() => null), canPersist: vi.fn(() => true), write: vi.fn(() => false), clear: vi.fn(),
    }
    const service = createHubTaskWorkerServiceV1({
      state, credentials, application: { perform: vi.fn() } as never,
      createPort: () => ({ pairOrReplaceNode: vi.fn(async () => pairResponse('new-subject', 'new-node', 'new-key')) }) as never,
    })

    await expect(service.connect({ endpoint: 'http://hub.intranet:3000', accessToken: 'a'.repeat(20), installationIdDigest: `sha256:${'a'.repeat(64)}` }))
      .resolves.toEqual({ ok: false, code: 'HUB_WORKER_CREDENTIAL_STORAGE_UNAVAILABLE' })

    expect(state.pendingEvidence()).toHaveLength(1)
    expect(JSON.stringify(state.pendingEvidence()[0])).toBe(oldBytes)
    expect(service.status()).toMatchObject({ configured: false, state: 'UNCONFIGURED', pendingReceiptCount: 1 })
  })

  it('does not create a local plan from accepted cached work after a 403 restart leaves no current identity', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    state.upsertAssignment(acceptedOpenedAssignment())
    state.markOpened('assignment-1', '2026-09-09T00:00:00.000Z')
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    credentials.write(credentialsFor('old-subject', 'old-node', 'old-key'))
    const revoked = createHubTaskWorkerServiceV1({
      state, credentials, application: { perform: vi.fn() } as never,
      createPort: () => ({ pollAssignments: vi.fn(async () => { throw new HubTaskWorkerHttpErrorV1('NODE_REVOKED') }) }) as never,
    })
    await expect(revoked.refresh()).resolves.toEqual({ ok: false, code: 'HUB_WORKER_NODE_REVOKED' })
    const perform = vi.fn(async () => ({ ok: true, value: { flowId: 'flow-1', revisionId: 'revision-1' } }))
    const restarted = createHubTaskWorkerServiceV1({ state, credentials, application: { perform } as never, createPort: () => ({} as never) })

    await expect(restarted.createPlanDraft('assignment-1', address())).resolves.toEqual({ ok: false, code: 'HUB_WORKER_UNCONFIGURED' })
    expect(perform).not.toHaveBeenCalled()
  })

  it('requires the current-token assignment response to match the cached accepted task before drafting', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    state.upsertAssignment(acceptedOpenedAssignment())
    state.markOpened('assignment-1', '2026-09-09T00:00:00.000Z')
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    credentials.write(credentialsFor('new-subject', 'new-node', 'new-key'))
    const perform = vi.fn(async () => ({ ok: true, value: { flowId: 'flow-1', revisionId: 'revision-1' } }))
    const mismatched = acceptedOpenedAssignment()
    mismatched.assignment.assignmentId = 'assignment-other'
    const service = createHubTaskWorkerServiceV1({
      state, credentials, application: { perform } as never,
      createPort: () => ({ downloadAssignment: vi.fn(async () => mismatched) }) as never,
    })

    await expect(service.createPlanDraft('assignment-1', address())).resolves.toEqual({ ok: false, code: 'HUB_ASSIGNMENT_NOT_READY' })
    expect(perform).not.toHaveBeenCalled()
    mismatched.assignment.assignmentId = 'assignment-1'
    await expect(service.createPlanDraft('assignment-1', address())).resolves.toEqual({ ok: true, value: { flowId: 'flow-1', revisionId: 'revision-1' } })
    expect(perform).toHaveBeenCalledOnce()
  })

  it('uploads a current-identity RESULT without letting an older receipt block its exact ACK', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    state.enqueueReceipt(receipt('old-event', 1, 'old-subject', 'old-node', 'old-key'), '2026-09-09T00:00:00.000Z')
    state.enqueueResult(resultSubmission('new-result-event', 'new-result', 2, 'new-subject', 'new-node', 'new-key'), '2026-09-09T00:00:01.000Z')
    const oldBytes = JSON.stringify(state.pendingEvidence()[0])
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    credentials.write(credentialsFor('new-subject', 'new-node', 'new-key'))
    const submitResult = vi.fn(async (submission) => ({
      resultId: submission.result.resultId, eventId: submission.receipt.eventId, verified: true as const,
      duplicate: false, executionState: 'RESULT_READY' as const,
      occurredAt: submission.result.occurredAt, receivedAt: '2026-09-09T00:01:00.000Z',
    }))
    const service = createHubTaskWorkerServiceV1({
      state, credentials, application: { perform: vi.fn() } as never,
      createPort: () => ({ submitResult, pollAssignments: vi.fn(async () => ({ cursor: null, assignments: [] })) }) as never,
    })

    await expect(service.refresh()).resolves.toMatchObject({ ok: true })

    expect(submitResult).toHaveBeenCalledOnce()
    expect(state.pendingEvidence()).toHaveLength(1)
    expect(JSON.stringify(state.pendingEvidence()[0])).toBe(oldBytes)
    service.close()
  })

  it('does not let a late old-port failure restore configured after a 401 cleared credentials', async () => {
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    const old = credentialsFor('old-subject', 'old-node', 'old-key')
    credentials.write(old)
    let rejectOldPoll!: (error: Error) => void
    const oldPoll = new Promise<never>((_resolve, reject) => { rejectOldPoll = reject })
    const createPort = vi.fn()
      .mockReturnValueOnce({ pollAssignments: vi.fn(() => oldPoll) })
      .mockReturnValueOnce({ pollAssignments: vi.fn(async () => { throw new HubTaskWorkerHttpErrorV1('AUTHENTICATION_FAILED') }) })
    const service = createHubTaskWorkerServiceV1({
      state: createInMemoryHubTaskWorkerStateStoreV1(), credentials, application: { perform: vi.fn() } as never,
      createPort,
    })
    const first = service.refresh()
    await vi.waitFor(() => expect(createPort).toHaveBeenCalledOnce())
    await expect(service.refresh()).resolves.toEqual({ ok: false, code: 'HUB_WORKER_AUTHENTICATION_FAILED' })

    rejectOldPoll(new HubTaskWorkerHttpErrorV1('STATE_CONFLICT'))
    await expect(first).resolves.toEqual({ ok: false, code: 'HUB_WORKER_STATE_CONFLICT' })

    expect(service.status()).toMatchObject({ configured: false, state: 'AUTHENTICATION_FAILED' })
  })
})

function credentialsFor(subjectId: string, nodeId: string, keyId: string) {
  return { endpoint: 'http://hub.intranet:3000', accessToken: 'a'.repeat(20), node: { subjectId, nodeId, keyId, deviceToken: 'device-token-0123456789', privateKeyPem: 'private-key' } }
}

function receipt(eventId: string, sequence: number, subjectId: string, nodeId: string, keyId: string) {
  return { schemaVersion: 'xiaogui.task-receipt.v1' as const, eventId, assignmentId: 'assignment-1', taskId: 'task-1', subjectId, nodeId, keyId, eventType: 'USER_OPENED' as const, packageSha256: `sha256:${'c'.repeat(64)}`, occurredAt: '2026-09-09T00:00:00.000Z', sequence, resultSha256: null, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
}

function receiptAck(value: { eventId: string; occurredAt: string }) {
  return { receiptId: `receipt-${value.eventId}`, eventId: value.eventId, verified: true as const, duplicate: false, occurredAt: value.occurredAt, receivedAt: '2026-09-09T00:01:00.000Z' }
}

function pairResponse(subjectId: string, nodeId: string, keyId: string) {
  return {
    binding: {
      subjectId, nodeId, keyId, installationIdDigest: `sha256:${'a'.repeat(64)}`,
      publicKeyPem: 'public-key', publicKeyDigest: `sha256:${'b'.repeat(64)}`,
      state: 'ACTIVE' as const, pairedAt: '2026-09-09T00:00:00.000Z', revokedAt: null,
      lastSeenAt: '2026-09-09T00:00:00.000Z',
    },
    deviceToken: 'device-token-0123456789', privateKeyPem: 'private-key-012345678901234567890123456789',
  }
}

function acceptedOpenedAssignment() {
  return { assignment: { assignmentId: 'assignment-1', taskId: 'task-1', decisionState: 'ACCEPTED' as const, deliveryState: 'OPENED' as const, executionState: 'NOT_STARTED' as const, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' }, offer: { taskId: 'task-1', mode: 'DIRECT' as const, title: 'task', taskContent: 'content', constraints: [], acceptanceRequirements: [], attachmentRefs: [], packageSha256: `sha256:${'c'.repeat(64)}` }, openedAt: '2026-09-09T00:00:00.000Z', localDeliveryState: 'HUB_CONFIRMED' as const, localPlanDraft: null }
}

function resultSubmission(eventId: string, resultId: string, sequence: number, subjectId: string, nodeId: string, keyId: string) {
  const occurredAt = '2026-09-09T00:00:00.000Z'
  const resultSha256 = `sha256:${'d'.repeat(64)}`
  return {
    result: { schemaVersion: 'xiaogui.task-result.v1' as const, resultId, assignmentId: 'assignment-1', taskId: 'task-1', outcome: 'RESULT_READY' as const, resultSummary: 'ready', artifactRefs: [], verification: { verdict: 'PASS' as const, summary: 'pass' }, occurredAt, resultSha256 },
    receipt: { ...receipt(eventId, sequence, subjectId, nodeId, keyId), eventType: 'RESULT_READY' as const, occurredAt, resultSha256 },
  }
}

function address() {
  return { projectId: `xgp1_${'a'.repeat(64)}`, sessionKey: `xgs1_${'b'.repeat(64)}` } as never
}
