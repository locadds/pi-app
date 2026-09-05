import type { CodingRoleAgentSnapshotV1 } from '@shared/xiaogui-coding-role-control'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkerManager } from '../worker-manager'
import { attachWorkerHandlers } from '../worker-manager-pool'
import type { WorkerSlot } from '../worker-manager-types'
import { readCurrentWorkerExecutionIdentityDigestV1 } from '../worker-execution-identity'
import { createTrustedWorkerCapabilityFixtureV1 } from './trusted-worker-capability-fixture'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => process.cwd()) },
  utilityProcess: { fork: vi.fn() },
}))
vi.mock('../config-store', () => ({ configStore: { get: vi.fn(() => undefined) } }))
vi.mock('../session-file-meta', () => ({
  readSessionMetaFromFile: vi.fn(() => ({ cwd: '/workspace' })),
}))
vi.mock('../sandbox-workspaces', () => ({ findSandboxWorkspaceForSessionFile: vi.fn(() => null) }))
vi.mock('../worker-pool-config', () => ({
  readMaxSessionWorkers: vi.fn(() => 4),
  readSessionWorkerIdleTimeoutMinutes: vi.fn(() => 0),
}))

const ADDRESS = {
  projectId: `xgp1_${'a'.repeat(64)}`,
  sessionKey: `xgs1_${'b'.repeat(64)}`,
} as SessionAddressV1

const ROOT = process.cwd()

const ROLE: CodingRoleAgentSnapshotV1 = {
  schemaVersion: 1,
  attemptId: 'attempt-1',
  boundAt: '2026-08-31T12:00:00.000Z',
  snapshot: {
    schemaVersion: 1,
    profileId: 'xiaogui.role.research.default',
    role: 'RESEARCH',
    name: '研究',
    description: '只读',
    systemPrompt: 'PRIVATE ROLE PROMPT',
    modelSelector: 'inherit',
    runtimePolicyId: 'approved.default',
    requestedToolAllowlist: ['read'],
    effectiveToolAllowlist: ['read'],
    profileDigest: `sha256:${'1'.repeat(64)}`,
  },
  snapshotDigest: `sha256:${'2'.repeat(64)}`,
}

const trusted = createTrustedWorkerCapabilityFixtureV1()

type FakeTransport = WorkerSlot['worker'] & {
  postMessage: ReturnType<typeof vi.fn>
  emitMessage: (message: Record<string, unknown>) => void
}

function slot(input: {
  readonly file: string
  readonly address?: SessionAddressV1
}): WorkerSlot {
  const projectBinding = trusted.issueProject(ROOT)
  const project = trusted.authority.inspectProject(projectBinding)
  let onMessage: Parameters<WorkerSlot['worker']['onMessage']>[0] | null = null
  const worker: FakeTransport = {
    kind: 'utilityProcess',
    postMessage: vi.fn((_message: Record<string, unknown>) => {}),
    onMessage: (callback) => { onMessage = callback },
    onExit: vi.fn(),
    onStdout: vi.fn(),
    onStderr: vi.fn(),
    kill: vi.fn(),
    emitMessage: (message) => onMessage?.(message as never),
  }
  return {
    poolKey: input.file,
    cwd: ROOT,
    runtime: { mode: 'host', distro: null },
    executionIdentityDigest: readCurrentWorkerExecutionIdentityDigestV1(ROOT, {
      mode: 'host',
      distro: null,
    }),
    projectIdentityDigest: project.projectIdentityDigest,
    projectBinding,
    sessionBinding: trusted.issueSession(ROOT, input.file),
    slotBindingDigest: `slot:${input.file}`,
    sessionFile: input.file,
    sessionId: `session:${input.file}`,
    promptContext: input.address ? {
      schemaVersion: 1,
      mode: 'CODING',
      phase: 'EXECUTE',
      workspaceAvailable: true,
      projectTrusted: true,
      enabledCapabilities: ['coding.workspace'],
      availableToolNames: [],
      ...input.address,
    } : null,
    worker,
    pendingRequests: new Map(),
    requestCounter: 0,
    initResolver: null,
    initRejecter: null,
    initPromise: null,
    agentTurnActive: false,
    lastIdleAt: Date.now(),
    lastForegroundAt: Date.now(),
    sdkFallback: false,
    autoRestartEnabled: true,
    stopping: false,
  }
}

