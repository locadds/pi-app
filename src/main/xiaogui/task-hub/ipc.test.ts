import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  isPackaged: false,
  kimiProductionEnabled: false,
  codingPermissionMode: 'CONFIRM_EACH',
  scopeLookup: { lookup: vi.fn() },
  runtimeCompositions: [] as Array<{
    application: { generation: number }
    close: ReturnType<typeof vi.fn>
    stageAttemptInput: ReturnType<typeof vi.fn>
    taskExecution: { start: ReturnType<typeof vi.fn>; startBatch: ReturnType<typeof vi.fn> }
    delivery: {
      selectTasks: ReturnType<typeof vi.fn>
      approveGate: ReturnType<typeof vi.fn>
      returnBatch: ReturnType<typeof vi.fn>
      reconcileApply: ReturnType<typeof vi.fn>
      retryApply: ReturnType<typeof vi.fn>
      prepareRecovery: ReturnType<typeof vi.fn>
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
      startBatch: vi.fn(async (request) => ({
        ok: true,
        value: {
          contractVersion: 'xiaogui.task-execution.batch.v1',
          items: request.items.map((item: { taskRunId: string }, index: number) => ({
            ok: true,
            taskRunId: item.taskRunId,
            value: {
              taskRun: { taskRunId: item.taskRunId, taskSpecId: `xhbts_${index}`, taskKey: `task-${index}`, status: 'RUNNING' },
              attempt: { attemptId: `xhba_${index}`, taskRunId: item.taskRunId, status: 'RUNNING' },
            },
          })),
        },
      })),
    },
    delivery: {
      selectTasks: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: 't' } })),
      approveGate: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: 't' } })),
      returnBatch: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: 't' } })),
      reconcileApply: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: 't' } })),
      retryApply: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: 't' } })),
      prepareRecovery: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', messageKey: 'x', traceId: 't' } })),
    },
  }
  mocks.runtimeCompositions.push(composition)
  return composition
})

vi.mock('electron', () => ({
  app: {
    getPath: mocks.getElectronPath,
    get isPackaged() { return mocks.isPackaged },
  },
}))

vi.mock('../../ipc/registry', () => ({
  registerHandler: vi.fn((channel: string, handler: (payload: unknown) => Promise<unknown>) => {
    mocks.handlers.set(channel, handler)
  }),
}))

