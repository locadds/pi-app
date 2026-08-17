import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InitialPlanDraftInputV1 } from '@shared/xiaogui-collaboration-hub'
import type { SessionAddressV1, SessionMode, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { createCollaborationHubApplicationV1 } from './application'
import {
  closeDefaultCollaborationHubRuntimeComposition,
  getDefaultCollaborationHubApplication,
  registerCollaborationHubHandlers,
} from './ipc'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => Promise<unknown>>(),
  getElectronPath: vi.fn(() => 'D:/fake-xiaogui-user-data'),
  kimiProductionEnabled: false,
  scopeLookup: { lookup: vi.fn() },
  runtimeCompositions: [] as Array<{
    application: { generation: number }
    close: ReturnType<typeof vi.fn>
    stageAttemptInput: ReturnType<typeof vi.fn>
    taskExecution: { start: ReturnType<typeof vi.fn> }
    delivery: {
      selectTasks: ReturnType<typeof vi.fn>
      approveGate: ReturnType<typeof vi.fn>
      returnBatch: ReturnType<typeof vi.fn>
      reconcileApply: ReturnType<typeof vi.fn>
      retryApply: ReturnType<typeof vi.fn>
    }
  }>,
  loginCoordinators: [] as Array<{
    options: { effectiveEnabled: boolean; userDataDir: string }
    inspect: ReturnType<typeof vi.fn>
    startLogin: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }>,
  createRuntimeComposition: vi.fn(),
}))

mocks.createRuntimeComposition.mockImplementation(() => {
  const composition = {
    application: { generation: mocks.runtimeCompositions.length + 1 },
    close: vi.fn(async () => undefined),
    stageAttemptInput: vi.fn(),
    taskExecution: {
      start: vi.fn(async () => ({
        ok: true,
        value: {
          taskRun: { taskRunId: 'xhbtr_task', taskSpecId: 'xhbts_task', taskKey: 'task', status: 'RUNNING' },
          attempt: { attemptId: 'xhba_attempt', taskRunId: 'xhbtr_task', status: 'RUNNING' },
        },
      })),
    },
    delivery: {
      selectTasks: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: 't' } })),
      approveGate: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: 't' } })),
      returnBatch: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: 't' } })),
      reconcileApply: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: 't' } })),
      retryApply: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: 't' } })),
    },
  }
  mocks.runtimeCompositions.push(composition)
  return composition
})

vi.mock('electron', () => ({
  app: { getPath: mocks.getElectronPath },
}))

vi.mock('../../ipc/registry', () => ({
  registerHandler: vi.fn((channel: string, handler: (payload: unknown) => Promise<unknown>) => {
    mocks.handlers.set(channel, handler)
  }),
}))

vi.mock('../../config-store', () => ({
  configStore: {
    get: vi.fn((key: string) =>
      key === 'xiaoguiKimiProductionEnabled' ? mocks.kimiProductionEnabled : undefined,
    ),
  },
}))

vi.mock('../scope-service', () => ({
  sessionScopeResolverV1: mocks.scopeLookup,
}))

vi.mock('./runtime-composition', () => ({
  createXiaoguiRuntimeCompositionV1: mocks.createRuntimeComposition,
}))

vi.mock('../agent-runtime/kimi-login', () => ({
  KimiLoginCoordinatorV1: class {
    readonly inspect: ReturnType<typeof vi.fn>
    readonly startLogin: ReturnType<typeof vi.fn>
    readonly close = vi.fn()

    constructor(readonly options: { effectiveEnabled: boolean; userDataDir: string }) {
      const result = () => ({
        status: options.effectiveEnabled ? 'LOGIN_REQUIRED' : 'DISABLED',
        reasonCode: options.effectiveEnabled ? 'KIMI_CREDENTIAL_MISSING' : 'PRODUCTION_DISABLED',
        approvedVersion: '0.34.0',
      })
      this.inspect = vi.fn(async () => result())
      this.startLogin = vi.fn(async () => result())
      mocks.loginCoordinators.push(this)
    }
  },
}))

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1

