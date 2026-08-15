import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

// 内存版 electron-store 替身：sidecar-bridge → scope-store 在模块加载期构造
// electron-store，测试环境无 Electron app，用空实现替身（同 scope-store.test.ts）。
vi.mock('electron-store', () => {
  class FakeStore<T extends object> {
    private readonly defaults: Partial<T>
    constructor(options?: { name?: string; defaults?: Partial<T>; clearInvalidConfig?: boolean }) {
      this.defaults = options?.defaults ?? {}
    }
    get<K extends string>(key: K): unknown {
      return (this.defaults as Record<string, unknown>)[key]
    }
    set(key: string, value: unknown): void {
      void key
      void value
    }
  }
  return { default: FakeStore }
})

import { buildSidecarEnv, resolveAllowedRoots } from './sidecar-bridge'

describe('resolveAllowedRoots（白名单默认收敛）', () => {
  it('未显式配置时收敛为 [当前项目根]', () => {
    expect(resolveAllowedRoots([], 'D:/proj/demo')).toEqual(['D:/proj/demo'])
  })

  it('显式配置存在时用配置 ∪ 当前项目根（向后兼容）', () => {
    expect(resolveAllowedRoots(['D:/x', 'D:/y'], 'D:/proj/demo')).toEqual([
      'D:/x',
      'D:/y',
      'D:/proj/demo',
    ])
  })

  it('去重与去空：项目根与配置重复或为空时不重复/不注入', () => {
    expect(resolveAllowedRoots(['D:/proj/demo'], 'D:/proj/demo')).toEqual(['D:/proj/demo'])
    expect(resolveAllowedRoots([''], '  ')).toEqual([])
    expect(resolveAllowedRoots([], null)).toEqual([])
  })
})

describe('buildSidecarEnv（sidecar 子进程 env 构造）', () => {
  it('未配置 allowedRoots 时 env 注入当前项目根（安全默认）', () => {
    const env = buildSidecarEnv({}, { allowedRoots: [], requestTimeoutMs: 30_000 }, 'D:/proj/demo')
    expect(env['XIAOGUI_ALLOWED_ROOTS']).toBe('D:/proj/demo')
  })

  it('显式配置时 env 为配置 ∪ 当前项目根', () => {
    const env = buildSidecarEnv(
      {},
      { allowedRoots: ['D:/x'], requestTimeoutMs: 30_000 },
      'D:/proj/demo',
    )
    expect(env['XIAOGUI_ALLOWED_ROOTS']).toBe(['D:/x', 'D:/proj/demo'].join(path.delimiter))
  })

  it('两者皆空时不设置 XIAOGUI_ALLOWED_ROOTS（保持 sidecar 侧既有语义）', () => {
    const env = buildSidecarEnv({}, { allowedRoots: [], requestTimeoutMs: 30_000 }, null)
    expect(env['XIAOGUI_ALLOWED_ROOTS']).toBeUndefined()
  })

  it('透传 base env 并注入 XIAOGUI_REQUEST_TIMEOUT（秒）', () => {
    const env = buildSidecarEnv({ FOO: 'bar' }, { allowedRoots: [], requestTimeoutMs: 30_000 })
    expect(env['FOO']).toBe('bar')
    expect(env['XIAOGUI_REQUEST_TIMEOUT']).toBe('30')
  })
})