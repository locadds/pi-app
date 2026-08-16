export type AdapterIdV1 = string & { readonly __brand: 'AdapterIdV1' }
export type RuntimeKindV1 = 'KIMI' | 'QODER' | 'OTHER'
export type RuntimeProtocolV1 =
  | 'ACP'
  | 'HEADLESS'
  | 'SDK'
  | 'REMOTE_CONTROL'
  | 'CLOUD_REMOTE'
  | 'NON_INTERACTIVE_CLI_DIAGNOSTIC'
export type AdapterHealthV1 = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE'
export type RuntimeApprovalStatusV1 = 'DISCOVERED' | 'APPROVED_FOR_TEST' | 'APPROVED_FOR_PRODUCTION' | 'REJECTED'
export type RuntimeSessionStateV1 = 'READY' | 'RUNNING' | 'INTERRUPT_REQUESTED' | 'SETTLED' | 'OUTCOME_UNKNOWN'
export type RuntimeRefIdV1 = string & { readonly __brand: 'RuntimeRefIdV1' }
export type RuntimeDigestV1 = string & { readonly __brand: 'RuntimeDigestV1' }

export interface RuntimeCapabilityV1 {
  adapterId: AdapterIdV1 | string
  runtimeKind: RuntimeKindV1
  protocol: RuntimeProtocolV1
  capabilityDigest: RuntimeDigestV1 | string
  approvalStatus: RuntimeApprovalStatusV1
  health: AdapterHealthV1
  canCreateSession: boolean
  canResumeSession: boolean
  stream: 'NONE' | 'POLL' | 'PUSH'
  interrupt: 'NONE' | 'BEST_EFFORT' | 'ACKED'
  inspect: 'NONE' | 'SNAPSHOT' | 'RECONCILE'
  interactivePermission: 'NONE' | 'HOST_MEDIATED' | 'RUNTIME_NATIVE'
  diagnosticOnly: boolean
  reasonCode?: string
}

export interface RuntimeAdapterSelectionV1 {
  adapterId: AdapterIdV1 | string
  runtimeKind: RuntimeKindV1
  protocol: RuntimeProtocolV1
  capabilityDigest: RuntimeDigestV1 | string
  approvalStatus: 'APPROVED_FOR_PRODUCTION'
  diagnosticOnly: false
  stream: 'POLL' | 'PUSH'
  interrupt: 'BEST_EFFORT' | 'ACKED'
  inspect: 'SNAPSHOT' | 'RECONCILE'
}

export interface RuntimeProductionPolicyV1 {
  allowedSelections: readonly RuntimeAdapterSelectionV1[]
  rejectDiagnosticOnly: true
}

export interface RuntimeScopeBindingV1 {
  projectId: string
  sessionKey: string
  sessionMode: 'CODING'
  flowId: string
  taskRunId: string
  attemptId: string
  attemptDigest: string
  workspaceReceiptId: string
  workspaceReceiptDigest: string
}

export interface RuntimeWorkspaceBindingV1 {
  attemptWorktreeId: string
  worktreeRootDigest: string
  baseRevisionDigest: string
  targetProjectRootDigest: string
  writePolicy: 'ATTEMPT_WORKTREE_ONLY'
}

export interface PromptEnvelopeRefV1 {
  refId: RuntimeRefIdV1 | string
  digest: RuntimeDigestV1 | string
  mediaType: 'application/vnd.xiaogui.runtime-prompt+json'
}

export interface RuntimeTextStreamRefV1 {
  refId: RuntimeRefIdV1 | string
  digest: RuntimeDigestV1 | string
}

export interface RuntimeCandidateFileRefV1 {
  refId: RuntimeRefIdV1 | string
  digest: RuntimeDigestV1 | string
  purpose: 'TASK_CHANGESET_CANDIDATE'
}

export interface RuntimePromptEnvelopeV1 {
  promptEnvelopeRef: PromptEnvelopeRefV1
  redactedPreviewDigest: RuntimeDigestV1 | string
  payloadBytes: Uint8Array
}

export interface RuntimeCandidateFileSnapshotV1 {
  candidateFileRef: RuntimeCandidateFileRefV1
  relativePathDigest: RuntimeDigestV1 | string
  contentDigest: RuntimeDigestV1 | string
  payloadBytes: Uint8Array
}

export interface M2ChangeSetCandidateInputV1 {
  candidateDigest: RuntimeDigestV1 | string
  candidateFileRefs: readonly RuntimeCandidateFileRefV1[]
  evidenceDigest: RuntimeDigestV1 | string
}

