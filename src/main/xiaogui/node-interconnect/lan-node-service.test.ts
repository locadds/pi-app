import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createInMemoryXiaoguiNodeHubV1 } from './in-memory-node-hub'
import { startXiaoguiLanHubHttpServerV1 } from './lan-hub-http'
import {
  createXiaoguiLanNodeMainProcessServiceV1,
  loadXiaoguiLanNodeMainProcessConfigV1,
} from './lan-node-service'
import { createXiaoguiLanWorkerLedgerForUserDataV1 } from './worker-assignment-ledger'

const HUB_TOKEN = 'hub-control-token-0000000000000001'
const NODE_A_TOKEN = 'node-a-control-token-000000000001'
const NODE_B_TOKEN = 'node-b-control-token-000000000001'

describe('Xiaogui LAN node main-process seam', () => {
  it('is disabled by default without requiring credentials or opening a connection', async () => {
    const loaded = loadXiaoguiLanNodeMainProcessConfigV1({})
    expect(loaded).toEqual({ ok: true, value: { enabled: false } })
    if (!loaded.ok || loaded.value.enabled) throw new Error('disabled config failed')

    const service = createXiaoguiLanNodeMainProcessServiceV1({ config: loaded.value })
    await expect(service.start()).resolves.toEqual({ ok: true, state: 'DISABLED' })
    expect(service.status()).toEqual({ state: 'DISABLED' })
  })

  it('builds distinct two-node outbound-only configs and requires an explicit remote HTTP pilot gate', () => {
    const nodeA = loadXiaoguiLanNodeMainProcessConfigV1(enabledEnv('xiaogui-a', NODE_A_TOKEN, 'https://xiaogui-hub.lan:9443'))
    const nodeB = loadXiaoguiLanNodeMainProcessConfigV1(enabledEnv('xiaogui-b', NODE_B_TOKEN, 'https://xiaogui-hub.lan:9443'))
    expect(nodeA).toMatchObject({
      ok: true,
      value: {
        enabled: true,
        hubOrigin: 'https://xiaogui-hub.lan:9443',
        connectionMode: 'OUTBOUND_ONLY',
        transportSecurity: 'TLS',
        localApproval: 'REQUIRED',
        reconcileOnStart: true,
        manifest: { identity: { nodeId: 'xiaogui-a' } },
      },
    })
    expect(nodeB).toMatchObject({ ok: true, value: { enabled: true, manifest: { identity: { nodeId: 'xiaogui-b' } } } })
    expect(loadXiaoguiLanNodeMainProcessConfigV1(
      enabledEnv('xiaogui-b', NODE_B_TOKEN, 'http://192.168.10.8:9443'),
    )).toEqual({ ok: false, reasonCode: 'LAN_NODE_HTTP_PILOT_NOT_ENABLED' })
    expect(loadXiaoguiLanNodeMainProcessConfigV1({
      ...enabledEnv('xiaogui-b', NODE_B_TOKEN, 'http://192.168.10.8:9443'),
      XIAOGUI_LAN_HTTP_PILOT: '1',
    })).toMatchObject({
      ok: true,
      value: { enabled: true, transportSecurity: 'TOKEN_AUTHENTICATED_HTTP_PILOT' },
    })
    for (const publicOrigin of ['http://8.8.8.8:9443', 'http://public-hub.example:9443']) {
      expect(loadXiaoguiLanNodeMainProcessConfigV1({
        ...enabledEnv('xiaogui-b', NODE_B_TOKEN, publicOrigin),
        XIAOGUI_LAN_HTTP_PILOT: '1',
      })).toEqual({ ok: false, reasonCode: 'LAN_NODE_HTTP_PILOT_ORIGIN_INVALID' })
    }
  })

  it('reconciles a durable running assignment during start before claiming more work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaogui-lan-node-reconcile-'))
    const hub = createInMemoryXiaoguiNodeHubV1({ now: () => '2026-08-27T03:00:00.000Z' })
    const server = await startXiaoguiLanHubHttpServerV1({
      hub,
      authorization: { hubToken: HUB_TOKEN, nodeTokens: new Map([['xiaogui-b', NODE_B_TOKEN]]) },
    })
    try {
      const loaded = loadXiaoguiLanNodeMainProcessConfigV1(
        enabledEnv('xiaogui-b', NODE_B_TOKEN, server.origin),
        () => '2026-08-27T03:00:00.000Z',
      )
      if (!loaded.ok || !loaded.value.enabled) throw new Error('enabled config failed')
      await hub.register(loaded.value.manifest)
      const offered = await hub.offer({
        taskId: 'task-reconcile-on-start',
        requiredCapabilities: ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'],
        dataEgressPolicy: 'LOCAL_ONLY',
        payloadRef: {
          mediaType: 'application/vnd.xiaogui.assignment-payload+json',
          artifactId: 'artifact-reconcile-on-start',
          digest: 'sha256:reconcile-on-start',
        },
      })
      if (!offered.ok) throw new Error('offer failed')
      await hub.claim('xiaogui-b')
      await hub.approveLocal('xiaogui-b', offered.envelope.assignmentId, offered.envelope.leaseId)
      await hub.markRunning('xiaogui-b', offered.envelope.assignmentId, offered.envelope.leaseId)
      await createXiaoguiLanWorkerLedgerForUserDataV1(directory).upsert({
        assignmentId: offered.envelope.assignmentId,
        leaseId: offered.envelope.leaseId,
        attemptId: `${offered.envelope.assignmentId}.${offered.envelope.leaseId}`,
        status: 'RUNNING',
        summaryDigest: 'sha256:reconcile-start-summary',
        updatedAt: '2026-08-27T03:00:00.000Z',
      })
      const execute = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:must-not-run' }))
      const service = createXiaoguiLanNodeMainProcessServiceV1({
        config: loaded.value,
        userDataDir: directory,
        approveLocal: async () => true,
        executeLocal: execute,
      })

      await expect(service.start()).resolves.toEqual({ ok: true, state: 'RUNNING' })
      await expect(hub.reconcile(offered.envelope.assignmentId)).resolves.toEqual({
        ok: true,
        status: 'OUTCOME_UNKNOWN',
        reasonCode: 'WORKER_RESTARTED_DURING_RUNNING',
      })
      expect(execute).not.toHaveBeenCalled()
      await service.stop()
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('registers outbound, requires local approval, and reuses the durable ledger after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaogui-lan-node-service-'))
    const hub = createInMemoryXiaoguiNodeHubV1({ now: () => '2026-08-27T03:00:00.000Z' })
    const server = await startXiaoguiLanHubHttpServerV1({
      hub,
      authorization: { hubToken: HUB_TOKEN, nodeTokens: new Map([['xiaogui-b', NODE_B_TOKEN]]) },
    })
    let serverClosed = false
    try {
      const loaded = loadXiaoguiLanNodeMainProcessConfigV1(
        enabledEnv('xiaogui-b', NODE_B_TOKEN, server.origin),
        () => '2026-08-27T03:00:00.000Z',
      )
      if (!loaded.ok || !loaded.value.enabled) throw new Error('enabled config failed')
      const execute = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:node-b-result' }))
      const approve = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      const first = createXiaoguiLanNodeMainProcessServiceV1({
        config: loaded.value,
        userDataDir: directory,
        approveLocal: approve,
        executeLocal: execute,
      })

      await expect(first.start()).resolves.toEqual({ ok: true, state: 'RUNNING' })
      const offered = await hub.offer({
        taskId: 'task-main-process-seam',
        requiredCapabilities: ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'],
        dataEgressPolicy: 'LOCAL_ONLY',
        payloadRef: {
          mediaType: 'application/vnd.xiaogui.assignment-payload+json',
          artifactId: 'artifact-main-process-seam',
          digest: 'sha256:main-process-seam',
        },
      })
      expect(offered).toMatchObject({ ok: true, envelope: { targetNodeId: 'xiaogui-b' } })
      await expect(first.pollOnce()).resolves.toMatchObject({ ok: true, value: { status: 'WAITING_LOCAL_APPROVAL' } })
      expect(execute).not.toHaveBeenCalled()
      await expect(first.pollOnce()).resolves.toMatchObject({
        ok: true,
        value: { status: 'COMPLETED', resultDigest: 'sha256:node-b-result' },
      })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(first.status())).not.toContain(NODE_B_TOKEN)
      expect(JSON.stringify(first.status())).not.toContain(server.origin)
      await first.stop()

      const restarted = createXiaoguiLanNodeMainProcessServiceV1({
        config: loaded.value,
        userDataDir: directory,
        approveLocal: async () => true,
        executeLocal: execute,
      })
      await expect(restarted.start()).resolves.toEqual({ ok: true, state: 'RUNNING' })
      await expect(restarted.pollOnce()).resolves.toEqual({ ok: true, value: { status: 'NO_WORK' } })
      expect(execute).toHaveBeenCalledTimes(1)
      await server.close()
      serverClosed = true
      await expect(restarted.pollOnce()).resolves.toEqual({ ok: false, reasonCode: 'LAN_WORKER_TRANSPORT_FAILED' })
      expect(restarted.status()).toEqual({ state: 'DEGRADED', reasonCode: 'LAN_WORKER_TRANSPORT_FAILED' })
      expect(execute).toHaveBeenCalledTimes(1)
      await restarted.stop()
    } finally {
      if (!serverClosed) await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function enabledEnv(nodeId: string, nodeToken: string, hubOrigin: string): Record<string, string> {
  return {
    XIAOGUI_LAN_NODE_ENABLED: '1',
    XIAOGUI_LAN_NODE_ID: nodeId,
    XIAOGUI_LAN_NODE_TOKEN: nodeToken,
    XIAOGUI_LAN_HUB_ORIGIN: hubOrigin,
    XIAOGUI_LAN_NODE_CAPABILITIES: 'WORK.DOCX.TEMPLATE,EXECUTION.LOCAL_ONLY',
    XIAOGUI_LAN_NODE_DATA_EGRESS: 'LOCAL_ONLY',
  }
}
