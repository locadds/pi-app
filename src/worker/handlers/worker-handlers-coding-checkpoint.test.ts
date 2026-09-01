import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent'

import { st } from '../worker-runtime'
import { handleCodingSessionCheckpoint } from './worker-handlers-coding-checkpoint'

const temporaryDirectories: string[] = []

type Entry = {
  type: string
  id: string
  parentId: string | null
  timestamp: string
  message?: { role: string; content: string }
  customType?: string
  data?: unknown
}

function installSession() {
  const entries: Entry[] = [{
    type: 'message',
    id: 'leaf_1',
    parentId: null,
    timestamp: '2026-08-31T00:00:00.000Z',
    message: { role: 'user', content: 'TOP SECRET' },
  }]
  let leafId: string | null = 'leaf_1'
  let sequence = 0

  const getBranch = (fromId = leafId): Entry[] => {
    if (fromId === null) return []
    const branch: Entry[] = []
    let cursor: string | null = fromId
    while (cursor) {
      const entry = entries.find((candidate) => candidate.id === cursor)
      if (!entry) throw new Error('missing branch entry')
      branch.unshift(entry)
      cursor = entry.parentId
    }
    return branch
  }
  const sessionManager = {
    getLeafId: () => leafId,
    getEntries: () => [...entries],
    getBranch,
    getEntry: (id: string) => entries.find((entry) => entry.id === id),
    appendCustomEntry: (customType: string, data: unknown) => {
      const id = `custom_${++sequence}`
      entries.push({
        type: 'custom',
        id,
        parentId: leafId,
        timestamp: `2026-08-31T00:00:0${sequence}.000Z`,
        customType,
        data,
      })
      leafId = id
      return id
    },
    branch: (id: string) => {
      if (!entries.some((entry) => entry.id === id)) throw new Error('unknown leaf')
      leafId = id
    },
    resetLeaf: () => { leafId = null },
    buildSessionContext: () => ({
      messages: getBranch().filter((entry) => entry.type === 'message').map((entry) => entry.message),
      thinkingLevel: 'medium',
      model: null,
    }),
  }
  const agentState = { messages: [{ role: 'user', content: 'TOP SECRET' }] }
  st.currentSessionId = 'pi_session_1'
  st.session = {
    sessionId: 'pi_session_1',
    sessionFile: 'C:\\private\\one.jsonl',
    isStreaming: false,
    sessionManager,
    agent: { state: agentState },
  } as unknown as AgentSession

  return {
    entries,
    sessionManager,
    agentState,
    appendMessage(id: string, content: string) {
      entries.push({
        type: 'message',
        id,
        parentId: leafId,
        timestamp: '2026-08-31T00:01:00.000Z',
        message: { role: 'user', content },
      })
      leafId = id
      agentState.messages = sessionManager.buildSessionContext().messages as typeof agentState.messages
    },
  }
}

