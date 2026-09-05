import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession, AgentSessionRuntime } from '@earendil-works/pi-coding-agent'

vi.mock('./worker-transport', () => ({
  sendToMain: vi.fn(),
}))

import {
  bindWorkerExecutionIdentityV1,
  st,
  switchOrLoadSession,
} from './worker-runtime'

const authorizedCwd = 'D:\\trusted-project'
const sessionFile = 'D:\\sessions\\trusted.jsonl'
const projectIdentityDigest = `sha256:${'1'.repeat(64)}`
const slotBindingDigest = `sha256:${'2'.repeat(64)}`

function promptContext() {
  return {
    schemaVersion: 1,
    mode: 'CODING',
    phase: 'EXECUTE',
    workspaceAvailable: true,
    projectTrusted: true,
    enabledCapabilities: ['coding.workspace'],
    availableToolNames: ['read', 'edit', 'write', 'bash'],
    sessionKey: 'xgs1_session_execution_lease',
    projectId: 'xgp1_session_execution_lease',
  }
}

function lease(operationNonce = 'nonce-cold-1') {
  return {
    schemaVersion: 1,
    sessionFile,
    authorizedCwd,
    projectIdentityDigest,
    slotBindingDigest,
    operationNonce,
  }
}

function fakeSession(cwd = authorizedCwd): AgentSession {
  return {
    sessionId: 'session-1',
    sessionFile,
    model: { provider: 'test', id: 'model' },
    thinkingLevel: 'medium',
    sessionManager: {
      getCwd: () => cwd,
      getLeafId: () => null,
      getBranch: () => [],
    },
    bindExtensions: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(),
  } as unknown as AgentSession
}

afterEach(async () => {
  try {
    await st.runtime?.dispose()
  } catch {
    // Test doubles may already be disposed.
  }
  st.uiBridge?.dispose()
  st.sdk = null
  st.sharedEventBus = null
  st.runtime = null
  st.session = null
  st.uiBridge = null
  st.widgetHost = null
  st.currentCwd = ''
  st.currentSessionId = ''
  st.workerExecutionIdentity = null
  st.consumedSessionOperationNonces.clear()
  st.promptContext = null
  st.promptContextCandidate = null
  st.promptTurnContext = null
  st.pendingPromptContext = null
  st.promptDiagnostics = null
  st.promptPreflight = null
})

