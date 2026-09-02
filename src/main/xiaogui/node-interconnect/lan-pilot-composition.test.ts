import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createInMemoryXiaoguiNodeHubV1 } from './in-memory-node-hub'
import { startXiaoguiLanHubHttpServerV1 } from './lan-hub-http'
import {
  createXiaoguiLanPilotMainProcessCompositionV1,
  loadXiaoguiLanHubMainProcessConfigV1,
} from './lan-pilot-composition'

const HUB_TOKEN = 'hub-control-token-0000000000000001'
const NODE_A_TOKEN = 'node-a-control-token-000000000001'
const NODE_B_TOKEN = 'node-b-control-token-000000000001'
const PRIVATE_LAN_TEST_HOST = privateNonLoopbackIpv4()

describe('Xiaogui two-machine LAN HTTP pilot composition', () => {
  it('keeps the inbound hub disabled unless the HTTP pilot and explicit interface are configured', () => {
    expect(loadXiaoguiLanHubMainProcessConfigV1({})).toEqual({ ok: true, value: { enabled: false } })
    expect(loadXiaoguiLanHubMainProcessConfigV1({
      ...hubEnv('192.168.10.8', 9443),
      XIAOGUI_LAN_HTTP_PILOT: '0',
    })).toEqual({ ok: false, reasonCode: 'LAN_HUB_HTTP_PILOT_NOT_ENABLED' })
    expect(loadXiaoguiLanHubMainProcessConfigV1({
      ...hubEnv('0.0.0.0', 9443),
    })).toEqual({ ok: false, reasonCode: 'LAN_HUB_BIND_HOST_INVALID' })
  })

  it('rejects direct non-loopback hub exposure outside the pilot composition gate', async () => {
    const manifests = trustedManifests()
    await expect(startXiaoguiLanHubHttpServerV1({
      hub: createInMemoryXiaoguiNodeHubV1({ trustedManifests: manifests }),
      authorization: {
        hubToken: HUB_TOKEN,
        nodeTokens: new Map([['xiaogui-a', NODE_A_TOKEN], ['xiaogui-b', NODE_B_TOKEN]]),
        trustedManifests: manifests,
      },
      bindHost: '192.168.10.8',
    })).rejects.toThrow('LAN_HUB_EXPOSURE_NOT_APPROVED')
  })

  it.each([
    undefined,
    '0.0.0.0',
    '127.0.0.1',
    'localhost',
    '8.8.8.8',
    '169.254.10.8',
    '100.64.10.8',
    '::1',
    'fd00::8',
    'xiaogui-hub.lan',
  ])('fails closed before listening when bindHost is not an RFC1918 literal IPv4: %s', async (bindHost) => {
    const error = await captureStartError(bindHost)
    expect(error).toBe('LAN_HUB_BIND_HOST_INVALID')
  })

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('runs two isolated node compositions over a non-loopback token-authenticated LAN socket', async () => {
    const bindHost = PRIVATE_LAN_TEST_HOST!
    const port = await reservePort(bindHost)
    const root = await mkdtemp(join(tmpdir(), 'xiaogui-two-node-pilot-'))
    const nodeARoot = join(root, 'node-a')
    const nodeBRoot = join(root, 'node-b')
    const executeA = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:node-a-result' }))
    const executeB = vi.fn(async () => ({ status: 'SUCCEEDED' as const, resultDigest: 'sha256:node-b-result' }))
    const approveB = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const hubMachine = createXiaoguiLanPilotMainProcessCompositionV1({
      env: {
        ...hubEnv(bindHost, port),
        ...nodeEnv('xiaogui-a', NODE_A_TOKEN, `http://${bindHost}:${port}`, 'WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'),
      },
      userDataDir: nodeARoot,
      approveLocal: async () => true,
      executeLocal: executeA,
      now: () => '2026-08-27T04:00:00.000Z',
    })
    const secondMachine = createXiaoguiLanPilotMainProcessCompositionV1({
      env: nodeEnv('xiaogui-b', NODE_B_TOKEN, `http://${bindHost}:${port}`, 'CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'),
      userDataDir: nodeBRoot,
      approveLocal: approveB,
      executeLocal: executeB,
      now: () => '2026-08-27T04:00:00.000Z',
    })
    if (!hubMachine.ok || !secondMachine.ok) throw new Error('pilot composition config failed')

    try {
      await expect(hubMachine.value.start()).resolves.toEqual({ ok: true })
      await expect(secondMachine.value.start()).resolves.toEqual({ ok: true })
      const hub = hubMachine.value.hub()
      if (!hub) throw new Error('hub unavailable')
      const work = await hub.offer({
        taskId: 'task-node-a',
        requiredCapabilities: ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'],
        dataEgressPolicy: 'LOCAL_ONLY',
        payloadRef: { mediaType: 'application/vnd.xiaogui.assignment-payload+json', artifactId: 'artifact-a', digest: 'sha256:a' },
      })
      const coding = await hub.offer({
        taskId: 'task-node-b',
        requiredCapabilities: ['CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'],
        dataEgressPolicy: 'LOCAL_ONLY',
        payloadRef: { mediaType: 'application/vnd.xiaogui.assignment-payload+json', artifactId: 'artifact-b', digest: 'sha256:b' },
      })
      expect(work).toMatchObject({ ok: true, envelope: { targetNodeId: 'xiaogui-a' } })
      expect(coding).toMatchObject({ ok: true, envelope: { targetNodeId: 'xiaogui-b' } })
      await expect(hubMachine.value.pollOnce()).resolves.toMatchObject({ ok: true, value: { status: 'COMPLETED' } })
      await expect(secondMachine.value.pollOnce()).resolves.toMatchObject({ ok: true, value: { status: 'WAITING_LOCAL_APPROVAL' } })
      expect(executeB).not.toHaveBeenCalled()
      await expect(secondMachine.value.pollOnce()).resolves.toMatchObject({ ok: true, value: { status: 'COMPLETED' } })
      expect(executeA).toHaveBeenCalledTimes(1)
      expect(executeB).toHaveBeenCalledTimes(1)
      const publicStatus = JSON.stringify({ hub: hubMachine.value.status(), node: secondMachine.value.status() })
      expect(publicStatus).not.toContain(HUB_TOKEN)
      expect(publicStatus).not.toContain(NODE_A_TOKEN)
      expect(publicStatus).not.toContain(NODE_B_TOKEN)
      expect(publicStatus).not.toContain(`http://${bindHost}:${port}`)

      await hubMachine.value.stop()
      await expect(secondMachine.value.pollOnce()).resolves.toEqual({ ok: false, reasonCode: 'LAN_WORKER_TRANSPORT_FAILED' })
      await expect(hubMachine.value.start()).resolves.toEqual({ ok: true })
      await expect(secondMachine.value.start()).resolves.toEqual({ ok: true })
      await expect(secondMachine.value.pollOnce()).resolves.toEqual({ ok: true, value: { status: 'NO_WORK' } })
      expect(executeB).toHaveBeenCalledTimes(1)
    } finally {
      await secondMachine.value.stop()
      await hubMachine.value.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('reports DEGRADED when the Hub assignment store fails after the listener starts', async () => {
    const bindHost = PRIVATE_LAN_TEST_HOST!
    const port = await reservePort(bindHost)
    const root = await mkdtemp(join(tmpdir(), 'xiaogui-hub-store-failure-'))
    const composition = createXiaoguiLanPilotMainProcessCompositionV1({
      env: hubEnv(bindHost, port),
      userDataDir: root,
      approveLocal: async () => true,
      executeLocal: async () => ({ status: 'SUCCEEDED', resultDigest: 'sha256:unused' }),
      hubAssignmentStore: {
        async load() { throw new Error('store unavailable') },
        async replace() { throw new Error('store unavailable') },
      },
    })
    if (!composition.ok) throw new Error('composition config failed')
    try {
      await expect(composition.value.start()).resolves.toEqual({ ok: true })
      expect(composition.value.status().hub).toMatchObject({ state: 'RUNNING' })
      await expect(composition.value.hub()?.offer({
        taskId: 'task-store-failure',
        requiredCapabilities: ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'],
        dataEgressPolicy: 'LOCAL_ONLY',
        payloadRef: {
          mediaType: 'application/vnd.xiaogui.assignment-payload+json',
          artifactId: 'artifact-store-failure',
          digest: 'sha256:store-failure',
        },
      })).resolves.toEqual({ ok: false, reasonCode: 'HUB_ASSIGNMENT_STORE_FAILED' })
      expect(composition.value.status().hub).toEqual({ state: 'DEGRADED', reasonCode: 'HUB_ASSIGNMENT_STORE_FAILED' })
    } finally {
      await composition.value.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

function hubEnv(bindHost: string, port: number): Record<string, string> {
  const manifests = trustedManifests()
  return {
    XIAOGUI_LAN_HTTP_PILOT: '1',
    XIAOGUI_LAN_HUB_ENABLED: '1',
    XIAOGUI_LAN_HUB_ID: 'xiaogui-lan-pilot-hub',
    XIAOGUI_LAN_HUB_BIND_HOST: bindHost,
    XIAOGUI_LAN_HUB_PORT: String(port),
    XIAOGUI_LAN_HUB_TOKEN: HUB_TOKEN,
    XIAOGUI_LAN_HUB_APPROVED_NODES: JSON.stringify([
      { nodeId: 'xiaogui-a', token: NODE_A_TOKEN, manifest: manifests.get('xiaogui-a') },
      { nodeId: 'xiaogui-b', token: NODE_B_TOKEN, manifest: manifests.get('xiaogui-b') },
    ]),
  }
}

function nodeEnv(
  nodeId: string,
  nodeToken: string,
  hubOrigin: string,
  ...capabilities: string[]
): Record<string, string> {
  return {
    XIAOGUI_LAN_HTTP_PILOT: '1',
    XIAOGUI_LAN_NODE_ENABLED: '1',
    XIAOGUI_LAN_NODE_ID: nodeId,
    XIAOGUI_LAN_NODE_TOKEN: nodeToken,
    XIAOGUI_LAN_HUB_ORIGIN: hubOrigin,
    XIAOGUI_LAN_NODE_CAPABILITIES: capabilities.join(','),
    XIAOGUI_LAN_NODE_DATA_EGRESS: 'LOCAL_ONLY',
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

function reservePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('PORT_RESERVATION_FAILED'))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function captureStartError(bindHost: string | undefined): Promise<string | null> {
  const manifests = trustedManifests()
  try {
    const server = await startXiaoguiLanHubHttpServerV1({
      hub: createInMemoryXiaoguiNodeHubV1({ trustedManifests: manifests }),
      authorization: {
        hubToken: HUB_TOKEN,
        nodeTokens: new Map([['xiaogui-a', NODE_A_TOKEN], ['xiaogui-b', NODE_B_TOKEN]]),
        trustedManifests: manifests,
      },
      ...(bindHost ? { bindHost } : {}),
      exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
    })
    await server.close()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function trustedManifests() {
  return new Map([
    ['xiaogui-a', trustedManifest('xiaogui-a', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'])],
    ['xiaogui-b', trustedManifest('xiaogui-b', ['CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'])],
  ])
}

function trustedManifest(nodeId: string, capabilities: readonly ('WORK.DOCX.TEMPLATE' | 'CODING.TYPESCRIPT' | 'EXECUTION.LOCAL_ONLY')[]) {
  return {
    identity: { nodeId, protocolVersion: 'xiaogui-node.v1' as const, product: 'XIAOGUI_DESKTOP' as const, displayName: `小规 ${nodeId}` },
    capabilities,
    dataEgressPolicy: 'LOCAL_ONLY' as const,
    health: 'ONLINE' as const,
    leaseTtlMs: 30_000,
    updatedAt: '2026-08-27T04:00:00.000Z',
    designReserved: true as const,
  }
}
