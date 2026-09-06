import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { isWslWindowsPath, wslPathToWindows, wslWindowsPathDistro } from '@shared/wsl-path'

import { readSessionMetaFromFile, type SessionFileMeta } from './session-file-meta'
import {
  isSandboxWorkspacePath,
  sandboxOwnsSessionFile,
} from './sandbox-workspaces'
import {
  trustedSessionAccessCapabilityIssuerV1,
  trustedWorkerCapabilityAuthorityV1,
  type TrustedProjectBindingHandleV1,
  type TrustedProjectBindingSnapshotV1,
  type TrustedSessionBindingHandleV1,
  type TrustedSessionBindingSnapshotV1,
  type TrustedWorkerCapabilityAuthorityV1,
  type TrustedWorkerCapabilityIssuerV1,
} from './trusted-worker-capability'
import { authorizeTrustedProjectRoot, authorizeTrustedSessionFile } from './trusted-workspace'
import { canonicalWorkerProjectRootV1 } from './worker-execution-identity'
import { workerManager } from './worker-manager'
import type { PiSessionRefV1, PiSessionScopeV1 } from './xiaogui/scope-derive'
import { normalizePathKey } from './xiaogui/path-key'
import type { SessionScopeRegistrarV1, SessionScopeResolverV1 } from './xiaogui/scope-resolver'
import { sessionScopeResolverV1 } from './xiaogui/scope-service'

export interface TrustedProjectAccessV1 extends TrustedProjectBindingSnapshotV1 {
  readonly binding: TrustedProjectBindingHandleV1
}

export interface TrustedSessionAccessV1 {
  readonly binding: TrustedSessionBindingHandleV1
  readonly ref: PiSessionRefV1
  readonly scope: PiSessionScopeV1
}

export interface TrustedSessionBindingPortV1 {
  rememberSessionBinding(binding: TrustedSessionBindingHandleV1): void
  resolveRegisteredSessionBinding(sessionFile: string): TrustedSessionBindingHandleV1 | null
  readLiveSessionBinding(
    binding: TrustedSessionBindingHandleV1,
  ): { readonly sessionId: string; readonly agentTurnActive: boolean } | null
}

type TrustedCwdAuthorizationV1 = (
  requestedCwd: string | undefined,
) => { ok: true; cwd: string } | { ok: false; error: string }

type TrustedSessionFileAuthorizationV1 = (
  requestedCwd: string | undefined,
  requestedSessionFile: string | undefined,
) => { ok: true; cwd: string; sessionFile: string } | { ok: false; error: string }

interface TrustedSessionAccessOptionsV1 {
  readonly authorizeProject: TrustedCwdAuthorizationV1
  readonly authorizeFile: TrustedSessionFileAuthorizationV1
  readonly scopeResolver: SessionScopeResolverV1 & SessionScopeRegistrarV1
  readonly bindings: TrustedSessionBindingPortV1
  readonly authority: TrustedWorkerCapabilityAuthorityV1
  readonly issuer: TrustedWorkerCapabilityIssuerV1
  readonly readSessionMeta: (sessionFile: string) => SessionFileMeta | null
  readonly sessionFileExists: (sessionFile: string) => boolean
  readonly sandboxOwnsSession: (rootPath: string, sessionFile: string) => boolean
}

function portableAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || isWslWindowsPath(value)
}

function sessionFileForFs(sessionFile: string): string {
  if (process.platform !== 'win32' || !sessionFile.startsWith('//')) return sessionFile
  return `\\\\${sessionFile.slice(2).replace(/\//g, '\\')}`
}

function normalizedRuntimeSessionFile(sessionFile: string): string {
  const value = String(sessionFile || '').trim()
  if (!value || !portableAbsolutePath(value) || !/\.jsonl$/i.test(value)) {
    throw new Error('trusted_runtime_session_path_invalid')
  }
  return value
}

function comparableProjectRoot(sessionFile: string, cwd: string): string {
  const distro = wslWindowsPathDistro(sessionFile)
  const hostPath = distro && cwd.startsWith('/') ? wslPathToWindows(distro, cwd) : cwd
  return canonicalWorkerProjectRootV1(hostPath)
}

