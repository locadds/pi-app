/**
 * 企业安全护栏策略面板（小规 Agent · CODING 模式，编程工作台内嵌）。
 *
 * 只读呈现主进程 ipc:xiaogui.guard.status 返回的护栏状态：
 * 1. 启用状态徽章（三态：未部署 / 已部署未启用 / 已启用）
 * 2. 写入根白名单
 * 3. 五类危险命令拦截类别（中文展示）
 * 4. 审计开关与日志路径（可在文件夹中显示）
 *
 * 文案统一用「安全护栏」；不出现"沙箱/sandbox"字样。
 * 视觉沿用朱砂红 ACCENT 与虚线测量框（ProjectInspectView / WorkHomeView 范式）。
 */

import { useEffect } from 'react'

import { ipcClient } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'

import { useXiaoguiStore } from '../stores/xiaogui-store'

/** 朱砂红——与 ModeSelector / ProjectInspectView 保持同一强调色。 */
const ACCENT = '#c0392b'

/** 三态徽章元数据（样式对齐 ProjectInspectView 的 STATUS_META）。 */
const GUARD_PHASE_META: Record<
  'unknown' | 'undeployed' | 'deployedDisabled' | 'enabled',
  { zh: string; cls: string; mark: string }
> = {
  unknown: {
    zh: '未知',
    cls: 'text-muted-foreground border-border',
    mark: '…',
  },
  undeployed: {
    zh: '未部署',
    cls: 'text-red-700 border-red-700/50 dark:text-red-400 dark:border-red-400/50',
    mark: '✕',
  },
  deployedDisabled: {
    zh: '已部署未启用',
    cls: 'text-amber-700 border-amber-700/50 dark:text-amber-400 dark:border-amber-400/50',
    mark: '▲',
  },
  enabled: {
    zh: '已启用',
    cls: 'text-green-700 border-green-700/50 dark:text-green-400 dark:border-green-400/50',
    mark: '✓',
  },
}

/** 取日志文件父目录（渲染层不引 path 模块，按两种分隔符切分）。 */
function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx > 0 ? p.slice(0, idx) : p
}

export function GuardPolicyPanel() {
  const guardStatus = useXiaoguiStore((s) => s.guardStatus)
  const refreshGuardStatus = useXiaoguiStore((s) => s.refreshGuardStatus)
  const currentWorkspace = useUIStore((s) => s.currentWorkspace)

  // 挂载时（以及切换项目后）拉取一次护栏状态
  useEffect(() => {
    void refreshGuardStatus(currentWorkspace ?? undefined)
  }, [refreshGuardStatus, currentWorkspace])

  const showAuditInFolder = async () => {
    const logPath = guardStatus?.audit.logPath
    if (!logPath) return
    try {
      if (guardStatus?.audit.exists) {
        await ipcClient.invoke('shell.showItemInFolder', { path: logPath })
      } else {
        await ipcClient.invoke('shell.openPath', { path: parentDir(logPath) })
      }
    } catch (e) {
      console.warn('[xiaogui] 打开审计日志位置失败:', e)
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border border-dashed border-border bg-background/40">
      {/* ---- 单头 ---- */}
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-3">
        <h2 className="text-[13px] font-semibold text-foreground">
          安全护栏
          <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            coding guard
          </span>
        </h2>
        {guardStatus && (
          <span
            className={[
              'inline-flex rotate-[-2deg] items-center gap-1.5 rounded border-2 px-2 py-0.5',
              'font-mono text-[11px] font-bold tracking-[0.18em]',
              GUARD_PHASE_META[
                guardStatus.enabled
                  ? 'enabled'
                  : guardStatus.deployed
                    ? 'deployedDisabled'
                    : 'undeployed'
              ].cls,
            ].join(' ')}
          >
            <span aria-hidden>
              {
                GUARD_PHASE_META[
                  guardStatus.enabled
                    ? 'enabled'
                    : guardStatus.deployed
                      ? 'deployedDisabled'
                      : 'undeployed'
                ].mark
              }
            </span>
            {
              GUARD_PHASE_META[
                guardStatus.enabled
                  ? 'enabled'
                  : guardStatus.deployed
                    ? 'deployedDisabled'
                    : 'undeployed'
              ].zh
            }
          </span>
        )}
      </div>

      {/* ---- 未选择项目 / 状态未到达 ---- */}
      {!guardStatus ? (
        <div className="px-5 py-8 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/70">
            NO PROJECT
          </p>
          <p className="mt-2 text-[13px] text-muted-foreground">
            未选择项目——打开一个项目后即可查看安全护栏状态。
          </p>
        </div>
      ) : (
        <div className="space-y-4 px-5 py-4">
          {/* ---- 未部署：部署指引 ---- */}
          {!guardStatus.deployed && (
            <div className="rounded-md border border-dashed px-3 py-2.5" style={{ borderColor: `${ACCENT}55` }}>
              <p className="text-[12px] font-semibold" style={{ color: ACCENT }}>
                当前项目未部署安全护栏扩展
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                部署方式：将小规仓库 <span className="font-mono">src/coding/guard-extension</span>{' '}
                复制为本项目的{' '}
                <span className="font-mono">.pi/extensions/xiaogui-coding-guard</span>
                （入口文件为 index.ts），并在小规扩展设置中启用。部署后危险命令将被拦截并写入审计日志。
              </p>
            </div>
          )}

          {/* ---- 写入根白名单 ---- */}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              写入根白名单
            </p>
            <ul className="space-y-1 rounded-md border border-border/70 px-3 py-2">
              {guardStatus.writeRoots.map((root) => (
                <li
                  key={root}
                  className="break-all font-mono text-[11px] leading-relaxed text-foreground"
                >
                  <span className="mr-1.5" style={{ color: ACCENT }} aria-hidden>
                    ▸
                  </span>
                  {root}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-muted-foreground/80">
              白名单外的写目标命中敏感路径时将被安全护栏拦截并留痕。
            </p>
          </div>

          {/* ---- 危险命令拦截类别 ---- */}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              危险命令拦截类别
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {guardStatus.dangerCategories.map((c) => (
                <li
                  key={c.id}
                  className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5"
                  style={{ borderColor: `${ACCENT}55` }}
                  title={c.id}
                >
                  <span className="font-mono text-[10px] font-bold" style={{ color: ACCENT }}>
                    {c.id}
                  </span>
                  <span className="text-[11px] text-foreground">{c.zhLabel}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* ---- 审计开关与日志路径 ---- */}
          <div className="border-t border-dashed border-border/70 pt-3">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              审计日志
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code
                className="min-w-0 flex-1 break-all rounded border border-border/70 px-2 py-1 font-mono text-[11px] text-foreground"
                title={guardStatus.audit.logPath}
              >
                {guardStatus.audit.logPath}
              </code>
              <button
                type="button"
                onClick={() => void showAuditInFolder()}
                className="shrink-0 rounded-md border border-border px-3 py-1 text-[12px] text-foreground transition-colors hover:bg-foreground/5"
              >
                在文件夹中显示
              </button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground/80">
              {guardStatus.audit.overrideByEnv
                ? '日志路径已由环境变量 XIAOGUI_CODING_AUDIT_LOG 覆盖。'
                : '默认路径按项目目录哈希生成；拦截与放行决策逐条追加（哈希链防篡改）。'}
              {guardStatus.audit.exists ? '' : '（尚未产生日志文件）'}
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
