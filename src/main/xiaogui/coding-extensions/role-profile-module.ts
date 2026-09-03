import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import type {
  CodingRoleKindV1,
  CodingRoleProfileV1,
} from '@shared/xiaogui-coding-extension-pack'
import { isSafeRuntimeModelSelectorV1 } from '@shared/xiaogui-agent-runtime'

const KNOWN_TOOL_ORDER = Object.freeze(['read', 'bash', 'edit', 'write'] as const)
const KNOWN_TOOLS = new Set<string>(KNOWN_TOOL_ORDER)
const READ_ONLY_TOOLS = new Set<string>(['read'])

export type CodingRoleProfileDraftV1 = Omit<
  CodingRoleProfileV1,
  'profileDigest' | 'updatedAt'
>

export type CodingRoleProfileSummaryV1 = Omit<CodingRoleProfileV1, 'systemPrompt'>

export interface CodingResolvedRoleSnapshotV1 {
  readonly schemaVersion: 1
  readonly profileId: string
  readonly role: CodingRoleKindV1
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly modelSelector: string
  readonly runtimePolicyId: string
  readonly requestedToolAllowlist: readonly string[]
  readonly effectiveToolAllowlist: readonly string[]
  readonly profileDigest: string
}

export interface CodingResolvedRoleProfileV1 {
  readonly snapshot: CodingResolvedRoleSnapshotV1
  readonly snapshotDigest: string
}

export interface CodingAttemptRoleBindingV1 extends CodingResolvedRoleProfileV1 {
  readonly schemaVersion: 1
  readonly attemptId: string
  readonly boundAt: string
}

export interface CodingRoleProfileModuleOptionsV1 {
  readonly dbPath: string
  readonly now?: () => string
}

interface ProfileRowV1 {
  readonly profile_id: string
  readonly role: string
  readonly name: string
  readonly description: string
  readonly system_prompt: string
  readonly model_selector: string
  readonly runtime_policy_id: string
  readonly tool_allowlist_json: string
  readonly profile_digest: string
  readonly updated_at: string
}

interface BindingRowV1 {
  readonly attempt_id: string
  readonly profile_id: string
  readonly snapshot_json: string
  readonly snapshot_digest: string
  readonly bound_at: string
}

/**
 * Main-only role profile Module.
 *
 * The Renderer can receive summaries through a future Adapter, but prompt bodies and
 * frozen Attempt snapshots deliberately stay behind this interface.
 */
export class CodingRoleProfileModuleV1 {
  private readonly db: DatabaseSync
  private readonly now: () => string

