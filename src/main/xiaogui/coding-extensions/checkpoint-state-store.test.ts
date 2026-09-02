import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { XIAOGUI_CODING_CHECKPOINT_SESSION_IMPACT_V1 } from '@shared/xiaogui-coding-checkpoint-control'

import type { CodingCheckpointPersistedStateV1 } from './checkpoint-module'
import {
  CodingCheckpointStateStoreError,
  CodingCheckpointStateStoreV1,
} from './checkpoint-state-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })))
})

async function stateDbPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-checkpoint-state-'))
  roots.push(root)
  return join(root, 'checkpoint-state.sqlite')
}

const digest = (character: string) => `sha256:${character.repeat(64)}`

function stateFixture(): CodingCheckpointPersistedStateV1 {
  return {
    schemaVersion: 1,
    checkpoints: [{
      schemaVersion: 1,
      checkpoint: {
        schemaVersion: 1,
        checkpointId: 'checkpoint_1',
        attemptId: 'xhba_attempt_1',
        sessionCheckpointDigest: digest('1'),
        worktreeBaselineDigest: digest('3'),
        changeSummaryDigest: digest('4'),
        status: 'AVAILABLE',
      },
      binding: {
        attemptId: 'xhba_attempt_1',
        sessionId: 'pi_session_1',
        worktreeBindingDigest: digest('a'),
        state: 'IDLE',
        authorityStatus: 'READY',
      },
      sessionTarget: {
        attemptId: 'xhba_attempt_1',
        sessionId: 'pi_session_1',
        snapshotRef: `xgscp_${'b'.repeat(64)}`,
        snapshotDigest: digest('1'),
      },
      workspaceTarget: {
        attemptId: 'xhba_attempt_1',
        worktreeBindingDigest: digest('a'),
        snapshotRef: `workspace-ref:${digest('2')}`,
        snapshotDigest: digest('2'),
        baselineDigest: digest('3'),
        changeSummaryDigest: digest('4'),
      },
    }],
    previews: [{
      schemaVersion: 1,
      preview: {
        schemaVersion: 1,
        previewId: 'preview_1',
        checkpointId: 'checkpoint_1',
        attemptId: 'xhba_attempt_1',
        changedRelativePaths: ['src/example.ts'],
        changeCount: 1,
        truncated: false,
        sessionImpact: XIAOGUI_CODING_CHECKPOINT_SESSION_IMPACT_V1,
        previewDigest: digest('5'),
        expiresAt: 2_000,
      },
      binding: {
        attemptId: 'xhba_attempt_1',
        sessionId: 'pi_session_1',
        worktreeBindingDigest: digest('a'),
        state: 'IDLE',
        authorityStatus: 'READY',
      },
      currentSessionDigest: digest('6'),
      currentWorkspaceDigest: digest('7'),
      currentBaselineDigest: digest('8'),
      currentChangeSummaryDigest: digest('9'),
      workspacePreviewChangeSummaryDigest: digest('f'),
      changedRelativePathsDigest: digest('0'),
    }],
    sagas: [{
      schemaVersion: 1,
      restoreId: 'restore_1',
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
      binding: {
        attemptId: 'xhba_attempt_1',
        sessionId: 'pi_session_1',
        worktreeBindingDigest: digest('a'),
        state: 'IDLE',
        authorityStatus: 'READY',
      },
      phase: 'ROLLBACK_CAPTURED',
      rollbackSession: {
        attemptId: 'xhba_attempt_1',
        sessionId: 'pi_session_1',
        snapshotRef: `session-ref:${digest('b')}`,
        snapshotDigest: digest('b'),
      },
      rollbackWorkspace: {
        attemptId: 'xhba_attempt_1',
        worktreeBindingDigest: digest('a'),
        snapshotRef: `workspace-ref:${digest('c')}`,
        snapshotDigest: digest('c'),
        baselineDigest: digest('d'),
        changeSummaryDigest: digest('e'),
      },
      updatedAt: 1_000,
    }],
  }
}

