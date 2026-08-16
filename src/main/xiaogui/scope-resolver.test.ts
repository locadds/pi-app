import { beforeEach, describe, expect, it } from 'vitest'

import type {
  SessionAddressV1,
  SessionMode,
  SessionScopeLookupResultV1,
} from '@shared/xiaogui-session-scope'

import {
  createSessionScopeResolverV1,
  SessionScopeResolutionError,
  type SessionBindingCommitV1,
  type SessionScopePersistenceV1,
} from './scope-resolver'

class FakePersistence implements SessionScopePersistenceV1 {
  readonly sessions = new Map<string, SessionBindingCommitV1>()
  readonly legacySessions = new Map<string, SessionMode>()
  readonly legacyProjects = new Map<string, SessionMode>()
  writes = 0
  failCommit = false

  lookup(address: SessionAddressV1): SessionScopeLookupResultV1 {
    const binding = this.sessions.get(address.sessionKey)
    if (!binding) return { kind: 'NOT_FOUND' }
    if (binding.session.projectId !== address.projectId) return { kind: 'PROJECT_MISMATCH' }
    return {
      kind: 'FOUND',
      scope: { ...address, sessionMode: binding.sessionMode },
    }
  }

  getLegacySessionMode(normalizedSessionFile: string): SessionMode | null {
    return this.legacySessions.get(normalizedSessionFile) ?? null
  }

  getLegacyProjectMode(normalizedProjectRoot: string): SessionMode | null {
    return this.legacyProjects.get(normalizedProjectRoot) ?? null
  }

  commitSession(input: SessionBindingCommitV1): SessionMode {
    if (this.failCommit) throw new Error('cannot write D:/private/xiaogui.json')
    const existing = this.sessions.get(input.session.opaqueId)
    if (existing) return existing.sessionMode
    this.sessions.set(input.session.opaqueId, input)
    this.writes += 1
    return input.sessionMode
  }

  commitSandbox(): void {}
}

let persistence: FakePersistence

beforeEach(() => {
  persistence = new FakePersistence()
})

describe('SessionScopeResolverV1.resolve', () => {
  it('defaults historical sessions to WORK and persists before returning', async () => {
    const resolver = createSessionScopeResolverV1(persistence)
    const scope = await resolver.resolve({
      rootPath: 'd:\\Projects\\Alpha\\',
      sessionFile: 'd:\\Projects\\Alpha\\.pi\\agent\\sessions\\one.jsonl',
    })

    expect(scope).toEqual(
      expect.objectContaining({
        rootPath: 'D:/projects/alpha',
        sessionFile: 'D:/projects/alpha/.pi/agent/sessions/one.jsonl',
        sessionMode: 'WORK',
      }),
    )
    expect(persistence.writes).toBe(1)
    await expect(
      resolver.lookup({ projectId: scope.projectId, sessionKey: scope.sessionKey }),
    ).resolves.toEqual({
      kind: 'FOUND',
      scope: {
        projectId: scope.projectId,
        sessionKey: scope.sessionKey,
        sessionMode: 'WORK',
      },
    })
  })

  it('migrates legacy session mode before project fallback', async () => {
    persistence.legacySessions.set('D:/projects/alpha/session.jsonl', 'CODING')
    persistence.legacyProjects.set('D:/projects/alpha', 'DESIGN')
    const scope = await createSessionScopeResolverV1(persistence).resolve({
      rootPath: 'D:/projects/alpha',
      sessionFile: 'D:/projects/alpha/session.jsonl',
    })
    expect(scope.sessionMode).toBe('CODING')
  })

  it('uses the legacy project mode only when no session mapping exists', async () => {
    persistence.legacyProjects.set('D:/projects/alpha', 'DESIGN')
    const scope = await createSessionScopeResolverV1(persistence).resolve({
      rootPath: 'D:/projects/alpha',
      sessionFile: 'D:/projects/alpha/session.jsonl',
    })
    expect(scope.sessionMode).toBe('DESIGN')
  })

  it('fails closed without leaking persistence error details', async () => {
    persistence.failCommit = true
    const promise = createSessionScopeResolverV1(persistence).resolve({
      rootPath: 'D:/projects/alpha',
      sessionFile: 'D:/projects/alpha/session.jsonl',
    })
    await expect(promise).rejects.toEqual(
      expect.objectContaining({ code: 'SCOPE_PERSISTENCE_FAILED' }),
    )
    await expect(promise).rejects.not.toThrow('D:/private')
    expect(persistence.writes).toBe(0)
  })

  it('rejects empty internal references before persistence', async () => {
    await expect(
      createSessionScopeResolverV1(persistence).resolve({ rootPath: '', sessionFile: '' }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INVALID_CANONICAL_SCOPE_INPUT' }))
    expect(persistence.writes).toBe(0)
  })
})

describe('SessionScopeResolverV1 lookup and derivation', () => {
  it('keeps lookup read-only for absence and project mismatch', async () => {
    const resolver = createSessionScopeResolverV1(persistence)
    const source = await resolver.resolve({
      rootPath: 'D:/projects/alpha',
      sessionFile: 'D:/projects/alpha/source.jsonl',
    })
    const writes = persistence.writes

    await expect(
      resolver.lookup({ projectId: source.projectId, sessionKey: 'xgs1_missing' as never }),
    ).resolves.toEqual({ kind: 'NOT_FOUND' })
    await expect(
      resolver.lookup({ projectId: 'xgp1_wrong' as never, sessionKey: source.sessionKey }),
    ).resolves.toEqual({ kind: 'PROJECT_MISMATCH' })
    expect(persistence.writes).toBe(writes)
  })

  it('derives a new key and inherits the source mode without copying other facts', async () => {
    persistence.legacySessions.set('D:/projects/alpha/source.jsonl', 'CODING')
    const resolver = createSessionScopeResolverV1(persistence)
    const source = await resolver.resolve({
      rootPath: 'D:/projects/alpha',
      sessionFile: 'D:/projects/alpha/source.jsonl',
    })
    const target = await resolver.derive({
      kind: 'FORK',
      source: {
        rootPath: 'D:/projects/alpha',
        sessionFile: 'D:/projects/alpha/source.jsonl',
      },
      target: {
        rootPath: 'D:/projects/alpha',
        sessionFile: 'D:/projects/alpha/fork.jsonl',
      },
    })

    expect(target.sessionKey).not.toBe(source.sessionKey)
    expect(target.sessionMode).toBe('CODING')
    expect(persistence.sessions).toHaveLength(2)
  })

  it('rejects a pre-existing target whose mode contradicts inheritance', async () => {
    const resolver = createSessionScopeResolverV1(persistence)
    const target = await resolver.resolve({
      rootPath: 'D:/projects/alpha',
      sessionFile: 'D:/projects/alpha/target.jsonl',
    })
    persistence.sessions.get(target.sessionKey)!.sessionMode = 'DESIGN'

    await expect(
      resolver.derive({
        kind: 'CLONE',
        source: {
          rootPath: 'D:/projects/alpha',
          sessionFile: 'D:/projects/alpha/source.jsonl',
        },
        target: {
          rootPath: 'D:/projects/alpha',
          sessionFile: 'D:/projects/alpha/target.jsonl',
        },
      }),
    ).rejects.toBeInstanceOf(SessionScopeResolutionError)
  })
})
