import {
  OFFICE_SURFACE_PROTOCOL_V1,
  isOfficeSurfaceParentMessageV1,
  type OfficeSurfaceParentMessageV1,
  type OfficeSurfaceViewerMessageV1,
} from '../../../packages/shared/xiaogui-office-surface'

export interface OfficeParentBridgeV1 {
  post(message: OfficeSurfaceViewerPayloadV1): void
  subscribe(listener: (message: OfficeSurfaceParentMessageV1) => void): () => void
}

type OfficeSurfaceViewerPayloadV1 = OfficeSurfaceViewerMessageV1 extends infer Message
  ? Message extends OfficeSurfaceViewerMessageV1
    ? Omit<Message, 'protocol' | 'channelNonce'>
    : never
  : never

export function createOfficeParentBridgeV1(locationUrl = window.location.href): OfficeParentBridgeV1 | null {
  const url = new URL(locationUrl)
  const parentOrigin = url.searchParams.get('parentOrigin')
  const channelNonce = url.searchParams.get('channelNonce')
  if (!parentOrigin || !/^https?:\/\//.test(parentOrigin)) return null
  if (!channelNonce || channelNonce.length < 32 || channelNonce.length > 256) return null
  const normalizedOrigin = new URL(parentOrigin).origin

  return {
    post(message) {
      window.parent.postMessage({
        ...message,
        protocol: OFFICE_SURFACE_PROTOCOL_V1,
        channelNonce,
      }, normalizedOrigin)
    },
    subscribe(listener) {
      const onMessage = (event: MessageEvent<unknown>) => {
        if (event.source !== window.parent || event.origin !== normalizedOrigin) return
        if (!isOfficeSurfaceParentMessageV1(event.data)) return
        if (event.data.channelNonce !== channelNonce) return
        listener(event.data)
      }
      window.addEventListener('message', onMessage)
      return () => window.removeEventListener('message', onMessage)
    },
  }
}
