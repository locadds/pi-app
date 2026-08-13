import { beforeEach, describe, expect, it, vi } from 'vitest'

// 内存版 electron-store 替身：记录构造参数（验证 clearInvalidConfig 崩溃防护），
// 数据落在 hoisted 共享对象里，便于测试间重置。
const mem = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  lastOptions: null as null | { name?: string; clearInvalidConfig?: boolean },
}))

vi.mock('electron-store', () => {
  class FakeStore<T extends object> {
    private readonly defaults: Partial<T>
    constructor(options?: { name?: string; defaults?: Partial<T>; clearInvalidConfig?: boolean }) {
      mem.lastOptions = { name: options?.name, clearInvalidConfig: options?.clearInvalidConfig }
      this.defaults = options?.defaults ?? {}
    }
    get<K extends string>(key: K): unknown {
      return key in mem.data ? mem.data[key] : (this.defaults as Record<string, unknown>)[key]
    }
    set(key: string, value: unknown): void {
      mem.data[key] = value
    }
  }
  return { default: FakeStore }
})

import {
  __resetScopeStoreForTests,
  getProjectBaseline,
  getScope,
  listScopes,
  loadPersistedMode,
  persistMode,
  recordProjectBaseline,
  setScope,
} from './scope-store'

beforeEach(() => {
  mem.data = {}
  __resetScopeStoreForTests()
})

describe('scope-store 构造与崩溃防护', () => {
  it('使用独立 name=xiaogui 且开启 clearInvalidConfig（损坏配置不炸主进程）', () => {
    expect(mem.lastOptions).toEqual(
      expect.objectContaining({ name: 'xiaogui', clearInvalidConfig: true }),
    )
  })
})

describe('scope-store：setScope / getScope', () => {
  it('ifAbsent 命中已有映射时返回原值且不覆盖', () => {
    setScope('project', 'D:/proj', 'DESIGN')
    const effective = setScope('project', 'D:/proj', 'CODING', { ifAbsent: true })
    expect(effective).toBe('DESIGN')
    expect(getScope('project', 'D:/proj')).toBe('DESIGN')
  })

  it('ifAbsent=false（默认）覆盖已有映射', () => {
    setScope('session', 'D:/p/a.jsonl', 'DESIGN')
    const effective = setScope('session', 'D:/p/a.jsonl', 'CODING')
    expect(effective).toBe('CODING')
    expect(getScope('session', 'D:/p/a.jsonl')).toBe('CODING')
  })

  it('写后读一致（含规范化 key 的多种写法）', () => {
    setScope('project', 'd:\\Proj\\', 'CODING')
    expect(getScope('project', 'D:/proj')).toBe('CODING')
    expect(getScope('project', 'd:/PROJ/')).toBe('CODING')
    expect(listScopes().projectModeMap['D:/proj']).toBe('CODING')
  })

  it('非法 key / 非法模式值在读取时被 sanitize 丢弃', () => {
    // 直接注入脏数据模拟历史污染
    mem.data['sessionModeMap'] = {
      'D:/ok/a.jsonl': 'DESIGN',
      '   ': 'CODING',
      'D:/bad/b.jsonl': 'PLANNING',
      '': 'WORK',
    }
    expect(getScope('session', 'D:/ok/a.jsonl')).toBe('DESIGN')
    const map = listScopes().sessionModeMap
    expect(Object.keys(map)).toEqual(['D:/ok/a.jsonl'])
  })

  it('查不到的 key 返回 null（渲染层按历史数据 WORK 处理）', () => {
    expect(getScope('project', 'D:/never-tagged')).toBeNull()
    expect(getScope('session', '')).toBeNull()
  })
})

describe('scope-store：mode 持久化', () => {
  it('写后读一致', () => {
    persistMode('CODING')
    expect(loadPersistedMode()).toBe('CODING')
  })

  it('非法 mode 回退 WORK', () => {
    mem.data['mode'] = 'PLANNING'
    expect(loadPersistedMode()).toBe('WORK')
  })
})

describe('scope-store：项目基线', () => {
  it('记录基线取并集且规范化去重', () => {
    expect(recordProjectBaseline(['D:/a', 'd:\\a\\'])).toBe(1)
    expect(recordProjectBaseline(['D:/b'])).toBe(2)
    expect(getProjectBaseline().sort()).toEqual(['D:/a', 'D:/b'])
  })

  it('脏基线数据被 sanitize', () => {
    mem.data['projectBaseline'] = ['D:/ok/', '', 42, null]
    expect(getProjectBaseline()).toEqual(['D:/ok'])
  })
})
