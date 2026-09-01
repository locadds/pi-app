import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcClient } from '@renderer/lib/ipc-client'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import { resolveCodingContextStatus } from './coding-context-status'

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn() } }))

describe('resolveCodingContextStatus', () => {
  const address = {
    projectId: `xgp1_${'a'.repeat(64)}`,
    sessionKey: `xgs1_${'b'.repeat(64)}`,
  } as SessionAddressV1

  beforeEach(() => vi.mocked(ipcClient.invoke).mockReset())

  it('在 CODING 模式只标记发送前读取，不提前创建全文快照', async () => {
    await expect(resolveCodingContextStatus({
      enabled: true,
      address,
      relativePath: 'src/a.ts',
    })).resolves.toEqual({ codingContextStatus: 'PENDING_SESSION' })
    expect(ipcClient.invoke).not.toHaveBeenCalled()
  })

  it('非 CODING 模式不标记上下文；尚无会话时同样等待发送', async () => {
    await expect(resolveCodingContextStatus({
      enabled: false,
      address,
      relativePath: 'src/a.ts',
    })).resolves.toEqual({})
    expect(ipcClient.invoke).not.toHaveBeenCalled()

    await expect(resolveCodingContextStatus({
      enabled: true,
      address: null,
      relativePath: 'src/a.ts',
    })).resolves.toEqual({ codingContextStatus: 'PENDING_SESSION' })
  })
})
