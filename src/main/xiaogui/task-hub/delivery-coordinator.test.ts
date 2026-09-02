import { describe, expect, it } from 'vitest'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import type {
  DeliveryApplyAttemptIdV1,
  DeliveryApplyReceiptV1,
  DeliveryApprovalSubjectV1,
  DeliveryChangeSetIdV1,
  DeliveryChangeSetV1,
} from '@shared/xiaogui-delivery'
import type { Sha256Digest } from '@shared/xiaogui-task-verification'

import type { DeliveryApplyPortV1 } from './change-apply'
import { SqliteDeliveryCoordinatorV1, type DeliveryApplyStoreV1 } from './delivery-coordinator'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as HubAddressV1

describe('SqliteDeliveryCoordinatorV1', () => {
  it('hides begin/apply/complete ordering behind approveAndApply', async () => {
    const trace: string[] = []
    const changeSet = { deliveryChangeSetId: 'xhbd_1', version: 1, digest: 'sha256:digest' } as DeliveryChangeSetV1
    const approval = {
      deliveryChangeSetId: 'xhbd_1' as DeliveryChangeSetIdV1,
      version: 1 as const,
      digest: 'sha256:digest' as Sha256Digest,
    }
    const receipt = receiptFor('xhba_1')
    const store = fakeStore(trace, changeSet, approval)
    const port: DeliveryApplyPortV1 = {
      apply: async (request) => {
        trace.push(`apply:${request.applyAttemptId}`)
        return receipt
      },
      inspect: async () => {
        throw new Error('inspect not expected')
      },
    }
    const coordinator = new SqliteDeliveryCoordinatorV1(store, port)

    await expect(coordinator.approveAndApply({
      address: ADDRESS,
      requestId: 'req-1',
      deliveryChangeSetId: 'xhbd_1' as DeliveryChangeSetIdV1,
      approval,
    })).resolves.toEqual(receipt)

    expect(trace).toEqual(['begin:approving', 'apply:xhba_1', 'complete:SUCCEEDED'])
  })

  it('uses stored terminal receipt during inspect without reapplying', async () => {
    const trace: string[] = []
    const receipt = receiptFor('xhba_1')
    const store = fakeStore(trace, {} as DeliveryChangeSetV1, {} as DeliveryApprovalSubjectV1, receipt)
    const port: DeliveryApplyPortV1 = {
      apply: async () => {
        throw new Error('apply not expected')
      },
      inspect: async () => {
        throw new Error('port inspect not expected')
      },
    }
    const coordinator = new SqliteDeliveryCoordinatorV1(store, port)

    await expect(coordinator.inspectApplyAttempt('xhba_1' as DeliveryApplyAttemptIdV1)).resolves.toEqual(receipt)
    expect(trace).toEqual(['read:xhba_1'])
  })

  it('starts a new attempt when retrying a rolled-back failure', async () => {
    const trace: string[] = []
    const changeSet = { deliveryChangeSetId: 'xhbd_1', version: 1, digest: 'sha256:digest' } as DeliveryChangeSetV1
    const approval = {
      deliveryChangeSetId: 'xhbd_1' as DeliveryChangeSetIdV1,
      version: 1 as const,
      digest: 'sha256:digest' as Sha256Digest,
    }
    const retryReceipt = receiptFor('xhba_retry')
    const store = fakeStore(trace, changeSet, approval)
    const port: DeliveryApplyPortV1 = {
      apply: async (request) => {
        trace.push(`apply:${request.applyAttemptId}`)
        return retryReceipt
      },
      inspect: async () => {
        throw new Error('inspect not expected')
      },
    }
    const coordinator = new SqliteDeliveryCoordinatorV1(store, port)

    await expect(coordinator.retryFailedApply({
      address: ADDRESS,
      requestId: 'req-retry',
      failedApplyAttemptId: 'xhba_failed' as DeliveryApplyAttemptIdV1,
    })).resolves.toEqual(retryReceipt)

    expect(trace).toEqual(['begin-retry:xhba_failed', 'apply:xhba_retry', 'complete:SUCCEEDED'])
  })
})

function fakeStore(
  trace: string[],
  changeSet: DeliveryChangeSetV1,
  approval: DeliveryApprovalSubjectV1,
  existingReceipt?: DeliveryApplyReceiptV1,
): DeliveryApplyStoreV1 {
  return {
    beginApprovedApply: async () => {
      trace.push('begin:approving')
      return { applyAttemptId: 'xhba_1' as DeliveryApplyAttemptIdV1, changeSet, approval, fileContents: [] }
    },
    completeApply: async ({ receipt }) => {
      trace.push(`complete:${receipt.verdict}`)
    },
    applyAttempt: async ({ applyAttemptId }) => {
      trace.push(`read:${applyAttemptId}`)
      return { applyAttemptId, receipt: existingReceipt }
    },
    beginRetryApply: async ({ failedApplyAttemptId }) => {
      trace.push(`begin-retry:${failedApplyAttemptId}`)
      return { applyAttemptId: 'xhba_retry' as DeliveryApplyAttemptIdV1, changeSet, approval, fileContents: [] }
    },
  }
}

function receiptFor(applyAttemptId: string): DeliveryApplyReceiptV1 {
  return {
    applyAttemptId: applyAttemptId as DeliveryApplyAttemptIdV1,
    deliveryChangeSetId: 'xhbd_1' as DeliveryChangeSetIdV1,
    verdict: 'SUCCEEDED',
    changedRelativePaths: ['a.txt'],
    targetFingerprint: 'sha256:target' as Sha256Digest,
    receiptDigest: `sha256:receipt-${applyAttemptId}` as Sha256Digest,
  }
}
