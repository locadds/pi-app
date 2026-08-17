import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import type { WorkDocxOperationIdV1 } from '@shared/xiaogui-work-docx'

import { FileText, Loader2, X } from '@renderer/components/icons'
import { useUIStore } from '@renderer/stores/ui-store'
import { useXiaoguiStore } from '../stores/xiaogui-store'
import {
  cancelWorkDocx,
  confirmWorkDocx,
  discoverWorkDocx,
  prepareWorkDocx,
  shortWorkDocxDigest,
} from '../lib/work-docx-client'

type PreparedDocx = {
  address: SessionAddressV1
  addressKey: string
  operationId: WorkDocxOperationIdV1
  templateDisplayName: string
  payloadDisplayName: string
  placeholders: readonly string[]
  templateSha256: string
  payloadSha256: string
}

type PanelState =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'prepared'; prepared: PreparedDocx; cancelError?: string }
  | { kind: 'cancelling'; prepared: PreparedDocx }
  | { kind: 'confirming'; prepared: PreparedDocx }
  | { kind: 'success'; outputSha256: string; templateSha256: string; payloadSha256: string }
  | { kind: 'error'; message: string }

function addressKey(address: SessionAddressV1): string {
  return `${address.projectId}:${address.sessionKey}`
}

function sameAddress(a: SessionAddressV1 | null, key: string): boolean {
  return a != null && addressKey(a) === key
}

function currentWorkAddress(): SessionAddressV1 | null {
  if (useXiaoguiStore.getState().mode !== 'WORK') return null
  const state = useUIStore.getState()
  const scope = state.sessions.find((session) => session.sessionId === state.currentSessionId)?.canonicalScope
  if (!scope || scope.sessionMode !== 'WORK') return null
  return { projectId: scope.projectId, sessionKey: scope.sessionKey }
}

