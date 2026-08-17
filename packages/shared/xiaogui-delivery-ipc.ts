import type { HubAddressV1, FlowId, TaskRunId } from './xiaogui-collaboration-hub'
import type {
  DeliveryApplyAttemptId,
  DeliveryBatchId,
  DeliveryBatchProjectionV1,
  DeliveryGateId,
  DeliveryGateSubjectV1,
} from './xiaogui-delivery'

export type XiaoguiDeliveryIpcContractVersionV1 = 'm4d.v1'

export type XiaoguiDeliverySafeErrorCodeV1 =
  | 'IPC_VERSION_UNSUPPORTED'
  | 'DELIVERY_INPUT_INVALID'
  | 'STALE_DELIVERY_SUBJECT'
  | 'DELIVERY_NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'INTERNAL'

export interface XiaoguiDeliverySafeErrorV1 {
  readonly code: XiaoguiDeliverySafeErrorCodeV1
  readonly messageKey: string
  readonly traceId: string
}

export type XiaoguiDeliveryOutcomeV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: XiaoguiDeliverySafeErrorV1 }

export interface XiaoguiDeliverySelectTasksRequestV1 {
  readonly requestId: string
  readonly flowId: FlowId
  readonly taskRunIds: readonly TaskRunId[]
}

export interface XiaoguiDeliveryApproveGateRequestV1 {
  readonly requestId: string
  readonly gateId: DeliveryGateId
  readonly subject: DeliveryGateSubjectV1
}

export interface XiaoguiDeliveryReturnBatchRequestV1 {
  readonly requestId: string
  readonly gateId: DeliveryGateId
  readonly subject: DeliveryGateSubjectV1
  readonly rejectionReason?: string
}

export interface XiaoguiDeliveryReconcileApplyRequestV1 {
  readonly requestId: string
  readonly batchId: DeliveryBatchId
  readonly applyAttemptId?: DeliveryApplyAttemptId
}

export interface XiaoguiDeliveryRetryApplyRequestV1 {
  readonly requestId: string
  readonly batchId: DeliveryBatchId
  readonly failedApplyAttemptId: DeliveryApplyAttemptId
}

export interface XiaoguiDeliverySelectTasksIpcRequestV1 {
  readonly contractVersion: XiaoguiDeliveryIpcContractVersionV1
  readonly address: HubAddressV1
  readonly request: XiaoguiDeliverySelectTasksRequestV1
}

export interface XiaoguiDeliveryApproveGateIpcRequestV1 {
  readonly contractVersion: XiaoguiDeliveryIpcContractVersionV1
  readonly address: HubAddressV1
  readonly request: XiaoguiDeliveryApproveGateRequestV1
}

export interface XiaoguiDeliveryReturnBatchIpcRequestV1 {
  readonly contractVersion: XiaoguiDeliveryIpcContractVersionV1
  readonly address: HubAddressV1
  readonly request: XiaoguiDeliveryReturnBatchRequestV1
}

export interface XiaoguiDeliveryReconcileApplyIpcRequestV1 {
  readonly contractVersion: XiaoguiDeliveryIpcContractVersionV1
  readonly address: HubAddressV1
  readonly request: XiaoguiDeliveryReconcileApplyRequestV1
}

export interface XiaoguiDeliveryRetryApplyIpcRequestV1 {
  readonly contractVersion: XiaoguiDeliveryIpcContractVersionV1
  readonly address: HubAddressV1
  readonly request: XiaoguiDeliveryRetryApplyRequestV1
}

export interface XiaoguiDeliveryCoordinatorPortV1 {
  readonly selectTasks: (
    address: HubAddressV1,
    request: XiaoguiDeliverySelectTasksRequestV1,
  ) => Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>>
  readonly approveGate: (
    address: HubAddressV1,
    request: XiaoguiDeliveryApproveGateRequestV1,
  ) => Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>>
  readonly returnBatch: (
    address: HubAddressV1,
    request: XiaoguiDeliveryReturnBatchRequestV1,
  ) => Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>>
  readonly reconcileApply: (
    address: HubAddressV1,
    request: XiaoguiDeliveryReconcileApplyRequestV1,
  ) => Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>>
  readonly retryApply: (
    address: HubAddressV1,
    request: XiaoguiDeliveryRetryApplyRequestV1,
  ) => Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>>
}
