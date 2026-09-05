import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerSlot } from '../worker-manager-types'
import { WorkerManager } from '../worker-manager'
import { attachWorkerHandlers } from '../worker-manager-pool'
import { normalizeSessionKey, workspacePoolKey } from '../worker-session-key'
import { readCurrentWorkerExecutionIdentityDigestV1 } from '../worker-execution-identity'
import {
  clearSessionLeafOverride,
  getSessionLeafOverride,
  setSessionLeafOverride,
} from '../session-leaf-override'
import { createTrustedWorkerCapabilityFixtureV1 } from './trusted-worker-capability-fixture'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => process.cwd()) },
  utilityProcess: { fork: vi.fn() },
}))

vi.mock('../config-store', () => ({
  configStore: { get: vi.fn(() => undefined) },
}))
vi.mock('../worker-execution-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worker-execution-identity')>()
  return {
    ...actual,
    readCurrentWorkerExecutionIdentityDigestV1: vi.fn((cwd: string) => {
      const value = Buffer.from(cwd, 'utf8').toString('hex').padEnd(64, '0').slice(0, 64)
      return `sha256:${value}`
    }),
  }
})
vi.mock('../session-file-meta', () => ({
  readSessionMetaFromFile: vi.fn(() => ({ cwd: '/workspace' })),
}))
vi.mock('../sandbox-workspaces', () => ({
  findSandboxWorkspaceForSessionFile: vi.fn(() => null),
}))
vi.mock('../xiaogui/prompt-context-runtime', () => ({
  xiaoguiPromptContextResolverV1: {
    forWorkspace: vi.fn(async (_cwd: string, mode = 'WORK') => ({
      schemaVersion: 1, mode, phase: 'ASK', workspaceAvailable: true, projectTrusted: true,
      enabledCapabilities: ['work.file-organize'], availableToolNames: [], projectId: 'xgp1_test',
    })),
    forSession: vi.fn(async (_cwd: string, sessionFile: string) => ({
      schemaVersion: 1, mode: 'WORK', phase: 'ASK', workspaceAvailable: true, projectTrusted: true,
      enabledCapabilities: ['work.file-organize'], availableToolNames: [], projectId: 'xgp1_test',
      sessionKey: `xgs1_${Buffer.from(sessionFile).toString('hex')}`,
    })),
  },
}))

const { forkWorkerForCwd, readMaxSessionWorkers } = vi.hoisted(() => ({
  forkWorkerForCwd: vi.fn(),
  readMaxSessionWorkers: vi.fn(() => 4),
}))

vi.mock('../worker-pool-config', () => ({
  readMaxSessionWorkers,
  readSessionWorkerIdleTimeoutMinutes: vi.fn(() => 0),
}))

vi.mock('../worker-manager-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worker-manager-pool')>()
  return { ...actual, forkWorkerForCwd }
})

type FakeTransport = WorkerSlot['worker'] & {
  postMessage: ReturnType<typeof vi.fn>
  emitMessage: (message: Record<string, unknown>) => void
}

type Internals = {
  pool: Map<string, WorkerSlot>
  foregroundPoolKey: string | null
}

const trusted = createTrustedWorkerCapabilityFixtureV1()

function managerForTests(): WorkerManager {
  return new WorkerManager(undefined, trusted.authority)
}

function fakeSlot(poolKey: string, active = false): WorkerSlot {
  const projectBinding = trusted.issueProject('/workspace')
  const project = trusted.authority.inspectProject(projectBinding)
  const sessionFile = poolKey.startsWith('ws:') ? null : poolKey
  let onMessage: Parameters<WorkerSlot['worker']['onMessage']>[0] | null = null
  const worker: FakeTransport = {
    kind: 'utilityProcess',
    postMessage: vi.fn((_message: Record<string, unknown>) => {}),
    onMessage: (callback) => {
      onMessage = callback
    },
    onExit: vi.fn(),
    onStdout: vi.fn(),
    onStderr: vi.fn(),
    kill: vi.fn(),
    emitMessage: (message) => onMessage?.(message as never),
  }
  return {
    poolKey,
    cwd: '/workspace',
    runtime: { mode: 'host', distro: null },
    executionIdentityDigest: readCurrentWorkerExecutionIdentityDigestV1('/workspace', {
      mode: 'host',
      distro: null,
    }),
    projectIdentityDigest: project.projectIdentityDigest,
    projectBinding,
    sessionBinding: sessionFile ? trusted.issuer.issueSession(projectBinding, sessionFile) : null,
    slotBindingDigest: `slot:${poolKey}`,
    sessionFile,
    sessionId: `session:${poolKey}`,
    worker,
    pendingRequests: new Map(),
    requestCounter: 0,
    initResolver: null,
    initRejecter: null,
    initPromise: null,
    agentTurnActive: active,
    lastIdleAt: Date.now(),
    lastForegroundAt: Date.now(),
    sdkFallback: false,
    autoRestartEnabled: true,
    stopping: false,
  }
}

