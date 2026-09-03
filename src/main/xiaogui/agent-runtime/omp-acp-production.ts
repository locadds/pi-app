import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { validateRuntimeProductionCreateRequestShapeV1 } from '@shared/xiaogui-agent-runtime'
import type {
  RuntimeCreateOrResumeRequestV1,
  RuntimeOutcomeV1,
} from '@shared/xiaogui-agent-runtime'

import type { AttemptTaskPatchCapturePortV1 } from '../task-hub/attempt-workspace'
import { isSafeAcpOpaqueId } from './acp/redaction'
import {
  OMP_ACP_APPROVED_VERSION_V1,
  OMP_ACP_SAFE_ARGS_V1,
  type OmpAcpCandidateInspectorV1,
  type OmpAcpRecoveryBindingV1,
  type OmpAcpRecoveryStoreV1,
  type OmpAcpTrustedLaunchPortV1,
} from './omp-acp-adapter'
import {
  OmpTrustedInstallationModuleV1,
  type OmpTrustedInstallationReceiptV1,
} from './omp-trusted-installation'

const MINIMUM_BUN_VERSION = Object.freeze([1, 3, 14] as const)
const PUBLIC_RUNTIME_SESSION_ID = /^xgrs_[0-9a-f]{32}$/
const SHA256 = /^sha256:[0-9a-f]{64}$/

export interface OmpBunRuntimeProbeV1 {
  findExecutable(): Promise<
    | { readonly available: true; readonly command: string; readonly version: string }
    | { readonly available: false; readonly reasonCode: string }
  >
}

/**
 * Converts an independently verified package receipt into the only production
 * launch accepted by the OMP Adapter. The OMP executable itself never comes
 * from PATH; PATH is used only to locate the mature Bun runtime.
 */
export class OmpTrustedAcpLaunchProviderV1 implements OmpAcpTrustedLaunchPortV1 {
  private readonly packageRoot: string
  private readonly bunProbe: OmpBunRuntimeProbeV1

  constructor(private readonly options: {
    readonly packageRoot: string
    readonly installation: Pick<OmpTrustedInstallationModuleV1, 'inspect'>
    readonly bunProbe?: OmpBunRuntimeProbeV1
  }) {
    this.packageRoot = exactAbsolutePath(options.packageRoot, 'OMP_INSTALL_ROOT_INVALID')
    this.bunProbe = options.bunProbe ?? new SystemOmpBunRuntimeProbeV1()
  }

  async inspectLaunch(): ReturnType<OmpAcpTrustedLaunchPortV1['inspectLaunch']> {
    const inspection = this.options.installation.inspect()
    if (!inspection.ok) return { available: false, reasonCode: inspection.reasonCode }
    const bun = await this.bunProbe.findExecutable()
    if (!bun.available) return bun
    try {
      const entryPath = trustedEntryPath(this.packageRoot, inspection.receipt)
      const version = await probeVersion(bun.command, [entryPath])
      if (version !== OMP_ACP_APPROVED_VERSION_V1) {
        return { available: false, reasonCode: 'OMP_TRUSTED_ENTRY_VERSION_MISMATCH' }
      }
      return Object.freeze({
        available: true as const,
        command: bun.command,
        args: Object.freeze([entryPath, ...OMP_ACP_SAFE_ARGS_V1]),
        version: OMP_ACP_APPROVED_VERSION_V1,
        installationReceiptDigest: inspection.receipt.receiptDigest,
      })
    } catch (error) {
      return {
        available: false,
        reasonCode: error instanceof Error && /^OMP_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : 'OMP_TRUSTED_LAUNCH_FAILED',
      }
    }
  }
}

export class SystemOmpBunRuntimeProbeV1 implements OmpBunRuntimeProbeV1 {
  async findExecutable(): ReturnType<OmpBunRuntimeProbeV1['findExecutable']> {
    const command = await findOnPath('bun')
    if (!command || !isAbsolute(command)) return { available: false, reasonCode: 'OMP_BUN_NOT_FOUND' }
    const version = await probeVersion(command, [])
    if (!version || !minimumVersion(version, MINIMUM_BUN_VERSION)) {
      return { available: false, reasonCode: 'OMP_BUN_VERSION_UNAPPROVED' }
    }
    return { available: true, command, version }
  }
}

