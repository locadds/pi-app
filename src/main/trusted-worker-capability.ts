import type { ProjectRootIdentityV2 } from './project-root-identity'
import { readProjectRootIdentityV2 } from './project-root-identity'

declare const trustedProjectBindingBrandV1: unique symbol
declare const trustedSessionBindingBrandV1: unique symbol

/**
 * Main-process-only capability handle. It intentionally contains no data: the
 * authority is object identity in the issuing Module's WeakMap, not a digest or
 * a TypeScript shape that can cross IPC.
 */
export type TrustedProjectBindingHandleV1 = Readonly<{
  readonly [trustedProjectBindingBrandV1]: true
}>

/** Main-process-only capability for one canonical Pi session. */
export type TrustedSessionBindingHandleV1 = Readonly<{
  readonly [trustedSessionBindingBrandV1]: true
}>

export interface TrustedProjectBindingSnapshotV1 {
  readonly authorizedRoot: string
  readonly projectIdentityDigest: string
}

export interface TrustedSessionBindingSnapshotV1 extends TrustedProjectBindingSnapshotV1 {
  readonly canonicalSessionFile: string
}

export type TrustedWorkerCapabilityErrorCodeV1 =
  | 'TRUSTED_PROJECT_BINDING_REQUIRED'
  | 'TRUSTED_SESSION_BINDING_REQUIRED'
  | 'PROJECT_IDENTITY_CHANGED'

export class TrustedWorkerCapabilityErrorV1 extends Error {
  constructor(readonly code: TrustedWorkerCapabilityErrorCodeV1) {
    super(code)
    this.name = 'TrustedWorkerCapabilityErrorV1'
  }
}

interface ProjectCapabilityRecordV1 extends TrustedProjectBindingSnapshotV1 {}

interface SessionCapabilityRecordV1 {
  readonly projectBinding: TrustedProjectBindingHandleV1
  readonly canonicalSessionFile: string
}

export interface TrustedWorkerCapabilityAuthorityV1 {
  inspectProject(binding: TrustedProjectBindingHandleV1): TrustedProjectBindingSnapshotV1
  inspectSession(binding: TrustedSessionBindingHandleV1): TrustedSessionBindingSnapshotV1
  projectForSession(binding: TrustedSessionBindingHandleV1): TrustedProjectBindingHandleV1
}

/**
 * The issuer half is deliberately separate from the authority half. Runtime
 * composition keeps this object private to TrustedSessionAccessModule; callers
 * that only receive the authority can validate handles but cannot mint them.
 */
export interface TrustedWorkerCapabilityIssuerV1 {
  issueProject(authorizedRoot: string): TrustedProjectBindingHandleV1
  issueSession(
    projectBinding: TrustedProjectBindingHandleV1,
    canonicalSessionFile: string,
  ): TrustedSessionBindingHandleV1
}

export interface TrustedWorkerCapabilitySetV1 {
  readonly authority: TrustedWorkerCapabilityAuthorityV1
  readonly issuer: TrustedWorkerCapabilityIssuerV1
}

function requiredValue(value: string, errorCode: TrustedWorkerCapabilityErrorCodeV1): string {
  const normalized = String(value || '').trim()
  if (!normalized) throw new TrustedWorkerCapabilityErrorV1(errorCode)
  return normalized
}

function frozenHandle<T>(): T {
  return Object.freeze(Object.create(null)) as T
}

/**
 * Create one in-memory authority domain. Handles issued by another domain (or
 * reconstructed after a restart) are rejected even when their visible shape is
 * identical. Persisted roots/digests therefore remain evidence, never authority.
 */
export function createTrustedWorkerCapabilitySetV1(options: {
  readonly readProjectIdentity?: (authorizedRoot: string) => ProjectRootIdentityV2
} = {}): TrustedWorkerCapabilitySetV1 {
  const readProjectIdentity = options.readProjectIdentity ?? readProjectRootIdentityV2
  const projects = new WeakMap<object, ProjectCapabilityRecordV1>()
  const sessions = new WeakMap<object, SessionCapabilityRecordV1>()

  function inspectProject(binding: TrustedProjectBindingHandleV1): TrustedProjectBindingSnapshotV1 {
    const record = binding && typeof binding === 'object'
      ? projects.get(binding as object)
      : undefined
    if (!record) {
      throw new TrustedWorkerCapabilityErrorV1('TRUSTED_PROJECT_BINDING_REQUIRED')
    }

    let current: ProjectRootIdentityV2
    try {
      current = readProjectIdentity(record.authorizedRoot)
    } catch {
      throw new TrustedWorkerCapabilityErrorV1('PROJECT_IDENTITY_CHANGED')
    }
    if (current.digest !== record.projectIdentityDigest) {
      throw new TrustedWorkerCapabilityErrorV1('PROJECT_IDENTITY_CHANGED')
    }
    return Object.freeze({ ...record })
  }

  const authority: TrustedWorkerCapabilityAuthorityV1 = Object.freeze({
    inspectProject,
    inspectSession(binding: TrustedSessionBindingHandleV1) {
      const record = binding && typeof binding === 'object'
        ? sessions.get(binding as object)
        : undefined
      if (!record) {
        throw new TrustedWorkerCapabilityErrorV1('TRUSTED_SESSION_BINDING_REQUIRED')
      }
      const project = inspectProject(record.projectBinding)
      return Object.freeze({
        ...project,
        canonicalSessionFile: record.canonicalSessionFile,
      })
    },
    projectForSession(binding: TrustedSessionBindingHandleV1) {
      const record = binding && typeof binding === 'object'
        ? sessions.get(binding as object)
        : undefined
      if (!record) {
        throw new TrustedWorkerCapabilityErrorV1('TRUSTED_SESSION_BINDING_REQUIRED')
      }
      inspectProject(record.projectBinding)
      return record.projectBinding
    },
  })

  const issuer: TrustedWorkerCapabilityIssuerV1 = Object.freeze({
    issueProject(authorizedRoot: string) {
      const root = requiredValue(authorizedRoot, 'TRUSTED_PROJECT_BINDING_REQUIRED')
      const identity = readProjectIdentity(root)
      const handle = frozenHandle<TrustedProjectBindingHandleV1>()
      projects.set(handle as object, Object.freeze({
        authorizedRoot: root,
        projectIdentityDigest: identity.digest,
      }))
      return handle
    },

    issueSession(
      projectBinding: TrustedProjectBindingHandleV1,
      canonicalSessionFile: string,
    ) {
      // Verification here prevents a forged/stale project value from becoming a
      // stronger session capability.
      inspectProject(projectBinding)
      const sessionFile = requiredValue(
        canonicalSessionFile,
        'TRUSTED_SESSION_BINDING_REQUIRED',
      )
      const handle = frozenHandle<TrustedSessionBindingHandleV1>()
      sessions.set(handle as object, Object.freeze({
        projectBinding,
        canonicalSessionFile: sessionFile,
      }))
      return handle
    },
  })

  return Object.freeze({ authority, issuer })
}

const productionCapabilitySetV1 = createTrustedWorkerCapabilitySetV1()

/** Shared verifier for Main modules that consume a trusted Worker capability. */
export const trustedWorkerCapabilityAuthorityV1 = productionCapabilitySetV1.authority

/**
 * @internal Issuance is reserved for TrustedSessionAccessModule. Do not import
 * this from IPC, persistence, Renderer, or Worker code.
 */
export const trustedSessionAccessCapabilityIssuerV1 = productionCapabilitySetV1.issuer
