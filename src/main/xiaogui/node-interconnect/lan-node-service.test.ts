import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createInMemoryXiaoguiNodeHubV1 } from './in-memory-node-hub'
import { xiaoguiTaskIdentityDigestV1 } from './hub-assignment-store'
import { startXiaoguiLanHubHttpServerV1 } from './lan-hub-http'
import {
  createXiaoguiLanNodeMainProcessServiceV1,
  loadXiaoguiLanNodeMainProcessConfigV1,
} from './lan-node-service'
import { createXiaoguiLanWorkerLedgerForUserDataV1 } from './worker-assignment-ledger'

const HUB_TOKEN = 'hub-control-token-0000000000000001'
const NODE_A_TOKEN = 'node-a-control-token-000000000001'
const NODE_B_TOKEN = 'node-b-control-token-000000000001'
const PRIVATE_LAN_TEST_HOST = privateNonLoopbackIpv4()

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
    const nodeA = loadXiaoguiLanNodeMainProcessConfigV1(enabledEnv('xiaogui-a', NODE_A_TOKEN, 'https://192.168.10.8:9443'))
    const nodeB = loadXiaoguiLanNodeMainProcessConfigV1(enabledEnv('xiaogui-b', NODE_B_TOKEN, 'https://192.168.10.8:9443'))
    expect(nodeA).toMatchObject({
      ok: true,
      value: {
        enabled: true,
        hubOrigin: 'https://192.168.10.8:9443',
        connectionMode: 'OUTBOUND_ONLY',
        transportSecurity: 'TLS',
        localApproval: 'REQUIRED',
        reconcileOnStart: true,
        manifest: { identity: { nodeId: 'xiaogui-a' } },
      },
    })
    expect(nodeB).toMatchObject({ ok: true, value: { enabled: true, manifest: { identity: { nodeId: 'xiaogui-b' } } } })
    expect(loadXiaoguiLanNodeMainProcessConfigV1(
      { ...enabledEnv('xiaogui-b', NODE_B_TOKEN, 'http://192.168.10.8:9443'), XIAOGUI_LAN_HTTP_PILOT: '0' },
    )).toEqual({ ok: false, reasonCode: 'LAN_NODE_HTTP_PILOT_NOT_ENABLED' })
    expect(loadXiaoguiLanNodeMainProcessConfigV1({
      ...enabledEnv('xiaogui-b', NODE_B_TOKEN, 'http://192.168.10.8:9443'),
      XIAOGUI_LAN_HTTP_PILOT: '1',
    })).toMatchObject({
      ok: true,
      value: { enabled: true, transportSecurity: 'TOKEN_AUTHENTICATED_HTTP_PILOT' },
    })
    for (const publicOrigin of [
      'http://8.8.8.8:9443',
      'http://public-hub.example:9443',
      'https://8.8.8.8:9443',
      'https://public-hub.example:9443',
      'https://169.254.10.8:9443',
      'https://100.64.10.8:9443',
      'https://127.0.0.1:9443',
      'https://[::1]:9443',
      'https://[fd00::8]:9443',
    ]) {
      expect(loadXiaoguiLanNodeMainProcessConfigV1({
        ...enabledEnv('xiaogui-b', NODE_B_TOKEN, publicOrigin),
        XIAOGUI_LAN_HTTP_PILOT: '1',
      })).toEqual({ ok: false, reasonCode: 'LAN_HUB_ORIGIN_HOST_INVALID' })
    }
  })

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('reconciles a durable running assignment during start before claiming more work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaogui-lan-node-reconcile-'))
    const approved = trustedNode('xiaogui-b')
    const trustedManifests = new Map([['xiaogui-b', approved]])
    const hub = createInMemoryXiaoguiNodeHubV1({ trustedManifests, now: () => '2026-08-27T03:00:00.000Z' })
    const server = await startXiaoguiLanHubHttpServerV1({
      hub,
      authorization: { hubToken: HUB_TOKEN, nodeTokens: new Map([['xiaogui-b', NODE_B_TOKEN]]), trustedManifests },
      bindHost: PRIVATE_LAN_TEST_HOST!,
      exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
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
        taskIdentityDigest: xiaoguiTaskIdentityDigestV1('task-reconcile-on-start'),
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

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('registers outbound, requires local approval, and reuses the durable ledger after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaogui-lan-node-service-'))
    const approved = trustedNode('xiaogui-b')
    const trustedManifests = new Map([['xiaogui-b', approved]])
    const hub = createInMemoryXiaoguiNodeHubV1({ trustedManifests, now: () => '2026-08-27T03:00:00.000Z' })
    const server = await startXiaoguiLanHubHttpServerV1({
      hub,
      authorization: { hubToken: HUB_TOKEN, nodeTokens: new Map([['xiaogui-b', NODE_B_TOKEN]]), trustedManifests },
      bindHost: PRIVATE_LAN_TEST_HOST!,
      exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
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

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('degrades safely when local approval rejects instead of leaking a Promise rejection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaogui-lan-approval-error-'))
    const approved = trustedNode('xiaogui-b')
    const trustedManifests = new Map([['xiaogui-b', approved]])
    const hub = createInMemoryXiaoguiNodeHubV1({ trustedManifests, now: () => approved.updatedAt })
    const server = await startXiaoguiLanHubHttpServerV1({
      hub,
      authorization: {
        hubToken: HUB_TOKEN,
        nodeTokens: new Map([['xiaogui-b', NODE_B_TOKEN]]),
        trustedManifests,
      },
      bindHost: PRIVATE_LAN_TEST_HOST!,
      exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
    })
    try {
      const loaded = loadXiaoguiLanNodeMainProcessConfigV1(
        { ...enabledEnv('xiaogui-b', NODE_B_TOKEN, server.origin), XIAOGUI_LAN_HTTP_PILOT: '1' },
        () => approved.updatedAt,
      )
      if (!loaded.ok || !loaded.value.enabled) throw new Error('enabled config failed')
      const execute = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:must-not-run' }))
      const service = createXiaoguiLanNodeMainProcessServiceV1({
        config: loaded.value,
        userDataDir: directory,
        approveLocal: async () => { throw new Error('approval UI unavailable') },
        executeLocal: execute,
      })
      await expect(service.start()).resolves.toEqual({ ok: true, state: 'RUNNING' })
      await hub.offer({
        taskId: 'task-approval-error',
        requiredCapabilities: ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'],
        dataEgressPolicy: 'LOCAL_ONLY',
        payloadRef: {
          mediaType: 'application/vnd.xiaogui.assignment-payload+json',
          artifactId: 'artifact-approval-error',
          digest: 'sha256:approval-error',
        },
      })

      await expect(service.pollOnce()).resolves.toEqual({ ok: false, reasonCode: 'LAN_LOCAL_APPROVAL_FAILED' })
      expect(service.status()).toEqual({ state: 'DEGRADED', reasonCode: 'LAN_LOCAL_APPROVAL_FAILED' })
      expect(execute).not.toHaveBeenCalled()
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('degrades safely when the durable ledger is unreadable during start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaogui-lan-ledger-error-'))
    const ledgerPath = join(directory, 'xiaogui', 'node-worker', 'v1', 'assignment-ledger.json')
    await mkdir(join(directory, 'xiaogui', 'node-worker', 'v1'), { recursive: true })
    await writeFile(ledgerPath, '{', 'utf8')
    const approved = trustedNode('xiaogui-b')
    const trustedManifests = new Map([['xiaogui-b', approved]])
    const hub = createInMemoryXiaoguiNodeHubV1({ trustedManifests, now: () => approved.updatedAt })
    const server = await startXiaoguiLanHubHttpServerV1({
      hub,
      authorization: {
        hubToken: HUB_TOKEN,
        nodeTokens: new Map([['xiaogui-b', NODE_B_TOKEN]]),
        trustedManifests,
      },
      bindHost: PRIVATE_LAN_TEST_HOST!,
      exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
    })
    try {
      const loaded = loadXiaoguiLanNodeMainProcessConfigV1(
        { ...enabledEnv('xiaogui-b', NODE_B_TOKEN, server.origin), XIAOGUI_LAN_HTTP_PILOT: '1' },
        () => approved.updatedAt,
      )
      if (!loaded.ok || !loaded.value.enabled) throw new Error('enabled config failed')
      const service = createXiaoguiLanNodeMainProcessServiceV1({
        config: loaded.value,
        userDataDir: directory,
        approveLocal: async () => true,
        executeLocal: async () => ({ status: 'SUCCEEDED', resultDigest: 'sha256:must-not-run' }),
      })

      await expect(service.start()).resolves.toEqual({ ok: false, reasonCode: 'LAN_WORKER_LEDGER_FAILED' })
      expect(service.status()).toEqual({ state: 'DEGRADED', reasonCode: 'LAN_WORKER_LEDGER_FAILED' })
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function enabledEnv(nodeId: string, nodeToken: string, hubOrigin: string): Record<string, string> {
  return {
    XIAOGUI_LAN_HTTP_PILOT: '1',
    XIAOGUI_LAN_NODE_ENABLED: '1',
    XIAOGUI_LAN_NODE_ID: nodeId,
    XIAOGUI_LAN_NODE_TOKEN: nodeToken,
    XIAOGUI_LAN_HUB_ORIGIN: hubOrigin,
    XIAOGUI_LAN_NODE_CAPABILITIES: 'WORK.DOCX.TEMPLATE,EXECUTION.LOCAL_ONLY',
    XIAOGUI_LAN_NODE_DATA_EGRESS: 'LOCAL_ONLY',
  }
}

function trustedNode(nodeId: string) {
  return {
    identity: {
      nodeId,
      protocolVersion: 'xiaogui-node.v1' as const,
      product: 'XIAOGUI_DESKTOP' as const,
      displayName: `小规 ${nodeId}`,
    },
    capabilities: ['WORK.DOCX.TEMPLATE' as const, 'EXECUTION.LOCAL_ONLY' as const],
    dataEgressPolicy: 'LOCAL_ONLY' as const,
    health: 'ONLINE' as const,
    leaseTtlMs: 30_000,
    updatedAt: '2026-08-27T03:00:00.000Z',
    designReserved: true as const,
  }
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
