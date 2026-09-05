import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(method: string, request?: unknown) => Promise<unknown>>(async () => ({})),
  appendOptimistic: vi.fn<(text: string, opts?: unknown) => {
    sessionFile: string
    assistantId: string
  }>(() => ({
    sessionFile: 'C:/sessions/current.jsonl',
    assistantId: 'opt-asst-1',
  })),
  bindOptimistic: vi.fn<(token: unknown, sessionFile: string | null) => void>(),
  clearOptimistic: vi.fn<(token: unknown) => boolean>(() => true),
  afterPromptSent: vi.fn<(bind?: unknown) => Promise<void>>(async () => {}),
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: (method: string, request?: unknown) => mocks.invoke(method, request) },
}))

vi.mock('@renderer/lib/session-worker-sync', () => ({
  composerTurnActive: () => false,
}))

vi.mock('@renderer/lib/optimistic-send', () => ({
  appendOptimisticOutgoingMessage: (text: string, opts?: unknown) =>
    mocks.appendOptimistic(text, opts),
  bindOptimisticOutgoingToSession: (token: unknown, sessionFile: string | null) =>
    mocks.bindOptimistic(token, sessionFile),
  clearOptimisticOutgoing: (token: unknown) => mocks.clearOptimistic(token),
}))

vi.mock('@renderer/lib/after-prompt-sent', () => ({
  afterPromptSent: (bind?: unknown) => mocks.afterPromptSent(bind),
}))

vi.mock('@renderer/lib/slash-desktop-router', () => ({
  routeDesktopSlashBeforeSend: vi.fn(async () => ({ handled: false })),
}))

vi.mock('@renderer/lib/composer-abort', () => ({
  abortAgentTurn: vi.fn(async () => {}),
  isComposerAbortCooldown: () => false,
}))

vi.mock('@renderer/stores/extension-ui-store', () => ({
  extensionUiBlocksComposer: () => false,
}))

vi.mock('./delayed-tooltip', () => ({
  hideAllDelayedTooltips: vi.fn(),
  wireDelayedTooltip: vi.fn(),
}))

import { useComposerSend } from './use-composer-send'
import { createAttachmentChip } from './attachments'

function createEditor(text: string): HTMLDivElement {
  const editor = document.createElement('div')
  editor.textContent = text
  return editor
}

