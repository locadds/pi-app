/**
 * 小规模式作用域（渲染层）：WORK/DESIGN/CODING 各自独立的对话与项目。
 *
 * 上游 Pi SDK session 列表与 recentProjects 不做任何修改；本模块基于主进程
 * scope 映射（ipc:xiaogui.scope.*）在渲染前过滤侧栏列表。
 * 核心约定：查不到映射的记录 = 历史数据，一律按 WORK 处理（仅 WORK 模式
 * 可见），数据一条都不删。
 *
 * 项目归属采用基线策略（与 sandbox 一致）：功能上线时已存在的 recentProjects
 * 记为基线（归 WORK、不打标签），仅基线之后新出现的项目才打当前模式标签；
 * 打开历史项目不静默改归属。sandbox 的打标签裁决在主进程创建处完成。
 */

import { create } from 'zustand'

import { ipcClient } from '@renderer/lib/ipc-client'
import { normalizeSessionFileKey } from '@renderer/lib/session-file-key'
import { useUIStore } from '@renderer/stores/ui-store'

import { useXiaoguiStore, type XiaoguiMode } from '../stores/xiaogui-store'

interface ModeScopeState {
  loaded: boolean
  sessionModeMap: Record<string, XiaoguiMode>
  projectModeMap: Record<string, XiaoguiMode>
}

export const useModeScopeStore = create<ModeScopeState>(() => ({
  loaded: false,
  sessionModeMap: {},
  projectModeMap: {},
}))

function isXiaoguiModeLike(value: unknown): value is XiaoguiMode {
  return value === 'WORK' || value === 'DESIGN' || value === 'CODING'
}

/** 从主进程拉取全量映射（挂载时调用一次；之后由打标签函数维护本地缓存）。 */
export async function refreshModeScope(): Promise<void> {
  try {
    const res = await ipcClient.invoke('xiaogui.scope.list')
    const sessionModeMap: Record<string, XiaoguiMode> = {}
    const projectModeMap: Record<string, XiaoguiMode> = {}
    for (const [k, v] of Object.entries((res?.sessionModeMap ?? {}) as Record<string, unknown>)) {
      if (isXiaoguiModeLike(v)) sessionModeMap[k] = v
    }
    for (const [k, v] of Object.entries((res?.projectModeMap ?? {}) as Record<string, unknown>)) {
      if (isXiaoguiModeLike(v)) projectModeMap[k] = v
    }
    useModeScopeStore.setState({ loaded: true, sessionModeMap, projectModeMap })
  } catch (e) {
    console.warn('[xiaogui] scope.list 失败:', e)
  }
}

/** 会话归属模式；查不到映射 = 历史数据 = WORK。 */
export function resolveSessionMode(sessionFile: string | null | undefined): XiaoguiMode {
  const key = normalizeSessionFileKey(sessionFile)
  if (!key) return 'WORK'
  return useModeScopeStore.getState().sessionModeMap[key] ?? 'WORK'
}

/** 项目（含临时对话 sandbox 工作区）归属模式；查不到映射 = 历史数据 = WORK。 */
export function resolveProjectMode(path: string | null | undefined): XiaoguiMode {
  const key = normalizeSessionFileKey(path)
  if (!key) return 'WORK'
  return useModeScopeStore.getState().projectModeMap[key] ?? 'WORK'
}

/**
 * 新建会话打标签：归入当前一级模式（乐观更新本地缓存 + 写主进程）。
 * 乐观写失败时回滚该 key 并触发一次全量刷新，避免重启后会话悄悄换归属。
 */
export async function tagSessionWithCurrentMode(
  sessionFile: string | null | undefined,
): Promise<void> {
  const key = normalizeSessionFileKey(sessionFile)
  if (!key) return
  const mode = useXiaoguiStore.getState().mode
  const prev = useModeScopeStore.getState().sessionModeMap[key]
  useModeScopeStore.setState((s) => ({
    sessionModeMap: { ...s.sessionModeMap, [key]: mode },
  }))
  try {
    await ipcClient.invoke('xiaogui.scope.set', { kind: 'session', key, mode })
  } catch (e) {
    console.warn('[xiaogui] scope.set(session) 失败，回滚本地乐观写:', e)
    useModeScopeStore.setState((s) => {
      const next = { ...s.sessionModeMap }
      if (prev === undefined) delete next[key]
      else next[key] = prev
      return { sessionModeMap: next }
    })
    // 兜底：与主进程全量对齐，消除部分写入造成的偏差
    void refreshModeScope()
  }
}

/**
 * 项目打标签：仅当该 path 尚无映射时归入当前一级模式。
 * ifAbsent 语义由主进程裁决（避免本地缓存未加载时误判），
 * 并按主进程返回的实际生效模式回填本地缓存。
 */
