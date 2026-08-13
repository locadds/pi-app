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

import { useUIStore } from '@renderer/stores/ui-store'

// 只拦截 xiaogui.*（scope 通道），其余透传真实 ipcClient：
// 全局替换会让 tool-card-registry 等模块导入期的 invoke 悬空，污染同图的其他测试文件
const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }))
vi.mock('@renderer/lib/ipc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/ipc-client')>()
  const INTERCEPT = /^xiaogui\./
  return {
    ...actual,
    ipcClient: {
      ...actual.ipcClient,
      invoke: (channel: string, request?: unknown) =>
        INTERCEPT.test(channel)
          ? mockInvoke(channel, request)
          : actual.ipcClient.invoke(channel, request),
    },
  }
})

import {
  __resetProjectBaselineForTests,
  refreshModeScope,
  rememberSandboxScope,
  resolveProjectMode,
  resolveSessionMode,
  startProjectBaselineWatcher,
  tagProjectWithCurrentModeIfAbsent,
  tagSessionWithCurrentMode,
  useModeScopeStore,
} from './mode-scope'
import { useXiaoguiStore } from '../stores/xiaogui-store'

beforeEach(() => {
  mockInvoke.mockReset()
  // ui-store 带 persist：清空测试间泄漏的持久化数据，避免 rehydrate 污染
  localStorage.clear()
  useModeScopeStore.setState({ loaded: false, sessionModeMap: {}, projectModeMap: {} })
  useXiaoguiStore.setState({ mode: 'WORK' })
  useUIStore.setState({ recentProjects: [], currentWorkspace: null })
  __resetProjectBaselineForTests()
})

describe('mode-scope：历史数据默认 WORK', () => {
  it('查不到映射的会话/项目一律解析为 WORK', () => {
    expect(resolveSessionMode('D:/proj/.pi/agent/sessions/a.jsonl')).toBe('WORK')
    expect(resolveProjectMode('D:/proj')).toBe('WORK')
    expect(resolveSessionMode(undefined)).toBe('WORK')
  })

  it('refreshModeScope 从主进程拉取映射后按映射解析（key 规范化等价）', async () => {
    mockInvoke.mockResolvedValueOnce({
      sessionModeMap: { 'D:/proj/.pi/agent/sessions/a.jsonl': 'DESIGN' },
      projectModeMap: { 'D:/design-proj': 'DESIGN' },
    })
    await refreshModeScope()
    // 反斜杠 + 小写盘符的 key 也能命中（与主进程规范化等价）
    expect(resolveSessionMode('d:\\proj\\.pi\\agent\\sessions\\a.jsonl')).toBe('DESIGN')
    expect(resolveProjectMode('d:/design-proj')).toBe('DESIGN')
    expect(resolveProjectMode('D:/other')).toBe('WORK')
  })
})

describe('mode-scope：写入时打标签', () => {
  it('tagSessionWithCurrentMode 用规范化 key 与当前 mode 写主进程并更新本地', async () => {
    useXiaoguiStore.setState({ mode: 'CODING' })
    mockInvoke.mockResolvedValueOnce({ ok: true, mode: 'CODING' })
    await tagSessionWithCurrentMode('d:\\proj\\.pi\\agent\\sessions\\b.jsonl')
    expect(mockInvoke).toHaveBeenCalledWith('xiaogui.scope.set', {
      kind: 'session',
      key: 'D:/proj/.pi/agent/sessions/b.jsonl'.toLowerCase().replace(/^d:/, 'D:'),
      mode: 'CODING',
    })
    expect(resolveSessionMode('D:/proj/.pi/agent/sessions/b.jsonl')).toBe('CODING')
  })

  it('tagSessionWithCurrentMode 乐观写失败时回滚该 key 并触发全量刷新', async () => {
    useXiaoguiStore.setState({ mode: 'CODING' })
    // 首次 scope.set 失败；回滚后的兜底 refreshModeScope（scope.list）返回空映射
    mockInvoke.mockRejectedValueOnce(new Error('boom'))
    mockInvoke.mockResolvedValueOnce({ sessionModeMap: {}, projectModeMap: {} })
    await tagSessionWithCurrentMode('D:/proj/.pi/agent/sessions/c.jsonl')
    expect(resolveSessionMode('D:/proj/.pi/agent/sessions/c.jsonl')).toBe('WORK')
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('xiaogui.scope.list', undefined),
    )
  })

  it('tagProjectWithCurrentModeIfAbsent 以主进程返回的生效模式回填（不覆盖已有映射）', async () => {
    useXiaoguiStore.setState({ mode: 'WORK' })
    // 主进程已有 DESIGN 映射：ifAbsent 命中，返回 DESIGN
    mockInvoke.mockResolvedValueOnce({ ok: true, mode: 'DESIGN' })
    await tagProjectWithCurrentModeIfAbsent('D:/design-proj')
    expect(mockInvoke).toHaveBeenCalledWith('xiaogui.scope.set', {
      kind: 'project',
      key: 'D:/design-proj',
      mode: 'WORK',
      ifAbsent: true,
    })
    expect(resolveProjectMode('D:/design-proj')).toBe('DESIGN')
  })
})

