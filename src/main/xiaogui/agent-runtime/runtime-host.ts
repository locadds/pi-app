import { createHash } from 'node:crypto'

import {
  isRuntimePublicSessionId,
  isRuntimeSelectionAllowed,
  validateRuntimePublicDto,
  type AgentRuntimeAdapterV1,
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

export function createAgentRuntimeHostV1(adapter: AgentRuntimeAdapterV1): AgentRuntimeHostV1 {
  const idempotency = new Map<string, IdempotencyRecord>()
  const sessionBindings = new Map<string, RuntimeSessionBinding>()
  const decisions = new Map<string, PermissionDecisionRecord>()
  const consumedProofs = new Map<string, string>()
  const consumedPermissionRequests = new Map<string, string>()
  const permissionRequests = new Map<string, PendingPermissionRequest>()

  const host: AgentRuntimeHostV1 = {
    async discover() {
      const capabilities = await adapter.discover()
      return capabilities.some((capability) => !validateRuntimePublicDto(capability).ok) ? [publicDtoLeakCapability()] : capabilities
    },

    async health(adapterId) {
      const capability = await adapter.health(adapterId)
      return validateRuntimePublicDto(capability).ok ? capability : publicDtoLeakCapability()
    },

    async createOrResume(request) {
      const publicRequest = validateRuntimePublicDto(request)
      if (!publicRequest.ok) return unknown('', publicRequest.reasonCode, 'public-dto-leak')

      const selection = isRuntimeSelectionAllowed(request.selection, request.productionPolicy)
      if (!selection.ok) return failed('', selection.reasonCode, 'runtime-selection-rejected')

      const key = createIdempotencyKey(request)
      const payload = digestJson(request)
      const existing = idempotency.get(key)
      if (existing) {
        if (existing.payloadDigest !== payload) return failed('', 'IDEMPOTENCY_CONFLICT', 'idempotency-conflict')
        return existing.outcome
      }

      const outcome = await adapter.createOrResume(request)
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
      const result = await adapter.send(request)
      return validateRuntimePublicDto(result).ok ? result : { accepted: false, reasonCode: 'PUBLIC_DTO_LEAK' }
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
        const result = sanitizePermissionResult(await adapter.permission(decision))
        if (result.accepted) consumedPermissionRequests.set(decision.permissionRequestId, decision.decisionRequestId)
        decisions.set(decision.decisionRequestId, { decisionDigest, proofKey: key, result })
        return result
      }

      const result = sanitizePermissionResult(await adapter.permission(decision))
      if (result.accepted) consumedPermissionRequests.set(decision.permissionRequestId, decision.decisionRequestId)
      decisions.set(decision.decisionRequestId, { decisionDigest, result })
      return result
    },

    async interrupt(request) {
      if (!validateRuntimePublicDto(request).ok) return { requested: false, reasonCode: 'PUBLIC_DTO_LEAK' }
      if (!sessionBindings.has(request.runtimeSessionId)) return { requested: false, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }

      const current = validateOutcome(request.runtimeSessionId, await adapter.inspect(request.runtimeSessionId))
      if (current.state === 'SUCCEEDED' || current.state === 'FAILED' || current.state === 'INTERRUPTED') {
        return { requested: false, reasonCode: 'RUNTIME_ALREADY_SETTLED' }
      }
      if (current.reasonCode !== 'RUNTIME_STILL_RUNNING') return { requested: false, reasonCode: current.reasonCode }

      const result = await adapter.interrupt(request)
      return validateRuntimePublicDto(result).ok ? result : { requested: false, reasonCode: 'PUBLIC_DTO_LEAK' }
    },

    async inspect(runtimeSessionId) {
      if (!sessionBindings.has(runtimeSessionId)) return unknown(runtimeSessionId, 'RUNTIME_SESSION_NOT_FOUND', 'session-not-found')
      return validateOutcome(runtimeSessionId, await adapter.inspect(runtimeSessionId))
    },

    async reconcile(runtimeSessionId, expectedReceiptDigest) {
      if (!sessionBindings.has(runtimeSessionId)) return unknown(runtimeSessionId, 'RUNTIME_SESSION_NOT_FOUND', 'session-not-found')
      return validateOutcome(runtimeSessionId, await adapter.reconcile(runtimeSessionId, expectedReceiptDigest))
    },
  }

  return host
}

function createIdempotencyKey(request: RuntimeCreateOrResumeRequestV1): string {
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
  request: RuntimeCreateOrResumeRequestV1,
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
  adapter: AgentRuntimeAdapterV1,
  bindings: Map<string, RuntimeSessionBinding>,
  permissionRequests: Map<string, PendingPermissionRequest>,
  runtimeSessionId: string,
  afterSequence: number,
): AsyncIterable<RuntimeEventV1> {
  if (!isRuntimePublicSessionId(runtimeSessionId)) {
    yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId: UNBOUND_RUNTIME_SESSION_ID, sequence: afterSequence + 1, reasonCode: 'PUBLIC_DTO_LEAK' }
    return
  }
  if (!bindings.has(runtimeSessionId)) {
    yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: afterSequence + 1, reasonCode: 'RUNTIME_SESSION_NOT_FOUND' }
    return
  }

  let expected = afterSequence + 1
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
      permissionRequests.set(event.permissionRequestId, {
        challengeDigest: String(event.challengeDigest),
        runtimeSessionId: event.runtimeSessionId,
        scope: event.scope,
      })
    }
    yield event
    expected += 1
  }
}

function validateOutcome(runtimeSessionId: string, outcome: RuntimeOutcomeV1): RuntimeOutcomeV1 {
  if (!isRuntimePublicSessionId(runtimeSessionId)) return unknown('', 'PUBLIC_DTO_LEAK', 'unsafe-runtime-session-id')
  const publicDto = validateRuntimePublicDto(outcome)
  if (!publicDto.ok) return unknown(runtimeSessionId, publicDto.reasonCode, 'public-dto-leak')
  if (outcome.runtimeSessionId !== runtimeSessionId) return unknown(runtimeSessionId, 'RUNTIME_OUTCOME_SESSION_MISMATCH', 'runtime-outcome-session-mismatch')
  return outcome
}

function sanitizePermissionResult(result: { accepted: boolean; reasonCode?: string }): { accepted: boolean; reasonCode?: string } {
  return validateRuntimePublicDto(result).ok ? result : { accepted: false, reasonCode: 'PUBLIC_DTO_LEAK' }
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
  return {
    adapterId: 'runtime-public-dto-leak',
    runtimeKind: 'OTHER',
    protocol: 'NON_INTERACTIVE_CLI_DIAGNOSTIC',
    capabilityDigest: 'sha256:public-dto-leak',
    approvalStatus: 'DISCOVERED',
    health: 'UNAVAILABLE',
    canCreateSession: false,
    canResumeSession: false,
    stream: 'NONE',
    interrupt: 'NONE',
    inspect: 'NONE',
    interactivePermission: 'NONE',
    diagnosticOnly: true,
    reasonCode: 'PUBLIC_DTO_LEAK',
  }
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export type { RuntimeInterruptRequestV1, RuntimePermissionDecisionV1, RuntimeSendRequestV1 }