afterEach(() => {
  st.session = null
  st.currentSessionId = ''
  st.agentTurnActive = false
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('handleCodingSessionCheckpoint', () => {
  it('captures an opaque custom marker and returns to the original live leaf', async () => {
    const fixture = installSession()
    const reply = vi.fn()

    await handleCodingSessionCheckpoint({
      action: 'CAPTURE',
      sessionFile: 'C:\\private\\one.jsonl',
      expectedSessionId: 'pi_session_1',
      snapshotRef: `xgscp_${'1'.repeat(64)}`,
    }, reply)

    expect(fixture.sessionManager.getLeafId()).toBe('leaf_1')
    expect(fixture.agentState.messages).toEqual([{ role: 'user', content: 'TOP SECRET' }])
    const response = reply.mock.calls[0]?.[0] as Record<string, unknown>
    expect(response).toEqual({
      type: 'codingSessionCheckpoint-done',
      action: 'CAPTURE',
      sessionId: 'pi_session_1',
      snapshotRef: `xgscp_${'1'.repeat(64)}`,
      snapshotDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(response)).not.toContain('TOP SECRET')
    expect(JSON.stringify(response)).not.toContain('leaf_1')
    const marker = fixture.entries.find((entry) => entry.type === 'custom')
    expect(marker).toMatchObject({
      customType: 'xiaogui.coding-checkpoint.v1',
      parentId: 'leaf_1',
      data: expect.objectContaining({
        schemaVersion: 1,
        kind: 'SNAPSHOT',
        snapshotRef: `xgscp_${'1'.repeat(64)}`,
      }),
    })
  })

  it('restores the recorded branch and appends a no-context restore head for restart', async () => {
    const fixture = installSession()
    const captureReply = vi.fn()
    const snapshotRef = `xgscp_${'2'.repeat(64)}`
    await handleCodingSessionCheckpoint({
      action: 'CAPTURE',
      sessionFile: 'C:\\private\\one.jsonl',
      expectedSessionId: 'pi_session_1',
      snapshotRef,
    }, captureReply)
    const snapshotDigest = captureReply.mock.calls[0]?.[0]?.snapshotDigest as string
    fixture.appendMessage('leaf_2', 'later branch')

    const restoreReply = vi.fn()
    await handleCodingSessionCheckpoint({
      action: 'RESTORE',
      sessionFile: 'C:\\private\\one.jsonl',
      expectedSessionId: 'pi_session_1',
      snapshotRef,
      expectedDigest: snapshotDigest,
    }, restoreReply)

    const restoredHead = fixture.entries.at(-1)
    expect(restoredHead).toMatchObject({
      type: 'custom',
      customType: 'xiaogui.coding-checkpoint.v1',
      parentId: 'leaf_1',
      data: {
        schemaVersion: 1,
        kind: 'RESTORE_HEAD',
        snapshotRef,
        snapshotDigest,
      },
    })
    expect(fixture.sessionManager.getLeafId()).toBe(restoredHead?.id)
    expect(fixture.agentState.messages).toEqual([{ role: 'user', content: 'TOP SECRET' }])
    expect(restoreReply).toHaveBeenCalledWith({
      type: 'codingSessionCheckpoint-done',
      action: 'RESTORE',
      sessionId: 'pi_session_1',
      restoredSnapshotDigest: snapshotDigest,
    })
    expect(JSON.stringify(restoreReply.mock.calls[0]?.[0])).not.toContain('leaf_1')
  })

  it('refuses capture while the Pi turn is active without appending a marker', async () => {
    const fixture = installSession()
    st.agentTurnActive = true
    const reply = vi.fn()

    await handleCodingSessionCheckpoint({
      action: 'CAPTURE',
      sessionFile: 'C:\\private\\one.jsonl',
      expectedSessionId: 'pi_session_1',
      snapshotRef: `xgscp_${'4'.repeat(64)}`,
    }, reply)

    expect(reply).toHaveBeenCalledWith({
      type: 'error',
      error: 'codingSessionCheckpoint failed: PI_SESSION_CHECKPOINT_SESSION_BUSY',
    })
    expect(fixture.entries).toHaveLength(1)
    expect(fixture.sessionManager.getLeafId()).toBe('leaf_1')
  })

  it('rejects a tampered restore digest before moving the live leaf', async () => {
    const fixture = installSession()
    const snapshotRef = `xgscp_${'5'.repeat(64)}`
    const captureReply = vi.fn()
    await handleCodingSessionCheckpoint({
      action: 'CAPTURE',
      sessionFile: 'C:\\private\\one.jsonl',
      expectedSessionId: 'pi_session_1',
      snapshotRef,
    }, captureReply)
    fixture.appendMessage('leaf_2', 'later branch')
    const beforeEntries = fixture.entries.length
    const reply = vi.fn()

    await handleCodingSessionCheckpoint({
      action: 'RESTORE',
      sessionFile: 'C:\\private\\one.jsonl',
      expectedSessionId: 'pi_session_1',
      snapshotRef,
      expectedDigest: `sha256:${'f'.repeat(64)}`,
    }, reply)

    expect(reply).toHaveBeenCalledWith({
      type: 'error',
      error: 'codingSessionCheckpoint failed: PI_SESSION_CHECKPOINT_NOT_FOUND',
    })
    expect(fixture.entries).toHaveLength(beforeEntries)
    expect(fixture.sessionManager.getLeafId()).toBe('leaf_2')
  })

  it('reopens on the restored branch with the real Pi SessionManager', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'xiaogui-pi-session-real-'))
    temporaryDirectories.push(directory)
    const sm = SessionManager.create(directory, join(directory, 'sessions'))
    sm.appendMessage({ role: 'user', content: 'fixture', timestamp: 1 })
    sm.appendMessage({
      role: 'assistant',
      content: [],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'fixture',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 2,
    })
    const sessionFile = sm.getSessionFile()
    if (!sessionFile) throw new Error('fixture session file missing')
    const sessionId = sm.getSessionId()
    st.currentSessionId = sessionId
    st.session = {
      sessionId,
      sessionFile,
      isStreaming: false,
      sessionManager: sm,
      agent: { state: { messages: [] } },
    } as unknown as AgentSession
    const snapshotRef = `xgscp_${'6'.repeat(64)}`
    const captureReply = vi.fn()

    await handleCodingSessionCheckpoint({
      action: 'CAPTURE',
      sessionFile,
      expectedSessionId: sessionId,
      snapshotRef,
    }, captureReply)
    const snapshotDigest = captureReply.mock.calls[0]?.[0]?.snapshotDigest as string
    sm.appendCustomEntry('fixture.later', { value: 2 })
    await handleCodingSessionCheckpoint({
      action: 'RESTORE',
      sessionFile,
      expectedSessionId: sessionId,
      snapshotRef,
      expectedDigest: snapshotDigest,
    }, vi.fn())

    const reopened = SessionManager.open(sessionFile)
    const leaf = reopened.getLeafEntry()
    expect(leaf).toMatchObject({
      type: 'custom',
      customType: 'xiaogui.coding-checkpoint.v1',
      data: expect.objectContaining({ kind: 'RESTORE_HEAD', snapshotRef }),
    })
    st.session = {
      sessionId,
      sessionFile,
      isStreaming: false,
      sessionManager: reopened,
      agent: { state: { messages: [] } },
    } as unknown as AgentSession
    const inspectReply = vi.fn()
    await handleCodingSessionCheckpoint({
      action: 'INSPECT',
      sessionFile,
      expectedSessionId: sessionId,
    }, inspectReply)
    expect(inspectReply).toHaveBeenCalledWith({
      type: 'codingSessionCheckpoint-done',
      action: 'INSPECT',
      sessionId,
      snapshotDigest,
    })
  })

  it('does not claim a restart-safe capture before Pi has flushed the Session file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'xiaogui-pi-session-unflushed-'))
    temporaryDirectories.push(directory)
    const sm = SessionManager.create(directory, join(directory, 'sessions'))
    sm.appendCustomEntry('fixture.unflushed', { value: 1 })
    const sessionFile = sm.getSessionFile()
    if (!sessionFile) throw new Error('fixture session file missing')
    const sessionId = sm.getSessionId()
    st.currentSessionId = sessionId
    st.session = {
      sessionId,
      sessionFile,
      isStreaming: false,
      sessionManager: sm,
      agent: { state: { messages: [] } },
    } as unknown as AgentSession
    const reply = vi.fn()

    await handleCodingSessionCheckpoint({
      action: 'CAPTURE',
      sessionFile,
      expectedSessionId: sessionId,
      snapshotRef: `xgscp_${'7'.repeat(64)}`,
    }, reply)

    expect(reply).toHaveBeenCalledWith({
      type: 'error',
      error: 'codingSessionCheckpoint failed: PI_SESSION_CHECKPOINT_MARKER_NOT_PERSISTED',
    })
  })
})