export class TrustedSessionAccessModuleV1 {
  private readonly materializedSessions = new WeakSet<object>()
  private readonly listedSessions = new Map<string, {
    readonly authorizedRoot: string
    readonly projectIdentityDigest: string
    readonly sessionId: string
    readonly canonicalSessionFile: string
  }>()

  constructor(private readonly options: TrustedSessionAccessOptionsV1) {}

  /** Mint a project capability only after an existing Main-owned cwd grant succeeds. */
  project(input: { readonly workspaceId: string }): TrustedProjectAccessV1 {
    const authorized = this.options.authorizeProject(input.workspaceId)
    if (!authorized.ok) throw new Error(authorized.error)
    const binding = this.options.issuer.issueProject(authorized.cwd)
    return Object.freeze({ binding, ...this.options.authority.inspectProject(binding) })
  }

  /** Authorize an explicit Main-owned open/navigation action and mint its capability. */
  async open(input: {
    readonly workspaceId: string
    readonly sessionFile: string
  }): Promise<TrustedSessionAccessV1> {
    const registered = this.options.bindings.resolveRegisteredSessionBinding(input.sessionFile)
    if (registered) return this.accessFromRegisteredBinding(registered, input)

    const project = this.project({ workspaceId: input.workspaceId })
    const listed = this.listedSessions.get(normalizePathKey(input.sessionFile))
    if (
      !listed
      || canonicalWorkerProjectRootV1(listed.authorizedRoot)
        !== canonicalWorkerProjectRootV1(project.authorizedRoot)
      || listed.projectIdentityDigest !== project.projectIdentityDigest
    ) {
      throw new Error('trusted_session_not_listed')
    }
    const access = await this.prepareOpen(input, undefined, project.binding, listed.sessionId)
    this.options.bindings.rememberSessionBinding(access.binding)
    return access
  }

  /**
   * Record Main SessionManager discovery output without issuing a session
   * capability. Renderer selectors can only consume an exact recorded item.
   */
  recordListedSessions(input: {
    readonly projectBinding: TrustedProjectBindingHandleV1
    readonly sessions: readonly { readonly id: string; readonly path: string }[]
  }): readonly string[] {
    const project = this.options.authority.inspectProject(input.projectBinding)
    const projectRootKey = canonicalWorkerProjectRootV1(project.authorizedRoot)
    for (const [key, row] of this.listedSessions) {
      if (canonicalWorkerProjectRootV1(row.authorizedRoot) === projectRootKey) {
        this.listedSessions.delete(key)
      }
    }

    const accepted: string[] = []
    for (const candidate of input.sessions) {
      const sessionId = String(candidate.id || '').trim()
      const requestedPath = String(candidate.path || '').trim()
      if (!sessionId || !requestedPath) continue
      const authorized = this.options.authorizeFile(project.authorizedRoot, requestedPath)
      if (!authorized.ok) continue
      if (
        canonicalWorkerProjectRootV1(authorized.cwd) !== projectRootKey
        || !this.options.sessionFileExists(sessionFileForFs(authorized.sessionFile))
      ) continue
      const metadata = this.options.readSessionMeta(authorized.sessionFile)
      if (!metadata || metadata.sessionId !== sessionId) continue
      const metadataRoot = metadata.cwd
        ? comparableProjectRoot(authorized.sessionFile, metadata.cwd)
        : ''
      const sandboxException = this.options.sandboxOwnsSession(
        project.authorizedRoot,
        authorized.sessionFile,
      )
      if (metadataRoot !== projectRootKey && !sandboxException) continue

      const key = normalizePathKey(authorized.sessionFile)
      this.listedSessions.set(key, Object.freeze({
        authorizedRoot: project.authorizedRoot,
        projectIdentityDigest: project.projectIdentityDigest,
        sessionId,
        canonicalSessionFile: authorized.sessionFile,
      }))
      accepted.push(authorized.sessionFile)
    }
    this.options.authority.inspectProject(input.projectBinding)
    return Object.freeze(accepted)
  }

