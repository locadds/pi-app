import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: Record<string, unknown>) => Promise<unknown>>(),
  promptAccess: vi.fn(),
  loadSession: vi.fn(),
  sendPrompt: vi.fn(),
  steer: vi.fn(),
  followUp: vi.fn(),
  resolveContext: vi.fn(),
}))

vi.mock('../registry', () => ({
  registerHandler: vi.fn(),
  registerHandlerWithSchema: (
    channel: string,
    _schema: unknown,
    handler: (request: Record<string, unknown>) => Promise<unknown>,
  ) => mocks.handlers.set(channel, handler),
}))
vi.mock('../../trusted-session-access', () => ({
  trustedSessionAccessV1: { prompt: mocks.promptAccess },
}))
vi.mock('../../worker-manager', () => ({
  workerManager: {
    loadSession: mocks.loadSession,
    sendPrompt: mocks.sendPrompt,
    steer: mocks.steer,
    followUp: mocks.followUp,
  },
}))
vi.mock('../../session-bind-state', () => ({
  ensureWorkerSessionBound: vi.fn(async (loader: (file: string) => Promise<unknown>, options: { sessionFile: string }) =>
    loader(options.sessionFile)),
}))
vi.mock('../../xiaogui/coding-extensions/context-composition', () => ({
  resolveCodingContextForPromptV1: mocks.resolveContext,
}))
vi.mock('../../clipboard-temp-images', () => ({ writeClipboardTempImage: vi.fn() }))

import { registerPromptHandlers } from './prompt'

describe('prompt trusted session seam', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    mocks.promptAccess.mockResolvedValue({
      ref: { rootPath: 'D:/project', sessionFile: 'D:/sessions/canonical.jsonl' },
      scope: {},
    })
    mocks.loadSession.mockResolvedValue({ model: 'provider/model', thinkingLevel: 'medium' })
    mocks.resolveContext.mockResolvedValue(null)
    registerPromptHandlers()
  })

  it('authorizes before creating/loading a Worker or submitting a message', async () => {
    mocks.promptAccess.mockRejectedValueOnce(new Error('trusted_session_binding_mismatch'))
    await expect(mocks.handlers.get('ipc:prompt.send')!({
      sessionId: 'session-1',
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/renderer.jsonl',
      text: 'hello',
    })).rejects.toThrow('trusted_session_binding_mismatch')
    expect(mocks.loadSession).not.toHaveBeenCalled()
    expect(mocks.resolveContext).not.toHaveBeenCalled()
    expect(mocks.sendPrompt).not.toHaveBeenCalled()
  })

  it('uses the canonical Main path and requires an active exact Worker for steer and followUp', async () => {
    await mocks.handlers.get('ipc:prompt.send')!({
      sessionId: 'session-1',
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/renderer.jsonl',
      text: 'hello',
    })
    expect(mocks.sendPrompt).toHaveBeenCalledWith('hello', 'D:/sessions/canonical.jsonl', null)

    await mocks.handlers.get('ipc:prompt.steer')!({
      sessionId: 'session-1',
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/renderer.jsonl',
      text: 'steer',
    })
    await mocks.handlers.get('ipc:prompt.followUp')!({
      sessionId: 'session-1',
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/renderer.jsonl',
      text: 'follow',
    })
    expect(mocks.promptAccess).toHaveBeenCalledWith(expect.objectContaining({ requireRunningWorker: true }))
    expect(mocks.steer).toHaveBeenCalledWith('steer', 'D:/sessions/canonical.jsonl')
    expect(mocks.followUp).toHaveBeenCalledWith('follow', 'D:/sessions/canonical.jsonl')
  })
})