  constructor(options: CodingRoleProfileModuleOptionsV1) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec(`
      create table if not exists xiaogui_coding_role_profiles_v1 (
        profile_id text primary key,
        role text not null,
        name text not null,
        description text not null,
        system_prompt text not null,
        model_selector text not null,
        runtime_policy_id text not null,
        tool_allowlist_json text not null,
        profile_digest text not null,
        updated_at text not null
      );
      create table if not exists xiaogui_coding_attempt_role_bindings_v1 (
        attempt_id text primary key,
        profile_id text not null,
        snapshot_json text not null,
        snapshot_digest text not null,
        bound_at text not null
      );
    `)
    this.seedDefaults()
  }

  list(): readonly CodingRoleProfileSummaryV1[] {
    const rows = this.db.prepare(`
      select profile_id, role, name, description, system_prompt, model_selector,
        runtime_policy_id, tool_allowlist_json, profile_digest, updated_at
      from xiaogui_coding_role_profiles_v1
      order by case role when 'RESEARCH' then 1 when 'IMPLEMENT' then 2 else 3 end,
        profile_id asc
    `).all() as unknown as ProfileRowV1[]
    return Object.freeze(rows.map((row) => {
      const profile = profileFromRow(row)
      const { systemPrompt: _systemPrompt, ...summary } = profile
      return Object.freeze(summary)
    }))
  }

  /** Explicit privileged read used only by a profile editor Adapter. */
  readForEdit(profileId: string): CodingRoleProfileV1 | null {
    assertSafeId(profileId, 'CODING_ROLE_PROFILE_ID_INVALID')
    const row = this.readProfileRow(profileId)
    return row ? profileFromRow(row) : null
  }

  upsert(rawDraft: CodingRoleProfileDraftV1): CodingRoleProfileV1 {
    const draft = canonicalDraft(rawDraft)
    const updatedAt = validTimestamp(this.now())
    const profileDigest = profileDigestOf(draft)
    this.db.prepare(`
      insert into xiaogui_coding_role_profiles_v1 (
        profile_id, role, name, description, system_prompt, model_selector,
        runtime_policy_id, tool_allowlist_json, profile_digest, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(profile_id) do update set
        role = excluded.role,
        name = excluded.name,
        description = excluded.description,
        system_prompt = excluded.system_prompt,
        model_selector = excluded.model_selector,
        runtime_policy_id = excluded.runtime_policy_id,
        tool_allowlist_json = excluded.tool_allowlist_json,
        profile_digest = excluded.profile_digest,
        updated_at = excluded.updated_at
    `).run(
      draft.profileId,
      draft.role,
      draft.name,
      draft.description,
      draft.systemPrompt,
      draft.modelSelector,
      draft.runtimePolicyId,
      JSON.stringify(draft.toolAllowlist),
      profileDigest,
      updatedAt,
    )
    return freezeProfile({ ...draft, profileDigest, updatedAt })
  }

  copy(sourceProfileId: string, newProfileId: string): CodingRoleProfileV1 {
    assertSafeId(sourceProfileId, 'CODING_ROLE_PROFILE_ID_INVALID')
    assertSafeId(newProfileId, 'CODING_ROLE_PROFILE_ID_INVALID')
    this.db.exec('begin immediate')
    try {
      const sourceRow = this.readProfileRow(sourceProfileId)
      if (!sourceRow) throw new Error('CODING_ROLE_PROFILE_NOT_FOUND')
      if (this.readProfileRow(newProfileId)) {
        throw new Error('CODING_ROLE_PROFILE_ALREADY_EXISTS')
      }
      const source = profileFromRow(sourceRow)
      const draft = canonicalDraft({
        schemaVersion: 1,
        profileId: newProfileId,
        role: source.role,
        name: source.name,
        description: source.description,
        systemPrompt: source.systemPrompt,
        modelSelector: source.modelSelector,
        runtimePolicyId: source.runtimePolicyId,
        toolAllowlist: source.toolAllowlist,
      })
      const updatedAt = validTimestamp(this.now())
      const profileDigest = profileDigestOf(draft)
      this.db.prepare(`
        insert into xiaogui_coding_role_profiles_v1 (
          profile_id, role, name, description, system_prompt, model_selector,
          runtime_policy_id, tool_allowlist_json, profile_digest, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        draft.profileId,
        draft.role,
        draft.name,
        draft.description,
        draft.systemPrompt,
        draft.modelSelector,
        draft.runtimePolicyId,
        JSON.stringify(draft.toolAllowlist),
        profileDigest,
        updatedAt,
      )
      this.db.exec('commit')
      return freezeProfile({ ...draft, profileDigest, updatedAt })
    } catch (error) {
      rollbackQuietly(this.db)
      throw error
    }
  }

  resetDefault(profileId: string): CodingRoleProfileV1 {
    assertSafeId(profileId, 'CODING_ROLE_PROFILE_ID_INVALID')
    const frozenDefault = DEFAULT_ROLE_DRAFTS.find((profile) => profile.profileId === profileId)
    if (!frozenDefault) throw new Error('CODING_ROLE_PROFILE_NOT_DEFAULT')
    return this.upsert(frozenDefault)
  }

  resolve(profileId: string): CodingResolvedRoleProfileV1 {
    const profile = this.readForEdit(profileId)
    if (!profile) throw new Error('CODING_ROLE_PROFILE_NOT_FOUND')
    const effectiveToolAllowlist = profile.role === 'IMPLEMENT'
      ? profile.toolAllowlist
      : profile.toolAllowlist.filter((tool) => READ_ONLY_TOOLS.has(tool))
    const snapshot = freezeSnapshot({
      schemaVersion: 1,
      profileId: profile.profileId,
      role: profile.role,
      name: profile.name,
      description: profile.description,
      systemPrompt: profile.systemPrompt,
      modelSelector: profile.modelSelector,
      runtimePolicyId: profile.runtimePolicyId,
      requestedToolAllowlist: profile.toolAllowlist,
      effectiveToolAllowlist,
      profileDigest: profile.profileDigest,
    })
    return freezeResolved({
      snapshot,
      snapshotDigest: snapshotDigestOf(snapshot),
    })
  }

  bindAttempt(attemptId: string, profileId: string): CodingAttemptRoleBindingV1 {
    assertSafeId(attemptId, 'CODING_ROLE_ATTEMPT_ID_INVALID')
    const resolved = this.resolve(profileId)
    this.db.exec('begin immediate')
    try {
      const existing = this.readBindingRow(attemptId)
      if (existing) {
        const binding = bindingFromRow(existing)
        if (
          binding.snapshot.profileId !== profileId ||
          binding.snapshotDigest !== resolved.snapshotDigest
        ) {
          throw new Error('CODING_ROLE_ATTEMPT_ALREADY_BOUND')
        }
        this.db.exec('commit')
        return binding
      }
      const boundAt = validTimestamp(this.now())
      this.db.prepare(`
        insert into xiaogui_coding_attempt_role_bindings_v1 (
          attempt_id, profile_id, snapshot_json, snapshot_digest, bound_at
        ) values (?, ?, ?, ?, ?)
      `).run(
        attemptId,
        profileId,
        JSON.stringify(resolved.snapshot),
        resolved.snapshotDigest,
        boundAt,
      )
      this.db.exec('commit')
      return freezeBinding({
        schemaVersion: 1,
        attemptId,
        boundAt,
        ...resolved,
      })
    } catch (error) {
      rollbackQuietly(this.db)
      throw error
    }
  }

  readAttemptBinding(attemptId: string): CodingAttemptRoleBindingV1 | null {
    assertSafeId(attemptId, 'CODING_ROLE_ATTEMPT_ID_INVALID')
    const row = this.readBindingRow(attemptId)
    return row ? bindingFromRow(row) : null
  }

  close(): void {
    this.db.close()
  }

  private seedDefaults(): void {
    const updatedAt = validTimestamp(this.now())
    this.db.exec('begin immediate')
    try {
      for (const migration of DEFAULT_ROLE_MIGRATIONS_V1) {
        const legacy = canonicalDraft(migration.legacy)
        const current = canonicalDraft(migration.current)
        if (
          legacy.profileId !== migration.profileId ||
          current.profileId !== migration.profileId
        ) throw new Error('CODING_ROLE_DEFAULT_MIGRATION_INVALID')
        const existing = this.readProfileRow(current.profileId)
        const currentDigest = profileDigestOf(current)
        if (!existing) {
          this.db.prepare(`
            insert into xiaogui_coding_role_profiles_v1 (
              profile_id, role, name, description, system_prompt, model_selector,
              runtime_policy_id, tool_allowlist_json, profile_digest, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            current.profileId,
            current.role,
            current.name,
            current.description,
            current.systemPrompt,
            current.modelSelector,
            current.runtimePolicyId,
            JSON.stringify(current.toolAllowlist),
            currentDigest,
            updatedAt,
          )
          continue
        }
        if (existing.profile_digest !== profileDigestOf(legacy)) continue
        this.db.prepare(`
          update xiaogui_coding_role_profiles_v1 set
            role = ?,
            name = ?,
            description = ?,
            system_prompt = ?,
            model_selector = ?,
            runtime_policy_id = ?,
            tool_allowlist_json = ?,
            profile_digest = ?,
            updated_at = ?
          where profile_id = ? and profile_digest = ?
        `).run(
          current.role,
          current.name,
          current.description,
          current.systemPrompt,
          current.modelSelector,
          current.runtimePolicyId,
          JSON.stringify(current.toolAllowlist),
          currentDigest,
          updatedAt,
          current.profileId,
          existing.profile_digest,
        )
      }
      this.db.exec('commit')
    } catch (error) {
      rollbackQuietly(this.db)
      throw error
    }
  }

  private readProfileRow(profileId: string): ProfileRowV1 | undefined {
    return this.db.prepare(`
      select profile_id, role, name, description, system_prompt, model_selector,
        runtime_policy_id, tool_allowlist_json, profile_digest, updated_at
      from xiaogui_coding_role_profiles_v1 where profile_id = ? limit 1
    `).get(profileId) as unknown as ProfileRowV1 | undefined
  }

  private readBindingRow(attemptId: string): BindingRowV1 | undefined {
    return this.db.prepare(`
      select attempt_id, profile_id, snapshot_json, snapshot_digest, bound_at
      from xiaogui_coding_attempt_role_bindings_v1 where attempt_id = ? limit 1
    `).get(attemptId) as unknown as BindingRowV1 | undefined
  }
}

