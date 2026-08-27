import { networkInterfaces } from 'node:os'

import { describe, expect, it } from 'vitest'

import type { XiaoguiNodeCapabilityManifestV1 } from '@shared/xiaogui-node-contract'
import { createInMemoryXiaoguiNodeHubV1 } from './in-memory-node-hub'
import { startXiaoguiLanHubHttpServerV1 } from './lan-hub-http'

const HUB_TOKEN = 'hub-control-token-0000000000000001'
const NODE_A_TOKEN = 'node-a-control-token-000000000001'
const NODE_B_TOKEN = 'node-b-control-token-000000000001'
const PRIVATE_LAN_TEST_HOST = privateNonLoopbackIpv4()

describe('Xiaogui LAN Hub security boundary', () => {
  it.skipIf(!PRIVATE_LAN_TEST_HOST)('rejects duplicate node tokens before opening the listener', async () => {
    const approvedA = node('node-a', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'])
    const approvedB = node('node-b', ['CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'])
    const manifests = new Map([['node-a', approvedA], ['node-b', approvedB]])
    const hub = createInMemoryXiaoguiNodeHubV1({ trustedManifests: manifests })

    await expect(startXiaoguiLanHubHttpServerV1({
      hub,
      authorization: {
        hubToken: HUB_TOKEN,
        nodeTokens: new Map([['node-a', NODE_A_TOKEN], ['node-b', NODE_A_TOKEN]]),
        trustedManifests: manifests,
      },
      bindHost: PRIVATE_LAN_TEST_HOST!,
      exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
    })).rejects.toThrow('LAN_NODE_IDENTITY_BINDING_INVALID')
  })

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('rejects swapped identities and self-promoted manifests without polluting routing state', async () => {
    const approvedA = node('node-a', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'])
    const approvedB = node('node-b', ['CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'])
    const manifests = new Map([['node-a', approvedA], ['node-b', approvedB]])
    const hub = createInMemoryXiaoguiNodeHubV1({ trustedManifests: manifests })
    const server = await startXiaoguiLanHubHttpServerV1({
      hub,
      authorization: {
        hubToken: HUB_TOKEN,
        nodeTokens: new Map([['node-a', NODE_A_TOKEN], ['node-b', NODE_B_TOKEN]]),
        trustedManifests: manifests,
      },
      bindHost: PRIVATE_LAN_TEST_HOST!,
      exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
    })
    try {
      await expect(post(server.origin, '/register', { manifest: approvedA }, NODE_B_TOKEN)).resolves.toEqual({
        status: 401,
        body: { ok: false, reasonCode: 'LAN_NODE_UNAUTHORIZED' },
      })
      await expect(post(server.origin, '/register', {
        manifest: node('node-a', ['WORK.DOCX.TEMPLATE', 'CODING.TYPESCRIPT', 'EXECUTION.EXTERNAL_ALLOWED'], 'EXTERNAL_ALLOWED'),
      }, NODE_A_TOKEN)).resolves.toEqual({
        status: 409,
        body: { ok: false, reasonCode: 'NODE_MANIFEST_NOT_APPROVED' },
      })

      await expect(post(server.origin, '/register', { manifest: approvedA }, NODE_A_TOKEN)).resolves.toEqual({
        status: 200,
        body: { ok: true },
      })
      await expect(post(server.origin, '/offer', offer('task-spoofed-route', ['CODING.TYPESCRIPT'], 'EXTERNAL_ALLOWED'), HUB_TOKEN)).resolves.toEqual({
        status: 409,
        body: { ok: false, reasonCode: 'NO_NODE_CAPABILITY' },
      })
      await expect(post(server.origin, '/offer', offer('task-approved-route', ['WORK.DOCX.TEMPLATE'], 'LOCAL_ONLY'), HUB_TOKEN)).resolves.toMatchObject({
        status: 200,
        body: { ok: true, envelope: { targetNodeId: 'node-a' } },
      })
    } finally {
      await server.close()
    }
  })

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('returns safe 4xx responses for malformed JSON route bodies and leaves Hub state clean', async () => {
    const approvedA = node('node-a', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'])
    const manifests = new Map([['node-a', approvedA]])
    const hub = createInMemoryXiaoguiNodeHubV1({ trustedManifests: manifests })
    const server = await startXiaoguiLanHubHttpServerV1({
      hub,
      authorization: {
        hubToken: HUB_TOKEN,
        nodeTokens: new Map([['node-a', NODE_A_TOKEN]]),
        trustedManifests: manifests,
      },
      bindHost: PRIVATE_LAN_TEST_HOST!,
      exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
    })
    try {
      await expect(post(server.origin, '/register', { manifest: { identity: { nodeId: 'node-a' } } }, NODE_A_TOKEN)).resolves.toEqual({
        status: 400,
        body: { ok: false, reasonCode: 'LAN_REQUEST_INVALID' },
      })
      await expect(post(server.origin, '/offer', { taskId: 'task-malformed' }, HUB_TOKEN)).resolves.toEqual({
        status: 400,
        body: { ok: false, reasonCode: 'LAN_REQUEST_INVALID' },
      })
      await expect(postRaw(server.origin, '/offer', '{')).resolves.toEqual({
        status: 400,
        body: { ok: false, reasonCode: 'LAN_JSON_INVALID' },
      })

      await post(server.origin, '/register', { manifest: approvedA }, NODE_A_TOKEN)
      await expect(post(server.origin, '/offer', offer('task-malformed', ['WORK.DOCX.TEMPLATE'], 'LOCAL_ONLY'), HUB_TOKEN)).resolves.toMatchObject({
        status: 200,
        body: { ok: true },
      })
    } finally {
      await server.close()
    }
  })

  it.skipIf(!PRIVATE_LAN_TEST_HOST)('fails closed when the Hub port returns a malformed route response', async () => {
    const approvedA = node('node-a', ['WORK.DOCX.TEMPLATE', 'EXECUTION.LOCAL_ONLY'])
    const manifests = new Map([['node-a', approvedA]])
    const realHub = createInMemoryXiaoguiNodeHubV1({ trustedManifests: manifests })
    const malformedHub = new Proxy(realHub, {
      get(target, property, receiver) {
        if (property === 'offer') return async () => ({ ok: true, envelope: {} })
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const server = await startXiaoguiLanHubHttpServerV1({
      hub: malformedHub,
      authorization: {
        hubToken: HUB_TOKEN,
        nodeTokens: new Map([['node-a', NODE_A_TOKEN]]),
        trustedManifests: manifests,
      },
      bindHost: PRIVATE_LAN_TEST_HOST!,
      exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
    })
    try {
      await expect(post(
        server.origin,
        '/offer',
        offer('task-malformed-response', ['WORK.DOCX.TEMPLATE'], 'LOCAL_ONLY'),
        HUB_TOKEN,
      )).resolves.toEqual({
        status: 500,
        body: { ok: false, reasonCode: 'LAN_HUB_RESPONSE_INVALID' },
      })
    } finally {
      await server.close()
    }
  })
})

function node(
  nodeId: string,
  capabilities: XiaoguiNodeCapabilityManifestV1['capabilities'],
  dataEgressPolicy: XiaoguiNodeCapabilityManifestV1['dataEgressPolicy'] = 'LOCAL_ONLY',
): XiaoguiNodeCapabilityManifestV1 {
  return {
    identity: { nodeId, protocolVersion: 'xiaogui-node.v1', product: 'XIAOGUI_DESKTOP', displayName: nodeId },
    capabilities,
    dataEgressPolicy,
    health: 'ONLINE',
    leaseTtlMs: 30_000,
    updatedAt: '2026-08-27T06:00:00.000Z',
    designReserved: true,
  }
}

function offer(
  taskId: string,
  requiredCapabilities: XiaoguiNodeCapabilityManifestV1['capabilities'],
  dataEgressPolicy: XiaoguiNodeCapabilityManifestV1['dataEgressPolicy'],
) {
  return {
    taskId,
    requiredCapabilities,
    dataEgressPolicy,
    payloadRef: {
      mediaType: 'application/vnd.xiaogui.assignment-payload+json',
      artifactId: `artifact-${taskId}`,
      digest: `sha256:${taskId}`,
    },
  }
}

async function post(origin: string, route: string, body: unknown, token: string) {
  const response = await fetch(`${origin}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function postRaw(origin: string, route: string, body: string) {
  const response = await fetch(`${origin}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${HUB_TOKEN}` },
    body,
  })
  return { status: response.status, body: await response.json() }
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
