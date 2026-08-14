import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// jsdom does not enable pretendToBeVisual by default, so requestAnimationFrame
// never fires in tests. Polyfill with setTimeout so deferred UI commits (e.g.
// the model-switch toast after the picker unmounts) resolve in tests too.
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id)
}

// Mock matchMedia (not available in jsdom)
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

// Mock IntersectionObserver
class MockIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  takeRecords = vi.fn()
}
if (!window.IntersectionObserver) {
  Object.defineProperty(window, 'IntersectionObserver', {
    writable: true,
    value: MockIntersectionObserver,
  })
}

// Mock ResizeObserver
class MockResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
if (!window.ResizeObserver) {
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: MockResizeObserver,
  })
}

// Node 25 原生 localStorage 会遮蔽 jsdom 实现（--localstorage-file 无有效路径时
// setItem/removeItem/clear 均为 undefined），zustand persist 与主题缓存在测试里
// 会抛 "localStorage.removeItem is not a function"；在全局 setup 阶段安装内存版
// 实现（仅当环境损坏时，不影响正常 jsdom 环境）。
const localStorageBroken =
  typeof globalThis.localStorage === 'undefined' ||
  typeof globalThis.localStorage.setItem !== 'function'
if (localStorageBroken) {
  const mem = new Map<string, string>()
  const storage: Storage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(String(k), String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => void mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
}
