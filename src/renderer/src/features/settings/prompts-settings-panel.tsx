import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { RefreshCw, MessageSquareText, FolderGit2, Cpu, Plug, FileText } from '@renderer/components/icons'
import { cn } from '@renderer/lib/utils'
import { ipcClient } from '@renderer/lib/ipc-client'
import { MarkdownResourceEditor } from '@renderer/features/settings/markdown-resource-editor'
import { SettingsPageHeader } from '@renderer/features/settings/settings-shell'
import { resolvePromptRowDisplay } from '@renderer/features/settings/prompt-catalog-i18n'
import type { XiaoguiEffectivePromptDiagnosticsV1 } from '@shared/xiaogui-prompt-contract'

type PromptCategory =
  | 'product_system_layers'
  | 'user_system_append'
  | 'project_context'
  | 'slash_prompt_templates'
  | 'tool_capability_guidelines'
  | 'subtask_prompts'

type PromptRow = {
  id: string
  category: PromptCategory
  name: string
  description: string
  path: string | null
  command: string
  source?: string
  editable?: boolean
  readOnly?: boolean
  inSystemContext?: boolean
}

const GROUP_ICON: Record<PromptCategory, typeof FileText> = {
  product_system_layers: Cpu,
  user_system_append: FileText,
  project_context: FolderGit2,
  slash_prompt_templates: MessageSquareText,
  tool_capability_guidelines: Plug,
  subtask_prompts: FileText,
}

const ADVANCED_PROMPT_PREVIEW_LIMIT = 12_000

