import { isAbsolute } from 'node:path'

import {
  validateXiaoguiNodePublicDtoV1,
  type XiaoguiAssignmentEnvelopeV1,
  type XiaoguiNodeCapabilityManifestV1,
  type XiaoguiNodeCapabilityV1,
  type XiaoguiNodeDataEgressPolicyV1,
} from '@shared/xiaogui-node-contract'
import { createXiaoguiLanWorkerV1, type XiaoguiLanWorkerPollResultV1 } from './lan-worker'

const KNOWN_CAPABILITIES = new Set<XiaoguiNodeCapabilityV1>([
  'WORK.DOCX.TEMPLATE',
  'WORK.PDF.READ',
  'CODING.GIT.CHANGESET',
  'CODING.TYPESCRIPT',
  'EXECUTION.LOCAL_ONLY',
  'EXECUTION.EXTERNAL_ALLOWED',
  'DESIGN.RESERVED',
])

export type XiaoguiLanNodeMainProcessConfigV1 =
  | { readonly enabled: false }
  | {
      readonly enabled: true
      /** Private main-process value. It must never be returned through IPC or node public DTOs. */
      readonly hubOrigin: string
      /** Private main-process value. It must never be persisted in the assignment ledger. */
      readonly nodeToken: string
      readonly manifest: XiaoguiNodeCapabilityManifestV1
      readonly connectionMode: 'OUTBOUND_ONLY'
      readonly transportSecurity: 'TLS' | 'LOOPBACK_HTTP' | 'TOKEN_AUTHENTICATED_HTTP_PILOT'
      readonly localApproval: 'REQUIRED'
      readonly reconcileOnStart: true
    }

type EnabledLanNodeConfigV1 = Extract<XiaoguiLanNodeMainProcessConfigV1, { enabled: true }>
type ConfigEnvironmentV1 = Readonly<Record<string, string | undefined>>

export type XiaoguiLanNodeMainProcessConfigResultV1 =
  | { ok: true; value: XiaoguiLanNodeMainProcessConfigV1 }
  | { ok: false; reasonCode: string }

export function loadXiaoguiLanNodeMainProcessConfigV1(
  env: ConfigEnvironmentV1 = process.env,
  now: () => string = () => new Date().toISOString(),
): XiaoguiLanNodeMainProcessConfigResultV1 {
  const enablement = env.XIAOGUI_LAN_NODE_ENABLED?.trim()
  if (!enablement || enablement === '0') return { ok: true, value: { enabled: false } }
  if (enablement !== '1') return { ok: false, reasonCode: 'LAN_NODE_CONFIG_ENABLEMENT_INVALID' }

  const nodeId = env.XIAOGUI_LAN_NODE_ID?.trim() ?? ''
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(nodeId)) return { ok: false, reasonCode: 'LAN_NODE_ID_INVALID' }

  const nodeToken = env.XIAOGUI_LAN_NODE_TOKEN ?? ''
  if (nodeToken !== nodeToken.trim() || nodeToken.length < 32 || /[\r\n\0]/.test(nodeToken)) {
    return { ok: false, reasonCode: 'LAN_PRIVATE_TOKEN_INVALID' }
  }

  const hubOrigin = normalizeHubOrigin(env.XIAOGUI_LAN_HUB_ORIGIN, env.XIAOGUI_LAN_HTTP_PILOT?.trim() === '1')
  if (!hubOrigin.ok) return hubOrigin

  const capabilities = parseCapabilities(env.XIAOGUI_LAN_NODE_CAPABILITIES)
  if (!capabilities.ok) return capabilities

  const dataEgressPolicy = env.XIAOGUI_LAN_NODE_DATA_EGRESS?.trim() || 'LOCAL_ONLY'
  if (dataEgressPolicy !== 'LOCAL_ONLY' && dataEgressPolicy !== 'EXTERNAL_ALLOWED') {
    return { ok: false, reasonCode: 'LAN_NODE_DATA_EGRESS_INVALID' }
  }

  const leaseTtlMs = parseBoundedInteger(env.XIAOGUI_LAN_NODE_LEASE_TTL_MS, 30_000, 5_000, 300_000)
  if (leaseTtlMs === null) return { ok: false, reasonCode: 'LAN_NODE_LEASE_TTL_INVALID' }

  const updatedAt = now()
  if (!Number.isFinite(Date.parse(updatedAt))) return { ok: false, reasonCode: 'LAN_NODE_CLOCK_INVALID' }
  const displayName = env.XIAOGUI_LAN_NODE_DISPLAY_NAME?.trim() || `小规 ${nodeId}`
  if (!displayName || displayName.length > 64) return { ok: false, reasonCode: 'LAN_NODE_DISPLAY_NAME_INVALID' }

  const manifest: XiaoguiNodeCapabilityManifestV1 = {
    identity: {
      nodeId,
      protocolVersion: 'xiaogui-node.v1',
      product: 'XIAOGUI_DESKTOP',
      displayName,
    },
    capabilities: capabilities.value,
    dataEgressPolicy: dataEgressPolicy as XiaoguiNodeDataEgressPolicyV1,
    health: 'ONLINE',
    leaseTtlMs,
    updatedAt,
    designReserved: true,
  }
  if (!validateXiaoguiNodePublicDtoV1(manifest).ok) return { ok: false, reasonCode: 'LAN_NODE_MANIFEST_INVALID' }

  return {
    ok: true,
    value: {
      enabled: true,
      hubOrigin: hubOrigin.value,
      nodeToken,
      manifest,
      connectionMode: 'OUTBOUND_ONLY',
      transportSecurity: hubOrigin.transportSecurity,
      localApproval: 'REQUIRED',
      reconcileOnStart: true,
    },
  }
}

