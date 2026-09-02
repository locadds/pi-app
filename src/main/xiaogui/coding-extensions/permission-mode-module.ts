import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import {
  CODING_PERMISSION_MODES_V1,
  XIAOGUI_CODING_PERMISSION_MODE_OPTIONS_V1,
  type CodingPermissionBoundaryStateV1,
  type CodingPermissionIntentV1,
  type CodingPermissionModeBindingV1,
  type CodingPermissionModeV1,
  type CodingPermissionPolicyEvaluationV1,
} from '@shared/xiaogui-coding-extension-pack'

import type { AttemptFileManifestV1 } from '../task-hub/attempt-workspace'
import { evaluateCodingPermissionPolicyV1 } from './permission-policy'

export interface CodingPermissionModeSelectionV1 {
  readonly schemaVersion: 1
  readonly mode: CodingPermissionModeV1
  readonly source: 'USER_SELECTED'
  readonly policyDigest: string
}

export interface CodingPermissionModeModuleOptionsV1 {
  readonly dbPath: string
  readonly readSelectedMode: () => unknown
  readonly readAttemptManifest: (attemptId: string) => AttemptFileManifestV1 | undefined
  readonly now?: () => string
}

interface BindingRowV1 {
  readonly attempt_id: string
  readonly mode: string
  readonly source: string
  readonly policy_digest: string
  readonly bound_at: string
}

/**
 * TaskHub-owned permission-mode Module. The global preference is sampled once,
 * then an immutable policy snapshot is bound to the Attempt. Renderer and
 * Runtime never attest workspace, command, or data-egress boundaries.
 */
export class CodingPermissionModeModuleV1 {
  private readonly db: DatabaseSync
  private readonly now: () => string

  constructor(private readonly options: CodingPermissionModeModuleOptionsV1) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec(`
      create table if not exists xiaogui_coding_permission_mode_bindings_v1 (
        attempt_id text primary key,
        mode text not null,
        source text not null,
        policy_digest text not null,
        bound_at text not null
      );
    `)
  }

  captureSelection(): CodingPermissionModeSelectionV1 {
    const selected = this.options.readSelectedMode()
    const mode = isCodingPermissionMode(selected) ? selected : 'CONFIRM_EACH'
    return Object.freeze({
      schemaVersion: 1,
      mode,
      source: 'USER_SELECTED',
      policyDigest: codingPermissionPolicyDigestV1(mode),
    })
  }

  bindAttempt(
    attemptId: string,
    selection: CodingPermissionModeSelectionV1,
  ): CodingPermissionModeBindingV1 {
    assertSafeAttemptId(attemptId)
    const canonical = canonicalSelection(selection)
    this.db.exec('begin immediate')
    try {
      const existing = this.readBindingRow(attemptId)
      if (existing) {
        const binding = bindingFromRow(existing)
        if (!sameSelection(binding, canonical)) {
          throw new Error('CODING_PERMISSION_MODE_ATTEMPT_ALREADY_BOUND')
        }
        this.db.exec('commit')
        return binding
      }
      const boundAt = validTimestamp(this.now())
      this.db.prepare(`
        insert into xiaogui_coding_permission_mode_bindings_v1 (
          attempt_id, mode, source, policy_digest, bound_at
        ) values (?, ?, ?, ?, ?)
      `).run(attemptId, canonical.mode, canonical.source, canonical.policyDigest, boundAt)
      this.db.exec('commit')
      return freezeBinding({
        schemaVersion: 1,
        attemptId,
        mode: canonical.mode,
        source: canonical.source,
        policyDigest: canonical.policyDigest,
        boundAt,
      })
    } catch (error) {
      rollbackQuietly(this.db)
      throw error
    }
  }

  readAttemptBinding(attemptId: string): CodingPermissionModeBindingV1 | null {
    assertSafeAttemptId(attemptId)
    const row = this.readBindingRow(attemptId)
    return row ? bindingFromRow(row) : null
  }

  verifyAttemptBinding(
    attemptId: string,
    selection: CodingPermissionModeSelectionV1,
  ): boolean {
    try {
      const binding = this.readAttemptBinding(attemptId)
      return binding !== null && sameSelection(binding, canonicalSelection(selection))
    } catch {
      return false
    }
  }

  /** CodingPermissionPolicyPortV1 implementation. */
  async evaluate(intent: CodingPermissionIntentV1): Promise<CodingPermissionPolicyEvaluationV1> {
    let binding: CodingPermissionModeBindingV1 | null
    try {
      binding = this.readAttemptBinding(intent.attemptId)
    } catch {
      binding = null
    }
    const boundaryState = binding
      ? taskHubBoundaryState(intent, this.options.readAttemptManifest(intent.attemptId))
      : 'UNVERIFIED'
    return evaluateCodingPermissionPolicyV1({
      mode: binding?.mode ?? 'CONFIRM_EACH',
      intent,
      boundaryState,
    })
  }

  close(): void {
    this.db.close()
  }

  private readBindingRow(attemptId: string): BindingRowV1 | undefined {
    return this.db.prepare(`
      select attempt_id, mode, source, policy_digest, bound_at
      from xiaogui_coding_permission_mode_bindings_v1
      where attempt_id = ? limit 1
    `).get(attemptId) as unknown as BindingRowV1 | undefined
  }
}

