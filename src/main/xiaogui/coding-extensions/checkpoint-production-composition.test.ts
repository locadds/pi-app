import { describe, expect, it, vi } from 'vitest'

import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import type {
  AttemptCheckpointBindingV1,
  AttemptCheckpointWorkspacePort,
  PiSessionCheckpointPort,
} from './checkpoint-module'
import type { CheckpointSessionAddressRecordV1 } from './checkpoint-session-binding-registry'
import {
  codingCheckpointProductionPathsV1,
  createCodingCheckpointProductionCompositionV1,
  type CodingCheckpointProductionHandlerRegistrationV1,
} from './checkpoint-production-composition'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

const DIGEST = (character: string): string => `sha256:${character.repeat(64)}`

function fixture(overrides: {
  readonly bindAttempt?: () => never
  readonly inScope?: boolean
} = {}) {
  const closeOrder: string[] = []
  const trustedSession: CheckpointSessionAddressRecordV1 = {
    address: ADDRESS,
    sourceSessionId: 'pi-session-1',
    sessionFile: 'D:\\private\\sessions\\one.jsonl',
  }
  const binding: AttemptCheckpointBindingV1 = {
    attemptId: 'attempt-1',
    sessionId: trustedSession.sourceSessionId,
    worktreeBindingDigest: DIGEST('a'),
    state: 'IDLE',
    authorityStatus: 'READY',
  }
  const registry = {
    recordAddress: vi.fn(),
    readAddressBinding: vi.fn(() => trustedSession),
    bindAttempt: vi.fn(() => {
      overrides.bindAttempt?.()
      return { attemptId: binding.attemptId, ...trustedSession }
    }),
    close: vi.fn(() => { closeOrder.push('registry') }),
  }
  const sessions = {
    bindAttempt: vi.fn(),
    inspect: vi.fn(async () => ({
      attemptId: binding.attemptId,
      sessionId: binding.sessionId,
      snapshotDigest: DIGEST('b'),
    })),
    capture: vi.fn(async () => ({
      attemptId: binding.attemptId,
      sessionId: binding.sessionId,
      snapshotRef: 'private-session-snapshot-1',
      snapshotDigest: DIGEST('b'),
    })),
    restore: vi.fn(),
    close: vi.fn(() => { closeOrder.push('sessions') }),
  } satisfies PiSessionCheckpointPort & {
    bindAttempt(input: { attemptId: string; sessionId: string; sessionFile: string }): void
    close(): void
  }
  const attempts = {
    inspect: vi.fn(async () => binding),
    markOutcomeUnknown: vi.fn(),
    close: vi.fn(() => { closeOrder.push('attempts') }),
  }
  const workspace = {
    inspect: vi.fn(async () => ({
      attemptId: binding.attemptId,
      worktreeBindingDigest: binding.worktreeBindingDigest,
      snapshotDigest: DIGEST('c'),
      baselineDigest: DIGEST('d'),
      changeSummaryDigest: DIGEST('e'),
    })),
    capture: vi.fn(async () => ({
      attemptId: binding.attemptId,
      worktreeBindingDigest: binding.worktreeBindingDigest,
      snapshotRef: 'private-workspace-snapshot-1',
      snapshotDigest: DIGEST('c'),
      baselineDigest: DIGEST('d'),
      changeSummaryDigest: DIGEST('e'),
    })),
    previewRestore: vi.fn(),
    restore: vi.fn(),
    close: vi.fn(() => { closeOrder.push('workspace') }),
  } satisfies AttemptCheckpointWorkspacePort & { close(): void }
  const stateStore = {
    load: vi.fn(() => undefined),
    save: vi.fn(),
    close: vi.fn(() => { closeOrder.push('state') }),
  }
  const scope = {
    isCodingSession: vi.fn(() => overrides.inScope ?? true),
    hasAttempt: vi.fn(() => overrides.inScope ?? true),
    close: vi.fn(() => { closeOrder.push('scope') }),
  }
  let registration: CodingCheckpointProductionHandlerRegistrationV1 | undefined
  const registerHandlers = vi.fn((input: CodingCheckpointProductionHandlerRegistrationV1) => {
    registration = input
  })
  const composition = createCodingCheckpointProductionCompositionV1({
    ports: { registry, sessions, attempts, workspace, stateStore, scope },
    registerHandlers,
  })

  return {
    attempts,
    closeOrder,
    composition,
    get registration() {
      return registration
    },
    registerHandlers,
    registry,
    sessions,
    stateStore,
    trustedSession,
    workspace,
  }
}

