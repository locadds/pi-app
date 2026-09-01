import type { CodingRoleKindV1, CodingRoleProfileV1 } from './xiaogui-coding-extension-pack'
import type { SessionAddressV1 } from './xiaogui-session-scope'

export const XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1 =
  'xiaogui.coding-role-control.v1' as const

/**
 * Main-to-Worker only Attempt binding. The prompt body must never be returned by
 * ordinary Renderer projections or written to timeline/log events.
 */
export interface CodingRoleAgentSnapshotV1 {
  readonly schemaVersion: 1
  readonly attemptId: string
  readonly boundAt: string
  readonly snapshot: {
    readonly schemaVersion: 1
    readonly profileId: string
    readonly role: CodingRoleKindV1
    readonly name: string
    readonly description: string
    readonly systemPrompt: string
    readonly modelSelector: string
    readonly runtimePolicyId: string
    readonly requestedToolAllowlist: readonly string[]
    readonly effectiveToolAllowlist: readonly string[]
    readonly profileDigest: string
  }
  readonly snapshotDigest: string
}

export type CodingRoleProfileSummaryProjectionV1 = Omit<CodingRoleProfileV1, 'systemPrompt'>

export type CodingRoleProfileEditorDraftV1 = Omit<
  CodingRoleProfileV1,
  'profileDigest' | 'updatedAt'
>

export interface CodingRoleAttemptProjectionV1 {
  readonly schemaVersion: 1
  readonly attemptId: string
  readonly profileId: string
  readonly role: CodingRoleKindV1
  readonly name: string
  readonly description: string
  readonly modelSelector: string
  readonly runtimePolicyId: string
  readonly effectiveToolAllowlist: readonly string[]
  readonly profileDigest: string
  readonly snapshotDigest: string
  readonly boundAt: string
}

export interface CodingRoleControlBaseRequestV1 {
  readonly contractVersion: typeof XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1
  readonly address: SessionAddressV1
}

export type CodingRoleListRequestV1 = CodingRoleControlBaseRequestV1

export interface CodingRoleReadForEditRequestV1 extends CodingRoleControlBaseRequestV1 {
  readonly profileId: string
}

export interface CodingRoleUpsertRequestV1 extends CodingRoleControlBaseRequestV1 {
  readonly profile: CodingRoleProfileEditorDraftV1
}

export interface CodingRoleCopyRequestV1 extends CodingRoleControlBaseRequestV1 {
  readonly sourceProfileId: string
  readonly newProfileId: string
}

export interface CodingRoleResetDefaultRequestV1 extends CodingRoleControlBaseRequestV1 {
  readonly profileId: string
}

export interface CodingRoleAttemptBindRequestV1 extends CodingRoleControlBaseRequestV1 {
  readonly attemptId: string
  readonly profileId: string
  readonly expectedProfileDigest: string
}

export interface CodingRoleAttemptReadRequestV1 extends CodingRoleControlBaseRequestV1 {
  readonly attemptId: string
}

export type CodingRoleControlErrorCodeV1 =
  | 'INVALID_REQUEST'
  | 'SESSION_SCOPE_MISMATCH'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_INVALID'
  | 'PROFILE_ALREADY_EXISTS'
  | 'PROFILE_NOT_DEFAULT'
  | 'VERSION_CONFLICT'
  | 'ATTEMPT_ALREADY_BOUND'
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_POLICY_UNSUPPORTED'
  | 'MODEL_UNAVAILABLE'
  | 'ROLE_STORE_UNAVAILABLE'

export interface CodingRoleControlErrorV1 {
  readonly code: CodingRoleControlErrorCodeV1
  readonly messageKey: string
}

export type CodingRoleControlOutcomeV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CodingRoleControlErrorV1 }

export type CodingRoleListOutcomeV1 = CodingRoleControlOutcomeV1<{
  readonly contractVersion: typeof XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1
  readonly profiles: readonly CodingRoleProfileSummaryProjectionV1[]
}>

export type CodingRoleReadForEditOutcomeV1 = CodingRoleControlOutcomeV1<{
  readonly contractVersion: typeof XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1
  readonly profile: CodingRoleProfileV1
}>

export type CodingRoleUpsertOutcomeV1 = CodingRoleControlOutcomeV1<{
  readonly contractVersion: typeof XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1
  readonly profile: CodingRoleProfileSummaryProjectionV1
}>

export type CodingRoleCopyOutcomeV1 = CodingRoleUpsertOutcomeV1

export type CodingRoleResetDefaultOutcomeV1 = CodingRoleUpsertOutcomeV1

export type CodingRoleAttemptOutcomeV1 = CodingRoleControlOutcomeV1<{
  readonly contractVersion: typeof XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1
  readonly binding: CodingRoleAttemptProjectionV1 | null
}>
