/**
 * 小规模式作用域（scope）元数据（主进程侧）。
 *
 * 背景：Pi SDK session（工作区 .pi/agent/sessions 下 JSONL）与上游
 * recentProjects 都是上游通用数据，小规不修改它们。为实现
 * WORK/DESIGN/CODING 三模式各自独立的对话与项目，在列表之上建立映射层：
 * - sessionModeMap: 规范化 sessionFile 路径 -> 一级模式
 * - projectModeMap: 规范化项目路径（含临时对话 sandbox 工作区）-> 一级模式
 * 查不到映射的记录视为历史数据，一律按 WORK 处理（仅 WORK 模式可见），
 * 数据一条都不删。
 *
 * 持久化在独立的 xiaogui.json（electron-store name='xiaogui'），
 * 不污染上游 pi-desktop.json schema。
 */

import Store from 'electron-store'

import type {
  ProjectId,
  SandboxKeyV1,
  SessionAddressV1,
  SessionKey,
  SessionMode,
  SessionScopeLookupResultV1,
} from '@shared/xiaogui-session-scope'

import { isXiaoguiMode, type XiaoguiMode } from './config'
import { normalizeLegacyPathKeyV1, normalizePathKey, versionedPathKeysV2 } from './path-key'
import { opaqueScopeIdDeriverV1, type CanonicalInputFingerprintV1 } from './scope-derive'
import {
  SessionScopeResolutionError,
  type SandboxBindingCommitV1,
  type SessionBindingCommitV1,
  type SessionBindingLookupV1,
  type SessionScopePersistenceV1,
} from './scope-resolver'

export type ScopeKind = 'session' | 'project'

interface XiaoguiScopeSchema {
  /** 最近一次使用的一级模式（应用重启后恢复）。 */
  mode: XiaoguiMode
  sessionModeMap: Record<string, XiaoguiMode>
  projectModeMap: Record<string, XiaoguiMode>
  /**
   * 项目基线：功能上线时已存在的 recentProjects（规范化路径）。
   * 基线项目不打标签，默认归 WORK（仅 WORK 可见）；仅基线之后
   * 新出现的项目才打当前模式标签——打开历史项目不静默改归属。
   */
  projectBaseline: string[]
  canonicalScopeBindings: CanonicalScopeBindingsV3
}

interface PersistedProjectBindingV2 {
  canonicalInputFingerprint: CanonicalInputFingerprintV1
  /** null only while migrating an already trusted V1 binding. */
  rootIdentityDigest: string | null
}

interface PersistedSessionBindingV1 {
  projectId: ProjectId
  canonicalInputFingerprint: CanonicalInputFingerprintV1
  sessionMode: SessionMode
}

interface PersistedSandboxBindingV1 {
  projectId: ProjectId
  canonicalInputFingerprint: CanonicalInputFingerprintV1
}

interface PersistedLegacyWslProjectMigrationV1 {
  currentProjectId: ProjectId
  legacyPathKey: string
  currentPathKey: string
}

interface PersistedLegacyWslSessionMigrationV1 {
  currentSessionKey: SessionKey
  legacyProjectId: ProjectId
  currentProjectId: ProjectId
  legacyPathKey: string
  currentPathKey: string
}

interface PersistedLegacyWslMigrationsV1 {
  projects: Record<string, PersistedLegacyWslProjectMigrationV1>
  sessions: Record<string, PersistedLegacyWslSessionMigrationV1>
}

interface CanonicalScopeBindingsV3 {
  version: 3
  projects: Record<string, PersistedProjectBindingV2>
  sessions: Record<string, PersistedSessionBindingV1>
  sandboxes: Record<string, PersistedSandboxBindingV1>
  legacyWslMigrations: PersistedLegacyWslMigrationsV1
}

function emptyLegacyWslMigrations(): PersistedLegacyWslMigrationsV1 {
  return { projects: {}, sessions: {} }
}

function emptyCanonicalScopeBindings(): CanonicalScopeBindingsV3 {
  return {
    version: 3,
    projects: {},
    sessions: {},
    sandboxes: {},
    legacyWslMigrations: emptyLegacyWslMigrations(),
  }
}