vi.mock('../../config-store', () => ({
  configStore: {
    get: vi.fn((key: string) => {
      if (key === 'xiaoguiKimiProductionEnabled') return mocks.kimiProductionEnabled
      if (key === 'xiaoguiCodingPermissionMode') return mocks.codingPermissionMode
      return undefined
    }),
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
const CONTROLLED_EVIDENCE_ROOT = 'D:\\CodexTemp\\xiaogui-hub-m4g-real-journey-v1\\evidence'

afterEach(async () => {
  await closeDefaultCollaborationHubRuntimeComposition()
  mocks.handlers.clear()
  mocks.runtimeCompositions.splice(0)
  mocks.loginCoordinators.splice(0)
  mocks.kimiProductionEnabled = false
  mocks.codingPermissionMode = 'CONFIRM_EACH'
  mocks.isPackaged = false
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDb(name = 'hub.sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'xiaogui-hub-m2a-ipc-'))
  roots.push(root)
  return join(root, name)
}

async function tempControlledRuntimeFixture(): Promise<{ scenarioPath: string; eventLogPath: string }> {
  await mkdir(CONTROLLED_EVIDENCE_ROOT, { recursive: true })
  const root = await mkdtemp(join(CONTROLLED_EVIDENCE_ROOT, 'ipc-launch-'))
  roots.push(root)
  const scenarioPath = join(root, 'scenario.json')
  const eventLogPath = join(root, 'events.jsonl')
  await writeFile(scenarioPath, `${JSON.stringify({
    version: 1,
    eventLog: 'events.jsonl',
    tasks: [{ label: 'A', allowedPath: 'src/a.ts', releaseFile: 'release-a', content: 'A' }],
  })}\n`, 'utf8')
  return { scenarioPath, eventLogPath }
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
  it('keeps PI_E2E alone from registering the Scripted adapter in a packaged application', async () => {
    const previousPiE2e = process.env.PI_E2E
    const previousScenario = process.env.PI_E2E_SCRIPTED_RUNTIME_SCENARIO
    try {
      mocks.isPackaged = true
      process.env.PI_E2E = '1'
      process.env.PI_E2E_SCRIPTED_RUNTIME_SCENARIO =
        'D:\\CodexTemp\\xiaogui-hub-m4g-real-journey-v1\\evidence\\packaged-attempt.json'

      getDefaultCollaborationHubApplication()

      expect(mocks.createRuntimeComposition).toHaveBeenCalledWith({
        userDataDir: 'D:/fake-xiaogui-user-data',
        productionEnabled: false,
        lookup: mocks.scopeLookup,
        codingPermissionModeProvider: expect.any(Function),
      })
    } finally {
      if (previousPiE2e === undefined) delete process.env.PI_E2E
      else process.env.PI_E2E = previousPiE2e
      if (previousScenario === undefined) delete process.env.PI_E2E_SCRIPTED_RUNTIME_SCENARIO
      else process.env.PI_E2E_SCRIPTED_RUNTIME_SCENARIO = previousScenario
    }
  })

  it('requires matching per-run Scripted runtime tokens from environment and argv', async () => {
    const previousPiE2e = process.env.PI_E2E
    const previousScenario = process.env.PI_E2E_SCRIPTED_RUNTIME_SCENARIO
    const previousToken = process.env.PI_E2E_SCRIPTED_RUNTIME_TOKEN
    const previousArgv = [...process.argv]
    try {
      process.env.PI_E2E = '1'
      process.env.PI_E2E_SCRIPTED_RUNTIME_SCENARIO =
        'D:\\CodexTemp\\xiaogui-hub-m4g-real-journey-v1\\evidence\\token-mismatch.json'
      process.env.PI_E2E_SCRIPTED_RUNTIME_TOKEN = 'a'.repeat(64)
      process.argv = [...previousArgv, `--pi-e2e-scripted-runtime-token=${'b'.repeat(64)}`]

      getDefaultCollaborationHubApplication()

      expect(mocks.createRuntimeComposition).toHaveBeenCalledWith({
        userDataDir: 'D:/fake-xiaogui-user-data',
        productionEnabled: false,
        lookup: mocks.scopeLookup,
        codingPermissionModeProvider: expect.any(Function),
      })
    } finally {
      process.argv = previousArgv
      if (previousPiE2e === undefined) delete process.env.PI_E2E
      else process.env.PI_E2E = previousPiE2e
      if (previousScenario === undefined) delete process.env.PI_E2E_SCRIPTED_RUNTIME_SCENARIO
      else process.env.PI_E2E_SCRIPTED_RUNTIME_SCENARIO = previousScenario
      if (previousToken === undefined) delete process.env.PI_E2E_SCRIPTED_RUNTIME_TOKEN
      else process.env.PI_E2E_SCRIPTED_RUNTIME_TOKEN = previousToken
    }
  })

  it('passes an opaque Scripted launch only when the development token gates and controlled paths match', async () => {
    const { scenarioPath, eventLogPath } = await tempControlledRuntimeFixture()
    const token = 'c'.repeat(64)
    const previous = {
      piE2e: process.env.PI_E2E,
      scenario: process.env.PI_E2E_SCRIPTED_RUNTIME_SCENARIO,
      eventLog: process.env.PI_E2E_EVENT_LOG,
      token: process.env.PI_E2E_SCRIPTED_RUNTIME_TOKEN,
      argv: [...process.argv],
    }
    try {
      process.env.PI_E2E = '1'
      process.env.PI_E2E_SCRIPTED_RUNTIME_SCENARIO = scenarioPath
      process.env.PI_E2E_EVENT_LOG = eventLogPath
      process.env.PI_E2E_SCRIPTED_RUNTIME_TOKEN = token
      process.argv = [...previous.argv, `--pi-e2e-scripted-runtime-token=${token}`]

      getDefaultCollaborationHubApplication()

      expect(mocks.createRuntimeComposition).toHaveBeenCalledWith({
        userDataDir: 'D:/fake-xiaogui-user-data',
        productionEnabled: false,
        lookup: mocks.scopeLookup,
        codingPermissionModeProvider: expect.any(Function),
        piE2eScriptedRuntimeLaunch: { scenarioPath, eventLogPath },
        runtimeRoutingPolicy: expect.objectContaining({
          priorityAdapterIds: ['pi-e2e-scripted-local'],
        }),
      })
    } finally {
      process.argv = previous.argv
      for (const [key, value] of [
        ['PI_E2E', previous.piE2e],
        ['PI_E2E_SCRIPTED_RUNTIME_SCENARIO', previous.scenario],
        ['PI_E2E_EVENT_LOG', previous.eventLog],
        ['PI_E2E_SCRIPTED_RUNTIME_TOKEN', previous.token],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

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
      codingPermissionModeProvider: expect.any(Function),
    })
    const firstPermissionModeProvider = mocks.createRuntimeComposition.mock.calls[0]?.[0]
      ?.codingPermissionModeProvider as (() => unknown) | undefined
    expect(firstPermissionModeProvider?.()).toBe('CONFIRM_EACH')
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
      codingPermissionModeProvider: expect.any(Function),
    })
    const secondPermissionModeProvider = mocks.createRuntimeComposition.mock.calls[1]?.[0]
      ?.codingPermissionModeProvider as (() => unknown) | undefined
    mocks.codingPermissionMode = 'AUTONOMOUS'
    expect(secondPermissionModeProvider?.()).toBe('AUTONOMOUS')
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

  it('registers the six delivery handlers when using the default runtime composition', async () => {
    registerCollaborationHubHandlers()

    expect([...mocks.handlers.keys()].filter((channel) => channel.startsWith('ipc:xiaogui.delivery.')).sort()).toEqual([
      'ipc:xiaogui.delivery.apply.reconcile',
      'ipc:xiaogui.delivery.apply.recovery.prepare',
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

  it('registers a versioned batch execution IPC method and forwards only its narrow 1..2 item shape', async () => {
    registerCollaborationHubHandlers()
    const startBatch = mocks.handlers.get('ipc:xiaogui.hub.execution.startBatch')!
    const taskExecution = mocks.runtimeCompositions[0]!.taskExecution
    const valid = {
      contractVersion: 'xiaogui.task-execution.batch.v1',
      address: ADDRESS,
      flowId: 'xhbf_flow',
      items: [
        { taskRunId: 'xhbtr_a', prompt: '完成 A', files: [{ operation: 'MODIFY', relativePath: 'src/a.ts' }] },
        { taskRunId: 'xhbtr_b', prompt: '完成 B', files: [{ operation: 'CREATE', relativePath: 'src/b.ts' }] },
      ],
    }

    await expect(startBatch(valid)).resolves.toMatchObject({
      ok: true,
      value: { contractVersion: 'xiaogui.task-execution.batch.v1', items: [{ taskRunId: 'xhbtr_a' }, { taskRunId: 'xhbtr_b' }] },
    })
    expect(taskExecution.startBatch).toHaveBeenCalledOnce()

    for (const payload of [
      { ...valid, contractVersion: 'xiaogui.task-execution.batch.v2' },
      { ...valid, items: [] },
      { ...valid, items: [...valid.items, valid.items[0]] },
      { ...valid, items: [{ ...valid.items[0], adapterId: 'kimi-acp' }] },
      { ...valid, items: [{ ...valid.items[0], files: [{ operation: 'MODIFY', relativePath: '../outside.ts' }] }] },
    ]) {
      await expect(startBatch(payload)).resolves.toMatchObject({
        ok: false,
        error: { code: 'EXECUTION_INPUT_INVALID' },
      })
    }
    expect(taskExecution.startBatch).toHaveBeenCalledOnce()
  })

  it('does not accept an ambient event-log host path when the Scripted launch gate is closed', async () => {
    const eventLogPath = await tempDb('ambient-events.jsonl')
    const previousPiE2e = process.env.PI_E2E
    const previousEventLog = process.env.PI_E2E_EVENT_LOG
    try {
      process.env.PI_E2E = '1'
      process.env.PI_E2E_EVENT_LOG = eventLogPath
      registerCollaborationHubHandlers()
      const startBatch = mocks.handlers.get('ipc:xiaogui.hub.execution.startBatch')!

      await startBatch({
        contractVersion: 'xiaogui.task-execution.batch.v1',
        address: ADDRESS,
        flowId: 'xhbf_flow',
        items: [
          { taskRunId: 'xhbtr_a', prompt: '完成 A', files: [{ operation: 'MODIFY', relativePath: 'src/a.ts' }] },
        ],
      })

      expect(existsSync(eventLogPath)).toBe(false)
    } finally {
      if (previousPiE2e === undefined) delete process.env.PI_E2E
      else process.env.PI_E2E = previousPiE2e
      if (previousEventLog === undefined) delete process.env.PI_E2E_EVENT_LOG
      else process.env.PI_E2E_EVENT_LOG = previousEventLog
    }
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
