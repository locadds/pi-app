import { isAbsolute } from 'node:path'

import type {
  XiaoguiAssignmentEnvelopeV1,
  XiaoguiNodeCapabilityManifestV1,
  XiaoguiNodePortV1,
} from '@shared/xiaogui-node-contract'
import { createInMemoryXiaoguiNodeHubV1 } from './in-memory-node-hub'
import type { HubAssignmentStoreV1 } from './hub-assignment-store'
import { parseXiaoguiLanNodeManifestV1 } from './lan-contract-shapes'
import {
  startXiaoguiLanHubHttpServerV1,
  type XiaoguiLanHubHttpServerV1,
} from './lan-hub-http'
import {
  createXiaoguiLanNodeMainProcessServiceV1,
  loadXiaoguiLanNodeMainProcessConfigV1,
  type XiaoguiLanNodeMainProcessServiceStateV1,
} from './lan-node-service'
import type { XiaoguiLanWorkerPollResultV1 } from './lan-worker'
import { isRfc1918LiteralIpv4V1 } from './lan-network-policy'

type ConfigEnvironmentV1 = Readonly<Record<string, string | undefined>>

export type XiaoguiLanHubMainProcessConfigV1 =
  | { readonly enabled: false }
  | {
      readonly enabled: true
      readonly hubId: string
      readonly bindHost: string
      readonly port: number
      /** Private main-process values. They must never be returned through status or IPC. */
      readonly hubToken: string
      readonly nodeTokens: ReadonlyMap<string, string>
      readonly trustedManifests: ReadonlyMap<string, XiaoguiNodeCapabilityManifestV1>
      readonly exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT'
    }

export type XiaoguiLanHubMainProcessConfigResultV1 =
  | { ok: true; value: XiaoguiLanHubMainProcessConfigV1 }
  | { ok: false; reasonCode: string }

export function loadXiaoguiLanHubMainProcessConfigV1(
  env: ConfigEnvironmentV1 = process.env,
): XiaoguiLanHubMainProcessConfigResultV1 {
  const enablement = env.XIAOGUI_LAN_HUB_ENABLED?.trim()
  if (!enablement || enablement === '0') return { ok: true, value: { enabled: false } }
  if (enablement !== '1') return { ok: false, reasonCode: 'LAN_HUB_CONFIG_ENABLEMENT_INVALID' }
  if (env.XIAOGUI_LAN_HTTP_PILOT?.trim() !== '1') {
    return { ok: false, reasonCode: 'LAN_HUB_HTTP_PILOT_NOT_ENABLED' }
  }

  const hubId = env.XIAOGUI_LAN_HUB_ID?.trim() || 'xiaogui-lan-pilot-hub'
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(hubId)) return { ok: false, reasonCode: 'LAN_HUB_ID_INVALID' }
  const bindHost = env.XIAOGUI_LAN_HUB_BIND_HOST?.trim() ?? ''
  if (!isRfc1918LiteralIpv4V1(bindHost)) return { ok: false, reasonCode: 'LAN_HUB_BIND_HOST_INVALID' }
  const port = parsePort(env.XIAOGUI_LAN_HUB_PORT)
  if (port === null) return { ok: false, reasonCode: 'LAN_HUB_PORT_INVALID' }

  const hubToken = env.XIAOGUI_LAN_HUB_TOKEN ?? ''
  if (!isPrivateToken(hubToken)) return { ok: false, reasonCode: 'LAN_PRIVATE_TOKEN_INVALID' }
  const approvedNodes = parseApprovedNodes(env.XIAOGUI_LAN_HUB_APPROVED_NODES, hubToken)
  if (!approvedNodes.ok) return approvedNodes

  return {
    ok: true,
    value: {
      enabled: true,
      hubId,
      bindHost,
      port,
      hubToken,
      nodeTokens: approvedNodes.nodeTokens,
      trustedManifests: approvedNodes.trustedManifests,
      exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
    },
  }
}