export type XiaoguiLanNodeMainProcessServiceStateV1 =
  | { state: 'DISABLED' }
  | { state: 'STOPPED' }
  | { state: 'RUNNING' }
  | { state: 'DEGRADED'; reasonCode: string }

export interface XiaoguiLanNodeMainProcessServiceV1 {
  start(): Promise<{ ok: true; state: 'DISABLED' | 'RUNNING' } | { ok: false; reasonCode: string }>
  pollOnce(): Promise<
    | { ok: true; value: XiaoguiLanWorkerPollResultV1 }
    | { ok: false; reasonCode: string }
  >
  status(): XiaoguiLanNodeMainProcessServiceStateV1
  stop(): Promise<void>
}

type EnabledServiceOptionsV1 = {
  config: EnabledLanNodeConfigV1
  /** Electron composition must pass app.getPath('userData'); the ledger stores no token or origin. */
  userDataDir: string
  approveLocal: (envelope: XiaoguiAssignmentEnvelopeV1) => Promise<boolean>
  executeLocal: (envelope: XiaoguiAssignmentEnvelopeV1) => Promise<
    | { status: 'SUCCEEDED'; resultDigest: string }
    | { status: 'FAILED'; reasonCode: string }
  >
}

export function createXiaoguiLanNodeMainProcessServiceV1(
  options: { config: { enabled: false } } | EnabledServiceOptionsV1,
): XiaoguiLanNodeMainProcessServiceV1 {
  if (isDisabledServiceOptions(options)) return disabledService()
  if (!isAbsolute(options.userDataDir)) throw new Error('LAN_NODE_USER_DATA_DIR_INVALID')

  const worker = createXiaoguiLanWorkerV1({
    origin: options.config.hubOrigin,
    nodeToken: options.config.nodeToken,
    manifest: options.config.manifest,
    approveLocal: options.approveLocal,
    executeLocal: options.executeLocal,
    userDataDir: options.userDataDir,
  })
  let state: XiaoguiLanNodeMainProcessServiceStateV1 = { state: 'STOPPED' }

  return {
    async start() {
      if (state.state === 'RUNNING') return { ok: true, state: 'RUNNING' }
      const registered = await worker.register()
      if (!registered.ok) {
        state = { state: 'DEGRADED', reasonCode: registered.reasonCode }
        return registered
      }
      const reconciled = await worker.reconcile()
      if (!reconciled.ok) {
        state = { state: 'DEGRADED', reasonCode: reconciled.reasonCode }
        return reconciled
      }
      state = { state: 'RUNNING' }
      return { ok: true, state: 'RUNNING' }
    },
    async pollOnce() {
      if (state.state !== 'RUNNING') return { ok: false, reasonCode: 'LAN_NODE_SERVICE_NOT_RUNNING' }
      const result = await worker.pollOnce()
      state = result.ok ? { state: 'RUNNING' } : { state: 'DEGRADED', reasonCode: result.reasonCode }
      return result
    },
    status() { return state },
    async stop() { state = { state: 'STOPPED' } },
  }
}

function isDisabledServiceOptions(
  options: { config: { enabled: false } } | EnabledServiceOptionsV1,
): options is { config: { enabled: false } } {
  return options.config.enabled === false
}

function disabledService(): XiaoguiLanNodeMainProcessServiceV1 {
  return {
    async start() { return { ok: true, state: 'DISABLED' } },
    async pollOnce() { return { ok: false, reasonCode: 'LAN_NODE_SERVICE_DISABLED' } },
    status() { return { state: 'DISABLED' } },
    async stop() { return undefined },
  }
}

function normalizeHubOrigin(value: string | undefined, allowHttpPilot: boolean):
  | {
      ok: true
      value: string
      transportSecurity: EnabledLanNodeConfigV1['transportSecurity']
    }
  | { ok: false; reasonCode: string } {
  const raw = value?.trim() ?? ''
  if (!raw) return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_INVALID' }
  try {
    const parsed = new URL(raw)
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    ) {
      return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_INVALID' }
    }
    const loopback = isLoopbackHost(parsed.hostname)
    if (parsed.protocol === 'http:' && !loopback) {
      if (!isPrivateLanIpv4(parsed.hostname)) {
        return { ok: false, reasonCode: 'LAN_NODE_HTTP_PILOT_ORIGIN_INVALID' }
      }
      if (!allowHttpPilot) return { ok: false, reasonCode: 'LAN_NODE_HTTP_PILOT_NOT_ENABLED' }
    }
    return {
      ok: true,
      value: parsed.origin,
      transportSecurity: parsed.protocol === 'https:'
        ? 'TLS'
        : loopback
          ? 'LOOPBACK_HTTP'
          : 'TOKEN_AUTHENTICATED_HTTP_PILOT',
    }
  } catch {
    return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_INVALID' }
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]' || normalized === '::1'
}

function isPrivateLanIpv4(value: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false
  const octets = value.split('.').map(Number)
  if (octets.some((octet) => octet < 0 || octet > 255)) return false
  const [first, second] = octets
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
}

function parseCapabilities(value: string | undefined):
  | { ok: true; value: readonly XiaoguiNodeCapabilityV1[] }
  | { ok: false; reasonCode: string } {
  const capabilities = [...new Set((value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean))]
  if (!capabilities.length || capabilities.some((capability) => !KNOWN_CAPABILITIES.has(capability as XiaoguiNodeCapabilityV1))) {
    return { ok: false, reasonCode: 'LAN_NODE_CAPABILITIES_INVALID' }
  }
  return { ok: true, value: capabilities as XiaoguiNodeCapabilityV1[] }
}

function parseBoundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number | null {
  if (value == null || value.trim() === '') return fallback
  if (!/^[0-9]+$/.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
}
