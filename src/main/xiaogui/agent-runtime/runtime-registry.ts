import {
  isRuntimePublicSessionId,
  runtimeSelectionKey,
  validateRuntimePublicDto,
  type AdapterIdV1,
  type AgentRuntimeAdapterV1,
  type AgentRuntimeRegistryV1,
  type RuntimeAdapterSelectionV1,
  type RuntimeCapabilityV1,
  type RuntimeCapabilityV2,
  type RuntimeCreateOrResumeOutcomeV1,
  type RuntimeCreateOrResumeRequestV1,
  type RuntimeEventV1,
  type RuntimeInterruptRequestV1,
  type RuntimeOutcomeV1,
  type RuntimePermissionDecisionV1,
  type RuntimeRequiredOperationV1,
  type RuntimeRouteFailureReasonV1,
  type RuntimeRouteResultV1,
  type RuntimeRoutingPolicyV1,
  type RuntimeSendRequestV1,
} from '@shared/xiaogui-agent-runtime'

interface RegisteredAdapterV1 {
  adapter: AgentRuntimeAdapterV1
  adapterIds: Set<string>
}

interface RestorableRuntimeAdapterV1 {
  restoreRuntimeSession(runtimeSessionId: string): Promise<
    { ok: true } | { ok: false; reasonCode: RuntimeRouteFailureReasonV1 }
  >
}

export function createAgentRuntimeRegistryV1(): AgentRuntimeRegistryV1 {
  return new InProcessAgentRuntimeRegistryV1()
}

class InProcessAgentRuntimeRegistryV1 implements AgentRuntimeRegistryV1 {
  private readonly registrations: RegisteredAdapterV1[] = []
  private readonly adaptersById = new Map<string, AgentRuntimeAdapterV1>()
  private readonly sessionAdapters = new Map<string, AgentRuntimeAdapterV1>()
  private readonly retiredAdapters = new Set<AgentRuntimeAdapterV1>()
  private closed = false

  async register(adapter: AgentRuntimeAdapterV1) {
    if (this.closed) return { ok: false as const, reasonCode: 'RUNTIME_REGISTRY_CLOSED' as const }
    if (this.registrations.some((registration) => registration.adapter === adapter)) {
      return { ok: false as const, reasonCode: 'RUNTIME_ADAPTER_ALREADY_REGISTERED' as const }
    }

    this.registrations.push({ adapter, adapterIds: new Set() })
    return { ok: true as const }
  }

  async unregister(adapterId: AdapterIdV1 | string) {
    if (this.closed) return { ok: false as const, reasonCode: 'RUNTIME_REGISTRY_CLOSED' as const }
    const adapter = this.adaptersById.get(String(adapterId))
    if (!adapter) return { ok: false as const, reasonCode: 'RUNTIME_ADAPTER_NOT_REGISTERED' as const }

    const index = this.registrations.findIndex((registration) => registration.adapter === adapter)
    if (index >= 0) {
      const [registration] = this.registrations.splice(index, 1)
      for (const id of registration.adapterIds) this.adaptersById.delete(id)
    }
    // Unregistering removes an adapter from new routing immediately, but an
    // in-flight attempt stays pinned to the adapter it started with. Closing
    // is therefore deferred until the registry itself closes.
    this.retiredAdapters.add(adapter)
    return { ok: true as const }
  }

  async restoreBinding(runtimeSessionId: string, selection: RuntimeAdapterSelectionV1) {
    if (this.closed) return { ok: false as const, reasonCode: 'RUNTIME_REGISTRY_CLOSED' as const }
    if (!isRuntimePublicSessionId(runtimeSessionId)) return { ok: false as const, reasonCode: 'PUBLIC_DTO_LEAK' as const }
    const adapterId = selection.adapterId
    const adapter = this.adaptersById.get(String(adapterId)) ?? await this.findAdapterByHealth(adapterId)
    if (!adapter) return { ok: false as const, reasonCode: 'RUNTIME_ADAPTER_NOT_REGISTERED' as const }
    const capability = await this.health(adapterId)
    const reason = staticRejection(capability, {
      mode: 'CODING',
      requiredCapabilities: [],
      dataEgressPolicy: 'EXTERNAL_ALLOWED',
      priorityAdapterIds: [adapterId],
      requireProductionApproval: true,
    })
    if (reason) return { ok: false as const, reasonCode: reason }
    if (runtimeSelectionKey(capability) !== runtimeSelectionKey(selection)) {
      return { ok: false as const, reasonCode: 'RUNTIME_PREFERRED_NOT_AVAILABLE' as const }
    }
    if (hasRuntimeSessionRestorer(adapter)) {
      const restored = await adapter.restoreRuntimeSession(runtimeSessionId)
      if (!restored.ok) return restored
    }
    this.sessionAdapters.set(runtimeSessionId, adapter)
    return { ok: true as const }
  }