export function EffectivePromptDiagnosticsPanel({
  diagnostics,
  previewPath,
}: {
  diagnostics: XiaoguiEffectivePromptDiagnosticsV1 | null
  previewPath: string | null
}) {
  const { t } = useTranslation()
  const [promptBody, setPromptBody] = useState<string | null>(null)
  const [promptLoading, setPromptLoading] = useState(false)
  const [promptError, setPromptError] = useState<string | null>(null)

  const loadPromptBody = useCallback(async () => {
    if (!previewPath || promptBody !== null || promptLoading) return
    setPromptLoading(true)
    setPromptError(null)
    try {
      const result = await ipcClient.invoke('resource.read', {
        path: previewPath,
        expectedPromptSha256: diagnostics?.manifest.completePromptSha256,
      })
      if (result?.error) throw new Error(String(result.error))
      setPromptBody(String(result?.content ?? ''))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setPromptError(message)
      toast.error(message)
    } finally {
      setPromptLoading(false)
    }
  }, [previewPath, promptBody, promptLoading, diagnostics?.manifest.completePromptSha256])

  useEffect(() => {
    setPromptBody(null)
    setPromptError(null)
  }, [previewPath, diagnostics?.manifest.completePromptSha256])

  if (!diagnostics) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/15 px-6 text-center text-sm text-muted-foreground">
        {t('settings:prompts.effectiveUnavailable')}
      </div>
    )
  }

  const { manifest } = diagnostics
  const visiblePrompt = promptBody?.slice(0, ADVANCED_PROMPT_PREVIEW_LIMIT) ?? ''
  const promptTruncated = (promptBody?.length ?? 0) > ADVANCED_PROMPT_PREVIEW_LIMIT

  return (
    <div className="flex h-full min-h-[420px] flex-col overflow-hidden rounded-lg border border-border/60 bg-card/30">
      <div className="border-b border-border/50 px-4 py-3">
        <div className="text-base font-semibold">{t('settings:prompts.effectiveTitle')}</div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('settings:prompts.effectiveSafeSummary')}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {diagnostics.migrationNotices.some(
          (notice) => notice.code === 'LEGACY_DESIGN_PROMPT_RUNTIME_DEDUPED',
        ) ? (
          <p className="rounded-md border border-brand/25 bg-brand/5 px-3 py-2 text-xs text-foreground/80">
            {t('settings:prompts.legacyDesignRuntimeDeduped')}
          </p>
        ) : null}
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[
            [t('settings:prompts.effectiveMode'), manifest.mode],
            [t('settings:prompts.effectivePhase'), manifest.phase],
            [t('settings:prompts.effectiveCharacters'), String(manifest.completePromptCharacterCount)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border/50 bg-muted/15 px-3 py-2">
              <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-mono text-sm font-medium">{value}</dd>
            </div>
          ))}
        </dl>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('settings:prompts.effectiveSha256')}
          </h3>
          <code className="mt-1 block break-all rounded-md bg-muted/30 px-3 py-2 text-xs">
            {manifest.completePromptSha256}
          </code>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('settings:prompts.effectiveCapabilities', { count: manifest.capabilityIds.length })}
            </h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {manifest.capabilityIds.length > 0
                ? manifest.capabilityIds.map((id) => (
                    <code key={id} className="rounded bg-brand/10 px-2 py-1 text-xs text-brand">{id}</code>
                  ))
                : <span className="text-xs text-muted-foreground">{t('settings:prompts.effectiveNone')}</span>}
            </div>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('settings:prompts.effectiveTools', { count: manifest.toolNames.length })}
            </h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {manifest.toolNames.length > 0
                ? manifest.toolNames.map((name) => (
                    <code key={name} className="rounded bg-muted/50 px-2 py-1 text-xs">{name}</code>
                  ))
                : <span className="text-xs text-muted-foreground">{t('settings:prompts.effectiveNone')}</span>}
            </div>
          </div>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('settings:prompts.effectiveLayers', { count: manifest.layers.length })}
          </h3>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full min-w-[680px] text-left text-xs">
              <thead className="bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('settings:prompts.layerId')}</th>
                  <th className="px-3 py-2 font-medium">{t('settings:prompts.layerKind')}</th>
                  <th className="px-3 py-2 font-medium">{t('settings:prompts.layerVersion')}</th>
                  <th className="px-3 py-2 font-medium">{t('settings:prompts.layerCharacters')}</th>
                  <th className="px-3 py-2 font-medium">SHA-256</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {manifest.layers.map((layer) => (
                  <tr key={`${layer.id}@${layer.version}`}>
                    <td className="px-3 py-2 font-mono">{layer.id}</td>
                    <td className="px-3 py-2">{layer.kind}</td>
                    <td className="px-3 py-2 font-mono">{layer.version}</td>
                    <td className="px-3 py-2 font-mono">{layer.characterCount}</td>
                    <td className="max-w-52 break-all px-3 py-2 font-mono text-2xs">{layer.sha256}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <details className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2">
          <summary
            className="cursor-pointer font-medium text-foreground/85"
            onClick={() => void loadPromptBody()}
          >
            {t('settings:prompts.advancedSummary')}
          </summary>
          {promptLoading ? (
            <p className="mt-3 text-xs text-muted-foreground">{t('settings:prompts.advancedLoading')}</p>
          ) : promptError ? (
            <p className="mt-3 text-xs text-destructive">{promptError}</p>
          ) : promptBody !== null ? (
            <>
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/80 p-3 font-mono text-xs leading-relaxed">
                {visiblePrompt}
              </pre>
              {promptTruncated ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('settings:prompts.advancedTruncated', { count: ADVANCED_PROMPT_PREVIEW_LIMIT })}
                </p>
              ) : null}
            </>
          ) : null}
        </details>
      </div>
    </div>
  )
}

