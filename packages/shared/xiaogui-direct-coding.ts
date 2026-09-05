import type { SessionAddressV1 } from './xiaogui-session-scope'
import type { CodingPermissionModeV1 } from './xiaogui-coding-permission'
import type { XiaoguiExecutionPhase } from './xiaogui-prompt-contract'

export const XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2 = '2.0.0' as const
export const XIAOGUI_DIRECT_CODING_EXECUTION_VERSION_V3 = '3.0.0' as const
export const XIAOGUI_DIRECT_CODING_SUBJECT_V2 = 'DIRECT_SESSION' as const
export const XIAOGUI_TASKHUB_CODING_SUBJECT_V2 = 'TASKHUB_ATTEMPT' as const

export const DIRECT_CODING_OPERATIONS_V2 = [
  'READ',
  'EDIT',
  'WRITE',
  'BASH',
  'DATA_EGRESS',
] as const
export type DirectCodingOperationV2 = (typeof DIRECT_CODING_OPERATIONS_V2)[number]

export const DIRECT_CODING_CALL_STATES_V2 = [
  'PENDING',
  'ALLOWED',
  'EXECUTING',
  'SETTLED',
  'OUTCOME_UNKNOWN',
] as const
export type DirectCodingCallStateV2 = (typeof DIRECT_CODING_CALL_STATES_V2)[number]

export type DirectCodingPermissionChoiceV2 = 'ALLOW_ONCE' | 'DENY'

/**
 * Main-owned authorization subject for ordinary CODING conversations. TaskHub
 * Attempt authorization keeps its V1 contract and never masquerades as this
 * subject.
 */
export interface DirectCodingAuthorizationSubjectV2 {
  readonly schemaVersion: 2
  readonly kind: typeof XIAOGUI_DIRECT_CODING_SUBJECT_V2
  readonly address: SessionAddressV1
}

export interface TaskHubCodingAuthorizationSubjectV2 {
  readonly schemaVersion: 2
  readonly kind: typeof XIAOGUI_TASKHUB_CODING_SUBJECT_V2
  readonly attemptId: string
}

/** Versioned subject union owned by the shared authorization Module. */
export type CodingAuthorizationSubjectV2 =
  | DirectCodingAuthorizationSubjectV2
  | TaskHubCodingAuthorizationSubjectV2

/** Current direct-session execution contract; older prompt/preflight variants are not supported in parallel. */
export interface DirectCodingPermissionPromptV3 {
  readonly schemaVersion: 3
  readonly subject: typeof XIAOGUI_DIRECT_CODING_SUBJECT_V2
  readonly requestDigest: string
  readonly originDigest: string
  readonly projectLabel: string
  readonly sessionLabel: string
  readonly operation: DirectCodingOperationV2
  readonly mode: CodingPermissionModeV1
  readonly relativePath?: string
  /** Exact command text shown to the user; never persisted by Main. */
  readonly commandText?: string
  readonly warning?: string
  readonly choices: readonly ['ALLOW_ONCE', 'DENY']
}

export interface DirectCodingPermissionResponseV3 {
  readonly choice: DirectCodingPermissionChoiceV2
  readonly requestDigest: string
  readonly originDigest: string
}

export interface DirectCodingPermissionOriginV3 {
  readonly projectLabel: string
  readonly sessionLabel: string
  readonly fromCwd: string
  readonly fromPoolKey: string
  readonly sessionFile: string
  readonly sourceSessionId: string
}

export interface DirectCodingPreflightPayloadV4 {
  readonly sourceSessionId: string
  readonly toolCallId: string
  readonly requestDigest: string
  readonly phase: XiaoguiExecutionPhase
  readonly operation: DirectCodingOperationV2
  /** Raw Pi path; Main normalizes it against the trusted project root. */
  readonly path?: string
  /** Exact command, capped at 64 KiB before crossing the Worker seam. */
  readonly commandText?: string
  readonly commandDigest?: string
}

export interface DirectCodingSettlePayloadV2 {
  readonly sourceSessionId: string
  readonly toolCallId: string
  readonly requestDigest: string
  readonly isError: boolean
  readonly exitCode?: number | null
}

export interface DirectCodingBeginPayloadV4 {
  readonly sourceSessionId: string
  readonly toolCallId: string
  readonly requestDigest: string
}

type DirectCodingLifecycleResultBaseV4 = {
  readonly subject: typeof XIAOGUI_DIRECT_CODING_SUBJECT_V2
  readonly requestDigest: string
  readonly reasonCode: string
}

export type DirectCodingPreflightResultV4 =
  | (DirectCodingLifecycleResultBaseV4 & {
      readonly kind: 'XIAOGUI_DIRECT_CODING_PREFLIGHT'
      readonly decision: 'ALLOW'
      readonly state: 'ALLOWED'
      /** Present only for READ/EDIT/WRITE. This is the sole path Pi may execute. */
      readonly authorizedRelativePath?: string
    })
  | (DirectCodingLifecycleResultBaseV4 & {
      readonly kind: 'XIAOGUI_DIRECT_CODING_PREFLIGHT'
      readonly decision: 'DENY'
      readonly state: DirectCodingCallStateV2
    })

export type DirectCodingSettleResultV2 = {
  readonly kind: 'XIAOGUI_DIRECT_CODING_SETTLED'
  readonly subject: typeof XIAOGUI_DIRECT_CODING_SUBJECT_V2
  readonly state: Extract<DirectCodingCallStateV2, 'SETTLED' | 'OUTCOME_UNKNOWN'>
  readonly requestDigest: string
}

