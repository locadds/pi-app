import type { SessionAddressV1 } from './xiaogui-session-scope'

export type WorkDocxOperationIdV1 = string & { readonly __brand: 'WorkDocxOperationIdV1' }

export interface WorkDocxCapabilityV1 {
  id: 'docx-template-patch'
  version: '9.7.1'
  status: 'AVAILABLE'
  intents: readonly ['PREPARE', 'CONFIRM']
}

export type WorkDocxErrorCodeV1 =
  | 'SCOPE_NOT_FOUND'
  | 'SCOPE_MISMATCH'
  | 'MODE_NOT_ALLOWED'
  | 'INPUT_INVALID'
  | 'INPUT_TOO_LARGE'
  | 'UNSAFE_DOCX'
  | 'PLACEHOLDER_MISSING'
  | 'TARGET_EXISTS'
  | 'OPERATION_NOT_FOUND'
  | 'OPERATION_SCOPE_MISMATCH'
  | 'SOURCE_CHANGED'
  | 'GENERATION_FAILED'
  | 'PUBLISH_FAILED'

export type WorkDocxOutcomeV1<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: WorkDocxErrorCodeV1; messageKey: string } }

export type WorkDocxDiscoverRequestV1 = SessionAddressV1

export interface WorkDocxDiscoverResultV1 {
  capabilities: readonly [WorkDocxCapabilityV1]
}

export interface WorkDocxPrepareRequestV1 {
  address: SessionAddressV1
}

export type WorkDocxPrepareResultV1 =
  | { kind: 'CANCELLED' }
  | {
      kind: 'PREPARED'
      operationId: WorkDocxOperationIdV1
      placeholders: readonly string[]
      templateSha256: string
      payloadSha256: string
    }

export interface WorkDocxConfirmRequestV1 {
  address: SessionAddressV1
  operationId: WorkDocxOperationIdV1
}

export interface WorkDocxPublishedResultV1 {
  kind: 'PUBLISHED'
  operationId: WorkDocxOperationIdV1
  outputSha256: string
  templateSha256: string
  payloadSha256: string
  originalInputsUnchanged: true
}
