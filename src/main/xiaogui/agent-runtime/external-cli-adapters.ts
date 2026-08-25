import type {
  AdapterIdV1,
  AgentRuntimeAdapterV1,
  RuntimeCapabilityV1,
  RuntimeCapabilityV2,
  RuntimeCreateOrResumeOutcomeV1,
  RuntimeCreateOrResumeRequestV1,
  RuntimeEventV1,
  RuntimeInterruptRequestV1,
  RuntimeOutcomeV1,
  RuntimePermissionDecisionV1,
  RuntimeProtocolV1,
  RuntimeSendRequestV1,
} from '@shared/xiaogui-agent-runtime'

export interface ExternalAgentProtocolProbeV1 {
  stableAcp: boolean
  stableSdk: boolean
  headlessRecoverable: boolean
  headlessInterruptible: boolean
  headlessInspectable: boolean
}

export function selectExternalAgentProtocolV1(probe: ExternalAgentProtocolProbeV1): {
  protocol: RuntimeProtocolV1
  productionEligible: boolean
  reasonCode?: string
} {
  if (probe.stableAcp) return { protocol: 'ACP', productionEligible: true }
  if (probe.stableSdk) return { protocol: 'SDK', productionEligible: true }
  if (probe.headlessRecoverable && probe.headlessInterruptible && probe.headlessInspectable) {
    return { protocol: 'HEADLESS', productionEligible: true }
  }
  return {
    protocol: 'NON_INTERACTIVE_CLI_DIAGNOSTIC',
    productionEligible: false,
    reasonCode: 'RUNTIME_PROTOCOL_NOT_PRODUCTION_READY',
  }
}

/** Qoder 目前只登记可诊断能力，不进入生产路由。 */
export function createQoderDiagnosticAdapterV1(options: {
  probe: ExternalAgentProtocolProbeV1
  runtimeVersion?: string
}): AgentRuntimeAdapterV1 {
  return new DiagnosticExternalAgentAdapterV1('qoder-adapter', 'QODER', options.probe, options.runtimeVersion)
}

class DiagnosticExternalAgentAdapterV1 implements AgentRuntimeAdapterV1 {
  constructor(
    private readonly adapterId: AdapterIdV1 | string,
    private readonly runtimeKind: 'QODER' | 'CODEX',
    private readonly probe: ExternalAgentProtocolProbeV1,
    private readonly runtimeVersion = 'unknown',
  ) {}

  async discover(): Promise<readonly RuntimeCapabilityV1[]> { return [this.capability()] }

  async health(adapterId: AdapterIdV1 | string): Promise<RuntimeCapabilityV1> {
    return String(adapterId) === String(this.adapterId)
      ? this.capability()
      : unavailable(adapterId, 'RUNTIME_ADAPTER_NOT_FOUND')
  }

  async createOrResume(_request: RuntimeCreateOrResumeRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1> {
    return failed('runtime-unbound', 'RUNTIME_ADAPTER_DIAGNOSTIC_ONLY')
  }

  async send(_request: RuntimeSendRequestV1) {
    return { accepted: false as const, reasonCode: 'RUNTIME_ADAPTER_DIAGNOSTIC_ONLY' }
  }

  async *stream(runtimeSessionId: string, afterSequence: number): AsyncIterable<RuntimeEventV1> {
    yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: afterSequence + 1, reasonCode: 'RUNTIME_ADAPTER_DIAGNOSTIC_ONLY' }
  }

  async permission(_decision: RuntimePermissionDecisionV1) {
    return { accepted: false, reasonCode: 'RUNTIME_ADAPTER_DIAGNOSTIC_ONLY' }
  }

  async interrupt(_request: RuntimeInterruptRequestV1) {
    return { requested: false as const, reasonCode: 'RUNTIME_ADAPTER_DIAGNOSTIC_ONLY' }
  }

  async inspect(runtimeSessionId: string): Promise<RuntimeOutcomeV1> {
    return unknown(runtimeSessionId, 'RUNTIME_ADAPTER_DIAGNOSTIC_ONLY')
  }

  async reconcile(runtimeSessionId: string): Promise<RuntimeOutcomeV1> {
    return unknown(runtimeSessionId, 'RUNTIME_ADAPTER_DIAGNOSTIC_ONLY')
  }

  private capability(): RuntimeCapabilityV2 {
    const selected = selectExternalAgentProtocolV1(this.probe)
    return {
      adapterId: this.adapterId,
      runtimeKind: this.runtimeKind,
      protocol: 'NON_INTERACTIVE_CLI_DIAGNOSTIC',
      capabilityDigest: `sha256:${this.runtimeKind.toLowerCase()}-diagnostic-${this.runtimeVersion}`,
      approvalStatus: 'DISCOVERED',
      health: 'UNAVAILABLE',
      canCreateSession: false,
      canResumeSession: false,
      stream: 'NONE',
      interrupt: 'NONE',
      inspect: 'NONE',
      interactivePermission: 'NONE',
      diagnosticOnly: true,
      reasonCode: selected.reasonCode ?? 'RUNTIME_ADAPTER_IMPLEMENTATION_MISSING',
      version: 2,
      runtimeVersion: this.runtimeVersion,
      capabilitySummary: `${this.runtimeKind} 尚未通过小规生产接入门`,
      workModes: ['CODING'],
      taskCapabilities: ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT'],
      executionLocation: 'EXTERNAL',
      requiresDataEgress: true,
      supportsResume: false,
      supportsEventStream: false,
      supportsInterrupt: false,
      supportsResultReconcile: false,
    }
  }
}

function unavailable(adapterId: AdapterIdV1 | string, reasonCode: string): RuntimeCapabilityV1 {
  return {
    adapterId,
    runtimeKind: 'OTHER',
    protocol: 'NON_INTERACTIVE_CLI_DIAGNOSTIC',
    capabilityDigest: `sha256:${reasonCode.toLowerCase()}`,
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

function failed(runtimeSessionId: string, reasonCode: string): RuntimeOutcomeV1 {
  return { state: 'FAILED', runtimeSessionId, receiptDigest: `sha256:${reasonCode.toLowerCase()}`, reasonCode }
}

function unknown(runtimeSessionId: string, reasonCode: string): RuntimeOutcomeV1 {
  return { state: 'OUTCOME_UNKNOWN', runtimeSessionId, inspectHandleDigest: `sha256:${reasonCode.toLowerCase()}`, reasonCode }
}
