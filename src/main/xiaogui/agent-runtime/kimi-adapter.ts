import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  isRuntimeContractTestSelectionAllowed,
  isRuntimeSelectionAllowed,
  runtimeSelectionKey,
  validateRuntimeContractTestCreateRequestShapeV1,
  validateRuntimeProductionCreateRequestShapeV1,
} from '@shared/xiaogui-agent-runtime'
import type {
  AgentRuntimeAdapterV1,
  AgentRuntimeContractTestAdapterV1,
  AdapterIdV1,
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
  RuntimeSendRequestV1,
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'

import { KimiAcpProcessTransportFactoryV1 } from './acp/process-transport'
import {
  KIMI_ACP_APPROVED_VERSION_V1,
  KIMI_ACP_ENGINE_V1,
  KIMI_ACP_LEGACY_AGENT_PROFILE_DIGEST_V1,
  KIMI_ACP_TOOL_ALLOWLIST_V1,
  KIMI_ACP_TOOL_POLICY_DIGEST_V1,
  KimiAcpToolPolicyError,
  prepareKimiAcpToolPolicyV1,
} from './acp/kimi-tool-policy'
import { digestSafeText, isSafeAcpOpaqueId, localRuntimeSurrogate } from './acp/redaction'
import type {
  AcpRequestPermissionParamsV1,
  AcpRequestPermissionResultV1,
  AcpSessionUpdateParamsV1,
  AcpTransportFactoryV1,
  AcpTransportV1,
} from './acp/types'
import {
  digestBytes,
  KimiAcpWorkspacePolicyError,
  prepareKimiAcpWorkspacePolicy,
  type KimiAcpAllowedFileV1,
  type PreparedKimiAcpWorkspacePolicyV1,
} from './acp/workspace-policy'

const ADAPTER_ID = 'kimi-acp' as AdapterIdV1
const CLIENT_INFO = { name: 'xiaogui-kimi-acp-adapter', version: '0.1.0' }

export interface KimiAcpWorkspaceResolutionV1 {
  rootPath: string
  kimiCodeHome?: string
  allowedFiles: readonly KimiAcpAllowedFileV1[]
  resumeSessionId?: string
}

export interface KimiAcpWorkspaceResolverV1 {
  resolve(request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1): Promise<KimiAcpWorkspaceResolutionV1>
}

export interface KimiAcpProbeV1 {
  findExecutable(): Promise<{ available: true; command: string; version?: string } | { available: false; reasonCode: string }>
}

export interface KimiAcpRuntimeAdapterOptionsV1 {
  payloadResolver: TrustedRuntimePayloadResolverV1
  workspaceResolver: KimiAcpWorkspaceResolverV1
  probe?: KimiAcpProbeV1
  transportFactory?: AcpTransportFactoryV1
  productionGate?:
    | { enabled: false }
    | { enabled: true; selection: RuntimeAdapterSelectionV1 }
}

interface RuntimeSessionState {
  publicRuntimeSessionId: string
  vendorSessionId: string
  request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1
  transport: AcpTransportV1
  policy: PreparedKimiAcpWorkspacePolicyV1
  events: RuntimeEventV1[]
  sequence: number
  outcome: RuntimeOutcomeV1 | null
  disconnected: boolean
  releasePromise?: Promise<void>
  release: () => Promise<void>
  promptInFlight: boolean
  promptQueue: string[]
  cancellationRequested: boolean
  writeSequence: number
  pendingPermissions: Map<string, PendingPermission>
  vendorToolCalls: Map<string, VendorToolCallSnapshot>
  candidateDigest?: string
}

interface VendorToolCallSnapshot {
  kind?: string
  locations?: Array<{ path: string; line?: number }>
  rawInput?: unknown
}

type PendingPermission = VendorPendingPermission | WritePendingPermission

interface BasePendingPermission {
  challengeDigest: string
  consumed: boolean
  consumedBy?: string
}

interface VendorPendingPermission extends BasePendingPermission {
  kind: 'vendor'
  allowOnceOptionId: string
  rejectOptionId?: string
  resolve: (value: AcpRequestPermissionResultV1) => void
}

interface WritePendingPermission extends BasePendingPermission {
  kind: 'write'
  resolve: (value: boolean) => void
}

interface IdempotencyRecord {
  payloadDigest: string
  outcome: RuntimeCreateOrResumeOutcomeV1
}

interface PermissionDecisionRecord {
  decisionDigest: string
  result: { accepted: boolean; reasonCode?: string }
}

type RuntimeEventDraftV1 = RuntimeEventV1 extends infer Event ? (Event extends { sequence: number } ? Omit<Event, 'sequence'> : never) : never

export function createKimiAcpRuntimeAdapterV1(options: KimiAcpRuntimeAdapterOptionsV1): KimiAcpRuntimeAdapterV1 {
  return new KimiAcpRuntimeAdapterV1(options)
}

export class KimiAcpRuntimeAdapterV1 implements AgentRuntimeAdapterV1, AgentRuntimeContractTestAdapterV1 {
  private readonly probe: KimiAcpProbeV1
  private readonly transportFactory: AcpTransportFactoryV1
  private readonly sessions = new Map<string, RuntimeSessionState>()
  private readonly idempotency = new Map<string, IdempotencyRecord>()
  private readonly permissionDecisions = new Map<string, PermissionDecisionRecord>()
  private readonly consumedProofs = new Map<string, string>()
  private readonly ownedTransports = new Set<AcpTransportV1>()
  private readonly transportDisposals = new WeakMap<AcpTransportV1, Promise<void>>()
  private closed = false
  private closePromise?: Promise<void>

  constructor(private readonly options: KimiAcpRuntimeAdapterOptionsV1) {
    this.probe = options.probe ?? new KimiAcpCliProbeV1()
    this.transportFactory = options.transportFactory ?? new KimiAcpProcessTransportFactoryV1()
  }

  async discover(): Promise<readonly RuntimeCapabilityV1[]> {
    return [await this.capability()]
  }

  async health(adapterId: AdapterIdV1 | string): Promise<RuntimeCapabilityV1> {
    if (adapterId !== ADAPTER_ID) return this.unavailableCapability('RUNTIME_ADAPTER_NOT_FOUND')
    return this.capability()
  }

  async createOrResume(request: RuntimeCreateOrResumeRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1>
  async createOrResume(request: RuntimeContractTestCreateOrResumeRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1>
  async createOrResume(request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1> {
    if (this.closed) return failed('runtime-unbound', 'KIMI_ADAPTER_CLOSED')
    if (!isContractTestCreateRequestShape(request)) {
      const productionShape = validateRuntimeProductionCreateRequestShapeV1(request)
      if (!productionShape.ok) return failed('runtime-unbound', productionShape.reasonCode)
      const productionGate = this.options.productionGate
      if (!productionGate?.enabled) return failed('runtime-unbound', 'KIMI_PRODUCTION_DISABLED')
      const probe = await this.probe.findExecutable()
      if (!probe.available) return failed('runtime-unbound', probe.reasonCode)
      if (!isApprovedKimiVersion(probe.version)) return failed('runtime-unbound', 'KIMI_VERSION_UNAPPROVED')
      const selection = isRuntimeSelectionAllowed(request.selection, request.productionPolicy)
      if (!selection.ok) return failed('runtime-unbound', selection.reasonCode)
      if (!productionSelectionMatchesCandidate(request.selection, productionGate.selection, kimiAcpCapabilityDigestForVersionV1(probe.version))) {
        return failed('runtime-unbound', 'KIMI_PRODUCTION_SELECTION_MISMATCH')
      }
      return this.createVerifiedSession(request, probe)
    }
    const shape = validateRuntimeContractTestCreateRequestShapeV1(request)
    if (!shape.ok) return failed('runtime-unbound', shape.reasonCode)
    const probe = await this.probe.findExecutable()
    if (!probe.available) return failed('runtime-unbound', probe.reasonCode)
    if (!isApprovedKimiVersion(probe.version)) return failed('runtime-unbound', 'KIMI_VERSION_UNAPPROVED')
    const selection = isRuntimeContractTestSelectionAllowed(request.selection, request.contractTestPolicy)
    if (!selection.ok) return failed('runtime-unbound', selection.reasonCode)
    if (!selectionMatchesCandidate(request, kimiAcpCapabilityDigestForVersionV1(probe.version))) return failed('runtime-unbound', 'RUNTIME_SELECTION_NOT_KIMI_ACP_TEST')

    return this.createVerifiedSession(request, probe)
  }

  private async createVerifiedSession(
    request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1,
    probe: { available: true; command: string; version?: string },
  ): Promise<RuntimeCreateOrResumeOutcomeV1> {
    const idemKey = createIdempotencyKey(request)
    const payloadDigest = digestJson(request)
    const existing = this.idempotency.get(idemKey)
    if (existing) {
      if (existing.payloadDigest !== payloadDigest) return failed('runtime-unbound', 'IDEMPOTENCY_CONFLICT')
      return existing.outcome
    }

    let workspace: KimiAcpWorkspaceResolutionV1
    let policy: PreparedKimiAcpWorkspacePolicyV1
    let prompt: string
    try {
      workspace = await this.options.workspaceResolver.resolve(request)
      policy = prepareKimiAcpWorkspacePolicy(workspace.rootPath, workspace.allowedFiles)
      const toolPolicy = prepareKimiAcpToolPolicyV1(workspace.kimiCodeHome, workspace.rootPath)
      const envelope = await this.options.payloadResolver.resolvePrompt(request.promptEnvelopeRef)
      if (digestBytes(envelope.payloadBytes) !== request.promptEnvelopeRef.digest) return failed('runtime-unbound', 'PROMPT_DIGEST_MISMATCH')
      prompt = Buffer.from(envelope.payloadBytes).toString('utf8')
      if (this.closed) return failed('runtime-unbound', 'KIMI_ADAPTER_CLOSED')
      const transport = this.transportFactory.create(probe.command, ['acp'], workspace.rootPath, {
        env: toolPolicy.env,
        preSpawn: toolPolicy.revalidateBeforeSpawn,
      })
      this.ownedTransports.add(transport)
      return this.startReadySession(request, workspace, policy, prompt, transport, idemKey, payloadDigest)
    } catch (error) {
      return failed('runtime-unbound', reasonFromError(error, 'RUNTIME_WORKSPACE_BINDING_FAILED'))
    }
  }

  private async startReadySession(
    request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1,
    workspace: KimiAcpWorkspaceResolutionV1,
    policy: PreparedKimiAcpWorkspacePolicyV1,
    prompt: string,
    transport: AcpTransportV1,
    idemKey: string,
    payloadDigest: string,
  ): Promise<RuntimeCreateOrResumeOutcomeV1> {
    let state: RuntimeSessionState | null = null
    const requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>()
    requestHandlers.set('fs/read_text_file', (params) => {
      const result = policy.readTextFile(extractPath(params))
      return { content: result.content }
    })
    requestHandlers.set('fs/write_text_file', async (params) => {
      const write = extractWrite(params)
      if (!state || state.disconnected || state.outcome || state.cancellationRequested) throw new KimiAcpWorkspacePolicyError('ACP_FS_WRITE_NOT_RUNNING')
      const preflight = policy.preflightWriteTextFile(write.path, write.content)
      const granted = await this.requestWritePermission(state, preflight)
      if (!granted) throw new KimiAcpWorkspacePolicyError('ACP_FS_WRITE_DENIED')
      if (state.disconnected || state.outcome || state.cancellationRequested) throw new KimiAcpWorkspacePolicyError('ACP_FS_WRITE_NOT_RUNNING')
      const result = policy.writeTextFile(write.path, write.content, preflight)
      state.candidateDigest = result.candidateDigest
      pushEvent(state, { type: 'CANDIDATE_PRODUCED', runtimeSessionId: state.publicRuntimeSessionId, candidateDigest: result.candidateDigest })
      return { contentDigest: result.contentDigest }
    })
    for (const method of ['terminal/create', 'terminal/wait_for_exit', 'terminal/output', 'terminal/release', 'terminal/kill']) {
      requestHandlers.set(method, () => {
        throw new Error('ACP_TERMINAL_DENIED')
      })
    }

    try {
      await transport.start({
        cwd: workspace.rootPath,
        initialize: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
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
      if (this.closed) {
        await this.disposeTransport(transport)
        return failed('runtime-unbound', 'KIMI_ADAPTER_CLOSED')
      }
      const vendorSessionId = workspace.resumeSessionId ?? (await transport.newSession(workspace.rootPath)).sessionId
      if (this.closed) {
        await this.disposeTransport(transport)
        return failed('runtime-unbound', 'KIMI_ADAPTER_CLOSED')
      }
      if (!isSafeAcpOpaqueId(vendorSessionId)) {
        await this.disposeTransport(transport)
        return failed('runtime-unbound', 'ACP_SESSION_ID_UNSAFE')
      }
      if (workspace.resumeSessionId) await transport.loadSession(vendorSessionId, workspace.rootPath)
      if (this.closed) {
        await this.disposeTransport(transport)
        return failed('runtime-unbound', 'KIMI_ADAPTER_CLOSED')
      }

      const publicRuntimeSessionId = localRuntimeSurrogate(vendorSessionId, digestJson({ scope: request.scope, workspace: request.workspace }))
      state = {
        publicRuntimeSessionId,
        vendorSessionId,
        request,
        transport,
        policy,
        events: [],
        sequence: 0,
        outcome: null,
        disconnected: false,
        release: () => this.disposeTransport(transport),
        promptInFlight: false,
        promptQueue: [],
        cancellationRequested: false,
        writeSequence: 0,
        pendingPermissions: new Map(),
        vendorToolCalls: new Map(),
      }
      this.sessions.set(publicRuntimeSessionId, state)
      pushEvent(state, { type: 'SESSION_READY', runtimeSessionId: publicRuntimeSessionId })

      enqueuePromptTurn(state, prompt)
      const outcome = { state: 'READY', runtimeSessionId: publicRuntimeSessionId } as const
      this.idempotency.set(idemKey, { payloadDigest, outcome })
      return outcome
    } catch (error) {
      await this.disposeTransport(transport)
      const outcome = this.closed
        ? failed('runtime-unbound', 'KIMI_ADAPTER_CLOSED')
        : failed('runtime-unbound', reasonFromError(error, 'ACP_SESSION_START_FAILED'))
      if (!this.closed) this.idempotency.set(idemKey, { payloadDigest, outcome })
      return outcome
    }
  }

  async send(request: RuntimeSendRequestV1): Promise<{ accepted: true; requestId: string } | { accepted: false; reasonCode: string }> {
    const state = this.sessions.get(request.runtimeSessionId)
    if (!state) return { accepted: false, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    if (state.disconnected || state.outcome || state.cancellationRequested) return { accepted: false, reasonCode: inactiveSessionReason(state) }
    let message: string
    try {
      if (request.messageEnvelopeRef.mediaType !== 'application/vnd.xiaogui.runtime-message+json') return { accepted: false, reasonCode: 'MESSAGE_MEDIA_TYPE_UNSUPPORTED' }
      const envelope = await this.options.payloadResolver.resolveMessage(request.messageEnvelopeRef)
      if (
        envelope.messageEnvelopeRef.refId !== request.messageEnvelopeRef.refId ||
        envelope.messageEnvelopeRef.digest !== request.messageEnvelopeRef.digest ||
        envelope.messageEnvelopeRef.mediaType !== request.messageEnvelopeRef.mediaType
      ) {
        return { accepted: false, reasonCode: 'MESSAGE_REF_MISMATCH' }
      }
      if (digestBytes(envelope.payloadBytes) !== request.messageEnvelopeRef.digest) return { accepted: false, reasonCode: 'MESSAGE_DIGEST_MISMATCH' }
      message = Buffer.from(envelope.payloadBytes).toString('utf8')
    } catch {
      return { accepted: false, reasonCode: 'MESSAGE_RESOLVE_FAILED' }
    }
    if (state.disconnected || state.outcome || state.cancellationRequested) return { accepted: false, reasonCode: inactiveSessionReason(state) }
    enqueuePromptTurn(state, message)
    return { accepted: true, requestId: request.requestId }
  }

  async *stream(runtimeSessionId: string, afterSequence: number): AsyncIterable<RuntimeEventV1> {
    const state = this.sessions.get(runtimeSessionId)
    if (!state) {
      yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: afterSequence + 1, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
      return
    }
    for (const event of state.events) {
      if (event.sequence > afterSequence) yield event
    }
  }

  async permission(decision: RuntimePermissionDecisionV1): Promise<{ accepted: boolean; reasonCode?: string }> {
    const state = this.sessions.get(decision.runtimeSessionId)
    if (!state) return { accepted: false, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    if (state.disconnected || state.outcome || state.cancellationRequested) return { accepted: false, reasonCode: inactiveSessionReason(state) }
    const decisionDigest = digestJson(decision)
    const existing = this.permissionDecisions.get(decision.decisionRequestId)
    if (existing) {
      if (existing.decisionDigest !== decisionDigest) return { accepted: false, reasonCode: 'PERMISSION_DECISION_CONFLICT' }
      return existing.result
    }
    if (digestJson(decision.scope) !== digestJson(state.request.scope)) {
      const result = { accepted: false, reasonCode: 'PERMISSION_SCOPE_MISMATCH' }
      this.permissionDecisions.set(decision.decisionRequestId, { decisionDigest, result })
      return result
    }
    const pending = state.pendingPermissions.get(decision.permissionRequestId)
    if (!pending || pending.challengeDigest !== decision.challengeDigest) {
      const result = { accepted: false, reasonCode: 'PERMISSION_SCOPE_MISMATCH' }
      this.permissionDecisions.set(decision.decisionRequestId, { decisionDigest, result })
      return result
    }
    if (pending.consumed) {
      const result = { accepted: false, reasonCode: pending.consumedBy === decision.decisionRequestId ? undefined : 'PERMISSION_REQUEST_CONSUMED' }
      this.permissionDecisions.set(decision.decisionRequestId, { decisionDigest, result })
      return result
    }
    if (decision.type === 'ALLOW_ONCE') {
      const key = permissionProofKey(decision)
      const proofConsumedBy = this.consumedProofs.get(key)
      if (proofConsumedBy && proofConsumedBy !== decision.decisionRequestId) {
        const result = { accepted: false, reasonCode: 'PERMISSION_PROOF_REPLAYED' }
        this.permissionDecisions.set(decision.decisionRequestId, { decisionDigest, result })
        return result
      }
      this.consumedProofs.set(key, decision.decisionRequestId)
    }
    pending.consumed = true
    pending.consumedBy = decision.decisionRequestId
    if (decision.type === 'DENY') {
      if (pending.kind === 'vendor') pending.resolve(pending.rejectOptionId ? { outcome: { outcome: 'selected', optionId: pending.rejectOptionId } } : { outcome: { outcome: 'cancelled' } })
      else pending.resolve(false)
      const result = { accepted: true }
      this.permissionDecisions.set(decision.decisionRequestId, { decisionDigest, result })
      return result
    }
    if (pending.kind === 'vendor') pending.resolve({ outcome: { outcome: 'selected', optionId: pending.allowOnceOptionId } })
    else pending.resolve(true)
    const result = { accepted: true }
    this.permissionDecisions.set(decision.decisionRequestId, { decisionDigest, result })
    return result
  }

  async interrupt(request: RuntimeInterruptRequestV1): Promise<{ requested: true } | { requested: false; reasonCode: string }> {
    const state = this.sessions.get(request.runtimeSessionId)
    if (!state) return { requested: false, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    if (state.outcome) return { requested: false, reasonCode: terminalReason(state.outcome) ?? 'RUNTIME_ALREADY_SETTLED' }
    if (state.disconnected) return { requested: false, reasonCode: 'PROCESS_DISCONNECTED' }
    state.cancellationRequested = true
    state.promptQueue = []
    clearPendingPermissions(state)
    await state.transport.cancel(state.vendorSessionId)
    return { requested: true }
  }

  async inspect(runtimeSessionId: string): Promise<RuntimeOutcomeV1> {
    return this.sessions.get(runtimeSessionId)?.outcome ?? unknown(runtimeSessionId, 'RUNTIME_STILL_RUNNING')
  }

  async reconcile(runtimeSessionId: string, expectedReceiptDigest?: string): Promise<RuntimeOutcomeV1> {
    const outcome = await this.inspect(runtimeSessionId)
    if (expectedReceiptDigest && 'receiptDigest' in outcome && outcome.receiptDigest !== expectedReceiptDigest) {
      return unknown(runtimeSessionId, 'RUNTIME_RECEIPT_DIGEST_MISMATCH')
    }
    return outcome
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true

    const states = [...this.sessions.values()]
    this.sessions.clear()
    this.idempotency.clear()
    this.permissionDecisions.clear()
    this.consumedProofs.clear()
    const stateReleases = states.map((state) => {
      state.cancellationRequested = true
      state.promptQueue = []
      clearPendingPermissions(state)
      return releaseTransport(state)
    })

    const transports = [...this.ownedTransports]
    this.closePromise = Promise.all([
      ...stateReleases,
      ...transports.map((transport) => this.disposeTransport(transport)),
    ]).then(() => undefined)
    return this.closePromise
  }

  private async capability(): Promise<RuntimeCapabilityV1> {
    if (this.closed) return this.unavailableCapability('KIMI_ADAPTER_CLOSED')
    const productionGate = this.options.productionGate
    const approvedProductionDigest = kimiAcpCapabilityDigestForVersionV1(KIMI_ACP_APPROVED_VERSION_V1)
    if (productionGate?.enabled && !isExactKimiProductionSelection(productionGate.selection, approvedProductionDigest)) {
      return unavailable('KIMI_PRODUCTION_SELECTION_INVALID', 'REJECTED')
    }
    const approvalStatus = productionGate?.enabled ? 'APPROVED_FOR_PRODUCTION' : 'APPROVED_FOR_TEST'
    const probe = await this.probe.findExecutable()
    if (!probe.available) return unavailable(probe.reasonCode, approvalStatus)
    if (!isApprovedKimiVersion(probe.version)) return unavailable('KIMI_VERSION_UNAPPROVED', approvalStatus)
    const capability: RuntimeCapabilityV2 = {
      adapterId: ADAPTER_ID,
      runtimeKind: 'KIMI',
      protocol: 'ACP',
      capabilityDigest: kimiAcpCapabilityDigestForVersionV1(probe.version),
      approvalStatus,
      health: 'AVAILABLE',
      canCreateSession: true,
      canResumeSession: true,
      stream: 'POLL',
      interrupt: 'BEST_EFFORT',
      inspect: 'RECONCILE',
      interactivePermission: 'HOST_MEDIATED',
      diagnosticOnly: false,
      version: 2,
      runtimeVersion: probe.version ?? 'unknown',
      capabilitySummary: '小规 CODING 任务的 Kimi ACP 运行时',
      workModes: ['CODING'],
      taskCapabilities: ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT'],
      executionLocation: 'EXTERNAL',
      requiresDataEgress: true,
      supportsResume: true,
      supportsEventStream: true,
      supportsInterrupt: true,
      supportsResultReconcile: true,
      reasonCode: probe.version ? `KIMI_${probe.version}` : undefined,
    }
    return capability
  }

  private unavailableCapability(reasonCode: string): RuntimeCapabilityV1 {
    const productionGate = this.options.productionGate
    if (!productionGate?.enabled) return unavailable(reasonCode)
    const expectedDigest = kimiAcpCapabilityDigestForVersionV1(KIMI_ACP_APPROVED_VERSION_V1)
    const approvalStatus = isExactKimiProductionSelection(productionGate.selection, expectedDigest)
      ? 'APPROVED_FOR_PRODUCTION'
      : 'REJECTED'
    return unavailable(reasonCode, approvalStatus)
  }

  private handlePermissionRequest(state: RuntimeSessionState, params: AcpRequestPermissionParamsV1): Promise<AcpRequestPermissionResultV1> {
    const options = Array.isArray(params.options) ? params.options : []
    const optionIds = options.map((option) => option.optionId)
    const optionsValid = optionIds.every((optionId) => typeof optionId === 'string' && optionId.length > 0 && optionId === optionId.trim()) && new Set(optionIds).size === optionIds.length
    const allowOnce = options.filter((option) => option.kind === 'allow_once')
    if (!optionsValid || allowOnce.length !== 1 || !isApprovedVendorFileToolRequest(state, params)) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }
    const rejectOnce = options.find((option) => option.kind === 'reject_once')
    const permissionRequestId = `perm-${digestJson(params).slice(7, 23)}`
    const challengeDigest = digestJson({ session: state.publicRuntimeSessionId, tool: params.toolCall, options: params.options })
    pushEvent(state, {
      type: 'PERMISSION_REQUESTED',
      permissionRequestId,
      runtimeSessionId: state.publicRuntimeSessionId,
      scope: state.request.scope,
      challengeDigest,
      decisionRequired: 'ALLOW_ONCE_OR_DENY',
      permissionPurpose: 'APPROVED_FILE_TOOL',
    })
    return new Promise((resolve) => {
      state.pendingPermissions.set(permissionRequestId, { kind: 'vendor', challengeDigest, allowOnceOptionId: allowOnce[0].optionId, rejectOptionId: rejectOnce?.optionId, resolve, consumed: false })
    })
  }

  private requestWritePermission(state: RuntimeSessionState, preflight: { targetDigest: string; contentDigest: string }): Promise<boolean> {
    state.writeSequence += 1
    const writeSequence = state.writeSequence
    const challengeDigest = digestJson({
      domain: 'xiaogui.kimi-acp.write-permission-challenge.v1',
      runtimeSessionId: state.publicRuntimeSessionId,
      writeSequence,
      targetDigest: preflight.targetDigest,
      contentDigest: preflight.contentDigest,
    })
    const permissionRequestId = `write-perm-${digestJson({ runtimeSessionId: state.publicRuntimeSessionId, writeSequence, challengeDigest }).slice(7, 23)}`
    pushEvent(state, {
      type: 'PERMISSION_REQUESTED',
      permissionRequestId,
      runtimeSessionId: state.publicRuntimeSessionId,
      scope: state.request.scope,
      challengeDigest,
      decisionRequired: 'ALLOW_ONCE_OR_DENY',
      permissionPurpose: 'FILE_WRITE',
    })
    return new Promise((resolve) => {
      state.pendingPermissions.set(permissionRequestId, { kind: 'write', challengeDigest, resolve, consumed: false })
    })
  }

  private disposeTransport(transport: AcpTransportV1): Promise<void> {
    const existing = this.transportDisposals.get(transport)
    if (existing) return existing

    const disposal = Promise.resolve()
      .then(() => transport.dispose())
      .catch(() => {
        // Transport shutdown failures stay behind the adapter boundary.
      })
      .finally(() => {
        this.ownedTransports.delete(transport)
      })
    this.transportDisposals.set(transport, disposal)
    return disposal
  }
}

export class KimiAcpCliProbeV1 implements KimiAcpProbeV1 {
  async findExecutable(): Promise<{ available: true; command: string; version?: string } | { available: false; reasonCode: string }> {
    const command = firstExisting([
      process.env.KIMI_CLI_PATH,
      await findOnPath('kimi'),
      join(homedir(), '.kimi-code', 'bin', 'kimi.exe'),
      join(homedir(), '.kimi-code', 'bin', 'kimi'),
    ])
    if (!command) return { available: false, reasonCode: 'EXECUTABLE_NOT_FOUND' }
    const version = await probeVersion(command)
    return version ? { available: true, command, version } : { available: true, command }
  }
}

export function kimiAcpCapabilityDigestForVersionV1(version: string | undefined): string {
  return digestJson({
    adapterId: ADAPTER_ID,
    protocol: 'ACP',
    engine: KIMI_ACP_ENGINE_V1,
    approvedVersion: KIMI_ACP_APPROVED_VERSION_V1,
    version: version === KIMI_ACP_APPROVED_VERSION_V1 ? version : 'unapproved',
    fs: 'host-mediated',
    writePermission: 'adapter-owned-allow-once-per-write',
    terminal: 'host-deny',
    promptTurns: 'strict-fifo',
    kimiLocalToolPolicyDigest: KIMI_ACP_TOOL_POLICY_DIGEST_V1,
    kimiLocalToolAllowlist: KIMI_ACP_TOOL_ALLOWLIST_V1,
    kimiLegacyAgentProfileDigest: KIMI_ACP_LEGACY_AGENT_PROFILE_DIGEST_V1,
    sourceBaseline: 'task-hub@4c9f81c05310b7771d6cf320293ad3af46a256b7',
  })
}

function selectionMatchesCandidate(request: RuntimeContractTestCreateOrResumeRequestV1, expectedCapabilityDigest: string): boolean {
  const candidate = request.selection
  return (
    candidate.adapterId === ADAPTER_ID &&
    candidate.runtimeKind === 'KIMI' &&
    candidate.protocol === 'ACP' &&
    candidate.capabilityDigest === expectedCapabilityDigest &&
    candidate.approvalStatus === 'APPROVED_FOR_TEST' &&
    candidate.diagnosticOnly === false &&
    candidate.stream === 'POLL' &&
    candidate.interrupt === 'BEST_EFFORT' &&
    candidate.inspect === 'RECONCILE'
  )
}

function productionSelectionMatchesCandidate(
  requestSelection: RuntimeAdapterSelectionV1,
  approvedSelection: RuntimeAdapterSelectionV1,
  expectedCapabilityDigest: string,
): boolean {
  return (
    isExactKimiProductionSelection(requestSelection, expectedCapabilityDigest) &&
    isExactKimiProductionSelection(approvedSelection, expectedCapabilityDigest) &&
    runtimeSelectionKey(requestSelection) === runtimeSelectionKey(approvedSelection)
  )
}

function isExactKimiProductionSelection(selection: RuntimeAdapterSelectionV1, expectedCapabilityDigest: string): boolean {
  return (
    selection.adapterId === ADAPTER_ID &&
    selection.runtimeKind === 'KIMI' &&
    selection.protocol === 'ACP' &&
    selection.capabilityDigest === expectedCapabilityDigest &&
    selection.approvalStatus === 'APPROVED_FOR_PRODUCTION' &&
    selection.diagnosticOnly === false &&
    selection.stream === 'POLL' &&
    selection.interrupt === 'BEST_EFFORT' &&
    selection.inspect === 'RECONCILE'
  )
}

function handleSessionUpdate(state: RuntimeSessionState, params: AcpSessionUpdateParamsV1): void {
  const update = params.update
  if (!update) return
  if (
    update.sessionUpdate === 'agent_message_chunk' &&
    !Array.isArray(update.content) &&
    update.content?.text
  ) {
    pushEvent(state, { type: 'TEXT_DELTA', runtimeSessionId: state.publicRuntimeSessionId, textDigest: digestJson(digestSafeText(update.content.text, 8000)) })
  } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    cacheVendorToolCall(state, update)
    pushEvent(state, {
      type: 'TOOL_EVENT',
      runtimeSessionId: state.publicRuntimeSessionId,
      toolName: safeToolName(update.kind ?? update.title ?? 'tool'),
      eventDigest: digestJson(digestSafeText(JSON.stringify(update), 2000)),
    })
  }
}

function enqueuePromptTurn(state: RuntimeSessionState, prompt: string): void {
  if (state.outcome || state.disconnected || state.cancellationRequested) return
  state.promptQueue.push(prompt)
  drainPromptQueue(state)
}

function drainPromptQueue(state: RuntimeSessionState): void {
  if (state.promptInFlight || state.outcome || state.disconnected || state.cancellationRequested) return
  const prompt = state.promptQueue.shift()
  if (prompt === undefined) return
  state.promptInFlight = true
  void state.transport.prompt(state.vendorSessionId, [{ type: 'text', text: prompt }]).then(
    (result) => {
      state.promptInFlight = false
      settleFromPrompt(state, result.stopReason)
    },
    () => {
      state.promptInFlight = false
      markUnknown(state, 'PROCESS_DISCONNECTED')
    },
  )
}

function settleFromPrompt(state: RuntimeSessionState, stopReason: string | undefined): void {
  if (state.outcome) return
  if (stopReason === 'cancelled') {
    markOutcome(state, { state: 'INTERRUPTED', runtimeSessionId: state.publicRuntimeSessionId, receiptDigest: digestJson({ stopReason }), reasonCode: 'RUNTIME_CANCELLED' })
    return
  }
  if (stopReason !== 'end_turn') {
    markUnknown(state, 'ACP_STOP_REASON_UNKNOWN')
    return
  }
  if (state.promptQueue.length > 0) {
    drainPromptQueue(state)
    return
  }
  if (!state.candidateDigest) {
    markUnknown(state, 'CANDIDATE_NOT_PRODUCED')
    return
  }
  markOutcome(state, {
    state: 'SUCCEEDED',
    runtimeSessionId: state.publicRuntimeSessionId,
    receiptDigest: digestJson({ candidateDigest: state.candidateDigest, stopReason }),
    candidateDigest: state.candidateDigest,
  })
}

function markUnknown(state: RuntimeSessionState, reasonCode: string): void {
  if (state.outcome) return
  markOutcome(state, unknown(state.publicRuntimeSessionId, reasonCode))
}

function markDisconnected(state: RuntimeSessionState, reasonCode: string): void {
  if (state.disconnected) return
  state.disconnected = true
  state.promptQueue = []
  if (!state.outcome) markOutcome(state, unknown(state.publicRuntimeSessionId, reasonCode))
  else releaseTransport(state)
}

function markOutcome(state: RuntimeSessionState, outcome: RuntimeOutcomeV1): void {
  if (state.outcome) return
  state.outcome = outcome
  state.promptQueue = []
  clearPendingPermissions(state)
  state.vendorToolCalls.clear()
  if (outcome.state === 'OUTCOME_UNKNOWN') {
    pushEvent(state, { type: 'OUTCOME_UNKNOWN', runtimeSessionId: state.publicRuntimeSessionId, reasonCode: outcome.reasonCode })
  } else {
    pushEvent(state, { type: 'RUNTIME_SETTLED', runtimeSessionId: state.publicRuntimeSessionId, outcome: outcome.state })
  }
  releaseTransport(state)
}

function clearPendingPermissions(state: RuntimeSessionState): void {
  for (const pending of state.pendingPermissions.values()) {
    if (!pending.consumed) {
      if (pending.kind === 'vendor') pending.resolve({ outcome: { outcome: 'cancelled' } })
      else pending.resolve(false)
    }
    pending.consumed = true
  }
  state.pendingPermissions.clear()
}

function isApprovedVendorFileToolRequest(
  state: RuntimeSessionState,
  params: AcpRequestPermissionParamsV1,
): boolean {
  // Kimi 0.34 asks permission after announcing the tool kind, but before it
  // publishes rawInput/locations. Bind the request to that toolCallId and use
  // the permission diff as the path-bearing evidence. Actual writes are still
  // checked independently by the workspace policy.
  if (params.sessionId !== state.vendorSessionId) return false
  const toolCallId = safeToolCallId(params.toolCall?.toolCallId)
  const cached = toolCallId ? state.vendorToolCalls.get(toolCallId) : undefined
  const kind = normalizedToolKind(cached?.kind)
  if (!cached || kind !== 'edit') return false
  try {
    const targetDigest = permissionDiffTargetDigest(state.policy, params.toolCall?.content)
    if (!targetDigest) return false

    const rawPath = fileToolInputPath(cached.rawInput)
    if (cached.rawInput !== undefined && !rawPath) return false
    if (rawPath && state.policy.approvedTargetDigest(rawPath) !== targetDigest) return false
    if (
      cached.locations !== undefined &&
      !allLocationsMatchTarget(state.policy, cached.locations, targetDigest)
    ) {
      return false
    }

    const requestKind = params.toolCall?.kind
    if (requestKind !== undefined && normalizedToolKind(requestKind) !== kind) return false
    if (
      params.toolCall?.locations !== undefined &&
      !allLocationsMatchTarget(state.policy, params.toolCall.locations, targetDigest)
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

function cacheVendorToolCall(
  state: RuntimeSessionState,
  update: AcpSessionUpdateParamsV1['update'],
): void {
  const toolCallId = safeToolCallId(update.toolCallId)
  if (!toolCallId) return
  const current = state.vendorToolCalls.get(toolCallId) ?? {}
  const next: VendorToolCallSnapshot = { ...current }
  if (typeof update.kind === 'string') next.kind = update.kind
  if (Array.isArray(update.locations)) next.locations = update.locations
  if (Object.prototype.hasOwnProperty.call(update, 'rawInput')) next.rawInput = update.rawInput
  state.vendorToolCalls.set(toolCallId, next)
  if (update.status === 'completed' || update.status === 'failed') {
    state.vendorToolCalls.delete(toolCallId)
  }
}

function safeToolCallId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    ? value
    : null
}

function normalizedToolKind(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function fileToolInputPath(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  for (const key of ['path', 'file_path']) {
    const path = input[key]
    if (typeof path === 'string' && path.length > 0 && path === path.trim()) return path
  }
  return null
}

function allLocationsMatchTarget(
  policy: PreparedKimiAcpWorkspacePolicyV1,
  locations: unknown,
  targetDigest: string,
): boolean {
  if (!Array.isArray(locations) || locations.length === 0) return false
  return locations.every((location) => (
    typeof location === 'object' &&
    location !== null &&
    typeof (location as { path?: unknown }).path === 'string' &&
    policy.approvedTargetDigest((location as { path: string }).path) === targetDigest
  ))
}

function permissionDiffTargetDigest(
  policy: PreparedKimiAcpWorkspacePolicyV1,
  content: unknown,
): string | null {
  if (!Array.isArray(content)) return null
  const diffEntries = content.filter((entry) => (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as { type?: unknown }).type === 'diff'
  ))
  if (diffEntries.length === 0) return null
  let targetDigest: string | null = null
  for (const entry of diffEntries) {
    const path = (entry as { path?: unknown }).path
    if (typeof path !== 'string' || path.length === 0 || path !== path.trim()) return null
    const digest = policy.approvedTargetDigest(path)
    if (targetDigest && targetDigest !== digest) return null
    targetDigest = digest
  }
  return targetDigest
}

function releaseTransport(state: RuntimeSessionState): Promise<void> {
  if (state.releasePromise) return state.releasePromise
  state.releasePromise = state.release()
  return state.releasePromise
}

function pushEvent(state: RuntimeSessionState, event: RuntimeEventDraftV1): void {
  state.sequence += 1
  state.events.push({ ...event, sequence: state.sequence } as RuntimeEventV1)
}

function extractPath(params: unknown): string {
  if (typeof params !== 'object' || params === null || Array.isArray(params) || typeof (params as { path?: unknown }).path !== 'string') {
    throw new KimiAcpWorkspacePolicyError('ACP_FS_PATH_INVALID')
  }
  return (params as { path: string }).path
}

function extractWrite(params: unknown): { path: string; content: string } {
  if (
    typeof params !== 'object' ||
    params === null ||
    Array.isArray(params) ||
    typeof (params as { path?: unknown }).path !== 'string' ||
    typeof (params as { content?: unknown }).content !== 'string'
  ) {
    throw new KimiAcpWorkspacePolicyError('ACP_FS_WRITE_INVALID')
  }
  return params as { path: string; content: string }
}

function safeToolName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
  return normalized || 'tool'
}

function failed(runtimeSessionId: string, reasonCode: string): RuntimeOutcomeV1 {
  return { state: 'FAILED', runtimeSessionId, receiptDigest: digestJson({ reasonCode }), reasonCode }
}

function unknown(runtimeSessionId: string, reasonCode: string): RuntimeOutcomeV1 {
  return { state: 'OUTCOME_UNKNOWN', runtimeSessionId, inspectHandleDigest: digestJson({ reasonCode }), reasonCode }
}

function unavailable(
  reasonCode: string,
  approvalStatus: RuntimeCapabilityV1['approvalStatus'] = 'APPROVED_FOR_TEST',
): RuntimeCapabilityV1 {
  return {
    adapterId: ADAPTER_ID,
    runtimeKind: 'KIMI',
    protocol: 'ACP',
    capabilityDigest: kimiAcpCapabilityDigestForVersionV1(undefined),
    approvalStatus,
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

function isApprovedKimiVersion(version: string | undefined): boolean {
  return version === KIMI_ACP_APPROVED_VERSION_V1
}

function reasonFromError(error: unknown, fallback: string): string {
  if (error instanceof KimiAcpWorkspacePolicyError) return error.reasonCode
  if (error instanceof KimiAcpToolPolicyError) return error.reasonCode
  return fallback
}

function terminalReason(outcome: RuntimeOutcomeV1 | null): string | undefined {
  if (!outcome) return undefined
  return outcome.state === 'SUCCEEDED' ? undefined : outcome.reasonCode
}

function inactiveSessionReason(state: RuntimeSessionState): string {
  if (state.outcome) return state.outcome.state === 'SUCCEEDED' ? 'RUNTIME_ALREADY_SETTLED' : state.outcome.reasonCode
  if (state.disconnected) return 'PROCESS_DISCONNECTED'
  if (state.cancellationRequested) return 'RUNTIME_CANCEL_REQUESTED'
  return 'RUNTIME_NOT_RUNNING'
}

function permissionProofKey(decision: Extract<RuntimePermissionDecisionV1, { type: 'ALLOW_ONCE' }>): string {
  return [
    decision.runtimeSessionId,
    decision.proofId,
    decision.proofDigest,
    digestJson(decision.scope),
  ].join('|')
}

function createIdempotencyKey(request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1): string {
  return [
    request.requestId,
    request.selection.adapterId,
    request.selection.protocol,
    request.selection.capabilityDigest,
    request.scope.attemptDigest,
    request.scope.workspaceReceiptDigest,
    request.promptEnvelopeRef.digest,
  ].join('|')
}

function isContractTestCreateRequestShape(value: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1): value is RuntimeContractTestCreateOrResumeRequestV1 {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { executionMode?: unknown }).executionMode === 'CONTRACT_TEST'
  } catch {
    return false
  }
}

async function findOnPath(name: string): Promise<string | undefined> {
  const command = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = await runCapturing(command, [name], 8000)
  if (result.exitCode !== 0) return undefined
  return firstExisting(result.output.split(/\r?\n/).map((line) => line.trim()))
}

function firstExisting(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // ignore invalid candidate paths
    }
  }
  return undefined
}

async function probeVersion(command: string): Promise<string | undefined> {
  const result = await runCapturing(command, ['--version'], 10000)
  if (result.exitCode !== 0 || !result.output) return undefined
  const match = result.output.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/)
  return match?.[0] ?? result.output.split(/\r?\n/)[0]?.trim()
}

function runCapturing(command: string, args: readonly string[], timeoutMs: number): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      const needShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
      const spawnFile = needShell ? `"${command}" ${args.join(' ')}` : command
      child = spawn(spawnFile, needShell ? [] : [...args], {
        shell: needShell,
        env: { ...process.env, PATH: process.env.PATH ?? '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve({ exitCode: null, output: '' })
      return
    }

    let output = ''
    let settled = false
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, output: output.trim() })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore failed timeout cleanup
      }
      finish(null)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      output += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
  })
}

function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}