describe('session execution lease', () => {
  it('uses the Main-authorized cwd override when opening a session whose JSONL cwd is untrusted', async () => {
    const session = fakeSession()
    const sessionManager = session.sessionManager
    const open = vi.fn(() => sessionManager)
    const runtime = {
      session,
      services: { modelRuntime: null },
      modelFallbackMessage: null,
      setBeforeSessionInvalidate: vi.fn(),
      setRebindSession: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentSessionRuntime
    const createAgentSessionRuntime = vi.fn(async (_factory, options) => {
      expect(options.cwd).toBe(authorizedCwd)
      expect(options.sessionManager).toBe(sessionManager)
      return runtime
    })
    st.sdk = {
      getAgentDir: () => 'D:\\agent',
      SessionManager: { open },
      createAgentSessionRuntime,
    } as never
    st.sharedEventBus = { on: vi.fn(() => () => undefined) } as never
    bindWorkerExecutionIdentityV1({
      authorizedCwd,
      projectIdentityDigest,
      slotBindingDigest,
    })

    await switchOrLoadSession(lease(), promptContext())

    expect(open).toHaveBeenCalledWith(sessionFile, undefined, authorizedCwd)
    expect(createAgentSessionRuntime).toHaveBeenCalledOnce()
    expect(st.currentCwd).toBe(authorizedCwd)
  })

  it('uses the same authorized cwd override for a warm Pi runtime switch', async () => {
    const session = fakeSession()
    const switchSession = vi.fn(async () => ({ cancelled: false }))
    st.session = session
    st.runtime = {
      session,
      services: { modelRuntime: null },
      modelFallbackMessage: null,
      switchSession,
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentSessionRuntime
    st.sdk = {} as never
    st.currentCwd = authorizedCwd
    bindWorkerExecutionIdentityV1({
      authorizedCwd,
      projectIdentityDigest,
      slotBindingDigest,
    })

    await switchOrLoadSession(lease('nonce-warm-1'), promptContext())

    expect(switchSession).toHaveBeenCalledWith(sessionFile, { cwdOverride: authorizedCwd })
    expect(st.currentCwd).toBe(authorizedCwd)
  })

  it('disposes a cold runtime that does not honor the Main-authorized cwd override', async () => {
    const session = fakeSession('D:\\forged-jsonl-cwd')
    const dispose = vi.fn(async () => undefined)
    const runtime = {
      session,
      services: { modelRuntime: null },
      modelFallbackMessage: null,
      setBeforeSessionInvalidate: vi.fn(),
      setRebindSession: vi.fn(),
      dispose,
    } as unknown as AgentSessionRuntime
    st.sdk = {
      getAgentDir: () => 'D:\\agent',
      SessionManager: { open: vi.fn(() => session.sessionManager) },
      createAgentSessionRuntime: vi.fn(async () => runtime),
    } as never
    st.sharedEventBus = { on: vi.fn(() => () => undefined) } as never
    bindWorkerExecutionIdentityV1({
      authorizedCwd,
      projectIdentityDigest,
      slotBindingDigest,
    })

    await expect(
      switchOrLoadSession(lease('nonce-forged-cwd-1'), promptContext()),
    ).rejects.toThrow('SESSION_AUTHORIZED_CWD_MISMATCH')

    expect(dispose).toHaveBeenCalledOnce()
    expect(st.runtime).toBeNull()
    expect(st.session).toBeNull()
  })

  it('disposes a cold runtime that binds a different session file than the lease target', async () => {
    const session = fakeSession()
    Object.assign(session, { sessionFile: 'D:\\sessions\\different.jsonl' })
    const dispose = vi.fn(async () => undefined)
    const runtime = {
      session,
      services: { modelRuntime: null },
      modelFallbackMessage: null,
      setBeforeSessionInvalidate: vi.fn(),
      setRebindSession: vi.fn(),
      dispose,
    } as unknown as AgentSessionRuntime
    st.sdk = {
      getAgentDir: () => 'D:\\agent',
      SessionManager: { open: vi.fn(() => session.sessionManager) },
      createAgentSessionRuntime: vi.fn(async () => runtime),
    } as never
    st.sharedEventBus = { on: vi.fn(() => () => undefined) } as never
    bindWorkerExecutionIdentityV1({
      authorizedCwd,
      projectIdentityDigest,
      slotBindingDigest,
    })

    await expect(
      switchOrLoadSession(lease('nonce-wrong-session-1'), promptContext()),
    ).rejects.toThrow('SESSION_EXECUTION_LEASE_SESSION_MISMATCH')

    expect(dispose).toHaveBeenCalledOnce()
    expect(st.runtime).toBeNull()
  })

  it('rejects a lease whose Main identity facts do not match this Worker slot', async () => {
    const open = vi.fn()
    st.sdk = { SessionManager: { open } } as never
    bindWorkerExecutionIdentityV1({
      authorizedCwd,
      projectIdentityDigest,
      slotBindingDigest,
    })

    await expect(
      switchOrLoadSession({
        ...lease('nonce-wrong-slot-1'),
        slotBindingDigest: `sha256:${'9'.repeat(64)}`,
      }, promptContext()),
    ).rejects.toThrow('SESSION_EXECUTION_LEASE_IDENTITY_MISMATCH')

    expect(open).not.toHaveBeenCalled()
  })

  it('rejects a relative session target before invoking Pi', async () => {
    const open = vi.fn()
    st.sdk = { SessionManager: { open } } as never
    bindWorkerExecutionIdentityV1({
      authorizedCwd,
      projectIdentityDigest,
      slotBindingDigest,
    })

    await expect(
      switchOrLoadSession({
        ...lease('nonce-relative-session-1'),
        sessionFile: 'sessions/relative.jsonl',
      }, promptContext()),
    ).rejects.toThrow('SESSION_EXECUTION_LEASE_INVALID')

    expect(open).not.toHaveBeenCalled()
  })

  it('consumes an operation nonce once and never replays the Pi switch', async () => {
    const session = fakeSession()
    const switchSession = vi.fn(async () => ({ cancelled: false }))
    st.session = session
    st.runtime = {
      session,
      services: { modelRuntime: null },
      modelFallbackMessage: null,
      switchSession,
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentSessionRuntime
    st.sdk = {} as never
    st.currentCwd = authorizedCwd
    bindWorkerExecutionIdentityV1({
      authorizedCwd,
      projectIdentityDigest,
      slotBindingDigest,
    })
    const oneShotLease = lease('nonce-one-shot-1')

    await switchOrLoadSession(oneShotLease, promptContext())
    await expect(
      switchOrLoadSession(oneShotLease, promptContext()),
    ).rejects.toThrow('SESSION_EXECUTION_LEASE_REPLAYED')

    expect(switchSession).toHaveBeenCalledOnce()
  })

  it('disposes a warm runtime when the switched session is not bound to the authorized cwd', async () => {
    const currentSession = fakeSession()
    const forgedSession = fakeSession('D:\\forged-jsonl-cwd')
    const dispose = vi.fn(async () => undefined)
    const switchSession = vi.fn(async () => {
      st.session = forgedSession
      return { cancelled: false }
    })
    st.session = currentSession
    st.runtime = {
      session: currentSession,
      services: { modelRuntime: null },
      modelFallbackMessage: null,
      setBeforeSessionInvalidate: vi.fn(),
      setRebindSession: vi.fn(),
      switchSession,
      dispose,
    } as unknown as AgentSessionRuntime
    st.sdk = {} as never
    st.currentCwd = authorizedCwd
    bindWorkerExecutionIdentityV1({
      authorizedCwd,
      projectIdentityDigest,
      slotBindingDigest,
    })

    await expect(
      switchOrLoadSession(lease('nonce-warm-forged-cwd-1'), promptContext()),
    ).rejects.toThrow('SESSION_AUTHORIZED_CWD_MISMATCH')

    expect(dispose).toHaveBeenCalledOnce()
    expect(st.runtime).toBeNull()
    expect(st.session).toBeNull()
  })
})
