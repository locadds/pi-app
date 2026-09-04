import { beforeEach, describe, expect, it, vi } from 'vitest'

import { XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2 } from '@shared/xiaogui-direct-coding'
import type { ProjectId, SessionKey } from '@shared/xiaogui-session-scope'

const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()

vi.mock('../../ipc/registry', () => ({
  registerHandler: vi.fn((channel: string, handler: (payload: unknown) => Promise<unknown>) => {
    handlers.set(channel, handler)
  }),
}))

import { registerDirectCodingCheckpointHandlersV2 } from './direct-coding-checkpoint-ipc'

const address = {
  projectId: `xgp1_${'a'.repeat(64)}` as ProjectId,
  sessionKey: `xgs1_${'b'.repeat(64)}` as SessionKey,
}

describe('direct CODING checkpoint V2 IPC', () => {
  beforeEach(() => handlers.clear())

  it('binds the public address to a CODING subject without inventing an Attempt', async () => {
    const module = {
      list: vi.fn(() => ({
        ok: true as const,
        value: {
          contractVersion: XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2,
          checkpoints: [],
        },
      })),
      prepareRestore: vi.fn(),
      confirmRestore: vi.fn(),
    }
    const scope = {
      lookup: vi.fn(async () => ({
        kind: 'FOUND' as const,
        scope: { ...address, sessionMode: 'CODING' as const },
      })),
    }
    registerDirectCodingCheckpointHandlersV2({
      module: module as never,
      scope,
      resolveCurrentRoot: vi.fn(async () => 'D:\\project'),
    })

    await expect(handlers.get('ipc:xiaogui.coding.direct.checkpoint.list')!({
      contractVersion: XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2,
      address,
    })).resolves.toMatchObject({ ok: true, value: { checkpoints: [] } })
    expect(module.list).toHaveBeenCalledWith({
      schemaVersion: 2,
      kind: 'DIRECT_SESSION',
      address: { ...address, sessionMode: 'CODING' },
    })
    expect(JSON.stringify(module.list.mock.calls)).not.toContain('attemptId')
  })

  it('rejects TaskHub fields and a non-CODING address before module access', async () => {
    const module = {
      list: vi.fn(),
      prepareRestore: vi.fn(),
      confirmRestore: vi.fn(),
    }
    const scope = {
      lookup: vi.fn(async () => ({
        kind: 'FOUND' as const,
        scope: { ...address, sessionMode: 'WORK' as const },
      })),
    }
    registerDirectCodingCheckpointHandlersV2({
      module: module as never,
      scope,
      resolveCurrentRoot: vi.fn(async () => null),
    })
    const list = handlers.get('ipc:xiaogui.coding.direct.checkpoint.list')!

    await expect(list({
      contractVersion: XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2,
      address,
      attemptId: 'forged-attempt',
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    await expect(list({
      contractVersion: XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2,
      address,
    })).resolves.toMatchObject({ ok: false, error: { code: 'SESSION_SCOPE_MISMATCH' } })
    expect(module.list).not.toHaveBeenCalled()
  })

  it('binds restore to the current Main-owned project root', async () => {
    const module = {
      list: vi.fn(),
      prepareRestore: vi.fn(() => ({
        ok: false as const,
        error: { code: 'CHECKPOINT_CONFLICT' as const, messageKey: 'root.changed' },
      })),
      confirmRestore: vi.fn(),
    }
    const scope = {
      lookup: vi.fn(async () => ({
        kind: 'FOUND' as const,
        scope: { ...address, sessionMode: 'CODING' as const },
      })),
    }
    const resolveCurrentRoot = vi.fn(async () => 'D:\\current-project')
    registerDirectCodingCheckpointHandlersV2({
      module: module as never,
      scope,
      resolveCurrentRoot,
    })

    await expect(handlers.get('ipc:xiaogui.coding.direct.checkpoint.restore.preview')!({
      contractVersion: XIAOGUI_DIRECT_CODING_CONTRACT_VERSION_V2,
      address,
      checkpointToken: 'xdcp_token-0001',
    })).resolves.toMatchObject({ ok: false, error: { code: 'CHECKPOINT_CONFLICT' } })
    expect(resolveCurrentRoot).toHaveBeenCalledWith(address)
    expect(module.prepareRestore).toHaveBeenCalledWith(
      {
        schemaVersion: 2,
        kind: 'DIRECT_SESSION',
        address: { ...address, sessionMode: 'CODING' },
      },
      'D:\\current-project',
      'xdcp_token-0001',
    )
  })
})
