import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  OFFICE_SURFACE_PROTOCOL_V1,
  isOfficeSurfaceViewerMessageV1,
  type OfficeSurfaceCapabilityV1,
  type OfficeSurfaceParentMessageV1,
} from '@shared/xiaogui-office-surface'

export interface OfficeSurfaceFramePropsV1 {
  readonly gatewayOrigin: string
  readonly gatewayAccessToken: string
  readonly onReady?: (capabilities: OfficeSurfaceCapabilityV1) => void
  readonly onDirtyChange?: (dirty: boolean, headSha256: string) => void
  readonly onError?: (message: string) => void
}

export interface OfficeSurfaceFrameHandleV1 {
  save(): void
  reload(): void
  focusField(fieldId: string): void
  focusOccurrence(occurrenceId: string): void
}

type FrameStatus = 'LOADING' | 'READY' | 'FAILED'
type OfficeSurfaceParentPayloadV1 = OfficeSurfaceParentMessageV1 extends infer Message
  ? Message extends OfficeSurfaceParentMessageV1
    ? Omit<Message, 'protocol' | 'channelNonce'>
    : never
  : never

export const OfficeSurfaceFrameV1 = forwardRef<
  OfficeSurfaceFrameHandleV1,
  OfficeSurfaceFramePropsV1
>(function OfficeSurfaceFrameV1(props, ref): React.JSX.Element {
  const { gatewayOrigin, gatewayAccessToken, onReady, onDirtyChange, onError } = props
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const portRef = useRef<MessagePort | null>(null)
  const readyTimerRef = useRef<number | null>(null)
  const callbacksRef = useRef({ onReady, onDirtyChange, onError })
  callbacksRef.current = { onReady, onDirtyChange, onError }
  const [status, setStatus] = useState<FrameStatus>('LOADING')
  const [reloadKey, setReloadKey] = useState(0)
  const channelNonce = useMemo(() => createChannelNonce(), [reloadKey])
  const normalizedGatewayOrigin = useMemo(() => new URL(gatewayOrigin).origin, [gatewayOrigin])
  const viewerUrl = useMemo(() => {
    const url = new URL('/viewer/', normalizedGatewayOrigin)
    url.searchParams.set('channelNonce', channelNonce)
    return url.toString()
  }, [normalizedGatewayOrigin, channelNonce])

  const post = useCallback((message: OfficeSurfaceParentPayloadV1) => {
    portRef.current?.postMessage({
      ...message,
      protocol: OFFICE_SURFACE_PROTOCOL_V1,
      channelNonce,
    })
  }, [channelNonce])

  useImperativeHandle(ref, () => ({
    save: () => post({ type: 'PARENT_SAVE' }),
    reload: () => post({ type: 'PARENT_RELOAD' }),
    focusField: (fieldId: string) => post({ type: 'PARENT_FOCUS_FIELD', fieldId }),
    focusOccurrence: (occurrenceId: string) => post({ type: 'PARENT_FOCUS_OCCURRENCE', occurrenceId }),
  }), [post])

  useEffect(() => {
    setStatus('LOADING')
    readyTimerRef.current = window.setTimeout(() => {
      readyTimerRef.current = null
      setStatus('FAILED')
      callbacksRef.current.onError?.('小规文档界面启动超时。')
    }, 15_000)
    return () => {
      if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current)
      readyTimerRef.current = null
      post({ type: 'PARENT_DISPOSE' })
      portRef.current?.close()
      portRef.current = null
    }
  }, [channelNonce, post])

  const offerPort = () => {
    const target = iframeRef.current?.contentWindow
    if (!target) return
    portRef.current?.close()
    const channel = new MessageChannel()
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (!isOfficeSurfaceViewerMessageV1(event.data) || event.data.channelNonce !== channelNonce) return
      if (event.data.type === 'VIEWER_READY') {
        if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current)
        readyTimerRef.current = null
        setStatus('READY')
        callbacksRef.current.onReady?.(event.data.capabilities)
      } else if (event.data.type === 'VIEWER_DIRTY_STATE') {
        callbacksRef.current.onDirtyChange?.(event.data.dirty, event.data.headSha256)
      } else {
        if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current)
        readyTimerRef.current = null
        setStatus('FAILED')
        callbacksRef.current.onError?.(event.data.message)
      }
    }
    channel.port1.start()
    portRef.current = channel.port1
    target.postMessage({
      protocol: OFFICE_SURFACE_PROTOCOL_V1,
      channelNonce,
      type: 'OFFICE_PORT_OFFER',
      gatewayAccessToken,
    }, normalizedGatewayOrigin, [channel.port2])
    window.setTimeout(() => post({ type: 'PARENT_PING' }), 0)
  }

  return (
    <section className="relative h-full min-h-0 w-full overflow-hidden bg-neutral-100">
      {status === 'LOADING' ? (
        <div className="absolute inset-x-0 top-0 z-10 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          正在启动小规文档工作表面…
        </div>
      ) : null}
      {status === 'FAILED' ? (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-white">
          <p className="text-sm text-neutral-600">文档工作表面暂时无法打开。</p>
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
        title="小规文档工作表面"
        className="h-full w-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
        onLoad={offerPort}
      />
    </section>
  )
})

function createChannelNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}