const roots: string[] = []

afterEach(async () => {
  await closeDefaultCollaborationHubRuntimeComposition()
  mocks.handlers.clear()
  mocks.runtimeCompositions.splice(0)
  mocks.loginCoordinators.splice(0)
  mocks.kimiProductionEnabled = false
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDb(name = 'hub.sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-hub-m2a-ipc-'))
  roots.push(root)
  return join(root, name)
}

function lookup(mode: SessionMode): SessionScopeLookupV1 {
  return {
    lookup: vi.fn(async (address: SessionAddressV1) => ({
      kind: 'FOUND' as const,
      scope: { ...address, sessionMode: mode },
    })),
  }
}

function draft(): InitialPlanDraftInputV1 {
  return {
    objective: '验证 IPC 与 Direct 共用同一应用接口',
    tasks: [
      { taskKey: 'a', title: '准备 Fixture' },
      { taskKey: 'b', title: '执行手工草稿', dependsOn: ['a'] },
    ],
  }
}

async function appFor(dbPath: string) {
  let id = 0
  return createCollaborationHubApplicationV1({
    lookup: lookup('WORK'),
    storeFactory: () => new CollaborationHubSqliteStoreV1(dbPath),
    now: () => '2026-08-16T00:00:00.000Z',
    idFactory: (prefix) => `${prefix}_${++id}`,
  })
}