const LEGACY_DEFAULT_ROLE_DRAFTS_V1: readonly CodingRoleProfileDraftV1[] = Object.freeze([
  Object.freeze({
    schemaVersion: 1,
    profileId: 'xiaogui.role.research.default',
    role: 'RESEARCH',
    name: '研究',
    description: '只读理解项目、定位来源并明确不确定性。',
    systemPrompt: '你是小规的研究角色。保持只读，只分析项目范围内的信息；说明来源、证据和限制，不修改文件。',
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    toolAllowlist: Object.freeze(['read']),
  }),
  Object.freeze({
    schemaVersion: 1,
    profileId: 'xiaogui.role.implement.default',
    role: 'IMPLEMENT',
    name: '实现',
    description: '在已批准的独立工作树内实现并验证计划。',
    systemPrompt: '你是小规的实现角色。只在批准的任务、文件范围和独立工作树内修改；遵守权限门，并用真实命令验证。',
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    toolAllowlist: Object.freeze(['read', 'bash', 'edit', 'write']),
  }),
  Object.freeze({
    schemaVersion: 1,
    profileId: 'xiaogui.role.review.default',
    role: 'REVIEW',
    name: '审阅',
    description: '只读检查真实差异、验证证据和未解决问题。',
    systemPrompt: '你是小规的审阅角色。保持只读，只依据真实差异和验证证据指出问题；不得修改文件或替代人工批准。',
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    toolAllowlist: Object.freeze(['read']),
  }),
])

