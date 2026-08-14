/**
 * 小规企业安全护栏（CODING Guard）只读状态探测。
 *
 * 仅做只读 FS / env 检查，不执行任何项目代码、不做任何写操作。
 * 结果供渲染层编程工作台（CodingHomeView / GuardPolicyPanel）呈现。
 *
 * 事实来源（小规仓库 src/coding/guard-extension/）：
 * - policy.ts：五类危险命令拦截（DangerCategory，见下方 DANGER_CATEGORIES）
 * - audit.ts resolveAuditLogPath：审计日志路径公式
 *   env XIAOGUI_CODING_AUDIT_LOG 优先；否则
 *   ~/.xiaogui/audit/<sha256(path.resolve(cwd)).slice(0,16)>.log
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { probeExtensions } from '../../extension-compat/extension-probe'

export interface XiaoguiGuardStatus {
  version: 1
  /** 项目内是否已部署护栏扩展（<cwd>/.pi/extensions/xiaogui-coding-guard/index.ts） */
  deployed: boolean
  /** 护栏是否实际生效（probe 命中条目 enabled && piEnabled） */
  enabled: boolean
  /** 生效条目的来源作用域；未命中为 null */
  scope: 'project' | 'global' | null
  /** 允许写入根：会话 cwd + env XIAOGUI_CODING_WRITE_ROOTS 追加项 */
  writeRoots: string[]
  /** 危险命令拦截类别（与 policy.ts DangerCategory 对齐） */
  dangerCategories: { id: string; zhLabel: string }[]
  audit: {
    logPath: string
    exists: boolean
    /** 是否由 XIAOGUI_CODING_AUDIT_LOG 覆盖了默认路径 */
    overrideByEnv: boolean
  }
  /** 编程工作台 feature flag（XIAOGUI_CODING_WORKBENCH !== '0'） */
  workbenchEnabled: boolean
  reserved?: Record<string, unknown>
}

/** 五类危险命令拦截类别（policy.ts DangerCategory 的展示镜像）。 */
export const DANGER_CATEGORIES: { id: string; zhLabel: string }[] = [
  { id: 'recursive-delete', zhLabel: '递归删除' },
  { id: 'disk-operation', zhLabel: '磁盘操作' },
  { id: 'pipe-execute', zhLabel: '管道执行' },
  { id: 'irreversible', zhLabel: '不可逆破坏' },
  { id: 'system-control', zhLabel: '系统级控制' },
]

const GUARD_EXTENSION_NAME = 'xiaogui-coding-guard'

/**
 * 审计日志路径解析。与小规仓库 guard-extension/audit.ts 的
 * `resolveAuditLogPath` 保持同一公式（交叉引用，勿单独演进）：
 * env XIAOGUI_CODING_AUDIT_LOG 优先，否则
 * ~/.xiaogui/audit/<sha256(path.resolve(cwd)).slice(0,16)>.log
 */
export function resolveGuardAuditLogPath(cwd: string): { logPath: string; overrideByEnv: boolean } {
  const override = process.env.XIAOGUI_CODING_AUDIT_LOG
  if (override && override.trim()) {
    return { logPath: override.trim(), overrideByEnv: true }
  }
  const projectHash = createHash('sha256')
    .update(path.resolve(cwd))
    .digest('hex')
    .slice(0, 16)
  return {
    logPath: path.join(homedir(), '.xiaogui', 'audit', `${projectHash}.log`),
    overrideByEnv: false,
  }
}

/**
 * 读取护栏状态（只读）。
 *
 * @param cwd 会话/项目工作目录
 */
export async function readGuardStatus(cwd: string): Promise<XiaoguiGuardStatus> {
  const guardEntryPath = path.join(cwd, '.pi', 'extensions', GUARD_EXTENSION_NAME, 'index.ts')
  const deployed = existsSync(guardEntryPath)

  let enabled = false
  let scope: XiaoguiGuardStatus['scope'] = null
  try {
    const probes = probeExtensions(cwd)
    const entry = probes.find((p) => p.name.includes(GUARD_EXTENSION_NAME))
    if (entry) {
      enabled = entry.enabled && entry.piEnabled === true
      scope = entry.source === 'project' || entry.source === 'global' ? entry.source : null
    }
  } catch (e) {
    console.warn('[xiaogui] guard-status probe failed:', e)
  }

  const extraRoots = process.env.XIAOGUI_CODING_WRITE_ROOTS
  const writeRoots = [cwd, ...(extraRoots ? extraRoots.split(path.delimiter).filter(Boolean) : [])]

  const audit = resolveGuardAuditLogPath(cwd)

  return {
    version: 1,
    deployed,
    enabled,
    scope,
    writeRoots,
    dangerCategories: DANGER_CATEGORIES,
    audit: {
      logPath: audit.logPath,
      exists: existsSync(audit.logPath),
      overrideByEnv: audit.overrideByEnv,
    },
    workbenchEnabled: process.env.XIAOGUI_CODING_WORKBENCH !== '0',
  }
}
