import { useEffect, useState } from 'react'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import { ipcClient } from '@renderer/lib/ipc-client'

type WorkerState = 'UNCONFIGURED' | 'READY' | 'OFFLINE' | 'AUTHENTICATION_FAILED' | 'NODE_REVOKED'

interface WorkerStatus {
  configured: boolean
  state: WorkerState
  lastSyncedAt: string | null
  pendingReceiptCount: number
}

interface InboxItem {
  assignmentId: string
  title: string
  taskContent: string
  constraints: readonly string[]
  acceptanceRequirements: readonly string[]
  attachmentCount: number
  mode: 'DIRECT' | 'POOL'
  decisionState: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'RETURNED'
  hubDeliveryState: 'QUEUED' | 'NODE_STORED' | 'OPENED'
  executionState: 'NOT_STARTED' | 'RUNNING' | 'RESULT_READY' | 'COMPLETED' | 'FAILED' | 'OUTCOME_UNKNOWN'
  openedAt: string | null
  receiptPendingSync: boolean
  localPlanDraftCreated: boolean
}

type HubWorkerResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string }

const STATUS_TEXT: Record<WorkerState, string> = {
  UNCONFIGURED: '尚未连接院内 Hub',
  READY: '可收取任务',
  OFFLINE: 'Hub 暂时不可连接',
  AUTHENTICATION_FAILED: '账号登录已失效',
  NODE_REVOKED: '这台小规已被新设备替换',
}

const DECISION_TEXT: Record<InboxItem['decisionState'], string> = {
  PENDING: '待决定',
  ACCEPTED: '已接受',
  REJECTED: '已拒绝',
  RETURNED: '已退回任务池',
}

/**
 * Reuses the existing right-side collaboration panel. Task data is opened in
 * this explicit inbox and becomes only an approval-gated local plan draft;
 * it never starts an Agent, creates a worktree, or applies a change.
 */
