import { describe, expect, it, vi } from 'vitest'

import {
  createTrustedWorkerCapabilitySetV1,
  type TrustedProjectBindingHandleV1,
  type TrustedSessionBindingHandleV1,
} from './trusted-worker-capability'

function identity(root: string, digest: string) {
  return {
    schemaVersion: 2 as const,
    canonicalRoot: root,
    device: '1',
    inode: '2',
    birthtimeNs: '3',
    digest,
  }
}

describe('trusted worker capability authority', () => {
  it('keeps authority in object identity rather than visible fields or digests', () => {
    const readProjectIdentity = vi.fn((root: string) => identity(root, 'sha256:project-a'))
    const capabilities = createTrustedWorkerCapabilitySetV1({ readProjectIdentity })
    const project = capabilities.issuer.issueProject('D:/project')
    const session = capabilities.issuer.issueSession(project, 'D:/sessions/a.jsonl')

    expect(Object.keys(project)).toEqual([])
    expect(Object.keys(session)).toEqual([])
    expect(JSON.stringify(project)).toBe('{}')
    expect(JSON.stringify(session)).toBe('{}')
    expect(capabilities.authority.inspectSession(session)).toEqual({
      authorizedRoot: 'D:/project',
      projectIdentityDigest: 'sha256:project-a',
      canonicalSessionFile: 'D:/sessions/a.jsonl',
    })

    const forgedProject = {
      authorizedRoot: 'D:/project',
      projectIdentityDigest: 'sha256:project-a',
    } as unknown as TrustedProjectBindingHandleV1
    const forgedSession = {
      canonicalSessionFile: 'D:/sessions/a.jsonl',
    } as unknown as TrustedSessionBindingHandleV1
    expect(() => capabilities.authority.inspectProject(forgedProject))
      .toThrow('TRUSTED_PROJECT_BINDING_REQUIRED')
    expect(() => capabilities.authority.inspectSession(forgedSession))
      .toThrow('TRUSTED_SESSION_BINDING_REQUIRED')
  })

  it('rejects handles from another authority domain and reconstructed handles', () => {
    const readProjectIdentity = vi.fn((root: string) => identity(root, 'sha256:project-a'))
    const first = createTrustedWorkerCapabilitySetV1({ readProjectIdentity })
    const second = createTrustedWorkerCapabilitySetV1({ readProjectIdentity })
    const project = first.issuer.issueProject('D:/project')
    const session = first.issuer.issueSession(project, 'D:/sessions/a.jsonl')

    expect(() => second.authority.inspectProject(project))
      .toThrow('TRUSTED_PROJECT_BINDING_REQUIRED')
    expect(() => second.authority.inspectSession(session))
      .toThrow('TRUSTED_SESSION_BINDING_REQUIRED')
    expect(() => first.authority.inspectProject(
      structuredClone(project) as TrustedProjectBindingHandleV1,
    )).toThrow('TRUSTED_PROJECT_BINDING_REQUIRED')
  })

  it('rechecks the project entity whenever a project or session handle is consumed', () => {
    let digest = 'sha256:original'
    const readProjectIdentity = vi.fn((root: string) => identity(root, digest))
    const capabilities = createTrustedWorkerCapabilitySetV1({ readProjectIdentity })
    const project = capabilities.issuer.issueProject('D:/project')
    const session = capabilities.issuer.issueSession(project, 'D:/sessions/a.jsonl')

    expect(capabilities.authority.inspectProject(project).projectIdentityDigest)
      .toBe('sha256:original')
    digest = 'sha256:replacement'
    expect(() => capabilities.authority.inspectProject(project))
      .toThrow('PROJECT_IDENTITY_CHANGED')
    expect(() => capabilities.authority.inspectSession(session))
      .toThrow('PROJECT_IDENTITY_CHANGED')
  })

  it('normalizes a missing/replaced root into the stable identity-change error', () => {
    let missing = false
    const capabilities = createTrustedWorkerCapabilitySetV1({
      readProjectIdentity: (root) => {
        if (missing) throw new Error('PROJECT_ROOT_MISSING')
        return identity(root, 'sha256:original')
      },
    })
    const project = capabilities.issuer.issueProject('D:/project')
    missing = true

    expect(() => capabilities.authority.inspectProject(project))
      .toThrow('PROJECT_IDENTITY_CHANGED')
  })

  it('does not issue a session capability from a forged or stale project handle', () => {
    let digest = 'sha256:original'
    const capabilities = createTrustedWorkerCapabilitySetV1({
      readProjectIdentity: (root) => identity(root, digest),
    })
    const project = capabilities.issuer.issueProject('D:/project')

    expect(() => capabilities.issuer.issueSession(
      {} as TrustedProjectBindingHandleV1,
      'D:/sessions/a.jsonl',
    )).toThrow('TRUSTED_PROJECT_BINDING_REQUIRED')
    digest = 'sha256:replacement'
    expect(() => capabilities.issuer.issueSession(project, 'D:/sessions/a.jsonl'))
      .toThrow('PROJECT_IDENTITY_CHANGED')
  })
})
