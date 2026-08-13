import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // Node 25 原生 localStorage 遮蔽 jsdom 实现（无 setItem），zustand persist
  // 写入会在测试里炸；在模块 import 前安装内存版实现（仅当环境损坏时）。
  const broken = typeof localStorage === 'undefined' || typeof localStorage.setItem !== 'function'
  if (!broken) return
  const mem = new Map<string, string>()
  const storage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => void mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
})

// 只拦截测试关心的通道，其余透传真实 ipcClient：
// 全局替换会让 tool-card-registry 等模块导入期的 invoke 悬空，污染同图的其他测试文件
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@renderer/lib/ipc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/ipc-client')>()
  const INTERCEPT = /^(workspace\.sandbox\.create|workspace\.open|xiaogui\.)/
  return {
    ...actual,
    ipcClient: {
      ...actual.ipcClient,
      invoke: (channel: string, request?: unknown) =>
        INTERCEPT.test(channel)
          ? mocks.invoke(channel, request)
          : actual.ipcClient.invoke(channel, request),
    },
  }
})
vi.mock('@renderer/lib/new-session', () => ({
  materializePendingNewSession: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@renderer/lib/session-navigation', () => ({ beginSessionNavigation: vi.fn() }))

import { useUIStore } from '@renderer/stores/ui-store'
import { useModeScopeStore } from '@renderer/xiaogui/lib/mode-scope'
import { useXiaoguiStore } from '@renderer/xiaogui/stores/xiaogui-store'

import { finalizeEphemeralSandboxOnFirstSend } from './ephemeral-sandbox'

beforeEach(() => {
  mocks.invoke.mockReset()
  localStorage.clear()
  useModeScopeStore.setState({ loaded: false, sessionModeMap: {}, projectModeMap: {} })
  useXiaoguiStore.setState({ mode: 'WORK' })
})

describe('ephemeral-sandbox × 小规模式作用域（#28 实时视图刷新）', () => {
  it('sandbox 创建后立即回填模式映射到本地缓存并触发全量拉取', async () => {
    useXiaoguiStore.setState({ mode: 'DESIGN' })
    useUIStore.setState({ ephemeralSandboxDraft: true, currentWorkspace: null })
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'workspace.sandbox.create') {
        return { sandbox: { path: 'D:/sandboxes/hi', label: 'hi' } }
      }
      // 主进程 ground truth：sandbox 创建处已按当前模式打好标签
      if (channel === 'xiaogui.scope.list') {
        return { sessionModeMap: {}, projectModeMap: { 'D:/sandboxes/hi': 'DESIGN' } }
      }
      return {}
    })

    await expect(finalizeEphemeralSandboxOnFirstSend('hi')).resolves.toBe('D:/sandboxes/hi')

    // 动态 import 回填是异步的，等待落定：本地缓存立即包含新映射（无需重启/侧栏重挂）
    await vi.waitFor(() => {
      expect(useModeScopeStore.getState().projectModeMap['D:/sandboxes/hi']).toBe('DESIGN')
    })
    // 回填同时触发 refreshModeScope 全量拉取，与主进程保持最终一致
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('xiaogui.scope.list', undefined),
    )
  })
})
