import type {
  ProjectId,
  SessionAddressV1,
  SessionMode,
  SessionScopeLookupResultV1,
  SessionScopeLookupV1,
} from '@shared/xiaogui-session-scope'

import {
  opaqueScopeIdDeriverV1,
  type OpaqueIdentityBindingV1,
  type OpaqueScopeIdDeriverV1,
  type PiSessionRefV1,
  type PiSessionScopeV1,
  type SessionDerivationKind,
} from './scope-derive'
import { versionedPathKeysV2 } from './path-key'
import {
  filesystemExecutionPathV2,
  readProjectRootIdentityV2,
} from '../project-root-identity'

export type ProjectIdentityBindingV1 = Extract<OpaqueIdentityBindingV1, { kind: 'PROJECT' }> & {
  readonly rootIdentityDigest: string
}
export type SessionIdentityBindingV1 = Extract<OpaqueIdentityBindingV1, { kind: 'SESSION' }>
export type SandboxIdentityBindingV1 = Extract<OpaqueIdentityBindingV1, { kind: 'SANDBOX' }>

export interface SessionBindingCommitV1 {
  project: ProjectIdentityBindingV1
  session: SessionIdentityBindingV1
  sessionMode: SessionMode
  /** Main-trusted compatibility evidence for the pre-V2 lowercase WSL key contract. */
  legacyWslMigration?: LegacyWslSessionMigrationV1
}

export interface LegacyWslSessionMigrationV1 {
  readonly project: Extract<OpaqueIdentityBindingV1, { kind: 'PROJECT' }>
  readonly session: Extract<OpaqueIdentityBindingV1, { kind: 'SESSION' }>
  readonly legacyProjectPathKey: string
  readonly currentProjectPathKey: string
  readonly legacySessionPathKey: string
  readonly currentSessionPathKey: string
}

export type SessionBindingLookupV1 = Pick<SessionBindingCommitV1, 'project' | 'session'>

export interface SandboxBindingCommitV1 {
  project: ProjectIdentityBindingV1
  sandbox: SandboxIdentityBindingV1
}

export interface SessionScopePersistenceV1 {
  lookup(address: SessionAddressV1): SessionScopeLookupResultV1
  lookupBoundSession(input: SessionBindingLookupV1): SessionScopeLookupResultV1
  getLegacySessionMode(
    normalizedSessionFile: string,
    legacyNormalizedSessionFile?: string,
  ): SessionMode | null
  getLegacyProjectMode(
    normalizedProjectRoot: string,
    legacyNormalizedProjectRoot?: string,
  ): SessionMode | null
  commitSession(input: SessionBindingCommitV1): SessionMode
  commitSandbox(input: SandboxBindingCommitV1): void
}

export interface SessionScopeResolverV1 extends SessionScopeLookupV1 {
  /** 仅解析已经注册的会话；缺失时返回 null，绝不迁移或写入绑定。 */
  resolveExisting(session: PiSessionRefV1): Promise<PiSessionScopeV1 | null>
  resolve(session: PiSessionRefV1): Promise<PiSessionScopeV1>
  derive(input: {
    kind: SessionDerivationKind
    source: PiSessionRefV1
    target: PiSessionRefV1
  }): Promise<PiSessionScopeV1>
}

/** Main-process-only creation seam. The mode is an intent for an unregistered session. */
export interface SessionScopeRegistrarV1 {
  registerNew(session: PiSessionRefV1, requestedMode: SessionMode): Promise<PiSessionScopeV1>
}

export type SessionScopeResolutionErrorCode =
  | 'INVALID_CANONICAL_SCOPE_INPUT'
  | 'OPAQUE_ID_COLLISION'
  | 'CANONICAL_INPUT_MISMATCH'
  | 'CANONICAL_SCOPE_STORE_CORRUPT'
  | 'SCOPE_PERSISTENCE_FAILED'
  | 'PROJECT_IDENTITY_CHANGED'
  | 'LEGACY_SCOPE_AMBIGUOUS'

export class SessionScopeResolutionError extends Error {
  constructor(readonly code: SessionScopeResolutionErrorCode) {
    super(code)
    this.name = 'SessionScopeResolutionError'
  }
}

interface NormalizedSessionRefV1 {
  readonly execution: PiSessionRefV1
  readonly comparison: PiSessionRefV1
  readonly legacyComparison: PiSessionRefV1 | null
}

function normalizeSessionRef(session: PiSessionRefV1): NormalizedSessionRefV1 {
  const execution = {
    rootPath: filesystemExecutionPathV2(session.rootPath),
    sessionFile: filesystemExecutionPathV2(session.sessionFile),
  }
  const rootKeys = versionedPathKeysV2(execution.rootPath)
  const sessionKeys = versionedPathKeysV2(execution.sessionFile)
  const comparison = { rootPath: rootKeys.current, sessionFile: sessionKeys.current }
  if (!comparison.rootPath || !comparison.sessionFile) {
    throw new SessionScopeResolutionError('INVALID_CANONICAL_SCOPE_INPUT')
  }
  const legacyComparison = rootKeys.legacyV1 || sessionKeys.legacyV1
    ? {
        rootPath: rootKeys.legacyV1 ?? rootKeys.current,
        sessionFile: sessionKeys.legacyV1 ?? sessionKeys.current,
      }
    : null
  return { execution, comparison, legacyComparison }
}