const store = new Store<XiaoguiScopeSchema>({
  name: 'xiaogui',
  // 崩溃防护：xiaogui.json 损坏（非法 JSON）时清空并重建，而不是在模块
  // import 求值期抛 SyntaxError —— 那早于主进程 uncaughtException 兜底注册，
  // 会导致应用直接起不来。
  clearInvalidConfig: true,
  defaults: {
    mode: 'WORK',
    sessionModeMap: {},
    projectModeMap: {},
    projectBaseline: [],
    canonicalScopeBindings: emptyCanonicalScopeBindings(),
  },
})

const PROJECT_ID_PATTERN = /^xgp1_[0-9a-f]{64}$/
const SESSION_KEY_PATTERN = /^xgs1_[0-9a-f]{64}$/
const SANDBOX_KEY_PATTERN = /^xgb1_[0-9a-f]{64}$/
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function corruptStore(): never {
  throw new SessionScopeResolutionError('CANONICAL_SCOPE_STORE_CORRUPT')
}

function readLegacyWslMigrations(raw: Record<string, unknown>): PersistedLegacyWslMigrationsV1 {
  if (raw.version !== 3) return emptyLegacyWslMigrations()
  const value = raw.legacyWslMigrations
  if (!isRecord(value) || !isRecord(value.projects) || !isRecord(value.sessions)) corruptStore()

  const projects: PersistedLegacyWslMigrationsV1['projects'] = {}
  for (const [legacyProjectId, candidate] of Object.entries(value.projects)) {
    if (
      !PROJECT_ID_PATTERN.test(legacyProjectId) ||
      !isRecord(candidate) ||
      !PROJECT_ID_PATTERN.test(String(candidate.currentProjectId ?? '')) ||
      typeof candidate.legacyPathKey !== 'string' ||
      typeof candidate.currentPathKey !== 'string'
    ) {
      corruptStore()
    }
    const legacyPathKey = normalizeLegacyPathKeyV1(candidate.legacyPathKey)
    const currentPathKey = normalizePathKey(candidate.currentPathKey)
    const keys = versionedPathKeysV2(currentPathKey)
    if (
      !legacyPathKey ||
      !currentPathKey ||
      candidate.legacyPathKey !== legacyPathKey ||
      candidate.currentPathKey !== currentPathKey ||
      keys.legacyV1 !== legacyPathKey ||
      opaqueScopeIdDeriverV1.deriveProject(legacyPathKey).projectId !== legacyProjectId ||
      opaqueScopeIdDeriverV1.deriveProject(currentPathKey).projectId !== candidate.currentProjectId
    ) {
      corruptStore()
    }
    projects[legacyProjectId] = {
      currentProjectId: candidate.currentProjectId as ProjectId,
      legacyPathKey,
      currentPathKey,
    }
  }

  const sessions: PersistedLegacyWslMigrationsV1['sessions'] = {}
  for (const [legacySessionKey, candidate] of Object.entries(value.sessions)) {
    if (
      !SESSION_KEY_PATTERN.test(legacySessionKey) ||
      !isRecord(candidate) ||
      !SESSION_KEY_PATTERN.test(String(candidate.currentSessionKey ?? '')) ||
      !PROJECT_ID_PATTERN.test(String(candidate.legacyProjectId ?? '')) ||
      !PROJECT_ID_PATTERN.test(String(candidate.currentProjectId ?? '')) ||
      typeof candidate.legacyPathKey !== 'string' ||
      typeof candidate.currentPathKey !== 'string'
    ) {
      corruptStore()
    }
    const legacyPathKey = normalizeLegacyPathKeyV1(candidate.legacyPathKey)
    const currentPathKey = normalizePathKey(candidate.currentPathKey)
    const keys = versionedPathKeysV2(currentPathKey)
    if (
      !legacyPathKey ||
      !currentPathKey ||
      candidate.legacyPathKey !== legacyPathKey ||
      candidate.currentPathKey !== currentPathKey ||
      keys.legacyV1 !== legacyPathKey ||
      opaqueScopeIdDeriverV1.deriveSession(
        candidate.legacyProjectId as ProjectId,
        legacyPathKey,
      ).sessionKey !== legacySessionKey ||
      opaqueScopeIdDeriverV1.deriveSession(
        candidate.currentProjectId as ProjectId,
        currentPathKey,
      ).sessionKey !== candidate.currentSessionKey
    ) {
      corruptStore()
    }
    sessions[legacySessionKey] = {
      currentSessionKey: candidate.currentSessionKey as SessionKey,
      legacyProjectId: candidate.legacyProjectId as ProjectId,
      currentProjectId: candidate.currentProjectId as ProjectId,
      legacyPathKey,
      currentPathKey,
    }
  }

  for (const migration of Object.values(sessions)) {
    if (migration.legacyProjectId === migration.currentProjectId) continue
    const project = projects[migration.legacyProjectId]
    if (!project || project.currentProjectId !== migration.currentProjectId) corruptStore()
  }
  return { projects, sessions }
}

