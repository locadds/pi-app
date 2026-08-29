import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  OFFICE_SURFACE_PROTOCOL_V1,
  isOfficeSurfaceViewerMessageV1,
  type OfficeSurfaceCapabilityV1,
  type OfficeSurfaceParentMessageV1,
} from '../../../../../packages/shared/xiaogui-office-surface'

export interface OfficeSurfaceFramePropsV1 {
  readonly gatewayOrigin: string
  readonly parentOrigin: string
  readonly onReady?: (capabilities: OfficeSurfaceCapabilityV1) => void
  readonly onDirtyChange?: (dirty: boolean, headSha256: string) => void
  readonly onError?: (message: string) => void
}

type FrameStatus = 'LOADING' | 'READY' | 'FAILED'

export function OfficeSurfaceFrameV1(props: OfficeSurfaceFramePropsV1): React.JSX.Element {
  const { gatewayOrigin, parentOrigin, onReady, onDirtyChange, onError } = props
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const callbacksRef = useRef({ onReady, onDirtyChange, onError })
  callbacksRef.current = { onReady, onDirtyChange, onError }
  const [status, setStatus] = useState<FrameStatus>('LOADING')
  const [reloadKey, setReloadKey] = useState(0)
  const channelNonce = useMemo(() => createChannelNonce(), [reloadKey])
  const viewerUrl = useMemo(() => {
    const normalizedGatewayOrigin = new URL(gatewayOrigin).origin
    const normalizedParentOrigin = new URL(parentOrigin).origin
    const url = new URL('/viewer/', normalizedGatewayOrigin)
    url.searchParams.set('parentOrigin', normalizedParentOrigin)
    url.searchParams.set('channelNonce', channelNonce)
    return url.toString()
  }, [gatewayOrigin, parentOrigin, channelNonce])

  const post = useCallback((type: OfficeSurfaceParentMessageV1['type']) => {
    iframeRef.current?.contentWindow?.postMessage({
      protocol: OFFICE_SURFACE_PROTOCOL_V1,
      channelNonce,
      type,
    }, new URL(gatewayOrigin).origin)
  }, [channelNonce, gatewayOrigin])

  useEffect(() => {
    setStatus('LOADING')
    const normalizedGatewayOrigin = new URL(gatewayOrigin).origin
    const timer = window.setTimeout(() => {
      setStatus('FAILED')
      callbacksRef.current.onError?.('小规文档界面启动超时。')
    }, 15_000)
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== normalizedGatewayOrigin) return
      if (!isOfficeSurfaceViewerMessageV1(event.data) || event.data.channelNonce !== channelNonce) return
      if (event.data.type === 'VIEWER_READY') {
        window.clearTimeout(timer)
        setStatus('READY')
        callbacksRef.current.onReady?.(event.data.capabilities)
      } else if (event.data.type === 'VIEWER_DIRTY_STATE') {
        callbacksRef.current.onDirtyChange?.(event.data.dirty, event.data.headSha256)
      } else {
        setStatus('FAILED')
        callbacksRef.current.onError?.(event.data.message)
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      post('PARENT_DISPOSE')
    }
  }, [channelNonce, gatewayOrigin, post])

  return (
    <section className="relative h-full min-h-0 w-full overflow-hidden bg-neutral-100">
      {status === 'LOADING' ? (
        <div className="absolute inset-x-0 top-0 z-10 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          正在启动小规文档界面…
        </div>
      ) : null}
      {status === 'FAILED' ? (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-white">
          <p className="text-sm text-neutral-600">文档界面暂时无法打开。</p>
          <button
            type="button"
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            重新载入
          </button>
        </div>
      ) : null}
      <iframe
        key={reloadKey}
        ref={iframeRef}
        src={viewerUrl}
        title="小规文档界面"
        className="h-full w-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
        onLoad={() => post('PARENT_PING')}
      />
    </section>
  )
}

function createChannelNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}
