/**
 * 小规 UI state：当前一级模式、执行方式（ASK/PLAN/EXECUTE）、sidecar 状态、
 * design.project.inspect 结果、企业安全护栏状态。
 *
 * 渲染进程不直接接触文件系统/Python 进程，所有操作经 IPC 白名单通道
 * （xiaogui.mode.switch / mode.get / tool.invoke / sidecar.status /
 * guard.status）进入主进程。
 */

import { create } from 'zustand'

import { ipcClient } from '@renderer/lib/ipc-client'
import { navigateToModeHome } from '@renderer/xiaogui/lib/navigate-mode-home'
import { refreshWorkspaceSessionLists } from '@renderer/lib/refresh-workspace-session-lists'
import {
  XIAOGUI_DEFAULT_EXECUTION_PHASE_V1,
  type XiaoguiExecutionPhase,
} from '@shared/xiaogui-prompt-contract'

export type XiaoguiMode = 'WORK' | 'DESIGN' | 'CODING'

export const XIAOGUI_MODES: { id: XiaoguiMode; zhLabel: string }[] = [
  { id: 'WORK', zhLabel: '工作' },
  { id: 'DESIGN', zhLabel: '规划设计' },
  { id: 'CODING', zhLabel: '编程' },
]

/** 执行方式（与一级工作模式正交，与主进程 src/main/xiaogui/config.ts 保持一致）。 */
export type ExecutionPhase = XiaoguiExecutionPhase

/** ToolResult（与小规仓库 docs/DESIGN_TOOLS.md 统一返回结构一致）。 */
export interface XiaoguiEvidence {
  source_type: string
  source_path?: string
  location?: string
  object_id?: string
  excerpt?: string
  hash?: string
  metadata?: Record<string, unknown>
}

export interface XiaoguiToolResult {
  status: 'ok' | 'warning' | 'error'
  data: Record<string, unknown>
  evidence: XiaoguiEvidence[]
  warnings: string[]
  source_version: string
  generated_at: string
  trace_id: string
}

export interface XiaoguiSidecarStatus {
  running: boolean
  mode: XiaoguiMode
  pythonCommand: string
  pythonCwd: string
  lastError: string | null
  pendingRequests: number
}

/**
 * 企业安全护栏只读状态（与主进程 src/main/xiaogui/guard-status.ts 的
 * XiaoguiGuardStatus 保持一致；渲染层不跨进程 import，故在此重新声明）。
 */
export interface XiaoguiGuardStatus {
  version: 1
  deployed: boolean
  enabled: boolean
  scope: 'project' | 'global' | null
  writeRoots: string[]
  dangerCategories: { id: string; zhLabel: string }[]
  audit: { logPath: string; exists: boolean; overrideByEnv: boolean }
  workbenchEnabled: boolean
  reserved?: Record<string, unknown>
}

interface XiaoguiStoreState {
  mode: XiaoguiMode
  executionPhase: ExecutionPhase
  sidecar: XiaoguiSidecarStatus | null
  guardStatus: XiaoguiGuardStatus | null
  invoking: boolean
  lastResult: XiaoguiToolResult | null
  lastError: string | null

  refreshMode: () => Promise<void>
  switchMode: (mode: XiaoguiMode) => Promise<boolean>
  refreshExecutionPhase: () => Promise<void>
  switchExecutionPhase: (phase: ExecutionPhase) => Promise<void>
  refreshSidecarStatus: () => Promise<void>
  refreshGuardStatus: (workspacePath?: string) => Promise<void>
  invokeDesignProjectInspect: (path: string) => Promise<void>
  clearResult: () => void
}

export const useXiaoguiStore = create<XiaoguiStoreState>((set, get) => ({
  mode: 'WORK',
  executionPhase: XIAOGUI_DEFAULT_EXECUTION_PHASE_V1,
  sidecar: null,
  guardStatus: null,
  invoking: false,
  lastResult: null,
  lastError: null,

  refreshMode: async () => {
    try {
      const res = await ipcClient.invoke('xiaogui.mode.get')
      const mode = res?.mode as XiaoguiMode | undefined
      if (mode) set({ mode })
    } catch (e) {
      console.warn('[xiaogui] mode.get 失败:', e)
    }
  },

  switchMode: async (mode) => {
    const previousMode = get().mode
    set({ mode }) // 乐观更新
    // 切模式立即回到新模式首屏（只清视图绑定，后台会话继续运行）
    navigateToModeHome()
    try {
      const res = await ipcClient.invoke('xiaogui.mode.switch', { mode })
      const promptContextStatus = res?.promptContextStatus
      if (
        res?.ok === true &&
        res.mode === mode &&
        (
          promptContextStatus === 'REBUILT' ||
          promptContextStatus === 'NOT_BOUND' ||
          promptContextStatus === 'UNCHANGED'
        )
      ) {
        set({ mode })
        void refreshWorkspaceSessionLists()
        return true
      }
      console.warn('[xiaogui] mode.switch 响应错配:', res)
    } catch (e) {
      console.error('[xiaogui] mode.switch 失败:', e)
    }
    set({ mode: previousMode })
    await get().refreshMode()
    // 模式切换后主动刷新会话列表，让侧栏按新模式重新过滤（小规 scope）
    void refreshWorkspaceSessionLists()
    return false
  },

  refreshExecutionPhase: async () => {
    try {
      const res = await ipcClient.invoke('xiaogui.phase.get')
      const phase = res?.phase as ExecutionPhase | undefined
      if (phase) set({ executionPhase: phase })
    } catch (e) {
      console.warn('[xiaogui] phase.get 失败:', e)
    }
  },

  switchExecutionPhase: async (phase) => {
    set({ executionPhase: phase }) // 乐观更新（执行方式不影响视图路由，无需切首屏）
    try {
      const res = await ipcClient.invoke('xiaogui.phase.switch', { phase })
      if (res?.phase) set({ executionPhase: res.phase as ExecutionPhase })
    } catch (e) {
      console.error('[xiaogui] phase.switch 失败:', e)
      void get().refreshExecutionPhase()
    }
  },

  refreshSidecarStatus: async () => {
    try {
      const res = (await ipcClient.invoke('xiaogui.sidecar.status')) as XiaoguiSidecarStatus
      set({ sidecar: res })
    } catch (e) {
      console.warn('[xiaogui] sidecar.status 失败:', e)
    }
  },

  refreshGuardStatus: async (workspacePath) => {
    try {
      const status = (await ipcClient.invoke('xiaogui.guard.status', {
        workspacePath,
      })) as XiaoguiGuardStatus | null
      set({ guardStatus: status })
    } catch (e) {
      console.warn('[xiaogui] guard.status 失败:', e)
    }
  },

  invokeDesignProjectInspect: async (path) => {
    if (get().invoking) return
    set({ invoking: true, lastError: null })
    try {
      const res = await ipcClient.invoke('xiaogui.tool.invoke', {
        tool: 'design.project',
        action: 'inspect',
        params: { path },
      })
      const result = res?.result as XiaoguiToolResult | undefined
      if (result) {
        set({ lastResult: result, invoking: false })
      } else {
        set({ lastError: '未收到 ToolResult', invoking: false })
      }
    } catch (e) {
      set({
        lastError: e instanceof Error ? e.message : String(e),
        invoking: false,
      })
    }
    void get().refreshSidecarStatus()
  },

  clearResult: () => set({ lastResult: null, lastError: null }),
}))
