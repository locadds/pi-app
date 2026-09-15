import { generateKeyPairSync } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'

import { registerHubTaskWorkerHandlers } from './worker-ipc'
import {
  createInMemoryHubTaskWorkerCredentialsV1,
} from './worker-service'
import { createInMemoryHubTaskWorkerStateStoreV1 } from './worker-state'
import { createHubTaskWorkerCompositionV1 } from './worker-composition'

const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
vi.mock('../../ipc/registry', () => ({
  registerHandler: vi.fn((channel: string, handler: (payload: unknown) => Promise<unknown>) => {
    handlers.set(channel, handler)
  }),
}))
vi.mock('../task-hub/ipc', () => ({
  getDefaultCollaborationHubApplication: vi.fn(),
  getDefaultHubTaskAcceptAndExecuteTrustedPortV2: vi.fn(),
}))

const ADDRESS = {
  projectId: `xgp1_${'a'.repeat(64)}`,
  sessionKey: `xgs1_${'b'.repeat(64)}`,
} as HubAddressV1
const PACKAGE = `sha256:${'c'.repeat(64)}`
const IDENTITY = { subjectId: 'subject-1', nodeId: 'node-1', keyId: 'key-1' }
const PRIVATE_KEY_PEM = generateKeyPairSync('ed25519').privateKey
  .export({ format: 'pem', type: 'pkcs8' })
  .toString()

afterEach(() => {
  handlers.clear()
})

describe('Hub Task V2 IPC composition seam', () => {
  it('runs the real Worker service authorization path behind the registered handler', async () => {
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    state.upsertAssignment(detail('PENDING'), IDENTITY)
    state.markOpened('assignment-1', '2026-09-15T00:00:00.000Z')

    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    credentials.write({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'a'.repeat(20),
      node: { ...IDENTITY, deviceToken: 'device-token-1', privateKeyPem: PRIVATE_KEY_PEM },
    })
    const submitDecision = vi.fn(async () => detail('ACCEPTED'))
    const execute = vi.fn(async () => ({
      ok: true as const,
      flowId: 'flow-v2',
      revisionId: 'revision-v2',
      attemptId: 'attempt-v2',
      attemptStatus: 'STARTING',
      executionState: 'STARTED' as const,
    }))
    const service = createHubTaskWorkerCompositionV1({
      state,
      credentials,
      application: { perform: vi.fn() } as never,
      createPort: () => ({
        downloadAssignment: vi.fn(async () => detail('PENDING')),
        submitDecision,
        submitReceipt: vi.fn(async (receipt: { receiptId: string; eventId: string; occurredAt: string }) => ({
          receiptId: receipt.receiptId,
          eventId: receipt.eventId,
          verified: true as const,
          duplicate: false,
          occurredAt: receipt.occurredAt,
          receivedAt: '2026-09-15T00:00:01.000Z',
        })),
      }) as never,
      acceptAndExecuteV2: {
        resolveTarget: vi.fn(async () => ({
          ok: true as const,
          targetProjectIdentity: 'project-main-1',
          baselineSourceDigest: `sha256:${'d'.repeat(64)}`,
          authorityDatabaseIdentity: 'authority-main-1',
        })),
        recoverAssociation: vi.fn(async () => ({ status: 'NOT_DISPATCHED' as const })),
        execute,
      },
    })

    registerHubTaskWorkerHandlers(service, `sha256:${'e'.repeat(64)}`)
    const payload = {
      assignmentId: 'assignment-1',
      address: ADDRESS,
      observedPackageSha256: PACKAGE,
      requestId: 'request-v2',
    }
    await expect(handlers.get('ipc:xiaogui.hubTask.inbox.acceptAndExecute')!(payload)).resolves.toEqual({
      ok: true,
      value: {
        executionState: 'STARTED',
        actualAttemptStatus: 'STARTING',
        flowId: 'flow-v2',
        revisionId: 'revision-v2',
        attemptId: 'attempt-v2',
      },
    })
    expect(submitDecision).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()

    const listResult = await handlers.get('ipc:xiaogui.hubTask.inbox.list')!(undefined) as {
      ok: true
      value: Array<Record<string, unknown>>
    }
    expect(listResult.value[0]).toMatchObject({
      assignmentId: 'assignment-1',
      acceptAndExecuteV2: {
        state: 'BOUND',
        requestId: 'request-v2',
        observedPackageSha256: PACKAGE,
        projectId: ADDRESS.projectId,
        sessionKey: ADDRESS.sessionKey,
        flowId: 'flow-v2',
        revisionId: 'revision-v2',
        attemptId: 'attempt-v2',
      },
    })
    expect(listResult.value[0]).not.toHaveProperty('subjectId')
    expect(listResult.value[0]).not.toHaveProperty('nodeId')
    expect(listResult.value[0]).not.toHaveProperty('keyId')
    expect(listResult.value[0]).not.toHaveProperty('targetProjectIdentity')
  })
})

function detail(decisionState: 'PENDING' | 'ACCEPTED') {
  return {
    assignment: {
      assignmentId: 'assignment-1',
      taskId: 'task-1',
      decisionState,
      deliveryState: 'OPENED' as const,
      executionState: 'NOT_STARTED' as const,
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
    },
    offer: {
      taskId: 'task-1',
      mode: 'DIRECT' as const,
      title: 'task',
      taskContent: 'trusted body',
      constraints: ['constraint'],
      acceptanceRequirements: ['acceptance'],
      attachmentRefs: [],
      packageSha256: PACKAGE,
    },
  }
}
