import { describe, expect, it, vi } from 'vitest'

import type { XiaoguiNodeCapabilityManifestV1 } from '@shared/xiaogui-node-contract'
import { createInMemoryXiaoguiNodeHubV1 } from './in-memory-node-hub'
import { startXiaoguiLanHubHttpServerV1 } from './lan-hub-http'
import { createXiaoguiLanWorkerV1 } from './lan-worker'
import { createInMemoryWorkerAssignmentLedgerV1 } from './worker-assignment-ledger'

const HUB_TOKEN = 'hub-control-token-0000000000000001'
const NODE_A_TOKEN = 'node-a-control-token-000000000001'
const NODE_B_TOKEN = 'node-b-control-token-000000000001'

describe('Xiaogui outbound LAN worker', () => {
  it('selects the capable node and executes only after local approval', async () => {
    const hub = createInMemoryXiaoguiNodeHubV1({ now: () => '2026-08-25T02:00:00.000Z' })
    const server = await startXiaoguiLanHubHttpServerV1({ hub, authorization: authorization() })
    try {
      const executeA = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:a' }))
      const executeB = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:b' }))
      const approveB = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      const workerA = createXiaoguiLanWorkerV1({
        origin: server.origin, nodeToken: NODE_A_TOKEN, manifest: node('node-a', ['CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY']),
        approveLocal: async () => true, executeLocal: executeA,
      })
      const workerB = createXiaoguiLanWorkerV1({
        origin: server.origin, nodeToken: NODE_B_TOKEN, manifest: node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']),
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

  it('rejects duplicate claim and expired lease without duplicate execution', async () => {
    let now = '2026-08-25T02:00:00.000Z'
    const hub = createInMemoryXiaoguiNodeHubV1({ now: () => now })
    const server = await startXiaoguiLanHubHttpServerV1({ hub, authorization: authorization() })
    try {
      const execute = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:late' }))
      const worker = createXiaoguiLanWorkerV1({
        origin: server.origin, nodeToken: NODE_B_TOKEN, manifest: node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'], 500),
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

  it('keeps a settled ledger across worker restart and does not duplicate execution', async () => {
    const hub = createInMemoryXiaoguiNodeHubV1({ now: () => '2026-08-25T02:00:00.000Z' })
    const server = await startXiaoguiLanHubHttpServerV1({ hub, authorization: authorization() })
    try {
      const ledger = createInMemoryWorkerAssignmentLedgerV1()
      const execute = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:done-once' }))
      const worker = createXiaoguiLanWorkerV1({
        origin: server.origin, nodeToken: NODE_B_TOKEN, manifest: node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']),
        approveLocal: async () => true, executeLocal: execute, ledger,
      })
      await worker.register()
      const offered = await post(server.origin, '/offer', task('task-once', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']), HUB_TOKEN)
      const assignmentId = (offered as { envelope: { assignmentId: string } }).envelope.assignmentId
      await expect(worker.pollOnce()).resolves.toMatchObject({ ok: true, value: { status: 'COMPLETED', assignmentId } })
      await expect(ledger.get(assignmentId)).resolves.toMatchObject({ status: 'SETTLED', receiptDigest: 'sha256:done-once' })

      const restarted = createXiaoguiLanWorkerV1({
        origin: server.origin, nodeToken: NODE_B_TOKEN, manifest: node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']),
        approveLocal: async () => true, executeLocal: execute, ledger,
      })
      await expect(restarted.pollOnce()).resolves.toEqual({ ok: true, value: { status: 'NO_WORK' } })
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })

  it('marks a running assignment unknown after restart instead of executing again', async () => {
    const hub = createInMemoryXiaoguiNodeHubV1({ now: () => '2026-08-25T02:00:00.000Z' })
    const server = await startXiaoguiLanHubHttpServerV1({ hub, authorization: authorization() })
    try {
      const execute = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:should-not-run' }))
      const ledger = createInMemoryWorkerAssignmentLedgerV1()
      const worker = createXiaoguiLanWorkerV1({
        origin: server.origin, nodeToken: NODE_B_TOKEN, manifest: node('node-b', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY']),
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
    dataEgressPolicy: 'LOCAL_ONLY',
    payloadRef: { mediaType: 'application/vnd.xiaogui.assignment-payload+json', artifactId: `artifact-${taskId}`, digest: `sha256:${taskId}` },
  }
}

function authorization() {
  return { hubToken: HUB_TOKEN, nodeTokens: new Map([['node-a', NODE_A_TOKEN], ['node-b', NODE_B_TOKEN]]) }
}

async function post(origin: string, route: string, body: unknown, token: string): Promise<unknown> {
  const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  return response.json()
}
