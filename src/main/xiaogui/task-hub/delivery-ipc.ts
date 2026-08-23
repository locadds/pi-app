import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'

import { z } from 'zod'

import type {
  XiaoguiDeliveryCoordinatorPortV1,
  XiaoguiDeliveryApproveGateIpcRequestV1,
  XiaoguiDeliveryPrepareRecoveryIpcRequestV1,
  XiaoguiDeliveryReconcileApplyIpcRequestV1,
  XiaoguiDeliveryReturnBatchIpcRequestV1,
  XiaoguiDeliveryRetryApplyIpcRequestV1,
  XiaoguiDeliverySelectTasksIpcRequestV1,
} from '@shared/xiaogui-delivery-ipc'
import { registerHandler } from '../../ipc/registry'

const AddressSchema = z
  .object({
    projectId: z.string().regex(/^xgp1_[0-9a-f]{64}$/),
    sessionKey: z.string().regex(/^xgs1_[0-9a-f]{64}$/),
  })
  .strict()

const DeliverySubjectSchema = z
  .object({
    deliveryChangeSetId: z.string().min(1).max(256),
    version: z.literal(1),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict()

const BaseIpcSchema = z.object({ contractVersion: z.literal('m4d.v1'), address: AddressSchema }).strict()

const SelectTasksSchema = BaseIpcSchema.extend({
  request: z
    .object({
      requestId: z.string().min(1).max(256).refine(isTrimmed),
      flowId: z.string().min(1).max(256).refine(isTrimmed),
      taskRunIds: z.array(z.string().min(1).max(256).refine(isTrimmed)).min(1).max(128),
    })
    .strict(),
}).strict()

const ApproveGateSchema = BaseIpcSchema.extend({
  request: z
    .object({
      requestId: z.string().min(1).max(256).refine(isTrimmed),
      gateId: z.string().min(1).max(256).refine(isTrimmed),
      subject: DeliverySubjectSchema,
    })
    .strict(),
}).strict()

const ReturnBatchSchema = BaseIpcSchema.extend({
  request: z
    .object({
      requestId: z.string().min(1).max(256).refine(isTrimmed),
      gateId: z.string().min(1).max(256).refine(isTrimmed),
      subject: DeliverySubjectSchema,
      rejectionReason: z.string().min(1).max(2048).refine(isTrimmed).optional(),
    })
    .strict(),
}).strict()

const ReconcileApplySchema = BaseIpcSchema.extend({
  request: z
    .object({
      requestId: z.string().min(1).max(256).refine(isTrimmed),
      batchId: z.string().min(1).max(256).refine(isTrimmed),
      applyAttemptId: z.string().min(1).max(256).refine(isTrimmed).optional(),
    })
    .strict(),
}).strict()

const RetryApplySchema = BaseIpcSchema.extend({
  request: z
    .object({
      requestId: z.string().min(1).max(256).refine(isTrimmed),
      batchId: z.string().min(1).max(256).refine(isTrimmed),
      failedApplyAttemptId: z.string().min(1).max(256).refine(isTrimmed),
    })
    .strict(),
}).strict()

const PrepareRecoverySchema = BaseIpcSchema.extend({
  request: z
    .object({
      requestId: z.string().min(1).max(256).refine(isTrimmed),
      batchId: z.string().min(1).max(256).refine(isTrimmed),
      failedApplyAttemptId: z.string().min(1).max(256).refine(isTrimmed),
    })
    .strict(),
}).strict()

export function registerXiaoguiDeliveryHandlers(coordinator: XiaoguiDeliveryCoordinatorPortV1): void {
  registerHandler('ipc:xiaogui.delivery.selection.submit', async (payload) => {
    const parsed = SelectTasksSchema.safeParse(payload)
    if (!parsed.success || containsUnsafeRendererValue(payload)) return invalidDeliveryInput()
    const typed = parsed.data as unknown as XiaoguiDeliverySelectTasksIpcRequestV1
    return coordinator.selectTasks(typed.address, typed.request)
  })

  registerHandler('ipc:xiaogui.delivery.gate.approve', async (payload) => {
    const parsed = ApproveGateSchema.safeParse(payload)
    if (!parsed.success || containsUnsafeRendererValue(payload)) return invalidDeliveryInput()
    const typed = parsed.data as unknown as XiaoguiDeliveryApproveGateIpcRequestV1
    return coordinator.approveGate(typed.address, typed.request)
  })

  registerHandler('ipc:xiaogui.delivery.batch.return', async (payload) => {
    const parsed = ReturnBatchSchema.safeParse(payload)
    if (!parsed.success || containsUnsafeRendererValue(payload)) return invalidDeliveryInput()
    const typed = parsed.data as unknown as XiaoguiDeliveryReturnBatchIpcRequestV1
    return coordinator.returnBatch(typed.address, typed.request)
  })

  registerHandler('ipc:xiaogui.delivery.apply.reconcile', async (payload) => {
    const parsed = ReconcileApplySchema.safeParse(payload)
    if (!parsed.success || containsUnsafeRendererValue(payload)) return invalidDeliveryInput()
    const typed = parsed.data as unknown as XiaoguiDeliveryReconcileApplyIpcRequestV1
    return coordinator.reconcileApply(typed.address, typed.request)
  })

  registerHandler('ipc:xiaogui.delivery.apply.retry', async (payload) => {
    const parsed = RetryApplySchema.safeParse(payload)
    if (!parsed.success || containsUnsafeRendererValue(payload)) return invalidDeliveryInput()
    const typed = parsed.data as unknown as XiaoguiDeliveryRetryApplyIpcRequestV1
    return coordinator.retryApply(typed.address, typed.request)
  })

  registerHandler('ipc:xiaogui.delivery.apply.recovery.prepare', async (payload) => {
    const parsed = PrepareRecoverySchema.safeParse(payload)
    if (!parsed.success || containsUnsafeRendererValue(payload)) return invalidDeliveryInput()
    const typed = parsed.data as unknown as XiaoguiDeliveryPrepareRecoveryIpcRequestV1
    return coordinator.prepareRecovery(typed.address, typed.request)
  })
}

function isTrimmed(value: string): boolean {
  return value === value.trim()
}

function invalidDeliveryInput() {
  return {
    ok: false as const,
    error: {
      code: 'DELIVERY_INPUT_INVALID' as const,
      messageKey: 'xiaogui.delivery.input_invalid',
      traceId: `xhbd_${randomUUID()}`,
    },
  }
}

function containsUnsafeRendererValue(value: unknown): boolean {
  if (typeof value === 'string') return isUnsafeString(value)
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsUnsafeRendererValue)
  return Object.entries(value).some(([key, nested]) => isForbiddenRendererKey(key) || containsUnsafeRendererValue(nested))
}

function isForbiddenRendererKey(key: string): boolean {
  return [
    'absolutePath',
    'adapterId',
    'artifactBytes',
    'artifactContent',
    'baselineDigest',
    'command',
    'internalState',
    'rawLog',
    'trustedActor',
  ].includes(key)
}

function isUnsafeString(value: string): boolean {
  if (value.includes('\0')) return true
  if (win32.isAbsolute(value) || posix.isAbsolute(value) || value.startsWith('\\\\') || value.startsWith('//')) return true
  return false
}