export async function tagProjectWithCurrentModeIfAbsent(
  path: string | null | undefined,
): Promise<void> {
  const key = normalizeSessionFileKey(path)
  if (!key) return
  const mode = useXiaoguiStore.getState().mode
  try {
    const res = await ipcClient.invoke('xiaogui.scope.set', {
      kind: 'project',
      key,
      mode,
      ifAbsent: true,
    })
    const effective = res?.mode
    if (isXiaoguiModeLike(effective)) {
      useModeScopeStore.setState((s) =>
        s.projectModeMap[key] === effective
          ? {}
          : { projectModeMap: { ...s.projectModeMap, [key]: effective } },
      )
    }
  } catch (e) {
    console.warn('[xiaogui] scope.set(project) 失败:', e)
  }
}

/**
 * 项目归属显式重归属：无条件把该 path 的归属写为当前一级模式
 * （不带 ifAbsent）。用于用户在首屏明确选择打开项目目录的场景——
 * 意图明确，允许覆盖原有归属（如 CODING 模式打开 DESIGN 归属项目）。
 * 按主进程返回的实际生效模式回填本地缓存。
 */
export async function setProjectModeToCurrent(
  path: string | null | undefined,
): Promise<void> {
  const key = normalizeSessionFileKey(path)
  if (!key) return
  const mode = useXiaoguiStore.getState().mode
  try {
    const res = await ipcClient.invoke('xiaogui.scope.set', { kind: 'project', key, mode })
    const effective = res?.mode
    if (isXiaoguiModeLike(effective)) {
      useModeScopeStore.setState((s) =>
        s.projectModeMap[key] === effective
          ? {}
          : { projectModeMap: { ...s.projectModeMap, [key]: effective } },
      )
    }
  } catch (e) {
    console.warn('[xiaogui] scope.set(project, 显式重归属) 失败:', e)
  }
}


/**
 * sandbox（临时对话）工作区创建后立即回填本地模式映射。
 *
 * 主进程已在 sandbox 创建处按当前模式打好标签（ground truth 在 xiaogui.json），
 * 但渲染层本地缓存只在侧栏挂载时全量拉取一次；不同步回填会导致新建临时对话
 * 被过滤逻辑按"历史=WORK"兜底：DESIGN 下新建的临时对话在 DESIGN 侧栏不可见。
 * 乐观回填后触发一次全量拉取对齐，与主进程保持最终一致。
 */
export function rememberSandboxScope(path: string | null | undefined): void {
  const key = normalizeSessionFileKey(path)
  if (!key) return
  const mode = useXiaoguiStore.getState().mode
  useModeScopeStore.setState((s) => ({
    projectModeMap: { ...s.projectModeMap, [key]: mode },
  }))
  void refreshModeScope()
}

// ---- 项目基线监听（历史归 WORK：存量不打标签） ---------------------------------
// 功能上线时把已有 recentProjects 上报为基线（主进程持久化，归 WORK 不打标签）；
// 之后订阅 recentProjects，仅对基线之外新出现的项目打当前模式标签。
// 打开已有项目（包括历史项目）不触发打标签，归属不被静默修改。

let projectBaselineKeys: Set<string> | null = null

async function ensureProjectBaselineReported(): Promise<void> {
  if (projectBaselineKeys) return
  const state = useUIStore.getState()
  // currentWorkspace 可能已在 recentProjects 中，Set 去重
  const pathSet = new Set(state.recentProjects || [])
  if (state.currentWorkspace) pathSet.add(state.currentWorkspace)
  const paths = [...pathSet]
  // 本地快照先同步就位（在监听器可能触发的任何 diff 之前），
  // 再异步上报主进程持久化——避免上报 in-flight 期间新事件把存量误判为新增
  projectBaselineKeys = new Set(
    paths.map((p) => normalizeSessionFileKey(p)).filter((k) => k.length > 0),
  )
  try {
    await ipcClient.invoke('xiaogui.scope.baselineProjects', { paths })
  } catch (e) {
    console.warn('[xiaogui] scope.baselineProjects 上报失败:', e)
  }
}

function tagNewProjectIfEligible(path: string): void {
  const key = normalizeSessionFileKey(path)
  if (!key) return
  if (projectBaselineKeys?.has(key)) return
  if (useModeScopeStore.getState().projectModeMap[key]) return
  void tagProjectWithCurrentModeIfAbsent(key)
}

/**
 * 启动项目基线监听：先上报基线，再订阅 recentProjects 变化，
 * 为基线之后新出现的项目打当前模式标签。返回解绑函数。
 */
export function startProjectBaselineWatcher(): () => void {
  void ensureProjectBaselineReported()
  const unsubscribe = useUIStore.subscribe((state, prevState) => {
    if (state.recentProjects === prevState.recentProjects) return
    for (const path of state.recentProjects || []) {
      if (!(prevState.recentProjects || []).includes(path)) {
        tagNewProjectIfEligible(path)
      }
    }
  })
  return unsubscribe
}

/** Test-only：重置项目基线本地快照。 */
export function __resetProjectBaselineForTests(): void {
  projectBaselineKeys = null
}