const DEFAULT_ROLE_DRAFTS: readonly CodingRoleProfileDraftV1[] = Object.freeze([
  Object.freeze({
    schemaVersion: 1,
    profileId: 'xiaogui.role.research.default',
    role: 'RESEARCH',
    name: '研究',
    description: '只读理解项目、定位来源并明确不确定性。',
    systemPrompt: `## 目标

你是小规的研究角色。只读定位批准任务涉及的实现、来源、约束和可核验证据，为后续实现或审阅提供可靠事实基础。

## 允许

- 阅读任务范围内的代码、文档、配置、测试和版本历史。
- 运行不会修改项目或外部状态的查询与只读验证。
- 对证据进行交叉核对，并明确仍需补充的信息。

## 禁止

- 不得修改、创建、删除、格式化或提交任何项目文件。
- 不得扩展到未批准的任务范围，不得绕过权限、阶段或人工确认门。
- 不得把推断写成事实，也不得宣称实现完成、测试通过或已经验收。

## 输出契约

- 分别标明事实、推断和未知，并为关键事实给出可定位的来源或文件位置。
- 说明相关实现链、影响范围、冲突证据和仍未回答的问题。
- 结论保持精炼，不输出隐藏推理过程或无证据判断。

## 验证与批准

- 只报告实际执行过的只读检查及其结果；无法验证时明确说明原因。
- 研究结论仅供实现和人工决策，不替代代码验证、审阅或人工批准。`,
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    toolAllowlist: Object.freeze(['read']),
  }),
  Object.freeze({
    schemaVersion: 1,
    profileId: 'xiaogui.role.implement.default',
    role: 'IMPLEMENT',
    name: '实现',
    description: '在已批准的独立工作树内实现并验证计划。',
    systemPrompt: `## 目标

你是小规的实现角色。只在批准的任务、文件范围和独立工作树内完成最小正确变更，并保持结果可验证、可审阅、可回退。

## 允许

- 阅读批准范围内的实现、测试、项目约定和已有未提交改动。
- 在独立工作树内修改批准文件，并运行与变更风险相称的测试、类型检查或构建。
- 在不扩大范围的前提下修复由本次变更直接引入的问题。

## 禁止

- 不得扩大任务或文件范围，不得改写、覆盖或撤销他人的既有改动。
- 不得绕过权限、阶段、确认、发布或人工验收门。
- 不得提交密钥、凭据、真实敏感资料、私有配置或其他被禁止的文件。

## 输出契约

- 报告实际修改的文件与行为、执行过的验证及其结果。
- 明确失败、未验证项、残余风险和需要人工判断的事项。
- 不得把局部测试、草稿或候选状态描述为正式发布或验收完成。

## 验证与批准

- 只有真实验证成功时才声明对应检查通过；失败时保留证据并停止夸大结论。
- 代码修改与自动验证不能替代审阅、交付门或人工批准。`,
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    toolAllowlist: Object.freeze(['read', 'bash', 'edit', 'write']),
  }),
  Object.freeze({
    schemaVersion: 1,
    profileId: 'xiaogui.role.review.default',
    role: 'REVIEW',
    name: '审阅',
    description: '只读检查真实差异、验证证据和未解决问题。',
    systemPrompt: `## 目标

你是小规的审阅角色。只读审查批准范围内的真实差异、验证证据和风险，优先发现会影响正确性、安全性、数据完整性或交付质量的问题。

## 允许

- 阅读真实 diff、相关实现、测试、构建记录和任务约束。
- 运行不会修改项目或外部状态的复现、查询与只读检查。
- 核对实现是否越界、是否覆盖关键失败路径、是否保留既有安全门。

## 禁止

- 不得修改、创建、删除、格式化或提交文件，不得代替实现角色修复问题。
- 不得依据摘要或声称完成的文字替代真实 diff 和验证证据。
- 不得绕过或替代人工批准，不得把“未发现问题”表述为绝对安全。

## 输出契约

- 按严重度列出发现，并给出文件位置、影响、触发条件或复现方法以及建议方向。
- 区分已证实缺陷、风险推断和证据缺口；没有发现问题时仍报告未覆盖风险与验证盲区。
- 不重复无关背景，不输出隐藏推理过程。

## 验证与批准

- 只引用实际读取或执行所得证据；未复现、环境受限或证据不足时明确标注。
- 审阅结论是人工批准的输入，不是批准本身，也不能替代发布或验收门。`,
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    toolAllowlist: Object.freeze(['read']),
  }),
])

