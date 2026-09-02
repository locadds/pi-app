import type {
  AgentRuntimeAdapterV1,
  AdapterIdV1,
  RuntimeCapabilityV1,
  RuntimeCreateOrResumeOutcomeV1,
  RuntimeCreateOrResumeRequestV1,
  RuntimeEventV1,
  RuntimeInterruptRequestV1,
  RuntimeOutcomeV1,
  RuntimePermissionDecisionV1,
  RuntimeSendRequestV1,
} from '@shared/xiaogui-agent-runtime'

export interface ScriptedAgentRuntimeAdapterOptionsV1 {
  capabilities: readonly RuntimeCapabilityV1[]
  createRuntimeSessionId?: string
  createOutcome?: RuntimeCreateOrResumeOutcomeV1
  createOutcomesByRequestId?: Record<string, RuntimeCreateOrResumeOutcomeV1>
  eventsBySession?: Record<string, readonly RuntimeEventV1[]>
  outcomesBySession?: Record<string, RuntimeOutcomeV1>
  sendResult?: { accepted: true; requestId: string } | { accepted: false; reasonCode: string }
  interruptResult?: { requested: true } | { requested: false; reasonCode: string }
}

export class ScriptedAgentRuntimeAdapterV1 implements AgentRuntimeAdapterV1 {
  private readonly capabilities: readonly RuntimeCapabilityV1[]
  private readonly createRuntimeSessionId: string
  private readonly createOutcome?: RuntimeCreateOrResumeOutcomeV1
  private readonly createOutcomesByRequestId: Record<string, RuntimeCreateOrResumeOutcomeV1>
  private readonly eventsBySession: Record<string, readonly RuntimeEventV1[]>
  private readonly outcomesBySession: Record<string, RuntimeOutcomeV1>
  private readonly sendResult?: { accepted: true; requestId: string } | { accepted: false; reasonCode: string }
  private readonly interruptResult?: { requested: true } | { requested: false; reasonCode: string }

  constructor(options: ScriptedAgentRuntimeAdapterOptionsV1) {
    this.capabilities = options.capabilities
    this.createRuntimeSessionId = options.createRuntimeSessionId ?? 'scripted-runtime-session'
    this.createOutcome = options.createOutcome
    this.createOutcomesByRequestId = options.createOutcomesByRequestId ?? {}
    this.eventsBySession = options.eventsBySession ?? {}
    this.outcomesBySession = options.outcomesBySession ?? {}
    this.sendResult = options.sendResult
    this.interruptResult = options.interruptResult
  }

  async discover(): Promise<readonly RuntimeCapabilityV1[]> {
    return this.capabilities
  }

  async health(adapterId: AdapterIdV1 | string): Promise<RuntimeCapabilityV1> {
    return (
      this.capabilities.find((capability) => capability.adapterId === adapterId) ?? {
        adapterId,
        runtimeKind: 'OTHER',
        protocol: 'NON_INTERACTIVE_CLI_DIAGNOSTIC',
        capabilityDigest: 'sha256:unavailable',
        approvalStatus: 'DISCOVERED',
        health: 'UNAVAILABLE',
        canCreateSession: false,
        canResumeSession: false,
        stream: 'NONE',
        interrupt: 'NONE',
        inspect: 'NONE',
        interactivePermission: 'NONE',
        diagnosticOnly: true,
        reasonCode: 'RUNTIME_UNAVAILABLE',
      }
    )
  }

  async createOrResume(request: RuntimeCreateOrResumeRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1> {
    return this.createOutcomesByRequestId[request.requestId] ?? this.createOutcome ?? { state: 'READY', runtimeSessionId: this.createRuntimeSessionId }
  }

  async send(request: RuntimeSendRequestV1): Promise<{ accepted: true; requestId: string } | { accepted: false; reasonCode: string }> {
    return this.sendResult ?? { accepted: true, requestId: request.requestId }
  }

  async *stream(runtimeSessionId: string, _afterSequence: number): AsyncIterable<RuntimeEventV1> {
    for (const event of this.eventsBySession[runtimeSessionId] ?? []) yield event
  }

  async permission(_decision: RuntimePermissionDecisionV1): Promise<{ accepted: boolean; reasonCode?: string }> {
    return { accepted: true }
  }

  async interrupt(_request: RuntimeInterruptRequestV1): Promise<{ requested: true } | { requested: false; reasonCode: string }> {
    return this.interruptResult ?? { requested: true }
  }

  async inspect(runtimeSessionId: string): Promise<RuntimeOutcomeV1> {
    return this.outcomesBySession[runtimeSessionId] ?? {
      state: 'OUTCOME_UNKNOWN',
      runtimeSessionId,
      inspectHandleDigest: 'sha256:inspect-unavailable',
      reasonCode: 'INSPECT_UNAVAILABLE',
    }
  }

  async reconcile(runtimeSessionId: string, _expectedReceiptDigest?: string): Promise<RuntimeOutcomeV1> {
    return this.outcomesBySession[runtimeSessionId] ?? {
      state: 'OUTCOME_UNKNOWN',
      runtimeSessionId,
      inspectHandleDigest: 'sha256:reconcile-unavailable',
      reasonCode: 'RECONCILE_UNAVAILABLE',
    }
  }
}
