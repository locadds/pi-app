import { describe, expect, it, vi } from 'vitest'

import {
  CodingCheckpointModuleV1,
  type AttemptCheckpointBindingV1,
  type AttemptCheckpointWorkspacePort,
  type AttemptCheckpointabilityPort,
  type AttemptWorkspaceCheckpointSnapshotV1,
  type PiSessionCheckpointPort,
  type PiSessionCheckpointSnapshotV1,
} from './checkpoint-module'

const digest = (character: string): string => `sha256:${character.repeat(64)}`

class ScriptedAttemptPort implements AttemptCheckpointabilityPort {
  binding: AttemptCheckpointBindingV1 | null = {
    attemptId: 'xhba_attempt_1',
    sessionId: 'pi_session_1',
    worktreeBindingDigest: digest('a'),
    state: 'IDLE',
    authorityStatus: 'READY',
  }
  readonly unknownReasons: string[] = []

  async inspect(): Promise<AttemptCheckpointBindingV1 | null> {
    return this.binding
  }

  async markOutcomeUnknown(input: { attemptId: string; reasonCode: string }): Promise<void> {
    this.unknownReasons.push(input.reasonCode)
  }
}

class ScriptedSessionPort implements PiSessionCheckpointPort {
  currentDigest = digest('b')
  readonly trace: string[] = []
  failTargetRestore = false
  failRollbackRestore = false

  async inspect(input: { attemptId: string; sessionId: string }) {
    return {
      ...input,
      snapshotDigest: this.currentDigest,
    }
  }

  async capture(input: { attemptId: string; sessionId: string }): Promise<PiSessionCheckpointSnapshotV1> {
    this.trace.push(`session.capture:${this.currentDigest}`)
    return {
      ...input,
      snapshotRef: `session-ref:${this.currentDigest}`,
      snapshotDigest: this.currentDigest,
    }
  }

  async restore(input: {
    attemptId: string
    sessionId: string
    snapshotRef: string
    expectedDigest: string
  }) {
    this.trace.push(`session.restore:${input.expectedDigest}`)
    if (input.expectedDigest === digest('1') && this.failTargetRestore) {
      this.failTargetRestore = false
      throw new Error('target session restore failed after a partial write')
    }
    if (input.expectedDigest === digest('b') && this.failRollbackRestore) {
      throw new Error('session rollback failed')
    }
    this.currentDigest = input.expectedDigest
    return {
      attemptId: input.attemptId,
      sessionId: input.sessionId,
      restoredSnapshotDigest: input.expectedDigest,
    }
  }
}

class ScriptedWorkspacePort implements AttemptCheckpointWorkspacePort {
  currentDigest = digest('c')
  currentBaselineDigest = digest('d')
  currentChangeDigest = digest('e')
  readonly trace: string[] = []
  changedRelativePaths: string[] = ['src/a.ts', 'src/b.ts']
  failRollbackRestore = false

  async inspect(input: { attemptId: string; worktreeBindingDigest: string }) {
    return {
      ...input,
      snapshotDigest: this.currentDigest,
      baselineDigest: this.currentBaselineDigest,
      changeSummaryDigest: this.currentChangeDigest,
    }
  }

  async capture(input: {
    attemptId: string
    worktreeBindingDigest: string
  }): Promise<AttemptWorkspaceCheckpointSnapshotV1> {
    this.trace.push(`workspace.capture:${this.currentDigest}`)
    return {
      ...input,
      snapshotRef: `workspace-ref:${this.currentDigest}`,
      snapshotDigest: this.currentDigest,
      baselineDigest: this.currentBaselineDigest,
      changeSummaryDigest: this.currentChangeDigest,
    }
  }

  async previewRestore(input: {
    attemptId: string
    worktreeBindingDigest: string
    snapshotRef: string
    expectedDigest: string
  }) {
    this.trace.push(`workspace.preview:${input.expectedDigest}`)
    return {
      schemaVersion: 1 as const,
      attemptId: input.attemptId,
      worktreeBindingDigest: input.worktreeBindingDigest,
      targetSnapshotDigest: input.expectedDigest,
      currentSnapshotDigest: this.currentDigest,
      changedRelativePaths: [...this.changedRelativePaths],
      changeCount: this.changedRelativePaths.length,
      changeSummaryDigest: digest('f'),
    }
  }

  async restore(input: {
    attemptId: string
    worktreeBindingDigest: string
    snapshotRef: string
    expectedDigest: string
  }) {
    this.trace.push(`workspace.restore:${input.expectedDigest}`)
    if (input.expectedDigest === digest('c') && this.failRollbackRestore) {
      throw new Error('workspace rollback failed')
    }
    this.currentDigest = input.expectedDigest
    return {
      attemptId: input.attemptId,
      worktreeBindingDigest: input.worktreeBindingDigest,
      restoredSnapshotDigest: input.expectedDigest,
    }
  }
}

