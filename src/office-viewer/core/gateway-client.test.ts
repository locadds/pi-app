import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  OFFICE_SURFACE_PROTOCOL_V1,
  type OfficeSurfaceParentMessageV1,
  type OfficeSurfaceViewerMessageV1,
} from '@shared/xiaogui-office-surface'
import { OfficeGatewayClientV1 } from './gateway-client'
import type { OfficeParentBridgeV1 } from './parent-bridge'

const NONCE = 'a'.repeat(64)
const HEAD_ONE = `sha256:${'1'.repeat(64)}`
const HEAD_TWO = `sha256:${'2'.repeat(64)}`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Office Gateway 主进程代理客户端', () => {
  it('通过 MessagePort 代理读写快照，不在 Viewer 发起 HTTP 请求', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const requests: OfficeSurfaceViewerMessageV1[] = []
    const bridge = createBridge((request, respond) => {
      requests.push(request)
      if (request.type === 'VIEWER_GATEWAY_READ_REQUEST') {
        respond({
          type: 'PARENT_GATEWAY_RESPONSE',
          requestId: request.requestId,
          ok: true,
          headSha256: HEAD_ONE,
          snapshot: { title: '只存在主进程网关中的工作副本' },
        })
      } else if (request.type === 'VIEWER_GATEWAY_WRITE_REQUEST') {
        expect(request.expectedHeadSha256).toBe(HEAD_ONE)
        expect(request.snapshot).toEqual({ title: '已修改' })
        respond({
          type: 'PARENT_GATEWAY_RESPONSE',
          requestId: request.requestId,
          ok: true,
          headSha256: HEAD_TWO,
        })
      }
    })
    const client = new OfficeGatewayClientV1(bridge)

    await expect(client.load()).resolves.toEqual({
      headSha256: HEAD_ONE,
      snapshot: { title: '只存在主进程网关中的工作副本' },
    })
    await expect(client.save({ title: '已修改' })).resolves.toBe(HEAD_TWO)

    expect(requests.map((request) => request.type)).toEqual([
      'VIEWER_GATEWAY_READ_REQUEST',
      'VIEWER_GATEWAY_WRITE_REQUEST',
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('把条件写入冲突转换为用户可理解的错误', async () => {
    const bridge = createBridge((request, respond) => {
      if (request.type === 'VIEWER_GATEWAY_READ_REQUEST') {
        respond({
          type: 'PARENT_GATEWAY_RESPONSE',
          requestId: request.requestId,
          ok: true,
          headSha256: HEAD_ONE,
          snapshot: { title: '初始' },
        })
      } else if (request.type === 'VIEWER_GATEWAY_WRITE_REQUEST') {
        respond({
          type: 'PARENT_GATEWAY_RESPONSE',
          requestId: request.requestId,
          ok: false,
          errorCode: 'OFFICE_WORKTREE_CONFLICT',
          message: '文档工作副本已经变化，请重新载入。',
        })
      }
    })
    const client = new OfficeGatewayClientV1(bridge)
    await client.load()

    await expect(client.save({ title: '过期写入' })).rejects.toThrow('文档工作副本已经变化，请重新载入。')
  })
})

function createBridge(
  handler: (
    request: OfficeSurfaceViewerMessageV1,
    respond: (response: OfficeSurfaceParentPayloadV1) => void,
  ) => void,
): OfficeParentBridgeV1 {
  const listeners = new Set<(message: OfficeSurfaceParentMessageV1) => void>()
  return {
    post(request) {
      const wireRequest = {
        ...request,
        protocol: OFFICE_SURFACE_PROTOCOL_V1,
        channelNonce: NONCE,
      } as OfficeSurfaceViewerMessageV1
      handler(wireRequest, (response) => {
        const wireResponse = {
          ...response,
          protocol: OFFICE_SURFACE_PROTOCOL_V1,
          channelNonce: NONCE,
        } as OfficeSurfaceParentMessageV1
        queueMicrotask(() => {
          for (const listener of listeners) listener(wireResponse)
        })
      })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    waitForConnection: () => Promise.resolve(),
    dispose: () => listeners.clear(),
  }
}

type OfficeSurfaceParentPayloadV1 = OfficeSurfaceParentMessageV1 extends infer Message
  ? Message extends OfficeSurfaceParentMessageV1
    ? Omit<Message, 'protocol' | 'channelNonce'>
    : never
  : never
