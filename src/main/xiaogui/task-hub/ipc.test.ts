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
  scopeLookup: { lookup: vi.fn() },
  runtimeCompositions: [] as Array<{
    application: { generation: number }
    close: ReturnType<typeof vi.fn>
    stageAttemptInput: ReturnType<typeof vi.fn>
  }>,
  createRuntimeComposition: vi.fn(),
}))

mocks.createRuntimeComposition.mockImplementation(() => {
  const composition = {
    application: { generation: mocks.runtimeCompositions.length + 1 },
    close: vi.fn(async () => undefined),
    stageAttemptInput: vi.fn(),
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

vi.mock('../scope-service', () => ({
  sessionScopeResolverV1: mocks.scopeLookup,
}))

vi.mock('./runtime-composition', () => ({
  createXiaoguiRuntimeCompositionV1: mocks.createRuntimeComposition,
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
  it('lazily owns one disabled runtime composition and rebuilds it only after close', async () => {
    expect(mocks.getElectronPath).not.toHaveBeenCalled()
    expect(mocks.createRuntimeComposition).not.toHaveBeenCalled()

    const firstApplication = getDefaultCollaborationHubApplication()
    const firstComposition = mocks.runtimeCompositions[0]!

    expect(mocks.getElectronPath).toHaveBeenCalledOnce()
    expect(mocks.getElectronPath).toHaveBeenCalledWith('userData')
    expect(mocks.createRuntimeComposition).toHaveBeenCalledOnce()
    expect(mocks.createRuntimeComposition).toHaveBeenCalledWith({
      userDataDir: 'D:/fake-xiaogui-user-data',
      productionEnabled: false,
      lookup: mocks.scopeLookup,
    })
    expect(getDefaultCollaborationHubApplication()).toBe(firstApplication)
    expect(mocks.createRuntimeComposition).toHaveBeenCalledOnce()

    await closeDefaultCollaborationHubRuntimeComposition()
    await closeDefaultCollaborationHubRuntimeComposition()
    expect(firstComposition.close).toHaveBeenCalledOnce()

    expect(getDefaultCollaborationHubApplication()).not.toBe(firstApplication)
    expect(mocks.createRuntimeComposition).toHaveBeenCalledTimes(2)
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
