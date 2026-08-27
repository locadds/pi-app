import { networkInterfaces } from 'node:os'

import { describe, expect, it } from 'vitest'

import type { RuntimeCapabilityV2 } from '@shared/xiaogui-agent-runtime'
import { ScriptedAgentRuntimeAdapterV1 } from '../agent-runtime/scripted-adapter'
import { createAgentRuntimeRegistryV1 } from '../agent-runtime/runtime-registry'
import { createInMemoryXiaoguiNodeHubV1 } from './in-memory-node-hub'
import { startXiaoguiLanHubHttpServerV1 } from './lan-hub-http'
import { createXiaoguiLanWorkerV1 } from './lan-worker'

const HUB_TOKEN = 'hub-control-token-0000000000000001'
const NODE_TOKEN = 'node-b-control-token-000000000001'
const PRIVATE_LAN_TEST_HOST = privateNonLoopbackIpv4()

describe('dual-axis joint smoke', () => {
  it.skipIf(!PRIVATE_LAN_TEST_HOST)('routes to a Xiaogui node and then to its private runtime without leaking runtime identity upstream', async () => {
    const manifest = {
      identity: { nodeId: 'xiaogui-b', protocolVersion: 'xiaogui-node.v1' as const, product: 'XIAOGUI_DESKTOP' as const, displayName: '小规 B' },
      capabilities: ['CODING.TYPESCRIPT' as const, 'EXECUTION.LOCAL_ONLY' as const], dataEgressPolicy: 'LOCAL_ONLY' as const, health: 'ONLINE' as const,
      leaseTtlMs: 30_000, updatedAt: '2026-08-25T03:00:00.000Z', designReserved: true as const,
    }
    const trustedManifests = new Map([['xiaogui-b', manifest]])
    const hub = createInMemoryXiaoguiNodeHubV1({ trustedManifests, now: () => '2026-08-25T03:00:00.000Z' })
    const server = await startXiaoguiLanHubHttpServerV1({
      hub,
      authorization: { hubToken: HUB_TOKEN, nodeTokens: new Map([['xiaogui-b', NODE_TOKEN]]), trustedManifests },
      bindHost: PRIVATE_LAN_TEST_HOST!,
      exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
    })
    const registry = createAgentRuntimeRegistryV1()
    await registry.register(new ScriptedAgentRuntimeAdapterV1({ capabilities: [localRuntime()] }))
    try {
      const worker = createXiaoguiLanWorkerV1({
        origin: server.origin,
        nodeToken: NODE_TOKEN,
        manifest,
        approveLocal: async () => true,
        executeLocal: async () => {
          const routed = await registry.resolve({
            mode: 'CODING', requiredCapabilities: ['CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'], dataEgressPolicy: 'LOCAL_ONLY',
            priorityAdapterIds: ['private-local-agent'], requireProductionApproval: true,
          })
          if (!routed.ok) return { status: 'FAILED', reasonCode: 'LOCAL_RUNTIME_ROUTE_FAILED' }
          return { status: 'SUCCEEDED', resultDigest: 'sha256:node-b-delivery' }
        },
      })
      await worker.register()
      const offered = await post(server.origin, '/offer', {
        taskId: 'task-from-xiaogui-a', requiredCapabilities: ['CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'], dataEgressPolicy: 'LOCAL_ONLY',
        payloadRef: { mediaType: 'application/vnd.xiaogui.assignment-payload+json', artifactId: 'brief-1', digest: 'sha256:brief' },
      }, HUB_TOKEN) as { ok: true; envelope: { assignmentId: string } }
      await expect(worker.pollOnce()).resolves.toMatchObject({ ok: true, value: { status: 'COMPLETED' } })
      const reconciled = await post(server.origin, '/reconcile', { assignmentId: offered.envelope.assignmentId }, HUB_TOKEN)
      expect(reconciled).toEqual({ ok: true, status: 'COMPLETED', resultDigest: 'sha256:node-b-delivery' })
      const events = await post(server.origin, '/events', {}, HUB_TOKEN)
      expect(JSON.stringify(events)).not.toContain('private-local-agent')
      expect(JSON.stringify(events)).not.toContain('runtimeSession')
    } finally {
      await registry.close()
      await server.close()
    }
  })
})

function localRuntime(): RuntimeCapabilityV2 {
  return {
    adapterId: 'private-local-agent', runtimeKind: 'OTHER', protocol: 'HEADLESS', capabilityDigest: 'sha256:private-local',
    approvalStatus: 'APPROVED_FOR_PRODUCTION', health: 'AVAILABLE', canCreateSession: true, canResumeSession: true,
    stream: 'POLL', interrupt: 'BEST_EFFORT', inspect: 'RECONCILE', interactivePermission: 'HOST_MEDIATED', diagnosticOnly: false,
    version: 2, runtimeVersion: '1.0.0', capabilitySummary: '本机隔离运行时', workModes: ['CODING'],
    taskCapabilities: ['CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'], executionLocation: 'LOCAL', requiresDataEgress: false,
    supportsResume: true, supportsEventStream: true, supportsInterrupt: true, supportsResultReconcile: true,
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

async function post(origin: string, route: string, body: unknown, token: string): Promise<unknown> {
  const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  return response.json()
}