export interface TrustedRuntimePayloadResolverV1 {
  resolvePrompt(ref: PromptEnvelopeRefV1): Promise<RuntimePromptEnvelopeV1>
  resolveTextStream(ref: RuntimeTextStreamRefV1): AsyncIterable<Uint8Array>
  resolveCandidateFile(ref: RuntimeCandidateFileRefV1): Promise<RuntimeCandidateFileSnapshotV1>
  toM2ChangeSetCandidate(input: M2ChangeSetCandidateInputV1): Promise<{ changeSetCandidateId: string; digest: RuntimeDigestV1 | string }>
}

export interface RuntimeCreateOrResumeRequestV1 {
  requestId: string
  scope: RuntimeScopeBindingV1
  workspace: RuntimeWorkspaceBindingV1
  selection: RuntimeAdapterSelectionV1
  productionPolicy: RuntimeProductionPolicyV1
  promptEnvelopeRef: PromptEnvelopeRefV1
  resumeTokenDigest?: RuntimeDigestV1 | string
}

export type RuntimePermissionDecisionV1 =
  | {
      type: 'ALLOW_ONCE'
      permissionRequestId: string
      challengeDigest: RuntimeDigestV1 | string
      decisionRequestId: string
      scope: RuntimeScopeBindingV1
      runtimeSessionId: string
      proofId: string
      proofDigest: RuntimeDigestV1 | string
    }
  | {
      type: 'DENY'
      permissionRequestId: string
      challengeDigest: RuntimeDigestV1 | string
      decisionRequestId: string
      scope: RuntimeScopeBindingV1
      runtimeSessionId: string
      reasonCode: string
    }

export interface RuntimePermissionRequestV1 {
  permissionRequestId: string
  runtimeSessionId: string
  scope: RuntimeScopeBindingV1
  sequence: number
  challengeDigest: RuntimeDigestV1 | string
  decisionRequired: 'ALLOW_ONCE_OR_DENY'
}

export interface RuntimeSendRequestV1 {
  requestId: string
  runtimeSessionId: string
  messageKind: 'TASK_INPUT' | 'GUIDANCE'
  payloadDigest: string
}

export interface RuntimeInterruptRequestV1 {
  requestId: string
  runtimeSessionId: string
  reason: string
}