export function PromptsSettingsPanel() {
  const { t, i18n } = useTranslation()
  const [flat, setFlat] = useState<PromptRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [virtualSystemPreviewPath, setVirtualSystemPreviewPath] = useState<string | null>(null)
  const [effectivePromptDiagnostics, setEffectivePromptDiagnostics] =
    useState<XiaoguiEffectivePromptDiagnosticsV1 | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await ipcClient.invoke('prompts.list')
      const prompts: PromptRow[] = res?.prompts || []
      setFlat(prompts)
      setVirtualSystemPreviewPath(res?.virtualSystemPreviewPath || null)
      setEffectivePromptDiagnostics(res?.effectivePromptDiagnostics || null)
    } catch (e) {
      toast.error(t('settings:prompts.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const selected = useMemo(() => flat.find((p) => p.id === selectedId), [flat, selectedId])

  const editorPath = useMemo(() => {
    if (!selected) return null
    if (selected.id === 'builtin:system:default') return null
    return selected.path
  }, [selected])

  const editorReadOnly = selected?.readOnly === true || selected?.id === 'builtin:system:default'

  const displayGroups = useMemo(() => {
    const labels: Record<PromptCategory, string> = {
      product_system_layers: t('settings:prompts.productSystemLayers'),
      user_system_append: t('settings:prompts.userSystemAppend'),
      project_context: t('settings:prompts.groupProjectContext'),
      slash_prompt_templates: t('settings:prompts.slashPromptTemplates'),
      tool_capability_guidelines: t('settings:prompts.toolCapabilityGuidelines'),
      subtask_prompts: t('settings:prompts.subtaskPrompts'),
    }
    const order: PromptCategory[] = [
      'product_system_layers',
      'user_system_append',
      'project_context',
      'slash_prompt_templates',
      'tool_capability_guidelines',
      'subtask_prompts',
    ]
    return order
      .map((category) => ({
        category,
        label: labels[category],
        items: flat.filter((i) => i.category === category),
      }))
      .filter((g) => g.items.length > 0)
  }, [flat, i18n.language, t])

  return (
    <div className="w-full">
      <SettingsPageHeader
        title={t('settings:prompts.title')}
        description={t('settings:prompts.description')}
        action={
          <button
            type="button"
            onClick={() => void load()}
            className="chrome-icon-btn rounded-md p-2"
            aria-label={t('common:refresh')}
            title={t('common:refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} strokeWidth={1.5} />
          </button>
        }
      />

      <div className="grid min-h-[min(72vh,640px)] gap-4 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
        <div className="max-h-[min(70vh,560px)] overflow-y-auto rounded-xl border border-border/50">
          {loading && flat.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t('settings:prompts.loading')}</p>
          ) : displayGroups.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t('settings:prompts.empty')}</p>
          ) : (
            <div className="divide-y divide-border/40">
              {displayGroups.map((g) => {
                const Icon = GROUP_ICON[g.category]
                return (
                  <section key={g.category}>
                    <div className="sticky top-0 z-[1] flex items-center gap-1.5 border-b border-border/30 bg-[var(--bg-1)]/95 px-3 py-2 backdrop-blur-sm">
                      <Icon className="h-4 w-4 text-muted-foreground/70" strokeWidth={1.5} />
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">{g.label}</span>
                      <span className="font-mono text-2xs text-muted-foreground/50">({g.items.length})</span>
                    </div>
                    <ul>
                      {g.items.map((p) => {
                        const display = resolvePromptRowDisplay(p, t)
                        return (
                        <li key={p.id}>
                          <button
                            type="button"
                            disabled={!p.path && p.id !== 'builtin:system:default'}
                            onClick={() => setSelectedId(p.id)}
                            className={cn(
                              'w-full px-3 py-2.5 text-left disabled:opacity-45',
                              selectedId === p.id && 'bg-primary/8',
                            )}
                          >
                            <div className="flex items-center gap-1.5">
                              <span className="text-base font-medium">{display.name}</span>
                              {p.inSystemContext ? (
                                <span className="shrink-0 rounded bg-brand/12 px-1 py-0.5 text-2xs text-brand">
                                  {t('settings:prompts.perTurnSystem')}
                                </span>
                              ) : null}
                              {p.readOnly ? (
                                <span className="shrink-0 text-2xs text-muted-foreground">{t('settings:prompts.readOnly')}</span>
                              ) : null}
                            </div>
                            {p.command ? (
                              <p className="mt-0.5 font-mono text-2xs text-muted-foreground">{p.command}</p>
                            ) : null}
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground/70">{display.description}</p>
                          </button>
                        </li>
                        )
                      })}
                    </ul>
                  </section>
                )
              })}
            </div>
          )}
        </div>

        {selected?.id === 'builtin:system:default' ? (
          <EffectivePromptDiagnosticsPanel
            diagnostics={effectivePromptDiagnostics}
            previewPath={virtualSystemPreviewPath}
          />
        ) : (
          <MarkdownResourceEditor
            path={editorPath}
            title={
              selected
                ? selected.command
                  ? t('settings:prompts.templateTitle', { command: selected.command })
                  : resolvePromptRowDisplay(selected, t).name
                : ''
            }
            readOnly={editorReadOnly}
            onSaved={() => void load()}
          />
        )}
      </div>
    </div>
  )
}
