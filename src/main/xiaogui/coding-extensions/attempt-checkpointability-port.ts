import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  HubSystemCommandRequestM2BV1,
  HubSystemOutcomeM2BV1,
  PerformReceiptV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import type { RuntimeWorkspaceBindingV1 } from '@shared/xiaogui-agent-runtime'
import type {
  AttemptCheckpointBindingV1,
  AttemptCheckpointabilityPort,
} from './checkpoint-module'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

interface AttemptRowV1 {
  readonly attempt_id: string
  readonly project_id: string
  readonly session_key: string
  readonly flow_id: string
  readonly task_run_id: string
  readonly status: string
  readonly workspace_receipt_id: string | null
  readonly runtime_session_id: string | null
}

interface PlanBindingRowV1 {
  readonly project_id: string
  readonly session_key: string
}

interface PiSessionBindingRowV1 {
  readonly session_id: string
  readonly session_file: string
}

export interface CheckpointWorkspaceReceiptBindingV1 {
  readonly workspace_receipt_id: string
  readonly attempt_id: string
  readonly status: string
  readonly receipt_digest: string
}

interface WorkspacePreparedRowV1 {
  readonly result_json: string
}

interface PreparedWorkspaceResultV1 {
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

export interface AttemptCheckpointOutcomeAuthorityV1 {
  executeSystem(
    request: HubSystemCommandRequestM2BV1,
  ): Promise<HubSystemOutcomeM2BV1<PerformReceiptV1>>
  markVerifiedCheckpointOutcomeUnknown?(input: {
    readonly address: HubAddressV1
    readonly flowId: FlowId
    readonly taskRunId: TaskRunId
    readonly attemptId: AttemptId
    readonly reasonCode: string
    readonly receiptDigest: string
  }): Promise<void>
}

export interface SqliteAttemptCheckpointabilityPortOptionsV1 {
  readonly dbPath: string
  /** TaskHub private attempt-workspace registry. Defaults to dbPath for tests/migrations. */
  readonly workspaceDbPath?: string
  readonly authority: AttemptCheckpointOutcomeAuthorityV1
  readonly idFactory?: () => string
}

/**
 * TaskHub authority Adapter for Coding checkpoints.
 *
 * A usable binding exists only when the authoritative Attempt, its TaskHub
 * plan address, the private Pi session binding, and the prepared Attempt
 * worktree all agree. Runtime Agent session ids are deliberately not treated
 * as Pi session ids.
 */
export class SqliteAttemptCheckpointabilityPortV1 implements AttemptCheckpointabilityPort {
  private readonly db: DatabaseSync
  private readonly workspaceDb: DatabaseSync
  private readonly ownsWorkspaceDb: boolean
  private readonly authority: AttemptCheckpointOutcomeAuthorityV1
  private readonly idFactory: () => string

  constructor(options: SqliteAttemptCheckpointabilityPortOptionsV1) {
    if (!options?.dbPath) throw new Error('CHECKPOINT_AUTHORITY_DB_PATH_REQUIRED')
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec('pragma busy_timeout = 5000')
    const workspaceDbPath = options.workspaceDbPath ?? options.dbPath
    this.ownsWorkspaceDb = workspaceDbPath !== options.dbPath
    this.workspaceDb = this.ownsWorkspaceDb ? new DatabaseSync(workspaceDbPath) : this.db
    this.workspaceDb.exec('pragma busy_timeout = 5000')
    this.authority = options.authority
    this.idFactory = options.idFactory ?? randomUUID
  }

  async inspect(attemptId: string): Promise<AttemptCheckpointBindingV1 | null> {
    assertSafeId(attemptId, 'CHECKPOINT_ATTEMPT_ID_INVALID')
    const joined = this.readCompleteBinding(attemptId)
    if (!joined) return null
    return {
      attemptId,
      sessionId: joined.pi.session_id,
      worktreeBindingDigest: checkpointWorkspaceBindingDigestV1(
        attemptId,
        joined.receipt,
        joined.prepared.workspace,
        checkpointAuthorityStatus(joined.attempt.status),
      ),
      state: checkpointState(joined.attempt.status),
      authorityStatus: checkpointAuthorityStatus(joined.attempt.status),
    }
  }