function projectBinding(
  projectId: ProjectId,
  canonicalInputFingerprint: ProjectIdentityBindingV1['canonicalInputFingerprint'],
  rootIdentityDigest: string,
): ProjectIdentityBindingV1 {
  return { kind: 'PROJECT', opaqueId: projectId, canonicalInputFingerprint, rootIdentityDigest }
}

function safePersistenceCall<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof SessionScopeResolutionError) throw error
    throw new SessionScopeResolutionError('SCOPE_PERSISTENCE_FAILED')
  }
}

export function createSessionScopeResolverV1(
  persistence: SessionScopePersistenceV1,
  idDeriver: OpaqueScopeIdDeriverV1 = opaqueScopeIdDeriverV1,
  projectRootIdentity: (rootPath: string) => string = (rootPath) =>
    readProjectRootIdentityV2(rootPath).digest,
): SessionScopeResolverV1 & SessionScopeRegistrarV1 {
  function bindSession(
    session: PiSessionRefV1 | NormalizedSessionRefV1,
    requestedMode: SessionMode,
  ): PiSessionScopeV1 {
    const normalized = 'execution' in session ? session : normalizeSessionRef(session)
    const project = idDeriver.deriveProject(normalized.comparison.rootPath)
    const rootIdentityDigest = projectRootIdentity(normalized.execution.rootPath)
    const derivedSession = idDeriver.deriveSession(
      project.projectId,
      normalized.comparison.sessionFile,
    )
    const legacyWslMigration = normalized.legacyComparison
      ? (() => {
          const legacyProject = idDeriver.deriveProject(normalized.legacyComparison.rootPath)
          const legacySession = idDeriver.deriveSession(
            legacyProject.projectId,
            normalized.legacyComparison.sessionFile,
          )
          return {
            project: {
              kind: 'PROJECT' as const,
              opaqueId: legacyProject.projectId,
              canonicalInputFingerprint: legacyProject.canonicalInputFingerprint,
            },
            session: {
              kind: 'SESSION' as const,
              opaqueId: legacySession.sessionKey,
              projectId: legacyProject.projectId,
              canonicalInputFingerprint: legacySession.canonicalInputFingerprint,
            },
            legacyProjectPathKey: normalized.legacyComparison.rootPath,
            currentProjectPathKey: normalized.comparison.rootPath,
            legacySessionPathKey: normalized.legacyComparison.sessionFile,
            currentSessionPathKey: normalized.comparison.sessionFile,
          } satisfies LegacyWslSessionMigrationV1
        })()
      : undefined
    const effectiveMode = safePersistenceCall(() =>
      persistence.commitSession({
        project: projectBinding(
          project.projectId,
          project.canonicalInputFingerprint,
          rootIdentityDigest,
        ),
        session: {
          kind: 'SESSION',
          opaqueId: derivedSession.sessionKey,
          projectId: project.projectId,
          canonicalInputFingerprint: derivedSession.canonicalInputFingerprint,
        },
        sessionMode: requestedMode,
        ...(legacyWslMigration ? { legacyWslMigration } : {}),
      }),
    )
    return {
      projectId: project.projectId,
      sessionKey: derivedSession.sessionKey,
      sessionMode: effectiveMode,
      rootPath: normalized.execution.rootPath,
      sessionFile: normalized.execution.sessionFile,
    }
  }

  async function resolveSession(session: PiSessionRefV1): Promise<PiSessionScopeV1> {
    const normalized = normalizeSessionRef(session)
    const requestedMode = safePersistenceCall(
      () =>
        persistence.getLegacySessionMode(
          normalized.comparison.sessionFile,
          normalized.legacyComparison?.sessionFile,
        ) ??
        persistence.getLegacyProjectMode(
          normalized.comparison.rootPath,
          normalized.legacyComparison?.rootPath,
        ) ??
        'WORK',
    )
    return bindSession(normalized, requestedMode)
  }

  async function resolveExistingSession(session: PiSessionRefV1): Promise<PiSessionScopeV1 | null> {
    const normalized = normalizeSessionRef(session)
    const project = idDeriver.deriveProject(normalized.comparison.rootPath)
    const rootIdentityDigest = projectRootIdentity(normalized.execution.rootPath)
    const derivedSession = idDeriver.deriveSession(
      project.projectId,
      normalized.comparison.sessionFile,
    )
    const result = safePersistenceCall(() =>
      persistence.lookupBoundSession({
        project: projectBinding(
          project.projectId,
          project.canonicalInputFingerprint,
          rootIdentityDigest,
        ),
        session: {
          kind: 'SESSION',
          opaqueId: derivedSession.sessionKey,
          projectId: project.projectId,
          canonicalInputFingerprint: derivedSession.canonicalInputFingerprint,
        },
      }),
    )
    if (result.kind !== 'FOUND') return null
    return {
      ...result.scope,
      rootPath: normalized.execution.rootPath,
      sessionFile: normalized.execution.sessionFile,
    }
  }

  return {
    async lookup(address) {
      return safePersistenceCall(() => persistence.lookup(address))
    },

    resolveExisting: resolveExistingSession,

    resolve: resolveSession,

    async registerNew(session, requestedMode) {
      return bindSession(session, requestedMode)
    },

    async derive({ source, target }) {
      const sourceScope = await resolveSession(source)
      const targetScope = bindSession(target, sourceScope.sessionMode)
      if (targetScope.sessionMode !== sourceScope.sessionMode) {
        throw new SessionScopeResolutionError('CANONICAL_INPUT_MISMATCH')
      }
      return targetScope
    },
  }
}
