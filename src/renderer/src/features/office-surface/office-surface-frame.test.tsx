import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OFFICE_SURFACE_PROTOCOL_V1 } from '@shared/xiaogui-office-surface'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: mocks.invoke },
}))

import { OfficeSurfaceFrameV1 } from './office-surface-frame'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const HEAD = `sha256:${'a'.repeat(64)}`
const NONCE = 'b'.repeat(64)

let latestChannel: FakeMessageChannel | null = null

beforeEach(() => {
  mocks.invoke.mockReset()
  latestChannel = null
  vi.stubGlobal('MessageChannel', class {
    readonly port1 = new FakePort()
    readonly port2 = new FakePort()

    constructor() {
      latestChannel = this as unknown as FakeMessageChannel
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Office Surface file:// 父页代理', () => {
  it('只把无凭据的 MessagePort 请求交给主进程代理，URL 和握手均不含访问密钥', async () => {
    mocks.invoke.mockResolvedValue({ headSha256: HEAD, snapshot: { title: '受控工作副本' } })
    const { getByTitle, unmount } = render(
      <OfficeSurfaceFrameV1 sessionId={SESSION_ID} gatewayOrigin="http://127.0.0.1:43123" />,
    )
    const iframe = getByTitle('小规文档界面') as HTMLIFrameElement
    const offerSpy = vi.spyOn(iframe.contentWindow!, 'postMessage')

    fireEvent.load(iframe)
    expect(latestChannel).not.toBeNull()
    expect(iframe.src).toMatch(/^http:\/\/127\.0\.0\.1:43123\/viewer\/\?channelNonce=/)
    expect(iframe.src).not.toContain(SESSION_ID)
    expect(offerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: OFFICE_SURFACE_PROTOCOL_V1,
        type: 'OFFICE_PORT_OFFER',
      }),
      'http://127.0.0.1:43123',
      [latestChannel!.port2],
    )
    expect(JSON.stringify(offerSpy.mock.calls[0])).not.toMatch(/token|credential|authorization/i)

    latestChannel!.port1.onmessage?.({
      data: {
        protocol: OFFICE_SURFACE_PROTOCOL_V1,
        channelNonce: readOfferedNonce(offerSpy),
        type: 'VIEWER_GATEWAY_READ_REQUEST',
        requestId: NONCE,
      },
    } as MessageEvent)

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        'xiaogui.officeSurface.gateway.snapshot.read',
        { sessionId: SESSION_ID },
      )
      expect(latestChannel!.port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'PARENT_GATEWAY_RESPONSE',
        requestId: NONCE,
        ok: true,
        headSha256: HEAD,
        snapshot: { title: '受控工作副本' },
      }))
    })
    unmount()
  })
})

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null
  readonly postMessage = vi.fn()
  readonly start = vi.fn()
  readonly close = vi.fn()
}

interface FakeMessageChannel {
  readonly port1: FakePort
  readonly port2: FakePort
}

function readOfferedNonce(spy: ReturnType<typeof vi.spyOn>): string {
  const message = spy.mock.calls[0]?.[0] as { channelNonce?: unknown }
  if (typeof message.channelNonce !== 'string') throw new Error('channel nonce missing')
  return message.channelNonce
}