function replyFrom(slot: WorkerSlot, reply: Record<string, unknown>): void {
  const worker = slot.worker as FakeTransport
  attachWorkerHandlers(slot, worker, {
    mainWindow: null,
    onAppEvent: vi.fn(),
    onSlotExit: vi.fn(),
  })
  worker.postMessage.mockImplementation((message: Record<string, unknown>) => {
    const lease = message.sessionExecutionLease as { sessionFile?: string } | undefined
    const response = message.type === 'loadSession'
      ? {
          type: 'loadSession-done',
          sessionId: String(reply.sessionId || slot.sessionId || ''),
          sessionFile: lease?.sessionFile,
        }
      : reply
    queueMicrotask(() => worker.emitMessage({
      requestId: message.requestId,
      ...response,
      ...(message.creationOperationNonce
        ? { creationOperationNonce: message.creationOperationNonce }
        : {}),
    }))
  })
}

function managerWithForeground(slot: WorkerSlot): { manager: WorkerManager; internals: Internals } {
  const manager = managerForTests()
  const internals = manager as unknown as Internals
  internals.pool.set(slot.poolKey, slot)
  internals.foregroundPoolKey = slot.poolKey
  return { manager, internals }
}

function bindingFor(sessionFile: string, authorizedRoot: string) {
  return trusted.issueSession(authorizedRoot, sessionFile)
}

function bindSlotRoot(slot: WorkerSlot, root: string, sessionFile = slot.sessionFile): void {
  const projectBinding = trusted.issueProject(root)
  const project = trusted.authority.inspectProject(projectBinding)
  slot.cwd = root
  slot.executionIdentityDigest = readCurrentWorkerExecutionIdentityDigestV1(root, slot.runtime)
  slot.projectIdentityDigest = project.projectIdentityDigest
  slot.projectBinding = projectBinding
  slot.sessionFile = sessionFile
  slot.sessionBinding = sessionFile
    ? trusted.issuer.issueSession(projectBinding, sessionFile)
    : null
}

function projectFor(root: string) {
  const binding = trusted.issueProject(root)
  return {
    binding,
    issueRuntimeSession: (sessionFile: string) => trusted.issuer.issueSession(binding, sessionFile),
  }
}

