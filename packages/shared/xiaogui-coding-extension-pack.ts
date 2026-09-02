import type { SessionAddressV1, SessionMode } from './xiaogui-session-scope'

export type CodingExtensionIdV1 =
  | 'coding.context'
  | 'coding.permission'
  | 'coding.plan'
  | 'coding.review'
  | 'coding.checkpoint'
  | 'coding.roles'

export type CodingExtensionSeamV1 =
  | 'PI_EXTENSION'
  | 'TASK_HUB'
  | 'RENDERER_EXTENSION_UI'

export type CodingExtensionCapabilityV1 =
  | 'CONTEXT.FILE'
  | 'CONTEXT.SYMBOL'
  | 'CONTEXT.DIAGNOSTIC'
  | 'PERMISSION.COMMAND'
  | 'PERMISSION.PATH'
  | 'PERMISSION.EGRESS'
  | 'PLAN.DRAFT'
  | 'PLAN.TODO'
  | 'REVIEW.DIFF'
  | 'REVIEW.VERIFICATION'
  | 'CHECKPOINT.PREVIEW'
  | 'CHECKPOINT.RESTORE'
  | 'ROLE.RESEARCH'
  | 'ROLE.IMPLEMENT'
  | 'ROLE.REVIEW'

export interface CodingExtensionManifestV1 {
  readonly schemaVersion: 1
  readonly extensionId: CodingExtensionIdV1
  readonly displayName: string
  readonly allowedModes: readonly Extract<SessionMode, 'CODING'>[]
  /** P0 freezes contracts only. Production enablement belongs to P1-P3. */
  readonly defaultEnabled: false
  readonly requiredSeams: readonly CodingExtensionSeamV1[]
  readonly capabilities: readonly CodingExtensionCapabilityV1[]
}

const ALL_SEAMS = Object.freeze([
  'PI_EXTENSION',
  'TASK_HUB',
  'RENDERER_EXTENSION_UI',
] as const satisfies readonly CodingExtensionSeamV1[])

function manifest(
  extensionId: CodingExtensionIdV1,
  displayName: string,
  capabilities: readonly CodingExtensionCapabilityV1[],
): CodingExtensionManifestV1 {
  return Object.freeze({
    schemaVersion: 1,
    extensionId,
    displayName,
    allowedModes: Object.freeze(['CODING'] as const),
    defaultEnabled: false,
    requiredSeams: ALL_SEAMS,
    capabilities: Object.freeze([...capabilities]),
  })
}

export const XIAOGUI_CODING_EXTENSION_MANIFESTS_V1 = Object.freeze([
  manifest('coding.context', '代码上下文与符号', [
    'CONTEXT.FILE',
    'CONTEXT.SYMBOL',
    'CONTEXT.DIAGNOSTIC',
  ]),
  manifest('coding.permission', '命令、路径与外传权限', [
    'PERMISSION.COMMAND',
    'PERMISSION.PATH',
    'PERMISSION.EGRESS',
  ]),
  manifest('coding.plan', '计划卡与任务清单', ['PLAN.DRAFT', 'PLAN.TODO']),
  manifest('coding.review', 'Diff 与验证审阅', ['REVIEW.DIFF', 'REVIEW.VERIFICATION']),
  manifest('coding.checkpoint', 'Git 检查点与恢复', [
    'CHECKPOINT.PREVIEW',
    'CHECKPOINT.RESTORE',
  ]),
  manifest('coding.roles', '研究、实现、审阅角色', [
    'ROLE.RESEARCH',
    'ROLE.IMPLEMENT',
    'ROLE.REVIEW',
  ]),
] as const satisfies readonly CodingExtensionManifestV1[])

export interface CodingContextSnapshotV1 {
  readonly schemaVersion: 1
  readonly snapshotId: string
  readonly sources: readonly {
    readonly relativePath: string
    readonly symbol?: string
    readonly diagnosticCount?: number
    readonly byteLength: number
    readonly contentDigest: string
    readonly contentSummary: {
      readonly lineCount: number
      readonly includedBytes: number
      readonly truncated: boolean
    }
  }[]
  readonly symbolService: 'AVAILABLE' | 'UNAVAILABLE'
  readonly diagnosticService: 'AVAILABLE' | 'UNAVAILABLE'
  readonly resolutionMode: 'SYMBOL' | 'CONTROLLED_TEXT_FALLBACK'
  readonly degradationReason?: 'SYMBOL_SERVICE_UNAVAILABLE'
  readonly diagnosticDegradationReason?: 'DIAGNOSTIC_SERVICE_UNAVAILABLE'
  readonly truncated: boolean
}

