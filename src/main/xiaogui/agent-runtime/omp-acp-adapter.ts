import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import {
  isSafeRuntimeModelSelectorV1,
  isRuntimeContractTestSelectionAllowed,
  isRuntimeSelectionAllowed,
  runtimeSelectionKey,
  validateRuntimeContractTestCreateRequestShapeV1,
  validateRuntimeProductionCreateRequestShapeV1,
} from '@shared/xiaogui-agent-runtime'
import type {
  AdapterIdV1,
  AgentRuntimeAdapterV1,
  AgentRuntimeContractTestAdapterV1,
  RuntimeAdapterSelectionV1,
  RuntimeCapabilityV1,
  RuntimeCapabilityV2,
  RuntimeContractTestCreateOrResumeRequestV1,
  RuntimeCreateOrResumeOutcomeV1,
  RuntimeCreateOrResumeRequestV1,
  RuntimeEventV1,
  RuntimeInterruptRequestV1,
  RuntimeOutcomeV1,
  RuntimePermissionDecisionV1,
  RuntimeRouteFailureReasonV1,
  RuntimeSendRequestV1,
  RuntimeTestAdapterSelectionV1,
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'

import { AcpProcessTransportFactoryV1 } from './acp/process-transport'
import { digestSafeText, isSafeAcpOpaqueId, localRuntimeSurrogate } from './acp/redaction'
import type {
  AcpElicitationCreateParamsV1,
  AcpElicitationCreateResultV1,
  AcpRequestPermissionParamsV1,
  AcpRequestPermissionResultV1,
  AcpSessionUpdateParamsV1,
  AcpTransportFactoryV1,
  AcpTransportV1,
} from './acp/types'
import {
  digestBytes,
  prepareKimiAcpWorkspacePolicy,
  type KimiAcpAllowedFileV1,
  type PreparedKimiAcpWorkspacePolicyV1,
} from './acp/workspace-policy'

export const OMP_ACP_ADAPTER_ID_V1 = 'oh-my-pi-acp' as AdapterIdV1
export const OMP_ACP_APPROVED_VERSION_V1 = '18.1.2'
export const OMP_ACP_SOURCE_REVISION_V1 = '86bf72f52947f62ecaf9bd28e35572812e725a92'
export const OMP_ACP_APPROVED_PACKAGE_V1 = `@oh-my-pi/pi-coding-agent@${OMP_ACP_APPROVED_VERSION_V1}`
export const OMP_ACP_APPROVAL_ENVELOPE_V1 = 'omp-18.1.2-v1'

const CLIENT_INFO = { name: 'xiaogui-oh-my-pi-acp-adapter', version: '0.1.0' }
export const OMP_ACP_SAFE_ARGS_V1 = Object.freeze([
  '--approval-mode',
  'always-ask',
  '--no-extensions',
  '--no-skills',
  '--no-rules',
  'acp',
])

export interface OmpAcpLaunchV1 {
  command: string
  args: readonly string[]
  version?: string
}

export interface OmpAcpProbeV1 {
  findExecutable(): Promise<
    | ({ available: true } & OmpAcpLaunchV1)
    | { available: false; reasonCode: string }
  >
}

export interface OmpAcpWorkspaceResolutionV1 {
  rootPath: string
  allowedFiles: readonly KimiAcpAllowedFileV1[]
  resumeSessionId?: string
}

export interface OmpAcpWorkspaceResolverV1 {
  resolve(
    request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1,
  ): Promise<OmpAcpWorkspaceResolutionV1>
}

export interface OmpAcpTrustedLaunchV1 extends OmpAcpLaunchV1 {
  readonly version: typeof OMP_ACP_APPROVED_VERSION_V1
  readonly installationReceiptDigest: string
}

export interface OmpAcpTrustedLaunchPortV1 {
  inspectLaunch(): Promise<
    | ({ readonly available: true } & OmpAcpTrustedLaunchV1)
    | { readonly available: false; readonly reasonCode: string }
  >
}

export interface OmpAcpCandidateInspectorV1 {
  inspect(input: {
    readonly attemptId: string
    readonly allowNoApprovedChanges: boolean
  }): Promise<{ readonly candidateDigest: string }>
}

export interface OmpAcpRecoveryBindingV1 {
  readonly publicRuntimeSessionId: string
  readonly vendorSessionId: string
  readonly request: RuntimeCreateOrResumeRequestV1
  readonly installationReceiptDigest: string
  readonly outcome: Exclude<RuntimeOutcomeV1, { state: 'OUTCOME_UNKNOWN' }> | null
}

export interface OmpAcpRecoveryStoreV1 {
  /** True only when bindings and settled outcomes survive a process restart. */
  readonly durable: boolean
  bind(binding: Omit<OmpAcpRecoveryBindingV1, 'outcome'>): Promise<void>
  settle(
    publicRuntimeSessionId: string,
    outcome: Exclude<RuntimeOutcomeV1, { state: 'OUTCOME_UNKNOWN' }>,
  ): Promise<void>
  read(publicRuntimeSessionId: string): Promise<OmpAcpRecoveryBindingV1 | null>
  readByRequestId(requestId: string): Promise<OmpAcpRecoveryBindingV1 | null>
  close(): void | Promise<void>
}

export type OmpAcpProductionGateV1 =
  | { readonly enabled: false }
  | {
      readonly enabled: true
      readonly selection: RuntimeAdapterSelectionV1
      readonly trustedLaunch: OmpAcpTrustedLaunchPortV1
      readonly recoveryStore: OmpAcpRecoveryStoreV1
      readonly candidateInspector: OmpAcpCandidateInspectorV1
    }

interface OmpProductionSessionContextV1 {
  readonly installationReceiptDigest: string
  readonly recoveryStore: OmpAcpRecoveryStoreV1
  readonly candidateInspector: OmpAcpCandidateInspectorV1
}

export interface OmpAcpRuntimeAdapterOptionsV1 {
  payloadResolver: TrustedRuntimePayloadResolverV1
  workspaceResolver: OmpAcpWorkspaceResolverV1
  /** Isolated OMP state root; prevents loading user-global OMP credentials/config implicitly. */
  runtimeStateDir: string
  probe?: OmpAcpProbeV1
  transportFactory?: AcpTransportFactoryV1
  productionGate?: OmpAcpProductionGateV1
}

interface PendingPermissionV1 {
  challengeDigest: string
  allowOnceOptionId: string
  rejectOptionId?: string
  consumed: boolean
  resolve: (result: AcpRequestPermissionResultV1) => void
}

interface PermissionDecisionRecordV1 {
  digest: string
  result: { accepted: boolean; reasonCode?: string }
}

interface RuntimeSessionStateV1 {
  publicRuntimeSessionId: string
  vendorSessionId: string
  request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1
  transport: AcpTransportV1
  workspaceRoot: string
  workspacePolicy: PreparedKimiAcpWorkspacePolicyV1
  events: RuntimeEventV1[]
  sequence: number
  outcome: RuntimeOutcomeV1 | null
  evidenceDigests: string[]
  pendingPermissions: Map<string, PendingPermissionV1>
  disconnected: boolean
  cancellationRequested: boolean
  promptInFlight: boolean
  settlementInFlight: boolean
  promptQueue: string[]
  production?: OmpProductionSessionContextV1
  release: () => Promise<void>
}

interface IdempotencyRecordV1 {
  requestDigest: string
  outcome: RuntimeCreateOrResumeOutcomeV1
}

type RuntimeEventDraftV1 = RuntimeEventV1 extends infer Event
  ? Event extends { sequence: number }
    ? Omit<Event, 'sequence'>
    : never
  : never

export function createOmpAcpRuntimeAdapterV1(options: OmpAcpRuntimeAdapterOptionsV1): OmpAcpRuntimeAdapterV1 {
  return new OmpAcpRuntimeAdapterV1(options)
}

/**
 * ACP adapter for the pinned Oh My Pi runtime. Production remains behind an
 * explicit composition gate and the trusted-install/result-reconciliation seams.
 */
export class OmpAcpRuntimeAdapterV1 implements AgentRuntimeAdapterV1, AgentRuntimeContractTestAdapterV1 {
  private readonly probe: OmpAcpProbeV1
  private readonly transportFactory: AcpTransportFactoryV1
  private readonly sessions = new Map<string, RuntimeSessionStateV1>()
  private readonly transports = new Set<AcpTransportV1>()
  private readonly idempotency = new Map<string, IdempotencyRecordV1>()
  private readonly permissionDecisions = new Map<string, PermissionDecisionRecordV1>()
  private readonly consumedProofs = new Set<string>()
  private closed = false

  constructor(private readonly options: OmpAcpRuntimeAdapterOptionsV1) {
    this.probe = options.probe ?? new OmpAcpCliProbeV1()
    this.transportFactory = options.transportFactory ?? new AcpProcessTransportFactoryV1()
  }

  async discover(): Promise<readonly RuntimeCapabilityV1[]> {
    return [await this.capability()]
  }

  async health(adapterId: AdapterIdV1 | string): Promise<RuntimeCapabilityV1> {
    if (String(adapterId) !== String(OMP_ACP_ADAPTER_ID_V1)) {
      return unavailableCapability('RUNTIME_ADAPTER_NOT_FOUND')
    }
    return this.capability()
  }

  async createOrResume(request: RuntimeCreateOrResumeRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1>
  async createOrResume(request: RuntimeContractTestCreateOrResumeRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1>
  async createOrResume(
    request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1,
  ): Promise<RuntimeCreateOrResumeOutcomeV1> {
    if (this.closed) return failed('runtime-unbound', 'OMP_ADAPTER_CLOSED')
    let launch: OmpAcpLaunchV1
    let production: OmpProductionSessionContextV1 | undefined
    let requestDigest: string
    if (isContractTestRequest(request)) {
      const shape = validateRuntimeContractTestCreateRequestShapeV1(request)
      if (!shape.ok) return failed('runtime-unbound', shape.reasonCode)
      const allowed = isRuntimeContractTestSelectionAllowed(request.selection, request.contractTestPolicy)
      if (!allowed.ok) return failed('runtime-unbound', allowed.reasonCode)

      requestDigest = digestJson(request)
      const existing = this.idempotency.get(request.requestId)
      if (existing) {
        return existing.requestDigest === requestDigest
          ? existing.outcome
          : failed('runtime-unbound', 'IDEMPOTENCY_CONFLICT')
      }

      const candidate = await this.probe.findExecutable()
      if (!candidate.available) return failed('runtime-unbound', candidate.reasonCode)
      if (candidate.version !== OMP_ACP_APPROVED_VERSION_V1) {
        return failed('runtime-unbound', 'OMP_VERSION_UNAPPROVED')
      }
      if (!isApprovedOmpLaunchArgs(candidate.args)) {
        return failed('runtime-unbound', 'OMP_LAUNCH_ARGUMENTS_UNAPPROVED')
      }
      if (!selectionMatchesTestCandidate(request.selection, ompAcpCapabilityDigestForVersionV1(candidate.version))) {
        return failed('runtime-unbound', 'RUNTIME_SELECTION_NOT_OMP_ACP_TEST')
      }
      launch = candidate
    } else {
      const shape = validateRuntimeProductionCreateRequestShapeV1(request)
      if (!shape.ok) return failed('runtime-unbound', shape.reasonCode)
      const gate = this.options.productionGate
      if (!gate?.enabled) return failed('runtime-unbound', 'OMP_PRODUCTION_DISABLED')
      const lifecycleBlock = this.productionLifecycleBlockReason()
      if (lifecycleBlock) return failed('runtime-unbound', lifecycleBlock)
      const allowed = isRuntimeSelectionAllowed(request.selection, request.productionPolicy)
      if (!allowed.ok) return failed('runtime-unbound', allowed.reasonCode)
      if (!selectionMatchesProductionCandidate(request.selection, gate.selection)) {
        return failed('runtime-unbound', 'OMP_PRODUCTION_SELECTION_MISMATCH')
      }

      requestDigest = digestJson(request)
      const existing = this.idempotency.get(request.requestId)
      if (existing) {
        return existing.requestDigest === requestDigest
          ? existing.outcome
          : failed('runtime-unbound', 'IDEMPOTENCY_CONFLICT')
      }
      let recovered: OmpAcpRecoveryBindingV1 | null
      try {
        recovered = await gate.recoveryStore.readByRequestId(request.requestId)
      } catch {
        return unknown('runtime-unbound', 'OMP_RECOVERY_LOOKUP_FAILED')
      }
      if (recovered) {
        if (digestJson(recovered.request) !== requestDigest) {
          return failed('runtime-unbound', 'IDEMPOTENCY_CONFLICT')
        }
        const persisted = await this.outcomeFromRecoveryBinding(recovered)
        if (persisted.state === 'OUTCOME_UNKNOWN') {
          return persisted
        }
        this.idempotency.set(request.requestId, { requestDigest, outcome: persisted })
        return persisted
      }
      const trusted = await gate.trustedLaunch.inspectLaunch()
      if (!trusted.available) return failed('runtime-unbound', trusted.reasonCode)
      if (!isApprovedProductionLaunch(trusted)) {
        return failed('runtime-unbound', 'OMP_TRUSTED_LAUNCH_INVALID')
      }
      launch = trusted
      production = {
        installationReceiptDigest: trusted.installationReceiptDigest,
        recoveryStore: gate.recoveryStore,
        candidateInspector: gate.candidateInspector,
      }
    }

    let workspace: OmpAcpWorkspaceResolutionV1
    let prompt: string
    try {
      workspace = await this.options.workspaceResolver.resolve(request)
      const envelope = await this.options.payloadResolver.resolvePrompt(request.promptEnvelopeRef)
      if (digestBytes(envelope.payloadBytes) !== request.promptEnvelopeRef.digest) {
        return failed('runtime-unbound', 'PROMPT_DIGEST_MISMATCH')
      }
      prompt = Buffer.from(envelope.payloadBytes).toString('utf8')
    } catch (error) {
      return failed('runtime-unbound', reasonCodeFromError(error, 'RUNTIME_WORKSPACE_BINDING_FAILED'))
    }

    let workspacePolicy: PreparedKimiAcpWorkspacePolicyV1
    let transport: AcpTransportV1
    try {
      workspacePolicy = prepareKimiAcpWorkspacePolicy(workspace.rootPath, workspace.allowedFiles)
      if (!isAbsolute(this.options.runtimeStateDir)) {
        return failed('runtime-unbound', 'OMP_RUNTIME_STATE_DIR_INVALID')
      }
      mkdirSync(this.options.runtimeStateDir, { recursive: true })
      transport = this.transportFactory.create(launch.command, launch.args, workspace.rootPath, {
        env: { PI_CODING_AGENT_DIR: this.options.runtimeStateDir },
      })
    } catch (error) {
      return failed('runtime-unbound', reasonCodeFromError(error, 'OMP_RUNTIME_PREPARATION_FAILED'))
    }
    this.transports.add(transport)
    const outcome = await this.startSession(request, workspace, workspacePolicy, prompt, transport, production)
    this.idempotency.set(request.requestId, { requestDigest, outcome })
    return outcome
  }

  private async startSession(
    request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1,
    workspace: OmpAcpWorkspaceResolutionV1,
    workspacePolicy: PreparedKimiAcpWorkspacePolicyV1,
    prompt: string,
    transport: AcpTransportV1,
    production?: OmpProductionSessionContextV1,
    recovery?: {
      readonly publicRuntimeSessionId: string
      readonly persistedOutcome: Exclude<RuntimeOutcomeV1, { state: 'OUTCOME_UNKNOWN' }> | null
    },
  ): Promise<RuntimeCreateOrResumeOutcomeV1> {
    let state: RuntimeSessionStateV1 | null = null
    const requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>()
    requestHandlers.set('fs/read_text_file', (params) => {
      const read = workspacePolicy.readTextFile(extractPath(params))
      return { content: read.content }
    })
    requestHandlers.set('elicitation/create', (params) => (
      state && !this.closed && !state.cancellationRequested
        ? this.handleElicitationRequest(state, params as AcpElicitationCreateParamsV1)
        : { action: 'cancel' }
    ))
    for (const method of [
      'fs/write_text_file',
      'terminal/create',
      'terminal/wait_for_exit',
      'terminal/output',
      'terminal/release',
      'terminal/kill',
    ]) {
      requestHandlers.set(method, () => {
        throw new Error('OMP_ACP_CLIENT_CAPABILITY_DENIED')
      })
    }

    try {
      const initialized = await transport.start({
        cwd: workspace.rootPath,
        initialize: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false,
            elicitation: { form: {} },
          },
          clientInfo: CLIENT_INFO,
        },
        requestHandlers,
        onSessionUpdate: (params) => {
          if (state && !this.closed) handleSessionUpdate(state, params)
        },
        onPermissionRequest: (params) => (
          state && !this.closed && !state.cancellationRequested
            ? this.handlePermissionRequest(state, params)
            : Promise.resolve({ outcome: { outcome: 'cancelled' } })
        ),
        onDisconnect: (reasonCode) => {
          if (state) markDisconnected(state, reasonCode)
        },
      })
      if (
        initialized.protocolVersion !== 1 ||
        initialized.agentInfo?.name !== 'oh-my-pi' ||
        initialized.agentInfo?.version !== OMP_ACP_APPROVED_VERSION_V1
      ) {
        await this.disposeTransport(transport)
        return failed('runtime-unbound', 'OMP_ACP_IDENTITY_MISMATCH')
      }
      const vendorSessionId = workspace.resumeSessionId
        ?? (await transport.newSession(workspace.rootPath)).sessionId
      if (!isSafeAcpOpaqueId(vendorSessionId)) {
        await this.disposeTransport(transport)
        return failed('runtime-unbound', 'ACP_SESSION_ID_UNSAFE')
      }
      if (workspace.resumeSessionId) {
        if (!initialized.agentCapabilities?.loadSession) {
          await this.disposeTransport(transport)
          return failed('runtime-unbound', 'OMP_ACP_RESUME_UNSUPPORTED')
        }
        await transport.loadSession(vendorSessionId, workspace.rootPath)
      }
      const modelBindingFailure = await bindFrozenModelSelector(transport, vendorSessionId, request)
      if (modelBindingFailure) {
        await this.disposeTransport(transport)
        return failed('runtime-unbound', modelBindingFailure)
      }

      const publicRuntimeSessionId = recovery?.publicRuntimeSessionId ?? localRuntimeSurrogate(
        vendorSessionId,
        digestJson({ scope: request.scope, workspace: request.workspace, adapterId: OMP_ACP_ADAPTER_ID_V1 }),
      )
      if (production && !recovery) {
        try {
          await production.recoveryStore.bind({
            publicRuntimeSessionId,
            vendorSessionId,
            request: request as RuntimeCreateOrResumeRequestV1,
            installationReceiptDigest: production.installationReceiptDigest,
          })
        } catch {
          await this.disposeTransport(transport)
          return failed('runtime-unbound', 'OMP_RECOVERY_BINDING_FAILED')
        }
      }
      state = {
        publicRuntimeSessionId,
        vendorSessionId,
        request,
        transport,
        workspaceRoot: workspace.rootPath,
        workspacePolicy,
        events: [],
        sequence: 0,
        outcome: null,
        evidenceDigests: [],
        pendingPermissions: new Map(),
        disconnected: false,
        cancellationRequested: false,
        promptInFlight: false,
        settlementInFlight: false,
        promptQueue: [],
        ...(production ? { production } : {}),
        release: () => this.disposeTransport(transport),
      }
      this.sessions.set(publicRuntimeSessionId, state)
      pushEvent(state, { type: 'SESSION_READY', runtimeSessionId: publicRuntimeSessionId })
      if (recovery) {
        if (recovery.persistedOutcome) markOutcome(state, recovery.persistedOutcome)
        else markUnknown(state, 'OMP_RESTORED_OUTCOME_UNSETTLED')
      } else {
        enqueuePrompt(state, prompt)
      }
      return { state: 'READY', runtimeSessionId: publicRuntimeSessionId }
    } catch (error) {
      await this.disposeTransport(transport)
      return failed('runtime-unbound', reasonCodeFromError(error, 'OMP_ACP_SESSION_START_FAILED'))
    }
  }

  async restoreRuntimeSession(runtimeSessionId: string): Promise<
    { ok: true } | { ok: false; reasonCode: RuntimeRouteFailureReasonV1 }
  > {
    if (this.closed) return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
    if (this.sessions.has(runtimeSessionId)) return { ok: true }
    const gate = this.options.productionGate
    if (!gate?.enabled || this.productionLifecycleBlockReason()) {
      return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
    }

    try {
      const binding = await gate.recoveryStore.read(runtimeSessionId)
      if (!binding || binding.publicRuntimeSessionId !== runtimeSessionId) {
        return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
      }
      const shape = validateRuntimeProductionCreateRequestShapeV1(binding.request)
      if (!shape.ok) {
        return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
      }
      if (!selectionMatchesProductionCandidate(binding.request.selection, gate.selection)) {
        return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
      }
      const trusted = await gate.trustedLaunch.inspectLaunch()
      if (
        !trusted.available ||
        !isApprovedProductionLaunch(trusted) ||
        trusted.installationReceiptDigest !== binding.installationReceiptDigest
      ) {
        return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
      }
      const workspace = await this.options.workspaceResolver.resolve(binding.request)
      const workspacePolicy = prepareKimiAcpWorkspacePolicy(workspace.rootPath, workspace.allowedFiles)
      if (!isAbsolute(this.options.runtimeStateDir)) {
        return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
      }
      mkdirSync(this.options.runtimeStateDir, { recursive: true })
      if (binding.outcome?.state === 'SUCCEEDED') {
        const inspected = await gate.candidateInspector.inspect({
          attemptId: binding.request.scope.attemptId,
          allowNoApprovedChanges: isReadOnlyRole(binding.request),
        })
        if (inspected.candidateDigest !== binding.outcome.candidateDigest) {
          return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
        }
      }
      const transport = this.transportFactory.create(trusted.command, trusted.args, workspace.rootPath, {
        env: { PI_CODING_AGENT_DIR: this.options.runtimeStateDir },
      })
      this.transports.add(transport)
      const restored = await this.startSession(
        binding.request,
        { ...workspace, resumeSessionId: binding.vendorSessionId },
        workspacePolicy,
        '',
        transport,
        {
          installationReceiptDigest: binding.installationReceiptDigest,
          recoveryStore: gate.recoveryStore,
          candidateInspector: gate.candidateInspector,
        },
        {
          publicRuntimeSessionId: runtimeSessionId,
          persistedOutcome: binding.outcome,
        },
      )
      return restored.state === 'READY'
        ? { ok: true }
        : { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
    } catch {
      return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
    }
  }

  async send(request: RuntimeSendRequestV1) {
    const state = this.sessions.get(request.runtimeSessionId)
    if (!state) return { accepted: false as const, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    if (!isActive(state)) return { accepted: false as const, reasonCode: inactiveReason(state) }
    try {
      if (request.messageEnvelopeRef.mediaType !== 'application/vnd.xiaogui.runtime-message+json') {
        return { accepted: false as const, reasonCode: 'MESSAGE_MEDIA_TYPE_UNSUPPORTED' }
      }
      const envelope = await this.options.payloadResolver.resolveMessage(request.messageEnvelopeRef)
      if (digestBytes(envelope.payloadBytes) !== request.messageEnvelopeRef.digest) {
        return { accepted: false as const, reasonCode: 'MESSAGE_DIGEST_MISMATCH' }
      }
      enqueuePrompt(state, Buffer.from(envelope.payloadBytes).toString('utf8'))
      return { accepted: true as const, requestId: request.requestId }
    } catch {
      return { accepted: false as const, reasonCode: 'MESSAGE_RESOLVE_FAILED' }
    }
  }

  async *stream(runtimeSessionId: string, afterSequence: number): AsyncIterable<RuntimeEventV1> {
    const state = this.sessions.get(runtimeSessionId)
    if (!state) {
      const persisted = await this.persistedOutcome(runtimeSessionId)
      if (persisted) {
        if (persisted.state === 'OUTCOME_UNKNOWN') {
          yield {
            type: 'OUTCOME_UNKNOWN',
            runtimeSessionId,
            sequence: afterSequence + 1,
            reasonCode: persisted.reasonCode,
          }
        } else {
          yield {
            type: 'RUNTIME_SETTLED',
            runtimeSessionId,
            sequence: afterSequence + 1,
            outcome: persisted.state,
          }
        }
        return
      }
      yield {
        type: 'OUTCOME_UNKNOWN',
        runtimeSessionId,
        sequence: afterSequence + 1,
        reasonCode: 'RUNTIME_SESSION_NOT_FOUND',
      }
      return
    }
    for (const event of state.events) {
      if (event.sequence > afterSequence) yield event
    }
  }

  async permission(decision: RuntimePermissionDecisionV1) {
    const state = this.sessions.get(decision.runtimeSessionId)
    if (!state) return { accepted: false, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    if (!isActive(state)) return { accepted: false, reasonCode: inactiveReason(state) }
    if (digestJson(decision.scope) !== digestJson(state.request.scope)) {
      return { accepted: false, reasonCode: 'PERMISSION_SCOPE_MISMATCH' }
    }

    const digest = digestJson(decision)
    const existing = this.permissionDecisions.get(decision.decisionRequestId)
    if (existing) {
      return existing.digest === digest
        ? existing.result
        : { accepted: false, reasonCode: 'PERMISSION_DECISION_CONFLICT' }
    }
    const pending = state.pendingPermissions.get(decision.permissionRequestId)
    if (!pending || pending.challengeDigest !== decision.challengeDigest || pending.consumed) {
      const result = { accepted: false, reasonCode: 'PERMISSION_SCOPE_MISMATCH' }
      this.permissionDecisions.set(decision.decisionRequestId, { digest, result })
      return result
    }

    let result: { accepted: boolean; reasonCode?: string }
    if (decision.type === 'ALLOW_ONCE') {
      const proofKey = digestJson({
        runtimeSessionId: decision.runtimeSessionId,
        proofId: decision.proofId,
        proofDigest: decision.proofDigest,
        scope: decision.scope,
      })
      if (this.consumedProofs.has(proofKey)) {
        result = { accepted: false, reasonCode: 'PERMISSION_PROOF_REPLAYED' }
      } else {
        this.consumedProofs.add(proofKey)
        pending.resolve({ outcome: { outcome: 'selected', optionId: pending.allowOnceOptionId } })
        pending.consumed = true
        state.pendingPermissions.delete(decision.permissionRequestId)
        result = { accepted: true }
      }
    } else {
      pending.resolve(
        pending.rejectOptionId
          ? { outcome: { outcome: 'selected', optionId: pending.rejectOptionId } }
          : { outcome: { outcome: 'cancelled' } },
      )
      pending.consumed = true
      state.pendingPermissions.delete(decision.permissionRequestId)
      result = { accepted: true }
    }
    this.permissionDecisions.set(decision.decisionRequestId, { digest, result })
    return result
  }

  async interrupt(request: RuntimeInterruptRequestV1) {
    const state = this.sessions.get(request.runtimeSessionId)
    if (!state) return { requested: false as const, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    if (!isActive(state)) return { requested: false as const, reasonCode: inactiveReason(state) }
    state.cancellationRequested = true
    state.promptQueue = []
    clearPendingPermissions(state)
    try {
      await state.transport.cancel(state.vendorSessionId)
      await commitOutcome(state, {
        state: 'INTERRUPTED',
        runtimeSessionId: state.publicRuntimeSessionId,
        receiptDigest: digestJson({ requestId: request.requestId, reason: request.reason }),
        reasonCode: 'RUNTIME_CANCELLED',
      })
      return { requested: true as const }
    } catch {
      markUnknown(state, 'PROCESS_DISCONNECTED')
      return { requested: false as const, reasonCode: 'PROCESS_DISCONNECTED' }
    }
  }

  async inspect(runtimeSessionId: string): Promise<RuntimeOutcomeV1> {
    const state = this.sessions.get(runtimeSessionId)
    if (!state) {
      return await this.persistedOutcome(runtimeSessionId)
        ?? unknown(runtimeSessionId, 'RUNTIME_SESSION_NOT_FOUND')
    }
    return state.outcome ?? unknown(runtimeSessionId, 'RUNTIME_STILL_RUNNING')
  }

  async reconcile(runtimeSessionId: string, expectedReceiptDigest?: string): Promise<RuntimeOutcomeV1> {
    const outcome = await this.inspect(runtimeSessionId)
    if (
      expectedReceiptDigest &&
      outcome.state !== 'OUTCOME_UNKNOWN' &&
      outcome.receiptDigest !== expectedReceiptDigest
    ) {
      return unknown(runtimeSessionId, 'RUNTIME_RECEIPT_MISMATCH')
    }
    return outcome
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const state of this.sessions.values()) clearPendingPermissions(state)
    await Promise.all([...this.transports].map((transport) => this.disposeTransport(transport)))
    if (this.options.productionGate?.enabled) {
      await this.options.productionGate.recoveryStore.close()
    }
  }

  private async capability(): Promise<RuntimeCapabilityV1> {
    const gate = this.options.productionGate
    if (gate?.enabled) {
      const lifecycleBlock = this.productionLifecycleBlockReason()
      if (lifecycleBlock) return unavailableCapability(lifecycleBlock)
      const trusted = await gate.trustedLaunch.inspectLaunch()
      if (!trusted.available) return unavailableCapability(trusted.reasonCode)
      if (!isApprovedProductionLaunch(trusted)) return unavailableCapability('OMP_TRUSTED_LAUNCH_INVALID')
      if (!selectionMatchesProductionCandidate(gate.selection, ompAcpProductionSelectionV1())) {
        return unavailableCapability('OMP_PRODUCTION_SELECTION_MISMATCH')
      }
      return availableProductionCapability(trusted.version)
    }
    const launch = await this.probe.findExecutable()
    if (!launch.available) return unavailableCapability(launch.reasonCode)
    if (launch.version !== OMP_ACP_APPROVED_VERSION_V1) {
      return unavailableCapability('OMP_VERSION_UNAPPROVED', launch.version)
    }
    if (!isApprovedOmpLaunchArgs(launch.args)) {
      return unavailableCapability('OMP_LAUNCH_ARGUMENTS_UNAPPROVED', launch.version)
    }
    return availableCapability(launch.version)
  }

  private productionLifecycleBlockReason(): string | undefined {
    const gate = this.options.productionGate
    if (!gate?.enabled) return 'OMP_PRODUCTION_DISABLED'
    if (
      gate.recoveryStore.durable !== true ||
      typeof gate.recoveryStore.bind !== 'function' ||
      typeof gate.recoveryStore.read !== 'function' ||
      typeof gate.recoveryStore.readByRequestId !== 'function' ||
      typeof gate.recoveryStore.settle !== 'function'
    ) return 'OMP_DURABLE_RECOVERY_UNAVAILABLE'
    if (typeof gate.candidateInspector.inspect !== 'function') {
      return 'OMP_RESULT_RECONCILE_UNAVAILABLE'
    }
    return undefined
  }

  private async persistedOutcome(runtimeSessionId: string): Promise<RuntimeOutcomeV1 | null> {
    const gate = this.options.productionGate
    if (!gate?.enabled || this.closed) return null
    try {
      const binding = await gate.recoveryStore.read(runtimeSessionId)
      if (!binding) return null
      return this.outcomeFromRecoveryBinding(binding)
    } catch {
      return unknown(runtimeSessionId, 'OMP_RECOVERY_LOOKUP_FAILED')
    }
  }

  private async outcomeFromRecoveryBinding(binding: OmpAcpRecoveryBindingV1): Promise<RuntimeOutcomeV1> {
    if (!binding.outcome) {
      return unknown(binding.publicRuntimeSessionId, 'OMP_RESTORED_OUTCOME_UNSETTLED')
    }
    if (binding.outcome.state !== 'SUCCEEDED') return binding.outcome
    try {
      const gate = this.options.productionGate
      if (!gate?.enabled) return unknown(binding.publicRuntimeSessionId, 'OMP_RESULT_RECONCILE_UNAVAILABLE')
      const inspected = await gate.candidateInspector.inspect({
        attemptId: binding.request.scope.attemptId,
        allowNoApprovedChanges: isReadOnlyRole(binding.request),
      })
      return inspected.candidateDigest === binding.outcome.candidateDigest
        ? binding.outcome
        : unknown(binding.publicRuntimeSessionId, 'OMP_CANDIDATE_RUNTIME_RESULT_MISMATCH')
    } catch {
      return unknown(binding.publicRuntimeSessionId, 'OMP_CANDIDATE_RECONCILE_FAILED')
    }
  }

  private handlePermissionRequest(
    state: RuntimeSessionStateV1,
    params: AcpRequestPermissionParamsV1,
  ): Promise<AcpRequestPermissionResultV1> {
    if (params.sessionId !== state.vendorSessionId) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }
    const options = Array.isArray(params.options) ? params.options : []
    const optionIds = options.map((option) => option.optionId)
    const allowOnce = options.filter((option) => option.kind === 'allow_once')
    const paths = requestedRelativePaths(state.workspaceRoot, params.toolCall?.locations)
    if (
      new Set(optionIds).size !== optionIds.length ||
      optionIds.some((id) => !id || id !== id.trim()) ||
      allowOnce.length !== 1 ||
      paths === null
    ) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }

    const reject = options.find((option) => option.kind === 'reject_once')
    const challengeDigest = digestJson({
      runtimeSessionId: state.publicRuntimeSessionId,
      toolCall: params.toolCall,
      options,
    })
    const permissionRequestId = `omp-perm-${challengeDigest.slice(7, 23)}`
    const purpose = permissionPurpose(params)
    pushEvent(state, {
      type: 'PERMISSION_REQUESTED',
      permissionRequestId,
      runtimeSessionId: state.publicRuntimeSessionId,
      scope: state.request.scope,
      challengeDigest,
      decisionRequired: 'ALLOW_ONCE_OR_DENY',
      permissionPurpose: purpose,
      requestedRelativePaths: paths.length ? paths : undefined,
      actionDigest: purpose === 'COMMAND' || purpose === 'DATA_EGRESS'
        ? digestJson(params.toolCall ?? params)
        : undefined,
      commandSummary: purpose === 'COMMAND' ? safeToolName(params.toolCall?.kind ?? params.toolCall?.title ?? 'command') : undefined,
      egressDestination: purpose === 'DATA_EGRESS' ? 'external-service' : undefined,
    })
    return new Promise((resolvePermission) => {
      state.pendingPermissions.set(permissionRequestId, {
        challengeDigest,
        allowOnceOptionId: allowOnce[0].optionId,
        rejectOptionId: reject?.optionId,
        consumed: false,
        resolve: resolvePermission,
      })
    })
  }

  private async handleElicitationRequest(
    state: RuntimeSessionStateV1,
    params: AcpElicitationCreateParamsV1,
  ): Promise<AcpElicitationCreateResultV1> {
    if (params.sessionId !== state.vendorSessionId || !isOmpApprovalElicitation(params)) {
      return { action: 'cancel' }
    }
    const toolCall = decodePinnedOmpApprovalMessageV1(params.message)
    if (!toolCall) return { action: 'cancel' }
    const decision = await this.handlePermissionRequest(state, {
      sessionId: state.vendorSessionId,
      toolCall,
      options: [
        { optionId: 'omp-elicitation-approve', kind: 'allow_once' },
        { optionId: 'omp-elicitation-deny', kind: 'reject_once' },
      ],
    })
    if (decision.outcome.outcome !== 'selected') return { action: 'cancel' }
    return {
      action: 'accept',
      content: {
        value: decision.outcome.optionId === 'omp-elicitation-approve' ? 'Approve' : 'Deny',
      },
    }
  }

  private async disposeTransport(transport: AcpTransportV1): Promise<void> {
    this.transports.delete(transport)
    try {
      await transport.dispose()
    } catch {
      // Process shutdown failures stay behind the runtime adapter boundary.
    }
  }
}

export class OmpAcpCliProbeV1 implements OmpAcpProbeV1 {
  async findExecutable(): Promise<
    | ({ available: true } & OmpAcpLaunchV1)
    | { available: false; reasonCode: string }
  > {
    const configured = process.env.OMP_CLI_PATH
    const installedCommand = configured && existsSync(configured)
      ? configured
      : await findOnPath('omp')
    if (installedCommand) {
      const version = await probeVersion(installedCommand, [])
      return { available: true, command: installedCommand, args: OMP_ACP_SAFE_ARGS_V1, version }
    }

    // The pinned bunx package is an explicit P0 test seam. It is opt-in so
    // ordinary runtime discovery never downloads a large package or performs
    // unapproved network access merely because the registry is inspected.
    if (process.env.XIAOGUI_OMP_ACP_BUNX_TEST_ENABLED !== '1') {
      return { available: false, reasonCode: 'OMP_EXECUTABLE_NOT_FOUND' }
    }
    const bunx = await findOnPath('bunx')
    if (!bunx) return { available: false, reasonCode: 'OMP_BUNX_NOT_FOUND' }
    const prefix = ['--bun', OMP_ACP_APPROVED_PACKAGE_V1] as const
    const version = await probeVersion(bunx, prefix)
    return {
      available: true,
      command: bunx,
      args: Object.freeze([...prefix, ...OMP_ACP_SAFE_ARGS_V1]),
      version,
    }
  }
}

export function ompAcpCapabilityDigestForVersionV1(version: string | undefined): string {
  return digestJson({
    adapterId: OMP_ACP_ADAPTER_ID_V1,
    protocol: 'ACP',
    sourceRevision: OMP_ACP_SOURCE_REVISION_V1,
    approvedVersion: OMP_ACP_APPROVED_VERSION_V1,
    version: version === OMP_ACP_APPROVED_VERSION_V1 ? version : 'unapproved',
    approvalMode: 'always-ask',
    skillDiscovery: 'disabled',
    ruleDiscovery: 'disabled',
    clientFsWrite: 'denied',
    clientTerminal: 'denied',
    permission: 'host-mediated-allow-once',
    approvalEnvelope: OMP_ACP_APPROVAL_ENVELOPE_V1,
    production: 'disabled',
  })
}

export function ompAcpProductionCapabilityDigestV1(): string {
  return digestJson({
    adapterId: OMP_ACP_ADAPTER_ID_V1,
    protocol: 'ACP',
    sourceRevision: OMP_ACP_SOURCE_REVISION_V1,
    approvedVersion: OMP_ACP_APPROVED_VERSION_V1,
    approvalMode: 'always-ask',
    skillDiscovery: 'disabled',
    ruleDiscovery: 'disabled',
    clientFsWrite: 'denied',
    clientTerminal: 'denied',
    permission: 'taskhub-host-mediated',
    approvalEnvelope: OMP_ACP_APPROVAL_ENVELOPE_V1,
    trustedInstallation: 'receipt-v1',
    candidateDigest: 'task-result-tree-v1',
    recovery: 'durable-v1',
    production: 'explicit-gate-v1',
  })
}

export function ompAcpProductionSelectionV1(): RuntimeAdapterSelectionV1 {
  return Object.freeze({
    adapterId: OMP_ACP_ADAPTER_ID_V1,
    runtimeKind: 'OTHER',
    protocol: 'ACP',
    capabilityDigest: ompAcpProductionCapabilityDigestV1(),
    approvalStatus: 'APPROVED_FOR_PRODUCTION',
    diagnosticOnly: false,
    stream: 'POLL',
    interrupt: 'BEST_EFFORT',
    inspect: 'RECONCILE',
  })
}

function availableCapability(version: string): RuntimeCapabilityV2 {
  return {
    adapterId: OMP_ACP_ADAPTER_ID_V1,
    runtimeKind: 'OTHER',
    protocol: 'ACP',
    capabilityDigest: ompAcpCapabilityDigestForVersionV1(version),
    approvalStatus: 'APPROVED_FOR_TEST',
    health: 'AVAILABLE',
    canCreateSession: true,
    canResumeSession: true,
    stream: 'POLL',
    interrupt: 'BEST_EFFORT',
    inspect: 'SNAPSHOT',
    interactivePermission: 'HOST_MEDIATED',
    diagnosticOnly: false,
    version: 2,
    runtimeVersion: version,
    capabilitySummary: '小规 CODING 任务的 Oh My Pi ACP 测试运行时',
    workModes: ['CODING'],
    taskCapabilities: ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT'],
    executionLocation: 'EXTERNAL',
    requiresDataEgress: true,
    supportsResume: true,
    supportsEventStream: true,
    supportsInterrupt: true,
    supportsResultReconcile: false,
    reasonCode: `OMP_${version}_TEST_ONLY`,
  }
}

function availableProductionCapability(version: string): RuntimeCapabilityV2 {
  return {
    adapterId: OMP_ACP_ADAPTER_ID_V1,
    runtimeKind: 'OTHER',
    protocol: 'ACP',
    capabilityDigest: ompAcpProductionCapabilityDigestV1(),
    approvalStatus: 'APPROVED_FOR_PRODUCTION',
    health: 'AVAILABLE',
    canCreateSession: true,
    canResumeSession: true,
    stream: 'POLL',
    interrupt: 'BEST_EFFORT',
    inspect: 'RECONCILE',
    interactivePermission: 'HOST_MEDIATED',
    diagnosticOnly: false,
    version: 2,
    runtimeVersion: version,
    capabilitySummary: '小规 CODING 任务的 Oh My Pi ACP 受控运行时',
    workModes: ['CODING'],
    taskCapabilities: ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT', 'EXECUTION.EXTERNAL_ALLOWED'],
    executionLocation: 'EXTERNAL',
    requiresDataEgress: true,
    supportsResume: true,
    supportsEventStream: true,
    supportsInterrupt: true,
    supportsResultReconcile: true,
  }
}

function unavailableCapability(reasonCode: string, version?: string): RuntimeCapabilityV1 {
  return {
    adapterId: OMP_ACP_ADAPTER_ID_V1,
    runtimeKind: 'OTHER',
    protocol: 'ACP',
    capabilityDigest: ompAcpCapabilityDigestForVersionV1(version),
    approvalStatus: 'APPROVED_FOR_TEST',
    health: 'UNAVAILABLE',
    canCreateSession: false,
    canResumeSession: false,
    stream: 'NONE',
    interrupt: 'NONE',
    inspect: 'NONE',
    interactivePermission: 'HOST_MEDIATED',
    diagnosticOnly: false,
    reasonCode,
  }
}

function selectionMatchesTestCandidate(selection: RuntimeTestAdapterSelectionV1, digest: string): boolean {
  return (
    selection.adapterId === OMP_ACP_ADAPTER_ID_V1 &&
    selection.runtimeKind === 'OTHER' &&
    selection.protocol === 'ACP' &&
    selection.capabilityDigest === digest &&
    selection.approvalStatus === 'APPROVED_FOR_TEST' &&
    selection.diagnosticOnly === false &&
    selection.stream === 'POLL' &&
    selection.interrupt === 'BEST_EFFORT' &&
    selection.inspect === 'SNAPSHOT'
  )
}

function selectionMatchesProductionCandidate(
  selection: RuntimeAdapterSelectionV1,
  expected: RuntimeAdapterSelectionV1,
): boolean {
  return (
    selection.capabilityDigest === ompAcpProductionCapabilityDigestV1() &&
    expected.capabilityDigest === ompAcpProductionCapabilityDigestV1() &&
    runtimeSelectionKey(selection) === runtimeSelectionKey(expected)
  )
}

function isContractTestRequest(
  request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1,
): request is RuntimeContractTestCreateOrResumeRequestV1 {
  return 'executionMode' in request && request.executionMode === 'CONTRACT_TEST'
}

function handleSessionUpdate(state: RuntimeSessionStateV1, params: AcpSessionUpdateParamsV1): void {
  if (params.sessionId !== state.vendorSessionId) return
  const update = params.update
  if (!update) return
  if (
    update.sessionUpdate === 'agent_message_chunk' &&
    !Array.isArray(update.content) &&
    update.content?.text
  ) {
    const textDigest = digestJson(digestSafeText(update.content.text, 8000))
    state.evidenceDigests.push(textDigest)
    pushEvent(state, {
      type: 'TEXT_DELTA',
      runtimeSessionId: state.publicRuntimeSessionId,
      textDigest,
    })
    return
  }
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const eventDigest = digestJson(digestSafeText(JSON.stringify(update), 2000))
    state.evidenceDigests.push(eventDigest)
    pushEvent(state, {
      type: 'TOOL_EVENT',
      runtimeSessionId: state.publicRuntimeSessionId,
      toolName: safeToolName(update.kind ?? update.title ?? 'tool'),
      eventDigest,
    })
  }
}

function enqueuePrompt(state: RuntimeSessionStateV1, prompt: string): void {
  if (!isActive(state)) return
  state.promptQueue.push(prompt)
  drainPromptQueue(state)
}

function drainPromptQueue(state: RuntimeSessionStateV1): void {
  if (state.promptInFlight || !isActive(state)) return
  const prompt = state.promptQueue.shift()
  if (prompt === undefined) return
  state.promptInFlight = true
  void state.transport.prompt(state.vendorSessionId, [{ type: 'text', text: prompt }]).then(
    (result) => {
      state.promptInFlight = false
      if (result.stopReason === 'cancelled') {
        void commitOutcome(state, {
          state: 'INTERRUPTED',
          runtimeSessionId: state.publicRuntimeSessionId,
          receiptDigest: digestJson({ stopReason: result.stopReason }),
          reasonCode: 'RUNTIME_CANCELLED',
        })
      } else if (result.stopReason !== 'end_turn') {
        markUnknown(state, 'ACP_STOP_REASON_UNKNOWN')
      } else if (state.promptQueue.length) {
        drainPromptQueue(state)
      } else if (state.production) {
        void completeProductionSuccess(state, result.stopReason)
      } else if (!state.evidenceDigests.length) {
        markUnknown(state, 'OMP_CONTRACT_EVIDENCE_NOT_PRODUCED')
      } else {
        const candidateDigest = digestJson({
          domain: 'xiaogui.omp-acp.contract-test-evidence.v1',
          evidenceDigests: state.evidenceDigests,
        })
        pushEvent(state, {
          type: 'CANDIDATE_PRODUCED',
          runtimeSessionId: state.publicRuntimeSessionId,
          candidateDigest,
        })
        markOutcome(state, {
          state: 'SUCCEEDED',
          runtimeSessionId: state.publicRuntimeSessionId,
          receiptDigest: digestJson({ candidateDigest, stopReason: result.stopReason }),
          candidateDigest,
        })
      }
    },
    () => {
      state.promptInFlight = false
      markUnknown(state, 'PROCESS_DISCONNECTED')
    },
  )
}

async function completeProductionSuccess(state: RuntimeSessionStateV1, stopReason: string | undefined): Promise<void> {
  if (!state.production || state.outcome || state.settlementInFlight) return
  state.settlementInFlight = true
  try {
    const candidate = await state.production.candidateInspector.inspect({
      attemptId: state.request.scope.attemptId,
      allowNoApprovedChanges: !isContractTestRequest(state.request) && isReadOnlyRole(state.request),
    })
    if (!/^sha256:[0-9a-f]{64}$/.test(candidate.candidateDigest)) {
      markUnknown(state, 'OMP_CANDIDATE_DIGEST_INVALID')
      return
    }
    await commitOutcome(state, {
      state: 'SUCCEEDED',
      runtimeSessionId: state.publicRuntimeSessionId,
      receiptDigest: digestJson({
        domain: 'xiaogui.omp-acp.production-outcome.v1',
        candidateDigest: candidate.candidateDigest,
        installationReceiptDigest: state.production.installationReceiptDigest,
        stopReason,
      }),
      candidateDigest: candidate.candidateDigest,
    }, () => {
      pushEvent(state, {
        type: 'CANDIDATE_PRODUCED',
        runtimeSessionId: state.publicRuntimeSessionId,
        candidateDigest: candidate.candidateDigest,
      })
    })
  } catch {
    markUnknown(state, 'OMP_CANDIDATE_RECONCILE_FAILED')
  } finally {
    state.settlementInFlight = false
  }
}

async function commitOutcome(
  state: RuntimeSessionStateV1,
  outcome: Exclude<RuntimeOutcomeV1, { state: 'OUTCOME_UNKNOWN' }>,
  beforeMark?: () => void,
): Promise<void> {
  if (state.outcome) return
  if (state.production) {
    try {
      await state.production.recoveryStore.settle(state.publicRuntimeSessionId, outcome)
    } catch {
      markUnknown(state, 'OMP_OUTCOME_PERSIST_FAILED')
      return
    }
  }
  beforeMark?.()
  markOutcome(state, outcome)
}

async function bindFrozenModelSelector(
  transport: AcpTransportV1,
  vendorSessionId: string,
  request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1,
): Promise<string | undefined> {
  if (isContractTestRequest(request)) return undefined
  const selector = request.codingRole?.modelSelector
  if (!selector || selector === 'inherit') return undefined
  if (!isSafeRuntimeModelSelectorV1(selector)) return 'OMP_ACP_MODEL_SELECTOR_INVALID'
  if (!transport.setConfigOption) return 'OMP_ACP_MODEL_BINDING_UNAVAILABLE'
  try {
    await transport.setConfigOption(vendorSessionId, 'model', selector)
    return undefined
  } catch {
    return 'OMP_ACP_MODEL_BINDING_FAILED'
  }
}

function pushEvent(state: RuntimeSessionStateV1, event: RuntimeEventDraftV1): void {
  state.sequence += 1
  state.events.push({ ...event, sequence: state.sequence } as RuntimeEventV1)
}

function markOutcome(state: RuntimeSessionStateV1, outcome: RuntimeOutcomeV1): void {
  if (state.outcome) return
  state.outcome = outcome
  state.promptQueue = []
  clearPendingPermissions(state)
  if (outcome.state === 'OUTCOME_UNKNOWN') {
    pushEvent(state, {
      type: 'OUTCOME_UNKNOWN',
      runtimeSessionId: state.publicRuntimeSessionId,
      reasonCode: outcome.reasonCode,
    })
  } else {
    pushEvent(state, {
      type: 'RUNTIME_SETTLED',
      runtimeSessionId: state.publicRuntimeSessionId,
      outcome: outcome.state,
    })
  }
  void state.release()
}

function markUnknown(state: RuntimeSessionStateV1, reasonCode: string): void {
  markOutcome(state, unknown(state.publicRuntimeSessionId, reasonCode))
}

function markDisconnected(state: RuntimeSessionStateV1, reasonCode: string): void {
  if (state.disconnected) return
  state.disconnected = true
  if (!state.outcome) markUnknown(state, reasonCode)
}

function clearPendingPermissions(state: RuntimeSessionStateV1): void {
  for (const pending of state.pendingPermissions.values()) {
    if (!pending.consumed) pending.resolve({ outcome: { outcome: 'cancelled' } })
    pending.consumed = true
  }
  state.pendingPermissions.clear()
}

function isOmpApprovalElicitation(params: AcpElicitationCreateParamsV1): boolean {
  if (params.mode !== 'form' || !isPlainObject(params.requestedSchema)) return false
  const schema = params.requestedSchema
  if (schema.type !== 'object' || !isPlainObject(schema.properties)) return false
  const value = schema.properties.value
  if (!isPlainObject(value) || value.type !== 'string') return false
  if (!Array.isArray(value.enum) || value.enum.length !== 2 || value.enum[0] !== 'Approve' || value.enum[1] !== 'Deny') {
    return false
  }
  return Array.isArray(schema.required) && schema.required.length === 1 && schema.required[0] === 'value'
}

function decodePinnedOmpApprovalMessageV1(
  message: string | undefined,
): NonNullable<AcpRequestPermissionParamsV1['toolCall']> | null {
  if (typeof message !== 'string' || !message.length || message.length > 8192) return null
  const normalized = message.replace(/\r\n/g, '\n')
  if (normalized.includes('\r')) return null
  const lines = normalized.split('\n')
  const header = /^Allow tool: ([A-Za-z0-9._-]{1,40})$/.exec(lines[0] ?? '')
  if (!header) return null
  const toolName = header[1]
  if (toolName !== 'edit' && toolName !== 'write') return null

  // OMP 18.1.2 asks for ordinary edit/write approval through a form
  // elicitation before it publishes the structured tool_call event. This
  // decoder therefore accepts only that pinned upstream envelope. It is
  // intentionally narrower than a generic prompt parser: ambiguous,
  // truncated, multiline-path, multi-target, or future-version shapes cancel.
  const body = lines.slice(1)
  if (body[0]?.startsWith('Reason: ')) body.shift()
  let paths: string[]
  if (toolName === 'edit') {
    if (body.length !== 1 || !body[0]?.startsWith('File: ')) return null
    paths = [body[0].slice('File: '.length)]
  } else {
    if (body.length < 2 || !body[0]?.startsWith('Path: ') || body[1] !== 'Content:') return null
    if (body.slice(2).some((line) => line === 'Content:' || line.startsWith('Path: '))) return null
    paths = [body[0].slice('Path: '.length)]
  }
  if (paths.some((path) => (
    !path ||
    path !== path.trim() ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path === '(unknown)' ||
    path === '(missing)' ||
    path.includes('ch elided')
  ))) return null
  return {
    toolCallId: `omp-elicitation-${digestJson({ message }).slice(7, 23)}`,
    title: `OMP ${safeToolName(toolName)}`,
    kind: 'edit',
    status: 'pending',
    locations: paths.map((path) => ({ path })),
    rawInput: { approvalEnvelope: OMP_ACP_APPROVAL_ENVELOPE_V1 },
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isActive(state: RuntimeSessionStateV1): boolean {
  return !state.disconnected && !state.cancellationRequested && !state.outcome && !state.settlementInFlight
}

function inactiveReason(state: RuntimeSessionStateV1): string {
  if (state.outcome) return state.outcome.state === 'SUCCEEDED' ? 'RUNTIME_ALREADY_SETTLED' : state.outcome.reasonCode
  if (state.disconnected) return 'PROCESS_DISCONNECTED'
  if (state.cancellationRequested) return 'RUNTIME_CANCEL_REQUESTED'
  return 'RUNTIME_NOT_RUNNING'
}

function requestedRelativePaths(
  rootPath: string,
  locations: Array<{ path: string; line?: number }> | undefined,
): string[] | null {
  if (!Array.isArray(locations)) return []
  const result: string[] = []
  for (const location of locations) {
    if (!location || typeof location.path !== 'string' || !location.path.trim()) return null
    const absolute = isAbsolute(location.path)
      ? resolve(location.path)
      : resolve(rootPath, location.path)
    const rel = relative(resolve(rootPath), absolute)
    if (!rel || rel === '.') continue
    if (rel.startsWith('..') || isAbsolute(rel)) return null
    result.push(rel.replace(/\\/g, '/'))
  }
  return [...new Set(result)].sort()
}

function permissionPurpose(
  params: AcpRequestPermissionParamsV1,
): 'APPROVED_FILE_TOOL' | 'FILE_WRITE' | 'COMMAND' | 'DATA_EGRESS' {
  const kind = params.toolCall?.kind
  if (kind === 'fetch') return 'DATA_EGRESS'
  if (kind === 'execute') return 'COMMAND'
  if (Array.isArray(params.toolCall?.locations) && params.toolCall.locations.length) return 'FILE_WRITE'
  return 'APPROVED_FILE_TOOL'
}

function extractPath(params: unknown): string {
  if (
    typeof params !== 'object' ||
    params === null ||
    Array.isArray(params) ||
    typeof (params as { path?: unknown }).path !== 'string'
  ) {
    throw new Error('ACP_FS_PATH_INVALID')
  }
  return (params as { path: string }).path
}

function safeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'tool'
}

function failed(runtimeSessionId: string, reasonCode: string): RuntimeOutcomeV1 {
  return {
    state: 'FAILED',
    runtimeSessionId,
    receiptDigest: digestJson({ reasonCode }),
    reasonCode,
  }
}

function unknown(runtimeSessionId: string, reasonCode: string): RuntimeOutcomeV1 {
  return {
    state: 'OUTCOME_UNKNOWN',
    runtimeSessionId,
    inspectHandleDigest: digestJson({ runtimeSessionId, reasonCode }),
    reasonCode,
  }
}

function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function reasonCodeFromError(error: unknown, fallback: string): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { reasonCode?: unknown }).reasonCode === 'string'
  ) {
    return (error as { reasonCode: string }).reasonCode
  }
  return fallback
}

