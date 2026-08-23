import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeRuntimeComposition: vi.fn(),
  registerCollaborationHubHandlers: vi.fn(),
  registerWorkDocxHandlers: vi.fn(),
  registerXiaoguiHandlers: vi.fn(),
  shutdownSidecar: vi.fn(),
  collaborationApplication: { kind: 'collaboration-application' },
  workDocxService: { kind: 'work-docx-service' },
  collaborationHandler: vi.fn(),
  workDocxHandler: vi.fn(),
  routedHandler: vi.fn(),
  createCollaborationHandler: vi.fn(),
  createWorkDocxHandler: vi.fn(),
  createRouter: vi.fn(),
  getCollaborationApplication: vi.fn(),
  getWorkDocxService: vi.fn(),
  setHostToolRequestHandler: vi.fn(),
  scopeResolver: { kind: 'scope-resolver' },
}))

vi.mock('./ipc-handlers', () => ({
  registerXiaoguiHandlers: mocks.registerXiaoguiHandlers,
}))

vi.mock('./sidecar-bridge', () => ({
  xiaogui: { shutdown: mocks.shutdownSidecar },
}))

vi.mock('./task-hub/ipc', () => ({
  closeDefaultCollaborationHubRuntimeComposition: mocks.closeRuntimeComposition,
  getDefaultCollaborationHubApplication: mocks.getCollaborationApplication,
  registerCollaborationHubHandlers: mocks.registerCollaborationHubHandlers,
}))

vi.mock('./work-docx-ipc', () => ({
  getDefaultWorkDocxServiceV1: mocks.getWorkDocxService,
  registerWorkDocxHandlers: mocks.registerWorkDocxHandlers,
}))

vi.mock('./task-hub/worker-tool', () => ({
  createXiaoguiWorkerToolHandlerV1: mocks.createCollaborationHandler,
}))

vi.mock('./work-docx-worker-tool', () => ({
  createXiaoguiWorkDocxWorkerToolHandlerV1: mocks.createWorkDocxHandler,
}))

vi.mock('./worker-host-tool-router', () => ({
  createXiaoguiWorkerHostToolRouterV1: mocks.createRouter,
}))

vi.mock('../worker-manager', () => ({
  workerManager: { setHostToolRequestHandler: mocks.setHostToolRequestHandler },
}))

vi.mock('./scope-service', () => ({
  sessionScopeResolverV1: mocks.scopeResolver,
}))

import { initXiaogui, shutdownXiaoguiSidecar } from './index'

afterEach(() => {
  vi.clearAllMocks()
})

describe('xiaogui shutdown lifecycle', () => {
  it('starts both owned shutdowns and waits until both have settled', async () => {
    const sidecar = deferred<void>()
    const runtime = deferred<void>()
    mocks.shutdownSidecar.mockReturnValueOnce(sidecar.promise)
    mocks.closeRuntimeComposition.mockReturnValueOnce(runtime.promise)

    let settled = false
    const shutdown = shutdownXiaoguiSidecar().then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(mocks.shutdownSidecar).toHaveBeenCalledOnce()
    expect(mocks.closeRuntimeComposition).toHaveBeenCalledOnce()

    sidecar.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    runtime.resolve()
    await shutdown
    expect(settled).toBe(true)
  })
})

describe('xiaogui Worker host-tool wiring', () => {
  it('routes collaboration and WORK DOCX through the single WorkerManager handler', () => {
    mocks.getCollaborationApplication.mockReturnValue(mocks.collaborationApplication)
    mocks.getWorkDocxService.mockReturnValue(mocks.workDocxService)
    mocks.createCollaborationHandler.mockReturnValue(mocks.collaborationHandler)
    mocks.createWorkDocxHandler.mockReturnValue(mocks.workDocxHandler)
    mocks.createRouter.mockReturnValue(mocks.routedHandler)

    initXiaogui()

    expect(mocks.createCollaborationHandler).toHaveBeenCalledWith({
      application: mocks.collaborationApplication,
      scopeResolver: mocks.scopeResolver,
    })
    expect(mocks.createWorkDocxHandler).toHaveBeenCalledWith({
      getService: mocks.getWorkDocxService,
      scopeResolver: mocks.scopeResolver,
    })
    expect(mocks.createRouter).toHaveBeenCalledWith({
      collaboration: mocks.collaborationHandler,
      workDocx: mocks.workDocxHandler,
    })
    expect(mocks.setHostToolRequestHandler).toHaveBeenCalledWith(mocks.routedHandler)
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
