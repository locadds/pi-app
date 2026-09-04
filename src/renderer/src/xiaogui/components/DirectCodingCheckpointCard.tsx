import { useEffect, useState } from 'react'

import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import type {
  DirectCodingFileCheckpointV2,
  DirectCodingCheckpointRestorePreviewV2,
} from '@shared/xiaogui-direct-coding'
import { directCodingCheckpointClientV2 } from '../lib/direct-coding-checkpoint-client'

export function DirectCodingCheckpointCard({
  address,
  refreshKey,
}: {
  readonly address: SessionAddressV1
  readonly refreshKey?: string | null
}) {
  const [items, setItems] = useState<readonly DirectCodingFileCheckpointV2[]>([])
  const [preview, setPreview] = useState<DirectCodingCheckpointRestorePreviewV2 | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const reload = async () => {
    const outcome = await directCodingCheckpointClientV2.list(address)
    if (outcome.ok) setItems(outcome.value)
  }
  useEffect(() => {
    let active = true
    setPreview(null)
    setMessage(null)
    void directCodingCheckpointClientV2.list(address).then((outcome) => {
      if (active && outcome.ok) setItems(outcome.value)
    })
    return () => {
      active = false
    }
  }, [address.projectId, address.sessionKey, refreshKey])

  const available = items.filter((item) => item.status === 'AVAILABLE')
  const unknownCount = items.filter((item) => item.status === 'OUTCOME_UNKNOWN').length
  if (items.length === 0) return null

  const prepare = async (checkpointToken: string) => {
    setBusy(true)
    setMessage(null)
    const outcome = await directCodingCheckpointClientV2.preview(address, checkpointToken)
    setBusy(false)
    if (!outcome.ok) {
      setMessage(outcome.error === 'CHECKPOINT_CONFLICT'
        ? '文件之后又发生了变化，不能自动撤销。'
        : '无法准备撤销预览。')
      return
    }
    setPreview(outcome.value)
  }

  const restore = async () => {
    if (!preview || busy) return
    setBusy(true)
    const outcome = await directCodingCheckpointClientV2.confirm(address, preview)
    setBusy(false)
    setPreview(null)
    if (!outcome.ok) {
      setMessage(outcome.error === 'CHECKPOINT_CONFLICT'
        ? '文件内容已变化，未覆盖当前文件。'
        : '撤销失败，当前文件保持不变。')
      return
    }
    setMessage('已撤销本次文件修改；对话历史未改变。')
    await reload()
  }

  return (
    <section className="border-b border-border/40 px-3 py-2 text-[11px]" aria-label="文件修改检查点">
      <div className="font-medium text-foreground">文件修改检查点</div>
      <div className="mt-0.5 text-muted-foreground">仅撤销文件，不倒退对话。Bash 不在可恢复范围内。</div>
      {unknownCount > 0 && (
        <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          有 {unknownCount} 项操作的结果状态未知；不会自动重放，请先查看真实 Diff。
        </div>
      )}
      {available.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {available.map((item) => (
            <button
              key={item.checkpointToken}
              type="button"
              disabled={busy}
              onClick={() => void prepare(item.checkpointToken)}
              className="flex items-center justify-between rounded border border-border/60 px-2 py-1.5 text-left disabled:opacity-40"
            >
              <span className="min-w-0 truncate font-mono">{item.relativePath}</span>
              <span className="ml-2 shrink-0">撤销本次修改</span>
            </button>
          ))}
        </div>
      )}
      {preview && (
        <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <div>将{preview.action === 'REMOVE_CREATED_FILE' ? '移除新建文件' : '恢复修改前内容'}：<span className="font-mono">{preview.relativePath}</span></div>
          <div className="mt-1">不会撤销对话，也不会承诺撤销 Bash 副作用。</div>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={() => void restore()} className="rounded bg-destructive px-2 py-1 text-destructive-foreground disabled:opacity-40">
              {busy ? '正在撤销…' : '确认撤销本次文件修改'}
            </button>
            <button type="button" disabled={busy} onClick={() => setPreview(null)} className="rounded border px-2 py-1">取消</button>
          </div>
        </div>
      )}
      {message && <div className="mt-2 text-muted-foreground">{message}</div>}
    </section>
  )
}