export interface CodingContextSnapshotRequestV1 {
  /** Opaque canonical scope; Main derives the local project root. */
  readonly address: SessionAddressV1
  readonly relativePaths: readonly string[]
}

/** Main-to-Worker private turn payload. It is never returned to Renderer. */
export interface CodingContextAgentPayloadV1 {
  readonly schemaVersion: 1
  readonly snapshotIds: readonly string[]
  readonly sources: readonly {
    readonly relativePath: string
    readonly content: string
    readonly truncated: boolean
  }[]
  readonly symbolService: 'AVAILABLE' | 'UNAVAILABLE'
  readonly diagnosticService: 'AVAILABLE' | 'UNAVAILABLE'
}

export type CodingContextSnapshotOutcomeV1 =
  | { readonly ok: true; readonly snapshot: CodingContextSnapshotV1 }
  | {
      readonly ok: false
      readonly error:
        | 'INVALID_REQUEST'
        | 'OUTSIDE_WORKSPACE'
        | 'SOURCE_NOT_FOUND'
        | 'SOURCE_NOT_FILE'
        | 'SNAPSHOT_FAILED'
    }

export interface CodingPermissionIntentV1 {
  readonly schemaVersion: 1
  readonly attemptId: string
  readonly requestDigest: string
  readonly operation: 'READ' | 'WRITE' | 'COMMAND' | 'DATA_EGRESS'
  readonly relativePaths: readonly string[]
  readonly dataEgress: 'NONE' | 'REQUESTED'
  /** Digest of the private authoritative action. Required for command and egress rules. */
  readonly actionDigest?: string
  readonly commandSummary?: string
  readonly egressDestination?: string
}

export type CodingPermissionUserChoiceV1 = 'ALLOW_ONCE' | 'ALLOW_TASK_RULE' | 'DENY'

export interface CodingPermissionPromptV1 {
  readonly schemaVersion: 1
  readonly operation: CodingPermissionIntentV1['operation']
  readonly relativePaths: readonly string[]
  readonly dataEgress: CodingPermissionIntentV1['dataEgress']
  readonly commandSummary?: string
  readonly egressDestination?: string
  readonly summary: string
  readonly choices: readonly ['ALLOW_ONCE', 'ALLOW_TASK_RULE', 'DENY']
}

export const CODING_PERMISSION_MODES_V1 = Object.freeze([
  'CONFIRM_EACH',
  'AUTO_APPROVE',
  'FULL_AUTONOMY',
] as const)

export type CodingPermissionModeV1 = typeof CODING_PERMISSION_MODES_V1[number]
export const XIAOGUI_CODING_PERMISSION_MODE_SETTING_KEY_V1 = 'xiaoguiCodingPermissionMode' as const
export type CodingPermissionPolicyEffectV1 = 'ASK_USER' | 'ALLOW_ONCE' | 'DENY'

export interface CodingPermissionModeOptionV1 {
  readonly schemaVersion: 1
  readonly mode: CodingPermissionModeV1
  readonly label: string
  readonly description: string
  /**
   * These effects apply only after TaskHub has verified the Attempt boundary.
   * A mode never turns an unverified or denied operation into an allowed one.
   */
  readonly verifiedEffects: Readonly<Record<CodingPermissionIntentV1['operation'], Exclude<CodingPermissionPolicyEffectV1, 'DENY'>>>
}

function permissionModeOption(
  mode: CodingPermissionModeV1,
  label: string,
  description: string,
  verifiedEffects: CodingPermissionModeOptionV1['verifiedEffects'],
): CodingPermissionModeOptionV1 {
  return Object.freeze({
    schemaVersion: 1,
    mode,
    label,
    description,
    verifiedEffects: Object.freeze({ ...verifiedEffects }),
  })
}

