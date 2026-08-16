import { createHash } from 'node:crypto'

import {
  isRuntimePublicSessionId,
  isRuntimeContractTestSelectionAllowed,
  isRuntimeSelectionAllowed,
  validateRuntimePublicDto,
  type AgentRuntimeContractTestAdapterV1,
  type AgentRuntimeAdapterV1,
  type RuntimeContractTestCreateOrResumeRequestV1,
  type RuntimeCapabilityV1,
  type RuntimeCreateOrResumeOutcomeV1,
  type RuntimeCreateOrResumeRequestV1,
  type RuntimeEventV1,
  type RuntimeInterruptRequestV1,
  type RuntimeOutcomeV1,
  type RuntimePermissionDecisionV1,
  type RuntimeScopeBindingV1,
  type RuntimeSendRequestV1,
} from '@shared/xiaogui-agent-runtime'

const UNBOUND_RUNTIME_SESSION_ID = 'runtime-unbound'

type RuntimeCreateRequestV1 = RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1
type RuntimeStreamAdapterV1 = Pick<AgentRuntimeAdapterV1, 'stream'>

interface RuntimeSessionBinding {
  attemptId: string
  attemptWorktreeId: string
  scope: RuntimeScopeBindingV1
}

interface IdempotencyRecord {
  payloadDigest: string
  outcome: RuntimeCreateOrResumeOutcomeV1
}

interface PermissionDecisionRecord {
  decisionDigest: string
  proofKey?: string
  result: { accepted: boolean; reasonCode?: string }
}

interface PendingPermissionRequest {
  challengeDigest: string
  runtimeSessionId: string
  scope: RuntimeScopeBindingV1
}

export interface AgentRuntimeHostV1 extends AgentRuntimeAdapterV1 {}
export interface AgentRuntimeContractTestHostV1 extends AgentRuntimeContractTestAdapterV1 {}

export function createAgentRuntimeHostV1(adapter: AgentRuntimeAdapterV1): AgentRuntimeHostV1 {
  return createRuntimeHostCore(adapter, validateProductionCreateRequest)
}

export function createAgentRuntimeContractTestHostV1(adapter: AgentRuntimeContractTestAdapterV1): AgentRuntimeContractTestHostV1 {
  return createRuntimeHostCore(adapter, validateContractTestCreateRequest)
}

interface RuntimeHostCoreAdapterV1<Request extends RuntimeCreateRequestV1> {
  discover(): Promise<readonly RuntimeCapabilityV1[]>
  health(adapterId: string): Promise<RuntimeCapabilityV1>
  createOrResume(request: Request): Promise<RuntimeCreateOrResumeOutcomeV1>
  send(request: RuntimeSendRequestV1): Promise<{ accepted: true; requestId: string } | { accepted: false; reasonCode: string }>
  stream(runtimeSessionId: string, afterSequence: number): AsyncIterable<RuntimeEventV1>
  permission(decision: RuntimePermissionDecisionV1): Promise<{ accepted: boolean; reasonCode?: string }>
  interrupt(request: RuntimeInterruptRequestV1): Promise<{ requested: true } | { requested: false; reasonCode: string }>
  inspect(runtimeSessionId: string): Promise<RuntimeOutcomeV1>
  reconcile(runtimeSessionId: string, expectedReceiptDigest?: string): Promise<RuntimeOutcomeV1>
}