async function findOnPath(command: string): Promise<string | undefined> {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  return new Promise((resolveCommand) => {
    const child = spawn(probe, [command], { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.on('error', () => resolveCommand(undefined))
    child.on('close', (code) => {
      const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      resolveCommand(code === 0 && first ? first : undefined)
    })
  })
}

function isApprovedOmpLaunchArgs(args: readonly string[]): boolean {
  const direct = OMP_ACP_SAFE_ARGS_V1
  const bunx = ['--bun', OMP_ACP_APPROVED_PACKAGE_V1, ...OMP_ACP_SAFE_ARGS_V1]
  return arraysEqual(args, direct) || arraysEqual(args, bunx)
}

function isApprovedProductionLaunch(launch: OmpAcpTrustedLaunchV1): boolean {
  return (
    launch.version === OMP_ACP_APPROVED_VERSION_V1 &&
    isAbsolute(launch.command) &&
    /^sha256:[0-9a-f]{64}$/.test(launch.installationReceiptDigest) &&
    launch.args.length === OMP_ACP_SAFE_ARGS_V1.length + 1 &&
    isAbsolute(launch.args[0]) &&
    arraysEqual(launch.args.slice(1), OMP_ACP_SAFE_ARGS_V1)
  )
}

function isReadOnlyRole(request: RuntimeCreateOrResumeRequestV1): boolean {
  return request.codingRole?.role === 'RESEARCH' || request.codingRole?.role === 'REVIEW'
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function probeVersion(command: string, prefix: readonly string[]): Promise<string | undefined> {
  return new Promise((resolveVersion) => {
    const child = spawn(command, [...prefix, '--version'], {
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill()
      resolveVersion(undefined)
    }, 5000)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolveVersion(undefined)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolveVersion(stdout.match(/\d+\.\d+\.\d+/)?.[0])
    })
  })
}
