import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, posix, win32 } from 'node:path'

import {
  XIAOGUI_CODING_CHECKPOINT_SESSION_IMPACT_V1,
  type CodingCheckpointRestorePreviewProjectionV1,
} from '@shared/xiaogui-coding-checkpoint-control'
import type { CodingCheckpointV1 } from '@shared/xiaogui-coding-extension-pack'

export type AttemptCheckpointStateV1 = 'IDLE' | 'BUSY' | 'UNAVAILABLE' | 'OUTCOME_UNKNOWN'

export interface AttemptCheckpointBindingV1 {
  readonly attemptId: string
  readonly sessionId: string
  readonly worktreeBindingDigest: string
  readonly state: AttemptCheckpointStateV1
  readonly authorityStatus: 'READY' | 'SUCCEEDED' | 'OTHER'
}

export interface AttemptCheckpointabilityPort {
  inspect(attemptId: string): Promise<AttemptCheckpointBindingV1 | null>
  markOutcomeUnknown(input: { attemptId: string; reasonCode: string }): Promise<void>
}

export interface PiSessionCheckpointSnapshotV1 {
  readonly attemptId: string
  readonly sessionId: string
  /** Main-process-private opaque reference. Never expose this through IPC. */
  readonly snapshotRef: string
  readonly snapshotDigest: string
}

export interface PiSessionCheckpointPort {
  inspect(input: {
    attemptId: string
    sessionId: string
  }): Promise<Omit<PiSessionCheckpointSnapshotV1, 'snapshotRef'>>
  capture(input: {
    attemptId: string
    sessionId: string
  }): Promise<PiSessionCheckpointSnapshotV1>
  restore(input: {
    attemptId: string
    sessionId: string
    snapshotRef: string
    expectedDigest: string
  }): Promise<{
    attemptId: string
    sessionId: string
    restoredSnapshotDigest: string
  }>
}

export interface AttemptWorkspaceCheckpointSnapshotV1 {
  readonly attemptId: string
  readonly worktreeBindingDigest: string
  /** Main-process-private opaque reference. Never expose this through IPC. */
  readonly snapshotRef: string
  readonly snapshotDigest: string
  readonly baselineDigest: string
  readonly changeSummaryDigest: string
}

export interface AttemptWorkspaceCheckpointRestorePreviewV1 {
  readonly schemaVersion: 1
  readonly attemptId: string
  readonly worktreeBindingDigest: string
  readonly targetSnapshotDigest: string
  readonly currentSnapshotDigest: string
  readonly changedRelativePaths: readonly string[]
  readonly changeCount: number
  readonly changeSummaryDigest: string
}

export interface AttemptCheckpointWorkspacePort {
  inspect(input: {
    attemptId: string
    worktreeBindingDigest: string
  }): Promise<Omit<AttemptWorkspaceCheckpointSnapshotV1, 'snapshotRef'>>
  capture(input: {
    attemptId: string
    worktreeBindingDigest: string
  }): Promise<AttemptWorkspaceCheckpointSnapshotV1>
  previewRestore(input: {
    attemptId: string
    worktreeBindingDigest: string
    snapshotRef: string
    expectedDigest: string
  }): Promise<AttemptWorkspaceCheckpointRestorePreviewV1>
  restore(input: {
    attemptId: string
    worktreeBindingDigest: string
    snapshotRef: string
    expectedDigest: string
  }): Promise<{
    attemptId: string
    worktreeBindingDigest: string
    restoredSnapshotDigest: string
  }>
}

export type CodingCheckpointErrorCodeV1 =
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_BUSY'
  | 'ATTEMPT_UNAVAILABLE'
  | 'BINDING_MISMATCH'
  | 'CHECKPOINT_CONFLICT'
  | 'CHECKPOINT_NOT_FOUND'
  | 'CHECKPOINT_UNAVAILABLE'
  | 'PREVIEW_NOT_FOUND'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_DIGEST_MISMATCH'
  | 'PREVIEW_STALE'
  | 'CAPTURE_FAILED'
  | 'PREVIEW_FAILED'
  | 'RESTORE_FAILED'
  | 'OUTCOME_UNKNOWN'

export interface CodingCheckpointErrorV1 {
  readonly code: CodingCheckpointErrorCodeV1
}

export type CodingCheckpointRestorePreviewV1 = CodingCheckpointRestorePreviewProjectionV1

export type CodingCheckpointCaptureResultV1 =
  | { readonly ok: true; readonly checkpoint: CodingCheckpointV1 }
  | { readonly ok: false; readonly error: CodingCheckpointErrorV1 }

export type CodingCheckpointPreviewResultV1 =
  | { readonly ok: true; readonly preview: CodingCheckpointRestorePreviewV1 }
  | { readonly ok: false; readonly error: CodingCheckpointErrorV1 }