export type RuntimeEventV1 =
  | { type: 'SESSION_READY'; runtimeSessionId: string; sequence: number }
  | { type: 'TEXT_DELTA'; runtimeSessionId: string; sequence: number; textDigest: string }
  | { type: 'TOOL_EVENT'; runtimeSessionId: string; sequence: number; toolName: string; eventDigest: string }
  | ({ type: 'PERMISSION_REQUESTED' } & RuntimePermissionRequestV1)
  | { type: 'CANDIDATE_PRODUCED'; runtimeSessionId: string; sequence: number; candidateDigest: string }
  | { type: 'RUNTIME_SETTLED'; runtimeSessionId: string; sequence: number; outcome: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED' }
  | { type: 'OUTCOME_UNKNOWN'; runtimeSessionId: string; sequence: number; reasonCode: string }

export type RuntimeOutcomeV1 =
  | { state: 'SUCCEEDED'; runtimeSessionId: string; receiptDigest: string; candidateDigest: string }
  | { state: 'FAILED'; runtimeSessionId: string; receiptDigest: string; reasonCode: string }
  | { state: 'INTERRUPTED'; runtimeSessionId: string; receiptDigest: string; reasonCode: string }
  | { state: 'OUTCOME_UNKNOWN'; runtimeSessionId: string; inspectHandleDigest: string; reasonCode: string }

export type RuntimeCreateOrResumeOutcomeV1 = RuntimeOutcomeV1 | { state: 'READY'; runtimeSessionId: string }

export interface AgentRuntimeAdapterV1 {
  discover(): Promise<readonly RuntimeCapabilityV1[]>
  health(adapterId: AdapterIdV1 | string): Promise<RuntimeCapabilityV1>
  createOrResume(request: RuntimeCreateOrResumeRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1>
  send(request: RuntimeSendRequestV1): Promise<{ accepted: true; requestId: string } | { accepted: false; reasonCode: string }>
  stream(runtimeSessionId: string, afterSequence: number): AsyncIterable<RuntimeEventV1>
  permission(decision: RuntimePermissionDecisionV1): Promise<{ accepted: boolean; reasonCode?: string }>
  interrupt(request: RuntimeInterruptRequestV1): Promise<{ requested: true } | { requested: false; reasonCode: string }>
  inspect(runtimeSessionId: string): Promise<RuntimeOutcomeV1>
  reconcile(runtimeSessionId: string, expectedReceiptDigest?: string): Promise<RuntimeOutcomeV1>
}

export type RuntimeValidationResultV1 = { ok: true } | { ok: false; reasonCode: string }

export function isRuntimeSelectionAllowed(
  selection: RuntimeAdapterSelectionV1 | RuntimeCapabilityV1,
  policy: RuntimeProductionPolicyV1,
): RuntimeValidationResultV1 {
  if (selection.protocol === 'NON_INTERACTIVE_CLI_DIAGNOSTIC') return { ok: false, reasonCode: 'RUNTIME_DIAGNOSTIC_PROTOCOL' }
  if (selection.diagnosticOnly && policy.rejectDiagnosticOnly) return { ok: false, reasonCode: 'RUNTIME_DIAGNOSTIC_ONLY' }
  if (selection.approvalStatus !== 'APPROVED_FOR_PRODUCTION') return { ok: false, reasonCode: 'RUNTIME_SELECTION_NOT_APPROVED' }
  if (selection.stream === 'NONE') return { ok: false, reasonCode: 'RUNTIME_STREAM_UNAVAILABLE' }
  if (selection.interrupt === 'NONE') return { ok: false, reasonCode: 'RUNTIME_INTERRUPT_UNAVAILABLE' }
  if (selection.inspect === 'NONE') return { ok: false, reasonCode: 'RUNTIME_INSPECT_UNAVAILABLE' }

  const allowed = policy.allowedSelections.some((candidate) => runtimeSelectionKey(candidate) === runtimeSelectionKey(selection))
  return allowed ? { ok: true } : { ok: false, reasonCode: 'RUNTIME_SELECTION_NOT_APPROVED' }
}

export function runtimeSelectionKey(selection: RuntimeAdapterSelectionV1 | RuntimeCapabilityV1): string {
  return [
    selection.adapterId,
    selection.runtimeKind,
    selection.protocol,
    selection.capabilityDigest,
    selection.approvalStatus,
    selection.diagnosticOnly,
    selection.stream,
    selection.interrupt,
    selection.inspect,
  ].join('|')
}

export function validateRuntimePublicDto(value: unknown): RuntimeValidationResultV1 {
  return scanPublicDto(value) ? { ok: false, reasonCode: 'PUBLIC_DTO_LEAK' } : { ok: true }
}

export function isRuntimePublicSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !isSensitivePublicString(value)
}

function scanPublicDto(value: unknown, key?: string): boolean {
  if (value == null) return false
  if (typeof value === 'string') {
    if (key === 'runtimeSessionId' && !isRuntimePublicSessionId(value)) return true
    return isSensitivePublicString(value)
  }
  if (typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((nested) => scanPublicDto(nested, key))

  for (const [key, nested] of Object.entries(value)) {
    if (isSensitivePublicKey(key)) return true
    if (scanPublicDto(nested, key)) return true
  }
  return false
}

function isSensitivePublicKey(key: string): boolean {
  return /(^|_)(path|token|secret|password|env|stdout|stderr|prompt|candidatePath|uri|url)$/i.test(key)
}

function isSensitivePublicString(value: string): boolean {
  if (/[A-Za-z]:[\\/][^\s"'<>]*/.test(value)) return true
  if (/\\\\[^\\\s]+\\[^\\\s]+/.test(value)) return true
  if (/(^|[\s"'`[{(=:：])\/(?!\/)[A-Za-z0-9._-]+(?:\/[^\s"'<>]*)?/.test(value)) return true
  if (/file:\/\//i.test(value)) return true
  if (/^https?:\/\/(127\.0\.0\.1|localhost|[^/\s]+\/internal)/i.test(value)) return true
  if (/\b[A-Z][A-Z0-9_]*(API_KEY|TOKEN|SECRET|PASSWORD)\b/.test(value)) return true
  if (/"?(token|api[_-]?key|secret|password)"?\s*[:：]\s*"?.{4,}"?/i.test(value)) return true
  if (/\b(ghp|github_pat|sk|xox[baprs])-?[A-Za-z0-9_]{16,}\b/.test(value)) return true
  return false
}