function readCanonicalScopeBindings(): CanonicalScopeBindingsV3 {
  const raw = store.get('canonicalScopeBindings') as unknown
  if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2 && raw.version !== 3)) {
    corruptStore()
  }
  if (!isRecord(raw.projects) || !isRecord(raw.sessions) || !isRecord(raw.sandboxes)) {
    corruptStore()
  }

  const projects: CanonicalScopeBindingsV3['projects'] = {}
  for (const [projectId, value] of Object.entries(raw.projects)) {
    if (
      !PROJECT_ID_PATTERN.test(projectId) ||
      !isRecord(value) ||
      !FINGERPRINT_PATTERN.test(String(value.canonicalInputFingerprint ?? ''))
    ) {
      corruptStore()
    }
    const rawIdentity = value.rootIdentityDigest
    if (
      rawIdentity !== undefined &&
      rawIdentity !== null &&
      !DIGEST_PATTERN.test(String(rawIdentity))
    ) {
      corruptStore()
    }
    projects[projectId] = {
      canonicalInputFingerprint: value.canonicalInputFingerprint as CanonicalInputFingerprintV1,
      rootIdentityDigest: typeof rawIdentity === 'string' ? rawIdentity : null,
    }
  }

  const sessions: CanonicalScopeBindingsV3['sessions'] = {}
  for (const [sessionKey, value] of Object.entries(raw.sessions)) {
    if (
      !SESSION_KEY_PATTERN.test(sessionKey) ||
      !isRecord(value) ||
      !PROJECT_ID_PATTERN.test(String(value.projectId ?? '')) ||
      !FINGERPRINT_PATTERN.test(String(value.canonicalInputFingerprint ?? '')) ||
      !isXiaoguiMode(value.sessionMode)
    ) {
      corruptStore()
    }
    sessions[sessionKey] = {
      projectId: value.projectId as ProjectId,
      canonicalInputFingerprint: value.canonicalInputFingerprint as CanonicalInputFingerprintV1,
      sessionMode: value.sessionMode,
    }
  }

  const sandboxes: CanonicalScopeBindingsV3['sandboxes'] = {}
  for (const [sandboxKey, value] of Object.entries(raw.sandboxes)) {
    if (
      !SANDBOX_KEY_PATTERN.test(sandboxKey) ||
      !isRecord(value) ||
      !PROJECT_ID_PATTERN.test(String(value.projectId ?? '')) ||
      !FINGERPRINT_PATTERN.test(String(value.canonicalInputFingerprint ?? ''))
    ) {
      corruptStore()
    }
    sandboxes[sandboxKey] = {
      projectId: value.projectId as ProjectId,
      canonicalInputFingerprint: value.canonicalInputFingerprint as CanonicalInputFingerprintV1,
    }
  }

  for (const session of Object.values(sessions)) {
    if (!projects[session.projectId]) corruptStore()
  }
  for (const sandbox of Object.values(sandboxes)) {
    if (!projects[sandbox.projectId]) corruptStore()
  }

  return {
    version: 3,
    projects,
    sessions,
    sandboxes,
    legacyWslMigrations: readLegacyWslMigrations(raw),
  }
}

function validateIncomingId(value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw new SessionScopeResolutionError('CANONICAL_INPUT_MISMATCH')
  }
}

function validateIncomingFingerprint(value: CanonicalInputFingerprintV1): void {
  if (!FINGERPRINT_PATTERN.test(value)) {
    throw new SessionScopeResolutionError('CANONICAL_INPUT_MISMATCH')
  }
}

function assertProjectBinding(input: SessionBindingCommitV1['project']): void {
  validateIncomingId(input.opaqueId, PROJECT_ID_PATTERN)
  validateIncomingFingerprint(input.canonicalInputFingerprint)
  if (!DIGEST_PATTERN.test(input.rootIdentityDigest)) {
    throw new SessionScopeResolutionError('CANONICAL_INPUT_MISMATCH')
  }
}