export function HubTaskInboxSection({
  address,
  onPlanDraftCreated,
}: {
  address: HubAddressV1
  onPlanDraftCreated: () => void
}) {
  const canInvoke = typeof window !== 'undefined' && typeof window.piDesktop?.invoke === 'function'
  const [status, setStatus] = useState<WorkerStatus | null>(null)
  const [items, setItems] = useState<InboxItem[]>([])
  const [endpoint, setEndpoint] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openedAssignmentId, setOpenedAssignmentId] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    if (!canInvoke) return
    const nextStatus = await invoke<WorkerStatus>('xiaogui.hubTask.status')
    if (!nextStatus.ok) {
      setError(errorText(nextStatus.code))
      return
    }
    setStatus(nextStatus.value)
    if (!nextStatus.value.configured) {
      setItems([])
      return
    }
    const inbox = await invoke<InboxItem[]>('xiaogui.hubTask.inbox.list')
    if (!inbox.ok) {
      setError(errorText(inbox.code))
      return
    }
    setItems(inbox.value)
  }

  useEffect(() => {
    void reload()
    // `ipcClient` is a stable singleton; load once and refresh only after an
    // explicit user action to avoid background Renderer polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canInvoke])

  if (!canInvoke) return null

  const connect = async (): Promise<void> => {
    setBusy('connect')
    setError(null)
    try {
      const result = await invoke<WorkerStatus>('xiaogui.hubTask.connect', { endpoint, username, password })
      if (!result.ok) {
        setError(errorText(result.code))
        return
      }
      setStatus(result.value)
      setPassword('')
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const refresh = async (): Promise<void> => {
    setBusy('refresh')
    setError(null)
    try {
      const result = await invoke<WorkerStatus>('xiaogui.hubTask.refresh')
      if (!result.ok) {
        setError(errorText(result.code))
        // The main process may have cleared credentials and cached packages
        // after a revoked node response. Read its authoritative local status
        // immediately so the Renderer never leaves stale task content visible.
        await reload()
      } else {
        setStatus(result.value)
        await reload()
      }
    } finally {
      setBusy(null)
    }
  }

  const open = async (assignmentId: string): Promise<void> => {
    setBusy(`open:${assignmentId}`)
    setError(null)
    try {
      const result = await invoke<InboxItem>('xiaogui.hubTask.inbox.open', { assignmentId })
      if (!result.ok) {
        setError(errorText(result.code))
        return
      }
      setOpenedAssignmentId(assignmentId)
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const decide = async (assignmentId: string, decision: 'ACCEPT' | 'REJECT'): Promise<void> => {
    setBusy(`${decision}:${assignmentId}`)
    setError(null)
    try {
      const result = await invoke<InboxItem>('xiaogui.hubTask.inbox.decision', { assignmentId, decision })
      if (!result.ok) setError(errorText(result.code))
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const returnToPool = async (assignmentId: string): Promise<void> => {
    setBusy(`return:${assignmentId}`)
    setError(null)
    try {
      const result = await invoke<InboxItem>('xiaogui.hubTask.inbox.return', { assignmentId })
      if (!result.ok) setError(errorText(result.code))
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const createPlanDraft = async (assignmentId: string): Promise<void> => {
    setBusy(`draft:${assignmentId}`)
    setError(null)
    try {
      const result = await invoke<{ localPlanDraftCreated: true }>('xiaogui.hubTask.inbox.createPlanDraft', { assignmentId, address })
      if (!result.ok) {
        setError(errorText(result.code))
        return
      }
      await reload()
      onPlanDraftCreated()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mb-3 rounded-lg border border-border/50 p-2.5" data-testid="hub-task-inbox">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-[12px] font-medium text-foreground">Hub 任务收件箱</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {status ? STATUS_TEXT[status.state] : '正在读取收件箱状态…'}
          </p>
        </div>
        {status?.configured && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void refresh()}
            className="rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-foreground-secondary hover:bg-accent disabled:opacity-40"
          >
            {busy === 'refresh' ? '同步中…' : '同步'}
          </button>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive" role="alert">
          {error}
        </div>
      )}

      {!status?.configured ? (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
        >
          <div className="text-[11px] text-muted-foreground">
            登录后会把该账号原先绑定的小规节点替换为此设备；密钥只保存于本机系统加密区。
          </div>
          <label className="flex flex-col gap-1 text-[11px] text-foreground-secondary">
            Hub 地址
            <input
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="http://hub.intranet:3000"
              autoComplete="url"
              required
              className="rounded-md border border-border/60 bg-background px-2 py-1 text-[12px] text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-foreground-secondary">
            Hub 用户名
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
              className="rounded-md border border-border/60 bg-background px-2 py-1 text-[12px] text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-foreground-secondary">
            密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              className="rounded-md border border-border/60 bg-background px-2 py-1 text-[12px] text-foreground"
            />
          </label>
          <button
            type="submit"
            disabled={busy !== null}
            className="rounded-md bg-primary px-3 py-1.5 text-[12px] text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            {busy === 'connect' ? '正在登录并配对…' : '登录并配对此小规'}
          </button>
        </form>
      ) : (
        <>
          {status.pendingReceiptCount > 0 && (
            <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">
              有 {status.pendingReceiptCount} 条本机签名回执等待 Hub 验证同步；联网后会按顺序重试。
            </div>
          )}
          {items.length === 0 ? (
            <div className="mt-2 text-[11px] text-muted-foreground">当前没有分配给此小规的任务。</div>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {items.map((item) => {
                const opened = openedAssignmentId === item.assignmentId || item.openedAt !== null
                return (
                  <li key={item.assignmentId} className="rounded-md border border-border/40 p-2" data-testid="hub-task-inbox-item">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 text-[12px] font-medium text-foreground">{item.title}</div>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{DECISION_TEXT[item.decisionState]}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {item.mode === 'DIRECT' ? '定向任务' : '任务池任务'} · {deliveryText(item)}
                    </div>
                    {!opened ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void open(item.assignmentId)}
                        className="mt-2 rounded-md border border-border/60 px-2 py-1 text-[11px] text-foreground-secondary hover:bg-accent disabled:opacity-40"
                      >
                        {busy === `open:${item.assignmentId}` ? '正在打开…' : '打开任务'}
                      </button>
                    ) : (
                      <div className="mt-2">
                        <div className="whitespace-pre-wrap text-[11px] text-foreground-secondary">{item.taskContent}</div>
                        {item.constraints.length > 0 && <TextList title="约束" values={item.constraints} />}
                        {item.acceptanceRequirements.length > 0 && <TextList title="验收要求" values={item.acceptanceRequirements} />}
                        {item.attachmentCount > 0 && <div className="mt-1 text-[10px] text-muted-foreground">含 {item.attachmentCount} 个受控附件引用</div>}
                        {item.receiptPendingSync && <div className="mt-1 text-[10px] text-amber-800 dark:text-amber-200">已在本机记录打开时间，等待 Hub 验证回执。</div>}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {item.mode === 'DIRECT' && item.decisionState === 'PENDING' && (
                            <>
                              <button type="button" disabled={busy !== null} onClick={() => void decide(item.assignmentId, 'ACCEPT')} className="rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground hover:bg-primary/90 disabled:opacity-40">接受任务</button>
                              <button type="button" disabled={busy !== null} onClick={() => void decide(item.assignmentId, 'REJECT')} className="rounded-md border border-border/60 px-2 py-1 text-[11px] text-foreground-secondary hover:bg-accent disabled:opacity-40">拒绝</button>
                            </>
                          )}
                          {item.mode === 'POOL' && item.decisionState === 'ACCEPTED' && (
                            <button type="button" disabled={busy !== null} onClick={() => void returnToPool(item.assignmentId)} className="rounded-md border border-border/60 px-2 py-1 text-[11px] text-foreground-secondary hover:bg-accent disabled:opacity-40">退回任务池</button>
                          )}
                          {item.decisionState === 'ACCEPTED' && item.executionState === 'NOT_STARTED' && !item.localPlanDraftCreated && (
                            <button type="button" disabled={busy !== null} onClick={() => void createPlanDraft(item.assignmentId)} className="rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground hover:bg-primary/90 disabled:opacity-40">生成本机计划草稿</button>
                          )}
                          {item.localPlanDraftCreated && <span className="text-[11px] text-muted-foreground">本机计划草稿已创建，等待人工批准。</span>}
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

function TextList({ title, values }: { title: string; values: readonly string[] }) {
  return (
    <div className="mt-1 text-[10px] text-muted-foreground">
      <span className="font-medium">{title}：</span>{values.join('；')}
    </div>
  )
}

function deliveryText(item: InboxItem): string {
  if (item.hubDeliveryState === 'OPENED') return 'Hub 已确认送达'
  if (item.receiptPendingSync) return '打开回执待 Hub 验证'
  return '尚未获 Hub 确认送达'
}

async function invoke<T>(method: string, request?: unknown): Promise<HubWorkerResult<T>> {
  try {
    const value = await ipcClient.invoke(method, request)
    return isWorkerResult<T>(value) ? value : { ok: false, code: 'HUB_WORKER_CONNECTION_FAILED' }
  } catch {
    return { ok: false, code: 'HUB_WORKER_CONNECTION_FAILED' }
  }
}

function isWorkerResult<T>(value: unknown): value is HubWorkerResult<T> {
  return Boolean(value && typeof value === 'object' && 'ok' in value && typeof (value as { ok?: unknown }).ok === 'boolean')
}

function errorText(code: string): string {
  switch (code) {
    case 'HUB_WORKER_AUTHENTICATION_FAILED':
      return 'Hub 登录已失效或用户名、密码错误，请重新登录并配对此小规。'
    case 'HUB_WORKER_CREDENTIAL_STORAGE_UNAVAILABLE':
      return '系统加密不可用，不能保存节点凭据。'
    case 'HUB_WORKER_NODE_REVOKED':
      return '这台小规已被新设备替换，已锁定本地任务内容。'
    case 'HUB_WORKER_STATE_CONFLICT':
      return '任务或回执状态已发生变化，本机连接、收件箱和签名回执均已保留；请同步后再操作。'
    case 'HUB_WORKER_UNCONFIGURED':
      return '请先登录并配对此小规。'
    case 'HUB_ASSIGNMENT_NOT_READY':
      return '该任务当前不能执行此操作，请先同步。'
    case 'HUB_LOCAL_PLAN_DRAFT_FAILED':
      return '未能创建本机计划草稿，请检查当前会话后重试。'
    default:
      return '无法连接 Hub 或同步任务，请稍后重试。'
  }
}