describe('CodingCheckpointStateStoreV1', () => {
  it('persists the complete private checkpoint state and restores it after restart', async () => {
    const dbPath = await stateDbPath()
    const expected = stateFixture()
    const first = new CodingCheckpointStateStoreV1({
      dbPath,
      now: () => '2026-08-31T08:00:00.000Z',
    })

    expect(first.load()).toBeUndefined()
    first.save(expected)
    first.close()

    const reopened = new CodingCheckpointStateStoreV1({ dbPath })
    expect(reopened.load()).toEqual(expected)
    reopened.close()
  })

  it('atomically replaces the singleton and keeps the last valid state after a rejected write', async () => {
    const dbPath = await stateDbPath()
    const store = new CodingCheckpointStateStoreV1({ dbPath })
    const first = stateFixture()
    store.save(first)

    const second: CodingCheckpointPersistedStateV1 = {
      ...structuredClone(first),
      checkpoints: [{
        ...structuredClone(first.checkpoints[0]!),
        checkpoint: {
          ...structuredClone(first.checkpoints[0]!.checkpoint),
          status: 'RESTORED',
        },
      }],
    }
    store.save(second)
    expect(store.load()).toEqual(second)

    const invalid = structuredClone(second) as unknown as Record<string, unknown>
    ;(invalid.checkpoints as Array<Record<string, unknown>>)[0]!.sessionFile = 'D:\\private\\session.jsonl'
    ;((invalid.checkpoints as Array<Record<string, unknown>>)[0]!.sessionTarget as Record<string, unknown>).snapshotRef =
      'D:\\private\\snapshot.jsonl'
    expect(() => store.save(invalid as unknown as CodingCheckpointPersistedStateV1)).toThrow(
      new CodingCheckpointStateStoreError('CHECKPOINT_STATE_CORRUPT'),
    )
    expect(store.load()).toEqual(second)
    store.close()
  })

  it('fails closed with a stable redacted error when the stored JSON or digest is corrupted', async () => {
    const dbPath = await stateDbPath()
    const privateRef = `xgscp_${'f'.repeat(64)}`
    const store = new CodingCheckpointStateStoreV1({ dbPath })
    const state = stateFixture()
    ;(state.checkpoints[0]!.sessionTarget as { snapshotRef: string }).snapshotRef = privateRef
    store.save(state)
    store.close()

    const database = new DatabaseSync(dbPath)
    database.prepare(`
      update xiaogui_coding_checkpoint_state_v1
      set state_json = ?
      where singleton_id = 1
    `).run(`{"schemaVersion":1,"private":"${privateRef}`)
    database.close()

    const reopened = new CodingCheckpointStateStoreV1({ dbPath })
    let thrown: unknown
    try {
      reopened.load()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toEqual(new CodingCheckpointStateStoreError('CHECKPOINT_STATE_CORRUPT'))
    expect(String((thrown as Error).message)).not.toContain(privateRef)
    expect(String((thrown as Error).message)).not.toContain(dbPath)
    reopened.close()
  })

  it('fails closed on an unsupported stored schema version', async () => {
    const dbPath = await stateDbPath()
    const store = new CodingCheckpointStateStoreV1({ dbPath })
    store.save(stateFixture())
    store.close()

    const database = new DatabaseSync(dbPath)
    database.prepare(`
      update xiaogui_coding_checkpoint_state_v1
      set schema_version = 2
      where singleton_id = 1
    `).run()
    database.close()

    const reopened = new CodingCheckpointStateStoreV1({ dbPath })
    expect(() => reopened.load()).toThrow(
      new CodingCheckpointStateStoreError('CHECKPOINT_STATE_VERSION_UNSUPPORTED'),
    )
    reopened.close()
  })

  it('supports idempotent close and refuses later reads and writes without leaking the database path', async () => {
    const dbPath = await stateDbPath()
    const store = new CodingCheckpointStateStoreV1({ dbPath })
    store.close()
    expect(() => store.close()).not.toThrow()
    expect(() => store.load()).toThrow(new CodingCheckpointStateStoreError('CHECKPOINT_STATE_STORE_CLOSED'))
    expect(() => store.save(stateFixture())).toThrow(new CodingCheckpointStateStoreError('CHECKPOINT_STATE_STORE_CLOSED'))
    try {
      store.load()
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(dbPath)
    }
  })
})