function assertProjectCompatible(
  existing: PersistedProjectBindingV2 | undefined,
  input: SessionBindingCommitV1['project'],
): void {
  if (existing && existing.canonicalInputFingerprint !== input.canonicalInputFingerprint) {
    throw new SessionScopeResolutionError('OPAQUE_ID_COLLISION')
  }
  if (existing?.rootIdentityDigest && existing.rootIdentityDigest !== input.rootIdentityDigest) {
    throw new SessionScopeResolutionError('PROJECT_IDENTITY_CHANGED')
  }
}

function assertNotClaimedLegacyIdentity(
  current: CanonicalScopeBindingsV3,
  projectId: ProjectId,
  sessionKey?: SessionKey,
): void {
  const projectClaim = current.legacyWslMigrations.projects[projectId]
  if (projectClaim && projectClaim.currentProjectId !== projectId) {
    throw new SessionScopeResolutionError('LEGACY_SCOPE_AMBIGUOUS')
  }
  if (!sessionKey) return
  const sessionClaim = current.legacyWslMigrations.sessions[sessionKey]
  if (sessionClaim && sessionClaim.currentSessionKey !== sessionKey) {
    throw new SessionScopeResolutionError('LEGACY_SCOPE_AMBIGUOUS')
  }
}

function assertLegacyWslMigration(input: SessionBindingCommitV1): void {
  const migration = input.legacyWslMigration
  if (!migration) return
  validateIncomingId(migration.project.opaqueId, PROJECT_ID_PATTERN)
  validateIncomingFingerprint(migration.project.canonicalInputFingerprint)
  validateIncomingId(migration.session.opaqueId, SESSION_KEY_PATTERN)
  validateIncomingId(migration.session.projectId, PROJECT_ID_PATTERN)
  validateIncomingFingerprint(migration.session.canonicalInputFingerprint)
  if (migration.session.projectId !== migration.project.opaqueId) {
    throw new SessionScopeResolutionError('CANONICAL_INPUT_MISMATCH')
  }

  const projectKeys = versionedPathKeysV2(migration.currentProjectPathKey)
  const sessionKeys = versionedPathKeysV2(migration.currentSessionPathKey)
  const expectedLegacyProjectPath = projectKeys.legacyV1 ?? projectKeys.current
  const expectedLegacySessionPath = sessionKeys.legacyV1 ?? sessionKeys.current
  const currentProject = opaqueScopeIdDeriverV1.deriveProject(projectKeys.current)
  const legacyProject = opaqueScopeIdDeriverV1.deriveProject(expectedLegacyProjectPath)
  const currentSession = opaqueScopeIdDeriverV1.deriveSession(
    currentProject.projectId,
    sessionKeys.current,
  )
  const legacySession = opaqueScopeIdDeriverV1.deriveSession(
    legacyProject.projectId,
    expectedLegacySessionPath,
  )
  if (
    !projectKeys.current ||
    !sessionKeys.current ||
    (!projectKeys.legacyV1 && !sessionKeys.legacyV1) ||
    migration.currentProjectPathKey !== projectKeys.current ||
    migration.currentSessionPathKey !== sessionKeys.current ||
    migration.legacyProjectPathKey !== expectedLegacyProjectPath ||
    migration.legacySessionPathKey !== expectedLegacySessionPath ||
    input.project.opaqueId !== currentProject.projectId ||
    input.project.canonicalInputFingerprint !== currentProject.canonicalInputFingerprint ||
    input.session.opaqueId !== currentSession.sessionKey ||
    input.session.canonicalInputFingerprint !== currentSession.canonicalInputFingerprint ||
    migration.project.opaqueId !== legacyProject.projectId ||
    migration.project.canonicalInputFingerprint !== legacyProject.canonicalInputFingerprint ||
    migration.session.opaqueId !== legacySession.sessionKey ||
    migration.session.canonicalInputFingerprint !== legacySession.canonicalInputFingerprint
  ) {
    throw new SessionScopeResolutionError('CANONICAL_INPUT_MISMATCH')
  }
}

interface PreparedLegacyWslMigrationV1 {
  readonly migrations: PersistedLegacyWslMigrationsV1
  readonly legacySessionMode: SessionMode | null
  readonly changed: boolean
}

