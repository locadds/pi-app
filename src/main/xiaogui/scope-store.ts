/**
 * 小规模式作用域（scope）元数据（主进程侧）。
 *
 * 背景：Pi SDK session（工作区 .pi/agent/sessions 下 JSONL）与上游
 * recentProjects 都是上游通用数据，小规不修改它们。为实现
 * WORK/DESIGN/CODING 三模式各自独立的对话与项目，在列表之上建立映射层：
 * - sessionModeMap: 规范化 sessionFile 路径 -> 一级模式
 * - projectModeMap: 规范化项目路径（含临时对话 sandbox 工作区）-> 一级模式
 * 查不到映射的记录视为历史数据，一律按 WORK 处理（仅 WORK 模式可见），
 * 数据一条都不删。
 *
 * 持久化在独立的 xiaogui.json（electron-store name='xiaogui'），
 * 不污染上游 pi-desktop.json schema。
 */

import Store from 'electron-store'

import { isXiaoguiMode, type XiaoguiMode } from './config'
import { normalizePathKey } from './path-key'

export type ScopeKind = 'session' | 'project'

interface XiaoguiScopeSchema {
  /** 最近一次使用的一级模式（应用重启后恢复）。 */
  mode: XiaoguiMode
  sessionModeMap: Record<string, XiaoguiMode>
  projectModeMap: Record<string, XiaoguiMode>
  /**
   * 项目基线：功能上线时已存在的 recentProjects（规范化路径）。
   * 基线项目不打标签，默认归 WORK（仅 WORK 可见）；仅基线之后
   * 新出现的项目才打当前模式标签——打开历史项目不静默改归属。
   */
  projectBaseline: string[]
}

const store = new Store<XiaoguiScopeSchema>({
  name: 'xiaogui',
  // 崩溃防护：xiaogui.json 损坏（非法 JSON）时清空并重建，而不是在模块
  // import 求值期抛 SyntaxError —— 那早于主进程 uncaughtException 兜底注册，
  // 会导致应用直接起不来。
  clearInvalidConfig: true,
  defaults: {
    mode: 'WORK',
    sessionModeMap: {},
    projectModeMap: {},
    projectBaseline: [],
  },
})

/** 过滤非法 key/模式值（防御历史脏数据）。 */
function sanitizeMap(raw: Record<string, unknown> | undefined): Record<string, XiaoguiMode> {
  const out: Record<string, XiaoguiMode> = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    const normalized = normalizePathKey(key)
    if (normalized && isXiaoguiMode(value)) out[normalized] = value
  }
  return out
}

function mapFor(kind: ScopeKind): Record<string, XiaoguiMode> {
  const raw =
    kind === 'session'
      ? (store.get('sessionModeMap') as Record<string, unknown>)
      : (store.get('projectModeMap') as Record<string, unknown>)
  return sanitizeMap(raw)
}

function writeMap(kind: ScopeKind, map: Record<string, XiaoguiMode>): void {
  if (kind === 'session') store.set('sessionModeMap', map)
  else store.set('projectModeMap', map)
}

// ---- mode 持久化 -----------------------------------------------------------------

export function loadPersistedMode(): XiaoguiMode {
  const mode = store.get('mode')
  return isXiaoguiMode(mode) ? mode : 'WORK'
}

export function persistMode(mode: XiaoguiMode): void {
  store.set('mode', mode)
}

// ---- scope 映射读写 ---------------------------------------------------------------

/** 查不到返回 null（渲染层将 null 视为历史数据 = WORK）。 */
export function getScope(kind: ScopeKind, key: string): XiaoguiMode | null {
  const normalized = normalizePathKey(key)
  if (!normalized) return null
  return mapFor(kind)[normalized] ?? null
}

/**
 * 写映射。ifAbsent=true 时已有映射则保持不变。
 * 返回写入后实际生效的模式（ifAbsent 命中已有映射时返回已有值）。
 */
export function setScope(
  kind: ScopeKind,
  key: string,
  mode: XiaoguiMode,
  options?: { ifAbsent?: boolean },
): XiaoguiMode {
  const normalized = normalizePathKey(key)
  if (!normalized) return mode
  const map = mapFor(kind)
  const existing = map[normalized]
  if (options?.ifAbsent && existing) return existing
  map[normalized] = mode
  writeMap(kind, map)
  return mode
}

export interface ScopeListResult {
  mode: XiaoguiMode
  sessionModeMap: Record<string, XiaoguiMode>
  projectModeMap: Record<string, XiaoguiMode>
}

export function listScopes(): ScopeListResult {
  return {
    mode: loadPersistedMode(),
    sessionModeMap: mapFor('session'),
    projectModeMap: mapFor('project'),
  }
}

// ---- 项目基线（历史归 WORK：基线不打标签） --------------------------------------

function sanitizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const key = normalizePathKey(typeof item === 'string' ? item : '')
    if (key) out.push(key)
  }
  return out
}

/**
 * 记录项目基线（功能上线时的存量 recentProjects）。
 * 与已有基线取并集（规范化去重）；幂等，重复上报安全。
 */
export function recordProjectBaseline(paths: string[]): number {
  const existing = sanitizeList(store.get('projectBaseline'))
  const merged = new Set(existing)
  for (const p of paths) {
    const key = normalizePathKey(p)
    if (key) merged.add(key)
  }
  const next = [...merged]
  store.set('projectBaseline', next)
  return next.length
}

export function getProjectBaseline(): string[] {
  return sanitizeList(store.get('projectBaseline'))
}

/** Test-only：清空 scope 存储内容（恢复默认值）。 */
export function __resetScopeStoreForTests(): void {
  store.set('mode', 'WORK')
  store.set('sessionModeMap', {})
  store.set('projectModeMap', {})
  store.set('projectBaseline', [])
}