export type DirectCodingBeginResultV4 =
  | (DirectCodingLifecycleResultBaseV4 & {
      readonly kind: 'XIAOGUI_DIRECT_CODING_BEGIN'
      readonly decision: 'ALLOW'
      readonly state: 'EXECUTING'
      /** Present only for READ/EDIT/WRITE and must equal the preflight value. */
      readonly authorizedRelativePath?: string
    })
  | (DirectCodingLifecycleResultBaseV4 & {
      readonly kind: 'XIAOGUI_DIRECT_CODING_BEGIN'
      readonly decision: 'DENY'
      readonly state: 'OUTCOME_UNKNOWN'
    })

const DIRECT_CODING_COMMAND_UNSAFE_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/
const DIRECT_CODING_LABEL_UNSAFE_RE =
  /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** Shared Worker/Main/Renderer display-safety guard. Newlines and tabs remain valid command text. */
export function hasUnsafeDirectCodingCommandTextV1(value: string): boolean {
  return DIRECT_CODING_COMMAND_UNSAFE_RE.test(value)
}

/** Labels are display-only and never participate in authorization identity. */
export function sanitizeDirectCodingDisplayLabelV1(value: string, maxLength = 80): string {
  const normalized = value
    .replace(DIRECT_CODING_LABEL_UNSAFE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (normalized || '未命名').slice(0, maxLength)
}

export function isSafeDirectCodingDisplayLabelV1(value: string, maxLength = 80): boolean {
  return value.length > 0
    && value.length <= maxLength
    && sanitizeDirectCodingDisplayLabelV1(value, maxLength) === value
}

export const DIRECT_CODING_CHECKPOINT_STATUSES_V2 = [
  'AVAILABLE',
  'RESTORED',
  'CONFLICT',
  'OUTCOME_UNKNOWN',
] as const
export type DirectCodingCheckpointStatusV2 = (typeof DIRECT_CODING_CHECKPOINT_STATUSES_V2)[number]

/** Public projection. File bytes and the project root stay in Main storage. */
export interface DirectCodingFileCheckpointV2 {
  readonly schemaVersion: 2
  readonly subject: typeof XIAOGUI_DIRECT_CODING_SUBJECT_V2
  readonly checkpointToken: string
  readonly toolCallId: string
  readonly relativePath: string
  readonly existedBefore: boolean
  readonly beforeDigest: string
  readonly afterDigest: string | null
  readonly status: DirectCodingCheckpointStatusV2
  readonly createdAt: string
}

export interface DirectCodingCheckpointListRequestV2 {
  readonly contractVersion: typeof XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2
  readonly address: SessionAddressV1
}

export interface DirectCodingCheckpointPreviewRequestV2 extends DirectCodingCheckpointListRequestV2 {
  readonly checkpointToken: string
}

export interface DirectCodingCheckpointConfirmRequestV2
  extends DirectCodingCheckpointPreviewRequestV2 {
  readonly previewToken: string
  readonly previewDigest: string
}

export interface DirectCodingCheckpointRestorePreviewV2 {
  readonly schemaVersion: 2
  readonly checkpointToken: string
  readonly previewToken: string
  readonly previewDigest: string
  readonly relativePath: string
  readonly action: 'RESTORE_PREVIOUS_BYTES' | 'REMOVE_CREATED_FILE'
  readonly conversationEffect: 'UNCHANGED'
  readonly expiresAt: string
}

export type DirectCodingCheckpointErrorCodeV2 =
  | 'INVALID_REQUEST'
  | 'SESSION_SCOPE_MISMATCH'
  | 'CHECKPOINT_NOT_FOUND'
  | 'CHECKPOINT_CONFLICT'
  | 'PREVIEW_STALE'
  | 'OUTCOME_UNKNOWN'
  | 'RESTORE_FAILED'
  | 'CHECKPOINT_RUNTIME_UNAVAILABLE'

export type DirectCodingCheckpointOutcomeV2<T extends object> =
  | {
      readonly ok: true
      readonly value: T & { readonly contractVersion: typeof XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2 }
    }
  | {
      readonly ok: false
      readonly error: {
        readonly code: DirectCodingCheckpointErrorCodeV2
        readonly messageKey: string
      }
    }

export type DirectCodingCheckpointListOutcomeV2 = DirectCodingCheckpointOutcomeV2<{
  readonly checkpoints: readonly DirectCodingFileCheckpointV2[]
}>
export type DirectCodingCheckpointPreviewOutcomeV2 = DirectCodingCheckpointOutcomeV2<{
  readonly preview: DirectCodingCheckpointRestorePreviewV2
}>
export type DirectCodingCheckpointConfirmOutcomeV2 = DirectCodingCheckpointOutcomeV2<{
  readonly checkpoint: DirectCodingFileCheckpointV2
}>

export interface DirectCodingPermissionModeOptionV2 {
  readonly mode: CodingPermissionModeV1
  readonly label: string
  readonly description: string
}

/** Direct-session UI copy only; TaskHub keeps its frozen V1 effect matrix. */
export const XIAOGUI_DIRECT_CODING_PERMISSION_MODE_OPTIONS_V2 = Object.freeze([
  Object.freeze({
    mode: 'CONFIRM_EACH' as const,
    label: '逐条确认',
    description: '读取、修改和新建都逐次询问；命令和工具外传始终询问。',
  }),
  Object.freeze({
    mode: 'AUTO_APPROVE' as const,
    label: '自动通过',
    description: '项目内读取和已有文件修改自动通过；新建、命令和工具外传仍询问。',
  }),
  Object.freeze({
    mode: 'FULL_AUTONOMY' as const,
    label: '完全自主',
    description: '项目内文件读写自动通过；命令和工具外传仍逐次询问。',
  }),
] satisfies readonly DirectCodingPermissionModeOptionV2[])