function prepareLegacyWslMigration(
  current: CanonicalScopeBindingsV3,
  input: SessionBindingCommitV1,
): PreparedLegacyWslMigrationV1 {
  assertNotClaimedLegacyIdentity(current, input.project.opaqueId, input.session.opaqueId)
  const migration = input.legacyWslMigration
  if (!migration) {
    return { migrations: current.legacyWslMigrations, legacySessionMode: null, changed: false }
  }
  assertLegacyWslMigration(input)

  const legacyProjectId = migration.project.opaqueId
  const legacySessionKey = migration.session.opaqueId
  const existingProjectClaim = current.legacyWslMigrations.projects[legacyProjectId]
  const projectClaim: PersistedLegacyWslProjectMigrationV1 = {
    currentProjectId: input.project.opaqueId,
    legacyPathKey: migration.legacyProjectPathKey,
    currentPathKey: migration.currentProjectPathKey,
  }
  if (
    existingProjectClaim &&
    (existingProjectClaim.currentProjectId !== projectClaim.currentProjectId ||
      existingProjectClaim.legacyPathKey !== projectClaim.legacyPathKey ||
      existingProjectClaim.currentPathKey !== projectClaim.currentPathKey)
  ) {
    throw new SessionScopeResolutionError('LEGACY_SCOPE_AMBIGUOUS')
  }

  const existingSessionClaim = current.legacyWslMigrations.sessions[legacySessionKey]
  const sessionClaim: PersistedLegacyWslSessionMigrationV1 = {
    currentSessionKey: input.session.opaqueId,
    legacyProjectId,
    currentProjectId: input.project.opaqueId,
    legacyPathKey: migration.legacySessionPathKey,
    currentPathKey: migration.currentSessionPathKey,
  }
  if (
    existingSessionClaim &&
    (existingSessionClaim.currentSessionKey !== sessionClaim.currentSessionKey ||
      existingSessionClaim.legacyProjectId !== sessionClaim.legacyProjectId ||
      existingSessionClaim.currentProjectId !== sessionClaim.currentProjectId ||
      existingSessionClaim.legacyPathKey !== sessionClaim.legacyPathKey ||
      existingSessionClaim.currentPathKey !== sessionClaim.currentPathKey)
  ) {
    throw new SessionScopeResolutionError('LEGACY_SCOPE_AMBIGUOUS')
  }

  const legacyProject = current.projects[legacyProjectId]
  if (
    legacyProject &&
    legacyProject.canonicalInputFingerprint !== migration.project.canonicalInputFingerprint
  ) {
    throw new SessionScopeResolutionError('OPAQUE_ID_COLLISION')
  }
  if (
    legacyProject?.rootIdentityDigest &&
    legacyProject.rootIdentityDigest !== input.project.rootIdentityDigest
  ) {
    throw new SessionScopeResolutionError('PROJECT_IDENTITY_CHANGED')
  }
  const legacySession = current.sessions[legacySessionKey]
  if (
    legacySession &&
    (legacySession.projectId !== legacyProjectId ||
      legacySession.canonicalInputFingerprint !== migration.session.canonicalInputFingerprint)
  ) {
    throw new SessionScopeResolutionError('OPAQUE_ID_COLLISION')
  }

  const projectChanged = legacyProjectId !== input.project.opaqueId && !existingProjectClaim
  const sessionChanged = legacySessionKey !== input.session.opaqueId && !existingSessionClaim
  return {
    migrations: {
      projects: projectChanged
        ? { ...current.legacyWslMigrations.projects, [legacyProjectId]: projectClaim }
        : current.legacyWslMigrations.projects,
      sessions: sessionChanged
        ? { ...current.legacyWslMigrations.sessions, [legacySessionKey]: sessionClaim }
        : current.legacyWslMigrations.sessions,
    },
    legacySessionMode:
      legacySessionKey !== input.session.opaqueId ? legacySession?.sessionMode ?? null : null,
    changed: projectChanged || sessionChanged,
  }
}

function writeCanonicalScopeBindings(bindings: CanonicalScopeBindingsV3): void {
  store.set('canonicalScopeBindings', bindings)
}

function lookupCanonicalSession(address: SessionAddressV1): SessionScopeLookupResultV1 {
  const bindings = readCanonicalScopeBindings()
  const session = bindings.sessions[address.sessionKey]
  if (!session) return { kind: 'NOT_FOUND' }
  if (session.projectId !== address.projectId) return { kind: 'PROJECT_MISMATCH' }
  return {
    kind: 'FOUND',
    scope: {
      projectId: address.projectId,
      sessionKey: address.sessionKey,
      sessionMode: session.sessionMode,
    },
  }
}