  async markOutcomeUnknown(input: { attemptId: string; reasonCode: string }): Promise<void> {
    assertSafeId(input.attemptId, 'CHECKPOINT_ATTEMPT_ID_INVALID')
    const reasonCode = canonicalReasonCode(input.reasonCode)
    const attempt = this.readAttempt(input.attemptId)
    if (!attempt) throw new Error('CHECKPOINT_ATTEMPT_NOT_FOUND')
    if (attempt.status === 'OUTCOME_UNKNOWN') return
    if (attempt.status === 'SUCCEEDED') {
      if (!this.authority.markVerifiedCheckpointOutcomeUnknown) {
        throw new Error('CHECKPOINT_OUTCOME_UNKNOWN_TRANSITION_UNAVAILABLE')
      }
      const receiptDigest = digestJson({
        role: 'coding-checkpoint-verified-outcome-unknown',
        attemptId: input.attemptId,
        taskRunId: attempt.task_run_id,
        reasonCode,
      })
      await this.authority.markVerifiedCheckpointOutcomeUnknown({
        address: {
          projectId: attempt.project_id as HubAddressV1['projectId'],
          sessionKey: attempt.session_key as HubAddressV1['sessionKey'],
        },
        flowId: attempt.flow_id as FlowId,
        taskRunId: attempt.task_run_id as TaskRunId,
        attemptId: attempt.attempt_id as AttemptId,
        reasonCode,
        receiptDigest,
      })
      if (this.readAttempt(input.attemptId)?.status !== 'OUTCOME_UNKNOWN') {
        throw new Error('CHECKPOINT_OUTCOME_UNKNOWN_TRANSITION_UNPROVEN')
      }
      return
    }
    if (attempt.status !== 'STARTING' && attempt.status !== 'RUNNING') {
      throw new Error('CHECKPOINT_OUTCOME_UNKNOWN_TRANSITION_UNAVAILABLE')
    }
    const runtimeSessionId = attempt.runtime_session_id ?? (attempt.status === 'STARTING' ? 'runtime-unbound' : '')
    if (!runtimeSessionId) throw new Error('CHECKPOINT_RUNTIME_BINDING_INCOMPLETE')
    const id = this.idFactory()
    assertSafeId(id, 'CHECKPOINT_REQUEST_ID_INVALID')
    const requestId = `xhbcpo_${digestHex(`${input.attemptId}:${id}:${reasonCode}`).slice(0, 32)}`
    const receiptDigest = digestJson({
      role: 'coding-checkpoint-outcome-unknown',
      requestId,
      attemptId: input.attemptId,
      runtimeSessionId,
      reasonCode,
    })
    const request: HubSystemCommandRequestM2BV1 = {
      contractVersion: 'm2b.v1',
      address: {
        projectId: attempt.project_id as HubAddressV1['projectId'],
        sessionKey: attempt.session_key as HubAddressV1['sessionKey'],
      },
      requestId,
      intent: {
        type: 'system.agent.outcome.record',
        flowId: attempt.flow_id as FlowId,
        taskRunId: attempt.task_run_id as TaskRunId,
        attemptId: attempt.attempt_id as AttemptId,
        runtimeSessionId,
        outcome: 'OUTCOME_UNKNOWN',
        receiptDigest,
      },
      trustedActor: { kind: 'main-process-system' },
    }
    const outcome = await this.authority.executeSystem(request)
    if (!outcome.ok) throw new Error('CHECKPOINT_OUTCOME_UNKNOWN_TRANSITION_REJECTED')
    if (this.readAttempt(input.attemptId)?.status !== 'OUTCOME_UNKNOWN') {
      throw new Error('CHECKPOINT_OUTCOME_UNKNOWN_TRANSITION_UNPROVEN')
    }
  }

