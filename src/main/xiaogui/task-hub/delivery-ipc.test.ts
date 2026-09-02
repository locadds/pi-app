import { describe, expect, it, vi } from 'vitest'

import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import type {
  XiaoguiDeliveryCoordinatorPortV1,
  XiaoguiDeliveryOutcomeV1,
} from '@shared/xiaogui-delivery-ipc'
import type { DeliveryBatchProjectionV1 } from '@shared/xiaogui-delivery'
import { registerXiaoguiDeliveryHandlers } from './delivery-ipc'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => Promise<unknown>>(),
}))

vi.mock('../../ipc/registry', () => ({
  registerHandler: vi.fn((channel: string, handler: (payload: unknown) => Promise<unknown>) => {
    mocks.handlers.set(channel, handler)
  }),
}))

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

function okBatch(): XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1> {
  return {
    ok: true,
    value: {
      batchId: 'xhbdb_batch',
      flowId: 'xhbf_flow',
      selectionDraftId: 'xhbdsel_1',
      status: 'AWAITING_REVIEW',
      selectedTaskRunIds: ['xhbtr_a'],
    } as unknown as DeliveryBatchProjectionV1,
  }
}

function coordinator(): XiaoguiDeliveryCoordinatorPortV1 {
  return {
    selectTasks: vi.fn(async () => okBatch()),
    approveGate: vi.fn(async () => okBatch()),
    returnBatch: vi.fn(async () => okBatch()),
    reconcileApply: vi.fn(async () => okBatch()),
    retryApply: vi.fn(async () => okBatch()),
    prepareRecovery: vi.fn(async () => okBatch()),
  }
}