function createRuntimeHostCore<Request extends RuntimeCreateRequestV1>(
  adapter: RuntimeHostCoreAdapterV1<Request>,
  validateCreateRequest: (request: Request) => RuntimeCreateValidationResult,
): RuntimeHostCoreAdapterV1<Request> {
  const idempotency = new Map<string, IdempotencyRecord>()
  const sessionBindings = new Map<string, RuntimeSessionBinding>()
  const decisions = new Map<string, PermissionDecisionRecord>()
  const consumedProofs = new Map<string, string>()
  const consumedPermissionRequests = new Map<string, string>()
  const permissionRequests = new Map<string, PendingPermissionRequest>()

  const host: RuntimeHostCoreAdapterV1<Request> = {
    async discover() {
      const capabilities = await safeCall(() => adapter.discover())
      if (!capabilities.ok) return [unavailableCapability('RUNTIME_ADAPTER_ERROR')]
      return capabilities.value.some((capability) => !validateRuntimePublicDto(capability).ok) ? [publicDtoLeakCapability()] : capabilities.value
    },

    async health(adapterId) {
      const capability = await safeCall(() => adapter.health(adapterId))
      if (!capability.ok) return unavailableCapability('RUNTIME_ADAPTER_ERROR')
      return validateRuntimePublicDto(capability.value).ok ? capability.value : publicDtoLeakCapability()
    },

    async createOrResume(request) {
      const validation = validateCreateRequest(request)
      if (!validation.ok) return validation.outcome

      const key = createIdempotencyKey(request)
      const payload = digestJson(request)
      const existing = idempotency.get(key)
      if (existing) {
        if (existing.payloadDigest !== payload) return failed('', 'IDEMPOTENCY_CONFLICT', 'idempotency-conflict')
        return existing.outcome
      }

      const created = await safeCall(() => adapter.createOrResume(request))
      if (!created.ok) {
        const rejected = unknown('', 'RUNTIME_ADAPTER_ERROR', 'runtime-adapter-error')
        idempotency.set(key, { payloadDigest: payload, outcome: rejected })
        return rejected
      }
      const outcome = created.value
      const publicOutcome = validateRuntimePublicDto(outcome)
      if (!publicOutcome.ok) {
        const rejected = unknown('runtimeSessionId' in outcome ? outcome.runtimeSessionId : '', publicOutcome.reasonCode, 'public-dto-leak')
        idempotency.set(key, { payloadDigest: payload, outcome: rejected })
        return rejected
      }

      if ('runtimeSessionId' in outcome) {
        if (!isRuntimePublicSessionId(outcome.runtimeSessionId)) {
          const rejected = unknown('', 'PUBLIC_DTO_LEAK', 'unsafe-runtime-session-id')
          idempotency.set(key, { payloadDigest: payload, outcome: rejected })
          return rejected
        }
        const mismatch = bindRuntimeSession(sessionBindings, outcome.runtimeSessionId, request)
        if (mismatch) {
          const rejected = failed('', mismatch, 'runtime-session-scope-mismatch')
          idempotency.set(key, { payloadDigest: payload, outcome: rejected })
          return rejected
        }
      }

      idempotency.set(key, { payloadDigest: payload, outcome })
      return outcome
    },

    async send(request) {
      if (!sessionBindings.has(request.runtimeSessionId)) return { accepted: false, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
      if (!validateRuntimePublicDto(request).ok) return { accepted: false, reasonCode: 'PUBLIC_DTO_LEAK' }
      const result = await safeCall(() => adapter.send(request))
      if (!result.ok) return { accepted: false, reasonCode: 'RUNTIME_ADAPTER_ERROR' }
      return validateRuntimePublicDto(result.value).ok ? result.value : { accepted: false, reasonCode: 'PUBLIC_DTO_LEAK' }
    },

    stream(runtimeSessionId, afterSequence) {
      return streamFromAdapter(adapter, sessionBindings, permissionRequests, runtimeSessionId, afterSequence)
    },

    async permission(decision) {
      const publicDecision = validateRuntimePublicDto(decision)
      if (!publicDecision.ok) return { accepted: false, reasonCode: publicDecision.reasonCode }

      const decisionDigest = digestJson(decision)
      const existing = decisions.get(decision.decisionRequestId)
      if (existing) {
        if (existing.decisionDigest !== decisionDigest) return { accepted: false, reasonCode: 'PERMISSION_DECISION_CONFLICT' }
        return existing.result
      }

      const binding = sessionBindings.get(decision.runtimeSessionId)
      const permissionRequest = permissionRequests.get(decision.permissionRequestId)
      if (
        !binding ||
        !permissionRequest ||
        permissionRequest.runtimeSessionId !== decision.runtimeSessionId ||
        permissionRequest.challengeDigest !== decision.challengeDigest ||
        !sameScope(binding.scope, decision.scope) ||
        !sameScope(permissionRequest.scope, decision.scope)
      ) {
        const result = { accepted: false, reasonCode: 'PERMISSION_SCOPE_MISMATCH' }
        decisions.set(decision.decisionRequestId, { decisionDigest, result })
        return result
      }

      const consumedBy = consumedPermissionRequests.get(decision.permissionRequestId)
      if (consumedBy && consumedBy !== decision.decisionRequestId) {
        const result = { accepted: false, reasonCode: 'PERMISSION_REQUEST_CONSUMED' }
        decisions.set(decision.decisionRequestId, { decisionDigest, result })
        return result
      }

      if (decision.type === 'ALLOW_ONCE') {
        const key = proofKey(decision)
        const proofConsumedBy = consumedProofs.get(key)
        if (proofConsumedBy && proofConsumedBy !== decision.decisionRequestId) {
          const result = { accepted: false, reasonCode: 'PERMISSION_PROOF_REPLAYED' }
          decisions.set(decision.decisionRequestId, { decisionDigest, proofKey: key, result })
          return result
        }
        consumedProofs.set(key, decision.decisionRequestId)
        const result = await safePermission(() => adapter.permission(decision))
        if (result.accepted) consumedPermissionRequests.set(decision.permissionRequestId, decision.decisionRequestId)
        decisions.set(decision.decisionRequestId, { decisionDigest, proofKey: key, result })
        return result
      }

      const result = await safePermission(() => adapter.permission(decision))
      if (result.accepted) consumedPermissionRequests.set(decision.permissionRequestId, decision.decisionRequestId)
      decisions.set(decision.decisionRequestId, { decisionDigest, result })
      return result
    },

    async interrupt(request) {
      if (!validateRuntimePublicDto(request).ok) return { requested: false, reasonCode: 'PUBLIC_DTO_LEAK' }
      if (!sessionBindings.has(request.runtimeSessionId)) return { requested: false, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }

      const inspected = await safeCall(() => adapter.inspect(request.runtimeSessionId))
      const current = inspected.ok ? validateOutcome(request.runtimeSessionId, inspected.value) : unknown(request.runtimeSessionId, 'RUNTIME_ADAPTER_ERROR', 'runtime-adapter-error')
      if (current.state === 'SUCCEEDED' || current.state === 'FAILED' || current.state === 'INTERRUPTED') {
        return { requested: false, reasonCode: 'RUNTIME_ALREADY_SETTLED' }
      }
      if (current.reasonCode !== 'RUNTIME_STILL_RUNNING') return { requested: false, reasonCode: current.reasonCode }

      const result = await safeCall(() => adapter.interrupt(request))
      if (!result.ok) return { requested: false, reasonCode: 'RUNTIME_ADAPTER_ERROR' }
      return validateRuntimePublicDto(result.value).ok ? result.value : { requested: false, reasonCode: 'PUBLIC_DTO_LEAK' }
    },

    async inspect(runtimeSessionId) {
      if (!sessionBindings.has(runtimeSessionId)) return unknown(runtimeSessionId, 'RUNTIME_SESSION_NOT_FOUND', 'session-not-found')
      const outcome = await safeCall(() => adapter.inspect(runtimeSessionId))
      return outcome.ok ? validateOutcome(runtimeSessionId, outcome.value) : unknown(runtimeSessionId, 'RUNTIME_ADAPTER_ERROR', 'runtime-adapter-error')
    },

    async reconcile(runtimeSessionId, expectedReceiptDigest) {
      if (!sessionBindings.has(runtimeSessionId)) return unknown(runtimeSessionId, 'RUNTIME_SESSION_NOT_FOUND', 'session-not-found')
      const outcome = await safeCall(() => adapter.reconcile(runtimeSessionId, expectedReceiptDigest))
      return outcome.ok ? validateOutcome(runtimeSessionId, outcome.value) : unknown(runtimeSessionId, 'RUNTIME_ADAPTER_ERROR', 'runtime-adapter-error')
    },
  }

  return host
}

type RuntimeCreateValidationResult = { ok: true } | { ok: false; outcome: RuntimeOutcomeV1 }

function validateProductionCreateRequest(request: RuntimeCreateOrResumeRequestV1): RuntimeCreateValidationResult {
  if (isContractTestCreateRequestShape(request)) {
    return { ok: false, outcome: failed('', 'RUNTIME_CONTRACT_TEST_REQUEST_NOT_ALLOWED', 'runtime-contract-test-request-not-allowed') }
  }
  const publicRequest = validateRuntimePublicDto(request)
  if (!publicRequest.ok) return { ok: false, outcome: unknown('', publicRequest.reasonCode, 'public-dto-leak') }
  const selection = isRuntimeSelectionAllowed(request.selection, request.productionPolicy)
  return selection.ok ? { ok: true } : { ok: false, outcome: failed('', selection.reasonCode, 'runtime-selection-rejected') }
}

function validateContractTestCreateRequest(request: RuntimeContractTestCreateOrResumeRequestV1): RuntimeCreateValidationResult {
  if (!isContractTestCreateRequestShape(request)) {
    return { ok: false, outcome: failed('', 'RUNTIME_CONTRACT_TEST_REQUEST_REQUIRED', 'runtime-contract-test-request-required') }
  }
  const publicRequest = validateRuntimePublicDto(request)
  if (!publicRequest.ok) return { ok: false, outcome: unknown('', publicRequest.reasonCode, 'public-dto-leak') }
  if (request.workspace.writePolicy !== request.contractTestPolicy.workspacePolicy) {
    return { ok: false, outcome: failed('', 'RUNTIME_CONTRACT_TEST_POLICY_INVALID', 'runtime-contract-test-policy-invalid') }
  }
  const selection = isRuntimeContractTestSelectionAllowed(request.selection, request.contractTestPolicy)
  return selection.ok ? { ok: true } : { ok: false, outcome: failed('', selection.reasonCode, 'runtime-contract-test-selection-rejected') }
}

function createIdempotencyKey(request: RuntimeCreateRequestV1): string {
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

function bindRuntimeSession(
  bindings: Map<string, RuntimeSessionBinding>,
  runtimeSessionId: string,
  request: RuntimeCreateRequestV1,
): string | null {
  const next = {
    attemptId: request.scope.attemptId,
    attemptWorktreeId: request.workspace.attemptWorktreeId,
    scope: request.scope,
  }
  const existing = bindings.get(runtimeSessionId)
  if (!existing) {
    bindings.set(runtimeSessionId, next)
    return null
  }
  if (existing.attemptId !== next.attemptId || existing.attemptWorktreeId !== next.attemptWorktreeId) {
    return 'RUNTIME_SESSION_SCOPE_MISMATCH'
  }
  return null
}

async function* streamFromAdapter(
  adapter: RuntimeStreamAdapterV1,
  bindings: Map<string, RuntimeSessionBinding>,
  permissionRequests: Map<string, PendingPermissionRequest>,
  runtimeSessionId: string,
  afterSequence: number,
): AsyncIterable<RuntimeEventV1> {
  if (!isRuntimePublicSessionId(runtimeSessionId)) {
    yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId: UNBOUND_RUNTIME_SESSION_ID, sequence: afterSequence + 1, reasonCode: 'PUBLIC_DTO_LEAK' }
    return
  }
  const binding = bindings.get(runtimeSessionId)
  if (!binding) {
    yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: afterSequence + 1, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    return
  }

  let expected = afterSequence + 1
  try {
    for await (const event of adapter.stream(runtimeSessionId, afterSequence)) {
      if (event.sequence <= afterSequence) continue
      const publicDto = validateRuntimePublicDto(event)
      if (!publicDto.ok) {
        yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: expected, reasonCode: publicDto.reasonCode }
        return
      }
      if (event.runtimeSessionId !== runtimeSessionId) {
        yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: expected, reasonCode: 'RUNTIME_EVENT_SESSION_MISMATCH' }
        return
      }
      if (event.sequence !== expected) {
        yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: expected, reasonCode: 'EVENT_SEQUENCE_GAP' }
        return
      }
      if (event.type === 'PERMISSION_REQUESTED') {
        if (!sameScope(binding.scope, event.scope)) {
          yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: expected, reasonCode: 'PERMISSION_SCOPE_MISMATCH' }
          return
        }
        permissionRequests.set(event.permissionRequestId, {
          challengeDigest: String(event.challengeDigest),
          runtimeSessionId: event.runtimeSessionId,
          scope: event.scope,
        })
      }
      yield event
      expected += 1
    }
  } catch {
    yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: expected, reasonCode: 'RUNTIME_ADAPTER_ERROR' }
  }
}

