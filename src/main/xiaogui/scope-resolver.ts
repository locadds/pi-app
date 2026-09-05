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
import { normalizePathKey } from './path-key'
import { readProjectRootIdentityV2 } from '../project-root-identity'

export type ProjectIdentityBindingV1 = Extract<OpaqueIdentityBindingV1, { kind: 'PROJECT' }> & {
  readonly rootIdentityDigest: string
}
export type SessionIdentityBindingV1 = Extract<OpaqueIdentityBindingV1, { kind: 'SESSION' }>
export type SandboxIdentityBindingV1 = Extract<OpaqueIdentityBindingV1, { kind: 'SANDBOX' }>

export interface SessionBindingCommitV1 {
  project: ProjectIdentityBindingV1
  session: SessionIdentityBindingV1
  sessionMode: SessionMode
}

export type SessionBindingLookupV1 = Pick<SessionBindingCommitV1, 'project' | 'session'>

export interface SandboxBindingCommitV1 {
  project: ProjectIdentityBindingV1
  sandbox: SandboxIdentityBindingV1
}

export interface SessionScopePersistenceV1 {
  lookup(address: SessionAddressV1): SessionScopeLookupResultV1
  lookupBoundSession(input: SessionBindingLookupV1): SessionScopeLookupResultV1
  getLegacySessionMode(normalizedSessionFile: string): SessionMode | null
  getLegacyProjectMode(normalizedProjectRoot: string): SessionMode | null
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

export class SessionScopeResolutionError extends Error {
  constructor(readonly code: SessionScopeResolutionErrorCode) {
    super(code)
    this.name = 'SessionScopeResolutionError'
  }
}

function normalizeSessionRef(session: PiSessionRefV1): PiSessionRefV1 {
  const rootPath = normalizePathKey(session.rootPath)
  const sessionFile = normalizePathKey(session.sessionFile)
  if (!rootPath || !sessionFile) {
    throw new SessionScopeResolutionError('INVALID_CANONICAL_SCOPE_INPUT')
  }
  return { rootPath, sessionFile }
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
    session: PiSessionRefV1,
    requestedMode: SessionMode,
  ): PiSessionScopeV1 {
    const normalized = normalizeSessionRef(session)
    const project = idDeriver.deriveProject(normalized.rootPath)
    const rootIdentityDigest = projectRootIdentity(normalized.rootPath)
    const derivedSession = idDeriver.deriveSession(project.projectId, normalized.sessionFile)
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
      }),
    )
    return {
      projectId: project.projectId,
      sessionKey: derivedSession.sessionKey,
      sessionMode: effectiveMode,
      rootPath: normalized.rootPath,
      sessionFile: normalized.sessionFile,
    }
  }

  async function resolveSession(session: PiSessionRefV1): Promise<PiSessionScopeV1> {
    const normalized = normalizeSessionRef(session)
    const requestedMode = safePersistenceCall(
      () =>
        persistence.getLegacySessionMode(normalized.sessionFile) ??
        persistence.getLegacyProjectMode(normalized.rootPath) ??
        'WORK',
    )
    return bindSession(normalized, requestedMode)
  }

  async function resolveExistingSession(session: PiSessionRefV1): Promise<PiSessionScopeV1 | null> {
    const normalized = normalizeSessionRef(session)
    const project = idDeriver.deriveProject(normalized.rootPath)
    const rootIdentityDigest = projectRootIdentity(normalized.rootPath)
    const derivedSession = idDeriver.deriveSession(project.projectId, normalized.sessionFile)
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
      rootPath: normalized.rootPath,
      sessionFile: normalized.sessionFile,
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
