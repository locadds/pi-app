import { describe, expect, it } from 'vitest'

import { opaqueScopeIdDeriverV1 } from './scope-derive'

describe('opaqueScopeIdDeriverV1', () => {
  it('uses stable V1 prefixes and lowercase SHA-256 digests', () => {
    const project = opaqueScopeIdDeriverV1.deriveProject('D:\\Projects\\Alpha')
    const session = opaqueScopeIdDeriverV1.deriveSession(
      project.projectId,
      'D:\\Projects\\Alpha\\.pi\\agent\\sessions\\one.jsonl',
    )
    const sandbox = opaqueScopeIdDeriverV1.deriveSandbox(
      project.projectId,
      'D:\\Projects\\Alpha\\.pi\\sandboxes\\one',
    )

    expect(project.projectId).toMatch(/^xgp1_[0-9a-f]{64}$/)
    expect(session.sessionKey).toMatch(/^xgs1_[0-9a-f]{64}$/)
    expect(sandbox.sandboxKey).toMatch(/^xgb1_[0-9a-f]{64}$/)
    expect(project).toEqual({
      projectId: 'xgp1_c431462c94a7e310704584bbad18473eec84fc91b0bec234cc10abfba75c48ab',
      canonicalInputFingerprint: '608fe481c856df58f4cd5d04734414aa8c808ebfe0ca596f89fe775cb2259663',
    })
    expect(session).toEqual({
      sessionKey: 'xgs1_189a76363e248697239e1d67eb5f00c99aad910381b1dc4c1c2775989cea1b32',
      canonicalInputFingerprint: '5efb8a516ff52b8def650d9f6ad46989f448c1dc46079c06c3e6be5f868b99a9',
    })
    expect(sandbox).toEqual({
      sandboxKey: 'xgb1_833e9537bfa6e1539b53d89f844dc78bdf1b867e59c8bc5dd849e9b17bc3048d',
      canonicalInputFingerprint: '4d71eda61dd95d1f8077778cacffd164e67787277e38d284a99ee49411261685',
    })
    expect(new Set([project.projectId, session.sessionKey, sandbox.sandboxKey])).toHaveLength(3)
  })

  it('normalizes equivalent Windows inputs before deriving identities', () => {
    const left = opaqueScopeIdDeriverV1.deriveProject('d:\\PROJECTS\\Alpha\\')
    const right = opaqueScopeIdDeriverV1.deriveProject('D:/projects/alpha')
    expect(left).toEqual(right)

    const leftSession = opaqueScopeIdDeriverV1.deriveSession(
      left.projectId,
      'd:\\PROJECTS\\Alpha\\.pi\\agent\\sessions\\one.jsonl',
    )
    const rightSession = opaqueScopeIdDeriverV1.deriveSession(
      right.projectId,
      'D:/projects/alpha/.pi/agent/sessions/one.jsonl',
    )
    expect(leftSession).toEqual(rightSession)
  })

  it('normalizes the WSL selector without folding the Linux path body', () => {
    const mixedCase = opaqueScopeIdDeriverV1.deriveProject(
      '//wsl.localhost/Ubuntu/tmp/CaseSensitiveRoot',
    )
    const selectorAlias = opaqueScopeIdDeriverV1.deriveProject(
      '//WSL$/ubuntu/tmp/CaseSensitiveRoot',
    )
    const differentLinuxPath = opaqueScopeIdDeriverV1.deriveProject(
      '//wsl.localhost/ubuntu/tmp/casesensitiveroot',
    )

    expect(selectorAlias).toEqual(mixedCase)
    expect(differentLinuxPath).not.toEqual(mixedCase)
  })

  it('binds session and sandbox identities to their parent project', () => {
    const first = opaqueScopeIdDeriverV1.deriveProject('D:/projects/first')
    const second = opaqueScopeIdDeriverV1.deriveProject('D:/projects/second')

    expect(
      opaqueScopeIdDeriverV1.deriveSession(first.projectId, 'D:/shared/session.jsonl').sessionKey,
    ).not.toBe(
      opaqueScopeIdDeriverV1.deriveSession(second.projectId, 'D:/shared/session.jsonl').sessionKey,
    )
    expect(
      opaqueScopeIdDeriverV1.deriveSandbox(first.projectId, 'D:/shared/sandbox').sandboxKey,
    ).not.toBe(
      opaqueScopeIdDeriverV1.deriveSandbox(second.projectId, 'D:/shared/sandbox').sandboxKey,
    )
  })

  it('uses separate binding domains from public identity domains', () => {
    const project = opaqueScopeIdDeriverV1.deriveProject('D:/projects/alpha')
    const session = opaqueScopeIdDeriverV1.deriveSession(project.projectId, 'D:/sessions/one.jsonl')
    const sandbox = opaqueScopeIdDeriverV1.deriveSandbox(project.projectId, 'D:/sandboxes/one')

    for (const value of [project, session, sandbox]) {
      expect(value.canonicalInputFingerprint).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(project.canonicalInputFingerprint).not.toBe(project.projectId.slice('xgp1_'.length))
    expect(session.canonicalInputFingerprint).not.toBe(session.sessionKey.slice('xgs1_'.length))
    expect(sandbox.canonicalInputFingerprint).not.toBe(sandbox.sandboxKey.slice('xgb1_'.length))
  })

  it('fails closed for empty canonical inputs', () => {
    expect(() => opaqueScopeIdDeriverV1.deriveProject('  ')).toThrow(
      'INVALID_CANONICAL_SCOPE_INPUT:projectRoot',
    )

    const project = opaqueScopeIdDeriverV1.deriveProject('D:/projects/alpha')
    expect(() => opaqueScopeIdDeriverV1.deriveSession(project.projectId, '')).toThrow(
      'INVALID_CANONICAL_SCOPE_INPUT:sessionFile',
    )
    expect(() => opaqueScopeIdDeriverV1.deriveSandbox(project.projectId, '')).toThrow(
      'INVALID_CANONICAL_SCOPE_INPUT:sandboxIdentity',
    )
  })
})
