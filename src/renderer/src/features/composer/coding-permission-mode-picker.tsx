import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ShieldCheck } from '@renderer/components/icons'
import { ipcClient } from '@renderer/lib/ipc-client'
import {
  CODING_PERMISSION_MODES_V1,
  XIAOGUI_CODING_PERMISSION_MODE_SETTING_KEY_V1,
  type CodingPermissionModeV1,
} from '@shared/xiaogui-coding-permission'
import { XIAOGUI_DIRECT_CODING_PERMISSION_MODE_OPTIONS_V2 } from '@shared/xiaogui-direct-coding'

export function CodingPermissionModePicker({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation('composer')
  const [mode, setMode] = useState<CodingPermissionModeV1>('CONFIRM_EACH')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    void ipcClient.invoke('settings.get', { key: XIAOGUI_CODING_PERMISSION_MODE_SETTING_KEY_V1 })
      .then((response) => {
        const selected = response?.settings?.[XIAOGUI_CODING_PERMISSION_MODE_SETTING_KEY_V1]
        if (active && isPermissionMode(selected)) setMode(selected)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const selected = useMemo(
    () => XIAOGUI_DIRECT_CODING_PERMISSION_MODE_OPTIONS_V2.find((option) => option.mode === mode)!,
    [mode],
  )

  const choose = async (nextMode: CodingPermissionModeV1): Promise<void> => {
    if (saving || disabled) return
    setSaving(true)
    try {
      const response = await ipcClient.invoke('settings.set', {
        key: XIAOGUI_CODING_PERMISSION_MODE_SETTING_KEY_V1,
        value: nextMode,
      })
      if (response?.value !== nextMode) throw new Error('CODING_PERMISSION_MODE_SAVE_FAILED')
      setMode(nextMode)
      setOpen(false)
    } catch {
      toast.error(t('permissionMode.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative shrink-0" data-testid="coding-permission-mode-picker">
      <button
        type="button"
        disabled={disabled || saving}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('permissionMode.appliesNextAttempt')}
        onClick={() => setOpen((value) => !value)}
        className="composer-toolbar-btn flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-foreground-secondary/75 disabled:opacity-30"
      >
        <ShieldCheck className="h-[14px] w-[14px]" strokeWidth={1.8} />
        <span>{selected.label}</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[70] cursor-default"
            aria-label={t('permissionMode.close')}
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            aria-label={t('permissionMode.title')}
            className="popover-motion absolute bottom-full left-0 z-[71] mb-2 w-[min(340px,calc(100vw-2rem))] rounded-xl border border-border/80 bg-popover p-2 shadow-xl"
          >
            <div className="px-2 py-1.5">
              <div className="text-xs font-semibold text-foreground">{t('permissionMode.title')}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {t('permissionMode.appliesNextAttempt')}
              </div>
            </div>
            {XIAOGUI_DIRECT_CODING_PERMISSION_MODE_OPTIONS_V2.map((option) => (
              <button
                key={option.mode}
                type="button"
                role="menuitemradio"
                aria-checked={option.mode === mode}
                onClick={() => void choose(option.mode)}
                className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted/60"
              >
                <span className="mt-0.5 w-4 shrink-0 text-xs text-primary">
                  {option.mode === mode ? '✓' : ''}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{option.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </button>
            ))}
            <div className="mx-2 mt-1 border-t border-border/50 pt-2 text-[10px] leading-relaxed text-muted-foreground">
              {t('permissionMode.taskHubBoundary')}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function isPermissionMode(value: unknown): value is CodingPermissionModeV1 {
  return typeof value === 'string' && CODING_PERMISSION_MODES_V1.includes(value as CodingPermissionModeV1)
}
