import { expect, it, vi } from 'vitest'
import { createHubTaskWorkerServiceV1, createInMemoryHubTaskWorkerCredentialsV1 } from './worker-service'
import { createInMemoryHubTaskWorkerStateStoreV1 } from './worker-state'

it('persists NOT_RUN through the real worker terminal mapper without fabricating failed verification', async () => {
  const state = createInMemoryHubTaskWorkerStateStoreV1()
  const credentials = createInMemoryHubTaskWorkerCredentialsV1()
  credentials.write({ endpoint: 'http://hub.intranet:3000', accessToken: 'a'.repeat(20), node: {
    subjectId: 'subject-1', nodeId: 'node-1', keyId: 'key-1', deviceToken: 'device-token-0123456789', privateKeyPem: 'private-key',
  } })
  const address = { projectId: `xgp1_${'a'.repeat(64)}`, sessionKey: `xgs1_${'b'.repeat(64)}` } as const
  state.upsertAssignment({ assignment: {
    assignmentId: 'assignment-1', taskId: 'task-1', decisionState: 'ACCEPTED', deliveryState: 'OPENED',
    executionState: 'RUNNING', createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
  }, offer: { taskId: 'task-1', mode: 'DIRECT', title: 'task', taskContent: 'content', constraints: [], acceptanceRequirements: [], attachmentRefs: [], packageSha256: `sha256:${'c'.repeat(64)}` } })
  state.markOpened('assignment-1', '2026-09-09T00:00:00.000Z')
  state.bindPlanDraft('assignment-1', { ...address, flowId: 'flow-1', revisionId: 'revision-1', createdAt: '2026-09-09T00:00:00.000Z' } as never)
  const service = createHubTaskWorkerServiceV1({
    state, credentials, application: { perform: vi.fn() } as never,
    createPort: () => ({ submitResult: async () => { throw new Error('offline') } }) as never,
    signReceipt: unsigned => ({ ...unsigned, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
  })
  await service.reportExecutionOutcome(address as never, 'flow-1', { verificationState: 'NOT_RUN' })
  expect(state.pendingEvidence()).toContainEqual(expect.objectContaining({
    kind: 'RESULT', submission: expect.objectContaining({ result: expect.objectContaining({
      outcome: 'EXECUTION_FAILED', verification: { verdict: 'NOT_RUN', summary: '未进入受控验证阶段。' },
    }) }),
  }))
  service.close()
})
