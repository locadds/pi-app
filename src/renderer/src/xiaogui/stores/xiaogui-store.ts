/**
 * 小规 UI state：当前一级模式、sidecar 状态、design.project.inspect 结果。
 *
 * 渲染进程不直接接触文件系统/Python 进程，所有操作经 IPC 白名单通道
 * （xiaogui.mode.switch / mode.get / tool.invoke / sidecar.status）进入主进程。
 */

import { create } from 'zustand'

import { ipcClient } from '@renderer/lib/ipc-client'
import { refreshWorkspaceSessionLists } from '@renderer/lib/refresh-workspace-session-lists'

export type XiaoguiMode = 'WORK' | 'DESIGN' | 'CODING'

export const XIAOGUI_MODES: { id: XiaoguiMode; zhLabel: string }[] = [
  { id: 'WORK', zhLabel: '工作' },
  { id: 'DESIGN', zhLabel: '规划设计' },
  { id: 'CODING', zhLabel: '编程' },
]

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

interface XiaoguiStoreState {
  mode: XiaoguiMode
  sidecar: XiaoguiSidecarStatus | null
  invoking: boolean
  lastResult: XiaoguiToolResult | null
  lastError: string | null

  refreshMode: () => Promise<void>
  switchMode: (mode: XiaoguiMode) => Promise<void>
  refreshSidecarStatus: () => Promise<void>
  invokeDesignProjectInspect: (path: string) => Promise<void>
  clearResult: () => void
}

export const useXiaoguiStore = create<XiaoguiStoreState>((set, get) => ({
  mode: 'WORK',
  sidecar: null,
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
    set({ mode }) // 乐观更新
    try {
      const res = await ipcClient.invoke('xiaogui.mode.switch', { mode })
      if (res?.mode) set({ mode: res.mode as XiaoguiMode })
    } catch (e) {
      console.error('[xiaogui] mode.switch 失败:', e)
      void get().refreshMode()
    }
    // 模式切换后主动刷新会话列表，让侧栏按新模式重新过滤（小规 scope）
    void refreshWorkspaceSessionLists()
  },

  refreshSidecarStatus: async () => {
    try {
      const res = (await ipcClient.invoke('xiaogui.sidecar.status')) as XiaoguiSidecarStatus
      set({ sidecar: res })
    } catch (e) {
      console.warn('[xiaogui] sidecar.status 失败:', e)
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
