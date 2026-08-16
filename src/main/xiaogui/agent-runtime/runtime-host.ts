import { createHash } from 'node:crypto'

import {
  isRuntimeSelectionAllowed,
  validateRuntimePublicDto,
  type AgentRuntimeAdapterV1,
  type RuntimeCreateOrResumeOutcomeV1,
  type RuntimeCreateOrResumeRequestV1,
  type RuntimeEventV1,
  type RuntimeInterruptRequestV1,
  type RuntimeOutcomeV1,
  type RuntimePermissionDecisionV1,
  type RuntimeScopeBindingV1,
  type RuntimeSendRequestV1,
} from '@shared/xiaogui-agent-runtime'

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
  const permissionRequests = new Map<string, PendingPermissionRequest>()

  const host: AgentRuntimeHostV1 = {
    discover: () => adapter.discover(),
    health: (adapterId) => adapter.health(adapterId),

    async createOrResume(request) {
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
      if ('runtimeSessionId' in outcome) {
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
      return adapter.send(request)
    },

    stream(runtimeSessionId, afterSequence) {
      return streamFromAdapter(adapter, permissionRequests, runtimeSessionId, afterSequence)
    },

    async permission(decision) {
      const existing = decisions.get(decision.decisionRequestId)
      if (existing) return existing.result

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
        decisions.set(decision.decisionRequestId, { result })
        return result
      }

      if (decision.type === 'ALLOW_ONCE') {
        const key = proofKey(decision)
        const consumedBy = consumedProofs.get(key)
        if (consumedBy && consumedBy !== decision.decisionRequestId) {
          const result = { accepted: false, reasonCode: 'PERMISSION_PROOF_REPLAYED' }
          decisions.set(decision.decisionRequestId, { proofKey: key, result })
          return result
        }
        consumedProofs.set(key, decision.decisionRequestId)
        const result = await adapter.permission(decision)
        decisions.set(decision.decisionRequestId, { proofKey: key, result })
        return result
      }

      const result = await adapter.permission(decision)
      decisions.set(decision.decisionRequestId, { result })
      return result
    },

    async interrupt(request) {
      if (!validateRuntimePublicDto(request).ok) return { requested: false, reasonCode: 'PUBLIC_DTO_LEAK' }
      const current = await adapter.inspect(request.runtimeSessionId)
      if (current.state === 'SUCCEEDED' || current.state === 'FAILED' || current.state === 'INTERRUPTED') {
        return { requested: false, reasonCode: 'RUNTIME_ALREADY_SETTLED' }
      }
      if (current.state === 'OUTCOME_UNKNOWN') return { requested: false, reasonCode: current.reasonCode }
      return adapter.interrupt(request)
    },

    async inspect(runtimeSessionId) {
      const outcome = await adapter.inspect(runtimeSessionId)
      return validateOutcome(runtimeSessionId, outcome)
    },

    async reconcile(runtimeSessionId, expectedReceiptDigest) {
      const outcome = await adapter.reconcile(runtimeSessionId, expectedReceiptDigest)
      return validateOutcome(runtimeSessionId, outcome)
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
  permissionRequests: Map<string, PendingPermissionRequest>,
  runtimeSessionId: string,
  afterSequence: number,
): AsyncIterable<RuntimeEventV1> {
  let expected = afterSequence + 1
  for await (const event of adapter.stream(runtimeSessionId, afterSequence)) {
    if (event.sequence <= afterSequence) continue
    if (event.sequence !== expected) {
      yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: expected, reasonCode: 'EVENT_SEQUENCE_GAP' }
      return
    }
    const publicDto = validateRuntimePublicDto(event)
    if (!publicDto.ok) {
      yield { type: 'OUTCOME_UNKNOWN', runtimeSessionId, sequence: expected, reasonCode: publicDto.reasonCode }
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
  const publicDto = validateRuntimePublicDto(outcome)
  if (!publicDto.ok) return { state: 'OUTCOME_UNKNOWN', runtimeSessionId, inspectHandleDigest: 'sha256:public-dto-leak', reasonCode: publicDto.reasonCode }
  return outcome
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
  return { state: 'FAILED', runtimeSessionId, receiptDigest: `sha256:${receipt}`, reasonCode }
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export type { RuntimeInterruptRequestV1, RuntimePermissionDecisionV1, RuntimeSendRequestV1 }