/** Single source for the Renderer labels and TaskHub's deterministic policy. */
export const XIAOGUI_CODING_PERMISSION_MODE_OPTIONS_V1 = Object.freeze([
  permissionModeOption(
    'CONFIRM_EACH',
    '逐条确认',
    '写入、命令和外传操作会暂停，等待你确认。',
    { READ: 'ASK_USER', WRITE: 'ASK_USER', COMMAND: 'ASK_USER', DATA_EGRESS: 'ASK_USER' },
  ),
  permissionModeOption(
    'AUTO_APPROVE',
    '自动通过',
    '自动执行已核验范围内的读写；命令和外传仍会询问。',
    { READ: 'ALLOW_ONCE', WRITE: 'ALLOW_ONCE', COMMAND: 'ASK_USER', DATA_EGRESS: 'ASK_USER' },
  ),
  permissionModeOption(
    'FULL_AUTONOMY',
    '完全自主',
    '仅自动执行已经通过 TaskHub 硬边界核验的操作；越界或未核验操作不会执行。',
    { READ: 'ALLOW_ONCE', WRITE: 'ALLOW_ONCE', COMMAND: 'ALLOW_ONCE', DATA_EGRESS: 'ALLOW_ONCE' },
  ),
] as const satisfies readonly CodingPermissionModeOptionV1[])

export type CodingPermissionBoundaryStateV1 = 'VERIFIED' | 'UNVERIFIED' | 'DENIED'

export interface CodingPermissionModeBindingV1 {
  readonly schemaVersion: 1
  readonly attemptId: string
  readonly mode: CodingPermissionModeV1
  readonly source: 'USER_SELECTED'
  readonly policyDigest: string
  readonly boundAt: string
}

export interface CodingPermissionPolicyEvaluationV1 {
  readonly schemaVersion: 1
  readonly requestDigest: string
  readonly mode: CodingPermissionModeV1
  readonly effect: CodingPermissionPolicyEffectV1
  readonly reasonCode:
    | 'TASKHUB_BOUNDARY_UNVERIFIED'
    | 'TASKHUB_BOUNDARY_DENIED'
    | 'MODE_REQUIRES_USER_CONFIRMATION'
    | 'MODE_AUTO_APPROVED_VERIFIED_OPERATION'
}

export type CodingPlanTodoStatusV1 = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED'

export interface CodingPlanBodyV1 {
  readonly objective: string
  readonly steps: readonly {
    readonly stepId: string
    readonly title: string
    readonly validation: string
  }[]
  readonly constraints: readonly string[]
}

export interface CodingPlanDraftV1 {
  readonly schemaVersion: 1
  readonly planId: string
  readonly attemptId: string
  readonly objective: string
  readonly steps: readonly {
    readonly stepId: string
    readonly title: string
    readonly status: CodingPlanTodoStatusV1
    readonly validation: string
  }[]
  readonly constraints: readonly string[]
  readonly revision: number
}

export const CODING_PLAN_LIFECYCLE_STATES_V1 = Object.freeze([
  'AWAITING_APPROVAL',
  'APPROVED',
  'EXECUTING',
] as const)

export type CodingPlanLifecycleStateV1 = typeof CODING_PLAN_LIFECYCLE_STATES_V1[number]
export type CodingPlanSourceV1 = 'PI_DRAFT' | 'TASK_OBJECTIVE_FALLBACK'

/** Private Pi-to-Main draft keyed only by an opaque session address. */
export interface CodingPlanPendingDraftV1 {
  readonly schemaVersion: 1
  readonly address: SessionAddressV1
  readonly body: CodingPlanBodyV1
}

export type CodingPlanPendingDraftReceiptV1 =
  | { readonly ok: true; readonly draftDigest: string }
  | { readonly ok: false; readonly error: 'INVALID_COMMAND' }

export interface CodingPlanProjectionV1 {
  readonly schemaVersion: 1
  readonly attemptId: string
  readonly source: CodingPlanSourceV1
  readonly state: CodingPlanLifecycleStateV1
  readonly plan: CodingPlanDraftV1
  readonly planDigest: string
}

export interface CodingPlanBindAttemptCommandV1 {
  readonly schemaVersion: 1
  readonly address: SessionAddressV1
  readonly attemptId: string
  readonly taskObjective: string
}

export interface CodingPlanVersionCommandV1 {
  readonly schemaVersion: 1
  readonly attemptId: string
  readonly expectedRevision: number
  readonly expectedPlanDigest: string
}