  async discover(): Promise<readonly RuntimeCapabilityV1[]> {
    if (this.closed) return [unavailableCapability('RUNTIME_REGISTRY_CLOSED')]
    const capabilities: RuntimeCapabilityV1[] = []
    for (const registration of this.registrations) {
      try {
        const discovered = await registration.adapter.discover()
        for (const capability of discovered) {
          if (validateRuntimePublicDto(capability).ok) {
            const existing = this.adaptersById.get(String(capability.adapterId))
            if (existing && existing !== registration.adapter) {
              capabilities.push(unavailableCapability('RUNTIME_ADAPTER_ALREADY_REGISTERED', capability.adapterId))
              continue
            }
            registration.adapterIds.add(String(capability.adapterId))
            this.adaptersById.set(String(capability.adapterId), registration.adapter)
            capabilities.push(capability)
          } else {
            capabilities.push(unavailableCapability('PUBLIC_DTO_LEAK', capability.adapterId))
          }
        }
      } catch {
        for (const adapterId of registration.adapterIds) capabilities.push(unavailableCapability('RUNTIME_ADAPTER_ERROR', adapterId))
      }
    }
    return capabilities
  }

  async health(adapterId: AdapterIdV1 | string): Promise<RuntimeCapabilityV1> {
    if (this.closed) return unavailableCapability('RUNTIME_REGISTRY_CLOSED', adapterId)
    let adapter = this.adaptersById.get(String(adapterId))
    if (!adapter) adapter = await this.findAdapterByHealth(adapterId)
    if (!adapter) return unavailableCapability('RUNTIME_ADAPTER_NOT_REGISTERED', adapterId)
    try {
      const capability = await adapter.health(adapterId)
      return validateRuntimePublicDto(capability).ok ? capability : unavailableCapability('PUBLIC_DTO_LEAK', adapterId)
    } catch {
      return unavailableCapability('RUNTIME_ADAPTER_ERROR', adapterId)
    }
  }

  async resolve(policy: RuntimeRoutingPolicyV1): Promise<RuntimeRouteResultV1> {
    if (this.closed) return { ok: false, reasonCode: 'RUNTIME_REGISTRY_CLOSED' }
    const capabilities = await this.discover()
    const rejectedAdapterIds: string[] = []

    if (policy.preferredAdapterId) {
      const preferred = capabilities.find((capability) => capability.adapterId === policy.preferredAdapterId)
      if (!preferred) return { ok: false, reasonCode: 'RUNTIME_PREFERRED_NOT_AVAILABLE', rejectedAdapterIds }
      const accepted = await this.acceptCapability(preferred, policy, true)
      if (accepted.ok) return accepted
      return { ok: false, reasonCode: 'RUNTIME_PREFERRED_NOT_AVAILABLE', rejectedAdapterIds: [String(policy.preferredAdapterId)] }
    }

    for (const capability of orderCapabilities(capabilities, policy.priorityAdapterIds)) {
      const accepted = await this.acceptCapability(capability, policy, false)
      if (accepted.ok) return accepted
      rejectedAdapterIds.push(String(capability.adapterId))
    }
    return { ok: false, reasonCode: rejectedAdapterIds.length ? 'NO_APPROVED_RUNTIME' : 'NO_APPROVED_RUNTIME', rejectedAdapterIds }
  }