export function ComposerWorkDocxButton() {
  const mode = useXiaoguiStore((s) => s.mode)
  const currentSessionId = useUIStore((s) => s.currentSessionId)
  const sessions = useUIStore((s) => s.sessions)
  const [panel, setPanel] = useState<PanelState>({ kind: 'idle' })
  const requestSeq = useRef(0)
  const busyRef = useRef(false)
  const preparedRef = useRef<PreparedDocx | null>(null)
  const cancelled = useRef(new Set<WorkDocxOperationIdV1>())

  const address = useMemo(() => {
    const scope = sessions.find((session) => session.sessionId === currentSessionId)?.canonicalScope
    if (!scope || scope.sessionMode !== 'WORK') return null
    return { projectId: scope.projectId, sessionKey: scope.sessionKey }
  }, [currentSessionId, sessions])
  const key = address ? addressKey(address) : ''
  const activeKey = mode === 'WORK' ? key : ''
  const previousActiveKey = useRef(activeKey)

  const cancelPrepared = useCallback((prepared: PreparedDocx | null) => {
    if (!prepared || cancelled.current.has(prepared.operationId)) return
    cancelled.current.add(prepared.operationId)
    void cancelWorkDocx(prepared.address, prepared.operationId)
  }, [])

  useEffect(() => {
    if (previousActiveKey.current === activeKey) return
    previousActiveKey.current = activeKey
    requestSeq.current += 1
    busyRef.current = false
    const prepared = preparedRef.current
    preparedRef.current = null
    cancelPrepared(prepared)
    setPanel({ kind: 'idle' })
  }, [activeKey, cancelPrepared])

  useEffect(() => {
    return () => {
      const prepared = preparedRef.current
      preparedRef.current = null
      cancelPrepared(prepared)
    }
  }, [cancelPrepared])

  if (mode !== 'WORK') return null

  const enabled = address != null
  const busy = panel.kind === 'preparing' || panel.kind === 'cancelling' || panel.kind === 'confirming'

  const startPrepare = async () => {
    if (!address || panel.kind !== 'idle' || busyRef.current) return
    busyRef.current = true
    const seq = ++requestSeq.current
    const startAddress = address
    const startKey = addressKey(startAddress)
    setPanel({ kind: 'preparing' })

    const discovered = await discoverWorkDocx(startAddress)
    if (requestSeq.current !== seq || !sameAddress(currentWorkAddress(), startKey)) return
    if (!discovered.ok) {
      busyRef.current = false
      setPanel({ kind: 'error', message: discovered.message })
      return
    }

    const prepared = await prepareWorkDocx(startAddress)
    if (requestSeq.current !== seq || !sameAddress(currentWorkAddress(), startKey)) {
      if (prepared.ok && prepared.value.kind === 'PREPARED') {
        cancelPrepared({
          address: startAddress,
          addressKey: startKey,
          operationId: prepared.value.operationId,
          templateDisplayName: prepared.value.templateDisplayName,
          payloadDisplayName: prepared.value.payloadDisplayName,
          placeholders: prepared.value.placeholders,
          templateSha256: prepared.value.templateSha256,
          payloadSha256: prepared.value.payloadSha256,
        })
      }
      return
    }
    if (!prepared.ok) {
      busyRef.current = false
      setPanel({ kind: 'error', message: prepared.message })
      return
    }
    if (prepared.value.kind === 'CANCELLED') {
      busyRef.current = false
      setPanel({ kind: 'idle' })
      return
    }

    const next: PreparedDocx = {
      address: startAddress,
      addressKey: startKey,
      operationId: prepared.value.operationId,
      templateDisplayName: prepared.value.templateDisplayName,
      payloadDisplayName: prepared.value.payloadDisplayName,
      placeholders: prepared.value.placeholders,
      templateSha256: prepared.value.templateSha256,
      payloadSha256: prepared.value.payloadSha256,
    }
    preparedRef.current = next
    busyRef.current = false
    setPanel({ kind: 'prepared', prepared: next })
  }

  const closePanel = () => setPanel({ kind: 'idle' })

  const cancelPanel = async () => {
    if (panel.kind !== 'prepared' || busyRef.current) return
    busyRef.current = true
    const seq = ++requestSeq.current
    cancelled.current.add(panel.prepared.operationId)
    setPanel({ kind: 'cancelling', prepared: panel.prepared })
    const result = await cancelWorkDocx(panel.prepared.address, panel.prepared.operationId)
    if (requestSeq.current !== seq || !sameAddress(currentWorkAddress(), panel.prepared.addressKey)) return
    busyRef.current = false
    if (!result.ok) {
      cancelled.current.delete(panel.prepared.operationId)
      preparedRef.current = panel.prepared
      setPanel({ kind: 'prepared', prepared: panel.prepared, cancelError: result.message })
      return
    }
    preparedRef.current = null
    setPanel({ kind: 'idle' })
  }

  const confirmPrepared = async () => {
    if (panel.kind !== 'prepared' || busyRef.current) return
    busyRef.current = true
    const prepared = panel.prepared
    preparedRef.current = null
    const seq = ++requestSeq.current
    setPanel({ kind: 'confirming', prepared })
    const result = await confirmWorkDocx(prepared.address, prepared.operationId)
    if (requestSeq.current !== seq || !sameAddress(currentWorkAddress(), prepared.addressKey)) return
    if (!result.ok) {
      busyRef.current = false
      setPanel({ kind: 'error', message: result.message })
      return
    }
    busyRef.current = false
    setPanel({
      kind: 'success',
      outputSha256: result.value.outputSha256,
      templateSha256: result.value.templateSha256,
      payloadSha256: result.value.payloadSha256,
    })
  }

  return (
    <>
      <button
        type="button"
        disabled={!enabled || panel.kind !== 'idle'}
        title={enabled ? '生成 DOCX 文档' : '请先进入 WORK 会话'}
        aria-label="生成 DOCX 文档"
        onClick={startPrepare}
        className="composer-toolbar-btn flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground-secondary/70 disabled:opacity-30"
      >
        {busy ? <Loader2 className="h-[15px] w-[15px] animate-spin" strokeWidth={2} /> : <FileText className="h-[15px] w-[15px]" strokeWidth={2} />}
      </button>

      {panel.kind === 'prepared' && (
        <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/30 px-4" role="dialog" aria-modal="true" aria-label="确认生成 DOCX">
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">确认生成 DOCX</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  小规已读取模板和 JSON 数据。确认后会另存为新文件，原模板和原数据不会被修改。
                </p>
              </div>
              <button type="button" aria-label="关闭" onClick={cancelPanel} className="rounded-md p-1 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3 text-xs">
              <div className="grid gap-1 text-muted-foreground">
                <span>模板：{panel.prepared.templateDisplayName}</span>
                <span>数据：{panel.prepared.payloadDisplayName}</span>
              </div>
              <div className="font-medium text-foreground">待填字段（{panel.prepared.placeholders.length} 个）</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {panel.prepared.placeholders.map((placeholder) => (
                  <span key={placeholder} className="rounded border border-border bg-background px-1.5 py-0.5 text-muted-foreground">
                    {placeholder}
                  </span>
                ))}
              </div>
              <div className="mt-3 grid gap-1 text-muted-foreground">
                <span>模板摘要：{shortWorkDocxDigest(panel.prepared.templateSha256)}</span>
                <span>数据摘要：{shortWorkDocxDigest(panel.prepared.payloadSha256)}</span>
              </div>
              {panel.cancelError && <p className="mt-3 text-destructive">{panel.cancelError} 你可以重试取消，或继续确认生成。</p>}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={cancelPanel} className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground">
                取消
              </button>
              <button type="button" onClick={confirmPrepared} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
                确认生成
              </button>
            </div>
          </div>
        </div>
      )}

      {(panel.kind === 'cancelling' || panel.kind === 'confirming') && (
        <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/30 px-4" role="status" aria-label={panel.kind === 'cancelling' ? '正在取消 DOCX' : '正在生成 DOCX'}>
          <div className="rounded-lg border border-border bg-background px-4 py-3 text-sm shadow-xl">
            {panel.kind === 'cancelling' ? '正在清理本次准备内容...' : '正在另存为新文件...'}
          </div>
        </div>
      )}

      {panel.kind === 'success' && (
        <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/30 px-4" role="dialog" aria-modal="true" aria-label="DOCX 已生成">
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-xl">
            <h2 className="text-sm font-semibold text-foreground">DOCX 已生成</h2>
            <div className="mt-2 grid gap-1.5 text-xs leading-relaxed text-muted-foreground">
              <span>已另存为新文件。</span>
              <span>结构检查通过。</span>
              <span>原模板和原数据未修改。</span>
              <span>输出摘要：{shortWorkDocxDigest(panel.outputSha256)}</span>
            </div>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={closePanel} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {panel.kind === 'error' && (
        <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/30 px-4" role="alertdialog" aria-modal="true" aria-label="DOCX 生成失败">
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-xl">
            <h2 className="text-sm font-semibold text-foreground">暂时不能生成</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{panel.message}</p>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={closePanel} className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground">
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
