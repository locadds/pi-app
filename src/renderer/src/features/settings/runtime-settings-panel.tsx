import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { ipcClient } from '@renderer/lib/ipc-client'
import type { XiaoguiKimiRuntimeStatusSnapshotV1, XiaoguiKimiRuntimeStatusV1 } from '@shared/xiaogui-kimi-runtime'
import { ConfirmDialog } from './confirm-dialog'
import { SettingRow, SettingsSection, Toggle } from './settings-page-shared'
import { selectCls, btnOutline } from './settings-controls'
import { useSettingsDraft } from './settings-draft-context'

type WslDistroInfo = { name: string; version?: number; isDefault: boolean }
type WslProbeResult = {
  ok: boolean
  distro: string
  node: boolean
  nodeVersion?: string
  npm: boolean
  git: boolean
  pi: boolean
  supportsCd: boolean
  error?: string
}

export function RuntimeSettingsPanel() {
  const { t } = useTranslation()
  const { draft, setAgentRuntime, setXiaoguiKimiProductionEnabled } = useSettingsDraft()
  const isWindows = useMemo(() => (window.piDesktop?.platform ?? '') === 'win32', [])
  const [distros, setDistros] = useState<WslDistroInfo[]>([])
  const [probe, setProbe] = useState<WslProbeResult | null>(null)
  const [probeState, setProbeState] = useState<'idle' | 'checking'>('idle')
  const [confirmingKimiEnablement, setConfirmingKimiEnablement] = useState(false)
  const [kimiRuntimeStatus, setKimiRuntimeStatus] = useState<XiaoguiKimiRuntimeStatusSnapshotV1 | null>(null)
  const [kimiStatusLoading, setKimiStatusLoading] = useState(false)
  const [kimiLoginStarting, setKimiLoginStarting] = useState(false)
  const mountedRef = useRef(false)
  const kimiRequestSequenceRef = useRef(0)

  const runtime = draft.agentRuntime

  const refreshKimiRuntimeStatus = useCallback(async () => {
    const sequence = ++kimiRequestSequenceRef.current
    setKimiStatusLoading(true)
    try {
      const status = (await ipcClient.invoke('xiaogui.kimi.status', {})) as XiaoguiKimiRuntimeStatusSnapshotV1
      if (mountedRef.current && sequence === kimiRequestSequenceRef.current) {
        setKimiRuntimeStatus(status)
      }
    } catch {
      if (mountedRef.current && sequence === kimiRequestSequenceRef.current) {
        setKimiRuntimeStatus(null)
      }
    } finally {
      if (mountedRef.current && sequence === kimiRequestSequenceRef.current) {
        setKimiStatusLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refreshKimiRuntimeStatus()
    return () => {
      mountedRef.current = false
      kimiRequestSequenceRef.current += 1
    }
  }, [refreshKimiRuntimeStatus])

  useEffect(() => {
    if (kimiRuntimeStatus?.status !== 'LOGIN_IN_PROGRESS') return
    const interval = window.setInterval(() => {
      void refreshKimiRuntimeStatus()
    }, 2_000)
    return () => window.clearInterval(interval)
  }, [kimiRuntimeStatus?.status, refreshKimiRuntimeStatus])

  const startKimiLogin = useCallback(async () => {
    const sequence = ++kimiRequestSequenceRef.current
    setKimiLoginStarting(true)
    try {
      const status = (await ipcClient.invoke('xiaogui.kimi.login.start', {})) as XiaoguiKimiRuntimeStatusSnapshotV1
      if (mountedRef.current && sequence === kimiRequestSequenceRef.current) {
        setKimiRuntimeStatus(status)
      }
    } catch {
      if (mountedRef.current && sequence === kimiRequestSequenceRef.current) {
        setKimiRuntimeStatus(null)
      }
    } finally {
      if (mountedRef.current) setKimiLoginStarting(false)
    }
  }, [])

  useEffect(() => {
    if (!isWindows) return
    void ipcClient
      .invoke('wsl.listDistros', {})
      .then((res) => {
        const list = (res?.distros as WslDistroInfo[] | undefined) || []
        setDistros(list)
      })
      .catch(() => setDistros([]))
  }, [isWindows])

  useEffect(() => {
    if (runtime.mode !== 'wsl' || !runtime.distro) {
      setProbe(null)
      setProbeState('idle')
      return
    }
    setProbeState('checking')
    void ipcClient
      .invoke('wsl.probeDistro', { distro: runtime.distro })
      .then((res) => {
        setProbe((res?.result as WslProbeResult | undefined) ?? null)
      })
      .catch(() => {
        setProbe(null)
      })
      .finally(() => setProbeState('idle'))
  }, [runtime.mode, runtime.distro])

  const selectedExists = distros.some((d) => d.name === runtime.distro)

  return (
    <div className="space-y-6">
      <SettingsSection
        title={t('settings:runtime.sectionAgentRuntime')}
        description={t('settings:runtime.sectionAgentRuntimeDesc')}
      >
        <SettingRow label={t('settings:runtime.mode')} description={t('settings:runtime.modeDesc')}>
          <select
            className={cn(selectCls, 'min-w-[min(220px,60vw)]')}
            value={runtime.mode}
            onChange={(e) => {
              const mode = e.target.value as 'host' | 'wsl'
              setAgentRuntime({
                mode,
                distro: mode === 'wsl' && runtime.distro ? runtime.distro : null,
              })
            }}
          >
            <option value="host">{t('settings:runtime.modeHost')}</option>
            <option value="wsl" disabled={!isWindows}>
              {t('settings:runtime.modeWsl')}
            </option>
          </select>
        </SettingRow>

        {!isWindows && (
          <SettingRow
            label={t('settings:runtime.platformUnavailable')}
            description={t('settings:runtime.platformUnavailableDesc')}
          >
            <span className="text-xs text-muted-foreground/70">{window.piDesktop?.platform ?? 'unknown'}</span>
          </SettingRow>
        )}

        {runtime.mode === 'wsl' && isWindows && (
          <>
            <SettingRow label={t('settings:runtime.distro')} description={t('settings:runtime.distroDesc')}>
              <select
                className={cn(selectCls, 'min-w-[min(220px,60vw)]')}
                value={runtime.distro ?? ''}
                onChange={(e) =>
                  setAgentRuntime({
                    mode: 'wsl',
                    distro: e.target.value || null,
                  })
                }
              >
                <option value="">{t('settings:runtime.distroNone')}</option>
                {distros.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                    {d.isDefault ? ` (${t('settings:runtime.distroDefault')})` : ''}
                    {typeof d.version === 'number' ? ` (WSL${d.version})` : ''}
                  </option>
                ))}
              </select>
            </SettingRow>

            {runtime.distro && !selectedExists && (
              <SettingRow
                label={t('settings:runtime.distroMissing')}
                description={t('settings:runtime.distroMissingDesc', {
                  distro: runtime.distro,
                })}
              >
                <span className="text-xs text-destructive/80">{t('settings:runtime.distroMissingLabel')}</span>
              </SettingRow>
            )}

            {runtime.distro && (
              <SettingRow label={t('settings:runtime.probe')} description={probeStatusText(probe, probeState, t)}>
                <button
                  type="button"
                  className={cn(btnOutline, 'text-xs')}
                  disabled={probeState === 'checking'}
                  onClick={() => {
                    setProbeState('checking')
                    void ipcClient
                      .invoke('wsl.probeDistro', { distro: runtime.distro })
                      .then((res) => setProbe((res?.result as WslProbeResult | undefined) ?? null))
                      .catch(() => setProbe(null))
                      .finally(() => setProbeState('idle'))
                  }}
                >
                  {t('settings:runtime.probeButton')}
                </button>
              </SettingRow>
            )}
          </>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings:runtime.sectionXiaoguiTaskExecution')}
        description={t('settings:runtime.sectionXiaoguiTaskExecutionDesc')}
      >
        <SettingRow
          label={t('settings:runtime.xiaoguiKimiProductionEnabled')}
          description={t('settings:runtime.xiaoguiKimiProductionEnabledDesc')}
        >
          <Toggle
            on={draft.xiaoguiKimiProductionEnabled}
            onChange={(enabled) => {
              if (enabled) {
                setConfirmingKimiEnablement(true)
                return
              }
              setXiaoguiKimiProductionEnabled(false)
            }}
          />
        </SettingRow>

        <SettingRow
          label={t('settings:runtime.xiaoguiKimiRuntimeStatus')}
          description={kimiRuntimeStatusDescription(kimiRuntimeStatus?.status, t)}
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            {kimiLoginAction(kimiRuntimeStatus?.status) && (
              <button
                type="button"
                className={cn(btnOutline, 'text-xs')}
                disabled={kimiLoginStarting || kimiRuntimeStatus?.status === 'LOGIN_IN_PROGRESS'}
                onClick={() => void startKimiLogin()}
              >
                {kimiLoginButtonText(kimiRuntimeStatus?.status, kimiLoginStarting, t)}
              </button>
            )}
            <button
              type="button"
              className={cn(btnOutline, 'text-xs')}
              disabled={kimiStatusLoading || kimiLoginStarting}
              onClick={() => void refreshKimiRuntimeStatus()}
            >
              {t('settings:runtime.xiaoguiKimiStatusRefresh')}
            </button>
          </div>
        </SettingRow>
      </SettingsSection>

      <ConfirmDialog
        open={confirmingKimiEnablement}
        title={t('settings:runtime.xiaoguiKimiEnableConfirmTitle')}
        message={t('settings:runtime.xiaoguiKimiEnableConfirmMessage')}
        onConfirm={() => {
          setConfirmingKimiEnablement(false)
          setXiaoguiKimiProductionEnabled(true)
        }}
        onCancel={() => setConfirmingKimiEnablement(false)}
      />
    </div>
  )
}

function kimiLoginAction(status?: XiaoguiKimiRuntimeStatusV1): boolean {
  return status === 'LOGIN_REQUIRED' || status === 'CREDENTIAL_PRESENT_UNVERIFIED' || status === 'LOGIN_IN_PROGRESS'
}

function kimiLoginButtonText(
  status: XiaoguiKimiRuntimeStatusV1 | undefined,
  starting: boolean,
  t: (key: string) => string,
): string {
  if (starting || status === 'LOGIN_IN_PROGRESS') {
    return t('settings:runtime.xiaoguiKimiLoginInProgress')
  }
  return status === 'CREDENTIAL_PRESENT_UNVERIFIED'
    ? t('settings:runtime.xiaoguiKimiRelogin')
    : t('settings:runtime.xiaoguiKimiLogin')
}

function kimiRuntimeStatusDescription(
  status: XiaoguiKimiRuntimeStatusV1 | undefined,
  t: (key: string) => string,
): string {
  switch (status) {
    case 'DISABLED':
      return t('settings:runtime.xiaoguiKimiStatusDisabled')
    case 'CLI_NOT_FOUND':
      return t('settings:runtime.xiaoguiKimiStatusCliNotFound')
    case 'VERSION_UNAPPROVED':
      return t('settings:runtime.xiaoguiKimiStatusVersionUnapproved')
    case 'LOGIN_REQUIRED':
      return t('settings:runtime.xiaoguiKimiStatusLoginRequired')
    case 'CREDENTIAL_PRESENT_UNVERIFIED':
      return t('settings:runtime.xiaoguiKimiStatusCredentialPresent')
    case 'LOGIN_IN_PROGRESS':
      return t('settings:runtime.xiaoguiKimiStatusLoginInProgress')
    case 'STATUS_UNAVAILABLE':
    default:
      return t('settings:runtime.xiaoguiKimiStatusUnavailable')
  }
}

function probeStatusText(
  probe: WslProbeResult | null,
  probeState: 'idle' | 'checking',
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (probeState === 'checking') return t('settings:runtime.probeChecking')
  if (!probe) return t('settings:runtime.probeIdle')
  const parts: string[] = []
  parts.push(probe.node ? `node ${probe.nodeVersion ?? ''}`.trim() : t('settings:runtime.missingNode'))
  parts.push(probe.npm ? 'npm' : t('settings:runtime.missingNpm'))
  parts.push(probe.git ? 'git' : t('settings:runtime.missingGit'))
  parts.push(probe.pi ? 'pi' : t('settings:runtime.missingPi'))
  if (!probe.supportsCd) parts.push(t('settings:runtime.noCdFlag'))
  if (probe.error) return `${probe.error} · ${parts.join(' · ')}`
  return parts.join(' · ')
}
