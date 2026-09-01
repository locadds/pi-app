import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'

import { codingCheckpointClient } from './coding-checkpoint-client'

const invokeMock = vi.fn()
vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: (method: string, request?: unknown) => invokeMock(method, request) },
}))

const address: HubAddressV1 = {
  projectId: `xgp1_${'a'.repeat(64)}` as HubAddressV1['projectId'],
  sessionKey: `xgs1_${'b'.repeat(64)}` as HubAddressV1['sessionKey'],
}

describe('coding-checkpoint-client', () => {
  beforeEach(() => invokeMock.mockReset())

  it('重启后通过窄通道恢复检查点列表', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        contractVersion: 'xiaogui.coding-checkpoint-control.v1',
        checkpoints: [{
          schemaVersion: 1,
          checkpointId: 'checkpoint_1',
          attemptId: 'xhba_private',
          status: 'AVAILABLE',
        }],
      },
    })
    await expect(codingCheckpointClient.list(address, 'xhba_private')).resolves.toEqual({
      ok: true,
      value: [{ checkpointRef: 'checkpoint_1', status: 'AVAILABLE' }],
    })
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.coding.checkpoint.list', expect.objectContaining({
      attemptId: 'xhba_private',
      address,
    }))
  })

  it('通过登记窄通道创建检查点且不向 UI 暴露私有摘要', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        contractVersion: 'xiaogui.coding-checkpoint-control.v1',
        checkpoint: {
          schemaVersion: 1,
          checkpointId: 'checkpoint_1',
          attemptId: 'xhba_private',
          status: 'AVAILABLE',
        },
      },
    })
    await expect(codingCheckpointClient.capture(address, 'xhba_private')).resolves.toEqual({
      ok: true,
      value: { checkpointRef: 'checkpoint_1', status: 'AVAILABLE' },
    })
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.coding.checkpoint.capture', expect.objectContaining({
      attemptId: 'xhba_private',
      address,
    }))
  })

  it('IPC 异常和过期预览均 fail closed', async () => {
    invokeMock.mockRejectedValueOnce(new Error('private path'))
    await expect(codingCheckpointClient.capture(address, 'xhba_private')).resolves.toEqual({
      ok: false,
      error: 'CHECKPOINT_UNAVAILABLE',
    })
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'PREVIEW_EXPIRED', messageKey: 'safe' },
    })
    await expect(codingCheckpointClient.prepareRestore(address, 'xhba_private', 'checkpoint_1')).resolves.toEqual({
      ok: false,
      error: 'PREVIEW_STALE',
    })
  })
})
