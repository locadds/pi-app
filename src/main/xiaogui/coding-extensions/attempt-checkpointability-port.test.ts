import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HubSystemCommandRequestM2BV1,
  HubSystemOutcomeM2BV1,
  PerformReceiptV1,
} from '@shared/xiaogui-collaboration-hub'
import {
  SqliteAttemptCheckpointabilityPortV1,
  type AttemptCheckpointOutcomeAuthorityV1,
} from './attempt-checkpointability-port'

const roots: string[] = []
const ports: SqliteAttemptCheckpointabilityPortV1[] = []

afterEach(() => {
  for (const port of ports.splice(0)) {
    try {
      port.close()
    } catch {
      // A test may already have closed its port.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function checkpointabilityPort(
  options: ConstructorParameters<typeof SqliteAttemptCheckpointabilityPortV1>[0],
): SqliteAttemptCheckpointabilityPortV1 {
  const port = new SqliteAttemptCheckpointabilityPortV1(options)
  ports.push(port)
  return port
}

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-checkpointability-'))
  roots.push(root)
  return join(root, 'hub.sqlite')
}

function sha(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function seed(input: {
  path: string
  workspacePath?: string
  status?: string
  includePlan?: boolean
  includePiSession?: boolean
  includeWorkspace?: boolean
  runtimeSessionId?: string | null
}) {
  const db = new DatabaseSync(input.path)
  db.exec(`
    create table attempts (
      attempt_id text primary key,
      project_id text not null,
      session_key text not null,
      flow_id text not null,
      task_run_id text not null,
      status text not null,
      workspace_receipt_id text,
      runtime_session_id text
    );
    create table workspace_receipts (
      workspace_receipt_id text primary key,
      attempt_id text not null,
      status text not null,
      receipt_digest text not null
    );
    create table attempt_workspace_prepared (
      attempt_id text primary key,
      request_json text not null,
      result_json text not null
    );
    create table xiaogui_coding_attempt_plan_v1 (
      attempt_id text primary key,
      project_id text not null,
      session_key text not null
    );
    create table xiaogui_coding_pi_session_binding_v1 (
      attempt_id text primary key,
      session_id text not null,
      session_file text not null
    );
  `)
  const workspaceDb = input.workspacePath && input.workspacePath !== input.path
    ? new DatabaseSync(input.workspacePath)
    : db
  if (workspaceDb !== db) {
    workspaceDb.exec(`
      create table attempt_workspace_prepared (
        attempt_id text primary key,
        request_json text not null,
        result_json text not null
      );
    `)
  }
  const includeWorkspace = input.includeWorkspace ?? true
  db.prepare(`
    insert into attempts
      (attempt_id, project_id, session_key, flow_id, task_run_id, status,
       workspace_receipt_id, runtime_session_id)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'attempt_1',
    'project_1',
    'session_scope_1',
    'flow_1',
    'task_1',
    input.status ?? 'READY',
    includeWorkspace ? 'workspace_receipt_1' : null,
    input.runtimeSessionId ?? null,
  )
  if (input.includePlan ?? true) {
    db.prepare('insert into xiaogui_coding_attempt_plan_v1 (attempt_id, project_id, session_key) values (?, ?, ?)')
      .run('attempt_1', 'project_1', 'session_scope_1')
  }
  if (input.includePiSession ?? true) {
    db.prepare('insert into xiaogui_coding_pi_session_binding_v1 (attempt_id, session_id, session_file) values (?, ?, ?)')
      .run('attempt_1', 'pi_session_1', 'D:\\private\\sessions\\pi_session_1.jsonl')
  }
  if (includeWorkspace) {
    const receiptBinding = {
      compositionAttemptId: 'composition_1',
      attemptId: 'attempt_1',
      requestDigest: sha('request'),
      baselineBindingDigest: sha('baseline-binding'),
      compositionDigest: sha('composition'),
    }
    const workspace = {
      attemptWorktreeId: 'worktree_1',
      worktreeRootDigest: sha('private-worktree-root'),
      baseRevisionDigest: sha('base-revision'),
      targetProjectRootDigest: sha('private-project-root'),
      writePolicy: 'ATTEMPT_WORKTREE_ONLY',
    }
    const receiptDigest = sha('prepared-receipt')
    const result = {
      receipt: {
        status: 'PREPARED',
        workspaceReceiptId: 'workspace_receipt_1',
        receiptDigest,
        ...receiptBinding,
      },
      workspace,
      handle: {
        attemptId: 'attempt_1',
        attemptWorktreeId: 'worktree_1',
        rootPath: 'D:\\private\\managed-worktrees\\attempt_1',
        manifestDigest: sha('manifest'),
        manifestVersion: 1,
      },
      manifest: {
        attemptId: 'attempt_1',
        version: 1,
        grants: [],
        manifestDigest: sha('manifest'),
      },
      allowedRelativePaths: [],
    }
    db.prepare('insert into workspace_receipts (workspace_receipt_id, attempt_id, status, receipt_digest) values (?, ?, ?, ?)')
      .run('workspace_receipt_1', 'attempt_1', 'PREPARED', receiptDigest)
    workspaceDb.prepare('insert into attempt_workspace_prepared (attempt_id, request_json, result_json) values (?, ?, ?)')
      .run('attempt_1', JSON.stringify({ attemptId: 'attempt_1' }), JSON.stringify(result))
  }
  if (workspaceDb !== db) workspaceDb.close()
  db.close()
}

function authority(
  path: string,
  outcome: 'SUCCEED' | 'FAIL' = 'SUCCEED',
): AttemptCheckpointOutcomeAuthorityV1 & { executeSystem: ReturnType<typeof vi.fn> } {
  const executeSystem = vi.fn(async (
    request: HubSystemCommandRequestM2BV1,
  ): Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>> => {
    if (request.intent.type !== 'system.agent.outcome.record') {
      throw new Error('UNEXPECTED_TEST_INTENT')
    }
    if (outcome === 'FAIL') {
      return {
        ok: false,
        error: { code: 'ILLEGAL_TRANSITION', messageKey: 'test', traceId: 'trace_1' },
      }
    }
    const db = new DatabaseSync(path)
    db.prepare("update attempts set status = 'OUTCOME_UNKNOWN' where attempt_id = ?").run(request.intent.attemptId)
    db.close()
    return {
      ok: true,
      value: {
        requestId: request.requestId,
        intentType: request.intent.type,
        sessionVersion: 2,
        attemptId: request.intent.attemptId,
      },
    }
  })
  return { executeSystem }
}

describe('SqliteAttemptCheckpointabilityPortV1', () => {
  it('returns IDLE only for a READY Attempt with matching plan, Pi session, and prepared worktree bindings', async () => {
    const path = dbPath()
    seed({ path })
    const port = checkpointabilityPort({ dbPath: path, authority: authority(path) })

    const binding = await port.inspect('attempt_1')

    expect(binding).toEqual({
      attemptId: 'attempt_1',
      sessionId: 'pi_session_1',
      worktreeBindingDigest: 'sha256:145212180420a37db2334b83fca3d09aa08f504cda64d59625bc4fd4ff5e3436',
      state: 'IDLE',
      authorityStatus: 'READY',
    })
    expect(JSON.stringify(binding)).not.toContain('private')
  })

  it('does not invent a three-way binding when the production Pi session binding is absent', async () => {
    const path = dbPath()
    seed({ path, includePiSession: false })
    const port = checkpointabilityPort({ dbPath: path, authority: authority(path) })

    await expect(port.inspect('attempt_1')).resolves.toBeNull()
  })

  it('reads the prepared worktree only from the dedicated production workspace registry', async () => {
    const path = dbPath()
    const workspacePath = join(join(path, '..'), 'attempt-workspaces.sqlite')
    seed({ path, workspacePath })
    const port = checkpointabilityPort({
      dbPath: path,
      workspaceDbPath: workspacePath,
      authority: authority(path),
    })

    await expect(port.inspect('attempt_1')).resolves.toMatchObject({
      attemptId: 'attempt_1',
      state: 'IDLE',
    })
  })

  it.each([
    ['STARTING', 'BUSY'],
    ['RUNNING', 'BUSY'],
    ['VERIFYING', 'BUSY'],
    ['OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN'],
    ['SUCCEEDED', 'IDLE'],
    ['unexpected-state', 'OUTCOME_UNKNOWN'],
  ] as const)('maps authoritative Attempt status %s to %s without weakening the binding', async (status, state) => {
    const path = dbPath()
    seed({ path, status, runtimeSessionId: status === 'RUNNING' ? 'runtime_1' : null })
    const port = checkpointabilityPort({ dbPath: path, authority: authority(path) })

    await expect(port.inspect('attempt_1')).resolves.toMatchObject({
      attemptId: 'attempt_1',
      sessionId: 'pi_session_1',
      state,
    })
  })

  it('marks a RUNNING Attempt OUTCOME_UNKNOWN only through the authoritative TaskHub transition and verifies the result', async () => {
    const path = dbPath()
    seed({ path, status: 'RUNNING', runtimeSessionId: 'runtime_1' })
    const app = authority(path)
    const port = checkpointabilityPort({
      dbPath: path,
      authority: app,
      idFactory: () => 'checkpoint-unknown-1',
    })

    await expect(port.markOutcomeUnknown({
      attemptId: 'attempt_1',
      reasonCode: 'CHECKPOINT_ROLLBACK_INCOMPLETE',
    })).resolves.toBeUndefined()
    expect(app.executeSystem).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: 'm2b.v1',
      address: { projectId: 'project_1', sessionKey: 'session_scope_1' },
      intent: expect.objectContaining({
        type: 'system.agent.outcome.record',
        attemptId: 'attempt_1',
        runtimeSessionId: 'runtime_1',
        outcome: 'OUTCOME_UNKNOWN',
      }),
    }))
    await expect(port.inspect('attempt_1')).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN' })
  })

  it('invalidates a verified SUCCEEDED Attempt through the dedicated TaskHub authority', async () => {
    const path = dbPath()
    seed({ path, status: 'SUCCEEDED', runtimeSessionId: 'runtime_1' })
    const app = authority(path)
    const markVerifiedCheckpointOutcomeUnknown = vi.fn(async (input: {
      attemptId: string
    }) => {
      const db = new DatabaseSync(path)
      db.prepare("update attempts set status = 'OUTCOME_UNKNOWN' where attempt_id = ?").run(input.attemptId)
      db.close()
    })
    const port = checkpointabilityPort({
      dbPath: path,
      authority: { ...app, markVerifiedCheckpointOutcomeUnknown },
    })

    await expect(port.markOutcomeUnknown({
      attemptId: 'attempt_1',
      reasonCode: 'CHECKPOINT_ROLLBACK_INCOMPLETE',
    })).resolves.toBeUndefined()
    expect(markVerifiedCheckpointOutcomeUnknown).toHaveBeenCalledWith(expect.objectContaining({
      address: { projectId: 'project_1', sessionKey: 'session_scope_1' },
      flowId: 'flow_1',
      taskRunId: 'task_1',
      attemptId: 'attempt_1',
      reasonCode: 'CHECKPOINT_ROLLBACK_INCOMPLETE',
      receiptDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    }))
    expect(app.executeSystem).not.toHaveBeenCalled()
  })

  it('fails safely when READY has no authoritative OUTCOME_UNKNOWN transition', async () => {
    const path = dbPath()
    seed({ path, status: 'READY' })
    const app = authority(path)
    const port = checkpointabilityPort({ dbPath: path, authority: app })

    await expect(port.markOutcomeUnknown({
      attemptId: 'attempt_1',
      reasonCode: 'CHECKPOINT_ROLLBACK_INCOMPLETE',
    })).rejects.toThrow('CHECKPOINT_OUTCOME_UNKNOWN_TRANSITION_UNAVAILABLE')
    expect(app.executeSystem).not.toHaveBeenCalled()
  })
})
