import { useEffect, useState } from 'react'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import { ipcClient } from '@renderer/lib/ipc-client'

type WorkerState = 'UNCONFIGURED' | 'READY' | 'OFFLINE' | 'AUTHENTICATION_FAILED' | 'NODE_REVOKED'
type WorkerStatus = { configured: boolean; state: WorkerState; lastSyncedAt?: string | null; pendingReceiptCount?: number }
type WorkerResult<T> = { ok: true; value: T } | { ok: false; code: string }
type AcceptAndExecuteExecutionState = 'PREPARED' | 'STARTED' | 'ALREADY_STARTED' | 'ASSOCIATION_RECOVERED'
type InboxItem = {
  assignmentId: string
  title: string
  taskContent: string
  mode: 'DIRECT' | 'POOL'
  decisionState: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'RETURNED'
  executionState: 'NOT_STARTED' | 'RUNNING' | 'RESULT_READY' | 'COMPLETED' | 'FAILED' | 'OUTCOME_UNKNOWN'
  openedAt: string | null
  receiptPendingSync: boolean
  localPlanDraftCreated: boolean
  acceptAndExecuteV2?: {
    state: 'AVAILABLE' | 'BOUND'
    requestId: string
    observedPackageSha256: string
    phase: 'BOUND' | 'HUB_ACCEPTED' | 'ASSOCIATED' | 'EXECUTION_REQUESTED' | null
    projectId?: HubAddressV1['projectId']
    sessionKey?: HubAddressV1['sessionKey']
    executionState?: AcceptAndExecuteExecutionState
    flowId?: string
    revisionId?: string
    attemptId?: string
  }
}

export type HubTaskV2FlowBinding = {
  projectId: HubAddressV1['projectId']
  sessionKey: HubAddressV1['sessionKey']
  flowId: string
  revisionId: string
  attemptId?: string
}

const STATUS_TEXT: Record<WorkerState, string> = {
  UNCONFIGURED: '尚未连接院内 Hub',
  READY: '可收取任务',
  OFFLINE: 'Hub 暂时不可连接',
  AUTHENTICATION_FAILED: '账号登录已失效',
  NODE_REVOKED: '这台小规已被新设备替换',
}

