import {
  OFFICE_SURFACE_PROTOCOL_V1,
  isOfficeSurfaceParentMessageV1,
  isOfficeSurfacePortOfferV1,
  type OfficeSurfaceParentMessageV1,
  type OfficeSurfaceViewerMessageV1,
} from '@shared/xiaogui-office-surface'

export interface OfficeParentBridgeV1 {
  post(message: OfficeSurfaceViewerPayloadV1): void
  subscribe(listener: (message: OfficeSurfaceParentMessageV1) => void): () => void
  waitForAuthorization(): Promise<string>
  dispose(): void
}

type OfficeSurfaceViewerPayloadV1 = OfficeSurfaceViewerMessageV1 extends infer Message
  ? Message extends OfficeSurfaceViewerMessageV1
    ? Omit<Message, 'protocol' | 'channelNonce'>
    : never
  : never

/**
 * 主 Renderer 在生产环境来自 file://，没有可比较的 HTTP Origin。这里仅在
 * 一次性随机 nonce、父 WindowProxy 和转移后的 MessagePort 三者同时匹配时
 * 建立通道；后续消息不再经过 window.postMessage。
 */
export function createOfficeParentBridgeV1(locationUrl = window.location.href): OfficeParentBridgeV1 | null {
  const url = new URL(locationUrl)
  const channelNonce = url.searchParams.get('channelNonce')
  if (!channelNonce || channelNonce.length < 32 || channelNonce.length > 256) return null

  let port: MessagePort | null = null
  let gatewayAccessToken: string | null = null
  let resolveAuthorization: ((token: string) => void) | null = null
  const authorization = new Promise<string>((resolve) => {
    resolveAuthorization = resolve
  })
  const listeners = new Set<(message: OfficeSurfaceParentMessageV1) => void>()
  const queued: OfficeSurfaceViewerPayloadV1[] = []

  const send = (message: OfficeSurfaceViewerPayloadV1) => {
    const payload = { ...message, protocol: OFFICE_SURFACE_PROTOCOL_V1, channelNonce }
    if (port) port.postMessage(payload)
    else queued.push(message)
  }

  const onBootstrap = (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent || port || event.ports.length !== 1) return
    if (!isOfficeSurfacePortOfferV1(event.data) || event.data.channelNonce !== channelNonce) return
    port = event.ports[0]
    gatewayAccessToken = event.data.gatewayAccessToken
    resolveAuthorization?.(gatewayAccessToken)
    resolveAuthorization = null
    port.onmessage = (portEvent: MessageEvent<unknown>) => {
      if (!isOfficeSurfaceParentMessageV1(portEvent.data)) return
      if (portEvent.data.channelNonce !== channelNonce) return
      for (const listener of listeners) listener(portEvent.data)
    }
    port.start()
    for (const message of queued.splice(0)) send(message)
  }
  window.addEventListener('message', onBootstrap)

  return {
    post: send,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    waitForAuthorization() {
      return gatewayAccessToken ? Promise.resolve(gatewayAccessToken) : authorization
    },
    dispose() {
      window.removeEventListener('message', onBootstrap)
      listeners.clear()
      queued.splice(0)
      port?.close()
      port = null
    },
  }
}