export type CodingCheckpointRestoreResultV1 =
  | { readonly ok: true; readonly outcome: 'RESTORED'; readonly checkpoint: CodingCheckpointV1 }
  | {
      readonly ok: false
      readonly outcome?: 'FAILED_ROLLED_BACK' | 'OUTCOME_UNKNOWN'
      readonly error: CodingCheckpointErrorV1
    }

interface PrivateCheckpointRecordV1 {
  readonly schemaVersion: 1
  checkpoint: CodingCheckpointV1
  readonly binding: AttemptCheckpointBindingV1
  readonly sessionTarget: PiSessionCheckpointSnapshotV1
  readonly workspaceTarget: AttemptWorkspaceCheckpointSnapshotV1
}

interface PrivateRestorePreviewRecordV1 {
  readonly schemaVersion: 1
  readonly preview: CodingCheckpointRestorePreviewV1
  readonly binding: AttemptCheckpointBindingV1
  readonly currentSessionDigest: string
  readonly currentWorkspaceDigest: string
  readonly currentBaselineDigest: string
  readonly currentChangeSummaryDigest: string
  readonly workspacePreviewChangeSummaryDigest: string
  readonly changedRelativePathsDigest: string
}

export type CodingCheckpointRestoreSagaPhaseV1 =
  | 'PREPARING'
  | 'ROLLBACK_CAPTURED'
  | 'WORKTREE_RESTORE_STARTED'
  | 'WORKTREE_RESTORED'
  | 'SESSION_RESTORE_STARTED'
  | 'SESSION_RESTORED'
  | 'COMPLETED'
  | 'FAILED_NO_CHANGE'
  | 'FAILED_ROLLED_BACK'
  | 'OUTCOME_UNKNOWN'

export interface CodingCheckpointRestoreSagaV1 {
  readonly schemaVersion: 1
  readonly restoreId: string
  readonly attemptId: string
  readonly checkpointId: string
  readonly binding: AttemptCheckpointBindingV1
  phase: CodingCheckpointRestoreSagaPhaseV1
  rollbackSession?: PiSessionCheckpointSnapshotV1
  rollbackWorkspace?: AttemptWorkspaceCheckpointSnapshotV1
  updatedAt: number
}

export interface CodingCheckpointPersistedStateV1 {
  readonly schemaVersion: 1
  readonly checkpoints: readonly PrivateCheckpointRecordV1[]
  readonly previews: readonly PrivateRestorePreviewRecordV1[]
  readonly sagas: readonly CodingCheckpointRestoreSagaV1[]
}

export interface CodingCheckpointModuleOptionsV1 {
  readonly attempts: AttemptCheckpointabilityPort
  readonly sessions: PiSessionCheckpointPort
  readonly workspace: AttemptCheckpointWorkspacePort
  readonly previewTtlMs?: number
  readonly now?: () => number
  readonly idFactory?: (prefix: 'preview' | 'restore') => string
  readonly persistedState?: CodingCheckpointPersistedStateV1
  /** Persist the whole private state atomically. Called before every mutating saga step. */
  readonly persistState?: (state: CodingCheckpointPersistedStateV1) => void | Promise<void>
}

const TERMINAL_SAGA_PHASES = new Set<CodingCheckpointRestoreSagaPhaseV1>([
  'COMPLETED',
  'FAILED_NO_CHANGE',
  'FAILED_ROLLED_BACK',
  'OUTCOME_UNKNOWN',
])
const PUBLIC_PREVIEW_PATH_LIMIT = 100
const PUBLIC_PREVIEW_PATH_LENGTH_LIMIT = 1_024

/**
 * Main-process checkpoint deep module. It owns preview freshness, bindings and
 * restore compensation; Pi and worktree adapters only implement opaque snapshots.
 */
export class CodingCheckpointModuleV1 {
  private readonly attempts: AttemptCheckpointabilityPort
  private readonly sessions: PiSessionCheckpointPort
  private readonly workspace: AttemptCheckpointWorkspacePort
  private readonly previewTtlMs: number
  private readonly now: () => number
  private readonly idFactory: (prefix: 'preview' | 'restore') => string
  private readonly persistState: (state: CodingCheckpointPersistedStateV1) => void | Promise<void>
  private readonly checkpoints = new Map<string, PrivateCheckpointRecordV1>()
  private readonly previews = new Map<string, PrivateRestorePreviewRecordV1>()
  private readonly sagas = new Map<string, CodingCheckpointRestoreSagaV1>()
  private readonly activeAttempts = new Set<string>()

