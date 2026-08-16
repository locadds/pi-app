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
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  })
})

// 只拦截测试关心的通道，其余透传真实 ipcClient：
// 全局替换会让 tool-card-registry 等模块导入期的 invoke 悬空，污染同图的其他测试文件
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  materializePendingNewSession: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@renderer/lib/ipc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/ipc-client')>()
  const INTERCEPT = /^(workspace\.sandbox\.create|workspace\.open|xiaogui\.)/
  return {
    ...actual,
    ipcClient: {
      ...actual.ipcClient,
      invoke: (channel: string, request?: unknown) =>
        INTERCEPT.test(channel) ? mocks.invoke(channel, request) : actual.ipcClient.invoke(channel, request),
    },
  }
})
vi.mock('@renderer/lib/new-session', () => ({
  materializePendingNewSession: mocks.materializePendingNewSession,
}))
vi.mock('@renderer/lib/session-navigation', () => ({
  beginSessionNavigation: vi.fn(),
}))

import { useUIStore } from '@renderer/stores/ui-store'
import { useXiaoguiStore } from '@renderer/xiaogui/stores/xiaogui-store'

import { finalizeEphemeralSandboxOnFirstSend } from './ephemeral-sandbox'

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.materializePendingNewSession.mockClear()
  localStorage.clear()
  useXiaoguiStore.setState({ mode: 'WORK' })
})

describe('ephemeral-sandbox canonical session creation', () => {
  it('passes the current mode as a creation intent without renderer path maps', async () => {
    useXiaoguiStore.setState({ mode: 'DESIGN' })
    useUIStore.setState({
      ephemeralSandboxDraft: true,
      currentWorkspace: null,
    })
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'workspace.sandbox.create') {
        return { sandbox: { path: 'D:/sandboxes/hi', label: 'hi' } }
      }
      return {}
    })

    await expect(finalizeEphemeralSandboxOnFirstSend('hi')).resolves.toBe('D:/sandboxes/hi')

    expect(mocks.materializePendingNewSession).toHaveBeenCalledWith('D:/sandboxes/hi', 'hi', undefined, 'DESIGN')
    expect(mocks.invoke).not.toHaveBeenCalledWith('xiaogui.scope.list', expect.anything())
  })
})
