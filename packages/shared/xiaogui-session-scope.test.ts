import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  CanonicalSessionAddressScopeV1,
  ProjectId,
  SandboxKeyV1,
  SessionAddressV1,
  SessionKey,
  SessionMode,
  SessionScopeLookupResultV1,
  SessionScopeLookupV1,
} from './xiaogui-session-scope'

describe('M1 public session-scope contract', () => {
  it('exposes only the path-free canonical identity contract', () => {
    expectTypeOf<SessionMode>().toEqualTypeOf<'WORK' | 'DESIGN' | 'CODING'>()
    expectTypeOf<ProjectId>().not.toEqualTypeOf<string>()
    expectTypeOf<SessionKey>().not.toEqualTypeOf<string>()
    expectTypeOf<SandboxKeyV1>().not.toEqualTypeOf<string>()
    expectTypeOf<SessionAddressV1>().toEqualTypeOf<{
      projectId: ProjectId
      sessionKey: SessionKey
    }>()
    expectTypeOf<CanonicalSessionAddressScopeV1>().toEqualTypeOf<{
      projectId: ProjectId
      sessionKey: SessionKey
      sessionMode: SessionMode
    }>()
  })

  it('keeps lookup read-only and explicitly distinguishes mismatch from absence', () => {
    expectTypeOf<SessionScopeLookupV1['lookup']>().returns.resolves.toEqualTypeOf<SessionScopeLookupResultV1>()

    const resultKinds: SessionScopeLookupResultV1['kind'][] = [
      'FOUND',
      'NOT_FOUND',
      'PROJECT_MISMATCH',
    ]
    expect(resultKinds).toEqual(['FOUND', 'NOT_FOUND', 'PROJECT_MISMATCH'])
  })

  it('does not expose main-process filesystem fields', () => {
    const source = readFileSync(resolve('packages/shared/xiaogui-session-scope.ts'), 'utf8')
    for (const forbidden of ['rootPath', 'sessionFile', 'sandboxPath']) {
      expect(source).not.toContain(forbidden)
    }
  })
})