export class TaskHubOmpCandidateInspectorV1 implements OmpAcpCandidateInspectorV1 {
  constructor(private readonly workspace: AttemptTaskPatchCapturePortV1) {}

  async inspect(input: {
    readonly attemptId: string
    readonly allowNoApprovedChanges: boolean
  }): Promise<{ readonly candidateDigest: string }> {
    const capture = input.allowNoApprovedChanges
      ? await this.workspace.captureTaskPatch(input.attemptId, { allowNoApprovedChanges: true })
      : await this.workspace.captureTaskPatch(input.attemptId)
    if (!SHA256.test(capture.resultTreeHash)) throw new Error('OMP_CANDIDATE_DIGEST_INVALID')
    return Object.freeze({ candidateDigest: capture.resultTreeHash })
  }
}

interface RecoveryRowV1 {
  readonly public_runtime_session_id: string
  readonly vendor_session_id: string
  readonly attempt_id: string
  readonly request_json: string
  readonly request_digest: string
  readonly selection_digest: string
  readonly workspace_binding_digest: string
  readonly installation_receipt_digest: string
  readonly binding_digest: string
  readonly outcome_json: string | null
  readonly outcome_digest: string | null
  readonly created_at: string
  readonly settled_at: string | null
}

/** Private Adapter binding only; it stores no prompt body, credential, or path. */
export class SqliteOmpAcpRecoveryStoreV1 implements OmpAcpRecoveryStoreV1 {
  readonly durable = true as const
  private readonly db: DatabaseSync
  private readonly now: () => string
  private closed = false

