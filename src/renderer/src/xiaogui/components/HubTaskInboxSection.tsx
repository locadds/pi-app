import { useEffect, useState } from 'react'

import { ipcClient } from '@renderer/lib/ipc-client'

type WorkerState = 'UNCONFIGURED' | 'READY' | 'OFFLINE' | 'AUTHENTICATION_FAILED' | 'NODE_REVOKED'
type WorkerStatus = { configured: boolean; state: WorkerState }
type WorkerResult<T> = { ok: true; value: T } | { ok: false; code: string }

const STATUS_TEXT: Record<WorkerState, string> = {
  UNCONFIGURED: '尚未连接院内 Hub',
  READY: '已配置 Hub 账号连接；任务收件箱尚未开放',
  OFFLINE: 'Hub 暂时不可连接',
  AUTHENTICATION_FAILED: '账号登录已失效',
  NODE_REVOKED: '这台小规已被新设备替换',
}

/** C2 connection surface only. H1 polling, inbox and task actions are intentionally absent. */
export function HubTaskInboxSection() {
  const [status, setStatus] = useState<WorkerStatus | null>(null)
  const [endpoint, setEndpoint] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCredentials, setShowCredentials] = useState(false)

  const reload = async () => {
    const result = await invoke<WorkerStatus>('xiaogui.hubTask.status')
    if (result.ok) setStatus(result.value)
  }
  useEffect(() => { void reload() }, [])

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await invoke<WorkerStatus>('xiaogui.hubTask.connect', { endpoint, username, password })
      if (result.ok) {
        setStatus(result.value)
        setPassword('')
        setShowCredentials(false)
      } else {
        setError(errorText(result.code))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mb-3 rounded-lg border border-border/50 p-2.5" data-testid="hub-task-inbox">
      <div className="text-[12px] font-medium text-foreground">Hub 账号连接</div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{status ? STATUS_TEXT[status.state] : '正在读取连接状态…'}</p>
      {!status?.configured || showCredentials ? (
        <form className="mt-2 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void connect() }}>
          <p className="text-[11px] text-muted-foreground">登录后会配对此设备；密钥仅保存于本机系统加密区。</p>
          <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://hub.intranet:3000" autoComplete="url" required className="rounded-md border border-border/60 bg-background px-2 py-1 text-[12px]" />
          <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Hub 用户名" autoComplete="username" required className="rounded-md border border-border/60 bg-background px-2 py-1 text-[12px]" />
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" autoComplete="current-password" required className="rounded-md border border-border/60 bg-background px-2 py-1 text-[12px]" />
          <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-[12px] text-primary-foreground disabled:opacity-40">{busy ? '正在登录并配对…' : '登录并配对此小规'}</button>
        </form>
      ) : (
        <div className="mt-2 flex flex-col items-start gap-2">
          <p className="text-[11px] text-muted-foreground">本版本不收取、刷新或处理 Hub 任务。</p>
          <button type="button" onClick={() => setShowCredentials(true)} className="rounded-md border border-border/60 px-3 py-1.5 text-[12px]">重新登录并配对此小规</button>
        </div>
      )}
      {error ? <p className="mt-2 text-[11px] text-destructive" role="alert">{error}</p> : null}
    </section>
  )
}

async function invoke<T>(method: string, request?: unknown): Promise<WorkerResult<T>> {
  try {
    const value = await ipcClient.invoke(method, request)
    return value && typeof value === 'object' && 'ok' in value ? value as WorkerResult<T> : { ok: false, code: 'HUB_WORKER_CONNECTION_FAILED' }
  } catch {
    return { ok: false, code: 'HUB_WORKER_CONNECTION_FAILED' }
  }
}

function errorText(code: string): string {
  if (code === 'HUB_WORKER_CREDENTIAL_STORAGE_UNAVAILABLE') return '系统加密不可用，不能保存节点凭据。'
  if (code === 'HUB_WORKER_AUTHENTICATION_FAILED') return 'Hub 登录已失效或用户名、密码错误。'
  return '无法连接 Hub，请稍后重试。'
}
