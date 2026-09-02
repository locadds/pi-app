import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import type { AttemptCheckpointabilityPort } from './checkpoint-module'
import { checkpointWorkspaceBindingDigestV1 } from './attempt-checkpointability-port'
import { SqliteAttemptCheckpointWorkspaceAuthorityV1 } from './attempt-checkpoint-workspace-authority'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`

describe('SqliteAttemptCheckpointWorkspaceAuthorityV1', () => {
  it('returns the private root only after the authoritative binding digest matches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaogui-checkpoint-workspace-authority-'))
    roots.push(root)
    const dbPath = join(root, 'attempt-workspaces.sqlite')
    const privateRoot = join(root, 'managed', 'attempt_1')
    const receipt = {
      workspace_receipt_id: 'workspace_receipt_1',
      attempt_id: 'attempt_1',
      status: 'PREPARED',
      receipt_digest: sha('receipt'),
    }
    const workspace = {
      attemptWorktreeId: 'worktree_1',
      worktreeRootDigest: sha('worktree-root'),
      baseRevisionDigest: sha('base'),
      targetProjectRootDigest: sha('project-root'),
      writePolicy: 'ATTEMPT_WORKTREE_ONLY' as const,
    }
    const bindingDigest = checkpointWorkspaceBindingDigestV1('attempt_1', receipt, workspace, 'READY')
    const db = new DatabaseSync(dbPath)
    db.exec('create table attempt_workspace_prepared (attempt_id text primary key, result_json text not null)')
    db.prepare('insert into attempt_workspace_prepared (attempt_id, result_json) values (?, ?)').run(
      'attempt_1',
      JSON.stringify({
        receipt: {
          status: 'PREPARED',
          workspaceReceiptId: receipt.workspace_receipt_id,
          receiptDigest: receipt.receipt_digest,
          attemptId: 'attempt_1',
        },
        workspace,
        handle: {
          attemptId: 'attempt_1',
          attemptWorktreeId: workspace.attemptWorktreeId,
          rootPath: privateRoot,
          manifestDigest: sha('manifest'),
          manifestVersion: 1,
        },
        manifest: { attemptId: 'attempt_1', manifestDigest: sha('manifest') },
      }),
    )
    db.close()
    const attempts: AttemptCheckpointabilityPort = {
      inspect: async () => ({
        attemptId: 'attempt_1',
        sessionId: 'pi_session_1',
        worktreeBindingDigest: bindingDigest,
        state: 'IDLE',
        authorityStatus: 'READY',
      }),
      markOutcomeUnknown: async () => undefined,
    }
    const authority = new SqliteAttemptCheckpointWorkspaceAuthorityV1({ workspaceDbPath: dbPath, attempts })

    await expect(authority.inspect('attempt_1')).resolves.toEqual({
      attemptId: 'attempt_1',
      state: 'IDLE',
      worktreeBindingDigest: bindingDigest,
      worktreeRoot: privateRoot,
    })
    authority.close()
  })

  it('fails closed when the workspace digest does not match the TaskHub binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaogui-checkpoint-workspace-authority-'))
    roots.push(root)
    const dbPath = join(root, 'attempt-workspaces.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec('create table attempt_workspace_prepared (attempt_id text primary key, result_json text not null)')
    db.prepare('insert into attempt_workspace_prepared (attempt_id, result_json) values (?, ?)').run(
      'attempt_1',
      JSON.stringify({
        receipt: { status: 'PREPARED', workspaceReceiptId: 'receipt_1', receiptDigest: sha('receipt'), attemptId: 'attempt_1' },
        workspace: {
          attemptWorktreeId: 'worktree_1',
          worktreeRootDigest: sha('root'),
          baseRevisionDigest: sha('base'),
          targetProjectRootDigest: sha('project'),
          writePolicy: 'ATTEMPT_WORKTREE_ONLY',
        },
        handle: {
          attemptId: 'attempt_1', attemptWorktreeId: 'worktree_1', rootPath: join(root, 'managed', 'attempt_1'),
          manifestDigest: sha('manifest'), manifestVersion: 1,
        },
        manifest: { attemptId: 'attempt_1', manifestDigest: sha('manifest') },
      }),
    )
    db.close()
    const authority = new SqliteAttemptCheckpointWorkspaceAuthorityV1({
      workspaceDbPath: dbPath,
      attempts: {
        inspect: async () => ({
          attemptId: 'attempt_1', sessionId: 'pi_session_1',
          worktreeBindingDigest: sha('different'), state: 'IDLE',
          authorityStatus: 'READY',
        }),
        markOutcomeUnknown: async () => undefined,
      },
    })

    await expect(authority.inspect('attempt_1')).resolves.toBeUndefined()
    authority.close()
  })
})
