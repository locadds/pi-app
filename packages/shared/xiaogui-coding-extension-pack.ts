import type { SessionMode } from './xiaogui-session-scope'

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
    readonly contentDigest: string
  }[]
  readonly symbolService: 'AVAILABLE' | 'UNAVAILABLE'
  readonly truncated: boolean
}

export interface CodingPermissionIntentV1 {
  readonly schemaVersion: 1
  readonly attemptId: string
  readonly requestDigest: string
  readonly operation: 'READ' | 'WRITE' | 'COMMAND' | 'DATA_EGRESS'
  readonly relativePaths: readonly string[]
  readonly dataEgress: 'NONE' | 'REQUESTED'
}

export interface CodingPlanDraftV1 {
  readonly schemaVersion: 1
  readonly planId: string
  readonly attemptId: string
  readonly objective: string
  readonly steps: readonly {
    readonly stepId: string
    readonly title: string
    readonly status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED'
    readonly validation: string
  }[]
  readonly constraints: readonly string[]
  readonly revision: number
}

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
