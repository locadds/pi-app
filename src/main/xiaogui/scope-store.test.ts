import { beforeEach, describe, expect, it, vi } from 'vitest'

// 内存版 electron-store 替身：记录构造参数（验证 clearInvalidConfig 崩溃防护），
// 数据落在 hoisted 共享对象里，便于测试间重置。
const mem = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  lastOptions: null as null | { name?: string; clearInvalidConfig?: boolean },
  setCalls: [] as Array<{ key: string; value: unknown }>,
  throwOnCanonicalSet: false,
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
      if (key === 'canonicalScopeBindings' && mem.throwOnCanonicalSet) {
        throw new Error('cannot write D:/private/xiaogui.json')
      }
      mem.setCalls.push({ key, value })
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
  sessionScopePersistenceV1,
  setScope,
} from './scope-store'
import { opaqueScopeIdDeriverV1 } from './scope-derive'
import { SessionScopeResolutionError } from './scope-resolver'

beforeEach(() => {
  mem.data = {}
  mem.setCalls = []
  mem.throwOnCanonicalSet = false
  __resetScopeStoreForTests()
  mem.setCalls = []
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

function sessionCommit(root: string, file: string, sessionMode: 'WORK' | 'DESIGN' | 'CODING') {
  const project = opaqueScopeIdDeriverV1.deriveProject(root)
  const session = opaqueScopeIdDeriverV1.deriveSession(project.projectId, file)
  return {
    project: {
      kind: 'PROJECT' as const,
      opaqueId: project.projectId,
      canonicalInputFingerprint: project.canonicalInputFingerprint,
    },
    session: {
      kind: 'SESSION' as const,
      opaqueId: session.sessionKey,
      projectId: project.projectId,
      canonicalInputFingerprint: session.canonicalInputFingerprint,
    },
    sessionMode,
  }
}

describe('scope-store：canonical binding 原子持久化', () => {
  it('一次写入 project + session，并以无路径 DTO 只读查询', () => {
    const input = sessionCommit('D:/projects/alpha', 'D:/projects/alpha/one.jsonl', 'CODING')
    expect(sessionScopePersistenceV1.commitSession(input)).toBe('CODING')
    expect(mem.setCalls.filter((call) => call.key === 'canonicalScopeBindings')).toHaveLength(1)

    mem.setCalls = []
    expect(
      sessionScopePersistenceV1.lookup({
        projectId: input.project.opaqueId,
        sessionKey: input.session.opaqueId,
      }),
    ).toEqual({
      kind: 'FOUND',
      scope: {
        projectId: input.project.opaqueId,
        sessionKey: input.session.opaqueId,
        sessionMode: 'CODING',
      },
    })
    expect(mem.setCalls).toEqual([])
  })

  it('按可信绑定只读查询时核对指纹且绝不补写', () => {
    const input = sessionCommit('D:/projects/alpha', 'D:/projects/alpha/one.jsonl', 'DESIGN')
    expect(sessionScopePersistenceV1.lookupBoundSession(input)).toEqual({ kind: 'NOT_FOUND' })
    expect(mem.setCalls).toEqual([])

    sessionScopePersistenceV1.commitSession(input)
    mem.setCalls = []
    expect(sessionScopePersistenceV1.lookupBoundSession(input)).toMatchObject({
      kind: 'FOUND',
      scope: { sessionMode: 'DESIGN' },
    })
    expect(() =>
      sessionScopePersistenceV1.lookupBoundSession({
        project: input.project,
        session: {
          ...input.session,
          canonicalInputFingerprint: 'e'.repeat(64) as never,
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'OPAQUE_ID_COLLISION' }))
    expect(mem.setCalls).toEqual([])
  })

  it('same binding is idempotent and preserves the first canonical mode', () => {
    const input = sessionCommit('D:/projects/alpha', 'D:/projects/alpha/one.jsonl', 'WORK')
    expect(sessionScopePersistenceV1.commitSession(input)).toBe('WORK')
    mem.setCalls = []
    expect(sessionScopePersistenceV1.commitSession({ ...input, sessionMode: 'DESIGN' })).toBe('WORK')
    expect(mem.setCalls).toEqual([])
  })

  it('fails closed for project/session collisions without overwriting', () => {
    const input = sessionCommit('D:/projects/alpha', 'D:/projects/alpha/one.jsonl', 'WORK')
    sessionScopePersistenceV1.commitSession(input)
    const snapshot = structuredClone(mem.data['canonicalScopeBindings'])

    expect(() =>
      sessionScopePersistenceV1.commitSession({
        ...input,
        project: {
          ...input.project,
          canonicalInputFingerprint: 'f'.repeat(64) as never,
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'OPAQUE_ID_COLLISION' }))
    expect(() =>
      sessionScopePersistenceV1.commitSession({
        ...input,
        session: {
          ...input.session,
          canonicalInputFingerprint: 'e'.repeat(64) as never,
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'OPAQUE_ID_COLLISION' }))
    expect(mem.data['canonicalScopeBindings']).toEqual(snapshot)
  })

  it('distinguishes a parent-project mismatch and keeps lookup zero-write', () => {
    const input = sessionCommit('D:/projects/alpha', 'D:/projects/alpha/one.jsonl', 'WORK')
    sessionScopePersistenceV1.commitSession(input)
    const otherProject = opaqueScopeIdDeriverV1.deriveProject('D:/projects/other')

    mem.setCalls = []
    expect(
      sessionScopePersistenceV1.lookup({
        projectId: otherProject.projectId,
        sessionKey: input.session.opaqueId,
      }),
    ).toEqual({ kind: 'PROJECT_MISMATCH' })
    expect(mem.setCalls).toEqual([])
  })

  it('does not leave a half-written canonical mapping when persistence fails', () => {
    const input = sessionCommit('D:/projects/alpha', 'D:/projects/alpha/one.jsonl', 'WORK')
    const before = structuredClone(mem.data['canonicalScopeBindings'])
    mem.throwOnCanonicalSet = true
    expect(() => sessionScopePersistenceV1.commitSession(input)).toThrow('cannot write')
    expect(mem.data['canonicalScopeBindings']).toEqual(before)
  })

  it('fails closed on malformed persisted canonical data', () => {
    mem.data['canonicalScopeBindings'] = {
      version: 1,
      projects: { 'D:/leaked-path': { canonicalInputFingerprint: 'a'.repeat(64) } },
      sessions: {},
      sandboxes: {},
    }
    expect(() =>
      sessionScopePersistenceV1.lookup({
        projectId: 'xgp1_invalid' as never,
        sessionKey: 'xgs1_invalid' as never,
      }),
    ).toThrow(SessionScopeResolutionError)
  })

  it('rejects orphan session bindings and invalid incoming modes', () => {
    const input = sessionCommit('D:/projects/alpha', 'D:/projects/alpha/one.jsonl', 'WORK')
    mem.data['canonicalScopeBindings'] = {
      version: 1,
      projects: {},
      sessions: {
        [input.session.opaqueId]: {
          projectId: input.project.opaqueId,
          canonicalInputFingerprint: input.session.canonicalInputFingerprint,
          sessionMode: 'WORK',
        },
      },
      sandboxes: {},
    }
    expect(() =>
      sessionScopePersistenceV1.lookup({
        projectId: input.project.opaqueId,
        sessionKey: input.session.opaqueId,
      }),
    ).toThrow(expect.objectContaining({ code: 'CANONICAL_SCOPE_STORE_CORRUPT' }))

    __resetScopeStoreForTests()
    expect(() =>
      sessionScopePersistenceV1.commitSession({ ...input, sessionMode: 'UNKNOWN' as never }),
    ).toThrow(expect.objectContaining({ code: 'CANONICAL_INPUT_MISMATCH' }))
  })

  it('persists and collision-checks sandbox bindings without a locator', () => {
    const project = opaqueScopeIdDeriverV1.deriveProject('D:/projects/alpha')
    const sandbox = opaqueScopeIdDeriverV1.deriveSandbox(project.projectId, 'D:/sandboxes/one')
    const input = {
      project: {
        kind: 'PROJECT' as const,
        opaqueId: project.projectId,
        canonicalInputFingerprint: project.canonicalInputFingerprint,
      },
      sandbox: {
        kind: 'SANDBOX' as const,
        opaqueId: sandbox.sandboxKey,
        projectId: project.projectId,
        canonicalInputFingerprint: sandbox.canonicalInputFingerprint,
      },
    }
    sessionScopePersistenceV1.commitSandbox(input)
    mem.setCalls = []
    sessionScopePersistenceV1.commitSandbox(input)
    expect(mem.setCalls).toEqual([])

    expect(() =>
      sessionScopePersistenceV1.commitSandbox({
        ...input,
        sandbox: {
          ...input.sandbox,
          canonicalInputFingerprint: 'd'.repeat(64) as never,
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'OPAQUE_ID_COLLISION' }))
  })
})
