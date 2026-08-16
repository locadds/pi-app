import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'

import { KimiAcpProcessTransportFactoryV1 } from './acp/process-transport'
import { digestSafeText, isSafeAcpOpaqueId, localRuntimeSurrogate } from './acp/redaction'
import type {
  AcpRequestPermissionParamsV1,
  AcpRequestPermissionResultV1,
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
  allowedFiles: readonly KimiAcpAllowedFileV1[]
  resumeSessionId?: string
}

export interface KimiAcpWorkspaceResolverV1 {
  resolve(request: RuntimeCreateOrResumeRequestV1 | KimiAcpCreateOrResumeForTestRequestV1): Promise<KimiAcpWorkspaceResolutionV1>
}

export interface KimiAcpProbeV1 {
  findExecutable(): Promise<{ available: true; command: string; version?: string } | { available: false; reasonCode: string }>
}

export interface KimiAcpRuntimeAdapterOptionsV1 {
  payloadResolver: TrustedRuntimePayloadResolverV1
  workspaceResolver: KimiAcpWorkspaceResolverV1
  probe?: KimiAcpProbeV1
  transportFactory?: AcpTransportFactoryV1
}

export interface KimiAcpTestAdapterSelectionV1 {
  adapterId: AdapterIdV1 | string
  runtimeKind: 'KIMI'
  protocol: 'ACP'
  capabilityDigest: string
  approvalStatus: 'APPROVED_FOR_TEST'
  diagnosticOnly: false
  stream: 'POLL'
  interrupt: 'BEST_EFFORT'
  inspect: 'RECONCILE'
}

export type KimiAcpCreateOrResumeForTestRequestV1 = Omit<RuntimeCreateOrResumeRequestV1, 'selection'> & {
  selection: KimiAcpTestAdapterSelectionV1
}

interface RuntimeSessionState {
  publicRuntimeSessionId: string
  vendorSessionId: string
  request: RuntimeCreateOrResumeRequestV1 | KimiAcpCreateOrResumeForTestRequestV1
  transport: AcpTransportV1
  policy: PreparedKimiAcpWorkspacePolicyV1
  events: RuntimeEventV1[]
  sequence: number
  outcome: RuntimeOutcomeV1 | null
  disconnected: boolean
  pendingPermissions: Map<string, PendingPermission>
  candidateDigest?: string
}

interface PendingPermission {
  challengeDigest: string
  allowOnceOptionId: string
  rejectOptionId?: string
  resolve: (value: AcpRequestPermissionResultV1) => void
  consumed: boolean
  consumedBy?: string
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

export function createKimiAcpRuntimeAdapterV1(options: KimiAcpRuntimeAdapterOptionsV1): AgentRuntimeAdapterV1 {
  return new KimiAcpRuntimeAdapterV1(options)
}

export class KimiAcpRuntimeAdapterV1 implements AgentRuntimeAdapterV1 {
  private readonly probe: KimiAcpProbeV1
  private readonly transportFactory: AcpTransportFactoryV1
  private readonly sessions = new Map<string, RuntimeSessionState>()
  private readonly idempotency = new Map<string, IdempotencyRecord>()
  private readonly permissionDecisions = new Map<string, PermissionDecisionRecord>()

  constructor(private readonly options: KimiAcpRuntimeAdapterOptionsV1) {
    this.probe = options.probe ?? new KimiAcpCliProbeV1()
    this.transportFactory = options.transportFactory ?? new KimiAcpProcessTransportFactoryV1()
  }

  async discover(): Promise<readonly RuntimeCapabilityV1[]> {
    return [await this.capability()]
  }

  async health(adapterId: AdapterIdV1 | string): Promise<RuntimeCapabilityV1> {
    if (adapterId !== ADAPTER_ID) return unavailable('RUNTIME_ADAPTER_NOT_FOUND')
    return this.capability()
  }

