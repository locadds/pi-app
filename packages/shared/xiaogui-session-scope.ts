/**
 * M1 public session-scope contract.
 *
 * These values may cross preload/renderer boundaries. Filesystem facts stay in
 * the main process and are deliberately absent from this module.
 */
export type SessionMode = 'WORK' | 'DESIGN' | 'CODING'

export type ProjectId = string & { readonly __brand: 'ProjectId' }
export type SessionKey = string & { readonly __brand: 'SessionKey' }
export type SandboxKeyV1 = string & { readonly __brand: 'SandboxKeyV1' }

export interface SessionAddressV1 {
  projectId: ProjectId
  sessionKey: SessionKey
}

export interface CanonicalSessionAddressScopeV1 extends SessionAddressV1 {
  sessionMode: SessionMode
}

export type SessionScopeLookupResultV1 =
  | { kind: 'FOUND'; scope: CanonicalSessionAddressScopeV1 }
  | { kind: 'NOT_FOUND' }
  | { kind: 'PROJECT_MISMATCH' }

export interface SessionScopeLookupV1 {
  lookup(address: SessionAddressV1): Promise<SessionScopeLookupResultV1>
}
