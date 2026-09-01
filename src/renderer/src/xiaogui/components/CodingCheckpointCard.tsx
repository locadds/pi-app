import { useEffect, useState } from 'react'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import {
  codingCheckpointClient,
  type CodingCheckpointClientPortV1,
  type CodingCheckpointRestorePreviewUiV1,
  type CodingCheckpointSummaryUiV1,
} from '../lib/coding-checkpoint-client'

export function CodingCheckpointCard({
  address,
  attemptId,
  client = codingCheckpointClient,
  enabled = true,
  captureEnabled = enabled,
  restoreEnabled = enabled,
}: {
  readonly address: HubAddressV1
  readonly attemptId: string
  readonly client?: CodingCheckpointClientPortV1
  readonly enabled?: boolean
  readonly captureEnabled?: boolean
  readonly restoreEnabled?: boolean
}) {
  const [checkpoints, setCheckpoints] = useState<readonly CodingCheckpointSummaryUiV1[]>([])
  const [checkpoint, setCheckpoint] = useState<CodingCheckpointSummaryUiV1 | null>(null)
  const [preview, setPreview] = useState<CodingCheckpointRestorePreviewUiV1 | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!captureEnabled && !restoreEnabled) {
      setCheckpoints([])
      setCheckpoint(null)
      setPreview(null)
      setConfirmed(false)
      return
    }
    let active = true
    setPreview(null)
    setConfirmed(false)
    void client.list(address, attemptId).then((outcome) => {
      if (!active) return
      if (!outcome.ok) {
        setMessage('无法载入检查点列表。')
        return
      }
      const available = outcome.value.filter((item) => item.status === 'AVAILABLE')
      setCheckpoints(outcome.value)
      setCheckpoint(available.at(-1) ?? null)
    })
    return () => {
      active = false
    }
  }, [address.projectId, address.sessionKey, attemptId, client, captureEnabled, restoreEnabled])

  if (!client.availability.available) {
    return (
      <section className="mt-2 rounded-md border border-border/40 p-2 text-[11px]" aria-label="Git 检查点与恢复">
        <div className="font-medium text-foreground">Git 检查点与恢复</div>
        <div className="mt-1 text-muted-foreground">
          {client.availability.reason === 'IMPACT_SUMMARY_UNAVAILABLE'
            ? '恢复影响摘要尚不可用，检查点恢复已禁用。'
            : '检查点功能当前不可用。'}
        </div>
        <button type="button" disabled className="mt-2 rounded border border-border/40 px-2 py-1 text-muted-foreground opacity-50">
          创建检查点（不可用）
        </button>
      </section>
    )
  }

  const capture = async () => {
    if (!captureEnabled || busy) return
    setBusy(true)
    setMessage(null)
    setPreview(null)
    setConfirmed(false)
    const outcome = await client.capture(address, attemptId)
    setBusy(false)
    if (!outcome.ok) {
      setMessage('创建检查点失败。')
      return
    }
    setCheckpoints((current) => [...current, outcome.value])
    setCheckpoint(outcome.value)
    setMessage('检查点已创建。')
  }

  const prepare = async () => {
    if (!checkpoint || !restoreEnabled || busy) return
    setBusy(true)
    setMessage(null)
    setPreview(null)
    setConfirmed(false)
    const outcome = await client.prepareRestore(address, attemptId, checkpoint.checkpointRef)
    setBusy(false)
    if (!outcome.ok) {
      setMessage('无法准备恢复预览，请重新创建检查点。')
      return
    }
    if (!safePreview(outcome.value, checkpoint.checkpointRef)) {
      setMessage('恢复影响无法安全显示，已停止恢复。')
      return
    }
    setPreview(outcome.value)
  }

  const restore = async () => {
    if (!preview || !confirmed || busy) return
    setBusy(true)
    setMessage(null)
    const outcome = await client.confirmRestore(address, attemptId, preview)
    setBusy(false)
    if (!outcome.ok) {
      setPreview(null)
      setConfirmed(false)
      setMessage(outcome.error === 'OUTCOME_UNKNOWN'
        ? '恢复结果未知，已停止后续操作。'
        : '恢复失败，请重新生成影响预览。')
      return
    }
    setCheckpoint(outcome.value)
    setCheckpoints((current) => current.map((item) => (
      item.checkpointRef === outcome.value.checkpointRef ? outcome.value : item
    )))
    setPreview(null)
    setConfirmed(false)
    setMessage('已恢复到检查点。')
  }

  return (
    <section className="mt-2 rounded-md border border-border/40 p-2 text-[11px]" aria-label="Git 检查点与恢复">
      <div className="font-medium text-foreground">Git 检查点与恢复</div>
      {!captureEnabled && !restoreEnabled && <div className="mt-1 text-muted-foreground">当前执行不处于可安全恢复的就绪状态，暂不能创建或恢复检查点。</div>}
      {checkpoints.length > 0 && (
        <div className="mt-2" aria-label="检查点列表">
          <div className="text-muted-foreground">已有 {checkpoints.length} 个检查点</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {checkpoints.map((item, index) => (
              <button
                key={item.checkpointRef}
                type="button"
                disabled={item.status !== 'AVAILABLE' || busy}
                aria-pressed={checkpoint?.checkpointRef === item.checkpointRef}
                onClick={() => {
                  setCheckpoint(item)
                  setPreview(null)
                  setConfirmed(false)
                }}
                className="rounded border border-border/60 px-2 py-1 disabled:opacity-40"
              >
                检查点 {index + 1}{item.status === 'RESTORED' ? '（已恢复）' : item.status === 'INVALIDATED' ? '（已失效）' : ''}
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        disabled={!captureEnabled || busy}
        onClick={() => void capture()}
        className="mt-2 rounded border border-border/60 px-2 py-1 text-foreground-secondary disabled:opacity-40"
      >
        {busy ? '创建中…' : '创建检查点'}
      </button>
      {checkpoint && checkpoint.status === 'AVAILABLE' && !preview && (
        <button
          type="button"
          disabled={!restoreEnabled || busy}
          onClick={() => void prepare()}
          className="mt-2 rounded border border-border/60 px-2 py-1 text-foreground-secondary disabled:opacity-40"
        >
          {busy ? '准备预览中…' : '预览恢复影响'}
        </button>
      )}
      {preview && (
        <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <div className="font-medium">恢复影响</div>
          <div className="mt-1">将影响 {preview.impact.workspaceChangeCount} 个文件</div>
          {preview.impact.changedRelativePaths.length > 0 && (
            <ul className="mt-1 list-disc pl-4 font-mono text-[10px]">
              {preview.impact.changedRelativePaths.map((path) => <li key={path}>{path}</li>)}
            </ul>
          )}
          <div className="mt-1">{preview.impact.sessionEffect}</div>
          <div className="mt-1 font-medium">{preview.impact.warning}</div>
          <label className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已了解上述影响
          </label>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={!confirmed || busy}
              onClick={() => void restore()}
              className="rounded bg-destructive px-2 py-1 text-destructive-foreground disabled:opacity-40"
            >
              {busy ? '正在恢复…' : '确认恢复到此检查点'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPreview(null)
                setConfirmed(false)
              }}
              className="rounded border border-border/60 px-2 py-1"
            >
              取消恢复
            </button>
          </div>
        </div>
      )}
      {message && <div className="mt-2 text-muted-foreground">{message}</div>}
    </section>
  )
}

function safePreview(preview: CodingCheckpointRestorePreviewUiV1, checkpointRef: string): boolean {
  if (preview.checkpointRef !== checkpointRef) return false
  if (!preview.previewRef || !/^sha256:[0-9a-f]{64}$/.test(preview.previewDigest)) return false
  if (!Number.isSafeInteger(preview.impact.workspaceChangeCount) || preview.impact.workspaceChangeCount < 0) return false
  if (!preview.impact.sessionEffect.trim() || !preview.impact.warning.trim()) return false
  if (!Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now()) return false
  return preview.impact.changedRelativePaths.every((path) => {
    if (!path || /^[a-z]:/i.test(path) || /^[\\/]/.test(path) || path.includes('\0')) return false
    return !path.split(/[\\/]/).some((segment) => segment === '' || segment === '.' || segment === '..')
  })
}