  async createOrResume(_request: RuntimeCreateOrResumeRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1> {
    return failed('runtime-unbound', 'RUNTIME_SELECTION_NOT_KIMI_ACP_TEST')
  }

  async createOrResumeForTest(request: KimiAcpCreateOrResumeForTestRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1> {
    const probe = await this.probe.findExecutable()
    if (!probe.available) return failed('runtime-unbound', probe.reasonCode)
    if (!selectionMatchesCandidate(request, kimiAcpCapabilityDigestForVersionV1(probe.version))) return failed('runtime-unbound', 'RUNTIME_SELECTION_NOT_KIMI_ACP_TEST')
    if (request.productionPolicy.rejectDiagnosticOnly !== true) return failed('runtime-unbound', 'RUNTIME_POLICY_INVALID')

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
      const envelope = await this.options.payloadResolver.resolvePrompt(request.promptEnvelopeRef)
      if (digestBytes(envelope.payloadBytes) !== request.promptEnvelopeRef.digest) return failed('runtime-unbound', 'PROMPT_DIGEST_MISMATCH')
      prompt = Buffer.from(envelope.payloadBytes).toString('utf8')
    } catch (error) {
      return failed('runtime-unbound', reasonFromError(error, 'RUNTIME_WORKSPACE_BINDING_FAILED'))
    }

    const transport = this.transportFactory.create(probe.command, ['acp'], workspace.rootPath)
    let state: RuntimeSessionState | null = null
    const requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>()
    requestHandlers.set('fs/read_text_file', (params) => {
      const result = policy.readTextFile(extractPath(params))
      return { content: result.content }
    })
    requestHandlers.set('fs/write_text_file', (params) => {
      const write = extractWrite(params)
      const result = policy.writeTextFile(write.path, write.content)
      if (state) {
        state.candidateDigest = result.candidateDigest
        pushEvent(state, { type: 'CANDIDATE_PRODUCED', runtimeSessionId: state.publicRuntimeSessionId, candidateDigest: result.candidateDigest })
      }
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
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
          clientInfo: CLIENT_INFO,
        },
        requestHandlers,
        onSessionUpdate: (params) => {
          if (state) handleSessionUpdate(state, params)
        },
        onPermissionRequest: (params) => (state ? this.handlePermissionRequest(state, params) : Promise.resolve({ outcome: { outcome: 'cancelled' } })),
        onDisconnect: (reasonCode) => {
          if (state) markDisconnected(state, reasonCode)
        },
      })
      const vendorSessionId = workspace.resumeSessionId ?? (await transport.newSession(workspace.rootPath)).sessionId
      if (!isSafeAcpOpaqueId(vendorSessionId)) {
        await transport.dispose()
        return failed('runtime-unbound', 'ACP_SESSION_ID_UNSAFE')
      }
      if (workspace.resumeSessionId) await transport.loadSession(vendorSessionId, workspace.rootPath)

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
        pendingPermissions: new Map(),
      }
      this.sessions.set(publicRuntimeSessionId, state)
      pushEvent(state, { type: 'SESSION_READY', runtimeSessionId: publicRuntimeSessionId })