export interface XiaoguiLanPilotMainProcessCompositionStatusV1 {
  hub:
    | { state: 'DISABLED' | 'STOPPED' }
    | { state: 'RUNNING'; exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT' }
    | { state: 'DEGRADED'; reasonCode: string }
  node: XiaoguiLanNodeMainProcessServiceStateV1
}

export interface XiaoguiLanPilotMainProcessCompositionV1 {
  start(): Promise<{ ok: true } | { ok: false; reasonCode: string }>
  pollOnce(): Promise<
    | { ok: true; value: XiaoguiLanWorkerPollResultV1 | { status: 'DISABLED' } }
    | { ok: false; reasonCode: string }
  >
  stop(): Promise<void>
  status(): XiaoguiLanPilotMainProcessCompositionStatusV1
  /** Existing port seam for TaskHub/scheduler integration; no database is created or changed here. */
  hub(): XiaoguiNodePortV1 | null
}

export type XiaoguiLanPilotMainProcessCompositionResultV1 =
  | { ok: true; value: XiaoguiLanPilotMainProcessCompositionV1 }
  | { ok: false; reasonCode: string }

export function createXiaoguiLanPilotMainProcessCompositionV1(options: {
  env?: ConfigEnvironmentV1
  userDataDir: string
  approveLocal: (envelope: XiaoguiAssignmentEnvelopeV1) => Promise<boolean>
  executeLocal: (envelope: XiaoguiAssignmentEnvelopeV1) => Promise<
    | { status: 'SUCCEEDED'; resultDigest: string }
    | { status: 'FAILED'; reasonCode: string }
  >
  now?: () => string
  hubAssignmentStore?: HubAssignmentStoreV1
}): XiaoguiLanPilotMainProcessCompositionResultV1 {
  const env = options.env ?? process.env
  const hubConfig = loadXiaoguiLanHubMainProcessConfigV1(env)
  if (!hubConfig.ok) return hubConfig
  const nodeConfig = loadXiaoguiLanNodeMainProcessConfigV1(env, options.now)
  if (!nodeConfig.ok) return nodeConfig
  if ((hubConfig.value.enabled || nodeConfig.value.enabled) && !isAbsolute(options.userDataDir)) {
    return { ok: false, reasonCode: 'LAN_USER_DATA_DIR_INVALID' }
  }

  let hubState: XiaoguiLanPilotMainProcessCompositionStatusV1['hub'] = hubConfig.value.enabled
    ? { state: 'STOPPED' }
    : { state: 'DISABLED' }
  const hub = hubConfig.value.enabled
    ? createInMemoryXiaoguiNodeHubV1({
        hubId: hubConfig.value.hubId,
        now: options.now,
        trustedManifests: hubConfig.value.trustedManifests,
        assignmentStore: options.hubAssignmentStore,
        userDataDir: options.userDataDir,
        onDegraded: (reasonCode) => { hubState = { state: 'DEGRADED', reasonCode } },
      })
    : null
  const nodeService = nodeConfig.value.enabled
    ? createXiaoguiLanNodeMainProcessServiceV1({
        config: nodeConfig.value,
        userDataDir: options.userDataDir,
        approveLocal: options.approveLocal,
        executeLocal: options.executeLocal,
      })
    : createXiaoguiLanNodeMainProcessServiceV1({ config: nodeConfig.value })
  let server: XiaoguiLanHubHttpServerV1 | null = null
  const composition: XiaoguiLanPilotMainProcessCompositionV1 = {
    async start() {
      if (hubConfig.value.enabled && !server) {
        try {
          server = await startXiaoguiLanHubHttpServerV1({
            hub: hub!,
            authorization: {
              hubToken: hubConfig.value.hubToken,
              nodeTokens: hubConfig.value.nodeTokens,
              trustedManifests: hubConfig.value.trustedManifests,
            },
            bindHost: hubConfig.value.bindHost,
            port: hubConfig.value.port,
            exposureMode: hubConfig.value.exposureMode,
          })
          hubState = {
            state: 'RUNNING',
            exposureMode: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT',
          }
        } catch {
          hubState = { state: 'DEGRADED', reasonCode: 'LAN_HUB_START_FAILED' }
          return { ok: false, reasonCode: 'LAN_HUB_START_FAILED' }
        }
      }

      const nodeStarted = await nodeService.start()
      if (!nodeStarted.ok) {
        if (server) {
          await server.close().catch(() => undefined)
          server = null
          hubState = hubConfig.value.enabled ? { state: 'STOPPED' } : { state: 'DISABLED' }
        }
        return nodeStarted
      }
      return { ok: true }
    },
    async pollOnce() {
      if (!nodeConfig.value.enabled) return { ok: true, value: { status: 'DISABLED' } }
      return nodeService.pollOnce()
    },
    async stop() {
      await nodeService.stop()
      if (server) {
        await server.close()
        server = null
      }
      hubState = hubConfig.value.enabled ? { state: 'STOPPED' } : { state: 'DISABLED' }
    },
    status() { return { hub: hubState, node: nodeService.status() } },
    hub() { return hub },
  }
  return { ok: true, value: composition }
}

function parseApprovedNodes(value: string | undefined, hubToken: string):
  | {
      ok: true
      nodeTokens: ReadonlyMap<string, string>
      trustedManifests: ReadonlyMap<string, XiaoguiNodeCapabilityManifestV1>
    }
  | { ok: false; reasonCode: string } {
  try {
    const parsed = JSON.parse(value ?? '') as unknown
    if (!Array.isArray(parsed) || parsed.length < 1) {
      return { ok: false, reasonCode: 'LAN_HUB_APPROVED_NODES_INVALID' }
    }
    const nodeTokens = new Map<string, string>()
    const trustedManifests = new Map<string, XiaoguiNodeCapabilityManifestV1>()
    const tokens = new Set<string>([hubToken])
    for (const entry of parsed) {
      if (!isRecord(entry) || !hasOnlyKeys(entry, ['nodeId', 'token', 'manifest'])) {
        return { ok: false, reasonCode: 'LAN_HUB_APPROVED_NODES_INVALID' }
      }
      const manifest = parseXiaoguiLanNodeManifestV1(entry.manifest)
      if (
        typeof entry.nodeId !== 'string'
        || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(entry.nodeId)
        || typeof entry.token !== 'string'
        || !isPrivateToken(entry.token)
        || tokens.has(entry.token)
        || nodeTokens.has(entry.nodeId)
        || !manifest
        || String(manifest.identity.nodeId) !== entry.nodeId
      ) {
        return { ok: false, reasonCode: 'LAN_NODE_IDENTITY_BINDING_INVALID' }
      }
      nodeTokens.set(entry.nodeId, entry.token)
      trustedManifests.set(entry.nodeId, manifest)
      tokens.add(entry.token)
    }
    return { ok: true, nodeTokens, trustedManifests }
  } catch {
    return { ok: false, reasonCode: 'LAN_HUB_APPROVED_NODES_INVALID' }
  }
}

function parsePort(value: string | undefined): number | null {
  const raw = value?.trim() ?? ''
  if (!/^[0-9]+$/.test(raw)) return null
  const port = Number(raw)
  return Number.isSafeInteger(port) && port >= 1024 && port <= 65_535 ? port : null
}

function isPrivateToken(token: string): boolean {
  return token === token.trim() && token.length >= 32 && !/[\r\n\0]/.test(token)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}