export function HubTaskInboxSection({
  address,
  targetProjectLabel,
  targetProjectPath,
  onPlanDraftCreated,
  onV2ExecutionResult,
  onV2FlowBindingsChange,
}: {
  address?: HubAddressV1
  targetProjectLabel?: string
  targetProjectPath?: string
  onPlanDraftCreated?: () => void
  onV2ExecutionResult?: () => void | Promise<void>
  onV2FlowBindingsChange?: (bindings: readonly HubTaskV2FlowBinding[]) => void
} = {}) {
  const [status, setStatus] = useState<WorkerStatus | null>(null)
  const [items, setItems] = useState<InboxItem[]>([])
  const [endpoint, setEndpoint] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeTone, setNoticeTone] = useState<'success' | 'warning'>('success')
  const [showCredentials, setShowCredentials] = useState(false)

  const reload = async () => {
    const result = await invoke<WorkerStatus>('xiaogui.hubTask.status')
    if (!result.ok) return
    setStatus(result.value)
    if (!result.value.configured || !address) {
      setItems([])
      onV2FlowBindingsChange?.([])
      return
    }
    const inbox = await invoke<InboxItem[]>('xiaogui.hubTask.inbox.list')
    if (inbox.ok) {
      setItems(inbox.value)
      onV2FlowBindingsChange?.(projectV2FlowBindings(inbox.value))
    }
  }
  useEffect(() => { void reload() }, [address?.projectId, address?.sessionKey])

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await invoke<WorkerStatus>('xiaogui.hubTask.connect', { endpoint, username, password })
      if (result.ok) {
        setStatus(result.value)
        setPassword('')
        setShowCredentials(false)
        setItems([])
        if (address) await reload()
      } else {
        setError(errorText(result.code))
      }
    } finally {
      setBusy(false)
    }
  }

  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await invoke<WorkerStatus>('xiaogui.hubTask.refresh')
      if (result.ok) {
        setStatus(result.value)
        await reload()
      } else {
        setError(errorText(result.code))
        await reload()
      }
    } finally {
      setBusy(false)
    }
  }

  const open = async (assignmentId: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await invoke<InboxItem>('xiaogui.hubTask.inbox.open', { assignmentId })
      if (!result.ok) return setError(errorText(result.code))
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const decide = async (assignmentId: string, decision: 'ACCEPT' | 'REJECT') => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await invoke<InboxItem>('xiaogui.hubTask.inbox.decision', { assignmentId, decision })
      if (!result.ok) setError(errorText(result.code))
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const returnToPool = async (assignmentId: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await invoke<InboxItem>('xiaogui.hubTask.inbox.return', { assignmentId })
      if (!result.ok) setError(errorText(result.code))
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const createPlanDraft = async (assignmentId: string) => {
    if (!address) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await invoke<{ localPlanDraftCreated: true }>('xiaogui.hubTask.inbox.createPlanDraft', { assignmentId, address })
      if (!result.ok) return setError(errorText(result.code))
      await reload()
      onPlanDraftCreated?.()
    } finally {
      setBusy(false)
    }
  }

  const acceptAndExecute = async (item: InboxItem) => {
    if (!address) {
      setError('请先打开一个工作、规划设计或编程会话，选择目标项目后再执行任务。')
      return
    }
    const binding = item.acceptAndExecuteV2
    if (!binding) {
      setError('该任务没有可复用的一次接受绑定，请先同步收件箱。')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await invoke<{
        executionState: AcceptAndExecuteExecutionState
        actualAttemptStatus?: string
        flowId?: string
        revisionId?: string
        attemptId?: string
      }>(
        'xiaogui.hubTask.inbox.acceptAndExecute',
        {
          assignmentId: item.assignmentId,
          address,
          observedPackageSha256: binding.observedPackageSha256,
          requestId: binding.requestId,
        },
      )
      if (!result.ok) {
        setError(errorText(result.code))
        if (result.code === 'HUB_EXECUTION_OUTCOME_UNKNOWN') {
          await reload()
          await onV2ExecutionResult?.()
        }
        return
      }
      const recovered = result.value.executionState === 'ASSOCIATION_RECOVERED'
      setNotice(executionStateText(result.value.executionState, result.value.actualAttemptStatus))
      setNoticeTone(recovered || ['OUTCOME_UNKNOWN', 'FAILED', 'INTERRUPTED', 'CANCELLED'].includes(result.value.actualAttemptStatus ?? '')
        ? 'warning'
        : 'success')
      await reload()
      await onV2ExecutionResult?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mb-3 rounded-lg border border-border/50 p-2.5" data-testid="hub-task-inbox">
      <div className="text-[12px] font-medium text-foreground">Hub 账号连接</div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{status ? STATUS_TEXT[status.state] : '正在读取连接状态…'}</p>
      {status?.configured && !showCredentials ? (
        <>
          <div className="mt-2 flex items-center gap-2">
            {address && <button type="button" disabled={busy} onClick={() => void refresh()} className="rounded-md border border-border/60 px-2 py-1 text-[11px] disabled:opacity-40">同步</button>}
            <button type="button" disabled={busy} onClick={() => setShowCredentials(true)} className="rounded-md border border-border/60 px-2 py-1 text-[11px] disabled:opacity-40">重新登录并配对此小规</button>
          </div>
          {!address ? <p className="mt-2 text-[11px] text-muted-foreground">打开一个工作、规划设计或编程会话后选择目标项目，才能执行收件箱任务。</p> : <>
          {(status.pendingReceiptCount ?? 0) > 0 && <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-200">有 {status.pendingReceiptCount} 条签名回执等待 Hub 验证同步。</p>}
          {items.length === 0 ? <p className="mt-2 text-[11px] text-muted-foreground">当前没有分配给此小规的任务。</p> : (
            <ul className="mt-2 flex flex-col gap-2">
              {items.map((item) => {
                const opened = item.openedAt !== null
                const binding = item.acceptAndExecuteV2
                const bindingMatchesAddress = Boolean(
                  address &&
                  (!binding?.projectId || binding.projectId === address.projectId) &&
                  (!binding?.sessionKey || binding.sessionKey === address.sessionKey),
                )
                const canAcceptAndExecute = Boolean(
                  address
                  && binding
                  && bindingMatchesAddress
                  && opened
                  && ['PENDING', 'ACCEPTED'].includes(item.decisionState)
                  && item.executionState === 'NOT_STARTED',
                )
                const canRecoverBoundAssociation = Boolean(
                  address
                  && binding?.state === 'BOUND'
                  && binding.projectId === address.projectId
                  && binding.sessionKey === address.sessionKey
                  && !binding.flowId
                  && !binding.revisionId
                  && opened
                  && ['PENDING', 'ACCEPTED'].includes(item.decisionState)
                  && ['RUNNING', 'RESULT_READY', 'COMPLETED', 'FAILED', 'OUTCOME_UNKNOWN'].includes(item.executionState),
                )
                return <li key={item.assignmentId} className="rounded-md border border-border/40 p-2" data-testid="hub-task-inbox-item">
                  <div className="text-[12px] font-medium text-foreground">{item.title}</div>
                  <p className="mt-1 text-[10px] text-muted-foreground">{item.mode === 'DIRECT' ? '定向任务' : '任务池任务'} · {item.decisionState}</p>
                  {!opened ? <button type="button" disabled={busy} onClick={() => void open(item.assignmentId)} className="mt-2 rounded-md border border-border/60 px-2 py-1 text-[11px] disabled:opacity-40">打开任务</button> : (
                    <>
                      <p className="mt-2 whitespace-pre-wrap text-[11px] text-foreground-secondary">{item.taskContent}</p>
                      <p
                        className="mt-1 text-[10px] text-muted-foreground"
                        title={targetProjectPath ?? undefined}
                      >
                        目标项目：{targetProjectLabel ?? (address ? '当前工作区未识别' : '未选择目标项目')}
                      </p>
                      {item.receiptPendingSync && <p className="mt-1 text-[10px] text-amber-800 dark:text-amber-200">打开回执待 Hub 验证。</p>}
                      {item.acceptAndExecuteV2?.phase === 'ASSOCIATED' && <p className="mt-1 text-[10px] text-amber-800 dark:text-amber-200">原执行关联已恢复；当前任务状态：{executionStatusText(item.executionState)}。</p>}
                      {canRecoverBoundAssociation && <p className="mt-1 text-[10px] text-amber-800 dark:text-amber-200">执行记录待恢复；当前任务状态：{executionStatusText(item.executionState)}。</p>}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {canAcceptAndExecute && <button type="button" disabled={busy} onClick={() => void acceptAndExecute(item)} className="rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground disabled:opacity-40">接受并执行</button>}
                        {canRecoverBoundAssociation && <button type="button" disabled={busy} onClick={() => void acceptAndExecute(item)} className="rounded-md border border-amber-500/60 px-2 py-1 text-[11px] text-amber-800 dark:text-amber-200 disabled:opacity-40">恢复执行记录</button>}
                        {!item.acceptAndExecuteV2 && item.mode === 'DIRECT' && item.decisionState === 'PENDING' && <button type="button" disabled={busy} onClick={() => void decide(item.assignmentId, 'ACCEPT')} className="rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground disabled:opacity-40">接受任务</button>}
                        {item.mode === 'DIRECT' && item.decisionState === 'PENDING' && <button type="button" disabled={busy} onClick={() => void decide(item.assignmentId, 'REJECT')} className="rounded-md border border-border/60 px-2 py-1 text-[11px] disabled:opacity-40">拒绝</button>}
                        {item.mode === 'POOL' && item.decisionState === 'ACCEPTED' && <button type="button" disabled={busy} onClick={() => void returnToPool(item.assignmentId)} className="rounded-md border border-border/60 px-2 py-1 text-[11px] disabled:opacity-40">退回任务池</button>}
                        {!item.acceptAndExecuteV2 && item.decisionState === 'ACCEPTED' && item.executionState === 'NOT_STARTED' && !item.localPlanDraftCreated && <button type="button" disabled={busy} onClick={() => void createPlanDraft(item.assignmentId)} className="rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground disabled:opacity-40">生成本机计划草稿</button>}
                        {!item.acceptAndExecuteV2 && item.localPlanDraftCreated && <span className="text-[11px] text-muted-foreground">本机计划草稿已创建，等待人工批准。</span>}
                      </div>
                    </>
                  )}
                </li>
              })}
            </ul>
          )}
          </>}
        </>
      ) : (
        <form className="mt-2 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void connect() }}>
          <p className="text-[11px] text-muted-foreground">登录后会配对此设备；密钥仅保存于本机系统加密区。</p>
          <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://hub.intranet:3000" autoComplete="url" required className="rounded-md border border-border/60 bg-background px-2 py-1 text-[12px]" />
          <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Hub 用户名" autoComplete="username" required className="rounded-md border border-border/60 bg-background px-2 py-1 text-[12px]" />
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" autoComplete="current-password" required className="rounded-md border border-border/60 bg-background px-2 py-1 text-[12px]" />
          <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-[12px] text-primary-foreground disabled:opacity-40">{busy ? '正在登录并配对…' : '登录并配对此小规'}</button>
        </form>
      )}
      {notice ? <p className={`mt-2 text-[11px] ${noticeTone === 'warning' ? 'text-amber-800 dark:text-amber-200' : 'text-emerald-700 dark:text-emerald-300'}`} role="status">{notice}</p> : null}
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
  if (code === 'HUB_WORKER_AUTHENTICATION_FAILED') return 'Hub 登录已失效；本机签名回执已保留，请重新登录并配对此小规。'
  if (code === 'HUB_WORKER_NODE_REVOKED') return '这台小规已被替换；本机签名回执已保留，请重新登录并配对此小规。'
  if (code === 'HUB_ASSIGNMENT_NOT_READY') return '任务尚未具备执行条件，请刷新收件箱并确认目标项目。'
  if (code === 'HUB_TARGET_PROJECT_INVALID') return '目标项目不可用，当前任务没有启动。'
  if (code === 'HUB_BASELINE_SOURCE_INVALID') return '任务基线来源不可用，当前任务没有启动。'
  if (code === 'HUB_EXECUTION_OUTCOME_UNKNOWN') return '执行结果未知，未显示成功；请查看任务状态后再处理。'
  if (code === 'HUB_EXECUTION_ALREADY_SETTLED') return '任务已有确定结果，未重复执行。'
  if (code === 'HUB_ACCEPT_AND_EXECUTE_CONFLICT') return '任务或目标绑定已变化，未重复执行；请刷新收件箱。'
  return '无法连接 Hub，请稍后重试。'
}

function executionStateText(
  state: AcceptAndExecuteExecutionState,
  actualAttemptStatus?: string,
): string {
  if (state === 'ASSOCIATION_RECOVERED') {
    return `原执行关联已恢复；当前尝试状态：${actualAttemptStatus ?? '待同步'}。`
  }
  if (actualAttemptStatus === 'OUTCOME_UNKNOWN') return '执行结果未知，未显示成功。'
  if (['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(actualAttemptStatus ?? '')) {
    return `任务已接受，但当前尝试状态为 ${actualAttemptStatus}。`
  }
  if (state === 'PREPARED') return '任务已接受，执行已准备。'
  if (state === 'ALREADY_STARTED') return '任务已接受，原执行已在继续。'
  return '任务已接受并开始执行。'
}

function projectV2FlowBindings(items: readonly InboxItem[]): HubTaskV2FlowBinding[] {
  return items.flatMap((item) => {
    const binding = item.acceptAndExecuteV2
    return binding?.state === 'BOUND'
      && binding.projectId
      && binding.sessionKey
      && binding.flowId
      && binding.revisionId
      ? [{
          projectId: binding.projectId,
          sessionKey: binding.sessionKey,
          flowId: binding.flowId,
          revisionId: binding.revisionId,
          ...(binding.attemptId ? { attemptId: binding.attemptId } : {}),
        }]
      : []
  })
}

function executionStatusText(
  state: InboxItem['executionState'],
): string {
  switch (state) {
    case 'RUNNING': return '执行中'
    case 'RESULT_READY': return '结果待审阅'
    case 'COMPLETED': return '已完成'
    case 'FAILED': return '执行失败'
    case 'OUTCOME_UNKNOWN': return '结果未知'
    case 'NOT_STARTED': return '尚未开始'
  }
}
