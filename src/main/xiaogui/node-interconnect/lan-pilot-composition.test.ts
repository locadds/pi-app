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
    await expect(startXiaoguiLanHubHttpServerV1({
      hub: createInMemoryXiaoguiNodeHubV1(),
      authorization: {
        hubToken: HUB_TOKEN,
        nodeTokens: new Map([['xiaogui-a', NODE_A_TOKEN], ['xiaogui-b', NODE_B_TOKEN]]),
      },
      bindHost: '192.168.10.8',
    })).rejects.toThrow('LAN_HUB_EXPOSURE_NOT_APPROVED')
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
})

function hubEnv(bindHost: string, port: number): Record<string, string> {
  return {
    XIAOGUI_LAN_HTTP_PILOT: '1',
    XIAOGUI_LAN_HUB_ENABLED: '1',
    XIAOGUI_LAN_HUB_ID: 'xiaogui-lan-pilot-hub',
    XIAOGUI_LAN_HUB_BIND_HOST: bindHost,
    XIAOGUI_LAN_HUB_PORT: String(port),
    XIAOGUI_LAN_HUB_TOKEN: HUB_TOKEN,
    XIAOGUI_LAN_HUB_NODE_TOKENS: JSON.stringify({ 'xiaogui-a': NODE_A_TOKEN, 'xiaogui-b': NODE_B_TOKEN }),
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