  constructor(options: CodingCheckpointModuleOptionsV1) {
    this.attempts = options.attempts
    this.sessions = options.sessions
    this.workspace = options.workspace
    this.previewTtlMs = options.previewTtlMs ?? 5 * 60_000
    this.now = options.now ?? Date.now
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}_${randomUUID()}`)
    this.persistState = options.persistState ?? (() => undefined)

    const state = options.persistedState
    if (state?.schemaVersion === 1) {
      for (const record of state.checkpoints) this.checkpoints.set(record.checkpoint.checkpointId, cloneCheckpointRecord(record))
      for (const record of state.previews) this.previews.set(record.preview.previewId, clonePreviewRecord(record))
      for (const saga of state.sagas) this.sagas.set(saga.restoreId, cloneSaga(saga))
    }
  }

  list(attemptId: string): readonly CodingCheckpointV1[] {
    return [...this.checkpoints.values()]
      .map((record) => record.checkpoint)
      .filter((checkpoint) => checkpoint.attemptId === attemptId)
      .map((checkpoint) => ({ ...checkpoint }))
  }

  async capture(input: {
    attemptId: string
    checkpointId: string
  }): Promise<CodingCheckpointCaptureResultV1> {
    if (this.checkpoints.has(input.checkpointId)) return failure('CHECKPOINT_CONFLICT')
    const bindingResult = await this.requireIdleBinding(input.attemptId)
    if (!bindingResult.ok) return bindingResult
    const binding = bindingResult.binding

    try {
      const sessionTarget = await this.sessions.capture({
        attemptId: input.attemptId,
        sessionId: binding.sessionId,
      })
      const workspaceTarget = await this.workspace.capture({
        attemptId: input.attemptId,
        worktreeBindingDigest: binding.worktreeBindingDigest,
      })
      assertSessionSnapshot(sessionTarget, binding)
      assertWorkspaceSnapshot(workspaceTarget, binding)
      const stableBinding = await this.requireIdleBinding(input.attemptId, binding)
      if (!stableBinding.ok) return stableBinding

      const checkpoint: CodingCheckpointV1 = {
        schemaVersion: 1,
        checkpointId: input.checkpointId,
        attemptId: input.attemptId,
        sessionCheckpointDigest: sessionTarget.snapshotDigest,
        worktreeBaselineDigest: workspaceTarget.baselineDigest,
        changeSummaryDigest: workspaceTarget.changeSummaryDigest,
        status: 'AVAILABLE',
      }
      this.checkpoints.set(input.checkpointId, {
        schemaVersion: 1,
        checkpoint,
        binding,
        sessionTarget,
        workspaceTarget,
      })
      await this.persist()
      return { ok: true, checkpoint: { ...checkpoint } }
    } catch {
      this.checkpoints.delete(input.checkpointId)
      return failure('CAPTURE_FAILED')
    }
  }

  async prepareRestore(input: {
    attemptId: string
    checkpointId: string
  }): Promise<CodingCheckpointPreviewResultV1> {
    const checkpointResult = this.requireAvailableCheckpoint(input)
    if (!checkpointResult.ok) return checkpointResult
    const record = checkpointResult.record
    const bindingResult = await this.requireIdleBinding(input.attemptId, record.binding)
    if (!bindingResult.ok) return bindingResult

    try {
      const currentSession = await this.sessions.inspect({
        attemptId: input.attemptId,
        sessionId: record.binding.sessionId,
      })
      const currentWorkspace = await this.workspace.inspect({
        attemptId: input.attemptId,
        worktreeBindingDigest: record.binding.worktreeBindingDigest,
      })
      const workspaceRestorePreview = await this.workspace.previewRestore({
        attemptId: input.attemptId,
        worktreeBindingDigest: record.binding.worktreeBindingDigest,
        snapshotRef: record.workspaceTarget.snapshotRef,
        expectedDigest: record.workspaceTarget.snapshotDigest,
      })
      assertSessionInspection(currentSession, record.binding)
      assertWorkspaceInspection(currentWorkspace, record.binding)
      assertWorkspaceRestorePreview(
        workspaceRestorePreview,
        record.binding,
        record.workspaceTarget.snapshotDigest,
        currentWorkspace.snapshotDigest,
      )
      const stableBinding = await this.requireIdleBinding(input.attemptId, record.binding)
      if (!stableBinding.ok) return stableBinding

      const previewId = this.idFactory('preview')
      const expiresAt = this.now() + this.previewTtlMs
      const digestInput = {
        previewId,
        checkpointId: input.checkpointId,
        attemptId: input.attemptId,
        sessionId: record.binding.sessionId,
        worktreeBindingDigest: record.binding.worktreeBindingDigest,
        targetSessionDigest: record.sessionTarget.snapshotDigest,
        targetWorkspaceDigest: record.workspaceTarget.snapshotDigest,
        currentSessionDigest: currentSession.snapshotDigest,
        currentWorkspaceDigest: currentWorkspace.snapshotDigest,
        currentBaselineDigest: currentWorkspace.baselineDigest,
        currentChangeSummaryDigest: currentWorkspace.changeSummaryDigest,
        workspacePreviewChangeSummaryDigest: workspaceRestorePreview.changeSummaryDigest,
        changedRelativePathsDigest: payloadDigest(workspaceRestorePreview.changedRelativePaths),
        expiresAt,
      }
      const preview: CodingCheckpointRestorePreviewV1 = {
        schemaVersion: 1,
        previewId,
        checkpointId: input.checkpointId,
        attemptId: input.attemptId,
        changedRelativePaths: Object.freeze(
          workspaceRestorePreview.changedRelativePaths.slice(0, PUBLIC_PREVIEW_PATH_LIMIT),
        ),
        changeCount: workspaceRestorePreview.changeCount,
        truncated: workspaceRestorePreview.changeCount > PUBLIC_PREVIEW_PATH_LIMIT,
        sessionImpact: XIAOGUI_CODING_CHECKPOINT_SESSION_IMPACT_V1,
        previewDigest: payloadDigest(digestInput),
        expiresAt,
      }
      this.previews.set(previewId, {
        schemaVersion: 1,
        preview,
        binding: record.binding,
        currentSessionDigest: currentSession.snapshotDigest,
        currentWorkspaceDigest: currentWorkspace.snapshotDigest,
        currentBaselineDigest: currentWorkspace.baselineDigest,
        currentChangeSummaryDigest: currentWorkspace.changeSummaryDigest,
        workspacePreviewChangeSummaryDigest: workspaceRestorePreview.changeSummaryDigest,
        changedRelativePathsDigest: payloadDigest(workspaceRestorePreview.changedRelativePaths),
      })
      await this.persist()
      return { ok: true, preview: { ...preview } }
    } catch {
      return failure('PREVIEW_FAILED')
    }
  }

  async restore(input: {
    attemptId: string
    checkpointId: string
    previewId: string
    previewDigest: string
  }): Promise<CodingCheckpointRestoreResultV1> {
    if (this.activeAttempts.has(input.attemptId)) return failure('ATTEMPT_BUSY')
    const checkpointResult = this.requireAvailableCheckpoint(input)
    if (!checkpointResult.ok) return checkpointResult
    const preview = this.previews.get(input.previewId)
    if (!preview || preview.preview.attemptId !== input.attemptId || preview.preview.checkpointId !== input.checkpointId) {
      return failure('PREVIEW_NOT_FOUND')
    }
    if (this.now() > preview.preview.expiresAt) {
      this.previews.delete(input.previewId)
      await this.persistSafely()
      return failure('PREVIEW_EXPIRED')
    }
    if (input.previewDigest !== preview.preview.previewDigest || recomputePreviewDigest(preview, checkpointResult.record) !== input.previewDigest) {
      return failure('PREVIEW_DIGEST_MISMATCH')
    }

    this.activeAttempts.add(input.attemptId)
    try {
      const bindingResult = await this.requireIdleBinding(input.attemptId, preview.binding)
      if (!bindingResult.ok) return bindingResult
      const freshness = await this.checkPreviewFreshness(preview, checkpointResult.record)
      if (!freshness) return failure('PREVIEW_STALE')
      return await this.executeRestore(checkpointResult.record, preview)
    } finally {
      this.activeAttempts.delete(input.attemptId)
    }
  }

  /**
   * Restart recovery never continues a forward restore. It either proves that
   * no mutation started, compensates to the rollback snapshots, or records an
   * authoritative OUTCOME_UNKNOWN.
   */
  async recover(): Promise<readonly CodingCheckpointRestoreResultV1[]> {
    const results: CodingCheckpointRestoreResultV1[] = []
    for (const saga of this.sagas.values()) {
      if (saga.phase === 'OUTCOME_UNKNOWN') {
        try {
          await this.attempts.markOutcomeUnknown({
            attemptId: saga.attemptId,
            reasonCode: 'CHECKPOINT_RECOVERY_OUTCOME_UNKNOWN',
          })
        } catch {
          // Keep the private terminal state and fail closed below. A later
          // restart retries the authoritative TaskHub transition again.
        }
        results.push(unknownOutcome())
        continue
      }
      if (TERMINAL_SAGA_PHASES.has(saga.phase)) continue
      const checkpoint = this.checkpoints.get(saga.checkpointId)
      if (!checkpoint) {
        results.push(await this.markUnknown(saga, undefined, 'CHECKPOINT_RECOVERY_RECORD_MISSING'))
        continue
      }
      const binding = await this.requireIdleBinding(saga.attemptId, saga.binding)
      if (!binding.ok) {
        results.push(await this.markUnknown(saga, checkpoint, 'CHECKPOINT_RECOVERY_BINDING_UNPROVEN'))
        continue
      }
      if (saga.phase === 'PREPARING' || saga.phase === 'ROLLBACK_CAPTURED') {
        saga.phase = 'FAILED_NO_CHANGE'
        saga.updatedAt = this.now()
        checkpoint.checkpoint = { ...checkpoint.checkpoint, status: 'AVAILABLE' }
        try {
          await this.persist()
          results.push(failedRolledBack())
        } catch {
          results.push(await this.markUnknown(saga, checkpoint, 'CHECKPOINT_RECOVERY_PERSIST_FAILED'))
        }
        continue
      }
      results.push(await this.rollback(saga, checkpoint))
    }
    return results
  }

  snapshotState(): CodingCheckpointPersistedStateV1 {
    return {
      schemaVersion: 1,
      checkpoints: [...this.checkpoints.values()].map(cloneCheckpointRecord),
      previews: [...this.previews.values()].map(clonePreviewRecord),
      sagas: [...this.sagas.values()].map(cloneSaga),
    }
  }

  private async executeRestore(
    checkpoint: PrivateCheckpointRecordV1,
    preview: PrivateRestorePreviewRecordV1,
  ): Promise<CodingCheckpointRestoreResultV1> {
    const saga: CodingCheckpointRestoreSagaV1 = {
      schemaVersion: 1,
      restoreId: this.idFactory('restore'),
      attemptId: checkpoint.checkpoint.attemptId,
      checkpointId: checkpoint.checkpoint.checkpointId,
      binding: checkpoint.binding,
      phase: 'PREPARING',
      updatedAt: this.now(),
    }
    this.sagas.set(saga.restoreId, saga)
    try {
      await this.persist()
      const rollbackSession = await this.sessions.capture({
        attemptId: saga.attemptId,
        sessionId: saga.binding.sessionId,
      })
      const rollbackWorkspace = await this.workspace.capture({
        attemptId: saga.attemptId,
        worktreeBindingDigest: saga.binding.worktreeBindingDigest,
      })
      assertSessionSnapshot(rollbackSession, saga.binding)
      assertWorkspaceSnapshot(rollbackWorkspace, saga.binding)
      if (
        rollbackSession.snapshotDigest !== preview.currentSessionDigest
        || rollbackWorkspace.snapshotDigest !== preview.currentWorkspaceDigest
        || rollbackWorkspace.baselineDigest !== preview.currentBaselineDigest
        || rollbackWorkspace.changeSummaryDigest !== preview.currentChangeSummaryDigest
      ) {
        saga.phase = 'FAILED_NO_CHANGE'
        saga.updatedAt = this.now()
        await this.persist()
        return failure('PREVIEW_STALE')
      }
      saga.rollbackSession = rollbackSession
      saga.rollbackWorkspace = rollbackWorkspace
      saga.phase = 'ROLLBACK_CAPTURED'
      saga.updatedAt = this.now()
      await this.persist()

      saga.phase = 'WORKTREE_RESTORE_STARTED'
      saga.updatedAt = this.now()
      await this.persist()
      const workspaceReceipt = await this.workspace.restore({
        attemptId: saga.attemptId,
        worktreeBindingDigest: saga.binding.worktreeBindingDigest,
        snapshotRef: checkpoint.workspaceTarget.snapshotRef,
        expectedDigest: checkpoint.workspaceTarget.snapshotDigest,
      })
      assertWorkspaceRestoreReceipt(workspaceReceipt, saga.binding, checkpoint.workspaceTarget.snapshotDigest)
      saga.phase = 'WORKTREE_RESTORED'
      saga.updatedAt = this.now()
      await this.persist()

      saga.phase = 'SESSION_RESTORE_STARTED'
      saga.updatedAt = this.now()
      await this.persist()
      const sessionReceipt = await this.sessions.restore({
        attemptId: saga.attemptId,
        sessionId: saga.binding.sessionId,
        snapshotRef: checkpoint.sessionTarget.snapshotRef,
        expectedDigest: checkpoint.sessionTarget.snapshotDigest,
      })
      assertSessionRestoreReceipt(sessionReceipt, saga.binding, checkpoint.sessionTarget.snapshotDigest)
      saga.phase = 'SESSION_RESTORED'
      saga.updatedAt = this.now()
      await this.persist()

      checkpoint.checkpoint = { ...checkpoint.checkpoint, status: 'RESTORED' }
      saga.phase = 'COMPLETED'
      saga.updatedAt = this.now()
      this.previews.delete(preview.preview.previewId)
      await this.persist()
      return { ok: true, outcome: 'RESTORED', checkpoint: { ...checkpoint.checkpoint } }
    } catch {
      if (saga.phase === 'PREPARING') {
        saga.phase = 'FAILED_NO_CHANGE'
        saga.updatedAt = this.now()
        await this.persistSafely()
        return failure('RESTORE_FAILED')
      }
      return await this.rollback(saga, checkpoint)
    }
  }

  private async rollback(
    saga: CodingCheckpointRestoreSagaV1,
    checkpoint: PrivateCheckpointRecordV1,
  ): Promise<CodingCheckpointRestoreResultV1> {
    if (!saga.rollbackSession || !saga.rollbackWorkspace) {
      return await this.markUnknown(saga, checkpoint, 'CHECKPOINT_ROLLBACK_SNAPSHOT_MISSING')
    }
    let sessionRestored = false
    let workspaceRestored = false
    try {
      const receipt = await this.sessions.restore({
        attemptId: saga.attemptId,
        sessionId: saga.binding.sessionId,
        snapshotRef: saga.rollbackSession.snapshotRef,
        expectedDigest: saga.rollbackSession.snapshotDigest,
      })
      assertSessionRestoreReceipt(receipt, saga.binding, saga.rollbackSession.snapshotDigest)
      sessionRestored = true
    } catch {
      sessionRestored = false
    }
    try {
      const receipt = await this.workspace.restore({
        attemptId: saga.attemptId,
        worktreeBindingDigest: saga.binding.worktreeBindingDigest,
        snapshotRef: saga.rollbackWorkspace.snapshotRef,
        expectedDigest: saga.rollbackWorkspace.snapshotDigest,
      })
      assertWorkspaceRestoreReceipt(receipt, saga.binding, saga.rollbackWorkspace.snapshotDigest)
      workspaceRestored = true
    } catch {
      workspaceRestored = false
    }
    if (!sessionRestored || !workspaceRestored) {
      return await this.markUnknown(saga, checkpoint, 'CHECKPOINT_ROLLBACK_INCOMPLETE')
    }

    checkpoint.checkpoint = { ...checkpoint.checkpoint, status: 'AVAILABLE' }
    saga.phase = 'FAILED_ROLLED_BACK'
    saga.updatedAt = this.now()
    try {
      await this.persist()
      return failedRolledBack()
    } catch {
      return await this.markUnknown(saga, checkpoint, 'CHECKPOINT_ROLLBACK_PERSIST_FAILED')
    }
  }

  private async markUnknown(
    saga: CodingCheckpointRestoreSagaV1,
    checkpoint: PrivateCheckpointRecordV1 | undefined,
    reasonCode: string,
  ): Promise<CodingCheckpointRestoreResultV1> {
    if (checkpoint) checkpoint.checkpoint = { ...checkpoint.checkpoint, status: 'INVALIDATED' }
    saga.phase = 'OUTCOME_UNKNOWN'
    saga.updatedAt = this.now()
    await this.persistSafely()
    try {
      await this.attempts.markOutcomeUnknown({ attemptId: saga.attemptId, reasonCode })
    } catch {
      // The module still remains fail-closed in private state; composition must
      // retry the authoritative TaskHub transition during its own recovery.
    }
    return unknownOutcome()
  }

  private async checkPreviewFreshness(
    preview: PrivateRestorePreviewRecordV1,
    checkpoint: PrivateCheckpointRecordV1,
  ): Promise<boolean> {
    try {
      const currentSession = await this.sessions.inspect({
        attemptId: preview.preview.attemptId,
        sessionId: preview.binding.sessionId,
      })
      const currentWorkspace = await this.workspace.inspect({
        attemptId: preview.preview.attemptId,
        worktreeBindingDigest: preview.binding.worktreeBindingDigest,
      })
      const workspaceRestorePreview = await this.workspace.previewRestore({
        attemptId: preview.preview.attemptId,
        worktreeBindingDigest: preview.binding.worktreeBindingDigest,
        snapshotRef: checkpoint.workspaceTarget.snapshotRef,
        expectedDigest: checkpoint.workspaceTarget.snapshotDigest,
      })
      assertSessionInspection(currentSession, preview.binding)
      assertWorkspaceInspection(currentWorkspace, preview.binding)
      assertWorkspaceRestorePreview(
        workspaceRestorePreview,
        preview.binding,
        checkpoint.workspaceTarget.snapshotDigest,
        currentWorkspace.snapshotDigest,
      )
      return currentSession.snapshotDigest === preview.currentSessionDigest
        && currentWorkspace.snapshotDigest === preview.currentWorkspaceDigest
        && currentWorkspace.baselineDigest === preview.currentBaselineDigest
        && currentWorkspace.changeSummaryDigest === preview.currentChangeSummaryDigest
        && workspaceRestorePreview.changeSummaryDigest === preview.workspacePreviewChangeSummaryDigest
        && payloadDigest(workspaceRestorePreview.changedRelativePaths) === preview.changedRelativePathsDigest
    } catch {
      return false
    }
  }

  private requireAvailableCheckpoint(input: {
    attemptId: string
    checkpointId: string
  }): { ok: true; record: PrivateCheckpointRecordV1 } | { ok: false; error: CodingCheckpointErrorV1 } {
    const record = this.checkpoints.get(input.checkpointId)
    if (!record || record.checkpoint.attemptId !== input.attemptId) return failure('CHECKPOINT_NOT_FOUND')
    if (record.checkpoint.status !== 'AVAILABLE') return failure('CHECKPOINT_UNAVAILABLE')
    return { ok: true, record }
  }

  private async requireIdleBinding(
    attemptId: string,
    expected?: AttemptCheckpointBindingV1,
  ): Promise<
    | { ok: true; binding: AttemptCheckpointBindingV1 }
    | { ok: false; error: CodingCheckpointErrorV1 }
  > {
    let binding: AttemptCheckpointBindingV1 | null
    try {
      binding = await this.attempts.inspect(attemptId)
    } catch {
      return failure('ATTEMPT_UNAVAILABLE')
    }
    if (!binding) return failure('ATTEMPT_NOT_FOUND')
    if (binding.attemptId !== attemptId) return failure('BINDING_MISMATCH')
    if (binding.state === 'BUSY') return failure('ATTEMPT_BUSY')
    if (binding.state !== 'IDLE') return failure('ATTEMPT_UNAVAILABLE')
    if (expected && (
      binding.sessionId !== expected.sessionId
      || binding.worktreeBindingDigest !== expected.worktreeBindingDigest
      || binding.authorityStatus !== expected.authorityStatus
    )) return failure('BINDING_MISMATCH')
    return { ok: true, binding: { ...binding } }
  }

  private async persist(): Promise<void> {
    await this.persistState(this.snapshotState())
  }

  private async persistSafely(): Promise<void> {
    try {
      await this.persist()
    } catch {
      // The caller already degrades to a fail-closed result.
    }
  }
}

function recomputePreviewDigest(
  record: PrivateRestorePreviewRecordV1,
  checkpoint: PrivateCheckpointRecordV1,
): string {
  return payloadDigest({
    previewId: record.preview.previewId,
    checkpointId: record.preview.checkpointId,
    attemptId: record.preview.attemptId,
    sessionId: record.binding.sessionId,
    worktreeBindingDigest: record.binding.worktreeBindingDigest,
    targetSessionDigest: checkpoint.sessionTarget.snapshotDigest,
    targetWorkspaceDigest: checkpoint.workspaceTarget.snapshotDigest,
    currentSessionDigest: record.currentSessionDigest,
    currentWorkspaceDigest: record.currentWorkspaceDigest,
    currentBaselineDigest: record.currentBaselineDigest,
    currentChangeSummaryDigest: record.currentChangeSummaryDigest,
    workspacePreviewChangeSummaryDigest: record.workspacePreviewChangeSummaryDigest,
    changedRelativePathsDigest: record.changedRelativePathsDigest,
    expiresAt: record.preview.expiresAt,
  })
}

function payloadDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function failure<T extends CodingCheckpointErrorCodeV1>(code: T): {
  readonly ok: false
  readonly error: { readonly code: T }
} {
  return { ok: false, error: { code } }
}

function failedRolledBack(): CodingCheckpointRestoreResultV1 {
  return {
    ok: false,
    outcome: 'FAILED_ROLLED_BACK',
    error: { code: 'RESTORE_FAILED' },
  }
}

function unknownOutcome(): CodingCheckpointRestoreResultV1 {
  return {
    ok: false,
    outcome: 'OUTCOME_UNKNOWN',
    error: { code: 'OUTCOME_UNKNOWN' },
  }
}

function assertSessionSnapshot(
  snapshot: PiSessionCheckpointSnapshotV1,
  binding: AttemptCheckpointBindingV1,
): void {
  assertSessionInspection(snapshot, binding)
  if (!snapshot.snapshotRef) throw new Error('PI_SESSION_SNAPSHOT_REF_MISSING')
}

function assertSessionInspection(
  snapshot: Omit<PiSessionCheckpointSnapshotV1, 'snapshotRef'>,
  binding: AttemptCheckpointBindingV1,
): void {
  if (
    snapshot.attemptId !== binding.attemptId
    || snapshot.sessionId !== binding.sessionId
    || !snapshot.snapshotDigest
  ) throw new Error('PI_SESSION_CHECKPOINT_BINDING_MISMATCH')
}

function assertWorkspaceSnapshot(
  snapshot: AttemptWorkspaceCheckpointSnapshotV1,
  binding: AttemptCheckpointBindingV1,
): void {
  assertWorkspaceInspection(snapshot, binding)
  if (!snapshot.snapshotRef) throw new Error('WORKSPACE_SNAPSHOT_REF_MISSING')
}

function assertWorkspaceInspection(
  snapshot: Omit<AttemptWorkspaceCheckpointSnapshotV1, 'snapshotRef'>,
  binding: AttemptCheckpointBindingV1,
): void {
  if (
    snapshot.attemptId !== binding.attemptId
    || snapshot.worktreeBindingDigest !== binding.worktreeBindingDigest
    || !snapshot.snapshotDigest
    || !snapshot.baselineDigest
    || !snapshot.changeSummaryDigest
  ) throw new Error('WORKSPACE_CHECKPOINT_BINDING_MISMATCH')
}

function assertWorkspaceRestorePreview(
  preview: AttemptWorkspaceCheckpointRestorePreviewV1,
  binding: AttemptCheckpointBindingV1,
  targetSnapshotDigest: string,
  currentSnapshotDigest: string,
): void {
  if (
    preview.schemaVersion !== 1
    || preview.attemptId !== binding.attemptId
    || preview.worktreeBindingDigest !== binding.worktreeBindingDigest
    || preview.targetSnapshotDigest !== targetSnapshotDigest
    || preview.currentSnapshotDigest !== currentSnapshotDigest
    || !Number.isSafeInteger(preview.changeCount)
    || preview.changeCount < 0
    || preview.changeCount !== preview.changedRelativePaths.length
    || !preview.changeSummaryDigest
  ) throw new Error('WORKSPACE_RESTORE_PREVIEW_UNPROVEN')
  const unique = new Set<string>()
  for (const relativePath of preview.changedRelativePaths) {
    if (!isSafePreviewRelativePath(relativePath) || unique.has(relativePath)) {
      throw new Error('WORKSPACE_RESTORE_PREVIEW_PATH_INVALID')
    }
    unique.add(relativePath)
  }

}

function isSafePreviewRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || !value
    || value.length > PUBLIC_PREVIEW_PATH_LENGTH_LIMIT
    || value.includes('\0')
    || value.includes('\\')
    || value.includes(':')
    || isAbsolute(value)
    || posix.isAbsolute(value)
    || win32.isAbsolute(value)
  ) return false
  const normalized = posix.normalize(value)
  return normalized === value
    && normalized !== '.'
    && normalized !== '..'
    && !normalized.startsWith('../')
    && normalized !== '.git'
    && !normalized.startsWith('.git/')
}

function assertSessionRestoreReceipt(
  receipt: { attemptId: string; sessionId: string; restoredSnapshotDigest: string },
  binding: AttemptCheckpointBindingV1,
  expectedDigest: string,
): void {
  if (
    receipt.attemptId !== binding.attemptId
    || receipt.sessionId !== binding.sessionId
    || receipt.restoredSnapshotDigest !== expectedDigest
  ) throw new Error('PI_SESSION_RESTORE_UNPROVEN')
}

function assertWorkspaceRestoreReceipt(
  receipt: { attemptId: string; worktreeBindingDigest: string; restoredSnapshotDigest: string },
  binding: AttemptCheckpointBindingV1,
  expectedDigest: string,
): void {
  if (
    receipt.attemptId !== binding.attemptId
    || receipt.worktreeBindingDigest !== binding.worktreeBindingDigest
    || receipt.restoredSnapshotDigest !== expectedDigest
  ) throw new Error('WORKSPACE_RESTORE_UNPROVEN')
}

function cloneCheckpointRecord(record: PrivateCheckpointRecordV1): PrivateCheckpointRecordV1 {
  return {
    schemaVersion: 1,
    checkpoint: { ...record.checkpoint },
    binding: { ...record.binding },
    sessionTarget: { ...record.sessionTarget },
    workspaceTarget: { ...record.workspaceTarget },
  }
}

function clonePreviewRecord(record: PrivateRestorePreviewRecordV1): PrivateRestorePreviewRecordV1 {
  return {
    schemaVersion: 1,
    preview: { ...record.preview },
    binding: { ...record.binding },
    currentSessionDigest: record.currentSessionDigest,
    currentWorkspaceDigest: record.currentWorkspaceDigest,
    currentBaselineDigest: record.currentBaselineDigest,
    currentChangeSummaryDigest: record.currentChangeSummaryDigest,
    workspacePreviewChangeSummaryDigest: record.workspacePreviewChangeSummaryDigest,
    changedRelativePathsDigest: record.changedRelativePathsDigest,
  }
}

function cloneSaga(saga: CodingCheckpointRestoreSagaV1): CodingCheckpointRestoreSagaV1 {
  return {
    ...saga,
    binding: { ...saga.binding },
    rollbackSession: saga.rollbackSession ? { ...saga.rollbackSession } : undefined,
    rollbackWorkspace: saga.rollbackWorkspace ? { ...saga.rollbackWorkspace } : undefined,
  }
}