  async createOrResume(request: RuntimeCreateOrResumeRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1> {
    if (this.closed) return failed('', 'RUNTIME_REGISTRY_CLOSED', 'runtime-registry-closed')
    const adapter = this.adaptersById.get(String(request.selection.adapterId)) ?? await this.findAdapterByHealth(request.selection.adapterId)
    if (!adapter) return failed('', 'RUNTIME_ADAPTER_NOT_REGISTERED', 'runtime-adapter-not-registered')
    const outcome = await adapter.createOrResume(request)
    if ('runtimeSessionId' in outcome && isRuntimePublicSessionId(outcome.runtimeSessionId)) {
      this.sessionAdapters.set(outcome.runtimeSessionId, adapter)
    }
    return outcome
  }

  async send(request: RuntimeSendRequestV1) {
    const adapter = this.sessionAdapters.get(request.runtimeSessionId)
    if (!adapter) return { accepted: false as const, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    return adapter.send(request)
  }

  async *stream(runtimeSessionId: string, afterSequence: number): AsyncIterable<RuntimeEventV1> {
    const adapter = this.sessionAdapters.get(runtimeSessionId)
    if (!adapter) {
      yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: afterSequence + 1, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
      return
    }
    yield* adapter.stream(runtimeSessionId, afterSequence)
  }

  async permission(decision: RuntimePermissionDecisionV1) {
    const adapter = this.sessionAdapters.get(decision.runtimeSessionId)
    if (!adapter) return { accepted: false, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    return adapter.permission(decision)
  }

  async interrupt(request: RuntimeInterruptRequestV1) {
    const adapter = this.sessionAdapters.get(request.runtimeSessionId)
    if (!adapter) return { requested: false as const, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    return adapter.interrupt(request)
  }

  async inspect(runtimeSessionId: string): Promise<RuntimeOutcomeV1> {
    const adapter = this.sessionAdapters.get(runtimeSessionId)
    if (!adapter) return unknown(runtimeSessionId, 'RUNTIME_SESSION_NOT_FOUND', 'runtime-session-not-found')
    return adapter.inspect(runtimeSessionId)
  }

  async reconcile(runtimeSessionId: string, expectedReceiptDigest?: string): Promise<RuntimeOutcomeV1> {
    const adapter = this.sessionAdapters.get(runtimeSessionId)
    if (!adapter) return unknown(runtimeSessionId, 'RUNTIME_SESSION_NOT_FOUND', 'runtime-session-not-found')
    return adapter.reconcile(runtimeSessionId, expectedReceiptDigest)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.adaptersById.clear()
    this.sessionAdapters.clear()
    const adapters = new Set([
      ...this.registrations.splice(0).map((registration) => registration.adapter),
      ...this.retiredAdapters,
    ])
    this.retiredAdapters.clear()
    await Promise.all([...adapters].map(closeAdapterQuietly))
  }

  private async findAdapterByHealth(adapterId: AdapterIdV1 | string): Promise<AgentRuntimeAdapterV1 | undefined> {
    for (const registration of this.registrations) {
      try {
        const capability = await registration.adapter.health(adapterId)
        if (capability.adapterId === adapterId && validateRuntimePublicDto(capability).ok) {
          registration.adapterIds.add(String(adapterId))
          this.adaptersById.set(String(adapterId), registration.adapter)
          return registration.adapter
        }
      } catch {
        // Keep looking; the caller receives an explicit unavailable result if no adapter matches.
      }
    }
    return undefined
  }

  private async acceptCapability(
    capability: RuntimeCapabilityV1,
    policy: RuntimeRoutingPolicyV1,
    preferred: boolean,
  ): Promise<RuntimeRouteResultV1> {
    const reason = staticRejection(capability, policy)
    if (reason) return { ok: false, reasonCode: preferred ? 'RUNTIME_PREFERRED_NOT_AVAILABLE' : reason }
    const health = await this.health(capability.adapterId)
    const healthReason = staticRejection(health, policy)
    if (healthReason) return { ok: false, reasonCode: preferred ? 'RUNTIME_PREFERRED_NOT_AVAILABLE' : healthReason }
    return {
      ok: true,
      value: {
        adapterId: capability.adapterId,
        capability: health,
        selection: toRuntimeSelection(health),
        reasons: routeReasons(health, policy),
      },
    }
  }
}

function staticRejection(capability: RuntimeCapabilityV1, policy: RuntimeRoutingPolicyV1): RuntimeRouteFailureReasonV1 | null {
  if (capability.approvalStatus !== 'APPROVED_FOR_PRODUCTION' || capability.diagnosticOnly || capability.protocol === 'NON_INTERACTIVE_CLI_DIAGNOSTIC') {
    return 'NO_APPROVED_RUNTIME'
  }
  if (capability.health !== 'AVAILABLE' || !capability.canCreateSession || capability.stream === 'NONE' || capability.interrupt === 'NONE' || capability.inspect === 'NONE') {
    return 'RUNTIME_HEALTH_UNAVAILABLE'
  }
  const v2 = asCapabilityV2(capability)
  if (!v2) return policy.requiredCapabilities.length ? 'RUNTIME_CAPABILITY_UNSUPPORTED' : null
  if (!v2.workModes.includes(policy.mode)) return 'RUNTIME_CAPABILITY_UNSUPPORTED'
  if (!policy.requiredCapabilities.every((required) => v2.taskCapabilities.includes(required))) return 'RUNTIME_CAPABILITY_UNSUPPORTED'
  if (!supportsRequiredOperations(v2, requiredOperations(policy))) return 'RUNTIME_CAPABILITY_UNSUPPORTED'
  if (policy.dataEgressPolicy === 'LOCAL_ONLY' && v2.requiresDataEgress) return 'RUNTIME_DATA_EGRESS_FORBIDDEN'
  if (policy.dataEgressPolicy === 'LOCAL_ONLY' && v2.executionLocation !== 'LOCAL') return 'RUNTIME_DATA_EGRESS_FORBIDDEN'
  return null
}

function orderCapabilities(
  capabilities: readonly RuntimeCapabilityV1[],
  priorityAdapterIds: readonly (AdapterIdV1 | string)[],
): RuntimeCapabilityV1[] {
  const priority = new Map(priorityAdapterIds.map((adapterId, index) => [String(adapterId), index]))
  return [...capabilities].sort((left, right) => {
    const leftPriority = priority.get(String(left.adapterId)) ?? Number.MAX_SAFE_INTEGER
    const rightPriority = priority.get(String(right.adapterId)) ?? Number.MAX_SAFE_INTEGER
    if (leftPriority !== rightPriority) return leftPriority - rightPriority
    return String(left.adapterId).localeCompare(String(right.adapterId))
  })
}

function routeReasons(capability: RuntimeCapabilityV1, policy: RuntimeRoutingPolicyV1): string[] {
  return [
    `mode:${policy.mode}`,
    `adapter:${capability.adapterId}`,
    `approval:${capability.approvalStatus}`,
    `health:${capability.health}`,
    `data:${policy.dataEgressPolicy}`,
    `operations:${requiredOperations(policy).join(',')}`,
  ]
}

const DEFAULT_PRODUCTION_OPERATIONS: readonly RuntimeRequiredOperationV1[] = [
  'RESUME',
  'EVENT_STREAM',
  'INTERRUPT',
  'RESULT_RECONCILE',
]

function requiredOperations(policy: RuntimeRoutingPolicyV1): readonly RuntimeRequiredOperationV1[] {
  return [...new Set([...DEFAULT_PRODUCTION_OPERATIONS, ...(policy.requiredOperations ?? [])])]
}

function supportsRequiredOperations(
  capability: RuntimeCapabilityV2,
  required: readonly RuntimeRequiredOperationV1[],
): boolean {
  return required.every((operation) => {
    if (operation === 'RESUME') return capability.supportsResume && capability.canResumeSession
    if (operation === 'EVENT_STREAM') return capability.supportsEventStream && capability.stream !== 'NONE'
    if (operation === 'INTERRUPT') return capability.supportsInterrupt && capability.interrupt !== 'NONE'
    return capability.supportsResultReconcile && capability.inspect === 'RECONCILE'
  })
}

function hasRuntimeSessionRestorer(adapter: AgentRuntimeAdapterV1): adapter is AgentRuntimeAdapterV1 & RestorableRuntimeAdapterV1 {
  return typeof (adapter as Partial<RestorableRuntimeAdapterV1>).restoreRuntimeSession === 'function'
}

function asCapabilityV2(capability: RuntimeCapabilityV1): RuntimeCapabilityV2 | null {
  return (capability as { version?: unknown }).version === 2 ? capability as RuntimeCapabilityV2 : null
}

function toRuntimeSelection(value: RuntimeCapabilityV1): RuntimeAdapterSelectionV1 {
  if (value.stream === 'NONE' || value.interrupt === 'NONE' || value.inspect === 'NONE') {
    throw new Error('invalid runtime selection')
  }
  return {
    adapterId: value.adapterId,
    runtimeKind: value.runtimeKind,
    protocol: value.protocol,
    capabilityDigest: value.capabilityDigest,
    approvalStatus: 'APPROVED_FOR_PRODUCTION',
    diagnosticOnly: false,
    stream: value.stream,
    interrupt: value.interrupt,
    inspect: value.inspect,
  }
}

function unavailableCapability(reasonCode: string, adapterId: AdapterIdV1 | string = 'runtime-registry'): RuntimeCapabilityV1 {
  return {
    adapterId,
    runtimeKind: 'OTHER',
    protocol: 'NON_INTERACTIVE_CLI_DIAGNOSTIC',
    capabilityDigest: `sha256:${reasonCode.toLowerCase().replace(/_/g, '-')}`,
    approvalStatus: 'DISCOVERED',
    health: 'UNAVAILABLE',
    canCreateSession: false,
    canResumeSession: false,
    stream: 'NONE',
    interrupt: 'NONE',
    inspect: 'NONE',
    interactivePermission: 'NONE',
    diagnosticOnly: true,
    reasonCode,
  }
}

function failed(runtimeSessionId: string, reasonCode: string, receipt: string): RuntimeOutcomeV1 {
  return { state: 'FAILED', runtimeSessionId: runtimeSessionId || 'runtime-unbound', receiptDigest: `sha256:${receipt}`, reasonCode }
}

function unknown(runtimeSessionId: string, reasonCode: string, handle: string): RuntimeOutcomeV1 {
  return { state: 'OUTCOME_UNKNOWN', runtimeSessionId: runtimeSessionId || 'runtime-unbound', inspectHandleDigest: `sha256:${handle}`, reasonCode }
}

async function closeAdapterQuietly(adapter: AgentRuntimeAdapterV1): Promise<void> {
  const close = (adapter as { close?: () => void | Promise<void> }).close
  if (typeof close !== 'function') return
  try {
    await close.call(adapter)
  } catch {
    // Closing is best-effort; execution failures are reported at call sites.
  }
}
