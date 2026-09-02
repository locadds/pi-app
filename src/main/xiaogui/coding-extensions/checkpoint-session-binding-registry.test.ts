import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import {
  CheckpointSessionBindingRegistryErrorV1,
  CheckpointSessionBindingRegistryV1,
} from './checkpoint-session-binding-registry'

const roots: string[] = []
const registries: CheckpointSessionBindingRegistryV1[] = []

const ADDRESS_ONE = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

const ADDRESS_TWO = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'3'.repeat(64)}`,
} as SessionAddressV1

afterEach(() => {
  for (const registry of registries.splice(0)) registry.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-checkpoint-session-registry-'))
  roots.push(root)
  return join(root, 'private.sqlite')
}

function registry(dbPath: string): CheckpointSessionBindingRegistryV1 {
  const value = new CheckpointSessionBindingRegistryV1({
    dbPath,
    now: () => '2026-08-31T12:00:00.000Z',
  })
  registries.push(value)
  return value
}

function record(
  value: CheckpointSessionBindingRegistryV1,
  address = ADDRESS_ONE,
  sourceSessionId = 'pi-session-1',
  sessionFile = 'D:\\private\\sessions\\one.jsonl',
): void {
  value.recordAddress({ address, sourceSessionId, sessionFile })
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof CheckpointSessionBindingRegistryErrorV1 ? error.code : undefined
  }
}

describe('CheckpointSessionBindingRegistryV1', () => {
  it('persists the private address and restores an idempotent Attempt binding after restart', () => {
    const dbPath = temporaryDatabase()
    const first = registry(dbPath)
    record(first)
    record(first, ADDRESS_ONE, 'pi-session-1', 'd:/PRIVATE/sessions/one.jsonl')

    expect(first.bindAttempt('attempt-1', ADDRESS_ONE)).toEqual({
      attemptId: 'attempt-1',
      address: ADDRESS_ONE,
      sourceSessionId: 'pi-session-1',
      sessionFile: 'D:\\private\\sessions\\one.jsonl',
    })
    expect(first.readAddressBinding(ADDRESS_ONE)).toEqual({
      address: ADDRESS_ONE,
      sourceSessionId: 'pi-session-1',
      sessionFile: 'D:\\private\\sessions\\one.jsonl',
    })
    expect(first.bindAttempt('attempt-1', ADDRESS_ONE)).toEqual(
      first.readAttemptBinding('attempt-1'),
    )
    first.close()

    const restored = registry(dbPath)
    expect(restored.readAddressBinding(ADDRESS_ONE)).toEqual({
      address: ADDRESS_ONE,
      sourceSessionId: 'pi-session-1',
      sessionFile: 'D:\\private\\sessions\\one.jsonl',
    })
    expect(restored.readAttemptBinding('attempt-1')).toEqual({
      attemptId: 'attempt-1',
      address: ADDRESS_ONE,
      sourceSessionId: 'pi-session-1',
      sessionFile: 'D:\\private\\sessions\\one.jsonl',
    })
  })

  it('rejects changing the private Pi session behind an existing opaque address', () => {
    const value = registry(temporaryDatabase())
    record(value)

    expect(errorCode(() => record(
      value,
      ADDRESS_ONE,
      'pi-session-2',
      'D:\\private\\sessions\\two.jsonl',
    ))).toBe('CHECKPOINT_SESSION_REGISTRY_ADDRESS_CONFLICT')
    expect(value.readAttemptBinding('attempt-1')).toBeNull()
  })

  it('rejects registering one private session or file under a second address', () => {
    const value = registry(temporaryDatabase())
    record(value)

    expect(errorCode(() => record(
      value,
      ADDRESS_TWO,
      'pi-session-1',
      'D:\\private\\sessions\\two.jsonl',
    ))).toBe('CHECKPOINT_SESSION_REGISTRY_ADDRESS_CONFLICT')
    expect(errorCode(() => record(
      value,
      ADDRESS_TWO,
      'pi-session-2',
      'd:/PRIVATE/sessions/one.jsonl',
    ))).toBe('CHECKPOINT_SESSION_REGISTRY_ADDRESS_CONFLICT')
  })

  it('rejects rebinding one Attempt across addresses while allowing sequential Attempts in one session', () => {
    const value = registry(temporaryDatabase())
    record(value)
    record(value, ADDRESS_TWO, 'pi-session-2', 'D:\\private\\sessions\\two.jsonl')
    value.bindAttempt('attempt-1', ADDRESS_ONE)

    expect(errorCode(() => value.bindAttempt('attempt-1', ADDRESS_TWO)))
      .toBe('CHECKPOINT_SESSION_REGISTRY_ATTEMPT_CONFLICT')
    expect(value.bindAttempt('attempt-2', ADDRESS_ONE)).toMatchObject({
      attemptId: 'attempt-2',
      address: ADDRESS_ONE,
      sourceSessionId: 'pi-session-1',
    })
    expect(value.readAttemptBinding('attempt-1')?.address).toEqual(ADDRESS_ONE)
    expect(value.readAttemptBinding('attempt-2')?.address).toEqual(ADDRESS_ONE)
  })

  it('uses fixed redacted errors for missing addresses and invalid private paths', () => {
    const value = registry(temporaryDatabase())
    const secret = 'relative/private/session.jsonl'

    expect(errorCode(() => value.bindAttempt('attempt-1', ADDRESS_ONE)))
      .toBe('CHECKPOINT_SESSION_REGISTRY_ADDRESS_NOT_FOUND')
    expect(value.readAddressBinding(ADDRESS_ONE)).toBeNull()
    let error: unknown
    try {
      record(value, ADDRESS_ONE, 'pi-session-1', secret)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(CheckpointSessionBindingRegistryErrorV1)
    expect(String(error)).toBe(
      'CheckpointSessionBindingRegistryErrorV1: CHECKPOINT_SESSION_REGISTRY_SESSION_FILE_INVALID',
    )
    expect(String(error)).not.toContain(secret)
  })

  it('redacts a private database path when opening the registry fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaogui-checkpoint-session-registry-open-'))
    roots.push(root)
    const privatePath = join(root, 'missing', 'private.sqlite')
    let error: unknown

    try {
      registry(privatePath)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(CheckpointSessionBindingRegistryErrorV1)
    expect(String(error)).toContain('CHECKPOINT_SESSION_REGISTRY_OPEN_FAILED')
    expect(String(error)).not.toContain(privatePath)
  })
})