function validateOutcome(runtimeSessionId: string, outcome: RuntimeOutcomeV1): RuntimeOutcomeV1 {
  if (!isRuntimePublicSessionId(runtimeSessionId)) return unknown('', 'PUBLIC_DTO_LEAK', 'unsafe-runtime-session-id')
  const publicDto = validateRuntimePublicDto(outcome)
  if (!publicDto.ok) return unknown(runtimeSessionId, publicDto.reasonCode, 'public-dto-leak')
  if (outcome.runtimeSessionId !== runtimeSessionId) return unknown(runtimeSessionId, 'RUNTIME_OUTCOME_SESSION_MISMATCH', 'runtime-outcome-session-mismatch')
  return outcome
}

function isContractTestCreateRequestShape(value: unknown): value is RuntimeContractTestCreateOrResumeRequestV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { executionMode?: unknown }).executionMode === 'CONTRACT_TEST'
  )
}

function sanitizePermissionResult(result: { accepted: boolean; reasonCode?: string }): { accepted: boolean; reasonCode?: string } {
  return validateRuntimePublicDto(result).ok ? result : { accepted: false, reasonCode: 'PUBLIC_DTO_LEAK' }
}

async function safePermission(call: () => Promise<{ accepted: boolean; reasonCode?: string }>): Promise<{ accepted: boolean; reasonCode?: string }> {
  const result = await safeCall(call)
  return result.ok ? sanitizePermissionResult(result.value) : { accepted: false, reasonCode: 'RUNTIME_ADAPTER_ERROR' }
}