describe('M2A collaboration hub IPC adapter', () => {
  it('snapshots the trusted enablement setting when lazily creating each runtime composition', async () => {
    expect(mocks.getElectronPath).not.toHaveBeenCalled()
    expect(mocks.createRuntimeComposition).not.toHaveBeenCalled()

    const firstApplication = getDefaultCollaborationHubApplication()
    const firstComposition = mocks.runtimeCompositions[0]!

    expect(mocks.getElectronPath).toHaveBeenCalledOnce()
    expect(mocks.getElectronPath).toHaveBeenCalledWith('userData')
    expect(mocks.createRuntimeComposition).toHaveBeenCalledOnce()
    expect(mocks.loginCoordinators).toHaveLength(1)
    expect(mocks.loginCoordinators[0]!.options).toEqual({
      effectiveEnabled: false,
      userDataDir: 'D:/fake-xiaogui-user-data',
    })
    expect(mocks.createRuntimeComposition).toHaveBeenCalledWith({
      userDataDir: 'D:/fake-xiaogui-user-data',
      productionEnabled: false,
      lookup: mocks.scopeLookup,
    })
    expect(getDefaultCollaborationHubApplication()).toBe(firstApplication)
    expect(mocks.createRuntimeComposition).toHaveBeenCalledOnce()

    mocks.kimiProductionEnabled = true
    expect(getDefaultCollaborationHubApplication()).toBe(firstApplication)
    expect(mocks.createRuntimeComposition).toHaveBeenCalledOnce()

    await closeDefaultCollaborationHubRuntimeComposition()
    await closeDefaultCollaborationHubRuntimeComposition()
    expect(firstComposition.close).toHaveBeenCalledOnce()
    expect(mocks.loginCoordinators[0]!.close).toHaveBeenCalledOnce()

    expect(getDefaultCollaborationHubApplication()).not.toBe(firstApplication)
    expect(mocks.createRuntimeComposition).toHaveBeenCalledTimes(2)
    expect(mocks.createRuntimeComposition).toHaveBeenLastCalledWith({
      userDataDir: 'D:/fake-xiaogui-user-data',
      productionEnabled: true,
      lookup: mocks.scopeLookup,
    })
    expect(mocks.loginCoordinators[1]!.options).toEqual({
      effectiveEnabled: true,
      userDataDir: 'D:/fake-xiaogui-user-data',
    })
  })

  it('exposes strict empty-object Kimi IPC bound to the current effective enablement snapshot', async () => {
    registerCollaborationHubHandlers()
    const status = mocks.handlers.get('ipc:xiaogui.kimi.status')!
    const startLogin = mocks.handlers.get('ipc:xiaogui.kimi.login.start')!
    const coordinator = mocks.loginCoordinators[0]!

    mocks.kimiProductionEnabled = true
    await expect(status({})).resolves.toMatchObject({
      status: 'DISABLED',
    })
    await expect(startLogin({})).resolves.toMatchObject({
      status: 'DISABLED',
    })
    expect(coordinator.inspect).toHaveBeenCalledWith()
    expect(coordinator.startLogin).toHaveBeenCalledWith()

    await expect(status({ command: 'evil', path: 'D:/private' })).rejects.toThrow(
      'XIAOGUI_KIMI_IPC_PARAMETERS_NOT_ALLOWED',
    )
    await expect(startLogin(undefined)).rejects.toThrow(
      'XIAOGUI_KIMI_IPC_PARAMETERS_NOT_ALLOWED',
    )
    expect(coordinator.inspect).toHaveBeenCalledOnce()
    expect(coordinator.startLogin).toHaveBeenCalledOnce()
  })

  it('registers the five delivery handlers when using the default runtime composition', async () => {
    registerCollaborationHubHandlers()

    expect([...mocks.handlers.keys()].filter((channel) => channel.startsWith('ipc:xiaogui.delivery.')).sort()).toEqual([
      'ipc:xiaogui.delivery.apply.reconcile',
      'ipc:xiaogui.delivery.apply.retry',
      'ipc:xiaogui.delivery.batch.return',
      'ipc:xiaogui.delivery.gate.approve',
      'ipc:xiaogui.delivery.selection.submit',
    ])
    expect(mocks.runtimeCompositions[0]?.delivery).toBeDefined()
  })

  it('accepts only the narrow execution confirmation shape and rejects internal or unsafe fields before orchestration', async () => {
    registerCollaborationHubHandlers()
    const startExecution = mocks.handlers.get('ipc:xiaogui.hub.execution.start')!
    const taskExecution = mocks.runtimeCompositions[0]!.taskExecution
    const valid = {
      address: ADDRESS,
      flowId: 'xhbf_flow',
      prompt: '完成当前任务',
      files: [{ operation: 'MODIFY', relativePath: 'src/task.ts' }],
    }

    await expect(startExecution(valid)).resolves.toMatchObject({ ok: true })
    expect(taskExecution.start).toHaveBeenCalledOnce()

    for (const payload of [
      { ...valid, requestId: 'renderer-owned' },
      { ...valid, trustedActor: { kind: 'main-process-system' } },
      { ...valid, adapterId: 'kimi-acp' },
      { ...valid, files: [{ operation: 'MODIFY', relativePath: 'src/task.ts', baselineDigest: 'forged' }] },
      { ...valid, files: [{ operation: 'DELETE', relativePath: 'src/task.ts' }] },
      { ...valid, files: [{ operation: 'MODIFY', relativePath: '../outside.ts' }] },
      { ...valid, files: [{ operation: 'CREATE', relativePath: 'D:/absolute.ts' }] },
    ]) {
      await expect(startExecution(payload)).resolves.toMatchObject({
        ok: false,
        error: { code: 'EXECUTION_INPUT_INVALID' },
      })
    }
    expect(taskExecution.start).toHaveBeenCalledOnce()
  })

  it('matches Direct outputs for the same observe/perform/readEvents fixture', async () => {
    const direct = await appFor(await tempDb('direct.sqlite'))
    const ipcApp = await appFor(await tempDb('ipc.sqlite'))
    registerCollaborationHubHandlers(ipcApp)

    const observe = mocks.handlers.get('ipc:xiaogui.hub.observe')!
    const perform = mocks.handlers.get('ipc:xiaogui.hub.perform')!
    const readEvents = mocks.handlers.get('ipc:xiaogui.hub.readEvents')!
    const request = { requestId: 'req-ipc', intent: { type: 'flow.start.with_draft' as const, draft: draft() } }

    await expect(observe({ contractVersion: 'm2a.v1', address: ADDRESS })).resolves.toEqual(await direct.observe(ADDRESS))
    await expect(perform({ contractVersion: 'm2a.v1', address: ADDRESS, request })).resolves.toEqual(
      await direct.execute({
        ...request,
        contractVersion: 'm2a.v1',
        address: ADDRESS,
        trustedActor: { kind: 'main-process-user' },
      }),
    )
    await expect(readEvents({ contractVersion: 'm2a.v1', address: ADDRESS, request: { afterSessionSequence: 0, limit: 10 } })).resolves.toEqual(
      await direct.readEvents(ADDRESS, { afterSessionSequence: 0, limit: 10 }),
    )
    direct.close()
    ipcApp.close()
  })

  it('exposes the M2B projection as read-only while keeping M2B writes closed', async () => {
    const direct = await appFor(await tempDb('m2b-direct.sqlite'))
    const ipcApp = await appFor(await tempDb('m2b-ipc.sqlite'))
    registerCollaborationHubHandlers(ipcApp)

    const observe = mocks.handlers.get('ipc:xiaogui.hub.observe')!
    const perform = mocks.handlers.get('ipc:xiaogui.hub.perform')!
    const directProjection = await direct.observeM2B(ADDRESS)
    const ipcProjection = await observe({ contractVersion: 'm2b.v1', address: ADDRESS })
    const writeOutcome = await perform({
      contractVersion: 'm2b.v1',
      address: ADDRESS,
      request: { requestId: 'req-m2b-write-remains-closed', intent: { type: 'flow.start.with_draft', draft: draft() } },
    })

    direct.close()
    ipcApp.close()

    expect(ipcProjection).toEqual(directProjection)
    expect(writeOutcome).toMatchObject({ ok: false, error: { code: 'IPC_VERSION_UNSUPPORTED' } })
  })

  it('returns closed sanitized outcomes for version/schema rejection', async () => {
    const ipcApp = await appFor(await tempDb())
    registerCollaborationHubHandlers(ipcApp)
    const observe = mocks.handlers.get('ipc:xiaogui.hub.observe')!

    await expect(observe({ contractVersion: 'future.v9', address: ADDRESS })).resolves.toMatchObject({
      ok: false,
      error: { code: 'IPC_VERSION_UNSUPPORTED' },
    })
    await expect(observe({ contractVersion: 'm2a.v1', address: { projectId: 'D:/leak', sessionKey: 'bad' } })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL' },
    })
    ipcApp.close()
  })

  it('recognises later-slice intents and returns INTENT_DISABLED without persistence', async () => {
    const dbPath = await tempDb()
    const ipcApp = await appFor(dbPath)
    registerCollaborationHubHandlers(ipcApp)
    const perform = mocks.handlers.get('ipc:xiaogui.hub.perform')!
    const intents = [
      { type: 'flow.start', objective: 'disabled' },
      { type: 'task.run.guide', flowId: 'future', taskRunId: 'future', text: 'disabled' },
      { type: 'system.workspace.prepare.result.record', result: { ignored: true } },
      { type: 'system.verification.complete', receipt: { ignored: true } },
      { type: 'apply.retry.request', flowId: 'future', failedApplyAttemptId: 'future' },
    ]

    for (const [index, intent] of intents.entries()) {
      await expect(
        perform({
          contractVersion: 'm2a.v1',
          address: ADDRESS,
          request: { requestId: `req-disabled-${index}`, intent },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INTENT_DISABLED' } })
    }
    expect(existsSync(dbPath)).toBe(false)
    ipcApp.close()
  })
})