function lookupCanonicalBoundSession(input: SessionBindingLookupV1): SessionScopeLookupResultV1 {
  assertProjectBinding(input.project)
  validateIncomingId(input.session.opaqueId, SESSION_KEY_PATTERN)
  validateIncomingId(input.session.projectId, PROJECT_ID_PATTERN)
  validateIncomingFingerprint(input.session.canonicalInputFingerprint)
  if (input.session.projectId !== input.project.opaqueId) {
    throw new SessionScopeResolutionError('CANONICAL_INPUT_MISMATCH')
  }

  const current = readCanonicalScopeBindings()
  assertNotClaimedLegacyIdentity(current, input.project.opaqueId, input.session.opaqueId)
  const session = current.sessions[input.session.opaqueId]
  if (!session) return { kind: 'NOT_FOUND' }
  assertProjectCompatible(current.projects[input.project.opaqueId], input.project)
  if (!current.projects[input.project.opaqueId]?.rootIdentityDigest) {
    throw new SessionScopeResolutionError('PROJECT_IDENTITY_CHANGED')
  }
  if (session.projectId !== input.session.projectId) return { kind: 'PROJECT_MISMATCH' }
  if (session.canonicalInputFingerprint !== input.session.canonicalInputFingerprint) {
    throw new SessionScopeResolutionError('OPAQUE_ID_COLLISION')
  }
  return {
    kind: 'FOUND',
    scope: {
      projectId: input.project.opaqueId,
      sessionKey: input.session.opaqueId,
      sessionMode: session.sessionMode,
    },
  }
}

function commitCanonicalSession(input: SessionBindingCommitV1): SessionMode {
  assertProjectBinding(input.project)
  validateIncomingId(input.session.opaqueId, SESSION_KEY_PATTERN)
  validateIncomingId(input.session.projectId, PROJECT_ID_PATTERN)
  validateIncomingFingerprint(input.session.canonicalInputFingerprint)
  if (!isXiaoguiMode(input.sessionMode)) {
    throw new SessionScopeResolutionError('CANONICAL_INPUT_MISMATCH')
  }
  if (input.session.projectId !== input.project.opaqueId) {
    throw new SessionScopeResolutionError('CANONICAL_INPUT_MISMATCH')
  }

  const current = readCanonicalScopeBindings()
  const preparedMigration = prepareLegacyWslMigration(current, input)
  assertProjectCompatible(current.projects[input.project.opaqueId], input.project)
  const existing = current.sessions[input.session.opaqueId]
  if (existing) {
    if (existing.projectId !== input.session.projectId) {
      throw new SessionScopeResolutionError('CANONICAL_INPUT_MISMATCH')
    }
    if (existing.canonicalInputFingerprint !== input.session.canonicalInputFingerprint) {
      throw new SessionScopeResolutionError('OPAQUE_ID_COLLISION')
    }
    if (
      preparedMigration.legacySessionMode &&
      preparedMigration.legacySessionMode !== existing.sessionMode
    ) {
      throw new SessionScopeResolutionError('LEGACY_SCOPE_AMBIGUOUS')
    }
  }

  const effectiveMode = existing?.sessionMode ?? preparedMigration.legacySessionMode ?? input.sessionMode
  const existingProject = current.projects[input.project.opaqueId]
  const projectNeedsWrite = !existingProject?.rootIdentityDigest
  const sessionNeedsWrite = !existing
  if (!projectNeedsWrite && !sessionNeedsWrite && !preparedMigration.changed) {
    return effectiveMode
  }

  writeCanonicalScopeBindings({
    version: 3,
    projects: {
      ...current.projects,
      [input.project.opaqueId]: {
        canonicalInputFingerprint: input.project.canonicalInputFingerprint,
        rootIdentityDigest: input.project.rootIdentityDigest,
      },
    },
    sessions: {
      ...current.sessions,
      [input.session.opaqueId]: {
        projectId: input.session.projectId,
        canonicalInputFingerprint: input.session.canonicalInputFingerprint,
        sessionMode: effectiveMode,
      },
    },
    sandboxes: current.sandboxes,
    legacyWslMigrations: preparedMigration.migrations,
  })
  return effectiveMode
}