function replyFrom(target: WorkerSlot, reply: Record<string, unknown>): void {
  const worker = target.worker as FakeTransport
  attachWorkerHandlers(target, worker, {
    mainWindow: null,
    onAppEvent: vi.fn(),
    onSlotExit: vi.fn(),
  })
  worker.postMessage.mockImplementation((message: { requestId?: string }) => {
    queueMicrotask(() => worker.emitMessage({ requestId: message.requestId, ...reply }))
  })
}

function managerWith(...slots: WorkerSlot[]) {
  const manager = new WorkerManager(undefined, trusted.authority)
  const internals = manager as unknown as {
    pool: Map<string, WorkerSlot>
    foregroundPoolKey: string | null
  }
  for (const current of slots) internals.pool.set(current.poolKey, current)
  internals.foregroundPoolKey = slots[0]?.poolKey ?? null
  return manager
}

describe('WorkerManager private coding role route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('按不透明会话地址路由到正确 Worker，且只在内部 payload 携带提示正文', async () => {
    const foreground = slot({ file: '/sessions/foreground.jsonl' })
    const target = slot({ file: '/sessions/attempt.jsonl', address: ADDRESS })
    replyFrom(target, {
      type: 'codingRoleBinding-done',
      action: 'BIND',
      attemptId: ROLE.attemptId,
      profileId: ROLE.snapshot.profileId,
      role: ROLE.snapshot.role,
      snapshotDigest: ROLE.snapshotDigest,
      model: 'openai/gpt-5.6-sol',
      systemPrompt: 'COMPROMISED ECHO',
    })
    const manager = managerWith(foreground, target)

    const result = await manager.bindCodingAttemptRole(ADDRESS, ROLE)

    expect((target.worker as FakeTransport).postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'codingRoleBinding',
      action: 'BIND',
      codingRole: expect.objectContaining({
        attemptId: 'attempt-1',
        snapshot: expect.objectContaining({ systemPrompt: 'PRIVATE ROLE PROMPT' }),
      }),
    }))
    expect(foreground.worker.postMessage).not.toHaveBeenCalled()
    expect(result).toEqual({
      attemptId: 'attempt-1',
      profileId: 'xiaogui.role.research.default',
      role: 'RESEARCH',
      snapshotDigest: ROLE.snapshotDigest,
      model: 'openai/gpt-5.6-sol',
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE ROLE PROMPT')
    expect(JSON.stringify(result)).not.toContain('COMPROMISED ECHO')
    expect(JSON.stringify(result)).not.toContain('/sessions/')
  })

  it('先做兼容性检查，解除时必须指定原 Attempt', async () => {
    const target = slot({ file: '/sessions/attempt.jsonl', address: ADDRESS })
    replyFrom(target, {
      type: 'codingRoleBinding-done',
      action: 'CHECK',
      attemptId: ROLE.attemptId,
      profileId: ROLE.snapshot.profileId,
      role: ROLE.snapshot.role,
      snapshotDigest: ROLE.snapshotDigest,
      model: 'openai/gpt-5.6-sol',
    })
    const manager = managerWith(target)
    await expect(manager.inspectCodingRoleSupport(ADDRESS, ROLE)).resolves.toMatchObject({
      attemptId: 'attempt-1',
    })

    replyFrom(target, {
      type: 'codingRoleBinding-done',
      action: 'RELEASE',
      attemptId: ROLE.attemptId,
      released: true,
    })
    await expect(manager.releaseCodingAttemptRole(ADDRESS, 'attempt-1'))
      .resolves.toEqual({ attemptId: 'attempt-1', released: true })
  })

  it('会话未激活或 Worker 回包与预期快照不一致时明确失败', async () => {
    const manager = managerWith(slot({ file: '/sessions/other.jsonl' }))
    await expect(manager.inspectCodingRoleSupport(ADDRESS, ROLE))
      .rejects.toThrow('XIAOGUI_CODING_ROLE_RUNTIME_UNAVAILABLE')

    const target = slot({ file: '/sessions/attempt.jsonl', address: ADDRESS })
    replyFrom(target, {
      type: 'codingRoleBinding-done',
      action: 'BIND',
      attemptId: 'attempt-forged',
      profileId: ROLE.snapshot.profileId,
      role: ROLE.snapshot.role,
      snapshotDigest: ROLE.snapshotDigest,
      model: 'openai/gpt-5.6-sol',
    })
    const forged = managerWith(target)
    await expect(forged.bindCodingAttemptRole(ADDRESS, ROLE))
      .rejects.toThrow('XIAOGUI_CODING_ROLE_RUNTIME_RESPONSE_MISMATCH')
  })
})
