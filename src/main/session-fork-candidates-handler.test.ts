import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: Record<string, unknown>) => Promise<unknown>>(),
  getForkMessages: vi.fn(),
  loadSession: vi.fn(),
}))

vi.mock('./ipc/registry', () => ({
  registerHandler: (channel: string, handler: (request: Record<string, unknown>) => Promise<unknown>) => {
    mocks.handlers.set(channel, handler)
  },
  registerHandlerWithSchema: (
    channel: string,
    _schema: unknown,
    handler: (request: Record<string, unknown>) => Promise<unknown>,
  ) => {
    mocks.handlers.set(channel, handler)
  },
}))
vi.mock('./worker-manager', () => ({
  workerManager: {
    cwd: '',
    isRunning: false,
    getForkMessages: mocks.getForkMessages,
    loadSession: mocks.loadSession,
  },
}))
vi.mock('./config-store', () => ({ configStore: { get: vi.fn(() => '') } }))
vi.mock('./xiaogui/scope-service', () => ({
  sessionScopeResolverV1: { resolve: vi.fn(), registerNew: vi.fn(), derive: vi.fn() },
}))
vi.mock('./xiaogui/sidecar-bridge', () => ({
  xiaogui: { setMode: vi.fn(), getMode: vi.fn(() => 'WORK') },
}))

import { registerSessionHandlers } from './ipc/handlers/session'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  mocks.handlers.clear()
  vi.clearAllMocks()
})

describe('session.forkCandidates cold IPC', () => {
  it('returns disk candidates without worker creation or loadSession', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-fork-ipc-'))
    temporaryDirectories.push(directory)
    const sessionFile = join(directory, 'session.jsonl')
    const entries = [
      { type: 'session', version: 3, id: 'session-1', cwd: directory },
      { type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: 'hello' } },
      { type: 'message', id: 'assistant-1', parentId: 'user-1', message: { role: 'assistant', content: 'world' } },
    ]
    writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
    registerSessionHandlers()

    const response = await mocks.handlers.get('ipc:session.forkCandidates')!({ sessionFile })

    expect(response).toEqual({ messages: [{ entryId: 'user-1', text: 'hello' }] })
    expect(mocks.getForkMessages).not.toHaveBeenCalled()
    expect(mocks.loadSession).not.toHaveBeenCalled()
  })
})