  constructor(options: { readonly dbPath: string; readonly now?: () => string }) {
    const dbPath = exactAbsolutePath(options.dbPath, 'OMP_RECOVERY_DB_PATH_INVALID')
    this.now = options.now ?? (() => new Date().toISOString())
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      create table if not exists xiaogui_omp_acp_recovery_bindings_v1 (
        public_runtime_session_id text primary key,
        vendor_session_id text not null,
        attempt_id text not null,
        request_json text not null,
        request_digest text not null,
        selection_digest text not null,
        workspace_binding_digest text not null,
        installation_receipt_digest text not null,
        binding_digest text not null,
        outcome_json text,
        outcome_digest text,
        created_at text not null,
        settled_at text
      );
    `)
  }

  async bind(binding: Omit<OmpAcpRecoveryBindingV1, 'outcome'>): Promise<void> {
    this.assertOpen()
    const createdAt = validTimestamp(this.now())
    this.db.exec('begin immediate')
    try {
      assertPublicSessionId(binding.publicRuntimeSessionId)
      const existing = this.readRow(binding.publicRuntimeSessionId)
      if (existing) {
        const canonicalExisting = canonicalBinding(binding, validTimestamp(existing.created_at))
        if (!sameUnsignedBinding(existing, canonicalExisting)) throw new Error('OMP_RECOVERY_BINDING_CONFLICT')
        this.db.exec('commit')
        return
      }
      const canonical = canonicalBinding(binding, createdAt)
      this.db.prepare(`
        insert into xiaogui_omp_acp_recovery_bindings_v1 (
          public_runtime_session_id, vendor_session_id, attempt_id, request_json,
          request_digest, selection_digest, workspace_binding_digest,
          installation_receipt_digest, binding_digest, outcome_json,
          outcome_digest, created_at, settled_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, null)
      `).run(
        canonical.publicRuntimeSessionId,
        canonical.vendorSessionId,
        canonical.attemptId,
        canonical.requestJson,
        canonical.requestDigest,
        canonical.selectionDigest,
        canonical.workspaceBindingDigest,
        canonical.installationReceiptDigest,
        canonical.bindingDigest,
        canonical.createdAt,
      )
      this.db.exec('commit')
    } catch (error) {
      rollbackQuietly(this.db)
      throw error
    }
  }

  async settle(
    publicRuntimeSessionId: string,
    outcome: Exclude<RuntimeOutcomeV1, { state: 'OUTCOME_UNKNOWN' }>,
  ): Promise<void> {
    this.assertOpen()
    assertPublicSessionId(publicRuntimeSessionId)
    const canonicalOutcome = canonicalSettledOutcome(publicRuntimeSessionId, outcome)
    const outcomeJson = JSON.stringify(canonicalOutcome)
    const outcomeDigest = digestJson(canonicalOutcome)
    this.db.exec('begin immediate')
    try {
      const existing = this.readRow(publicRuntimeSessionId)
      if (!existing) throw new Error('OMP_RECOVERY_BINDING_NOT_FOUND')
      if (existing.outcome_json !== null || existing.outcome_digest !== null) {
        if (existing.outcome_json !== outcomeJson || existing.outcome_digest !== outcomeDigest) {
          throw new Error('OMP_RECOVERY_OUTCOME_CONFLICT')
        }
        this.db.exec('commit')
        return
      }
      const settledAt = validTimestamp(this.now())
      this.db.prepare(`
        update xiaogui_omp_acp_recovery_bindings_v1
        set outcome_json = ?, outcome_digest = ?, settled_at = ?
        where public_runtime_session_id = ? and outcome_json is null and outcome_digest is null
      `).run(outcomeJson, outcomeDigest, settledAt, publicRuntimeSessionId)
      this.db.exec('commit')
    } catch (error) {
      rollbackQuietly(this.db)
      throw error
    }
  }

  async read(publicRuntimeSessionId: string): Promise<OmpAcpRecoveryBindingV1 | null> {
    this.assertOpen()
    assertPublicSessionId(publicRuntimeSessionId)
    const row = this.readRow(publicRuntimeSessionId)
    return row ? bindingFromRow(row) : null
  }

  async verifyCandidateBinding(input: {
    readonly attemptId: string
    readonly runtimeSessionId: string
    readonly runtimeCandidateDigest: string
    readonly hostResultTreeHash: string
  }): Promise<boolean> {
    try {
      const binding = await this.read(input.runtimeSessionId)
      return Boolean(
        binding &&
        binding.request.scope.attemptId === input.attemptId &&
        binding.outcome?.state === 'SUCCEEDED' &&
        binding.outcome.candidateDigest === input.runtimeCandidateDigest &&
        input.runtimeCandidateDigest === input.hostResultTreeHash,
      )
    } catch {
      return false
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private readRow(publicRuntimeSessionId: string): RecoveryRowV1 | undefined {
    return this.db.prepare(`
      select public_runtime_session_id, vendor_session_id, attempt_id, request_json,
        request_digest, selection_digest, workspace_binding_digest,
        installation_receipt_digest, binding_digest, outcome_json,
        outcome_digest, created_at, settled_at
      from xiaogui_omp_acp_recovery_bindings_v1
      where public_runtime_session_id = ? limit 1
    `).get(publicRuntimeSessionId) as unknown as RecoveryRowV1 | undefined
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('OMP_RECOVERY_STORE_CLOSED')
  }
}

function trustedEntryPath(root: string, receipt: OmpTrustedInstallationReceiptV1): string {
  const realRoot = realpathSync.native(root)
  if (!lstatSync(realRoot).isDirectory() || pathKey(realRoot) !== pathKey(root)) {
    throw new Error('OMP_INSTALL_ROOT_INVALID')
  }
  if (!realRoot.split(/[\\/]+/).some((segment) => segment.toLowerCase() === 'node_modules')) {
    throw new Error('OMP_RUNTIME_DEPENDENCY_LAYOUT_INVALID')
  }
  const target = join(realRoot, ...receipt.entryRelativePath.split('/'))
  const realTarget = realpathSync.native(target)
  if (
    !lstatSync(realTarget).isFile() ||
    relative(realRoot, realTarget).startsWith('..') ||
    pathKey(realTarget) !== pathKey(target)
  ) throw new Error('OMP_TRUSTED_ENTRY_INVALID')
  return realTarget
}

function canonicalBinding(
  binding: Omit<OmpAcpRecoveryBindingV1, 'outcome'>,
  createdAt: string,
): {
  readonly publicRuntimeSessionId: string
  readonly vendorSessionId: string
  readonly attemptId: string
  readonly requestJson: string
  readonly requestDigest: string
  readonly selectionDigest: string
  readonly workspaceBindingDigest: string
  readonly installationReceiptDigest: string
  readonly bindingDigest: string
  readonly createdAt: string
} {
  assertPublicSessionId(binding.publicRuntimeSessionId)
  if (!isSafeAcpOpaqueId(binding.vendorSessionId)) throw new Error('OMP_VENDOR_SESSION_ID_INVALID')
  const shape = validateRuntimeProductionCreateRequestShapeV1(binding.request)
  if (!shape.ok || !safeId(binding.request.scope.attemptId)) throw new Error('OMP_RECOVERY_REQUEST_INVALID')
  if (!SHA256.test(binding.installationReceiptDigest)) throw new Error('OMP_INSTALLATION_RECEIPT_INVALID')
  const requestJson = JSON.stringify(binding.request)
  const requestDigest = digestJson(binding.request)
  const selectionDigest = digestJson(binding.request.selection)
  const workspaceBindingDigest = digestJson(binding.request.workspace)
  const unsigned = {
    publicRuntimeSessionId: binding.publicRuntimeSessionId,
    vendorSessionId: binding.vendorSessionId,
    attemptId: binding.request.scope.attemptId,
    requestDigest,
    selectionDigest,
    workspaceBindingDigest,
    installationReceiptDigest: binding.installationReceiptDigest,
    createdAt,
  }
  return Object.freeze({
    ...unsigned,
    requestJson,
    bindingDigest: digestJson({ domain: 'xiaogui.omp-acp.recovery-binding.v1', ...unsigned }),
  })
}

function bindingFromRow(row: RecoveryRowV1): OmpAcpRecoveryBindingV1 {
  assertPublicSessionId(row.public_runtime_session_id)
  if (!isSafeAcpOpaqueId(row.vendor_session_id) || !safeId(row.attempt_id)) {
    throw new Error('OMP_RECOVERY_BINDING_INVALID')
  }
  const request = JSON.parse(row.request_json) as RuntimeCreateOrResumeRequestV1
  const shape = validateRuntimeProductionCreateRequestShapeV1(request)
  if (!shape.ok || request.scope.attemptId !== row.attempt_id) throw new Error('OMP_RECOVERY_BINDING_INVALID')
  const unsigned = {
    publicRuntimeSessionId: row.public_runtime_session_id,
    vendorSessionId: row.vendor_session_id,
    attemptId: row.attempt_id,
    requestDigest: row.request_digest,
    selectionDigest: row.selection_digest,
    workspaceBindingDigest: row.workspace_binding_digest,
    installationReceiptDigest: row.installation_receipt_digest,
    createdAt: validTimestamp(row.created_at),
  }
  if (
    row.request_digest !== digestJson(request) ||
    row.selection_digest !== digestJson(request.selection) ||
    row.workspace_binding_digest !== digestJson(request.workspace) ||
    !SHA256.test(row.installation_receipt_digest) ||
    row.binding_digest !== digestJson({ domain: 'xiaogui.omp-acp.recovery-binding.v1', ...unsigned })
  ) throw new Error('OMP_RECOVERY_BINDING_INVALID')
  const outcome = row.outcome_json === null && row.outcome_digest === null
    ? null
    : canonicalOutcomeRow(row.public_runtime_session_id, row.outcome_json, row.outcome_digest, row.settled_at)
  return Object.freeze({
    publicRuntimeSessionId: row.public_runtime_session_id,
    vendorSessionId: row.vendor_session_id,
    request,
    installationReceiptDigest: row.installation_receipt_digest,
    outcome,
  })
}

function canonicalOutcomeRow(
  publicRuntimeSessionId: string,
  outcomeJson: string | null,
  outcomeDigest: string | null,
  settledAt: string | null,
): Exclude<RuntimeOutcomeV1, { state: 'OUTCOME_UNKNOWN' }> {
  if (!outcomeJson || !outcomeDigest || !settledAt) throw new Error('OMP_RECOVERY_OUTCOME_INVALID')
  validTimestamp(settledAt)
  const outcome = canonicalSettledOutcome(
    publicRuntimeSessionId,
    JSON.parse(outcomeJson) as Exclude<RuntimeOutcomeV1, { state: 'OUTCOME_UNKNOWN' }>,
  )
  if (outcomeDigest !== digestJson(outcome)) throw new Error('OMP_RECOVERY_OUTCOME_INVALID')
  return outcome
}

function canonicalSettledOutcome(
  publicRuntimeSessionId: string,
  outcome: Exclude<RuntimeOutcomeV1, { state: 'OUTCOME_UNKNOWN' }>,
): Exclude<RuntimeOutcomeV1, { state: 'OUTCOME_UNKNOWN' }> {
  if (
    !outcome ||
    outcome.runtimeSessionId !== publicRuntimeSessionId ||
    !SHA256.test(outcome.receiptDigest) ||
    !['SUCCEEDED', 'FAILED', 'INTERRUPTED'].includes(outcome.state)
  ) throw new Error('OMP_RECOVERY_OUTCOME_INVALID')
  if (outcome.state === 'SUCCEEDED') {
    if (!SHA256.test(outcome.candidateDigest)) throw new Error('OMP_RECOVERY_OUTCOME_INVALID')
  } else if (!safeReasonCode(outcome.reasonCode)) {
    throw new Error('OMP_RECOVERY_OUTCOME_INVALID')
  }
  return Object.freeze({ ...outcome })
}

function sameUnsignedBinding(
  row: RecoveryRowV1,
  binding: ReturnType<typeof canonicalBinding>,
): boolean {
  return row.public_runtime_session_id === binding.publicRuntimeSessionId &&
    row.vendor_session_id === binding.vendorSessionId &&
    row.attempt_id === binding.attemptId &&
    row.request_json === binding.requestJson &&
    row.request_digest === binding.requestDigest &&
    row.selection_digest === binding.selectionDigest &&
    row.workspace_binding_digest === binding.workspaceBindingDigest &&
    row.installation_receipt_digest === binding.installationReceiptDigest &&
    row.binding_digest === binding.bindingDigest
}

function assertPublicSessionId(value: string): void {
  if (!PUBLIC_RUNTIME_SESSION_ID.test(value)) throw new Error('OMP_PUBLIC_SESSION_ID_INVALID')
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(value)
}

function safeReasonCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9_]{1,128}$/.test(value)
}

function validTimestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('OMP_RECOVERY_TIMESTAMP_INVALID')
  }
  return value
}

function exactAbsolutePath(value: string, reasonCode: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !isAbsolute(value)) {
    throw new Error(reasonCode)
  }
  return resolve(value)
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function minimumVersion(value: string, minimum: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) return false
  const actual = match.slice(1).map(Number)
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true
    if (actual[index] < minimum[index]) return false
  }
  return true
}

async function findOnPath(command: string): Promise<string | undefined> {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  return await new Promise((resolveCommand) => {
    const child = spawn(probe, [command], { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString() })
    child.once('error', () => resolveCommand(undefined))
    child.once('close', (code) => {
      const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      resolveCommand(code === 0 && first ? first : undefined)
    })
  })
}

async function probeVersion(command: string, prefix: readonly string[]): Promise<string | undefined> {
  return await new Promise((resolveVersion) => {
    const child = spawn(command, [...prefix, '--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    let completed = false
    const finish = (value: string | undefined): void => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      resolveVersion(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(undefined)
    }, 5_000)
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString() })
    child.once('error', () => finish(undefined))
    child.once('close', (code) => finish(code === 0 ? stdout.match(/\d+\.\d+\.\d+/)?.[0] : undefined))
  })
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('rollback')
  } catch {
    // Preserve the original transaction failure.
  }
}