      void transport.prompt(vendorSessionId, [{ type: 'text', text: prompt }]).then(
        (result) => settleFromPrompt(state!, result.stopReason),
        () => markUnknown(state!, 'PROCESS_DISCONNECTED'),
      )
      const outcome = { state: 'READY', runtimeSessionId: publicRuntimeSessionId } as const
      this.idempotency.set(idemKey, { payloadDigest, outcome })
      return outcome
    } catch (error) {
      await transport.dispose()
      const outcome = failed('runtime-unbound', reasonFromError(error, 'ACP_SESSION_START_FAILED'))
      this.idempotency.set(idemKey, { payloadDigest, outcome })
      return outcome
    }
  }

  async send(request: RuntimeSendRequestV1): Promise<{ accepted: true; requestId: string } | { accepted: false; reasonCode: string }> {
    const state = this.sessions.get(request.runtimeSessionId)
    if (!state) return { accepted: false, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    if (state.disconnected || state.outcome) return { accepted: false, reasonCode: terminalReason(state.outcome) ?? 'RUNTIME_NOT_RUNNING' }
    void state.transport.prompt(state.vendorSessionId, [{ type: 'text', text: `payload:${request.payloadDigest}` }]).then(
      (result) => settleFromPrompt(state, result.stopReason),
      () => markUnknown(state, 'PROCESS_DISCONNECTED'),
    )
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
    pending.consumed = true
    pending.consumedBy = decision.decisionRequestId
    if (decision.type === 'DENY') {
      pending.resolve(pending.rejectOptionId ? { outcome: { outcome: 'selected', optionId: pending.rejectOptionId } } : { outcome: { outcome: 'cancelled' } })
      const result = { accepted: true }
      this.permissionDecisions.set(decision.decisionRequestId, { decisionDigest, result })
      return result
    }
    pending.resolve({ outcome: { outcome: 'selected', optionId: pending.allowOnceOptionId } })
    const result = { accepted: true }
    this.permissionDecisions.set(decision.decisionRequestId, { decisionDigest, result })
    return result
  }

  async interrupt(request: RuntimeInterruptRequestV1): Promise<{ requested: true } | { requested: false; reasonCode: string }> {
    const state = this.sessions.get(request.runtimeSessionId)
    if (!state) return { requested: false, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    if (state.outcome && state.outcome.state !== 'OUTCOME_UNKNOWN') return { requested: false, reasonCode: 'RUNTIME_ALREADY_SETTLED' }
    await state.transport.cancel(state.vendorSessionId)
    markOutcome(state, { state: 'INTERRUPTED', runtimeSessionId: state.publicRuntimeSessionId, receiptDigest: digestJson({ interrupted: request.requestId }), reasonCode: 'USER_INTERRUPTED' })
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

  private async capability(): Promise<RuntimeCapabilityV1> {
    const probe = await this.probe.findExecutable()
    if (!probe.available) return unavailable(probe.reasonCode)
    return {
      adapterId: ADAPTER_ID,
      runtimeKind: 'KIMI',
      protocol: 'ACP',
      capabilityDigest: kimiAcpCapabilityDigestForVersionV1(probe.version),
      approvalStatus: 'APPROVED_FOR_TEST',
      health: 'AVAILABLE',
      canCreateSession: true,
      canResumeSession: true,
      stream: 'POLL',
      interrupt: 'BEST_EFFORT',
      inspect: 'RECONCILE',
      interactivePermission: 'HOST_MEDIATED',
      diagnosticOnly: false,
      reasonCode: probe.version ? `KIMI_${probe.version}` : undefined,
    }
  }

  private handlePermissionRequest(state: RuntimeSessionState, params: AcpRequestPermissionParamsV1): Promise<AcpRequestPermissionResultV1> {
    const options = Array.isArray(params.options) ? params.options : []
    const optionIds = options.map((option) => option.optionId)
    const optionsValid = optionIds.every((optionId) => typeof optionId === 'string' && optionId.length > 0 && optionId === optionId.trim()) && new Set(optionIds).size === optionIds.length
    const allowOnce = options.filter((option) => option.kind === 'allow_once')
    if (!optionsValid || allowOnce.length !== 1) {
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
    })
    return new Promise((resolve) => {
      state.pendingPermissions.set(permissionRequestId, { challengeDigest, allowOnceOptionId: allowOnce[0].optionId, rejectOptionId: rejectOnce?.optionId, resolve, consumed: false })
    })
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
  return digestJson({ adapterId: ADAPTER_ID, protocol: 'ACP', version: version ?? 'unknown', fs: 'host-mediated', terminal: 'host-deny' })
}

function selectionMatchesCandidate(request: KimiAcpCreateOrResumeForTestRequestV1, expectedCapabilityDigest: string): boolean {
  const candidate = request.selection
  return (
    request.selection.adapterId === ADAPTER_ID &&
    request.selection.protocol === 'ACP' &&
    request.selection.capabilityDigest === expectedCapabilityDigest &&
    candidate.approvalStatus === 'APPROVED_FOR_TEST'
  )
}

function handleSessionUpdate(state: RuntimeSessionState, params: { update?: { sessionUpdate?: string; content?: { text?: string }; kind?: string; title?: string } }): void {
  const update = params.update
  if (!update) return
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
    pushEvent(state, { type: 'TEXT_DELTA', runtimeSessionId: state.publicRuntimeSessionId, textDigest: digestJson(digestSafeText(update.content.text, 8000)) })
  } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    pushEvent(state, {
      type: 'TOOL_EVENT',
      runtimeSessionId: state.publicRuntimeSessionId,
      toolName: safeToolName(update.kind ?? update.title ?? 'tool'),
      eventDigest: digestJson(digestSafeText(JSON.stringify(update), 2000)),
    })
  }
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
  state.disconnected = true
  markOutcome(state, unknown(state.publicRuntimeSessionId, reasonCode))
}

function markDisconnected(state: RuntimeSessionState, reasonCode: string): void {
  if (state.disconnected) return
  state.disconnected = true
  for (const pending of state.pendingPermissions.values()) {
    if (!pending.consumed) pending.resolve({ outcome: { outcome: 'cancelled' } })
    pending.consumed = true
  }
  state.pendingPermissions.clear()
  markOutcome(state, unknown(state.publicRuntimeSessionId, reasonCode))
  void state.transport.dispose()
}

function markOutcome(state: RuntimeSessionState, outcome: RuntimeOutcomeV1): void {
  if (state.outcome) return
  state.outcome = outcome
  if (outcome.state === 'OUTCOME_UNKNOWN') {
    pushEvent(state, { type: 'OUTCOME_UNKNOWN', runtimeSessionId: state.publicRuntimeSessionId, reasonCode: outcome.reasonCode })
  } else {
    pushEvent(state, { type: 'RUNTIME_SETTLED', runtimeSessionId: state.publicRuntimeSessionId, outcome: outcome.state })
  }
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

function unavailable(reasonCode: string): RuntimeCapabilityV1 {
  return {
    adapterId: ADAPTER_ID,
    runtimeKind: 'KIMI',
    protocol: 'ACP',
    capabilityDigest: kimiAcpCapabilityDigestForVersionV1(undefined),
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

function reasonFromError(error: unknown, fallback: string): string {
  if (error instanceof KimiAcpWorkspacePolicyError) return error.reasonCode
  return fallback
}

function terminalReason(outcome: RuntimeOutcomeV1 | null): string | undefined {
  if (!outcome) return undefined
  return outcome.state === 'SUCCEEDED' ? undefined : outcome.reasonCode
}

function createIdempotencyKey(request: RuntimeCreateOrResumeRequestV1 | KimiAcpCreateOrResumeForTestRequestV1): string {
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