  close(): void {
    if (this.ownsWorkspaceDb) this.workspaceDb.close()
    this.db.close()
  }

  private readCompleteBinding(attemptId: string): {
    attempt: AttemptRowV1
    plan: PlanBindingRowV1
    pi: PiSessionBindingRowV1
    receipt: CheckpointWorkspaceReceiptBindingV1
    prepared: PreparedWorkspaceResultV1
  } | null {
    if (!this.hasRequiredTables()) return null
    const attempt = this.readAttempt(attemptId)
    if (!attempt || !attempt.workspace_receipt_id) return null
    const plan = this.db.prepare(`
      select project_id, session_key
      from xiaogui_coding_attempt_plan_v1
      where attempt_id = ? limit 1
    `).get(attemptId) as unknown as PlanBindingRowV1 | undefined
    const pi = this.db.prepare(`
      select session_id, session_file
      from xiaogui_coding_pi_session_binding_v1
      where attempt_id = ? limit 1
    `).get(attemptId) as unknown as PiSessionBindingRowV1 | undefined
    const receipt = this.db.prepare(`
      select workspace_receipt_id, attempt_id, status, receipt_digest
      from workspace_receipts
      where attempt_id = ? order by rowid desc limit 1
    `).get(attemptId) as unknown as CheckpointWorkspaceReceiptBindingV1 | undefined
    const preparedRow = this.workspaceDb.prepare(`
      select result_json
      from attempt_workspace_prepared
      where attempt_id = ? limit 1
    `).get(attemptId) as unknown as WorkspacePreparedRowV1 | undefined
    if (!plan || !pi || !receipt || !preparedRow) return null
    if (plan.project_id !== attempt.project_id || plan.session_key !== attempt.session_key) return null
    if (!SAFE_ID_PATTERN.test(pi.session_id) || !privateAbsolutePath(pi.session_file)) return null
    if (
      receipt.attempt_id !== attemptId
      || receipt.status !== 'PREPARED'
      || receipt.workspace_receipt_id !== attempt.workspace_receipt_id
      || !SHA256_PATTERN.test(receipt.receipt_digest)
    ) return null
    const prepared = parsePreparedWorkspace(preparedRow.result_json)
    if (!prepared || !matchesPreparedWorkspace(attemptId, receipt, prepared)) return null
    return { attempt, plan, pi, receipt, prepared }
  }

  private readAttempt(attemptId: string): AttemptRowV1 | null {
    if (!this.tableExists(this.db, 'attempts')) return null
    const row = this.db.prepare(`
      select attempt_id, project_id, session_key, flow_id, task_run_id, status,
             workspace_receipt_id, runtime_session_id
      from attempts where attempt_id = ? limit 1
    `).get(attemptId) as unknown as AttemptRowV1 | undefined
    return row ?? null
  }

  private hasRequiredTables(): boolean {
    const hubTablesPresent = [
      'attempts',
      'workspace_receipts',
      'xiaogui_coding_attempt_plan_v1',
      'xiaogui_coding_pi_session_binding_v1',
    ].every((name) => this.tableExists(this.db, name))
    return hubTablesPresent && this.tableExists(this.workspaceDb, 'attempt_workspace_prepared')
  }

