import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  OFFICE_SURFACE_PROTOCOL_V1,
  isOfficeSurfaceViewerMessageV1,
  type OfficeSurfaceCapabilityV1,
  type OfficeSurfaceFieldUpdateResultV1,
  type OfficeSurfaceParentMessageV1,
  type OfficeSurfaceViewerMessageV1,
} from '@shared/xiaogui-office-surface'
import { ipcClient } from '@renderer/lib/ipc-client'

export interface OfficeSurfaceFramePropsV1 {
  readonly sessionId: string
  readonly gatewayOrigin: string
  readonly onReady?: (capabilities: OfficeSurfaceCapabilityV1) => void
  readonly onDirtyChange?: (dirty: boolean, headSha256: string) => void
  readonly onOccurrenceSelect?: (occurrenceId: string, fieldId: string) => void
  readonly onError?: (message: string) => void
}

export interface OfficeSurfaceFrameHandleV1 {
  save(): void
  reload(): void
  focusField(fieldId: string): void
  focusOccurrence(occurrenceId: string): void
  updateField(input: {
    fieldId: string
    value: string
    occurrenceIds: readonly string[]
  }): Promise<OfficeSurfaceFieldUpdateResultV1>
}

type FrameStatus = 'LOADING' | 'READY' | 'FAILED'
type OfficeSurfaceParentPayloadV1 = OfficeSurfaceParentMessageV1 extends infer Message
  ? Message extends OfficeSurfaceParentMessageV1
    ? Omit<Message, 'protocol' | 'channelNonce'>
    : never
  : never

export const OfficeSurfaceFrameV1 = forwardRef<OfficeSurfaceFrameHandleV1, OfficeSurfaceFramePropsV1>(
  function OfficeSurfaceFrameV1(props, ref): React.JSX.Element {
    const { sessionId, gatewayOrigin, onReady, onDirtyChange, onOccurrenceSelect, onError } = props
    const iframeRef = useRef<HTMLIFrameElement>(null)
    const portRef = useRef<MessagePort | null>(null)
    const pendingFieldUpdatesRef = useRef(
      new Map<
        string,
        {
          resolve: (result: OfficeSurfaceFieldUpdateResultV1) => void
          reject: (error: Error) => void
          timer: number
        }
      >(),
    )
    const readyTimerRef = useRef<number | null>(null)
    const callbacksRef = useRef({ onReady, onDirtyChange, onOccurrenceSelect, onError })
    callbacksRef.current = { onReady, onDirtyChange, onOccurrenceSelect, onError }
    const [status, setStatus] = useState<FrameStatus>('LOADING')
    const [reloadKey, setReloadKey] = useState(0)
    const channelNonce = useMemo(() => createChannelNonce(), [reloadKey])
    const normalizedGatewayOrigin = useMemo(() => new URL(gatewayOrigin).origin, [gatewayOrigin])
    const viewerUrl = useMemo(() => {
      const url = new URL('/viewer/', normalizedGatewayOrigin)
      url.searchParams.set('channelNonce', channelNonce)
      return url.toString()
    }, [normalizedGatewayOrigin, channelNonce])

    const post = useCallback(
      (message: OfficeSurfaceParentPayloadV1) => {
        portRef.current?.postMessage({
          ...message,
          protocol: OFFICE_SURFACE_PROTOCOL_V1,
          channelNonce,
        })
      },
      [channelNonce],
    )

    useImperativeHandle(
      ref,
      () => ({
        save: () => post({ type: 'PARENT_SAVE' }),
        reload: () => post({ type: 'PARENT_RELOAD' }),
        focusField: (fieldId: string) => post({ type: 'PARENT_FOCUS_FIELD', fieldId }),
        focusOccurrence: (occurrenceId: string) => post({ type: 'PARENT_FOCUS_OCCURRENCE', occurrenceId }),
        updateField: ({ fieldId, value, occurrenceIds }) => {
          if (!portRef.current || status !== 'READY') {
            return Promise.reject(new Error('文档界面尚未准备好。'))
          }
          const requestId = createChannelNonce()
          return new Promise<OfficeSurfaceFieldUpdateResultV1>((resolve, reject) => {
            const timer = window.setTimeout(() => {
              pendingFieldUpdatesRef.current.delete(requestId)
              reject(new Error('同步业务字段超时，请重新载入文档界面。'))
            }, 15_000)
            pendingFieldUpdatesRef.current.set(requestId, {
              resolve,
              reject,
              timer,
            })
            post({
              type: 'PARENT_UPDATE_FIELD',
              requestId,
              fieldId,
              value,
              occurrenceIds,
            })
          })
        },
      }),
      [post, status],
    )

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
        for (const pending of pendingFieldUpdatesRef.current.values()) {
          window.clearTimeout(pending.timer)
          pending.reject(new Error('文档界面已经关闭。'))
        }
        pendingFieldUpdatesRef.current.clear()
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
        if (
          event.data.type === 'VIEWER_GATEWAY_READ_REQUEST'
          || event.data.type === 'VIEWER_GATEWAY_WRITE_REQUEST'
        ) {
          void proxyGatewayRequest(sessionId, event.data).then(post)
          return
        }
        if (event.data.type === 'VIEWER_READY') {
          if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current)
          readyTimerRef.current = null
          setStatus('READY')
          callbacksRef.current.onReady?.(event.data.capabilities)
        } else if (event.data.type === 'VIEWER_DIRTY_STATE') {
          callbacksRef.current.onDirtyChange?.(event.data.dirty, event.data.headSha256)
        } else if (event.data.type === 'VIEWER_FIELD_UPDATE_RESULT') {
          const pending = pendingFieldUpdatesRef.current.get(event.data.requestId)
          if (!pending) return
          window.clearTimeout(pending.timer)
          pendingFieldUpdatesRef.current.delete(event.data.requestId)
          pending.resolve({
            requestId: event.data.requestId,
            fieldId: event.data.fieldId,
            updatedOccurrenceIds: event.data.updatedOccurrenceIds,
            failedOccurrenceIds: event.data.failedOccurrenceIds,
            headSha256: event.data.headSha256,
          })
        } else if (event.data.type === 'VIEWER_OCCURRENCE_SELECTED') {
          callbacksRef.current.onOccurrenceSelect?.(event.data.occurrenceId, event.data.fieldId)
        } else {
          if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current)
          readyTimerRef.current = null
          setStatus('FAILED')
          for (const pending of pendingFieldUpdatesRef.current.values()) {
            window.clearTimeout(pending.timer)
            pending.reject(new Error(event.data.message))
          }
          pendingFieldUpdatesRef.current.clear()
          callbacksRef.current.onError?.(event.data.message)
        }
      }
      channel.port1.start()
      portRef.current = channel.port1
      target.postMessage(
        {
          protocol: OFFICE_SURFACE_PROTOCOL_V1,
          channelNonce,
          type: 'OFFICE_PORT_OFFER',
        },
        normalizedGatewayOrigin,
        [channel.port2],
      )
      window.setTimeout(() => post({ type: 'PARENT_PING' }), 0)
    }

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
          onLoad={offerPort}
        />
      </section>
    )
  },
)

function createChannelNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

type GatewayRequestV1 = Extract<
  OfficeSurfaceViewerMessageV1,
  { type: 'VIEWER_GATEWAY_READ_REQUEST' | 'VIEWER_GATEWAY_WRITE_REQUEST' }
>

async function proxyGatewayRequest(
  sessionId: string,
  request: GatewayRequestV1,
): Promise<OfficeSurfaceParentPayloadV1> {
  try {
    if (request.type === 'VIEWER_GATEWAY_READ_REQUEST') {
      const result = await ipcClient.invoke('xiaogui.officeSurface.gateway.snapshot.read', { sessionId })
      if (!isGatewayReadResult(result)) throw new Error('OFFICE_GATEWAY_PROXY_INVALID_RESULT')
      return {
        type: 'PARENT_GATEWAY_RESPONSE',
        requestId: request.requestId,
        ok: true,
        headSha256: result.headSha256,
        snapshot: result.snapshot,
      }
    }
    const result = await ipcClient.invoke('xiaogui.officeSurface.gateway.snapshot.write', {
      sessionId,
      expectedHeadSha256: request.expectedHeadSha256,
      snapshot: request.snapshot,
    })
    if (!isGatewayWriteResult(result)) throw new Error('OFFICE_GATEWAY_PROXY_INVALID_RESULT')
    return {
      type: 'PARENT_GATEWAY_RESPONSE',
      requestId: request.requestId,
      ok: true,
      headSha256: result.headSha256,
    }
  } catch (error) {
    const failure = sanitizeGatewayFailure(error)
    return {
      type: 'PARENT_GATEWAY_RESPONSE',
      requestId: request.requestId,
      ok: false,
      errorCode: failure.code,
      message: failure.message,
    }
  }
}

function isGatewayReadResult(value: unknown): value is {
  headSha256: string
  snapshot: Record<string, unknown>
} {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return isDigest(result.headSha256)
    && Boolean(result.snapshot)
    && typeof result.snapshot === 'object'
    && !Array.isArray(result.snapshot)
}

function isGatewayWriteResult(value: unknown): value is { headSha256: string } {
  return Boolean(value)
    && typeof value === 'object'
    && isDigest((value as Record<string, unknown>).headSha256)
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function sanitizeGatewayFailure(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes('OFFICE_WORKTREE_CONFLICT')) {
    return { code: 'OFFICE_WORKTREE_CONFLICT', message: '文档工作副本已经变化，请重新载入。' }
  }
  if (raw.includes('OFFICE_SURFACE_SESSION_NOT_FOUND')) {
    return { code: 'OFFICE_SURFACE_SESSION_NOT_FOUND', message: '文档会话已经关闭，请重新打开。' }
  }
  return { code: 'OFFICE_GATEWAY_PROXY_FAILED', message: '主进程文档代理暂时不可用。' }
}