const DEFAULT_ROLE_MIGRATIONS_V1 = Object.freeze([
  Object.freeze({
    profileId: 'xiaogui.role.research.default',
    legacy: LEGACY_DEFAULT_ROLE_DRAFTS_V1.find(
      (profile) => profile.profileId === 'xiaogui.role.research.default',
    )!,
    current: DEFAULT_ROLE_DRAFTS.find(
      (profile) => profile.profileId === 'xiaogui.role.research.default',
    )!,
  }),
  Object.freeze({
    profileId: 'xiaogui.role.implement.default',
    legacy: LEGACY_DEFAULT_ROLE_DRAFTS_V1.find(
      (profile) => profile.profileId === 'xiaogui.role.implement.default',
    )!,
    current: DEFAULT_ROLE_DRAFTS.find(
      (profile) => profile.profileId === 'xiaogui.role.implement.default',
    )!,
  }),
  Object.freeze({
    profileId: 'xiaogui.role.review.default',
    legacy: LEGACY_DEFAULT_ROLE_DRAFTS_V1.find(
      (profile) => profile.profileId === 'xiaogui.role.review.default',
    )!,
    current: DEFAULT_ROLE_DRAFTS.find(
      (profile) => profile.profileId === 'xiaogui.role.review.default',
    )!,
  }),
])

