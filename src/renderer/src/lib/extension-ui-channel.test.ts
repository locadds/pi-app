import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissExtensionDialogState, parseExtensionUIRequestV1 } from './extension-ui-channel'
import { useExtensionUIStore } from '@renderer/stores/extension-ui-store'

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn(async () => ({})) },
  onExtensionUIRequest: vi.fn(),
  onExtensionUIDismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn() } }))
vi.mock('@renderer/lib/desktop-alerts', () => ({ signalDesktopAlert: vi.fn() }))
vi.mock('@renderer/lib/audio-trace', () => ({ traceAudioRenderer: vi.fn() }))
vi.mock('@renderer/lib/alert-trace', () => ({ alertTrace: vi.fn() }))
vi.mock('@renderer/lib/extension-ui-tool-sync', () => ({
  linkExtensionDialogToToolRow: vi.fn(),
  reconcileAllStaleInteractiveToolRows: vi.fn(),
  reconcileStaleInteractiveToolRows: vi.fn(),
}))

beforeEach(() => {
  useExtensionUIStore.setState({ activePending: null, queuedPending: [], suspended: null })
})

describe('dismissExtensionDialogState', () => {
  it('clears a suspended dialog when its source dismisses it', () => {
    useExtensionUIStore.setState({
      activePending: null,
      suspended: {
        requestId: 'dialog-1',
        pending: { id: 'dialog-1', method: 'confirm', title: 'Confirm', message: 'Continue?' },
        suspendedAt: 1,
      },
    })

    dismissExtensionDialogState('dialog-1')

    expect(useExtensionUIStore.getState().suspended).toBeNull()
  })

  it('keeps a different suspended dialog', () => {
    const suspended = {
      requestId: 'dialog-2',
      pending: { id: 'dialog-2', method: 'confirm' as const, title: 'Confirm', message: 'Continue?' },
      suspendedAt: 1,
    }
    useExtensionUIStore.setState({ activePending: null, suspended })

    dismissExtensionDialogState('dialog-1')

    expect(useExtensionUIStore.getState().suspended).toEqual(suspended)
  })

  it('removes a dismissed queued dialog without disturbing the active request', () => {
    useExtensionUIStore.setState({
      activePending: { id: 'dialog-1', method: 'confirm', title: 'First', message: 'Continue?' },
      queuedPending: [
        { id: 'dialog-2', method: 'confirm', title: 'Second', message: 'Continue?' },
        { id: 'dialog-3', method: 'confirm', title: 'Third', message: 'Continue?' },
      ],
      suspended: null,
    })

    dismissExtensionDialogState('dialog-2')

    expect(useExtensionUIStore.getState().activePending?.id).toBe('dialog-1')
    expect(useExtensionUIStore.getState().queuedPending.map((entry) => entry.id))
      .toEqual(['dialog-3'])
  })
})

describe('Main-owned Coding permission request parsing', () => {
  const prompt = {
    schemaVersion: 1,
    operation: 'COMMAND',
    relativePaths: ['src/a.ts'],
    dataEgress: 'NONE',
    commandSummary: 'npm run typecheck',
    summary: 'Agent 请求在当前任务工作树中运行命令。',
    choices: ['ALLOW_ONCE', 'ALLOW_TASK_RULE', 'DENY'],
  }

  it('accepts the exact Main envelope and rejects a Worker-forged origin', () => {
    const request = {
      id: 'xiaogui-direct-123e4567-e89b-42d3-a456-426614174000',
      method: 'custom',
      kind: 'coding_permission',
      payload: prompt,
    }
    expect(parseExtensionUIRequestV1({ ...request, origin: 'xiaogui-direct' }))
      .toEqual(expect.objectContaining({ method: 'coding_permission', prompt }))
    expect(parseExtensionUIRequestV1({ ...request, origin: 'worker' })).toBeNull()
  })

  it('rejects malformed or non-relative permission prompt fields', () => {
    expect(parseExtensionUIRequestV1({
      id: 'xiaogui-direct-123e4567-e89b-42d3-a456-426614174000',
      method: 'custom',
      kind: 'coding_permission',
      origin: 'xiaogui-direct',
      payload: { ...prompt, relativePaths: ['C:/secret.txt'] },
    })).toBeNull()
  })
})
