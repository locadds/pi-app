import { createHash } from 'node:crypto'

import type {
  CanonicalSessionAddressScopeV1,
  ProjectId,
  SandboxKeyV1,
  SessionKey,
} from '@shared/xiaogui-session-scope'

import { normalizePathKey } from './path-key'

export type SessionDerivationKind = 'FORK' | 'CLONE'

export interface PiSessionRefV1 {
  rootPath: string
  sessionFile: string
}

export interface PiSessionScopeV1 extends CanonicalSessionAddressScopeV1 {
  rootPath: string
  sessionFile: string
}

export type CanonicalInputFingerprintV1 = string & {
  readonly __brand: 'CanonicalInputFingerprintV1'
}

export type OpaqueIdentityBindingV1 =
  | {
      kind: 'PROJECT'
      opaqueId: ProjectId
      canonicalInputFingerprint: CanonicalInputFingerprintV1
    }
  | {
      kind: 'SESSION'
      opaqueId: SessionKey
      canonicalInputFingerprint: CanonicalInputFingerprintV1
      projectId: ProjectId
    }
  | {
      kind: 'SANDBOX'
      opaqueId: SandboxKeyV1
      canonicalInputFingerprint: CanonicalInputFingerprintV1
      projectId: ProjectId
    }

export interface OpaqueScopeIdDeriverV1 {
  deriveProject(normalizedProjectRoot: string): {
    projectId: ProjectId
    canonicalInputFingerprint: CanonicalInputFingerprintV1
  }
  deriveSession(projectId: ProjectId, normalizedSessionFile: string): {
    sessionKey: SessionKey
    canonicalInputFingerprint: CanonicalInputFingerprintV1
  }
  deriveSandbox(projectId: ProjectId, normalizedSandboxIdentity: string): {
    sandboxKey: SandboxKeyV1
    canonicalInputFingerprint: CanonicalInputFingerprintV1
  }
}

const PROJECT_DOMAIN = 'xiaogui.project.v1\0'
const SESSION_DOMAIN = 'xiaogui.session.v1\0'
const SANDBOX_DOMAIN = 'xiaogui.sandbox.v1\0'

const PROJECT_BINDING_DOMAIN = 'xiaogui.project.binding.v1\0'
const SESSION_BINDING_DOMAIN = 'xiaogui.session.binding.v1\0'
const SANDBOX_BINDING_DOMAIN = 'xiaogui.sandbox.binding.v1\0'

function sha256LowerHex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function canonicalize(value: string, inputName: string): string {
  const normalized = normalizePathKey(value)
  if (!normalized) {
    throw new Error(`INVALID_CANONICAL_SCOPE_INPUT:${inputName}`)
  }
  return normalized
}

function fingerprint(domain: string, canonicalInput: string): CanonicalInputFingerprintV1 {
  return sha256LowerHex(domain + canonicalInput) as CanonicalInputFingerprintV1
}

export const opaqueScopeIdDeriverV1: OpaqueScopeIdDeriverV1 = {
  deriveProject(projectRoot) {
    const canonicalRoot = canonicalize(projectRoot, 'projectRoot')
    return {
      projectId: `xgp1_${sha256LowerHex(PROJECT_DOMAIN + canonicalRoot)}` as ProjectId,
      canonicalInputFingerprint: fingerprint(PROJECT_BINDING_DOMAIN, canonicalRoot),
    }
  },

  deriveSession(projectId, sessionFile) {
    const canonicalFile = canonicalize(sessionFile, 'sessionFile')
    const canonicalInput = `${projectId}\0${canonicalFile}`
    return {
      sessionKey: `xgs1_${sha256LowerHex(SESSION_DOMAIN + canonicalInput)}` as SessionKey,
      canonicalInputFingerprint: fingerprint(SESSION_BINDING_DOMAIN, canonicalInput),
    }
  },

  deriveSandbox(projectId, sandboxIdentity) {
    const canonicalIdentity = canonicalize(sandboxIdentity, 'sandboxIdentity')
    const canonicalInput = `${projectId}\0${canonicalIdentity}`
    return {
      sandboxKey: `xgb1_${sha256LowerHex(SANDBOX_DOMAIN + canonicalInput)}` as SandboxKeyV1,
      canonicalInputFingerprint: fingerprint(SANDBOX_BINDING_DOMAIN, canonicalInput),
    }
  },
}
