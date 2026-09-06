import type { ProjectRootIdentityV2 } from './project-root-identity'

export type TrustedProjectRegistrationSourceV1 =
  | 'NATIVE_DIRECTORY_PICKER'
  | 'MANAGED_SANDBOX'

export interface TrustedProjectRegistrationEvidenceV1 {
  readonly schemaVersion: 1
  readonly canonicalRoot: string
  readonly projectIdentityDigest: string
  readonly source: TrustedProjectRegistrationSourceV1
  readonly registeredAt: number
}

export interface TrustedProjectRegistrationStoreV1 {
  read(): readonly TrustedProjectRegistrationEvidenceV1[]
  write(rows: readonly TrustedProjectRegistrationEvidenceV1[]): void
}

type ProjectAuthorizationV1 =
  | { readonly ok: true; readonly cwd: string }
  | { readonly ok: false; readonly error: string }

interface TrustedProjectRegistrationOptionsV1 {
  readonly store: TrustedProjectRegistrationStoreV1
  readonly readIdentity: (root: string) => ProjectRootIdentityV2
  readonly now: () => number
}

function registrationKey(root: string): string {
  const normalized = String(root || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

/** Main-only, revalidated evidence that a project was selected by a native Main action. */
export class TrustedProjectRegistrationModuleV1 {
  constructor(private readonly options: TrustedProjectRegistrationOptionsV1) {}

  register(
    candidateRoot: string,
    source: TrustedProjectRegistrationSourceV1,
  ): ProjectAuthorizationV1 {
    let identity: ProjectRootIdentityV2
    try {
      identity = this.options.readIdentity(String(candidateRoot || '').trim())
    } catch {
      return { ok: false, error: 'trusted_project_invalid' }
    }
    const evidence: TrustedProjectRegistrationEvidenceV1 = Object.freeze({
      schemaVersion: 1,
      canonicalRoot: identity.canonicalRoot,
      projectIdentityDigest: identity.digest,
      source,
      registeredAt: this.options.now(),
    })
    const key = registrationKey(identity.canonicalRoot)
    const next = this.options.store.read()
      .filter((row) => registrationKey(row.canonicalRoot) !== key)
      .concat(evidence)
    this.options.store.write(next)
    return { ok: true, cwd: identity.canonicalRoot }
  }

  authorize(candidateRoot: string | undefined): ProjectAuthorizationV1 {
    const candidate = String(candidateRoot || '').trim()
    if (!candidate) return { ok: false, error: 'trusted_project_open_required' }
    let identity: ProjectRootIdentityV2
    try {
      identity = this.options.readIdentity(candidate)
    } catch {
      return { ok: false, error: 'trusted_project_open_required' }
    }
    const key = registrationKey(identity.canonicalRoot)
    const evidence = this.options.store.read().find(
      (row) => row.schemaVersion === 1 && registrationKey(row.canonicalRoot) === key,
    )
    if (!evidence) return { ok: false, error: 'trusted_project_open_required' }
    if (evidence.projectIdentityDigest !== identity.digest) {
      return { ok: false, error: 'PROJECT_IDENTITY_CHANGED' }
    }
    return { ok: true, cwd: identity.canonicalRoot }
  }

  revoke(candidateRoot: string): void {
    const key = registrationKey(candidateRoot)
    this.options.store.write(
      this.options.store.read().filter((row) => registrationKey(row.canonicalRoot) !== key),
    )
  }
}
