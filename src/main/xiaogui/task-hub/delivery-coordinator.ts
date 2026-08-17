import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import type {
  DeliveryApplyAttemptIdV1,
  DeliveryApplyReceiptV1,
  DeliveryApprovalSubjectV1,
  DeliveryChangeSetIdV1,
  DeliveryChangeSetV1,
} from '@shared/xiaogui-delivery'

import type { DeliveryApplyFileContentV1, DeliveryApplyPortV1 } from './change-apply'

export interface DeliveryApplyBeginRecordV1 {
  readonly address: HubAddressV1
  readonly requestId: string
  readonly deliveryChangeSetId: DeliveryChangeSetIdV1
  readonly approval: DeliveryApprovalSubjectV1
}

export interface DeliveryApplyRetryRecordV1 {
  readonly address: HubAddressV1
  readonly requestId: string
  readonly failedApplyAttemptId: DeliveryApplyAttemptIdV1
}

export interface DeliveryApplyStoreV1 {
  beginApprovedApply(input: DeliveryApplyBeginRecordV1): Promise<{
    readonly applyAttemptId: DeliveryApplyAttemptIdV1
    readonly changeSet: DeliveryChangeSetV1
    readonly approval: DeliveryApprovalSubjectV1
    readonly fileContents: readonly DeliveryApplyFileContentV1[]
  }>
  completeApply(input: {
    readonly applyAttemptId: DeliveryApplyAttemptIdV1
    readonly receipt: DeliveryApplyReceiptV1
  }): Promise<void>
  applyAttempt(input: {
    readonly applyAttemptId: DeliveryApplyAttemptIdV1
  }): Promise<
    | {
        readonly applyAttemptId: DeliveryApplyAttemptIdV1
        readonly receipt?: DeliveryApplyReceiptV1
      }
    | null
  >
  beginRetryApply(input: DeliveryApplyRetryRecordV1): Promise<{
    readonly applyAttemptId: DeliveryApplyAttemptIdV1
    readonly changeSet: DeliveryChangeSetV1
    readonly approval: DeliveryApprovalSubjectV1
    readonly fileContents: readonly DeliveryApplyFileContentV1[]
  }>
}

export interface DeliveryCoordinatorV1 {
  approveAndApply(input: DeliveryApplyBeginRecordV1): Promise<DeliveryApplyReceiptV1>
  inspectApplyAttempt(applyAttemptId: DeliveryApplyAttemptIdV1): Promise<DeliveryApplyReceiptV1>
  retryFailedApply(input: DeliveryApplyRetryRecordV1): Promise<DeliveryApplyReceiptV1>
}

export class SqliteDeliveryCoordinatorV1 implements DeliveryCoordinatorV1 {
  private readonly inFlight = new Map<string, Promise<DeliveryApplyReceiptV1>>()

  constructor(
    private readonly store: DeliveryApplyStoreV1,
    private readonly applyPort: DeliveryApplyPortV1,
  ) {}

  approveAndApply(input: DeliveryApplyBeginRecordV1): Promise<DeliveryApplyReceiptV1> {
    const key = `approve:${input.address.projectId}:${input.address.sessionKey}:${input.requestId}`
    return this.singleFlight(key, async () => {
      const attempt = await this.store.beginApprovedApply(input)
      const receipt = await this.applyPort.apply({ ...attempt, fileContents: attempt.fileContents ?? [] })
      await this.store.completeApply({ applyAttemptId: attempt.applyAttemptId, receipt })
      return receipt
    })
  }

  inspectApplyAttempt(applyAttemptId: DeliveryApplyAttemptIdV1): Promise<DeliveryApplyReceiptV1> {
    const key = `inspect:${applyAttemptId}`
    return this.singleFlight(key, async () => {
      const persisted = await this.store.applyAttempt({ applyAttemptId })
      if (!persisted) throw new DeliveryCoordinatorErrorV1('APPLY_ATTEMPT_NOT_FOUND')
      if (persisted.receipt) return persisted.receipt
      const receipt = await this.applyPort.inspect(applyAttemptId)
      await this.store.completeApply({ applyAttemptId, receipt })
      return receipt
    })
  }

  retryFailedApply(input: DeliveryApplyRetryRecordV1): Promise<DeliveryApplyReceiptV1> {
    const key = `retry:${input.address.projectId}:${input.address.sessionKey}:${input.requestId}`
    return this.singleFlight(key, async () => {
      const attempt = await this.store.beginRetryApply(input)
      const receipt = await this.applyPort.apply({ ...attempt, fileContents: attempt.fileContents ?? [] })
      await this.store.completeApply({ applyAttemptId: attempt.applyAttemptId, receipt })
      return receipt
    })
  }

  private singleFlight(key: string, run: () => Promise<DeliveryApplyReceiptV1>): Promise<DeliveryApplyReceiptV1> {
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const task = run().finally(() => {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key)
    })
    this.inFlight.set(key, task)
    return task
  }
}

export class DeliveryCoordinatorErrorV1 extends Error {
  constructor(readonly reasonCode: 'APPLY_ATTEMPT_NOT_FOUND') {
    super(reasonCode)
    this.name = 'DeliveryCoordinatorErrorV1'
  }
}