  private async prepareOpen(
    input: {
      readonly workspaceId: string
      readonly sessionFile: string
    },
    expectedProjectIdentityDigest?: string,
    existingProjectBinding?: TrustedProjectBindingHandleV1,
    expectedSessionId?: string,
  ): Promise<TrustedSessionAccessV1> {
    const authorized = this.options.authorizeFile(input.workspaceId, input.sessionFile)
    if (!authorized.ok) throw new Error(authorized.error)
    const ref = { rootPath: authorized.cwd, sessionFile: authorized.sessionFile }
    const projectBinding = existingProjectBinding ?? this.options.issuer.issueProject(ref.rootPath)
    const project = this.options.authority.inspectProject(projectBinding)
    if (canonicalWorkerProjectRootV1(project.authorizedRoot) !== canonicalWorkerProjectRootV1(ref.rootPath)) {
      throw new Error('trusted_session_binding_mismatch')
    }
    if (
      expectedProjectIdentityDigest
      && project.projectIdentityDigest !== expectedProjectIdentityDigest
    ) {
      throw new Error('PROJECT_IDENTITY_CHANGED')
    }
    const scope = await this.options.scopeResolver.resolveExisting(ref)
      ?? await this.options.scopeResolver.resolve(ref)

    if (expectedSessionId) {
      const metadata = this.options.readSessionMeta(ref.sessionFile)
      if (!metadata || metadata.sessionId !== expectedSessionId) {
        throw new Error('trusted_session_listing_changed')
      }
    }

    // A root replacement during scope resolution must fail before a session
    // capability is issued or registered.
    this.options.authority.inspectProject(projectBinding)
    const binding = this.options.issuer.issueSession(projectBinding, ref.sessionFile)
    this.materializedSessions.add(binding as object)
    this.assertSessionMetadata(binding)
    return Object.freeze({ binding, ref, scope })
  }

  private async accessFromRegisteredBinding(
    binding: TrustedSessionBindingHandleV1,
    input: { readonly workspaceId: string; readonly sessionFile: string },
  ): Promise<TrustedSessionAccessV1> {
    const snapshot = this.inspectSession(binding)
    if (
      canonicalWorkerProjectRootV1(snapshot.authorizedRoot)
        !== canonicalWorkerProjectRootV1(input.workspaceId)
      || normalizePathKey(snapshot.canonicalSessionFile) !== normalizePathKey(input.sessionFile)
    ) throw new Error('trusted_session_binding_mismatch')
    const ref = {
      rootPath: snapshot.authorizedRoot,
      sessionFile: snapshot.canonicalSessionFile,
    }
    const scope = await this.options.scopeResolver.resolveExisting(ref)
    if (!scope) throw new Error('trusted_session_scope_missing')
    return Object.freeze({ binding, ref, scope })
  }

  /**
   * Accept a Pi-created path only inside a previously issued project capability.
   * Exact Worker/nonce/session-directory provenance is validated by the runtime
   * creation seam before it calls this method.
   */
  runtimeIssued(input: {
    readonly projectBinding: TrustedProjectBindingHandleV1
    readonly sessionFile: string
  }): TrustedSessionBindingHandleV1 {
    this.options.authority.inspectProject(input.projectBinding)
    const sessionFile = normalizedRuntimeSessionFile(input.sessionFile)
    const binding = this.options.issuer.issueSession(input.projectBinding, sessionFile)
    if (this.options.sessionFileExists(sessionFileForFs(sessionFile))) {
      this.materializedSessions.add(binding as object)
      this.assertSessionMetadata(binding)
    }
    this.options.bindings.rememberSessionBinding(binding)
    return binding
  }

  /**
   * Prompt access can select only a capability already registered by Main.
   * Renderer workspaceId/sessionFile values never mint or reconstruct one.
   */
  async prompt(input: {
    readonly workspaceId: string
    readonly sessionFile: string
    readonly requireRunningWorker?: boolean
  }): Promise<TrustedSessionAccessV1> {
    const workspaceId = String(input.workspaceId || '').trim()
    const requestedSessionFile = String(input.sessionFile || '').trim()
    if (!workspaceId || !requestedSessionFile) throw new Error('trusted_session_required')

    const binding = this.options.bindings.resolveRegisteredSessionBinding(requestedSessionFile)
    if (!binding) throw new Error('trusted_session_binding_mismatch')
    const snapshot = this.inspectSession(binding)
    if (
      canonicalWorkerProjectRootV1(snapshot.authorizedRoot)
        !== canonicalWorkerProjectRootV1(workspaceId)
      || normalizePathKey(snapshot.canonicalSessionFile) !== normalizePathKey(requestedSessionFile)
    ) throw new Error('trusted_session_binding_mismatch')

    const ref = {
      rootPath: snapshot.authorizedRoot,
      sessionFile: snapshot.canonicalSessionFile,
    }
    const scope = await this.options.scopeResolver.resolveExisting(ref)
    if (!scope) throw new Error('trusted_session_scope_missing')

    if (input.requireRunningWorker) {
      const live = this.options.bindings.readLiveSessionBinding(binding)
      if (!live?.agentTurnActive) throw new Error('trusted_running_session_required')
    }
    return Object.freeze({ binding, ref, scope })
  }

