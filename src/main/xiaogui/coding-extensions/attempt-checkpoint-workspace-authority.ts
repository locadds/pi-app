import { isAbsolute, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { RuntimeWorkspaceBindingV1 } from '@shared/xiaogui-agent-runtime'

import type {
  AttemptCheckpointWorkspaceAuthorityV1,
  AttemptCheckpointWorkspaceBindingV1,
} from './attempt-checkpoint-workspace-port'
import type { AttemptCheckpointabilityPort } from './checkpoint-module'
import { checkpointWorkspaceBindingDigestV1 } from './attempt-checkpointability-port'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

interface PreparedRowV1 {
  readonly result_json: string
}

interface PreparedResultV1 {
  readonly receipt: {
    readonly status: 'PREPARED'
    readonly workspaceReceiptId: string
    readonly receiptDigest: string
    readonly attemptId: string
  }
  readonly workspace: RuntimeWorkspaceBindingV1
  readonly handle: {
    readonly attemptId: string
    readonly attemptWorktreeId: string
    readonly rootPath: string
    readonly manifestDigest: string
    readonly manifestVersion: number
  }
  readonly manifest: {
    readonly attemptId: string
    readonly manifestDigest: string
  }
}

/**
 * Main-only resolver for the private Attempt worktree root. The TaskHub
 * checkpointability port proves the cross-database binding first; this class
 * only releases the matching root to the private Git adapter.
 */
export class SqliteAttemptCheckpointWorkspaceAuthorityV1
implements AttemptCheckpointWorkspaceAuthorityV1 {
  private readonly db: DatabaseSync

  constructor(options: {
    readonly workspaceDbPath: string
    readonly attempts: AttemptCheckpointabilityPort
  }) {
    if (!options?.workspaceDbPath) throw new Error('CHECKPOINT_WORKSPACE_DB_PATH_REQUIRED')
    this.db = new DatabaseSync(options.workspaceDbPath)
    this.db.exec('pragma busy_timeout = 5000')
    this.attempts = options.attempts
  }

  private readonly attempts: AttemptCheckpointabilityPort

  async inspect(attemptId: string): Promise<AttemptCheckpointWorkspaceBindingV1 | undefined> {
    if (!SAFE_ID_PATTERN.test(attemptId)) return undefined
    const binding = await this.attempts.inspect(attemptId)
    if (!binding) return undefined
    const prepared = this.readPrepared(attemptId)
    if (!prepared) return undefined
    const worktreeBindingDigest = checkpointWorkspaceBindingDigestV1(
      attemptId,
      {
        workspace_receipt_id: prepared.receipt.workspaceReceiptId,
        attempt_id: attemptId,
        status: prepared.receipt.status,
        receipt_digest: prepared.receipt.receiptDigest,
      },
      prepared.workspace,
      binding.authorityStatus,
    )
    if (worktreeBindingDigest !== binding.worktreeBindingDigest) return undefined
    return {
      attemptId,
      state: binding.state,
      worktreeBindingDigest,
      worktreeRoot: prepared.handle.rootPath,
    }
  }

  close(): void {
    this.db.close()
  }

  private readPrepared(attemptId: string): PreparedResultV1 | null {
    try {
      const row = this.db.prepare(`
        select result_json from attempt_workspace_prepared where attempt_id = ? limit 1
      `).get(attemptId) as unknown as PreparedRowV1 | undefined
      if (!row) return null
      const value = JSON.parse(row.result_json) as PreparedResultV1
      if (
        value?.receipt?.status !== 'PREPARED'
        || value.receipt.attemptId !== attemptId
        || value.handle?.attemptId !== attemptId
        || value.manifest?.attemptId !== attemptId
        || value.workspace?.writePolicy !== 'ATTEMPT_WORKTREE_ONLY'
        || value.handle.attemptWorktreeId !== value.workspace.attemptWorktreeId
        || value.handle.manifestDigest !== value.manifest.manifestDigest
        || !Number.isSafeInteger(value.handle.manifestVersion)
        || value.handle.manifestVersion < 1
        || !privateAbsolutePath(value.handle.rootPath)
        || !SAFE_ID_PATTERN.test(value.receipt.workspaceReceiptId)
        || !SHA256_PATTERN.test(value.receipt.receiptDigest)
        || !SHA256_PATTERN.test(value.handle.manifestDigest)
        || !SHA256_PATTERN.test(value.workspace.worktreeRootDigest)
        || !SHA256_PATTERN.test(value.workspace.baseRevisionDigest)
        || !SHA256_PATTERN.test(value.workspace.targetProjectRootDigest)
      ) return null
      return value
    } catch {
      return null
    }
  }
}

function privateAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value) && (isAbsolute(value) || win32.isAbsolute(value))
}
