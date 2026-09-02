import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { CodingRoleProfileDraftV1 } from './role-profile-module'
import { CodingRoleProfileModuleV1 } from './role-profile-module'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-coding-role-profile-'))
  roots.push(root)
  return join(root, 'roles.sqlite')
}

function draft(overrides: Partial<CodingRoleProfileDraftV1> = {}): CodingRoleProfileDraftV1 {
  return {
    schemaVersion: 1,
    profileId: 'role.implement.custom',
    role: 'IMPLEMENT',
    name: '实现角色',
    description: '在受控工作树内完成已经批准的计划。',
    systemPrompt: '只在批准范围内实现，并使用真实命令验证结果。',
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.local-or-remote',
    toolAllowlist: ['read', 'bash', 'edit', 'write'],
    ...overrides,
  }
}

const LEGACY_DEFAULT_DRAFTS: readonly CodingRoleProfileDraftV1[] = [
  {
    schemaVersion: 1,
    profileId: 'xiaogui.role.research.default',
    role: 'RESEARCH',
    name: '研究',
    description: '只读理解项目、定位来源并明确不确定性。',
    systemPrompt: '你是小规的研究角色。保持只读，只分析项目范围内的信息；说明来源、证据和限制，不修改文件。',
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    toolAllowlist: ['read'],
  },
  {
    schemaVersion: 1,
    profileId: 'xiaogui.role.implement.default',
    role: 'IMPLEMENT',
    name: '实现',
    description: '在已批准的独立工作树内实现并验证计划。',
    systemPrompt: '你是小规的实现角色。只在批准的任务、文件范围和独立工作树内修改；遵守权限门，并用真实命令验证。',
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    toolAllowlist: ['read', 'bash', 'edit', 'write'],
  },
  {
    schemaVersion: 1,
    profileId: 'xiaogui.role.review.default',
    role: 'REVIEW',
    name: '审阅',
    description: '只读检查真实差异、验证证据和未解决问题。',
    systemPrompt: '你是小规的审阅角色。保持只读，只依据真实差异和验证证据指出问题；不得修改文件或替代人工批准。',
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    toolAllowlist: ['read'],
  },
]

