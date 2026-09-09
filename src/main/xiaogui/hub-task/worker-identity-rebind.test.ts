import { expect, it, vi } from 'vitest'
import { createHubTaskWorkerServiceV1, createInMemoryHubTaskWorkerCredentialsV1 } from './worker-service'
import { createInMemoryHubTaskWorkerStateStoreV1 } from './worker-state'
import { HubTaskWorkerHttpErrorV1 } from './http-task-worker-port'
import type { XiaoguiTaskDeliveryReceiptV1 } from '@shared/xiaogui-hub-task-contract'
import type { HubTaskWorkerAssignmentDetailV1 } from './worker-state'
import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'

const now = '2026-09-09T00:00:00.000Z'
const digest = `sha256:${'a'.repeat(64)}`
function credential(nodeId: string) {
  return { endpoint: 'http://hub.intranet:3000', accessToken: 'a'.repeat(20), node: {
    subjectId: 'subject', nodeId, keyId: `key-${nodeId}`, deviceToken: 'device-token-0123456789', privateKeyPem: 'private-key',
  } }
}
function pair(nodeId: string) {
  return { binding: { ...credential(nodeId).node, installationIdDigest: digest, publicKeyPem: 'public-key', publicKeyDigest: digest,
    state: 'ACTIVE', pairedAt: now, revokedAt: null, lastSeenAt: now }, deviceToken: 'device-token-0123456789', privateKeyPem: 'private-key' }
}
function receipt(eventId: string, nodeId: string, sequence: number) {
  return { schemaVersion: 'xiaogui.task-receipt.v1' as const, eventId, assignmentId: 'assignment', taskId: 'task', subjectId: 'subject',
    nodeId, keyId: `key-${nodeId}`, sequence, eventType: 'USER_OPENED' as const, packageSha256: digest,
    occurredAt: now, resultSha256: null, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
}
function ack(r: { eventId: string }) {
  return { receiptId: `ack-${r.eventId}`, eventId: r.eventId, verified: true as const, duplicate: false, occurredAt: now, receivedAt: now }
}

it.each(['AUTHENTICATION_FAILED', 'NODE_REVOKED'] as const)('isolates an in-flight A receipt from B reconnect and retains current %s handling', async code => {
  const state = createInMemoryHubTaskWorkerStateStoreV1()
  const credentials = createInMemoryHubTaskWorkerCredentialsV1()
  credentials.write(credential('a'))
  const old = receipt('old', 'a', 1)
  state.enqueueReceipt(old, now)
  const oldBytes = JSON.stringify(state.pendingEvidence()[0])
  let failA!: (error: Error) => void
  const inFlightA = new Promise<never>((_, reject) => { failA = reject })
  const submitA = vi.fn(() => inFlightA)
  const submitB = vi.fn(async (r: ReturnType<typeof receipt>) => ack(r))
  const service = createHubTaskWorkerServiceV1({ state, credentials, application: { perform: vi.fn() } as never,
    createPort: bundle => ({
      pairOrReplaceNode: async () => { state.enqueueReceipt(receipt('new', 'b', 2), now); return pair('b') },
      submitReceipt: 'node' in bundle && bundle.node.nodeId === 'a' ? submitA : submitB,
      pollAssignments: async () => ({ cursor: null, assignments: [] }),
    }) as never,
  })
  const first = service.refresh()
  await vi.waitFor(() => expect(submitA).toHaveBeenCalledOnce())
  const reconnect = service.connect({ endpoint: 'http://hub.intranet:3000', accessToken: 'b'.repeat(20), installationIdDigest: digest })
  await vi.waitFor(() => expect(credentials.read()?.node.nodeId).toBe('b'))
  failA(new HubTaskWorkerHttpErrorV1(code))
  await Promise.all([first, reconnect])
  expect(credentials.read()?.node.nodeId).toBe('b')
  expect(submitB).toHaveBeenCalledOnce()
  expect(JSON.stringify(state.pendingEvidence()[0])).toBe(oldBytes)
  submitB.mockRejectedValue(new HubTaskWorkerHttpErrorV1(code))
  state.enqueueReceipt(receipt('current-failure', 'b', 3), now)
  await service.refresh()
  expect(credentials.read()).toBeNull()
  expect(service.status().state).toBe(code)
  service.close()
})

it.each(['tracked', 'legacy'] as const)('rebinds a %s accepted unstarted assignment with current NODE_STORED then manual USER_OPENED before START', async origin => {
  const state = createInMemoryHubTaskWorkerStateStoreV1()
  const credentials = createInMemoryHubTaskWorkerCredentialsV1()
  credentials.write(credential('a'))
  let activeNode = 'a'
  const detail: HubTaskWorkerAssignmentDetailV1 = {
    assignment: { assignmentId: 'assignment', taskId: 'task', decisionState: 'ACCEPTED', deliveryState: 'QUEUED', executionState: 'NOT_STARTED', createdAt: now, updatedAt: now },
    offer: { taskId: 'task', mode: 'DIRECT', title: 'task', taskContent: 'content', constraints: [], acceptanceRequirements: [], attachmentRefs: [], packageSha256: digest },
  }
  const accepted: Array<{ node: string; type: string }> = []
  const lastSequence = new Map<string, number>()
  const service = createHubTaskWorkerServiceV1({ state, credentials, application: { perform: vi.fn() } as never,
    signReceipt: unsigned => ({ ...unsigned, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
    createPort: bundle => ({
      pairOrReplaceNode: async () => { activeNode = 'b'; detail.assignment.deliveryState = 'QUEUED'; return pair('b') },
      pollAssignments: async () => ({ cursor: null, assignments: [{ ...detail.assignment }] }),
      downloadAssignment: async () => structuredClone(detail),
      submitReceipt: async (r: XiaoguiTaskDeliveryReceiptV1) => {
        // Fixed Hub70 claims, task binding, sequence and start preconditions.
        if (!('node' in bundle) || bundle.node.nodeId !== activeNode || r.subjectId !== 'subject' || r.nodeId !== activeNode || r.keyId !== `key-${activeNode}`
          || r.assignmentId !== 'assignment' || r.taskId !== 'task' || r.packageSha256 !== digest
          || r.sequence <= (lastSequence.get(r.keyId) ?? 0)) throw new HubTaskWorkerHttpErrorV1('STATE_CONFLICT')
        if (r.eventType === 'EXECUTION_STARTED' && (detail.assignment.decisionState !== 'ACCEPTED'
          || detail.assignment.deliveryState !== 'OPENED' || detail.assignment.executionState !== 'NOT_STARTED')) throw new HubTaskWorkerHttpErrorV1('STATE_CONFLICT')
        if (r.eventType === 'NODE_STORED' && detail.assignment.deliveryState === 'QUEUED') detail.assignment.deliveryState = 'NODE_STORED'
        if (r.eventType === 'USER_OPENED') detail.assignment.deliveryState = 'OPENED'
        if (r.eventType === 'EXECUTION_STARTED') detail.assignment.executionState = 'RUNNING'
        lastSequence.set(r.keyId, r.sequence)
        accepted.push({ node: activeNode, type: r.eventType })
        return ack(r)
      },
    }) as never,
  })
  if (origin === 'legacy') {
    detail.assignment.deliveryState = 'OPENED'
    state.upsertAssignment(detail)
    state.markOpened('assignment', now)
  } else {
    await service.refresh()
    await service.openAssignment('assignment')
    await service.refresh()
  }
  const address = { projectId: `xgp1_${'a'.repeat(64)}`, sessionKey: `xgs1_${'b'.repeat(64)}` } as HubAddressV1
  state.bindPlanDraft('assignment', { ...address, flowId: 'flow', revisionId: 'revision', createdAt: now })
  state.enqueueReceipt(receipt('historical', 'a', 99), now)
  const historicalBytes = JSON.stringify(state.pendingEvidence()[0])
  await service.connect({ endpoint: 'http://hub.intranet:3000', accessToken: 'b'.repeat(20), installationIdDigest: digest })
  await service.refresh()
  expect(accepted.filter(e => e.node === 'b')).toEqual([{ node: 'b', type: 'NODE_STORED' }])
  expect(service.listInbox()[0]?.openedAt).toBeNull()
  expect(service.listInbox()[0]?.localPlanDraft?.flowId).toBe('flow')
  const reopenedState = createInMemoryHubTaskWorkerStateStoreV1(state.snapshot())
  expect(reopenedState.requireAssignment('assignment').deliveryIdentity?.nodeId).toBe('b')
  expect(reopenedState.requireAssignment('assignment').openedAt).toBeNull()
  await service.openAssignment('assignment')
  await service.refresh()
  await service.recordExecutionStarted(address, 'flow')
  await service.refresh()
  expect(accepted.filter(e => e.node === 'b').map(e => e.type)).toEqual(['NODE_STORED', 'USER_OPENED', 'EXECUTION_STARTED'])
  expect(detail.assignment.executionState).toBe('RUNNING')
  expect(JSON.stringify(state.pendingEvidence()[0])).toBe(historicalBytes)
  // A valid old-node ACK may arrive late; it cannot confirm B's local open.
  state.markOpened('assignment', now)
  expect(state.acknowledgeReceipt('historical', ack({ eventId: 'historical' }), credential('a').node)).toBe(true)
  expect(state.requireAssignment('assignment').localDeliveryState).toBe('PENDING_H1_4_RECEIPT')
  service.close()
})

it.each(['RUNNING', 'OUTCOME_UNKNOWN'] as const)('does not restart a retired-node %s assignment during replacement', async executionState => {
  const state = createInMemoryHubTaskWorkerStateStoreV1()
  const credentials = createInMemoryHubTaskWorkerCredentialsV1()
  credentials.write(credential('a'))
  state.upsertAssignment({ assignment: { assignmentId: 'assignment', taskId: 'task', decisionState: 'ACCEPTED', deliveryState: 'OPENED', executionState, createdAt: now, updatedAt: now },
    offer: { taskId: 'task', mode: 'DIRECT', title: 'task', taskContent: 'content', constraints: [], acceptanceRequirements: [], attachmentRefs: [], packageSha256: digest } }, credential('a').node)
  state.markOpened('assignment', now)
  const old = receipt('history', 'a', 1)
  state.enqueueReceipt(old, now)
  const oldBytes = JSON.stringify(state.pendingEvidence())
  const submitReceipt = vi.fn(async () => { throw new Error('new node cannot receive retired running work') })
  const perform = vi.fn()
  const service = createHubTaskWorkerServiceV1({ state, credentials, application: { perform } as never,
    createPort: () => ({ pairOrReplaceNode: async () => pair('b'),
      // Hub70 retains these tasks on the retired node, never assigns them to B.
      pollAssignments: async () => ({ cursor: null, assignments: [] }), submitReceipt }) as never,
  })
  await service.connect({ endpoint: 'http://hub.intranet:3000', accessToken: 'b'.repeat(20), installationIdDigest: digest })
  expect(service.listInbox()).toEqual([])
  expect(submitReceipt).not.toHaveBeenCalled()
  expect(perform).not.toHaveBeenCalled()
  expect(JSON.stringify(state.pendingEvidence())).toBe(oldBytes)
  service.close()
})