export function codingPermissionPolicyDigestV1(mode: CodingPermissionModeV1): string {
  const option = XIAOGUI_CODING_PERMISSION_MODE_OPTIONS_V1.find((candidate) => candidate.mode === mode)
  if (!option) throw new Error('CODING_PERMISSION_MODE_INVALID')
  return `sha256:${createHash('sha256').update(JSON.stringify({
    domain: 'xiaogui.coding.permission-mode-policy.v1',
    option,
  })).digest('hex')}`
}

export function taskHubBoundaryState(
  intent: CodingPermissionIntentV1,
  manifest: AttemptFileManifestV1 | undefined,
): CodingPermissionBoundaryStateV1 {
  if (!manifest || manifest.attemptId !== intent.attemptId || manifest.grants.length === 0) {
    return 'UNVERIFIED'
  }
  if (intent.operation === 'COMMAND' || intent.operation === 'DATA_EGRESS') {
    // P1B deliberately has no command or egress pre-approval contract. A file
    // manifest cannot be promoted into either authority by inference.
    return 'UNVERIFIED'
  }
  if (intent.relativePaths.length === 0) return 'DENIED'
  const grants = new Map(manifest.grants.map((grant) => [grant.relativePath, grant.operation]))
  for (const path of intent.relativePaths) {
    if (!isSafeRelativePath(path)) return 'DENIED'
    const grant = grants.get(path)
    if (!grant) return 'DENIED'
    if (intent.operation === 'WRITE' && grant === 'DELETE') return 'DENIED'
  }
  return 'VERIFIED'
}

function canonicalSelection(selection: CodingPermissionModeSelectionV1): CodingPermissionModeSelectionV1 {
  if (
    selection?.schemaVersion !== 1 ||
    !isCodingPermissionMode(selection.mode) ||
    selection.source !== 'USER_SELECTED' ||
    selection.policyDigest !== codingPermissionPolicyDigestV1(selection.mode)
  ) throw new Error('CODING_PERMISSION_MODE_SELECTION_INVALID')
  return Object.freeze({ ...selection })
}

function bindingFromRow(row: BindingRowV1): CodingPermissionModeBindingV1 {
  if (
    !isCodingPermissionMode(row.mode) ||
    row.source !== 'USER_SELECTED' ||
    row.policy_digest !== codingPermissionPolicyDigestV1(row.mode)
  ) throw new Error('CODING_PERMISSION_MODE_BINDING_INVALID')
  return freezeBinding({
    schemaVersion: 1,
    attemptId: row.attempt_id,
    mode: row.mode,
    source: 'USER_SELECTED',
    policyDigest: row.policy_digest,
    boundAt: validTimestamp(row.bound_at),
  })
}

function sameSelection(
  binding: CodingPermissionModeBindingV1,
  selection: CodingPermissionModeSelectionV1,
): boolean {
  return binding.mode === selection.mode &&
    binding.source === selection.source &&
    binding.policyDigest === selection.policyDigest
}

function isCodingPermissionMode(value: unknown): value is CodingPermissionModeV1 {
  return typeof value === 'string' && CODING_PERMISSION_MODES_V1.includes(value as CodingPermissionModeV1)
}

function isSafeRelativePath(value: string): boolean {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[a-z]:/i.test(value)
  ) return false
  const parts = value.split(/[\\/]/)
  return !parts.some((part) => (
    part.length === 0 ||
    part === '.' ||
    part === '..' ||
    part.toLowerCase() === '.git'
  ))
}

function assertSafeAttemptId(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value !== value.trim()) {
    throw new Error('CODING_PERMISSION_MODE_ATTEMPT_ID_INVALID')
  }
}

function validTimestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('CODING_PERMISSION_MODE_TIMESTAMP_INVALID')
  }
  return value
}

function freezeBinding(binding: CodingPermissionModeBindingV1): CodingPermissionModeBindingV1 {
  return Object.freeze({ ...binding })
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('rollback')
  } catch {
    // Preserve the original transaction failure.
  }
}