describe('Coding checkpoint production composition', () => {
  it('keeps the TaskHub authority and Attempt-workspace registry on their real separate paths', () => {
    const paths = codingCheckpointProductionPathsV1('D:\\xiaogui-user-data')

    expect(paths.hubDbPath).toBe('D:\\xiaogui-user-data\\xiaogui-task-hub-m2a.sqlite')
    expect(paths.workspaceRegistryDbPath)
      .toBe('D:\\xiaogui-user-data\\xiaogui\\task-hub\\attempt-workspaces.sqlite')
    expect(paths.workspaceRegistryDbPath).not.toBe(paths.hubDbPath)
    expect(paths.workspaceSnapshotRoot)
      .toBe('D:\\xiaogui-user-data\\xiaogui\\coding-checkpoints\\workspace-snapshots')
  })

  it('stays unavailable until recovery, binds only an in-scope trusted session, and persists captures', async () => {
    const test = fixture()
    test.composition.register()
    test.composition.register()

    expect(test.registerHandlers).toHaveBeenCalledTimes(1)
    expect(test.composition.status()).toBe('RECOVERING')
    await expect(test.registration!.checkpoint.capture({
      attemptId: 'attempt-1',
      checkpointId: 'checkpoint-before-recovery',
    })).rejects.toThrow('CHECKPOINT_RUNTIME_UNAVAILABLE')

    test.composition.recordTrustedSessionAddress(test.trustedSession)
    expect(test.registry.recordAddress).toHaveBeenCalledWith(test.trustedSession)
    expect(test.composition.readTrustedSessionAddress(ADDRESS)).toEqual(test.trustedSession)
    expect(await test.registration!.scope.isCodingSession(ADDRESS)).toBe(true)
    expect(await test.registration!.scope.hasAttempt(ADDRESS, 'attempt-1')).toBe(true)
    expect(test.registry.bindAttempt).toHaveBeenCalledWith('attempt-1', ADDRESS)
    expect(test.sessions.bindAttempt).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      sessionId: 'pi-session-1',
      sessionFile: 'D:\\private\\sessions\\one.jsonl',
    })

    await test.composition.initialize()
    expect(test.composition.status()).toBe('READY')
    await expect(test.registration!.checkpoint.capture({
      attemptId: 'attempt-1',
      checkpointId: 'checkpoint-1',
    })).resolves.toMatchObject({
      ok: true,
      checkpoint: { attemptId: 'attempt-1', checkpointId: 'checkpoint-1' },
    })
    expect(test.stateStore.save).toHaveBeenCalledTimes(1)
    const persisted = test.stateStore.save.mock.calls[0]![0]
    expect(JSON.stringify(persisted)).not.toContain(test.trustedSession.sessionFile)
  })

  it('fails the session scope closed when the Attempt binding cannot be proven', async () => {
    const test = fixture({
      bindAttempt: () => {
        throw new Error('D:\\private\\sessions\\must-not-leak.jsonl')
      },
    })
    test.composition.register()
    await test.composition.initialize()

    expect(await test.registration!.scope.hasAttempt(ADDRESS, 'attempt-1')).toBe(false)
    expect(test.sessions.bindAttempt).not.toHaveBeenCalled()
    expect(test.attempts.inspect).not.toHaveBeenCalled()
  })

  it('closes every owned private port once and rejects work after close', async () => {
    const test = fixture()
    test.composition.register()
    await test.composition.initialize()
    await test.composition.close()
    await test.composition.close()

    expect(test.composition.status()).toBe('CLOSED')
    expect(test.closeOrder).toEqual(['workspace', 'attempts', 'sessions', 'registry', 'scope', 'state'])
    expect(() => test.composition.recordTrustedSessionAddress(test.trustedSession))
      .toThrow('CHECKPOINT_RUNTIME_CLOSED')
    expect(() => test.composition.readTrustedSessionAddress(ADDRESS))
      .toThrow('CHECKPOINT_RUNTIME_CLOSED')
    await expect(test.registration!.checkpoint.capture({
      attemptId: 'attempt-1',
      checkpointId: 'checkpoint-after-close',
    })).rejects.toThrow('CHECKPOINT_RUNTIME_UNAVAILABLE')
  })
})