describe('M4D delivery IPC adapter', () => {
  it('accepts only full-task selection intent and rejects renderer-owned internals', async () => {
    const port = coordinator()
    registerXiaoguiDeliveryHandlers(port)
    const select = mocks.handlers.get('ipc:xiaogui.delivery.selection.submit')!
    const valid = {
      contractVersion: 'm4d.v1',
      address: ADDRESS,
      request: { requestId: 'req-1', flowId: 'xhbf_flow', taskRunIds: ['xhbtr_a', 'xhbtr_b'] },
    }

    await expect(select(valid)).resolves.toMatchObject({ ok: true })
    expect(port.selectTasks).toHaveBeenCalledWith(ADDRESS, valid.request)

    for (const payload of [
      { ...valid, request: { ...valid.request, taskRunIds: [] } },
      { ...valid, request: { ...valid.request, filePaths: ['src/a.ts'] } },
      { ...valid, trustedActor: { kind: 'main-process-user' } },
      { ...valid, request: { ...valid.request, command: 'git apply patch.diff' } },
      { ...valid, request: { ...valid.request, absolutePath: 'D:\\private\\a.ts' } },
      { ...valid, request: { ...valid.request, artifactBytes: 'patch bytes' } },
    ]) {
      await expect(select(payload)).resolves.toMatchObject({
        ok: false,
        error: { code: 'DELIVERY_INPUT_INVALID' },
      })
    }
    expect(port.selectTasks).toHaveBeenCalledOnce()
  })

  it('passes approval only with the current delivery subject shape', async () => {
    const port = coordinator()
    registerXiaoguiDeliveryHandlers(port)
    const approve = mocks.handlers.get('ipc:xiaogui.delivery.gate.approve')!
    const valid = {
      contractVersion: 'm4d.v1',
      address: ADDRESS,
      request: {
        requestId: 'req-approve',
        gateId: 'xhbdg_1',
        subject: {
          deliveryChangeSetId: 'xhbdcs_1',
          version: 1,
          digest: `sha256:${'a'.repeat(64)}`,
        },
      },
    }

    await expect(approve(valid)).resolves.toMatchObject({ ok: true })
    expect(port.approveGate).toHaveBeenCalledWith(ADDRESS, valid.request)

    for (const payload of [
      { ...valid, request: { ...valid.request, subject: { ...valid.request.subject, version: 2 } } },
      { ...valid, request: { ...valid.request, subject: { ...valid.request.subject, digest: 'stale' } } },
      { ...valid, request: { ...valid.request, rejectionReason: 'no' } },
      { ...valid, request: { ...valid.request, internalState: 'APPROVED' } },
    ]) {
      await expect(approve(payload)).resolves.toMatchObject({
        ok: false,
        error: { code: 'DELIVERY_INPUT_INVALID' },
      })
    }
    expect(port.approveGate).toHaveBeenCalledOnce()
  })

  it('returns a batch without invoking apply', async () => {
    const port = coordinator()
    registerXiaoguiDeliveryHandlers(port)
    const returnBatch = mocks.handlers.get('ipc:xiaogui.delivery.batch.return')!
    const payload = {
      contractVersion: 'm4d.v1',
      address: ADDRESS,
      request: {
        requestId: 'req-return',
        gateId: 'xhbdg_1',
        subject: {
          deliveryChangeSetId: 'xhbdcs_1',
          version: 1,
          digest: `sha256:${'b'.repeat(64)}`,
        },
        rejectionReason: '需要调整任务选择',
      },
    }

    await expect(returnBatch(payload)).resolves.toMatchObject({ ok: true })
    expect(port.returnBatch).toHaveBeenCalledWith(ADDRESS, payload.request)
    expect(port.reconcileApply).not.toHaveBeenCalled()
    expect(port.retryApply).not.toHaveBeenCalled()
    expect(port.prepareRecovery).not.toHaveBeenCalled()
  })

  it('keeps reconcile, retry, and recovery prepare as intent-only IPC without apply bytes or commands', async () => {
    const port = coordinator()
    registerXiaoguiDeliveryHandlers(port)
    const reconcile = mocks.handlers.get('ipc:xiaogui.delivery.apply.reconcile')!
    const retry = mocks.handlers.get('ipc:xiaogui.delivery.apply.retry')!
    const prepareRecovery = mocks.handlers.get('ipc:xiaogui.delivery.apply.recovery.prepare')!

    await expect(
      reconcile({
        contractVersion: 'm4d.v1',
        address: ADDRESS,
        request: { requestId: 'req-reconcile', batchId: 'xhbdb_1', applyAttemptId: 'xhbdaa_1' },
      }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      retry({
        contractVersion: 'm4d.v1',
        address: ADDRESS,
        request: { requestId: 'req-retry', batchId: 'xhbdb_1', failedApplyAttemptId: 'xhbdaa_1' },
      }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      prepareRecovery({
        contractVersion: 'm4d.v1',
        address: ADDRESS,
        request: { requestId: 'req-recovery', batchId: 'xhbdb_1', failedApplyAttemptId: 'xhbdaa_1' },
      }),
    ).resolves.toMatchObject({ ok: true })

    await expect(
      reconcile({
        contractVersion: 'm4d.v1',
        address: ADDRESS,
        request: { requestId: 'req-bad', batchId: 'xhbdb_1', command: 'npm test' },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'DELIVERY_INPUT_INVALID' } })
    await expect(
      retry({
        contractVersion: 'm4d.v1',
        address: ADDRESS,
        request: {
          requestId: 'req-bad-retry',
          batchId: 'xhbdb_1',
          failedApplyAttemptId: 'xhbdaa_1',
          artifactContent: 'diff --git',
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'DELIVERY_INPUT_INVALID' } })
    await expect(
      prepareRecovery({
        contractVersion: 'm4d.v1',
        address: ADDRESS,
        request: {
          requestId: 'req-bad-recovery',
          batchId: 'xhbdb_1',
          failedApplyAttemptId: 'xhbdaa_1',
          absolutePath: 'D:\\private\\patch.diff',
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'DELIVERY_INPUT_INVALID' } })

    expect(port.reconcileApply).toHaveBeenCalledOnce()
    expect(port.retryApply).toHaveBeenCalledOnce()
    expect(port.prepareRecovery).toHaveBeenCalledOnce()
  })
})
