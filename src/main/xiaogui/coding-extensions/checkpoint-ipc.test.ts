import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
  XIAOGUI_CODING_CHECKPOINT_SESSION_IMPACT_V1,
} from '@shared/xiaogui-coding-checkpoint-control'
import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'

import type { CodingCheckpointModuleV1 } from './checkpoint-module'

const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()

vi.mock('../../ipc/registry', () => ({
  registerHandler: vi.fn((channel: string, handler: (payload: unknown) => Promise<unknown>) => {
    handlers.set(channel, handler)
  }),
}))

import { registerCodingCheckpointHandlersV1 } from './checkpoint-ipc'

const ADDRESS = {
  projectId: `xgp1_${'a'.repeat(64)}`,
  sessionKey: `xgs1_${'b'.repeat(64)}`,
} as HubAddressV1
const DIGEST = (value: string): string => `sha256:${value.repeat(64)}`
const CHECKPOINT = {
  schemaVersion: 1 as const,
  checkpointId: 'checkpoint_1',
  attemptId: 'attempt_1',
  sessionCheckpointDigest: DIGEST('1'),
  worktreeBaselineDigest: DIGEST('2'),
  changeSummaryDigest: DIGEST('3'),
  status: 'AVAILABLE' as const,
}
const PREVIEW = {
  schemaVersion: 1 as const,
  previewId: 'preview_1',
  checkpointId: CHECKPOINT.checkpointId,
  attemptId: CHECKPOINT.attemptId,
  changedRelativePaths: ['src/a.ts', 'src/b.ts'],
  changeCount: 2,
  truncated: false,
  sessionImpact: XIAOGUI_CODING_CHECKPOINT_SESSION_IMPACT_V1,
  previewDigest: DIGEST('4'),
  expiresAt: 1_000,
}

function scope(inScope = true) {
  return {
    isCodingSession: vi.fn(() => inScope),
    hasAttempt: vi.fn(() => inScope),
  }
}

function checkpointModule(overrides: Partial<Pick<
  CodingCheckpointModuleV1,
  'list' | 'capture' | 'prepareRestore' | 'restore'
>> = {}) {
  return {
    list: vi.fn(() => [CHECKPOINT]),
    capture: vi.fn(async () => ({ ok: true as const, checkpoint: CHECKPOINT })),
    prepareRestore: vi.fn(async () => ({ ok: true as const, preview: PREVIEW })),
    restore: vi.fn(async () => ({
      ok: true as const,
      outcome: 'RESTORED' as const,
      checkpoint: { ...CHECKPOINT, status: 'RESTORED' as const },
    })),
    ...overrides,
  }
}