function canonicalDraft(raw: CodingRoleProfileDraftV1): CodingRoleProfileDraftV1 {
  if (!raw || raw.schemaVersion !== 1) throw new Error('CODING_ROLE_PROFILE_INVALID')
  assertSafeId(raw.profileId, 'CODING_ROLE_PROFILE_ID_INVALID')
  if (!isRole(raw.role)) throw new Error('CODING_ROLE_KIND_INVALID')
  const name = boundedText(raw.name, 1, 80, 'CODING_ROLE_NAME_INVALID')
  const description = boundedText(raw.description, 1, 500, 'CODING_ROLE_DESCRIPTION_INVALID')
  const systemPrompt = boundedText(raw.systemPrompt, 1, 20_000, 'CODING_ROLE_SYSTEM_PROMPT_INVALID')
  if (!isSafeRuntimeModelSelectorV1(raw.modelSelector)) {
    throw new Error('CODING_ROLE_MODEL_SELECTOR_INVALID')
  }
  const modelSelector = raw.modelSelector
  const runtimePolicyId = selector(raw.runtimePolicyId, 'CODING_ROLE_RUNTIME_POLICY_INVALID')
  if (!Array.isArray(raw.toolAllowlist) || raw.toolAllowlist.length > KNOWN_TOOL_ORDER.length * 2) {
    throw new Error('CODING_ROLE_TOOL_ALLOWLIST_INVALID')
  }
  for (const tool of raw.toolAllowlist) {
    if (typeof tool !== 'string' || !KNOWN_TOOLS.has(tool)) {
      throw new Error('CODING_ROLE_TOOL_NOT_ALLOWED')
    }
  }
  const selected = new Set(raw.toolAllowlist)
  const toolAllowlist = Object.freeze(KNOWN_TOOL_ORDER.filter((tool) => selected.has(tool)))
  return Object.freeze({
    schemaVersion: 1,
    profileId: raw.profileId,
    role: raw.role,
    name,
    description,
    systemPrompt,
    modelSelector,
    runtimePolicyId,
    toolAllowlist,
  })
}

function profileFromRow(row: ProfileRowV1): CodingRoleProfileV1 {
  let tools: unknown
  try {
    tools = JSON.parse(row.tool_allowlist_json)
  } catch {
    throw new Error('CODING_ROLE_PROFILE_STORE_CORRUPT')
  }
  const canonical = canonicalDraft({
    schemaVersion: 1,
    profileId: row.profile_id,
    role: row.role as CodingRoleKindV1,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    modelSelector: row.model_selector,
    runtimePolicyId: row.runtime_policy_id,
    toolAllowlist: tools as readonly string[],
  })
  if (row.profile_digest !== profileDigestOf(canonical)) {
    throw new Error('CODING_ROLE_PROFILE_STORE_CORRUPT')
  }
  return freezeProfile({
    ...canonical,
    profileDigest: row.profile_digest,
    updatedAt: validTimestamp(row.updated_at),
  })
}

function bindingFromRow(row: BindingRowV1): CodingAttemptRoleBindingV1 {
  assertSafeId(row.attempt_id, 'CODING_ROLE_BINDING_STORE_CORRUPT')
  let parsed: unknown
  try {
    parsed = JSON.parse(row.snapshot_json)
  } catch {
    throw new Error('CODING_ROLE_BINDING_STORE_CORRUPT')
  }
  const snapshot = storedSnapshot(parsed)
  const digest = snapshotDigestOf(snapshot)
  if (
    row.profile_id !== snapshot.profileId ||
    row.snapshot_digest !== digest
  ) throw new Error('CODING_ROLE_BINDING_STORE_CORRUPT')
  return freezeBinding({
    schemaVersion: 1,
    attemptId: row.attempt_id,
    boundAt: validTimestamp(row.bound_at),
    snapshot,
    snapshotDigest: digest,
  })
}

