import { createHash } from 'node:crypto'

import {
  isRuntimeSelectionAllowed,
  runtimeSelectionKey,
  validateRuntimeProductionCreateRequestShapeV1,
} from '@shared/xiaogui-agent-runtime'
import type {
  AdapterIdV1,
  AgentRuntimeAdapterV1,
  RuntimeAdapterSelectionV1,
  RuntimeCapabilityV1,
  RuntimeCapabilityV2,
  RuntimeCreateOrResumeOutcomeV1,
  RuntimeCreateOrResumeRequestV1,
  RuntimeEventV1,
  RuntimeInterruptRequestV1,
  RuntimeOutcomeV1,
  RuntimePermissionDecisionV1,
  RuntimeRouteFailureReasonV1,
  RuntimeSendRequestV1,
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'

const CODEX_ADAPTER_ID = 'codex-headless' as AdapterIdV1

export interface CodexHeadlessProbeV1 {
  findExecutable(): Promise<{ available: true; version: string } | { available: false; reasonCode: string }>
}

export interface CodexHeadlessWorkspaceResolverV1 {
  resolve(request: RuntimeCreateOrResumeRequestV1): Promise<{ rootPath: string; resumeSessionId?: string }>
  /** Resolves the approved attempt worktree at recovery time; callers must not persist its path in public DTOs. */
  restore(runtimeSessionId: string): Promise<{ rootPath: string }>
}

export interface CodexHeadlessDriverEventV1 {
  type: 'TEXT' | 'TOOL' | 'SETTLED'
  text?: string
  toolName?: string
  outcome?: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED'
}

export interface CodexHeadlessDriverSessionV1 {
  vendorSessionId: string
  events(): readonly CodexHeadlessDriverEventV1[]
  interrupt(): Promise<boolean>
  outcome(): Promise<'UNKNOWN' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED'>
  candidateDigest(): Promise<string | null>
  close(): Promise<void>
}

export interface CodexHeadlessDriverV1 {
  /** True only when a restored thread can be inspected without issuing a new model turn. */
  readonly supportsCrossProcessResultReconcile: boolean
  start(input: { rootPath: string; prompt: string; resumeSessionId?: string }): Promise<CodexHeadlessDriverSessionV1>
  /** Restores only the local handle; the next send uses `codex exec resume`. */
  restore(input: { rootPath: string; vendorSessionId: string }): Promise<CodexHeadlessDriverSessionV1>
}

export interface CodexHeadlessBindingStoreV1 {
  /** Must mean the mapping survives an application process restart. */
  readonly durable: boolean
  write(binding: { publicSessionId: string; vendorSessionId: string }): Promise<void>
  read(publicSessionId: string): Promise<{ vendorSessionId: string } | null>
}

export interface CodexHeadlessAdapterOptionsV1 {
  payloadResolver: TrustedRuntimePayloadResolverV1
  workspaceResolver: CodexHeadlessWorkspaceResolverV1
  probe: CodexHeadlessProbeV1
  driver: CodexHeadlessDriverV1
  /** Private main-process storage; it must never contain prompts or worktree paths. */
  bindingStore?: CodexHeadlessBindingStoreV1
  productionGate?: { enabled: true; approvedVersion: string; selection: RuntimeAdapterSelectionV1 }
}

interface SessionStateV1 {
  publicSessionId: string
  driver: CodexHeadlessDriverSessionV1
  rootPath: string
  events: RuntimeEventV1[]
  observedDriverEvents: number
}

export function createCodexHeadlessRuntimeAdapterV1(options: CodexHeadlessAdapterOptionsV1): AgentRuntimeAdapterV1 {
  return new CodexHeadlessRuntimeAdapterV1(options)
}

class CodexHeadlessRuntimeAdapterV1 implements AgentRuntimeAdapterV1 {
  private readonly sessions = new Map<string, SessionStateV1>()
  private closed = false

  constructor(private readonly options: CodexHeadlessAdapterOptionsV1) {}

  async discover(): Promise<readonly RuntimeCapabilityV1[]> { return [await this.capability()] }

  async health(adapterId: AdapterIdV1 | string): Promise<RuntimeCapabilityV1> {
    return adapterId === CODEX_ADAPTER_ID ? this.capability() : unavailable(adapterId, 'RUNTIME_ADAPTER_NOT_FOUND')
  }

  async createOrResume(request: RuntimeCreateOrResumeRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1> {
    if (this.closed) return failed('runtime-unbound', 'CODEX_ADAPTER_CLOSED')
    const shape = validateRuntimeProductionCreateRequestShapeV1(request)
    if (!shape.ok) return failed('runtime-unbound', shape.reasonCode)
    const gate = this.options.productionGate
    if (!gate?.enabled) return failed('runtime-unbound', 'CODEX_PRODUCTION_DISABLED')
    if (!this.productionLifecycleSupported()) return failed('runtime-unbound', 'CODEX_RECOVERY_UNAVAILABLE')
    const allowed = isRuntimeSelectionAllowed(request.selection, request.productionPolicy)
    if (!allowed.ok) return failed('runtime-unbound', allowed.reasonCode)
    const probe = await this.options.probe.findExecutable()
    if (!probe.available) return failed('runtime-unbound', probe.reasonCode)
    if (probe.version !== gate.approvedVersion) return failed('runtime-unbound', 'CODEX_VERSION_UNAPPROVED')
    if (!sameSelection(request.selection, gate.selection, capabilityDigest(probe.version))) {
      return failed('runtime-unbound', 'CODEX_PRODUCTION_SELECTION_MISMATCH')
    }

    try {
      const [workspace, envelope] = await Promise.all([
        this.options.workspaceResolver.resolve(request),
        this.options.payloadResolver.resolvePrompt(request.promptEnvelopeRef),
      ])
      if (sha256(envelope.payloadBytes) !== request.promptEnvelopeRef.digest) {
        return failed('runtime-unbound', 'PROMPT_DIGEST_MISMATCH')
      }
      const driver = await this.options.driver.start({
        rootPath: workspace.rootPath,
        prompt: Buffer.from(envelope.payloadBytes).toString('utf8'),
        resumeSessionId: workspace.resumeSessionId,
      })
      const publicSessionId = publicSessionIdForVendor(driver.vendorSessionId, request.scope.attemptDigest)
      try {
        await this.options.bindingStore!.write({ publicSessionId, vendorSessionId: driver.vendorSessionId })
      } catch (error) {
        await driver.close().catch(() => undefined)
        throw error
      }
      this.sessions.set(publicSessionId, {
        publicSessionId,
        driver,
        rootPath: workspace.rootPath,
        events: [{ type: 'SESSION_READY', runtimeSessionId: publicSessionId, sequence: 1 }],
        observedDriverEvents: 0,
      })
      return { state: 'READY', runtimeSessionId: publicSessionId }
    } catch {
      return failed('runtime-unbound', 'CODEX_SESSION_START_FAILED')
    }
  }

  async restoreRuntimeSession(runtimeSessionId: string): Promise<
    { ok: true } | { ok: false; reasonCode: RuntimeRouteFailureReasonV1 }
  > {
    if (this.closed) return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
    if (this.sessions.has(runtimeSessionId)) return { ok: true }
    if (!this.recoverySupported()) {
      return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
    }
    try {
      const binding = await this.options.bindingStore!.read(runtimeSessionId)
      const vendorSessionId = binding?.vendorSessionId
      if (!vendorSessionId || !isSafeVendorSessionId(vendorSessionId)) {
        return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
      }
      const workspace = await this.options.workspaceResolver.restore(runtimeSessionId)
      const driver = await this.options.driver.restore({ rootPath: workspace.rootPath, vendorSessionId })
      if (driver.vendorSessionId !== vendorSessionId) {
        await driver.close().catch(() => undefined)
        return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
      }
      this.sessions.set(runtimeSessionId, {
        publicSessionId: runtimeSessionId,
        driver,
        rootPath: workspace.rootPath,
        events: [{ type: 'SESSION_READY', runtimeSessionId, sequence: 1 }],
        observedDriverEvents: 0,
      })
      return { ok: true }
    } catch {
      return { ok: false, reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE' }
    }
  }

  async send(request: RuntimeSendRequestV1) {
    const state = this.sessions.get(request.runtimeSessionId)
    if (!state) return { accepted: false as const, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    if (await state.driver.outcome() === 'RUNNING') return { accepted: false as const, reasonCode: 'RUNTIME_STILL_RUNNING' }
    try {
      const envelope = await this.options.payloadResolver.resolveMessage(request.messageEnvelopeRef)
      if (sha256(envelope.payloadBytes) !== request.messageEnvelopeRef.digest) {
        return { accepted: false as const, reasonCode: 'MESSAGE_DIGEST_MISMATCH' }
      }
      const next = await this.options.driver.start({
        rootPath: state.rootPath,
        prompt: Buffer.from(envelope.payloadBytes).toString('utf8'),
        resumeSessionId: state.driver.vendorSessionId,
      })
      await state.driver.close().catch(() => undefined)
      state.driver = next
      state.observedDriverEvents = 0
      return { accepted: true as const, requestId: request.requestId }
    } catch {
      return { accepted: false as const, reasonCode: 'CODEX_FOLLOW_UP_FAILED' }
    }
  }

  async *stream(runtimeSessionId: string, afterSequence: number): AsyncIterable<RuntimeEventV1> {
    const state = this.sessions.get(runtimeSessionId)
    if (!state) {
      yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: afterSequence + 1, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
      return
    }
    this.captureDriverEvents(state)
    for (const event of state.events) if (event.sequence > afterSequence) yield event
  }

  async permission(_decision: RuntimePermissionDecisionV1) {
    return { accepted: false, reasonCode: 'CODEX_HOST_PERMISSION_NOT_SUPPORTED' }
  }

  async interrupt(request: RuntimeInterruptRequestV1) {
    const state = this.sessions.get(request.runtimeSessionId)
    if (!state) return { requested: false as const, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    return await state.driver.interrupt()
      ? { requested: true as const }
      : { requested: false as const, reasonCode: 'CODEX_INTERRUPT_FAILED' }
  }

  async inspect(runtimeSessionId: string): Promise<RuntimeOutcomeV1> {
    const state = this.sessions.get(runtimeSessionId)
    if (!state) return unknown(runtimeSessionId, 'RUNTIME_SESSION_NOT_FOUND')
    this.captureDriverEvents(state)
    const outcome = await state.driver.outcome()
    if (outcome === 'UNKNOWN') return unknown(runtimeSessionId, 'CODEX_RESTORED_OUTCOME_UNKNOWN')
    if (outcome === 'RUNNING') return unknown(runtimeSessionId, 'RUNTIME_STILL_RUNNING')
    const receiptDigest = sha256Text(`${runtimeSessionId}|${outcome}`)
    if (outcome === 'SUCCEEDED') {
      const candidateDigest = await state.driver.candidateDigest()
      if (!candidateDigest) return unknown(runtimeSessionId, 'CODEX_CANDIDATE_DIGEST_UNAVAILABLE')
      return {
        state: 'SUCCEEDED',
        runtimeSessionId,
        receiptDigest,
        candidateDigest,
      }
    }
    return outcome === 'INTERRUPTED'
      ? { state: 'INTERRUPTED', runtimeSessionId, receiptDigest, reasonCode: 'CODEX_INTERRUPTED' }
      : { state: 'FAILED', runtimeSessionId, receiptDigest, reasonCode: 'CODEX_EXEC_FAILED' }
  }

  async reconcile(runtimeSessionId: string, expectedReceiptDigest?: string): Promise<RuntimeOutcomeV1> {
    const outcome = await this.inspect(runtimeSessionId)
    if (expectedReceiptDigest && 'receiptDigest' in outcome && outcome.receiptDigest !== expectedReceiptDigest) {
      return unknown(runtimeSessionId, 'RUNTIME_RECEIPT_DIGEST_MISMATCH')
    }
    return outcome
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.all([...this.sessions.values()].map((state) => state.driver.close().catch(() => undefined)))
    this.sessions.clear()
  }

  private async capability(): Promise<RuntimeCapabilityV2> {
    const gate = this.options.productionGate
    const probe = await this.options.probe.findExecutable()
    const version = probe.available ? probe.version : 'unknown'
    const approved = Boolean(
      gate?.enabled && probe.available && this.productionLifecycleSupported() && gate.approvedVersion === version &&
      runtimeSelectionKey(gate.selection) === runtimeSelectionKey(codexHeadlessSelectionV1(version)),
    )
    return {
      adapterId: CODEX_ADAPTER_ID,
      runtimeKind: 'CODEX',
      protocol: 'HEADLESS',
      capabilityDigest: capabilityDigest(version),
      approvalStatus: approved ? 'APPROVED_FOR_PRODUCTION' : 'APPROVED_FOR_TEST',
      health: probe.available ? 'AVAILABLE' : 'UNAVAILABLE',
      canCreateSession: probe.available,
      canResumeSession: probe.available && this.recoverySupported(),
      stream: 'POLL',
      interrupt: 'BEST_EFFORT',
      inspect: this.options.driver.supportsCrossProcessResultReconcile ? 'RECONCILE' : 'SNAPSHOT',
      interactivePermission: 'NONE',
      diagnosticOnly: false,
      reasonCode: probe.available ? undefined : probe.reasonCode,
      version: 2,
      runtimeVersion: version,
      capabilitySummary: '小规 CODING 任务的 Codex 无交互运行时（需显式批准）',
      workModes: ['CODING'],
      taskCapabilities: ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT', 'EXECUTION.EXTERNAL_ALLOWED'],
      executionLocation: 'EXTERNAL',
      requiresDataEgress: true,
      supportsResume: this.recoverySupported(),
      supportsEventStream: true,
      supportsInterrupt: true,
      supportsResultReconcile: this.options.driver.supportsCrossProcessResultReconcile,
    }
  }

  private recoverySupported(): boolean {
    return Boolean(
      this.options.bindingStore?.durable &&
      typeof this.options.bindingStore.read === 'function' &&
      typeof this.options.bindingStore.write === 'function' &&
      typeof this.options.workspaceResolver.restore === 'function' &&
      typeof this.options.driver.restore === 'function',
    )
  }

  private productionLifecycleSupported(): boolean {
    return this.recoverySupported() && this.options.driver.supportsCrossProcessResultReconcile
  }

  private captureDriverEvents(state: SessionStateV1): void {
    const driverEvents = state.driver.events()
    for (const event of driverEvents.slice(state.observedDriverEvents)) {
      const sequence = state.events.length + 1
      if (event.type === 'TEXT') {
        state.events.push({ type: 'TEXT_DELTA', runtimeSessionId: state.publicSessionId, sequence, textDigest: sha256Text(event.text ?? '') })
      } else if (event.type === 'TOOL') {
        state.events.push({
          type: 'TOOL_EVENT',
          runtimeSessionId: state.publicSessionId,
          sequence,
          toolName: safeToolName(event.toolName),
          eventDigest: sha256Text(JSON.stringify(event)),
        })
      } else if (event.outcome) {
        state.events.push({ type: 'RUNTIME_SETTLED', runtimeSessionId: state.publicSessionId, sequence, outcome: event.outcome })
      }
    }
    state.observedDriverEvents = driverEvents.length
  }
}

function sameSelection(left: RuntimeAdapterSelectionV1, right: RuntimeAdapterSelectionV1, digest: string): boolean {
  return left.capabilityDigest === digest && right.capabilityDigest === digest && runtimeSelectionKey(left) === runtimeSelectionKey(right)
}

export function codexHeadlessSelectionV1(version: string): RuntimeAdapterSelectionV1 {
  return {
    adapterId: CODEX_ADAPTER_ID,
    runtimeKind: 'CODEX',
    protocol: 'HEADLESS',
    capabilityDigest: capabilityDigest(version),
    approvalStatus: 'APPROVED_FOR_PRODUCTION',
    diagnosticOnly: false,
    stream: 'POLL',
    interrupt: 'BEST_EFFORT',
    inspect: 'RECONCILE',
  }
}

function capabilityDigest(version: string): string { return sha256Text(`xiaogui-codex-headless-v1|${version}`) }
function safeToolName(value: string | undefined): string { return (value ?? 'codex-tool').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'codex-tool' }
function sha256(bytes: Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
function hex(value: string): string { return createHash('sha256').update(value).digest('hex') }
function sha256Text(value: string): string { return `sha256:${hex(value)}` }

function publicSessionIdForVendor(vendorSessionId: string, attemptDigest: string): string {
  if (!isSafeVendorSessionId(vendorSessionId)) throw new Error('CODEX_THREAD_ID_INVALID')
  return `codex_${hex(`${vendorSessionId}|${attemptDigest}`).slice(0, 32)}`
}

function isSafeVendorSessionId(vendorSessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(vendorSessionId)
}

function unavailable(adapterId: AdapterIdV1 | string, reasonCode: string): RuntimeCapabilityV1 {
  return {
    adapterId, runtimeKind: 'OTHER', protocol: 'NON_INTERACTIVE_CLI_DIAGNOSTIC', capabilityDigest: sha256Text(reasonCode),
    approvalStatus: 'DISCOVERED', health: 'UNAVAILABLE', canCreateSession: false, canResumeSession: false,
    stream: 'NONE', interrupt: 'NONE', inspect: 'NONE', interactivePermission: 'NONE', diagnosticOnly: true, reasonCode,
  }
}
function failed(runtimeSessionId: string, reasonCode: string): RuntimeOutcomeV1 {
  return { state: 'FAILED', runtimeSessionId, receiptDigest: sha256Text(reasonCode), reasonCode }
}
function unknown(runtimeSessionId: string, reasonCode: string): RuntimeOutcomeV1 {
  return { state: 'OUTCOME_UNKNOWN', runtimeSessionId, inspectHandleDigest: sha256Text(reasonCode), reasonCode }
}