describe('CODING checkpoint IPC', () => {
  beforeEach(() => handlers.clear())

  it('lists persisted checkpoints after restart without exposing private snapshot data', async () => {
    const checkpoint = checkpointModule()
    registerCodingCheckpointHandlersV1({ checkpoint, scope: scope() })
    const outcome = await handlers.get('ipc:xiaogui.coding.checkpoint.list')!({
      contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
      address: ADDRESS,
      attemptId: CHECKPOINT.attemptId,
    })
    expect(outcome).toEqual({
      ok: true,
      value: {
        contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
        checkpoints: [{
          schemaVersion: 1,
          checkpointId: CHECKPOINT.checkpointId,
          attemptId: CHECKPOINT.attemptId,
          status: 'AVAILABLE',
        }],
      },
    })
    expect(JSON.stringify(outcome)).not.toContain(CHECKPOINT.sessionCheckpointDigest)
  })

  it('creates a Main-owned checkpoint id and returns only the public digest projection', async () => {
    const checkpoint = checkpointModule()
    registerCodingCheckpointHandlersV1({
      checkpoint,
      scope: scope(),
      checkpointIdFactory: () => 'checkpoint_1',
    })

    const outcome = await handlers.get('ipc:xiaogui.coding.checkpoint.capture')!({
      contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
      address: ADDRESS,
      attemptId: CHECKPOINT.attemptId,
    })

    expect(checkpoint.capture).toHaveBeenCalledWith({
      attemptId: CHECKPOINT.attemptId,
      checkpointId: CHECKPOINT.checkpointId,
    })
    expect(outcome).toEqual({
      ok: true,
      value: {
        contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
        checkpoint: {
          schemaVersion: 1,
          checkpointId: CHECKPOINT.checkpointId,
          attemptId: CHECKPOINT.attemptId,
          status: 'AVAILABLE',
        },
      },
    })
    expect(JSON.stringify(outcome)).not.toMatch(/[A-Z]:[\\/]/)
    expect(JSON.stringify(outcome)).not.toContain('snapshotRef')
    expect(JSON.stringify(outcome)).not.toContain(CHECKPOINT.sessionCheckpointDigest)
  })

  it('previews and confirms exactly the same digest without exposing private binding data', async () => {
    const checkpoint = checkpointModule()
    registerCodingCheckpointHandlersV1({ checkpoint, scope: scope() })

    const previewOutcome = await handlers.get('ipc:xiaogui.coding.checkpoint.restore.preview')!({
      contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
      address: ADDRESS,
      attemptId: CHECKPOINT.attemptId,
      checkpointId: CHECKPOINT.checkpointId,
    })
    expect(previewOutcome).toEqual({
      ok: true,
      value: {
        contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
        preview: PREVIEW,
      },
    })

    const confirmOutcome = await handlers.get('ipc:xiaogui.coding.checkpoint.restore.confirm')!({
      contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
      address: ADDRESS,
      attemptId: CHECKPOINT.attemptId,
      checkpointId: CHECKPOINT.checkpointId,
      previewId: PREVIEW.previewId,
      previewDigest: PREVIEW.previewDigest,
    })
    expect(checkpoint.restore).toHaveBeenCalledWith({
      attemptId: CHECKPOINT.attemptId,
      checkpointId: CHECKPOINT.checkpointId,
      previewId: PREVIEW.previewId,
      previewDigest: PREVIEW.previewDigest,
    })
    expect(confirmOutcome).toMatchObject({
      ok: true,
      value: { outcome: 'RESTORED', checkpoint: { status: 'RESTORED' } },
    })
    expect(JSON.stringify([previewOutcome, confirmOutcome])).not.toMatch(/sessionFile|worktreeRoot|snapshotRef|messageBody|leaf/i)
    expect(Object.keys((previewOutcome as { value: { preview: object } }).value.preview)
      .filter((key) => key.toLowerCase().includes('digest'))).toEqual(['previewDigest'])
    expect(JSON.stringify(confirmOutcome)).not.toContain(CHECKPOINT.sessionCheckpointDigest)
  })

  it('fails closed when real ports are not composed or the Attempt is outside the session', async () => {
    registerCodingCheckpointHandlersV1({ checkpoint: undefined, scope: scope() })
    const capture = handlers.get('ipc:xiaogui.coding.checkpoint.capture')!
    await expect(capture({
      contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
      address: ADDRESS,
      attemptId: CHECKPOINT.attemptId,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CHECKPOINT_RUNTIME_UNAVAILABLE' },
    })

    handlers.clear()
    const outOfScopeModule = checkpointModule()
    registerCodingCheckpointHandlersV1({ checkpoint: outOfScopeModule, scope: scope(false) })
    await expect(handlers.get('ipc:xiaogui.coding.checkpoint.capture')!({
      contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
      address: ADDRESS,
      attemptId: CHECKPOINT.attemptId,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'SESSION_SCOPE_MISMATCH' },
    })
    expect(outOfScopeModule.capture).not.toHaveBeenCalled()
  })

  it('rejects malformed or stale confirmation payloads before restore', async () => {
    const restore = vi.fn(async () => ({
      ok: true as const,
      outcome: 'RESTORED' as const,
      checkpoint: { ...CHECKPOINT, status: 'RESTORED' as const },
    }))
    const checkpoint = checkpointModule({ restore })
    registerCodingCheckpointHandlersV1({ checkpoint, scope: scope() })
    const confirm = handlers.get('ipc:xiaogui.coding.checkpoint.restore.confirm')!

    await expect(confirm({
      contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
      address: ADDRESS,
      attemptId: CHECKPOINT.attemptId,
      checkpointId: CHECKPOINT.checkpointId,
      previewId: PREVIEW.previewId,
      previewDigest: 'not-a-digest',
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(checkpoint.restore).not.toHaveBeenCalled()

    restore.mockResolvedValueOnce({
      ok: false,
      error: { code: 'PREVIEW_EXPIRED' },
    } as never)
    await expect(confirm({
      contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
      address: ADDRESS,
      attemptId: CHECKPOINT.attemptId,
      checkpointId: CHECKPOINT.checkpointId,
      previewId: PREVIEW.previewId,
      previewDigest: PREVIEW.previewDigest,
    })).resolves.toEqual({
      ok: false,
      error: {
        code: 'PREVIEW_EXPIRED',
        messageKey: 'xiaogui.coding.checkpoint.preview_expired',
      },
    })
  })

  it('maps thrown private errors to one safe unavailable result', async () => {
    const capture = vi.fn(async () => {
      throw new Error('D:\\private\\attempt-worktree\\secret.ts')
    })
    registerCodingCheckpointHandlersV1({
      checkpoint: checkpointModule({ capture }),
      scope: scope(),
    })

    const outcome = await handlers.get('ipc:xiaogui.coding.checkpoint.capture')!({
      contractVersion: XIAOGUI_CODING_CHECKPOINT_CONTROL_VERSION_V1,
      address: ADDRESS,
      attemptId: CHECKPOINT.attemptId,
    })
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'CHECKPOINT_RUNTIME_UNAVAILABLE',
        messageKey: 'xiaogui.coding.checkpoint.checkpoint_runtime_unavailable',
      },
    })
    expect(JSON.stringify(outcome)).not.toContain('private')
  })
})
