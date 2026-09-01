import type {
  CodingPlanBodyV1,
  CodingPlanCommandErrorV1,
  CodingPlanProjectionV1,
  CodingPlanTodoStatusV1,
  CodingReviewBundleV1,
} from './xiaogui-coding-extension-pack'
import type { HubAddressV1 } from './xiaogui-collaboration-hub'

export const XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1 =
  'xiaogui.coding-extension-control.v1' as const

export interface CodingPlanObserveRequestV1 {
  readonly contractVersion: typeof XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1
  readonly address: HubAddressV1
}

export interface CodingPlanObserveProjectionV1 {
  readonly contractVersion: typeof XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1
  readonly plans: readonly CodingPlanProjectionV1[]
}

export type CodingPlanObserveOutcomeV1 =
  | { readonly ok: true; readonly value: CodingPlanObserveProjectionV1 }
  | { readonly ok: false; readonly error: CodingExtensionSafeErrorV1 }

interface CodingPlanVersionActionV1 {
  readonly attemptId: string
  readonly expectedRevision: number
  readonly expectedPlanDigest: string
}

export type CodingPlanActionV1 =
  | (CodingPlanVersionActionV1 & {
      readonly type: 'REVISE'
      readonly body: CodingPlanBodyV1
    })
  | (CodingPlanVersionActionV1 & { readonly type: 'APPROVE' })
  | (CodingPlanVersionActionV1 & { readonly type: 'RESUME' })
  | (CodingPlanVersionActionV1 & {
      readonly type: 'TODO_TRANSITION'
      readonly stepId: string
      readonly nextStatus: CodingPlanTodoStatusV1
    })

export interface CodingPlanPerformRequestV1 {
  readonly contractVersion: typeof XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1
  readonly address: HubAddressV1
  readonly action: CodingPlanActionV1
}

export interface CodingPlanPerformReceiptV1 {
  readonly contractVersion: typeof XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1
  readonly projection: CodingPlanProjectionV1
  readonly executionResume: 'NOT_REQUESTED' | 'RESUMED'
}

export type CodingPlanPerformOutcomeV1 =
  | { readonly ok: true; readonly value: CodingPlanPerformReceiptV1 }
  | {
      readonly ok: false
      readonly error: CodingExtensionSafeErrorV1
      /** Approval remains authoritative if dispatch failed; the UI can retry RESUME. */
      readonly projection?: CodingPlanProjectionV1
    }

export interface CodingReviewReadRequestV1 {
  readonly contractVersion: typeof XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1
  readonly address: HubAddressV1
  readonly attemptId: string
}

export interface CodingReviewReadProjectionV1 {
  readonly contractVersion: typeof XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1
  readonly bundle: CodingReviewBundleV1
  readonly unifiedDiff: string
  readonly unifiedDiffDigest: string
}

export type CodingReviewReadOutcomeV1 =
  | { readonly ok: true; readonly value: CodingReviewReadProjectionV1 }
  | { readonly ok: false; readonly error: CodingExtensionSafeErrorV1 }

export type CodingExtensionSafeErrorCodeV1 =
  | CodingPlanCommandErrorV1
  | 'INVALID_REQUEST'
  | 'SESSION_SCOPE_MISMATCH'
  | 'EXECUTION_RESUME_FAILED'
  | 'ROLE_BINDING_REQUIRED'
  | 'REVIEW_UNAVAILABLE'

export interface CodingExtensionSafeErrorV1 {
  readonly code: CodingExtensionSafeErrorCodeV1
  readonly messageKey: string
}
