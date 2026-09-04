import { describe, expect, it, vi } from 'vitest'

import {
  createHttpXiaoguiHubTaskWorkerPortV1,
  HubTaskWorkerHttpErrorV1,
  loginHubTaskWorkerAccountV1,
} from './http-task-worker-port'

const PACKAGE_SHA256 = `sha256:${'a'.repeat(64)}`

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('HttpXiaoguiHubTaskWorkerPortV1', () => {
  it('exchanges a Hub account password for a main-process-only access token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      data: { token: 'hub-account-token-never-returned-to-renderer' },
    }))

    await expect(loginHubTaskWorkerAccountV1({
      endpoint: 'http://hub.intranet:3000',
      username: 'planner.a',
      password: 'correct-horse-battery-staple',
      fetchImpl,
    })).resolves.toEqual({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'hub-account-token-never-returned-to-renderer',
    })
    expect(fetchImpl).toHaveBeenCalledWith('http://hub.intranet:3000/api/v1/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'planner.a', password: 'correct-horse-battery-staple' }),
    }))
  })

  it('pairs with the account credential only, then polls via the distinct node-token header', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({
        data: {
          binding: {
            nodeId: 'xgh_node_1',
            subjectId: 'xgh_subject_1',
            installationIdDigest: `sha256:${'b'.repeat(64)}`,
            keyId: 'ed25519:test-key',
            publicKeyPem: 'PUBLIC',
            publicKeyDigest: `sha256:${'c'.repeat(64)}`,
            state: 'ACTIVE',
            pairedAt: '2026-09-01T00:00:00.000Z',
            revokedAt: null,
            lastSeenAt: '2026-09-01T00:00:00.000Z',
          },
          deviceToken: 'one-time-node-token',
          privateKeyPem: 'PRIVATE',
        },
      }))
      .mockResolvedValueOnce(response({
        data: {
          schemaVersion: 'xiaogui.hub.worker-assignment-snapshot.v1',
          cursor: 'snapshot:1',
          assignments: [{
            schemaVersion: 'xiaogui.hub.worker-assignment.v1',
            assignmentId: 'xgh_assignment_1',
            taskId: 'xgh_task_1',
            decisionState: 'PENDING',
            deliveryState: 'QUEUED',
            executionState: 'NOT_STARTED',
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
          }],
        },
      }))

    const pairingPort = createHttpXiaoguiHubTaskWorkerPortV1({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'account-jwt',
      fetchImpl,
    })
    const paired = await pairingPort.pairOrReplaceNode({ installationIdDigest: `sha256:${'b'.repeat(64)}` })
    const workerPort = createHttpXiaoguiHubTaskWorkerPortV1({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'account-jwt',
      node: { deviceToken: paired.deviceToken },
      fetchImpl,
    })
    const snapshot = await workerPort.pollAssignments(null)

    expect(snapshot).toEqual(expect.objectContaining({ cursor: 'snapshot:1', assignments: [expect.objectContaining({ assignmentId: 'xgh_assignment_1' })] }))
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://hub.intranet:3000/api/v2/taskhub/nodes/pair')
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer account-jwt' }),
    }))
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-xiaogui-node-token')
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('http://hub.intranet:3000/api/v2/taskhub/worker/assignments')
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        authorization: 'Bearer account-jwt',
        'x-xiaogui-node-token': 'one-time-node-token',
      }),
    }))
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).not.toHaveProperty('x-xiaogui-device-token')
  })

  it('maps a rejected worker request to a safe error without forwarding the response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: { code: 'UNAUTHENTICATED', message: 'token details' } }, 401))
    const port = createHttpXiaoguiHubTaskWorkerPortV1({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'account-jwt',
      node: { deviceToken: 'node-token' },
      fetchImpl,
    })

    await expect(port.pollAssignments(null)).rejects.toEqual(
      expect.objectContaining<Partial<HubTaskWorkerHttpErrorV1>>({ code: 'AUTHENTICATION_FAILED' }),
    )
  })

  it('submits only the signed receipt envelope and accepts an idempotent Hub acknowledgement', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      data: {
        receiptId: 'xgh_receipt_1',
        eventId: 'xgh_event_1',
        verified: true,
        duplicate: true,
        occurredAt: '2026-09-01T00:01:00.000Z',
        receivedAt: '2026-09-01T00:02:00.000Z',
      },
    }))
    const port = createHttpXiaoguiHubTaskWorkerPortV1({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'account-jwt',
      node: { deviceToken: 'node-token' },
      fetchImpl,
    })

    await expect(port.submitReceipt({
      schemaVersion: 'xiaogui.task-receipt.v1',
      eventId: 'xgh_event_1',
      assignmentId: 'xgh_assignment_1',
      taskId: 'xgh_task_1',
      subjectId: 'xgh_subject_1',
      nodeId: 'xgh_node_1',
      keyId: 'ed25519:test-key',
      eventType: 'USER_OPENED',
      packageSha256: PACKAGE_SHA256,
      occurredAt: '2026-09-01T00:01:00.000Z',
      sequence: 2,
      resultSha256: null,
      signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    })).resolves.toEqual({
      receiptId: 'xgh_receipt_1',
      eventId: 'xgh_event_1',
      verified: true,
      duplicate: true,
      occurredAt: '2026-09-01T00:01:00.000Z',
      receivedAt: '2026-09-01T00:02:00.000Z',
    })

    expect(fetchImpl).toHaveBeenCalledWith('http://hub.intranet:3000/api/v2/taskhub/worker/receipts', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer account-jwt',
        'x-xiaogui-node-token': 'node-token',
      }),
    }))
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body).toEqual(expect.objectContaining({
      eventId: 'xgh_event_1',
      signature: expect.any(String),
    }))
    expect(body).not.toHaveProperty('privateKeyPem')
    expect(body).not.toHaveProperty('deviceToken')
  })

  it('uploads a controlled result together with its terminal signed receipt and validates the ResultAck', async () => {
    const resultSha256 = `sha256:${'b'.repeat(64)}`
    const fetchImpl = vi.fn().mockResolvedValue(response({
      data: {
        resultId: 'xgh_result_1',
        eventId: 'xgh_event_result_1',
        verified: true,
        duplicate: false,
        executionState: 'RESULT_READY',
        occurredAt: '2026-09-01T00:01:00.000Z',
        receivedAt: '2026-09-01T00:02:00.000Z',
      },
    }))
    const port = createHttpXiaoguiHubTaskWorkerPortV1({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'account-jwt',
      node: { deviceToken: 'node-token' },
      fetchImpl,
    })
    await expect(port.submitResult({
      result: {
        schemaVersion: 'xiaogui.task-result.v1',
        resultId: 'xgh_result_1',
        assignmentId: 'xgh_assignment_1',
        taskId: 'xgh_task_1',
        outcome: 'RESULT_READY',
        resultSummary: '本机已形成通过受控验证的交付候选，仍需人工批准。',
        artifactRefs: [],
        verification: { verdict: 'PASS', summary: '本机交付验证已通过。' },
        occurredAt: '2026-09-01T00:01:00.000Z',
        resultSha256,
      },
      receipt: {
        schemaVersion: 'xiaogui.task-receipt.v1',
        eventId: 'xgh_event_result_1',
        assignmentId: 'xgh_assignment_1',
        taskId: 'xgh_task_1',
        subjectId: 'xgh_subject_1',
        nodeId: 'xgh_node_1',
        keyId: 'ed25519:test-key',
        eventType: 'RESULT_READY',
        packageSha256: PACKAGE_SHA256,
        occurredAt: '2026-09-01T00:01:00.000Z',
        sequence: 3,
        resultSha256,
        signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
    })).resolves.toEqual({
      resultId: 'xgh_result_1',
      eventId: 'xgh_event_result_1',
      verified: true,
      duplicate: false,
      executionState: 'RESULT_READY',
      occurredAt: '2026-09-01T00:01:00.000Z',
      receivedAt: '2026-09-01T00:02:00.000Z',
    })
    expect(fetchImpl).toHaveBeenCalledWith('http://hub.intranet:3000/api/v2/taskhub/worker/results', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer account-jwt',
        'x-xiaogui-node-token': 'node-token',
      }),
    }))
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body).toEqual(expect.objectContaining({ result: expect.any(Object), receipt: expect.any(Object) }))
    expect(JSON.stringify(body)).not.toContain('privateKeyPem')
    expect(JSON.stringify(body)).not.toContain('deviceToken')
  })

  it('maps a replaced node to the dedicated safe status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: { code: 'FORBIDDEN', message: 'node was replaced' } }, 403))
    const port = createHttpXiaoguiHubTaskWorkerPortV1({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'account-jwt',
      node: { deviceToken: 'node-token' },
      fetchImpl,
    })

    await expect(port.pollAssignments(null)).rejects.toEqual(
      expect.objectContaining<Partial<HubTaskWorkerHttpErrorV1>>({ code: 'NODE_REVOKED' }),
    )
  })

  it('keeps a normal task-state conflict distinct from a replaced node', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: { code: 'CONFLICT', message: 'decision already changed' } }, 409))
    const port = createHttpXiaoguiHubTaskWorkerPortV1({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'account-jwt',
      node: { deviceToken: 'node-token' },
      fetchImpl,
    })

    await expect(port.pollAssignments(null)).rejects.toEqual(
      expect.objectContaining<Partial<HubTaskWorkerHttpErrorV1>>({ code: 'STATE_CONFLICT' }),
    )
  })

  it('uses the narrow worker detail DTO and does not infer missing identities', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      data: {
        schemaVersion: 'xiaogui.hub.worker-assignment-detail.v1',
        assignment: {
          schemaVersion: 'xiaogui.hub.worker-assignment.v1',
          assignmentId: 'xgh_assignment_1',
          taskId: 'xgh_task_1',
          decisionState: 'ACCEPTED',
          deliveryState: 'QUEUED',
          executionState: 'NOT_STARTED',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
        offer: {
          schemaVersion: 'xiaogui.hub.worker-offer.v1',
          taskId: 'xgh_task_1',
          mode: 'POOL',
          title: '整理资料',
          taskContent: '按要求整理资料。',
          constraints: [],
          acceptanceRequirements: [],
          attachmentRefs: [],
          packageSha256: PACKAGE_SHA256,
          dispatchState: 'ASSIGNED',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    }))
    const port = createHttpXiaoguiHubTaskWorkerPortV1({
      endpoint: 'http://hub.intranet:3000',
      accessToken: 'account-jwt',
      node: { deviceToken: 'node-token' },
      fetchImpl,
    })

    await expect(port.downloadAssignment('xgh_assignment_1')).resolves.toEqual({
      assignment: expect.not.objectContaining({ nodeId: expect.anything(), assigneeSubjectId: expect.anything() }),
      offer: expect.not.objectContaining({ publisherSubjectId: expect.anything(), targetSubjectId: expect.anything() }),
    })
  })
})