describe('useComposerSend submission arbitration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invoke.mockImplementation(async () => ({}))
    useUIStore.setState({
      currentWorkspace: 'D:/workspace',
      currentSessionId: 'session-1',
      historySessionFile: 'C:/sessions/current.jsonl',
      timelineItems: [],
      pendingNewSessionPlaceholder: false,
      ephemeralSandboxDraft: false,
      workerLiveSnapshot: {
        sessionId: 'session-1',
        sessionFile: 'C:/sessions/current.jsonl',
        status: 'idle',
      },
      sessionRuntimeRunning: {},
      sessions: [{
        sessionId: 'session-1',
        sessionFile: 'C:/sessions/current.jsonl',
        title: 'Coding',
        updatedAt: 1,
        modelId: 'test',
        canonicalScope: {
          projectId: `xgp1_${'a'.repeat(64)}`,
          sessionKey: `xgs1_${'b'.repeat(64)}`,
          sessionMode: 'CODING',
        } as never,
      }],
    })
  })

  it('should_send_only_once_when_submit_reenters_before_editor_clear', async () => {
    const editor = createEditor('hello')
    const inputHistory = {
      recordSent: vi.fn(),
      tryArrowUp: vi.fn(),
      tryArrowDown: vi.fn(),
      onUserEdit: vi.fn(),
      onComposerBlur: vi.fn(),
      resetNav: vi.fn(),
    }
    const { result } = renderHook(() =>
      useComposerSend({
        editorRef: { current: editor },
        text: 'hello',
        attachments: [],
        updateFromEditor: vi.fn(),
        clearEditor: vi.fn(),
        setContent: vi.fn(),
        inputHistory,
        refreshCommands: vi.fn(async () => {}),
        showComposerStop: false,
        isRunning: false,
      }),
    )

    await act(async () => {
      const first = result.current.sendCurrent()
      const second = result.current.sendCurrent()
      await Promise.all([first, second])
    })

    expect(mocks.appendOptimistic).toHaveBeenCalledTimes(1)
    expect(
      mocks.invoke.mock.calls.filter((call) => call[0] === 'prompt.send'),
    ).toHaveLength(1)
    expect(inputHistory.recordSent).toHaveBeenCalledTimes(1)
  })

  it('creates a fresh snapshot immediately before send and sends only its opaque id', async () => {
    mocks.invoke.mockImplementation(async (method) => (
      method === 'xiaogui.coding.context.snapshot'
        ? {
            ok: true,
            snapshot: { snapshotId: 'xgctx_fresh-1234-1234-1234-123456789abc' },
          }
        : {}
    ))
    const editor = createEditor('分析 ')
    editor.appendChild(createAttachmentChip({
      path: 'src/a.ts',
      name: 'a.ts',
      kind: 'code',
      codingContextStatus: 'PENDING_SESSION',
    }))
    const inputHistory = {
      recordSent: vi.fn(),
      tryArrowUp: vi.fn(),
      tryArrowDown: vi.fn(),
      onUserEdit: vi.fn(),
      onComposerBlur: vi.fn(),
      resetNav: vi.fn(),
    }
    const { result } = renderHook(() => useComposerSend({
      editorRef: { current: editor },
      text: '分析',
      attachments: [{ path: 'src/a.ts' }],
      updateFromEditor: vi.fn(),
      clearEditor: vi.fn(),
      setContent: vi.fn(),
      inputHistory,
      refreshCommands: vi.fn(async () => {}),
      showComposerStop: false,
      isRunning: false,
    }))

    await act(async () => { await result.current.sendCurrent() })

    const send = mocks.invoke.mock.calls.find((call) => call[0] === 'prompt.send')
    expect(mocks.invoke).toHaveBeenCalledWith('xiaogui.coding.context.snapshot', {
      address: {
        projectId: `xgp1_${'a'.repeat(64)}`,
        sessionKey: `xgs1_${'b'.repeat(64)}`,
      },
      relativePaths: ['src/a.ts'],
    })
    expect(send?.[1]).toMatchObject({
      text: expect.stringContaining('@src/a.ts'),
      workspaceId: 'D:/workspace',
      sessionFile: 'C:/sessions/current.jsonl',
      codingContextSnapshotIds: ['xgctx_fresh-1234-1234-1234-123456789abc'],
    })
  })

  it('resolves a pre-session @ chip after the Coding session has materialized', async () => {
    mocks.invoke.mockImplementation(async (method) => (
      method === 'xiaogui.coding.context.snapshot'
        ? {
            ok: true,
            snapshot: { snapshotId: 'xgctx_aaaaaaaa-1234-1234-1234-123456789abc' },
          }
        : {}
    ))
    const editor = createEditor('分析 ')
    editor.appendChild(createAttachmentChip({
      path: 'src/pending.ts',
      name: 'pending.ts',
      kind: 'code',
      codingContextStatus: 'PENDING_SESSION',
    }))
    const inputHistory = {
      recordSent: vi.fn(),
      tryArrowUp: vi.fn(),
      tryArrowDown: vi.fn(),
      onUserEdit: vi.fn(),
      onComposerBlur: vi.fn(),
      resetNav: vi.fn(),
    }
    const { result } = renderHook(() => useComposerSend({
      editorRef: { current: editor },
      text: '分析',
      attachments: [{ path: 'src/pending.ts' }],
      updateFromEditor: vi.fn(),
      clearEditor: vi.fn(),
      setContent: vi.fn(),
      inputHistory,
      refreshCommands: vi.fn(async () => {}),
      showComposerStop: false,
      isRunning: false,
    }))

    await act(async () => { await result.current.sendCurrent() })

    expect(mocks.invoke).toHaveBeenCalledWith('xiaogui.coding.context.snapshot', {
      address: {
        projectId: `xgp1_${'a'.repeat(64)}`,
        sessionKey: `xgs1_${'b'.repeat(64)}`,
      },
      relativePaths: ['src/pending.ts'],
    })
    expect(mocks.invoke).toHaveBeenCalledWith('prompt.send', expect.objectContaining({
      codingContextSnapshotIds: ['xgctx_aaaaaaaa-1234-1234-1234-123456789abc'],
    }))
  })
})
