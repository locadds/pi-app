import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'

import type { C2InstallPublicStateV1 } from '@shared/xiaogui-c2-artifact'
import { ipcClient, onC2InstallState } from '@renderer/lib/ipc-client'

export function C2ArtifactInstallDialog() {
  const titleId = useId()
  const [state, setState] = useState<C2InstallPublicStateV1>({ phase: 'IDLE' })

  useEffect(() => {
    const unsubscribe = onC2InstallState(setState)
    void ipcClient.invoke('xiaogui.c2.status').then((value) => setState(value as C2InstallPublicStateV1)).catch(() => {})
    return unsubscribe
  }, [])

  const preview = state.phase === 'AWAITING_CONFIRMATION' || state.phase === 'INSTALLING'
    ? state.preview
    : null
  if (state.phase === 'IDLE' || state.phase === 'CANCELLED') return null

  const confirm = async () => {
    if (!preview) return
    setState({ phase: 'INSTALLING', preview })
    const next = await ipcClient.invoke('xiaogui.c2.confirm', { installIntentId: preview.installIntentId })
    setState(next as C2InstallPublicStateV1)
  }
  const cancel = async () => {
    if (!preview) {
      setState({ phase: 'IDLE' })
      return
    }
    const next = await ipcClient.invoke('xiaogui.c2.cancel', { installIntentId: preview.installIntentId })
    setState(next as C2InstallPublicStateV1)
  }

  return createPortal(
    <div className="electron-no-drag fixed inset-0 z-[720] flex items-center justify-center bg-black/45 p-4" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex max-h-[min(88vh,680px)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <div className="border-b border-border/60 px-5 py-4">
          <h2 id={titleId} className="text-[16px] font-semibold tracking-tight">安装小规制品</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">确认前不会领取、下载或安装。</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[13px]">
          {state.phase === 'PREVIEWING' ? <p>正在读取制品信息…</p> : null}
          {preview ? (
            <div className="space-y-3">
              <div>
                <div className="font-medium text-foreground">{preview.release.name}</div>
                <div className="mt-1 text-muted-foreground">{preview.release.kind} · {preview.release.version}</div>
              </div>
              {preview.release.summary ? <p className="leading-relaxed text-foreground/90">{preview.release.summary}</p> : null}
              <div>
                <div className="mb-1 font-medium">权限</div>
                {preview.release.permissions.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {preview.release.permissions.map((permission) => <li key={permission}>{permission}</li>)}
                  </ul>
                ) : <p className="text-muted-foreground">未声明额外权限</p>}
              </div>
              <p className="text-[12px] text-muted-foreground">最低小规版本 {preview.release.compatibility.minXiaoguiVersion}；适用模式 {preview.release.compatibility.supportedModes.join(' / ')}</p>
            </div>
          ) : null}
          {state.phase === 'INSTALLED' ? (
            <p><span className="font-medium">{state.installed.name}</span> {state.installed.version} 已安装。{state.installed.kind === 'APP' ? '静态应用请从院内社区浏览器打开。' : ''}</p>
          ) : null}
          {state.phase === 'FAILED' ? (
            <p className="text-destructive">{failureMessage(state.code)}</p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/20 px-4 py-3">
          {state.phase === 'AWAITING_CONFIRMATION' ? (
            <>
              <button type="button" onClick={() => void cancel()} className="rounded-lg border border-border px-3 py-1.5 text-[13px] hover:bg-accent/50">取消</button>
              <button type="button" onClick={() => void confirm()} className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:opacity-90">确认安装</button>
            </>
          ) : null}
          {state.phase === 'INSTALLING' || state.phase === 'PREVIEWING' ? <span className="text-[13px] text-muted-foreground">处理中…</span> : null}
          {state.phase === 'INSTALLED' || state.phase === 'FAILED' ? (
            <button type="button" onClick={() => setState({ phase: 'IDLE' })} className="rounded-lg border border-border px-3 py-1.5 text-[13px] hover:bg-accent/50">关闭</button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function failureMessage(code: Extract<C2InstallPublicStateV1, { phase: 'FAILED' }>['code']): string {
  if (code === 'CREDENTIALS_UNAVAILABLE') return '尚未连接可用的 Hub 设备，请先在协作中枢完成连接。'
  if (code === 'PREVIEW_FAILED') return '无法读取安装预览；安装意图可能已过期或不属于当前设备。'
  if (code === 'CANCEL_FAILED') return '取消失败；安装尚未开始，请稍后重试。'
  return '安装未完成；制品验证、兼容性或下载检查未通过。'
}