function commitCanonicalSandbox(input: SandboxBindingCommitV1): void {
  assertProjectBinding(input.project)
  validateIncomingId(input.sandbox.opaqueId, SANDBOX_KEY_PATTERN)
  validateIncomingId(input.sandbox.projectId, PROJECT_ID_PATTERN)
  validateIncomingFingerprint(input.sandbox.canonicalInputFingerprint)
  if (input.sandbox.projectId !== input.project.opaqueId) {
    throw new SessionScopeResolutionError('CANONICAL_INPUT_MISMATCH')
  }

  const current = readCanonicalScopeBindings()
  assertProjectCompatible(current.projects[input.project.opaqueId], input.project)
  const existing = current.sandboxes[input.sandbox.opaqueId]
  if (existing) {
    if (existing.projectId !== input.sandbox.projectId) {
      throw new SessionScopeResolutionError('CANONICAL_INPUT_MISMATCH')
    }
    if (existing.canonicalInputFingerprint !== input.sandbox.canonicalInputFingerprint) {
      throw new SessionScopeResolutionError('OPAQUE_ID_COLLISION')
    }
    if (!current.projects[input.project.opaqueId]?.rootIdentityDigest) {
      writeCanonicalScopeBindings({
        ...current,
        projects: {
          ...current.projects,
          [input.project.opaqueId]: {
            canonicalInputFingerprint: input.project.canonicalInputFingerprint,
            rootIdentityDigest: input.project.rootIdentityDigest,
          },
        },
      })
    }
    return
  }

  writeCanonicalScopeBindings({
    version: 3,
    projects: {
      ...current.projects,
      [input.project.opaqueId]: {
        canonicalInputFingerprint: input.project.canonicalInputFingerprint,
        rootIdentityDigest: input.project.rootIdentityDigest,
      },
    },
    sessions: current.sessions,
    sandboxes: {
      ...current.sandboxes,
      [input.sandbox.opaqueId]: {
        projectId: input.sandbox.projectId,
        canonicalInputFingerprint: input.sandbox.canonicalInputFingerprint,
      },
    },
    legacyWslMigrations: current.legacyWslMigrations,
  })
}

export const sessionScopePersistenceV1: SessionScopePersistenceV1 = {
  lookup: lookupCanonicalSession,
  lookupBoundSession: lookupCanonicalBoundSession,
  getLegacySessionMode: (normalizedSessionFile, legacyNormalizedSessionFile) =>
    getScopeAtVersionedKey('session', normalizedSessionFile, legacyNormalizedSessionFile),
  getLegacyProjectMode: (normalizedProjectRoot, legacyNormalizedProjectRoot) =>
    getScopeAtVersionedKey('project', normalizedProjectRoot, legacyNormalizedProjectRoot),
  commitSession: commitCanonicalSession,
  commitSandbox: commitCanonicalSandbox,
}

/** 过滤非法 key/模式值（防御历史脏数据）。 */
function sanitizeMap(raw: Record<string, unknown> | undefined): Record<string, XiaoguiMode> {
  const out: Record<string, XiaoguiMode> = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    const normalized = normalizePathKey(key)
    if (normalized && isXiaoguiMode(value)) out[normalized] = value
  }
  return out
}

function rawMapFor(kind: ScopeKind): Record<string, XiaoguiMode> {
  const raw =
    kind === 'session'
      ? (store.get('sessionModeMap') as Record<string, unknown>)
      : (store.get('projectModeMap') as Record<string, unknown>)
  return sanitizeMap(raw)
}

function matchingPathMigration(
  kind: ScopeKind,
  legacyPathKey: string,
): { legacyPathKey: string; currentPathKey: string } | null {
  const migrations = readCanonicalScopeBindings().legacyWslMigrations
  const candidates = kind === 'session'
    ? Object.values(migrations.sessions)
    : Object.values(migrations.projects)
  return candidates.find((candidate) => candidate.legacyPathKey === legacyPathKey) ?? null
}

function getScopeAtVersionedKey(
  kind: ScopeKind,
  currentPathKey: string,
  legacyPathKey?: string,
): XiaoguiMode | null {
  const current = normalizePathKey(currentPathKey)
  if (!current) return null
  const map = rawMapFor(kind)
  const currentMode = map[current]
  const legacy = legacyPathKey ? normalizeLegacyPathKeyV1(legacyPathKey) : null
  if (!legacy || legacy === current) return currentMode ?? null

  const claim = matchingPathMigration(kind, legacy)
  if (claim && claim.currentPathKey !== current) {
    throw new SessionScopeResolutionError('LEGACY_SCOPE_AMBIGUOUS')
  }
  const legacyMode = map[legacy]
  if (currentMode && legacyMode && currentMode !== legacyMode) {
    throw new SessionScopeResolutionError('LEGACY_SCOPE_AMBIGUOUS')
  }
  return currentMode ?? legacyMode ?? null
}