function storedSnapshot(value: unknown): CodingResolvedRoleSnapshotV1 {
  if (!value || typeof value !== 'object') throw new Error('CODING_ROLE_BINDING_STORE_CORRUPT')
  const candidate = value as Record<string, unknown>
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.profileId !== 'string' ||
    !isRole(candidate.role) ||
    typeof candidate.name !== 'string' ||
    typeof candidate.description !== 'string' ||
    typeof candidate.systemPrompt !== 'string' ||
    typeof candidate.modelSelector !== 'string' ||
    typeof candidate.runtimePolicyId !== 'string' ||
    !Array.isArray(candidate.requestedToolAllowlist) ||
    !Array.isArray(candidate.effectiveToolAllowlist) ||
    typeof candidate.profileDigest !== 'string'
  ) throw new Error('CODING_ROLE_BINDING_STORE_CORRUPT')
  const canonical = canonicalDraft({
    schemaVersion: 1,
    profileId: candidate.profileId,
    role: candidate.role,
    name: candidate.name,
    description: candidate.description,
    systemPrompt: candidate.systemPrompt,
    modelSelector: candidate.modelSelector,
    runtimePolicyId: candidate.runtimePolicyId,
    toolAllowlist: candidate.requestedToolAllowlist as string[],
  })
  if (candidate.profileDigest !== profileDigestOf(canonical)) {
    throw new Error('CODING_ROLE_BINDING_STORE_CORRUPT')
  }
  const expectedEffective = canonical.role === 'IMPLEMENT'
    ? canonical.toolAllowlist
    : canonical.toolAllowlist.filter((tool) => READ_ONLY_TOOLS.has(tool))
  if (JSON.stringify(candidate.effectiveToolAllowlist) !== JSON.stringify(expectedEffective)) {
    throw new Error('CODING_ROLE_BINDING_STORE_CORRUPT')
  }
  return freezeSnapshot({
    schemaVersion: 1,
    profileId: canonical.profileId,
    role: canonical.role,
    name: canonical.name,
    description: canonical.description,
    systemPrompt: canonical.systemPrompt,
    modelSelector: canonical.modelSelector,
    runtimePolicyId: canonical.runtimePolicyId,
    requestedToolAllowlist: canonical.toolAllowlist,
    effectiveToolAllowlist: expectedEffective,
    profileDigest: candidate.profileDigest,
  })
}

function profileDigestOf(profile: CodingRoleProfileDraftV1): string {
  return sha256({
    schemaVersion: 1,
    profileId: profile.profileId,
    role: profile.role,
    name: profile.name,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    modelSelector: profile.modelSelector,
    runtimePolicyId: profile.runtimePolicyId,
    toolAllowlist: profile.toolAllowlist,
  })
}

function snapshotDigestOf(snapshot: CodingResolvedRoleSnapshotV1): string {
  return sha256(snapshot)
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function freezeProfile(profile: CodingRoleProfileV1): CodingRoleProfileV1 {
  return Object.freeze({
    ...profile,
    toolAllowlist: Object.freeze([...profile.toolAllowlist]),
  })
}

function freezeSnapshot(snapshot: CodingResolvedRoleSnapshotV1): CodingResolvedRoleSnapshotV1 {
  return Object.freeze({
    ...snapshot,
    requestedToolAllowlist: Object.freeze([...snapshot.requestedToolAllowlist]),
    effectiveToolAllowlist: Object.freeze([...snapshot.effectiveToolAllowlist]),
  })
}

function freezeResolved(resolved: CodingResolvedRoleProfileV1): CodingResolvedRoleProfileV1 {
  return Object.freeze({ ...resolved, snapshot: freezeSnapshot(resolved.snapshot) })
}

function freezeBinding(binding: CodingAttemptRoleBindingV1): CodingAttemptRoleBindingV1 {
  return Object.freeze({ ...binding, snapshot: freezeSnapshot(binding.snapshot) })
}

function boundedText(value: string, min: number, max: number, code: string): string {
  if (typeof value !== 'string') throw new Error(code)
  const normalized = value.trim()
  if (
    normalized.length < min ||
    normalized.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) throw new Error(code)
  return normalized
}

function selector(value: string, code: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(value) ||
    value.includes('..') ||
    value.includes('//')
  ) throw new Error(code)
  return value
}

function assertSafeId(value: string, code: string): void {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)) {
    throw new Error(code)
  }
}

function isRole(value: unknown): value is CodingRoleKindV1 {
  return value === 'RESEARCH' || value === 'IMPLEMENT' || value === 'REVIEW'
}

function validTimestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('CODING_ROLE_TIMESTAMP_INVALID')
  }
  return value
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('rollback')
  } catch {
    // Best effort: preserve the original error.
  }
}