async function safeCall<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await call() }
  } catch {
    return { ok: false }
  }
}

function sameScope(left: RuntimeScopeBindingV1, right: RuntimeScopeBindingV1): boolean {
  return digestJson(left) === digestJson(right)
}

function proofKey(decision: Extract<RuntimePermissionDecisionV1, { type: 'ALLOW_ONCE' }>): string {
  return [
    decision.permissionRequestId,
    decision.challengeDigest,
    decision.runtimeSessionId,
    decision.proofId,
    decision.proofDigest,
    digestJson(decision.scope),
  ].join('|')
}

function failed(runtimeSessionId: string, reasonCode: string, receipt: string): RuntimeOutcomeV1 {
  return { state: 'FAILED', runtimeSessionId: safeRuntimeSessionId(runtimeSessionId), receiptDigest: `sha256:${receipt}`, reasonCode }
}

function unknown(runtimeSessionId: string, reasonCode: string, handle: string): RuntimeOutcomeV1 {
  return { state: 'OUTCOME_UNKNOWN', runtimeSessionId: safeRuntimeSessionId(runtimeSessionId), inspectHandleDigest: `sha256:${handle}`, reasonCode }
}

function safeRuntimeSessionId(runtimeSessionId: string): string {
  return isRuntimePublicSessionId(runtimeSessionId) ? runtimeSessionId : UNBOUND_RUNTIME_SESSION_ID
}

function publicDtoLeakCapability(): RuntimeCapabilityV1 {
  return unavailableCapability('PUBLIC_DTO_LEAK')
}

function unavailableCapability(reasonCode: string, adapterId = 'runtime-public-dto-leak'): RuntimeCapabilityV1 {
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

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export type { RuntimeInterruptRequestV1, RuntimePermissionDecisionV1, RuntimeSendRequestV1 }
