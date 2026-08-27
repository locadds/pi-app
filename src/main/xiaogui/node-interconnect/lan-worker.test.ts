import { mkdtemp, rm } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type {
  XiaoguiAssignmentEnvelopeV1,
  XiaoguiNodeCapabilityManifestV1,
} from '@shared/xiaogui-node-contract'
import { createInMemoryXiaoguiNodeHubV1 } from './in-memory-node-hub'
import { xiaoguiTaskIdentityDigestV1 } from './hub-assignment-store'
import { startXiaoguiLanHubHttpServerV1 } from './lan-hub-http'
import { createXiaoguiLanWorkerV1 } from './lan-worker'
import {
  createInMemoryWorkerAssignmentLedgerV1,
  createJsonFileWorkerAssignmentLedgerV1,
} from './worker-assignment-ledger'

const HUB_TOKEN = 'hub-control-token-0000000000000001'
const NODE_A_TOKEN = 'node-a-control-token-000000000001'
const NODE_B_TOKEN = 'node-b-control-token-000000000001'
const PRIVATE_LAN_TEST_HOST = privateNonLoopbackIpv4()

describe('Xiaogui outbound LAN worker', () => {
  it.each([
    'http://127.0.0.1:9443',
    'https://public-hub.example:9443',
    'https://8.8.8.8:9443',
    'https://100.64.10.8:9443',
    'https://169.254.10.8:9443',
    'https://[fd00::8]:9443',
  ])('rejects a non-RFC1918 origin at the low-level worker seam: %s', (origin) => {
    expect(() => createXiaoguiLanWorkerV1({
      origin,
      nodeToken: NODE_B_TOKEN,
      manifest: node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']),
      approveLocal: async () => true,
      executeLocal: async () => ({ status: 'SUCCEEDED', resultDigest: 'sha256:must-not-run' }),
    })).toThrow('LAN_HUB_ORIGIN_HOST_INVALID')
  })

  it('rejects a malformed Hub JSON response instead of trusting a generic cast', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, envelope: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const worker = createXiaoguiLanWorkerV1({
        origin: 'http://192.168.10.8:9443',
        nodeToken: NODE_B_TOKEN,
        manifest: node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']),
        approveLocal: async () => true,
        executeLocal: async () => ({ status: 'SUCCEEDED', resultDigest: 'sha256:must-not-run' }),
      })
      await expect(worker.register()).resolves.toEqual({ ok: false, reasonCode: 'LAN_WORKER_RESPONSE_INVALID' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a claim response whose envelope is not awaiting local approval', async () => {
    const executeLocal = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:must-not-run' }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        envelope: assignmentEnvelope({ status: 'RUNNING' }),
      }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const worker = createXiaoguiLanWorkerV1({
        origin: 'http://192.168.10.8:9443',
        nodeToken: NODE_B_TOKEN,
        manifest: node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']),
        approveLocal: async () => true,
        executeLocal,
      })

      await expect(worker.pollOnce()).resolves.toEqual({ ok: false, reasonCode: 'LAN_WORKER_RESPONSE_INVALID' })
      expect(executeLocal).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not settle an active ledger from COMPLETED reconcile without a result digest', async () => {
    const envelope = assignmentEnvelope({ status: 'RUNNING' })
    const ledger = createInMemoryWorkerAssignmentLedgerV1([{
      assignmentId: envelope.assignmentId,
      taskIdentityDigest: xiaoguiTaskIdentityDigestV1(envelope.taskId),
      leaseId: envelope.leaseId,
      attemptId: `${envelope.assignmentId}.${envelope.leaseId}`,
      status: 'RUNNING',
      summaryDigest: 'sha256:active-summary',
      updatedAt: '2026-08-27T06:00:00.000Z',
    }])
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, status: 'COMPLETED' })))
    try {
      const worker = createXiaoguiLanWorkerV1({
        origin: 'http://192.168.10.8:9443',
        nodeToken: NODE_B_TOKEN,
        manifest: node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']),
        approveLocal: async () => true,
        executeLocal: async () => ({ status: 'SUCCEEDED', resultDigest: 'sha256:must-not-run' }),
        ledger,
      })

      await expect(worker.reconcile()).resolves.toEqual({
        ok: true,
        value: {
          status: 'OUTCOME_UNKNOWN',
          assignmentId: envelope.assignmentId,
          reasonCode: 'LAN_RECONCILE_UNAVAILABLE',
        },
      })
      const record = await ledger.get(envelope.assignmentId)
      expect(record).toMatchObject({ status: 'OUTCOME_UNKNOWN' })
      expect(record).not.toHaveProperty('receiptDigest')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('persists only the bounded worker ledger fields across process instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaogui-node-ledger-'))
    const filePath = join(directory, 'assignment-ledger.json')
    try {
      await createJsonFileWorkerAssignmentLedgerV1(filePath).upsert({
        assignmentId: 'assignment-persisted',
        taskIdentityDigest: xiaoguiTaskIdentityDigestV1('task-persisted'),
        leaseId: 'lease-persisted',
        attemptId: 'attempt-persisted',
        status: 'RUNNING',
        summaryDigest: 'sha256:bounded-summary',
        updatedAt: '2026-08-25T02:00:00.000Z',
      })

      await expect(createJsonFileWorkerAssignmentLedgerV1(filePath).get('assignment-persisted')).resolves.toEqual({
        assignmentId: 'assignment-persisted',
        taskIdentityDigest: xiaoguiTaskIdentityDigestV1('task-persisted'),
        leaseId: 'lease-persisted',
        attemptId: 'attempt-persisted',
        status: 'RUNNING',
        summaryDigest: 'sha256:bounded-summary',
        updatedAt: '2026-08-25T02:00:00.000Z',
      })
      await expect(createJsonFileWorkerAssignmentLedgerV1(filePath).getByTaskIdentity(
        xiaoguiTaskIdentityDigestV1('task-persisted'),
      )).resolves.toMatchObject({ assignmentId: 'assignment-persisted' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('selects the capable node and executes only after local approval', async () => {
    const nodeA = node('node-a', ['CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'])
    const nodeB = node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'])
    const { hub, server } = await startHub(new Map([['node-a', nodeA], ['node-b', nodeB]]))
    try {
      const executeA = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:a' }))
      const executeB = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:b' }))
      const approveB = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      const workerA = createXiaoguiLanWorkerV1({
        origin: server.origin, nodeToken: NODE_A_TOKEN, manifest: nodeA,
        approveLocal: async () => true, executeLocal: executeA,
      })
      const workerB = createXiaoguiLanWorkerV1({
        origin: server.origin, nodeToken: NODE_B_TOKEN, manifest: nodeB,
        approveLocal: approveB, executeLocal: executeB,
      })
      await workerA.register()
      await workerB.register()
      const offered = await post(server.origin, '/offer', task('task-1', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']), HUB_TOKEN)
      expect(offered).toMatchObject({ ok: true, envelope: { targetNodeId: 'node-b' } })
      const offeredEnvelope = (offered as { envelope: { assignmentId: string; leaseId: string } }).envelope
      await expect(post(server.origin, '/approve-local', {
        nodeId: 'node-b', assignmentId: offeredEnvelope.assignmentId, leaseId: offeredEnvelope.leaseId,
      }, HUB_TOKEN)).resolves.toEqual({ ok: false, reasonCode: 'LAN_NODE_UNAUTHORIZED' })

      await expect(workerA.pollOnce()).resolves.toEqual({ ok: true, value: { status: 'NO_WORK' } })
      await expect(workerB.pollOnce()).resolves.toMatchObject({ ok: true, value: { status: 'WAITING_LOCAL_APPROVAL' } })
      expect(executeB).not.toHaveBeenCalled()
      await expect(workerB.pollOnce()).resolves.toMatchObject({ ok: true, value: { status: 'COMPLETED', resultDigest: 'sha256:b' } })
      expect(executeA).not.toHaveBeenCalled()
      expect(executeB).toHaveBeenCalledTimes(1)
      const assignmentId = offeredEnvelope.assignmentId
      await expect(post(server.origin, '/reconcile', { assignmentId }, HUB_TOKEN)).resolves.toEqual({ ok: true, status: 'COMPLETED', resultDigest: 'sha256:b' })
      await expect(post(server.origin, '/reconcile', { nodeId: 'node-a', assignmentId }, NODE_A_TOKEN)).resolves.toEqual({ ok: false, reasonCode: 'ASSIGNMENT_NODE_MISMATCH' })
      await expect(post(server.origin, '/reconcile', { nodeId: 'node-b', assignmentId }, NODE_B_TOKEN)).resolves.toEqual({ ok: true, status: 'COMPLETED', resultDigest: 'sha256:b' })
    } finally {
      await server.close()
    }
  })

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('rejects duplicate claim and expired lease without duplicate execution', async () => {
    let now = '2026-08-25T02:00:00.000Z'
    const nodeB = node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'], 500)
    const { hub, server } = await startHub(new Map([['node-b', nodeB]]), () => now)
    try {
      const execute = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:late' }))
      const worker = createXiaoguiLanWorkerV1({
        origin: server.origin, nodeToken: NODE_B_TOKEN, manifest: nodeB,
        approveLocal: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true), executeLocal: execute,
      })
      await worker.register()
      const offered = await post(server.origin, '/offer', task('task-expire', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']), HUB_TOKEN)
      await expect(worker.pollOnce()).resolves.toMatchObject({ ok: true, value: { status: 'WAITING_LOCAL_APPROVAL' } })
      await expect(post(server.origin, '/claim', { nodeId: 'node-b' }, NODE_B_TOKEN)).resolves.toEqual({ ok: false, reasonCode: 'NO_CLAIMABLE_ASSIGNMENT' })
      now = '2026-08-25T02:00:01.000Z'
      await expect(worker.pollOnce()).resolves.toEqual({ ok: false, reasonCode: 'ASSIGNMENT_LEASE_EXPIRED' })
      expect(execute).not.toHaveBeenCalled()
      const assignmentId = (offered as { envelope: { assignmentId: string } }).envelope.assignmentId
      await expect(post(server.origin, '/reconcile', { assignmentId }, HUB_TOKEN)).resolves.toMatchObject({ ok: true, status: 'LEASE_EXPIRED' })
    } finally {
      await server.close()
    }
  })

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('keeps a settled ledger across worker restart and does not duplicate execution', async () => {
    const nodeB = node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'])
    const { hub, server } = await startHub(new Map([['node-b', nodeB]]))
    try {
      const ledger = createInMemoryWorkerAssignmentLedgerV1()
      const execute = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:done-once' }))
      const worker = createXiaoguiLanWorkerV1({
        origin: server.origin, nodeToken: NODE_B_TOKEN, manifest: nodeB,
        approveLocal: async () => true, executeLocal: execute, ledger,
      })
      await worker.register()
      const offered = await post(server.origin, '/offer', task('task-once', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']), HUB_TOKEN)
      const assignmentId = (offered as { envelope: { assignmentId: string } }).envelope.assignmentId
      await expect(worker.pollOnce()).resolves.toMatchObject({ ok: true, value: { status: 'COMPLETED', assignmentId } })
      await expect(ledger.get(assignmentId)).resolves.toMatchObject({ status: 'SETTLED', receiptDigest: 'sha256:done-once' })

      const restarted = createXiaoguiLanWorkerV1({
        origin: server.origin, nodeToken: NODE_B_TOKEN, manifest: nodeB,
        approveLocal: async () => true, executeLocal: execute, ledger,
      })
      await expect(restarted.pollOnce()).resolves.toEqual({ ok: true, value: { status: 'NO_WORK' } })
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('marks a running assignment unknown after restart instead of executing again', async () => {
    const nodeA = node('node-a', ['CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'])
    const nodeB = node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'])
    const { hub, server } = await startHub(new Map([['node-a', nodeA], ['node-b', nodeB]]))
    try {
      const execute = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:should-not-run' }))
      const ledger = createInMemoryWorkerAssignmentLedgerV1()
      const worker = createXiaoguiLanWorkerV1({
        origin: server.origin, nodeToken: NODE_B_TOKEN, manifest: nodeB,
        approveLocal: async () => true, executeLocal: execute, ledger,
      })
      await worker.register()
      const offered = await post(server.origin, '/offer', task('task-running', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']), HUB_TOKEN)
      const envelope = (offered as { envelope: { assignmentId: string; leaseId: string } }).envelope
      await expect(post(server.origin, '/claim', { nodeId: 'node-b' }, NODE_B_TOKEN)).resolves.toMatchObject({ ok: true })
      await expect(post(server.origin, '/approve-local', { nodeId: 'node-b', assignmentId: envelope.assignmentId, leaseId: envelope.leaseId }, NODE_B_TOKEN)).resolves.toEqual({ ok: true })
      await expect(post(server.origin, '/mark-running', { nodeId: 'node-b', assignmentId: envelope.assignmentId, leaseId: envelope.leaseId }, NODE_B_TOKEN)).resolves.toEqual({ ok: true })
      await expect(post(server.origin, '/outcome-unknown', {
        nodeId: 'node-a', assignmentId: envelope.assignmentId, leaseId: envelope.leaseId, reasonCode: 'WRONG_NODE_RESTART',
      }, NODE_A_TOKEN)).resolves.toEqual({ ok: false, reasonCode: 'ASSIGNMENT_NODE_MISMATCH' })
      await ledger.upsert({
        assignmentId: envelope.assignmentId,
        taskIdentityDigest: xiaoguiTaskIdentityDigestV1('task-running'),
        leaseId: envelope.leaseId,
        attemptId: `${envelope.assignmentId}.${envelope.leaseId}`,
        status: 'RUNNING',
        summaryDigest: 'sha256:running-ledger',
        updatedAt: '2026-08-25T02:00:00.000Z',
      })

      await expect(worker.pollOnce()).resolves.toEqual({
        ok: true,
        value: { status: 'OUTCOME_UNKNOWN', assignmentId: envelope.assignmentId, reasonCode: 'WORKER_RESTARTED_DURING_RUNNING' },
      })
      expect(execute).not.toHaveBeenCalled()
      await expect(ledger.get(envelope.assignmentId)).resolves.toMatchObject({ status: 'OUTCOME_UNKNOWN' })
      await expect(post(server.origin, '/reconcile', { assignmentId: envelope.assignmentId }, HUB_TOKEN)).resolves.toEqual({
        ok: true,
        status: 'OUTCOME_UNKNOWN',
        reasonCode: 'WORKER_RESTARTED_DURING_RUNNING',
      })
      const eventsText = JSON.stringify(await post(server.origin, '/events', {}, HUB_TOKEN))
      expect(eventsText).toContain('ASSIGNMENT_OUTCOME_UNKNOWN')
      expect(eventsText).not.toMatch(/[A-Z]:\\\\|\\\\\\\\|kimi|qoder|codex|runtimeSession|credential|secret|password/i)
    } finally {
      await server.close()
    }
  })

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('refuses a new assignmentId when the durable ledger already closed the same task identity', async () => {
    const approved = node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'])
    const trustedManifests = new Map([['node-b', approved]])
    const hub = createInMemoryXiaoguiNodeHubV1({
      trustedManifests,
      now: () => '2026-08-27T06:30:00.000Z',
    })
    const server = await startXiaoguiLanHubHttpServerV1({
      hub,
      authorization: {
        hubToken: HUB_TOKEN,
        nodeTokens: new Map([['node-b', NODE_B_TOKEN]]),
        trustedManifests,
      },
      bindHost: PRIVATE_LAN_TEST_HOST!,
      exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
    })
    try {
      const taskId = 'task-ledger-identity'
      const taskIdentityDigest = xiaoguiTaskIdentityDigestV1(taskId)
      const ledger = createInMemoryWorkerAssignmentLedgerV1([{
        assignmentId: 'assignment-from-previous-hub-process',
        taskIdentityDigest,
        leaseId: 'lease-from-previous-hub-process',
        attemptId: 'attempt-from-previous-hub-process',
        status: 'SETTLED',
        summaryDigest: 'sha256:previous-task-summary',
        receiptDigest: 'sha256:previous-task-result',
        updatedAt: '2026-08-27T06:00:00.000Z',
      }])
      const execute = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:must-not-run' }))
      const worker = createXiaoguiLanWorkerV1({
        origin: server.origin,
        nodeToken: NODE_B_TOKEN,
        manifest: approved,
        approveLocal: async () => true,
        executeLocal: execute,
        ledger,
      })
      await worker.register()
      const offered = await hub.offer(task(taskId, ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']))
      if (!offered.ok) throw new Error('offer failed')

      await expect(worker.pollOnce()).resolves.toEqual({
        ok: true,
        value: {
          status: 'OUTCOME_UNKNOWN',
          assignmentId: offered.envelope.assignmentId,
          reasonCode: 'WORKER_TASK_IDENTITY_ALREADY_CLOSED',
        },
      })
      expect(execute).not.toHaveBeenCalled()
      await expect(hub.reconcile(offered.envelope.assignmentId)).resolves.toEqual({
        ok: true,
        status: 'OUTCOME_UNKNOWN',
        reasonCode: 'WORKER_TASK_IDENTITY_ALREADY_CLOSED',
      })
    } finally {
      await server.close()
    }
  })
})

function node(nodeId: string, capabilities: XiaoguiNodeCapabilityManifestV1['capabilities'], leaseTtlMs = 30_000): XiaoguiNodeCapabilityManifestV1 {
  return {
    identity: { nodeId, protocolVersion: 'xiaogui-node.v1', product: 'XIAOGUI_DESKTOP', displayName: `小规 ${nodeId}` },
    capabilities,
    dataEgressPolicy: 'LOCAL_ONLY',
    health: 'ONLINE',
    leaseTtlMs,
    updatedAt: '2026-08-25T02:00:00.000Z',
    designReserved: true,
  }
}

function task(taskId: string, requiredCapabilities: XiaoguiNodeCapabilityManifestV1['capabilities']) {
  return {
    taskId,
    requiredCapabilities,
    dataEgressPolicy: 'LOCAL_ONLY' as const,
    payloadRef: { mediaType: 'application/vnd.xiaogui.assignment-payload+json' as const, artifactId: `artifact-${taskId}`, digest: `sha256:${taskId}` },
  }
}

async function post(origin: string, route: string, body: unknown, token: string): Promise<unknown> {
  const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  return response.json()
}

function assignmentEnvelope(
  overrides: Partial<XiaoguiAssignmentEnvelopeV1> = {},
): XiaoguiAssignmentEnvelopeV1 {
  return { ...assignmentEnvelopeBase(), ...overrides }
}

function assignmentEnvelopeBase() {
  return {
    assignmentId: 'assignment-response-shape',
    taskId: 'task-response-shape',
    hubId: 'hub-response-shape',
    targetNodeId: 'node-b',
    leaseId: 'lease-response-shape',
    requiredCapabilities: ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'] as const,
    dataEgressPolicy: 'LOCAL_ONLY' as const,
    payloadRef: {
      mediaType: 'application/vnd.xiaogui.assignment-payload+json' as const,
      artifactId: 'artifact-response-shape',
      digest: 'sha256:response-shape',
    },
    humanApproval: 'REQUIRED' as const,
    status: 'AWAITING_LOCAL_APPROVAL' as const,
    issuedAt: '2026-08-27T06:00:00.000Z',
    leaseExpiresAt: '2026-08-27T07:00:00.000Z',
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function startHub(
  trustedManifests: ReadonlyMap<string, XiaoguiNodeCapabilityManifestV1>,
  now: () => string = () => '2026-08-25T02:00:00.000Z',
) {
  const hub = createInMemoryXiaoguiNodeHubV1({ trustedManifests, now })
  const nodeTokens = new Map<string, string>()
  for (const nodeId of trustedManifests.keys()) {
    nodeTokens.set(nodeId, nodeId === 'node-a' ? NODE_A_TOKEN : NODE_B_TOKEN)
  }
  const server = await startXiaoguiLanHubHttpServerV1({
    hub,
    authorization: { hubToken: HUB_TOKEN, nodeTokens, trustedManifests },
    bindHost: PRIVATE_LAN_TEST_HOST!,
    exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
  })
  return { hub, server }
}

function privateNonLoopbackIpv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && isPrivateIpv4(address.address)) return address.address
    }
  }
  return null
}

function isPrivateIpv4(value: string): boolean {
  const [first, second] = value.split('.').map(Number)
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
}
