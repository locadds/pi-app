import { useEffect, useMemo, useState } from 'react'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import type {
  CodingRoleAttemptProjectionV1,
  CodingRoleProfileEditorDraftV1,
  CodingRoleProfileSummaryProjectionV1,
} from '@shared/xiaogui-coding-role-control'

import {
  bindCodingAttemptRole,
  copyCodingRole,
  listCodingRoles,
  readCodingAttemptRole,
  readCodingRoleForEdit,
  resetDefaultCodingRole,
  saveCodingRole,
} from '../lib/coding-role-client'

const ROLE_TEXT = {
  RESEARCH: '研究',
  IMPLEMENT: '实现',
  REVIEW: '审阅',
} as const

type EditorState = CodingRoleProfileEditorDraftV1 & { readonly toolsText: string }

export function CodingRoleCard({
  address,
  attemptId,
  canBind,
}: {
  readonly address: HubAddressV1
  readonly attemptId: string
  readonly canBind: boolean
}) {
  const [profiles, setProfiles] = useState<readonly CodingRoleProfileSummaryProjectionV1[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [binding, setBinding] = useState<CodingRoleAttemptProjectionV1 | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [confirmingReset, setConfirmingReset] = useState(false)

  const selected = useMemo(
    () => profiles.find((profile) => profile.profileId === selectedProfileId) ?? profiles[0],
    [profiles, selectedProfileId],
  )

  useEffect(() => {
    let active = true
    setLoading(true)
    setUnavailable(false)
    setError(null)
    setMessage(null)
    setEditor(null)
    setConfirmingReset(false)
    void Promise.all([listCodingRoles(address), readCodingAttemptRole(address, attemptId)]).then(([list, attempt]) => {
      if (!active) return
      setLoading(false)
      if (!list.ok || !attempt.ok) {
        setUnavailable(true)
        setProfiles([])
        setBinding(null)
        return
      }
      setProfiles(list.value.profiles)
      setSelectedProfileId(attempt.value.binding?.profileId
        ?? list.value.profiles.find((profile) => profile.role === 'IMPLEMENT')?.profileId
        ?? list.value.profiles[0]?.profileId
        ?? '')
      setBinding(attempt.value.binding)
    })
    return () => {
      active = false
    }
  }, [address.projectId, address.sessionKey, attemptId])

  const bind = async () => {
    if (!selected || !canBind || binding || submitting) return
    setSubmitting(true)
    setError(null)
    setMessage(null)
    const outcome = await bindCodingAttemptRole(address, attemptId, selected)
    setSubmitting(false)
    if (!outcome.ok || !outcome.value.binding) {
      setError(outcome.ok ? '角色绑定未完成。' : roleBindingErrorText(outcome.error.code))
      return
    }
    setBinding(outcome.value.binding)
  }

  const openEditor = async () => {
    if (!selected || submitting) return
    setSubmitting(true)
    setError(null)
    setMessage(null)
    const outcome = await readCodingRoleForEdit(address, selected.profileId)
    setSubmitting(false)
    if (!outcome.ok) {
      setError('无法读取角色配置。')
      return
    }
    const profile = outcome.value.profile
    setEditor({
      schemaVersion: 1,
      profileId: profile.profileId,
      role: profile.role,
      name: profile.name,
      description: profile.description,
      systemPrompt: profile.systemPrompt,
      modelSelector: profile.modelSelector,
      runtimePolicyId: profile.runtimePolicyId,
      toolAllowlist: profile.toolAllowlist,
      toolsText: profile.toolAllowlist.join(', '),
    })
  }

  const save = async () => {
    if (!editor || submitting) return
    const tools = editor.toolsText.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean)
    const draft: CodingRoleProfileEditorDraftV1 = {
      schemaVersion: 1,
      profileId: editor.profileId,
      role: editor.role,
      name: editor.name.trim(),
      description: editor.description.trim(),
      systemPrompt: editor.systemPrompt.trim(),
      modelSelector: editor.modelSelector.trim(),
      runtimePolicyId: editor.runtimePolicyId.trim(),
      toolAllowlist: tools,
    }
    if (!draft.name || !draft.description || !draft.systemPrompt || !draft.modelSelector || !draft.runtimePolicyId) {
      setError('角色名称、说明、提示、模型和运行策略不能为空。')
      return
    }
    setSubmitting(true)
    setError(null)
    setMessage(null)
    const outcome = await saveCodingRole(address, draft)
    setSubmitting(false)
    if (!outcome.ok) {
      setError('角色配置保存失败。')
      return
    }
    setProfiles((current) => current.map((profile) =>
      profile.profileId === outcome.value.profile.profileId ? outcome.value.profile : profile))
    setEditor(null)
    setMessage('角色配置已保存；已启动的执行仍使用原快照。')
  }

  const copy = async () => {
    if (!selected || submitting) return
    setSubmitting(true)
    setError(null)
    setMessage(null)
    setConfirmingReset(false)
    const newProfileId = copiedProfileId(selected.profileId)
    const outcome = await copyCodingRole(address, selected.profileId, newProfileId)
    setSubmitting(false)
    if (!outcome.ok) {
      setError(outcome.error.code === 'PROFILE_ALREADY_EXISTS'
        ? '角色副本标识冲突，请重试。'
        : '复制角色失败。')
      return
    }
    setProfiles((current) => [...current.filter((profile) => profile.profileId !== newProfileId), outcome.value.profile])
    setSelectedProfileId(newProfileId)
    setMessage('角色副本已创建，可继续编辑。')
  }

  const resetDefault = async () => {
    if (!selected || submitting || !confirmingReset) return
    setSubmitting(true)
    setError(null)
    setMessage(null)
    const outcome = await resetDefaultCodingRole(address, selected.profileId)
    setSubmitting(false)
    setConfirmingReset(false)
    if (!outcome.ok) {
      setError(outcome.error.code === 'PROFILE_NOT_DEFAULT'
        ? '只有小规内置角色可以重置。'
        : '重置角色失败。')
      return
    }
    setProfiles((current) => current.map((profile) =>
      profile.profileId === outcome.value.profile.profileId ? outcome.value.profile : profile))
    setEditor(null)
    setMessage('已恢复内置默认配置；已启动的执行仍使用原快照。')
  }

  if (loading) {
    return <div className="mt-2 text-[10px] text-muted-foreground">正在读取角色配置…</div>
  }
  if (unavailable) {
    return (
      <section className="mt-2 rounded-md border border-border/40 p-2 text-[11px]" aria-label="执行角色">
        <div className="font-medium text-foreground">执行角色</div>
        <div className="mt-1 text-muted-foreground">角色配置当前不可用。</div>
      </section>
    )
  }
  if (!selected && !binding) return null

  return (
    <section className="mt-2 rounded-md border border-border/40 p-2 text-[11px]" aria-label="执行角色">
      <div className="font-medium text-foreground">执行角色</div>
      {binding ? (
        <div className="mt-1">
          <div className="text-foreground-secondary">当前角色：{binding.name}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {ROLE_TEXT[binding.role]} · {binding.description}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            已固定到本次执行，执行中不会静默更换。
          </div>
        </div>
      ) : (
        <>
          <label className="mt-2 flex flex-col gap-1 text-muted-foreground">
            选择角色
            <select
              aria-label="选择角色"
              value={selected?.profileId ?? ''}
              disabled={!canBind || submitting || editor !== null || confirmingReset}
              onChange={(event) => {
                setSelectedProfileId(event.target.value)
                setConfirmingReset(false)
                setMessage(null)
                setError(null)
              }}
              className="rounded border border-border/60 bg-background px-2 py-1 text-[11px] text-foreground"
            >
              {profiles.map((profile) => (
                <option key={profile.profileId} value={profile.profileId}>
                  {profile.name}（{ROLE_TEXT[profile.role]}）
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <div className="mt-1 text-[10px] text-muted-foreground">{selected.description}</div>
          )}
          {!canBind && <div className="mt-1 text-[10px] text-muted-foreground">执行已开始，不能再更换角色。</div>}
          <button
            type="button"
            disabled={!canBind || submitting}
            onClick={() => void bind()}
            className="mt-2 rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-40"
          >
            {submitting ? '正在绑定…' : '使用此角色'}
          </button>
        </>
      )}

      {selected && !editor && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void openEditor()}
            className="rounded border border-border/60 px-2 py-1 text-foreground-secondary disabled:opacity-40"
          >
            编辑角色
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void copy()}
            className="rounded border border-border/60 px-2 py-1 text-foreground-secondary disabled:opacity-40"
          >
            复制角色
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => setConfirmingReset(true)}
            className="rounded border border-border/60 px-2 py-1 text-foreground-secondary disabled:opacity-40"
          >
            重置默认角色
          </button>
        </div>
      )}

      {selected && confirmingReset && (
        <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <div>将恢复“小规内置角色”的默认配置。已绑定的执行不会改变。</div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void resetDefault()}
              className="rounded bg-destructive px-2 py-1 text-destructive-foreground disabled:opacity-40"
            >
              {submitting ? '正在重置…' : '确认重置'}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => setConfirmingReset(false)}
              className="rounded border border-border/60 px-2 py-1 disabled:opacity-40"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {editor && (
        <div className="mt-2 flex flex-col gap-2 rounded border border-border/40 p-2">
          <label className="flex flex-col gap-1 text-muted-foreground">
            角色类型
            <select aria-label="角色类型" value={editor.role} onChange={(event) => setEditor({ ...editor, role: event.target.value as EditorState['role'] })} className="rounded border border-border/60 bg-background px-2 py-1 text-foreground">
              <option value="RESEARCH">研究</option>
              <option value="IMPLEMENT">实现</option>
              <option value="REVIEW">审阅</option>
            </select>
          </label>
          <RoleInput label="角色名称" value={editor.name} onChange={(name) => setEditor({ ...editor, name })} />
          <RoleInput label="角色说明" value={editor.description} onChange={(description) => setEditor({ ...editor, description })} />
          <label className="flex flex-col gap-1 text-muted-foreground">
            系统提示
            <textarea aria-label="系统提示" value={editor.systemPrompt} onChange={(event) => setEditor({ ...editor, systemPrompt: event.target.value })} className="min-h-24 resize-y rounded border border-border/60 bg-background px-2 py-1 text-foreground" />
          </label>
          <RoleInput label="模型选择" value={editor.modelSelector} onChange={(modelSelector) => setEditor({ ...editor, modelSelector })} />
          <RoleInput label="运行策略" value={editor.runtimePolicyId} onChange={(runtimePolicyId) => setEditor({ ...editor, runtimePolicyId })} />
          <RoleInput label="工具白名单" value={editor.toolsText} onChange={(toolsText) => setEditor({ ...editor, toolsText })} />
          <div className="flex gap-2">
            <button type="button" disabled={submitting} onClick={() => void save()} className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-40">保存角色</button>
            <button type="button" disabled={submitting} onClick={() => setEditor(null)} className="rounded border border-border/60 px-2 py-1 text-foreground-secondary disabled:opacity-40">取消编辑</button>
          </div>
        </div>
      )}
      {message && <div className="mt-2 text-muted-foreground">{message}</div>}
      {error && <div className="mt-2 text-destructive">{error}</div>}
    </section>
  )
}

function roleBindingErrorText(code: string): string {
  if (code === 'MODEL_UNAVAILABLE') return '当前会话尚未选择可用模型，请先选择模型后再试。'
  if (code === 'RUNTIME_POLICY_UNSUPPORTED') return '当前运行策略不支持此角色，请修改角色配置。'
  if (code === 'RUNTIME_UNAVAILABLE') return '当前 Agent 会话尚未就绪，请刷新会话后重试。'
  if (code === 'ATTEMPT_ALREADY_BOUND') return '本次执行已经绑定其他角色，不能在执行中更换。'
  if (code === 'VERSION_CONFLICT') return '角色配置已经更新，请刷新后重新选择。'
  return '角色绑定失败，请刷新后重试。'
}

function copiedProfileId(sourceProfileId: string): string {
  const suffix = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12)
    ?? Date.now().toString(36)
  return `${sourceProfileId.slice(0, 100)}-copy-${suffix}`.slice(0, 128)
}

function RoleInput({ label, value, onChange }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-muted-foreground">
      {label}
      <input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className="rounded border border-border/60 bg-background px-2 py-1 text-foreground" />
    </label>
  )
}