describe('WorkerManager session isolation', () => {
  beforeEach(() => {
    forkWorkerForCwd.mockReset()
    readMaxSessionWorkers.mockReturnValue(4)
    clearSessionLeafOverride()
  })

  it('queries context only from the worker bound to the requested session', async () => {
    const foreground = fakeSlot(normalizeSessionKey('/sessions/a.jsonl'))
    const target = fakeSlot(normalizeSessionKey('/sessions/b.jsonl'))
    const { manager, internals } = managerWithForeground(foreground)
    internals.pool.set(target.poolKey, target)
    replyFrom(foreground, { type: 'getSessionContextPreview-done', preview: { estimatedChars: 11 } })
    replyFrom(target, { type: 'getSessionContextPreview-done', preview: { estimatedChars: 22 } })

    const preview = await manager.getSessionContextPreview(target.poolKey)

    expect(preview).toEqual(expect.objectContaining({ sessionFile: target.poolKey, estimatedChars: 22 }))
    expect(foreground.worker.postMessage).not.toHaveBeenCalled()
    expect(await manager.getSessionContextPreview('/sessions/missing.jsonl')).toBeNull()
  })

  it('routes a private checkpoint capture to the bound session without returning path or leaf', async () => {
    const foreground = fakeSlot(normalizeSessionKey('/sessions/a.jsonl'))
    const target = fakeSlot(normalizeSessionKey('/sessions/b.jsonl'))
    target.sessionId = 'pi_session_1'
    const { manager, internals } = managerWithForeground(foreground)
    internals.pool.set(target.poolKey, target)
    replyFrom(target, {
      type: 'codingSessionCheckpoint-done',
      action: 'CAPTURE',
      sessionId: 'pi_session_1',
      snapshotRef: `xgscp_${'1'.repeat(64)}`,
      snapshotDigest: `sha256:${'a'.repeat(64)}`,
      // Even if a compromised Worker adds private fields, Manager projects them out.
      sessionFile: target.poolKey,
      leafId: 'private_leaf',
    })

    const result = await manager.capturePiSessionCheckpoint({
      sessionFile: target.poolKey,
      expectedSessionId: 'pi_session_1',
      snapshotRef: `xgscp_${'1'.repeat(64)}`,
    })

    expect(result).toEqual({
      sessionId: 'pi_session_1',
      snapshotRef: `xgscp_${'1'.repeat(64)}`,
      snapshotDigest: `sha256:${'a'.repeat(64)}`,
    })
    expect(result).not.toHaveProperty('sessionFile')
    expect(result).not.toHaveProperty('leafId')
    expect(foreground.worker.postMessage).not.toHaveBeenCalled()
    expect(internals.foregroundPoolKey).toBe(foreground.poolKey)
  })

  it('clears a stale manual leaf override after a persisted checkpoint restore', async () => {
    const target = fakeSlot(normalizeSessionKey('/sessions/b.jsonl'))
    const { manager } = managerWithForeground(target)
    const snapshotDigest = `sha256:${'a'.repeat(64)}`
    replyFrom(target, {
      type: 'codingSessionCheckpoint-done',
      action: 'RESTORE',
      sessionId: 'pi_session_1',
      restoredSnapshotDigest: snapshotDigest,
    })
    setSessionLeafOverride(target.poolKey, 'stale_manual_leaf')

    await manager.restorePiSessionCheckpoint({
      sessionFile: target.poolKey,
      expectedSessionId: 'pi_session_1',
      snapshotRef: `xgscp_${'2'.repeat(64)}`,
      expectedDigest: snapshotDigest,
    })

    expect(getSessionLeafOverride(target.poolKey)).toBeUndefined()
  })

  it('creates a separate worker when the foreground session is running', async () => {
    const running = fakeSlot(normalizeSessionKey('/sessions/running.jsonl'), true)
    const { manager, internals } = managerWithForeground(running)
    const created = fakeSlot(workspacePoolKey('/workspace'))
    bindSlotRoot(created, '/workspace', normalizeSessionKey('/sessions/bootstrap.jsonl'))
    const createdFile = normalizeSessionKey('/sessions/new.jsonl')
    replyFrom(created, { type: 'newSession-done', sessionId: 'new', sessionFile: createdFile })
    forkWorkerForCwd.mockResolvedValue({ slot: created, init: Promise.resolve({ sessionId: 'temp' }) })

    const project = projectFor('/workspace')
    expect(await manager.newSession(project.binding, {
      issueRuntimeSession: project.issueRuntimeSession,
    })).toMatchObject({ sessionId: 'new', sessionFile: createdFile })
    expect(running.worker.postMessage).not.toHaveBeenCalled()
    expect(internals.pool.get(running.poolKey)).toBe(running)
    expect(internals.pool.get(createdFile)).toBe(created)
    const newSessionMessage = (created.worker.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find((message) => message.type === 'newSession')!
    expect(newSessionMessage.promptContext).toEqual(expect.objectContaining({
      schemaVersion: 1,
      mode: 'WORK',
    }))
    expect(newSessionMessage.promptContext).not.toHaveProperty('sessionKey')
    expect(created.worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'loadSession',
      sessionExecutionLease: expect.objectContaining({ sessionFile: createdFile }),
      promptContext: expect.objectContaining({
        schemaVersion: 1,
        sessionKey: `xgs1_${Buffer.from(createdFile).toString('hex')}`,
      }),
    }))
  })

  it('reuses the registered workspace after a new-session worker exits even when the Pi header cwd is stale', async () => {
    const manager = managerForTests()
    const internals = manager as unknown as Internals
    const workspace = '/selected-workspace'
    const createdFile = normalizeSessionKey('/sessions/new-with-stale-header.jsonl')
    const created = fakeSlot(workspacePoolKey(workspace))
    bindSlotRoot(created, workspace, normalizeSessionKey('/sessions/bootstrap.jsonl'))
    replyFrom(created, { type: 'newSession-done', sessionId: 'new', sessionFile: createdFile })

    const reloaded = fakeSlot(createdFile)
    bindSlotRoot(reloaded, workspace, createdFile)
    replyFrom(reloaded, {
      type: 'loadSession-done',
      sessionId: 'new',
      sessionFile: createdFile,
    })
    forkWorkerForCwd
      .mockResolvedValueOnce({ slot: created, init: Promise.resolve({ sessionId: 'temp' }) })
      .mockResolvedValueOnce({ slot: reloaded, init: Promise.resolve({ sessionId: 'bootstrap' }) })

    const project = projectFor(workspace)
    const createdSession = await manager.newSession(project.binding, {
      issueRuntimeSession: project.issueRuntimeSession,
    })
    internals.pool.clear()
    internals.foregroundPoolKey = null
    await manager.loadSession(createdSession.binding!)

    expect(forkWorkerForCwd).toHaveBeenLastCalledWith(
      workspace,
      expect.objectContaining({ sessionFile: createdFile }),
    )
  })

  it('bootstraps a cold Session worker without pre-binding the target Session identity', async () => {
    const manager = managerForTests()
    const targetFile = normalizeSessionKey('/sessions/cold.jsonl')
    const created = fakeSlot(targetFile)
    replyFrom(created, {
      type: 'loadSession-done',
      sessionId: 'cold',
      sessionFile: targetFile,
    })
    forkWorkerForCwd.mockResolvedValue({
      slot: created,
      init: Promise.resolve({ sessionId: 'bootstrap' }),
    })

    await manager.ensureSessionWorker(bindingFor(targetFile, '/workspace'))

    expect(forkWorkerForCwd).toHaveBeenCalledWith('/workspace', expect.objectContaining({
      sessionFile: targetFile,
      promptContext: expect.not.objectContaining({ sessionKey: expect.any(String) }),
    }))
    expect(created.worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'loadSession',
      sessionExecutionLease: expect.objectContaining({ sessionFile: targetFile }),
      promptContext: expect.objectContaining({
        sessionKey: `xgs1_${Buffer.from(targetFile).toString('hex')}`,
      }),
    }))
  })

  it('cannot cold-start a Worker from an unregistered renderer session path', async () => {
    const manager = managerForTests()

    await expect(manager.sendPrompt('hello', '/sessions/untrusted.jsonl'))
      .rejects.toThrow('Worker not started for session')

    expect(forkWorkerForCwd).not.toHaveBeenCalled()
  })

  it('does not mutate a slot when a Worker returns the wrong session target', async () => {
    const sessionFile = normalizeSessionKey('/sessions/authorized.jsonl')
    const slot = fakeSlot(sessionFile)
    const { manager } = managerWithForeground(slot)
    const worker = slot.worker as FakeTransport
    attachWorkerHandlers(slot, worker, {
      mainWindow: null,
      onAppEvent: vi.fn(),
      onSlotExit: vi.fn(),
    })
    worker.postMessage.mockImplementation((message: Record<string, unknown>) => {
      queueMicrotask(() => worker.emitMessage({
        requestId: message.requestId,
        type: 'loadSession-done',
        sessionId: 'forged-session',
        sessionFile: normalizeSessionKey('/sessions/forged.jsonl'),
      }))
    })

    await expect(manager.loadSession(bindingFor(sessionFile, '/workspace')))
      .rejects.toThrow('SESSION_SCOPE_MISMATCH')

    expect(slot.sessionFile).toBe(sessionFile)
    expect(slot.sessionId).toBe(`session:${sessionFile}`)
  })

  it('rejects rebinding an existing session to a different project cwd', async () => {
    const sessionFile = normalizeSessionKey('/sessions/project-switch.jsonl')
    const existing = fakeSlot(sessionFile)
    bindSlotRoot(existing, '/project-a', sessionFile)
    const manager = managerForTests()
    const internals = manager as unknown as Internals
    internals.pool.set(sessionFile, existing)

    await expect(manager.loadSession(bindingFor(sessionFile, '/project-b')))
      .rejects.toThrow('SESSION_WORKSPACE_REBIND_REJECTED')

    expect(existing.worker.kill).not.toHaveBeenCalled()
    expect(forkWorkerForCwd).not.toHaveBeenCalled()
    expect(internals.pool.get(sessionFile)).toBe(existing)
    expect(existing.worker.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'loadSession' }),
    )
  })

  it('replaces a Worker whose captured resource identity is stale', async () => {
    const sessionFile = normalizeSessionKey('/sessions/resource-change.jsonl')
    const existing = fakeSlot(sessionFile)
    existing.executionIdentityDigest = `sha256:${'0'.repeat(64)}`
    replyFrom(existing, { type: 'abort-done' })
    const manager = managerForTests()
    const internals = manager as unknown as Internals
    internals.pool.set(sessionFile, existing)

    const created = fakeSlot(sessionFile)
    replyFrom(created, {
      type: 'loadSession-done',
      sessionId: 'resource-refreshed',
      sessionFile,
    })
    forkWorkerForCwd.mockResolvedValue({
      slot: created,
      init: Promise.resolve({ sessionId: 'bootstrap' }),
    })

    await manager.ensureSessionWorker(bindingFor(sessionFile, '/workspace'))

    expect(existing.worker.kill).toHaveBeenCalledOnce()
    expect(internals.pool.get(sessionFile)).toBe(created)
  })

  it('rebuilds the foreground Session when resource reload sees a stale identity', async () => {
    const sessionFile = normalizeSessionKey('/sessions/resource-reload.jsonl')
    const existing = fakeSlot(sessionFile)
    existing.executionIdentityDigest = `sha256:${'0'.repeat(64)}`
    replyFrom(existing, { type: 'abort-done' })
    const { manager, internals } = managerWithForeground(existing)

    const created = fakeSlot(sessionFile)
    replyFrom(created, {
      type: 'loadSession-done',
      sessionId: 'resource-reloaded',
      sessionFile,
    })
    forkWorkerForCwd.mockResolvedValue({
      slot: created,
      init: Promise.resolve({ sessionId: 'bootstrap' }),
    })

    await manager.reloadResources()

    expect(existing.worker.kill).toHaveBeenCalledOnce()
    expect(internals.pool.get(sessionFile)).toBe(created)
    expect(internals.foregroundPoolKey).toBe(sessionFile)
    expect(created.worker.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reloadResources' }),
    )
  })

  it('runs the new-session persistence gate before foreground activation', async () => {
    const running = fakeSlot(normalizeSessionKey('/sessions/running.jsonl'), true)
    const { manager, internals } = managerWithForeground(running)
    const created = fakeSlot(workspacePoolKey('/workspace'))
    bindSlotRoot(created, '/workspace', normalizeSessionKey('/sessions/bootstrap.jsonl'))
    const createdFile = normalizeSessionKey('/sessions/new.jsonl')
    replyFrom(created, { type: 'newSession-done', sessionId: 'new', sessionFile: createdFile })
    forkWorkerForCwd.mockResolvedValue({ slot: created, init: Promise.resolve({ sessionId: 'temp' }) })
    const beforeActivate = vi.fn(async () => {
      expect(internals.foregroundPoolKey).toBe(running.poolKey)
      expect(internals.pool.has(createdFile)).toBe(false)
      expect(created.poolKey).toBe(workspacePoolKey('/workspace'))
    })

    const project = projectFor('/workspace')
    await expect(manager.newSession(project.binding, {
      beforeActivate,
      issueRuntimeSession: project.issueRuntimeSession,
    })).resolves.toMatchObject({
      sessionId: 'new',
      sessionFile: createdFile,
    })

    expect(beforeActivate).toHaveBeenCalledWith({ sessionId: 'new', sessionFile: createdFile })
    expect(internals.foregroundPoolKey).toBe(createdFile)
    expect(internals.pool.get(createdFile)).toBe(created)
  })

  it('disposes the candidate worker when the new-session persistence gate fails', async () => {
    const running = fakeSlot(normalizeSessionKey('/sessions/running.jsonl'), true)
    const { manager, internals } = managerWithForeground(running)
    const created = fakeSlot(workspacePoolKey('/workspace'))
    bindSlotRoot(created, '/workspace', normalizeSessionKey('/sessions/bootstrap.jsonl'))
    const createdFile = normalizeSessionKey('/sessions/new.jsonl')
    replyFrom(created, { type: 'newSession-done', sessionId: 'new', sessionFile: createdFile })
    forkWorkerForCwd.mockResolvedValue({ slot: created, init: Promise.resolve({ sessionId: 'temp' }) })

    const project = projectFor('/workspace')
    await expect(
      manager.newSession(project.binding, {
        issueRuntimeSession: project.issueRuntimeSession,
        beforeActivate: async () => {
          throw new Error('SCOPE_PERSISTENCE_FAILED')
        },
      }),
    ).rejects.toThrow('SCOPE_PERSISTENCE_FAILED')

    expect(internals.foregroundPoolKey).toBe(running.poolKey)
    expect(internals.pool.has(createdFile)).toBe(false)
    expect(internals.pool.has(created.poolKey)).toBe(false)
    expect(created.worker.kill).toHaveBeenCalled()
  })

  it('evicts an idle slot before forking when the pool is at capacity', async () => {
    readMaxSessionWorkers.mockReturnValue(1)
    const idle = fakeSlot(normalizeSessionKey('/sessions/idle.jsonl'))
    idle.sessionFile = null
    bindSlotRoot(idle, '/other', null)
    const { manager, internals } = managerWithForeground(idle)
    const created = fakeSlot(workspacePoolKey('/workspace'))
    bindSlotRoot(created, '/workspace', normalizeSessionKey('/sessions/bootstrap.jsonl'))
    const createdFile = normalizeSessionKey('/sessions/new.jsonl')
    replyFrom(created, { type: 'newSession-done', sessionId: 'new', sessionFile: createdFile })
    forkWorkerForCwd.mockImplementation(async () => {
      expect(internals.pool.size).toBe(0)
      return { slot: created, init: Promise.resolve({ sessionId: 'temp' }) }
    })

    const project = projectFor('/workspace')
    await expect(manager.newSession(project.binding, {
      issueRuntimeSession: project.issueRuntimeSession,
    })).resolves.toMatchObject({
      sessionId: 'new',
      sessionFile: createdFile,
    })
    expect(internals.pool.has(idle.poolKey)).toBe(false)
    expect(idle.worker.kill).toHaveBeenCalled()
  })

  it('keeps both slots when new sessions are created concurrently', async () => {
    const { manager, internals } = managerWithForeground(
      fakeSlot(normalizeSessionKey('/sessions/running.jsonl'), true),
    )
    let sequence = 0
    forkWorkerForCwd.mockImplementation(async (_cwd: string, options?: { poolKey?: string }) => {
      const index = ++sequence
      const slot = fakeSlot(options?.poolKey || workspacePoolKey('/workspace'))
      bindSlotRoot(slot, '/workspace', normalizeSessionKey(`/sessions/bootstrap-${index}.jsonl`))
      replyFrom(slot, {
        type: 'newSession-done',
        sessionId: `new-${index}`,
        sessionFile: normalizeSessionKey(`/sessions/new-${index}.jsonl`),
      })
      return { slot, init: Promise.resolve({ sessionId: `temp-${index}` }) }
    })

    const project = projectFor('/workspace')
    const options = { issueRuntimeSession: project.issueRuntimeSession }
    const results = await Promise.all([
      manager.newSession(project.binding, options),
      manager.newSession(project.binding, options),
    ])

    expect(results.map((result) => result.sessionId)).toEqual(['new-1', 'new-2'])
    expect(internals.pool.has(normalizeSessionKey('/sessions/new-1.jsonl'))).toBe(true)
    expect(internals.pool.has(normalizeSessionKey('/sessions/new-2.jsonl'))).toBe(true)
  })

  it.each(['fork', 'clone'] as const)(
    'runs the %s persistence gate before remapping the foreground slot',
    async (kind) => {
      const sourceFile = normalizeSessionKey('/sessions/source.jsonl')
      const targetFile = normalizeSessionKey(`/sessions/${kind}.jsonl`)
      const source = fakeSlot(sourceFile)
      const { manager, internals } = managerWithForeground(source)
      replyFrom(source, {
        type: `${kind}-done`,
        sessionId: kind,
        sessionFile: targetFile,
      })
      const beforeActivate = vi.fn(async () => {
        expect(internals.foregroundPoolKey).toBe(sourceFile)
        expect(internals.pool.get(sourceFile)).toBe(source)
        expect(internals.pool.has(targetFile)).toBe(false)
      })

      if (kind === 'fork') {
        await expect(
          manager.forkSession({
            sourceBinding: source.sessionBinding!,
            entryId: 'entry',
            beforeActivate,
            issueRuntimeSession: (projectBinding, sessionFile) =>
              trusted.issuer.issueSession(projectBinding, sessionFile),
          }),
        ).resolves.toMatchObject({ sessionId: 'fork', sessionFile: targetFile })
      } else {
        await expect(
          manager.cloneSession({
            sourceBinding: source.sessionBinding!,
            beforeActivate,
            issueRuntimeSession: (projectBinding, sessionFile) =>
              trusted.issuer.issueSession(projectBinding, sessionFile),
          }),
        ).resolves.toMatchObject({ sessionId: 'clone', sessionFile: targetFile })
      }

      expect(beforeActivate).toHaveBeenCalledWith({ sessionId: kind, sessionFile: targetFile })
      expect(internals.foregroundPoolKey).toBe(targetFile)
      expect(internals.pool.get(targetFile)).toBe(source)
    },
  )

  it.each(['fork', 'clone'] as const)(
    'disposes the candidate slot when the %s persistence gate fails',
    async (kind) => {
      const sourceFile = normalizeSessionKey('/sessions/source.jsonl')
      const targetFile = normalizeSessionKey(`/sessions/${kind}.jsonl`)
      const source = fakeSlot(sourceFile)
      const { manager, internals } = managerWithForeground(source)
      replyFrom(source, {
        type: `${kind}-done`,
        sessionId: kind,
        sessionFile: targetFile,
      })
      const beforeActivate = async () => {
        throw new Error('SCOPE_PERSISTENCE_FAILED')
      }

      const operation = kind === 'fork'
        ? manager.forkSession({
            sourceBinding: source.sessionBinding!,
            entryId: 'entry',
            beforeActivate,
            issueRuntimeSession: (projectBinding, sessionFile) =>
              trusted.issuer.issueSession(projectBinding, sessionFile),
          })
        : manager.cloneSession({
            sourceBinding: source.sessionBinding!,
            beforeActivate,
            issueRuntimeSession: (projectBinding, sessionFile) =>
              trusted.issuer.issueSession(projectBinding, sessionFile),
          })

      await expect(operation).rejects.toThrow('SCOPE_PERSISTENCE_FAILED')
      expect(internals.foregroundPoolKey).toBeNull()
      expect(internals.pool.has(sourceFile)).toBe(false)
      expect(internals.pool.has(targetFile)).toBe(false)
      expect(source.worker.kill).toHaveBeenCalled()
    },
  )

  it('sends abort only to the worker bound to the requested session', async () => {
    const foreground = fakeSlot(normalizeSessionKey('/sessions/a.jsonl'), true)
    const requested = fakeSlot(normalizeSessionKey('/sessions/b.jsonl'), true)
    const { manager, internals } = managerWithForeground(foreground)
    internals.pool.set(requested.poolKey, requested)
    replyFrom(requested, { type: 'abort-done' })

    await manager.abort(requested.poolKey)

    expect(foreground.worker.postMessage).not.toHaveBeenCalled()
    expect(requested.worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'abort', sessionFile: requested.poolKey }),
    )
  })
})