export interface CodingPlanReviseCommandV1 extends CodingPlanVersionCommandV1 {
  readonly body: CodingPlanBodyV1
}

export interface CodingPlanTodoCommandV1 extends CodingPlanVersionCommandV1 {
  readonly stepId: string
  readonly nextStatus: CodingPlanTodoStatusV1
}

export type CodingPlanCommandErrorV1 =
  | 'INVALID_COMMAND'
  | 'PLAN_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'PLAN_NOT_APPROVED'
  | 'PLAN_BODY_LOCKED'
  | 'TODO_NOT_FOUND'
  | 'INVALID_TODO_TRANSITION'

export type CodingPlanCommandOutcomeV1 =
  | { readonly ok: true; readonly projection: CodingPlanProjectionV1 }
  | { readonly ok: false; readonly error: CodingPlanCommandErrorV1 }

export interface CodingReviewBundleV1 {
  readonly schemaVersion: 1
  readonly attemptId: string
  readonly changeSetDigest: string
  readonly changedRelativePaths: readonly string[]
  readonly verifications: readonly {
    readonly label: string
    readonly commandDigest: string
    readonly exitCode: number | null
    readonly status: 'PASSED' | 'FAILED' | 'UNKNOWN'
  }[]
  readonly unresolvedIssues: readonly string[]
}

export interface CodingCheckpointV1 {
  readonly schemaVersion: 1
  readonly checkpointId: string
  readonly attemptId: string
  readonly sessionCheckpointDigest: string
  readonly worktreeBaselineDigest: string
  readonly changeSummaryDigest: string
  readonly status: 'AVAILABLE' | 'RESTORED' | 'INVALIDATED'
}

export type CodingRoleKindV1 = 'RESEARCH' | 'IMPLEMENT' | 'REVIEW'

export interface CodingRoleProfileV1 {
  readonly schemaVersion: 1
  readonly profileId: string
  readonly role: CodingRoleKindV1
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly modelSelector: string
  readonly runtimePolicyId: string
  readonly toolAllowlist: readonly string[]
  readonly profileDigest: string
  readonly updatedAt: string
}

export interface CodingExtensionRegistrationEventV1 {
  readonly schemaVersion: 1
  readonly eventType: 'MODULE_REGISTERED'
  readonly eventId: string
  readonly source: 'PI_EXTENSION'
  readonly manifest: CodingExtensionManifestV1
}

export interface CodingExtensionHubReceiptV1 {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly accepted: true
  readonly hubSequence: number
  readonly manifestDigest: string
}

export interface CodingExtensionRendererProjectionV1 {
  readonly schemaVersion: 1
  readonly sourceEventId: string
  readonly hubSequence: number
  readonly extensionId: CodingExtensionIdV1
  readonly displayName: string
  readonly readiness: 'CONTRACT_REGISTERED'
}

export interface CodingExtensionRoundTripReceiptV1 {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly hubSequence: number
  readonly rendererPublished: true
}

export function isCodingExtensionRegistrationEventV1(
  value: unknown,
): value is CodingExtensionRegistrationEventV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.eventType !== 'MODULE_REGISTERED') {
    return false
  }
  if (!hasExactKeys(value, ['schemaVersion', 'eventType', 'eventId', 'source', 'manifest'])) {
    return false
  }
  if (value.source !== 'PI_EXTENSION' || !isSafeIdentifier(value.eventId) || !isRecord(value.manifest)) {
    return false
  }
  const manifestValue = value.manifest
  if (!hasExactKeys(manifestValue, [
    'schemaVersion',
    'extensionId',
    'displayName',
    'allowedModes',
    'defaultEnabled',
    'requiredSeams',
    'capabilities',
  ])) return false
  const candidate = XIAOGUI_CODING_EXTENSION_MANIFESTS_V1.find(
    (entry) => entry.extensionId === manifestValue.extensionId,
  )
  return candidate !== undefined
    && manifestValue.schemaVersion === 1
    && manifestValue.displayName === candidate.displayName
    && manifestValue.defaultEnabled === false
    && sameStrings(manifestValue.allowedModes, candidate.allowedModes)
    && sameStrings(manifestValue.requiredSeams, candidate.requiredSeams)
    && sameStrings(manifestValue.capabilities, candidate.capabilities)
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index])
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((entry, index) => entry === sortedExpected[index])
}