  /** Persisted rows are evidence only; every recovery receives a fresh capability. */
  async reissuePersisted(input: {
    readonly authorizedRoot: string
    readonly projectIdentityDigest: string
    readonly sessionFile: string
  }): Promise<TrustedSessionAccessV1> {
    const project = this.project({ workspaceId: input.authorizedRoot })
    if (project.projectIdentityDigest !== input.projectIdentityDigest) {
      throw new Error('PROJECT_IDENTITY_CHANGED')
    }
    const listed = this.listedSessions.get(normalizePathKey(input.sessionFile))
    if (
      !listed
      || listed.projectIdentityDigest !== input.projectIdentityDigest
      || listed.projectIdentityDigest !== project.projectIdentityDigest
    ) throw new Error('trusted_session_not_listed')
    const opened = await this.prepareOpen(
      {
        workspaceId: input.authorizedRoot,
        sessionFile: input.sessionFile,
      },
      input.projectIdentityDigest,
      project.binding,
      listed.sessionId,
    )
    this.options.bindings.rememberSessionBinding(opened.binding)
    return opened
  }

  inspectProject(binding: TrustedProjectBindingHandleV1): TrustedProjectBindingSnapshotV1 {
    return this.options.authority.inspectProject(binding)
  }

  inspectSession(binding: TrustedSessionBindingHandleV1): TrustedSessionBindingSnapshotV1 {
    const snapshot = this.options.authority.inspectSession(binding)
    this.assertSessionMetadata(binding, snapshot)
    return snapshot
  }

  private assertSessionMetadata(
    binding: TrustedSessionBindingHandleV1,
    knownSnapshot?: TrustedSessionBindingSnapshotV1,
  ): void {
    const snapshot = knownSnapshot ?? this.options.authority.inspectSession(binding)
    const exists = this.options.sessionFileExists(sessionFileForFs(snapshot.canonicalSessionFile))
    const metadata = exists ? this.options.readSessionMeta(snapshot.canonicalSessionFile) : null

    if (!exists) {
      if (this.materializedSessions.has(binding as object)) {
        throw new Error('trusted_session_metadata_missing')
      }
      return
    }
    if (!metadata?.cwd) throw new Error('trusted_session_metadata_invalid')
    this.materializedSessions.add(binding as object)

    const actualRoot = comparableProjectRoot(snapshot.canonicalSessionFile, metadata.cwd)
    const expectedRoot = canonicalWorkerProjectRootV1(snapshot.authorizedRoot)
    const sandboxException = isSandboxWorkspacePath(snapshot.authorizedRoot)
      && this.options.sandboxOwnsSession(snapshot.authorizedRoot, snapshot.canonicalSessionFile)
    if (actualRoot !== expectedRoot && !sandboxException) {
      throw new Error('session_workspace_mismatch')
    }
  }
}

export const trustedSessionAccessV1 = new TrustedSessionAccessModuleV1({
  authorizeProject: authorizeTrustedProjectRoot,
  authorizeFile: authorizeTrustedSessionFile,
  scopeResolver: sessionScopeResolverV1,
  // WorkerManager implements this Main-only port in the CLOSEOUT migration.
  bindings: workerManager as unknown as TrustedSessionBindingPortV1,
  authority: trustedWorkerCapabilityAuthorityV1,
  issuer: trustedSessionAccessCapabilityIssuerV1,
  readSessionMeta: readSessionMetaFromFile,
  sessionFileExists: existsSync,
  sandboxOwnsSession: sandboxOwnsSessionFile,
})