describe('mode-scope：项目基线（历史归 WORK，存量不打标签）', () => {
  it('挂载时上报存量 recentProjects 为基线；基线内项目不打标签', async () => {
    useXiaoguiStore.setState({ mode: 'DESIGN' })
    useUIStore.setState({ recentProjects: ['D:/old-proj'], currentWorkspace: 'D:/old-proj' })
    mockInvoke.mockResolvedValue({ ok: true, baseline: [], recorded: 1 })
    const stop = startProjectBaselineWatcher()
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('xiaogui.scope.baselineProjects', {
        paths: ['D:/old-proj'],
      }),
    )

    // recentProjects 不变（只是重新打开历史项目）：不打标签
    useUIStore.setState({ recentProjects: ['D:/old-proj'] })
    await new Promise((r) => setTimeout(r, 10))
    for (const call of mockInvoke.mock.calls) {
      expect(call[0]).not.toBe('xiaogui.scope.set')
    }
    stop()
  })

  it('基线之后新出现的项目打当前模式标签', async () => {
    useXiaoguiStore.setState({ mode: 'CODING' })
    useUIStore.setState({ recentProjects: ['D:/old-proj'] })
    mockInvoke.mockResolvedValue({ ok: true, mode: 'CODING', baseline: [], recorded: 1 })
    const stop = startProjectBaselineWatcher()
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('xiaogui.scope.baselineProjects', {
        paths: ['D:/old-proj'],
      }),
    )

    useUIStore.setState({ recentProjects: ['D:/old-proj', 'D:/brand-new'] })
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('xiaogui.scope.set', {
        kind: 'project',
        key: 'D:/brand-new',
        mode: 'CODING',
        ifAbsent: true,
      }),
    )
    // 基线内的旧项目从未被打标签
    for (const call of mockInvoke.mock.calls) {
      if (call[0] === 'xiaogui.scope.set') {
        expect((call[1] as { key: string }).key).not.toBe('D:/old-proj')
      }
    }
    stop()
  })
})

describe('mode-scope：sandbox 临时对话创建后回填（#28）', () => {
  it('rememberSandboxScope 后本地缓存立即包含该 sandbox 映射（同步生效，key 规范化）', () => {
    useXiaoguiStore.setState({ mode: 'DESIGN' })
    mockInvoke.mockResolvedValue({ sessionModeMap: {}, projectModeMap: {} })
    rememberSandboxScope('d:\\sandboxes\\chat-1')
    // 同步回填：不等任何 IPC 即可被过滤逻辑解析
    expect(resolveProjectMode('D:/sandboxes/chat-1')).toBe('DESIGN')
    // 目录段大小写不敏感（与主进程规范化等价）
    expect(resolveProjectMode('d:/SANDBOXES/Chat-1')).toBe('DESIGN')
  })

  it('rememberSandboxScope 触发 refreshModeScope 全量拉取与主进程对齐', async () => {
    useXiaoguiStore.setState({ mode: 'DESIGN' })
    // 模拟主进程 ground truth：创建处已打标签，scope.list 返回该映射
    mockInvoke.mockResolvedValue({
      sessionModeMap: {},
      projectModeMap: { 'D:/sandboxes/chat-2': 'DESIGN' },
    })
    rememberSandboxScope('D:/sandboxes/chat-2')
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('xiaogui.scope.list', undefined),
    )
    // 全量对齐后映射仍在（与主进程一致，不会被误判为历史归 WORK）
    expect(resolveProjectMode('D:/sandboxes/chat-2')).toBe('DESIGN')
  })
})