function createFixture(now = 1_000) {
  const attempts = new ScriptedAttemptPort()
  const sessions = new ScriptedSessionPort()
  const workspace = new ScriptedWorkspacePort()
  let clock = now
  let sequence = 0
  const module = new CodingCheckpointModuleV1({
    attempts,
    sessions,
    workspace,
    now: () => clock,
    idFactory: (prefix) => `${prefix}_${++sequence}`,
    previewTtlMs: 100,
  })
  return {
    attempts,
    sessions,
    workspace,
    module,
    setNow(value: number) { clock = value },
  }
}

async function captureTarget(fixture: ReturnType<typeof createFixture>) {
  fixture.sessions.currentDigest = digest('1')
  fixture.workspace.currentDigest = digest('2')
  fixture.workspace.currentBaselineDigest = digest('3')
  fixture.workspace.currentChangeDigest = digest('4')
  const result = await fixture.module.capture({
    attemptId: 'xhba_attempt_1',
    checkpointId: 'checkpoint_1',
  })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.code)

  fixture.sessions.currentDigest = digest('b')
  fixture.workspace.currentDigest = digest('c')
  fixture.workspace.currentBaselineDigest = digest('d')
  fixture.workspace.currentChangeDigest = digest('e')
  return result.checkpoint
}

describe('CodingCheckpointModuleV1', () => {
  it('captures only an idle Attempt and exposes digests rather than private snapshot references', async () => {
    const fixture = createFixture()
    const checkpoint = await captureTarget(fixture)

    expect(checkpoint).toEqual({
      schemaVersion: 1,
      checkpointId: 'checkpoint_1',
      attemptId: 'xhba_attempt_1',
      sessionCheckpointDigest: digest('1'),
      worktreeBaselineDigest: digest('3'),
      changeSummaryDigest: digest('4'),
      status: 'AVAILABLE',
    })
    expect(JSON.stringify(checkpoint)).not.toContain('session-ref')
    expect(JSON.stringify(checkpoint)).not.toContain('workspace-ref')
  })

  it('rejects an expired restore preview and never mutates either surface', async () => {
    const fixture = createFixture()
    await captureTarget(fixture)
    const preview = await fixture.module.prepareRestore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
    })
    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error(preview.error.code)

    fixture.setNow(1_101)
    const restored = await fixture.module.restore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
      previewId: preview.preview.previewId,
      previewDigest: preview.preview.previewDigest,
    })

    expect(restored).toEqual({
      ok: false,
      error: { code: 'PREVIEW_EXPIRED' },
    })
    expect(fixture.workspace.trace.filter((entry) => entry.startsWith('workspace.restore'))).toEqual([])
    expect(fixture.sessions.trace.filter((entry) => entry.startsWith('session.restore'))).toEqual([])
  })

  it('returns a bounded readable preview and keeps private state digests out of it', async () => {
    const fixture = createFixture()
    await captureTarget(fixture)
    fixture.workspace.changedRelativePaths = Array.from(
      { length: 102 },
      (_, index) => `src/generated/file-${String(index).padStart(3, '0')}.ts`,
    )

    const prepared = await fixture.module.prepareRestore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
    })

    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.error.code)
    expect(prepared.preview).toMatchObject({
      changedRelativePaths: expect.arrayContaining(['src/generated/file-000.ts']),
      changeCount: 102,
      truncated: true,
      sessionImpact: '对话将回到此检查点',
      previewDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(prepared.preview.changedRelativePaths).toHaveLength(100)
    expect(Object.keys(prepared.preview).filter((key) => key.toLowerCase().includes('digest')))
      .toEqual(['previewDigest'])
  })

  it('fails closed while the Attempt is busy', async () => {
    const fixture = createFixture()
    fixture.attempts.binding = {
      ...fixture.attempts.binding!,
      state: 'BUSY',
    }

    await expect(fixture.module.capture({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
    })).resolves.toEqual({
      ok: false,
      error: { code: 'ATTEMPT_BUSY' },
    })
    expect(fixture.sessions.trace).toEqual([])
    expect(fixture.workspace.trace).toEqual([])
  })

  it('rejects a different session or worktree binding before restore', async () => {
    const fixture = createFixture()
    await captureTarget(fixture)
    fixture.attempts.binding = {
      ...fixture.attempts.binding!,
      sessionId: 'pi_session_other',
    }

    await expect(fixture.module.prepareRestore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
    })).resolves.toEqual({
      ok: false,
      error: { code: 'BINDING_MISMATCH' },
    })
  })

  it('does not restore a READY checkpoint after the Attempt becomes SUCCEEDED', async () => {
    const fixture = createFixture()
    await captureTarget(fixture)
    fixture.attempts.binding = {
      ...fixture.attempts.binding!,
      authorityStatus: 'SUCCEEDED',
    }

    await expect(fixture.module.prepareRestore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
    })).resolves.toEqual({
      ok: false,
      error: { code: 'BINDING_MISMATCH' },
    })
  })

  it('requires the exact preview digest and rechecks that current state is unchanged', async () => {
    const fixture = createFixture()
    await captureTarget(fixture)
    const prepared = await fixture.module.prepareRestore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.error.code)

    await expect(fixture.module.restore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
      previewId: prepared.preview.previewId,
      previewDigest: digest('f'),
    })).resolves.toEqual({
      ok: false,
      error: { code: 'PREVIEW_DIGEST_MISMATCH' },
    })

    fixture.workspace.currentDigest = digest('9')
    await expect(fixture.module.restore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
      previewId: prepared.preview.previewId,
      previewDigest: prepared.preview.previewDigest,
    })).resolves.toEqual({
      ok: false,
      error: { code: 'PREVIEW_STALE' },
    })
  })

  it('rolls both surfaces back when the second restore step fails', async () => {
    const fixture = createFixture()
    await captureTarget(fixture)
    const prepared = await fixture.module.prepareRestore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.error.code)
    fixture.sessions.failTargetRestore = true

    const result = await fixture.module.restore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
      previewId: prepared.preview.previewId,
      previewDigest: prepared.preview.previewDigest,
    })

    expect(result).toEqual({
      ok: false,
      outcome: 'FAILED_ROLLED_BACK',
      error: { code: 'RESTORE_FAILED' },
    })
    expect(fixture.workspace.currentDigest).toBe(digest('c'))
    expect(fixture.sessions.currentDigest).toBe(digest('b'))
    expect(fixture.workspace.trace).toContain(`workspace.restore:${digest('2')}`)
    expect(fixture.workspace.trace).toContain(`workspace.restore:${digest('c')}`)
    expect(fixture.sessions.trace).toContain(`session.restore:${digest('1')}`)
    expect(fixture.sessions.trace).toContain(`session.restore:${digest('b')}`)
    expect(fixture.attempts.unknownReasons).toEqual([])
  })

  it('marks OUTCOME_UNKNOWN when complete rollback cannot be proven', async () => {
    const fixture = createFixture()
    await captureTarget(fixture)
    const prepared = await fixture.module.prepareRestore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.error.code)
    fixture.sessions.failTargetRestore = true
    fixture.workspace.failRollbackRestore = true

    await expect(fixture.module.restore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
      previewId: prepared.preview.previewId,
      previewDigest: prepared.preview.previewDigest,
    })).resolves.toEqual({
      ok: false,
      outcome: 'OUTCOME_UNKNOWN',
      error: { code: 'OUTCOME_UNKNOWN' },
    })
    expect(fixture.attempts.unknownReasons).toEqual(['CHECKPOINT_ROLLBACK_INCOMPLETE'])
  })

  it('recovers an interrupted persisted saga by rolling back and never continuing forward', async () => {
    const fixture = createFixture()
    await captureTarget(fixture)
    const prepared = await fixture.module.prepareRestore({
      attemptId: 'xhba_attempt_1',
      checkpointId: 'checkpoint_1',
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.error.code)

    const firstState = fixture.module.snapshotState()
    const target = firstState.checkpoints[0]
    const restartState = {
      ...firstState,
      sagas: [{
        schemaVersion: 1 as const,
        restoreId: 'restore_interrupted',
        attemptId: 'xhba_attempt_1',
        checkpointId: 'checkpoint_1',
        binding: target.binding,
        phase: 'SESSION_RESTORE_STARTED' as const,
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
    fixture.workspace.currentDigest = digest('2')
    const restarted = new CodingCheckpointModuleV1({
      attempts: fixture.attempts,
      sessions: fixture.sessions,
      workspace: fixture.workspace,
      persistedState: restartState,
      now: () => 2_000,
      idFactory: (prefix) => `${prefix}_restart`,
    })

    await expect(restarted.recover()).resolves.toEqual([{
      ok: false,
      outcome: 'FAILED_ROLLED_BACK',
      error: { code: 'RESTORE_FAILED' },
    }])
    expect(fixture.workspace.currentDigest).toBe(digest('c'))
    expect(fixture.sessions.currentDigest).toBe(digest('b'))
    expect(fixture.workspace.trace).not.toContain(`workspace.restore:${digest('2')}`)
  })

  it('retries the authoritative OUTCOME_UNKNOWN transition after restart', async () => {
    const fixture = createFixture()
    await captureTarget(fixture)
    const state = fixture.module.snapshotState()
    const checkpoint = state.checkpoints[0]
    const restarted = new CodingCheckpointModuleV1({
      attempts: fixture.attempts,
      sessions: fixture.sessions,
      workspace: fixture.workspace,
      persistedState: {
        ...state,
        sagas: [{
          schemaVersion: 1,
          restoreId: 'restore_unknown',
          attemptId: checkpoint.checkpoint.attemptId,
          checkpointId: checkpoint.checkpoint.checkpointId,
          binding: checkpoint.binding,
          phase: 'OUTCOME_UNKNOWN',
          updatedAt: 2_000,
        }],
      },
    })

    await expect(restarted.recover()).resolves.toEqual([{
      ok: false,
      outcome: 'OUTCOME_UNKNOWN',
      error: { code: 'OUTCOME_UNKNOWN' },
    }])
    expect(fixture.attempts.unknownReasons).toEqual(['CHECKPOINT_RECOVERY_OUTCOME_UNKNOWN'])
  })
})
