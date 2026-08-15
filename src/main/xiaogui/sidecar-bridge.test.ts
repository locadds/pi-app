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

import {
  buildSidecarEnv,
  planSidecarLifecycle,
  resolveAllowedRoots,
  resolveSidecarIdentity,
} from './sidecar-bridge'

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

  it('两者皆空时显式传空白名单，调用层必须先 fail-closed', () => {
    const env = buildSidecarEnv({}, { allowedRoots: [], requestTimeoutMs: 30_000 }, null)
    expect(env['XIAOGUI_ALLOWED_ROOTS']).toBe('')
  })

  it('透传 base env 并注入 XIAOGUI_REQUEST_TIMEOUT（秒）', () => {
    const env = buildSidecarEnv({ FOO: 'bar' }, { allowedRoots: [], requestTimeoutMs: 30_000 })
    expect(env['FOO']).toBe('bar')
    expect(env['XIAOGUI_REQUEST_TIMEOUT']).toBe('30')
  })

  it('传入 effectiveAllowedRoots 时直接采用，不再解析 projectRoot/configRoots', () => {
    const env = buildSidecarEnv(
      {},
      { allowedRoots: ['D:/ignored'], requestTimeoutMs: 30_000 },
      'D:/ignored-project',
      ['D:/effective'],
    )
    expect(env['XIAOGUI_ALLOWED_ROOTS']).toBe('D:/effective')
  })
})

describe('resolveSidecarIdentity（启动身份与 fail-closed）', () => {
  it('没有 runtime 时返回结构化错误，不启动 sidecar', () => {
    const result = resolveSidecarIdentity(
      {
        pythonCwd: null,
        runtimeError: 'runtime missing',
        allowedRoots: [],
      },
      'D:/proj/demo',
    )
    expect(result).toEqual({ ok: false, error: 'runtime missing' })
  })

  it('没有项目根且没有显式白名单时拒绝项目工具', () => {
    const result = resolveSidecarIdentity(
      {
        pythonCwd: 'D:/runtime',
        runtimeError: null,
        allowedRoots: [],
      },
      null,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('空白名单')
  })

  it('没有项目根但有显式白名单时允许项目工具', () => {
    const result = resolveSidecarIdentity(
      {
        pythonCwd: 'D:/runtime',
        runtimeError: null,
        allowedRoots: ['D:/allowed'],
      },
      null,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.identity.allowedRoots).toEqual(['D:/allowed'])
      expect(result.identity.runtimeDir).toBe('D:/runtime')
    }
  })

  it('启动身份包含 runtimeDir 与白名单；项目 A/B key 不同', () => {
    const base = {
      pythonCwd: 'D:/runtime',
      runtimeError: null,
      allowedRoots: [],
    }
    const a = resolveSidecarIdentity(base, 'D:/proj/a')
    const b = resolveSidecarIdentity(base, 'D:/proj/b')
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.identity.allowedRoots).toEqual(['D:/proj/a'])
      expect(b.identity.allowedRoots).toEqual(['D:/proj/b'])
      expect(a.identity.key).not.toBe(b.identity.key)
    }
  })
})

describe('planSidecarLifecycle（项目切换生命周期策略）', () => {
  it('未运行时启动；身份相同时复用', () => {
    expect(
      planSidecarLifecycle({
        running: false,
        activeIdentityKey: null,
        nextIdentityKey: 'a',
        pendingRequests: 0,
      }),
    ).toBe('start')
    expect(
      planSidecarLifecycle({
        running: true,
        activeIdentityKey: 'a',
        nextIdentityKey: 'a',
        pendingRequests: 0,
      }),
    ).toBe('reuse')
  })

  it('项目 A 切到 B：无挂起请求时重启，有挂起请求时确定性拒绝', () => {
    expect(
      planSidecarLifecycle({
        running: true,
        activeIdentityKey: 'project-a',
        nextIdentityKey: 'project-b',
        pendingRequests: 0,
      }),
    ).toBe('restart')
    expect(
      planSidecarLifecycle({
        running: true,
        activeIdentityKey: 'project-a',
        nextIdentityKey: 'project-b',
        pendingRequests: 1,
      }),
    ).toBe('reject')
  })
})