function mapFor(kind: ScopeKind): Record<string, XiaoguiMode> {
  const map = rawMapFor(kind)
  const migrations = readCanonicalScopeBindings().legacyWslMigrations
  const candidates = kind === 'session'
    ? Object.values(migrations.sessions)
    : Object.values(migrations.projects)
  for (const migration of candidates) {
    const legacyMode = map[migration.legacyPathKey]
    if (!legacyMode) continue
    const currentMode = map[migration.currentPathKey]
    if (currentMode && currentMode !== legacyMode) {
      throw new SessionScopeResolutionError('LEGACY_SCOPE_AMBIGUOUS')
    }
    map[migration.currentPathKey] = currentMode ?? legacyMode
    if (migration.currentPathKey !== migration.legacyPathKey) delete map[migration.legacyPathKey]
  }
  return map
}

function writeMap(kind: ScopeKind, map: Record<string, XiaoguiMode>): void {
  if (kind === 'session') store.set('sessionModeMap', map)
  else store.set('projectModeMap', map)
}

// ---- mode 持久化 -----------------------------------------------------------------

export function loadPersistedMode(): XiaoguiMode {
  const mode = store.get('mode')
  return isXiaoguiMode(mode) ? mode : 'WORK'
}

export function persistMode(mode: XiaoguiMode): void {
  store.set('mode', mode)
}

// ---- scope 映射读写 ---------------------------------------------------------------

/** 查不到返回 null（渲染层将 null 视为历史数据 = WORK）。 */
export function getScope(kind: ScopeKind, key: string): XiaoguiMode | null {
  const keys = versionedPathKeysV2(key)
  return getScopeAtVersionedKey(kind, keys.current, keys.legacyV1 ?? undefined)
}

/**
 * 写映射。ifAbsent=true 时已有映射则保持不变。
 * 返回写入后实际生效的模式（ifAbsent 命中已有映射时返回已有值）。
 */
export function setScope(
  kind: ScopeKind,
  key: string,
  mode: XiaoguiMode,
  options?: { ifAbsent?: boolean },
): XiaoguiMode {
  const normalized = normalizePathKey(key)
  if (!normalized) return mode
  const map = mapFor(kind)
  const existing = getScope(kind, key)
  if (options?.ifAbsent && existing) return existing
  map[normalized] = mode
  writeMap(kind, map)
  return mode
}

export interface ScopeListResult {
  mode: XiaoguiMode
  sessionModeMap: Record<string, XiaoguiMode>
  projectModeMap: Record<string, XiaoguiMode>
}

export function listScopes(): ScopeListResult {
  return {
    mode: loadPersistedMode(),
    sessionModeMap: mapFor('session'),
    projectModeMap: mapFor('project'),
  }
}

// ---- 项目基线（历史归 WORK：基线不打标签） --------------------------------------

function sanitizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const key = normalizePathKey(typeof item === 'string' ? item : '')
    if (key) out.push(key)
  }
  return out
}

function migratedProjectBaseline(): string[] {
  const keys = new Set(sanitizeList(store.get('projectBaseline')))
  const migrations = readCanonicalScopeBindings().legacyWslMigrations.projects
  for (const migration of Object.values(migrations)) {
    if (!keys.has(migration.legacyPathKey)) continue
    keys.delete(migration.legacyPathKey)
    keys.add(migration.currentPathKey)
  }
  return [...keys]
}

/**
 * 记录项目基线（功能上线时的存量 recentProjects）。
 * 与已有基线取并集（规范化去重）；幂等，重复上报安全。
 */
export function recordProjectBaseline(paths: string[]): number {
  const existing = migratedProjectBaseline()
  const merged = new Set(existing)
  for (const p of paths) {
    const key = normalizePathKey(p)
    if (key) merged.add(key)
  }
  const next = [...merged]
  store.set('projectBaseline', next)
  return next.length
}

export function getProjectBaseline(): string[] {
  return migratedProjectBaseline()
}

/** Test-only：清空 scope 存储内容（恢复默认值）。 */
export function __resetScopeStoreForTests(): void {
  store.set('mode', 'WORK')
  store.set('sessionModeMap', {})
  store.set('projectModeMap', {})
  store.set('projectBaseline', [])
  store.set('canonicalScopeBindings', emptyCanonicalScopeBindings())
}