describe('CodingRoleProfileModuleV1', () => {
  it('建立研究、实现、审阅三个默认角色，列表不泄漏系统提示正文', () => {
    const module = new CodingRoleProfileModuleV1({ dbPath: databasePath() })

    const summaries = module.list()
    expect(summaries.map((profile) => profile.role)).toEqual([
      'RESEARCH',
      'IMPLEMENT',
      'REVIEW',
    ])
    expect(summaries).toHaveLength(3)
    expect(JSON.stringify(summaries)).not.toContain('systemPrompt')

    const research = module.readForEdit('xiaogui.role.research.default')
    const implementation = module.readForEdit('xiaogui.role.implement.default')
    const review = module.readForEdit('xiaogui.role.review.default')
    expect(research?.systemPrompt).toContain('只读')
    for (const profile of [research, implementation, review]) {
      expect(profile?.systemPrompt.match(/^## .+$/gm)).toEqual([
        '## 目标',
        '## 允许',
        '## 禁止',
        '## 输出契约',
        '## 验证与批准',
      ])
    }
    expect(research?.systemPrompt).toContain('事实、推断和未知')
    expect(research?.systemPrompt).toContain('不得修改')
    expect(implementation?.systemPrompt).toContain('批准的任务、文件范围和独立工作树')
    expect(implementation?.systemPrompt).toContain('残余风险')
    expect(review?.systemPrompt).toContain('严重度')
    expect(review?.systemPrompt).toContain('未覆盖风险')
    expect(review?.systemPrompt).toContain('不得修改')
    expect(research?.profileDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    module.close()
  })

  it('校验并持久化模型、运行时策略和已知工具，摘要由模块确定生成', () => {
    const dbPath = databasePath()
    const module = new CodingRoleProfileModuleV1({
      dbPath,
      now: () => '2026-08-31T10:00:00.000Z',
    })

    const saved = module.upsert(draft({
      toolAllowlist: ['write', 'read', 'write', 'bash'],
    }))
    expect(saved.updatedAt).toBe('2026-08-31T10:00:00.000Z')
    expect(saved.toolAllowlist).toEqual(['read', 'bash', 'write'])
    expect(saved.profileDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    module.close()

    const restored = new CodingRoleProfileModuleV1({ dbPath })
    expect(restored.readForEdit(saved.profileId)).toEqual(saved)

    expect(() => restored.upsert(draft({ modelSelector: 'model selector with spaces' })))
      .toThrow('CODING_ROLE_MODEL_SELECTOR_INVALID')
    expect(() => restored.upsert(draft({ runtimePolicyId: '../runtime-policy' })))
      .toThrow('CODING_ROLE_RUNTIME_POLICY_INVALID')
    expect(() => restored.upsert(draft({ toolAllowlist: ['read', 'unknown-tool'] })))
      .toThrow('CODING_ROLE_TOOL_NOT_ALLOWED')
    restored.close()
  })

  it('研究和审阅角色硬性只读，实现角色才获得已批准的写入工具', () => {
    const module = new CodingRoleProfileModuleV1({ dbPath: databasePath() })
    const requestedTools = ['read', 'bash', 'edit', 'write'] as const

    module.upsert(draft({
      profileId: 'role.research.custom',
      role: 'RESEARCH',
      name: '定制研究',
      toolAllowlist: requestedTools,
    }))
    module.upsert(draft({
      profileId: 'role.review.custom',
      role: 'REVIEW',
      name: '定制审阅',
      toolAllowlist: requestedTools,
    }))
    module.upsert(draft({ toolAllowlist: requestedTools }))

    const research = module.resolve('role.research.custom')
    const review = module.resolve('role.review.custom')
    const implementation = module.resolve('role.implement.custom')
    expect(research.snapshot.requestedToolAllowlist).toEqual(requestedTools)
    expect(research.snapshot.effectiveToolAllowlist).toEqual(['read'])
    expect(review.snapshot.effectiveToolAllowlist).toEqual(['read'])
    expect(implementation.snapshot.effectiveToolAllowlist).toEqual(requestedTools)
    expect(research.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(Object.isFrozen(research)).toBe(true)
    expect(Object.isFrozen(research.snapshot)).toBe(true)
    expect(Object.isFrozen(research.snapshot.effectiveToolAllowlist)).toBe(true)
    module.close()
  })

  it('Attempt 绑定保存冻结快照，配置后续变化不得静默替换', () => {
    const dbPath = databasePath()
    const first = new CodingRoleProfileModuleV1({
      dbPath,
      now: () => '2026-08-31T10:00:00.000Z',
    })
    const original = first.upsert(draft())
    const binding = first.bindAttempt('attempt-1', original.profileId)
    expect(binding.snapshot.profileDigest).toBe(original.profileDigest)

    const changed = first.upsert(draft({ systemPrompt: '这是后续修改后的系统提示。' }))
    expect(changed.profileDigest).not.toBe(original.profileDigest)
    expect(() => first.bindAttempt('attempt-1', original.profileId))
      .toThrow('CODING_ROLE_ATTEMPT_ALREADY_BOUND')
    expect(first.readAttemptBinding('attempt-1')).toEqual(binding)
    first.close()

    const restored = new CodingRoleProfileModuleV1({ dbPath })
    expect(restored.readAttemptBinding('attempt-1')).toEqual(binding)
    expect(() => restored.bindAttempt('attempt-1', 'xiaogui.role.review.default'))
      .toThrow('CODING_ROLE_ATTEMPT_ALREADY_BOUND')
    restored.close()
  })

  it('仅把 digest 精确等于旧内置默认的存量行迁移到新默认，并保持迁移幂等与 Attempt 快照隔离', () => {
    const dbPath = databasePath()
    const legacy = new CodingRoleProfileModuleV1({
      dbPath,
      now: () => '2026-09-01T08:00:00.000Z',
    })
    const oldProfiles = LEGACY_DEFAULT_DRAFTS.map((profile) => legacy.upsert(profile))
    const oldBinding = legacy.bindAttempt(
      'attempt.before-default-migration',
      'xiaogui.role.research.default',
    )
    legacy.close()

    const migrated = new CodingRoleProfileModuleV1({
      dbPath,
      now: () => '2026-09-02T08:00:00.000Z',
    })
    for (const oldProfile of oldProfiles) {
      const current = migrated.readForEdit(oldProfile.profileId)!
      expect(current.systemPrompt).toContain('## 目标')
      expect(current.profileDigest).not.toBe(oldProfile.profileDigest)
      expect(current.updatedAt).toBe('2026-09-02T08:00:00.000Z')
    }
    expect(migrated.readAttemptBinding('attempt.before-default-migration')).toEqual(oldBinding)
    expect(oldBinding.snapshot.profileDigest).toBe(oldProfiles[0].profileDigest)
    const newBinding = migrated.bindAttempt(
      'attempt.after-default-migration',
      'xiaogui.role.research.default',
    )
    expect(newBinding.snapshot.profileDigest).not.toBe(oldBinding.snapshot.profileDigest)
    const migratedResearch = migrated.readForEdit('xiaogui.role.research.default')!
    migrated.close()

    const reopened = new CodingRoleProfileModuleV1({
      dbPath,
      now: () => '2026-09-02T09:00:00.000Z',
    })
    expect(reopened.readForEdit('xiaogui.role.research.default')?.updatedAt)
      .toBe(migratedResearch.updatedAt)
    expect(reopened.readAttemptBinding('attempt.before-default-migration')).toEqual(oldBinding)
    expect(reopened.readAttemptBinding('attempt.after-default-migration')).toEqual(newBinding)
    reopened.close()
  })

  it('初始化迁移保留用户修改过的默认角色和自定义角色', () => {
    const dbPath = databasePath()
    const first = new CodingRoleProfileModuleV1({
      dbPath,
      now: () => '2026-09-02T10:00:00.000Z',
    })
    const base = first.readForEdit('xiaogui.role.review.default')!
    const editedDefault = first.upsert({
      ...base,
      description: '用户自定义的审阅摘要。',
      systemPrompt: '用户自定义的审阅提示，不应被初始化迁移覆盖。',
    })
    const custom = first.upsert(draft({
      profileId: 'role.user.migration-preserved',
      systemPrompt: '用户自定义角色提示，不应被初始化迁移覆盖。',
    }))
    first.close()

    const reopened = new CodingRoleProfileModuleV1({
      dbPath,
      now: () => '2026-09-02T11:00:00.000Z',
    })
    expect(reopened.readForEdit(editedDefault.profileId)).toEqual(editedDefault)
    expect(reopened.readForEdit(custom.profileId)).toEqual(custom)
    reopened.close()
  })

  it('对相同未变角色的重复绑定保持幂等，并拒绝非法或不存在的配置', () => {
    const module = new CodingRoleProfileModuleV1({ dbPath: databasePath() })
    const first = module.bindAttempt('attempt.same', 'xiaogui.role.implement.default')
    const second = module.bindAttempt('attempt.same', 'xiaogui.role.implement.default')
    expect(second).toEqual(first)

    expect(() => module.resolve('missing-role')).toThrow('CODING_ROLE_PROFILE_NOT_FOUND')
    expect(() => module.bindAttempt('../attempt', 'xiaogui.role.implement.default'))
      .toThrow('CODING_ROLE_ATTEMPT_ID_INVALID')
    expect(() => module.upsert(draft({ profileId: '../role' })))
      .toThrow('CODING_ROLE_PROFILE_ID_INVALID')
    module.close()
  })

  it('复制角色时创建新编号和新摘要，且不覆盖任何已有配置', () => {
    const module = new CodingRoleProfileModuleV1({
      dbPath: databasePath(),
      now: () => '2026-08-31T13:00:00.000Z',
    })
    const source = module.readForEdit('xiaogui.role.implement.default')!

    const copied = module.copy(source.profileId, 'role.implement.copy')
    expect(copied).toMatchObject({
      profileId: 'role.implement.copy',
      role: source.role,
      name: source.name,
      systemPrompt: source.systemPrompt,
      modelSelector: source.modelSelector,
      runtimePolicyId: source.runtimePolicyId,
      toolAllowlist: source.toolAllowlist,
    })
    expect(copied.profileDigest).not.toBe(source.profileDigest)
    expect(JSON.stringify(module.list())).not.toContain('systemPrompt')

    expect(() => module.copy(source.profileId, copied.profileId))
      .toThrow('CODING_ROLE_PROFILE_ALREADY_EXISTS')
    expect(() => module.copy(source.profileId, 'xiaogui.role.research.default'))
      .toThrow('CODING_ROLE_PROFILE_ALREADY_EXISTS')
    expect(() => module.copy('missing-role', 'role.missing.copy'))
      .toThrow('CODING_ROLE_PROFILE_NOT_FOUND')
    module.close()
  })

  it('重置仅恢复内置默认角色，不改变用户角色或已绑定 Attempt 快照', () => {
    const module = new CodingRoleProfileModuleV1({
      dbPath: databasePath(),
      now: () => '2026-08-31T14:00:00.000Z',
    })
    const defaultId = 'xiaogui.role.research.default'
    const frozenDefault = module.readForEdit(defaultId)!
    const editedDefault = module.upsert({
      ...frozenDefault,
      systemPrompt: '用户临时修改过的研究角色提示。',
      toolAllowlist: ['read', 'bash', 'write'],
    })
    const custom = module.upsert(draft({
      profileId: 'role.user.custom',
      systemPrompt: '用户角色不得被默认重置影响。',
    }))
    const binding = module.bindAttempt('attempt.before-reset', editedDefault.profileId)

    const reset = module.resetDefault(defaultId)
    expect(reset.systemPrompt).toBe(frozenDefault.systemPrompt)
    expect(reset.systemPrompt.match(/^## .+$/gm)).toEqual([
      '## 目标',
      '## 允许',
      '## 禁止',
      '## 输出契约',
      '## 验证与批准',
    ])
    expect(reset.toolAllowlist).toEqual(['read'])
    expect(reset.profileDigest).toBe(frozenDefault.profileDigest)
    expect(module.readForEdit(custom.profileId)).toEqual(custom)
    expect(module.readAttemptBinding('attempt.before-reset')).toEqual(binding)
    expect(binding.snapshot.profileDigest).toBe(editedDefault.profileDigest)
    expect(binding.snapshot.profileDigest).not.toBe(reset.profileDigest)

    expect(() => module.resetDefault(custom.profileId))
      .toThrow('CODING_ROLE_PROFILE_NOT_DEFAULT')
    expect(() => module.resetDefault('missing-role'))
      .toThrow('CODING_ROLE_PROFILE_NOT_DEFAULT')
    module.close()
  })
})