  private tableExists(db: DatabaseSync, name: string): boolean {
    return Boolean(db.prepare(
      "select 1 as present from sqlite_master where type = 'table' and name = ? limit 1",
    ).get(name))
  }
}

function checkpointState(status: string): AttemptCheckpointBindingV1['state'] {
  switch (status) {
    case 'READY':
    case 'SUCCEEDED':
      return 'IDLE'
    case 'CREATED':
    case 'WORKSPACE_PREPARING':
    case 'STARTING':
    case 'RUNNING':
    case 'VERIFYING':
    case 'INTERRUPT_REQUESTED':
      return 'BUSY'
    case 'FAILED':
    case 'INTERRUPTED':
    case 'CANCELLED':
      return 'UNAVAILABLE'
    case 'OUTCOME_UNKNOWN':
    default:
      return 'OUTCOME_UNKNOWN'
  }
}

function parsePreparedWorkspace(json: string): PreparedWorkspaceResultV1 | null {
  try {
    const value = JSON.parse(json) as PreparedWorkspaceResultV1
    if (
      !value
      || value.receipt?.status !== 'PREPARED'
      || !value.workspace
      || !value.handle
      || !value.manifest
      || value.workspace.writePolicy !== 'ATTEMPT_WORKTREE_ONLY'
      || typeof value.handle.rootPath !== 'string'
      || !privateAbsolutePath(value.handle.rootPath)
      || !SHA256_PATTERN.test(value.receipt.receiptDigest)
      || !SHA256_PATTERN.test(value.workspace.worktreeRootDigest)
      || !SHA256_PATTERN.test(value.workspace.baseRevisionDigest)
      || !SHA256_PATTERN.test(value.workspace.targetProjectRootDigest)
      || !SHA256_PATTERN.test(value.handle.manifestDigest)
      || !SHA256_PATTERN.test(value.manifest.manifestDigest)
    ) return null
    return value
  } catch {
    return null
  }
}

function matchesPreparedWorkspace(
  attemptId: string,
  receipt: CheckpointWorkspaceReceiptBindingV1,
  prepared: PreparedWorkspaceResultV1,
): boolean {
  return prepared.receipt.attemptId === attemptId
    && prepared.receipt.workspaceReceiptId === receipt.workspace_receipt_id
    && prepared.receipt.receiptDigest === receipt.receipt_digest
    && prepared.handle.attemptId === attemptId
    && prepared.manifest.attemptId === attemptId
    && prepared.handle.attemptWorktreeId === prepared.workspace.attemptWorktreeId
    && prepared.handle.manifestDigest === prepared.manifest.manifestDigest
    && prepared.handle.manifestVersion >= 1
}

export function checkpointWorkspaceBindingDigestV1(
  attemptId: string,
  receipt: CheckpointWorkspaceReceiptBindingV1,
  workspace: RuntimeWorkspaceBindingV1,
  authorityStatus: AttemptCheckpointBindingV1['authorityStatus'],
): string {
  return digestJson({
    schemaVersion: 1,
    attemptId,
    workspaceReceiptId: receipt.workspace_receipt_id,
    workspaceReceiptDigest: receipt.receipt_digest,
    attemptWorktreeId: workspace.attemptWorktreeId,
    worktreeRootDigest: workspace.worktreeRootDigest,
    baseRevisionDigest: workspace.baseRevisionDigest,
    targetProjectRootDigest: workspace.targetProjectRootDigest,
    writePolicy: workspace.writePolicy,
    authorityStatus,
  })
}

function checkpointAuthorityStatus(status: string): AttemptCheckpointBindingV1['authorityStatus'] {
  if (status === 'READY') return 'READY'
  if (status === 'SUCCEEDED') return 'SUCCEEDED'
  return 'OTHER'
}

function canonicalReasonCode(value: string): string {
  if (typeof value !== 'string') throw new Error('CHECKPOINT_REASON_CODE_INVALID')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    throw new Error('CHECKPOINT_REASON_CODE_INVALID')
  }
  return trimmed
}

function privateAbsolutePath(value: string): boolean {
  return Boolean(value && (isAbsolute(value) || win32.isAbsolute(value)))
}

function assertSafeId(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) throw new Error(code)
}

function digestJson(value: unknown): string {
  return `sha256:${digestHex(JSON.stringify(value))}`
}

function digestHex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
