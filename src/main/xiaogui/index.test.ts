import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeRuntimeComposition: vi.fn(),
  closeHubTaskWorkerService: vi.fn(),
  closeWorkReportDocxService: vi.fn(),
  closeTemplateLibraryService: vi.fn(),
  closeTemplateIntakeService: vi.fn(),
  closeTemplateMaterializeService: vi.fn(),
  closeAdvancedGenerationService: vi.fn(),
  registerCollaborationHubHandlers: vi.fn(),
  setHubTaskWorkerLifecycleReporter: vi.fn(),
  registerHubTaskWorkerHandlers: vi.fn(),
  registerWorkDocxHandlers: vi.fn(),
  registerTemplateLibraryHandlers: vi.fn(),
  registerDocumentReviewHandlers: vi.fn(),
  registerXiaoguiHandlers: vi.fn(),
  shutdownSidecar: vi.fn(),
  collaborationApplication: { kind: 'collaboration-application' },
  workDocxService: { kind: 'work-docx-service' },
  workReportDocxService: { kind: 'work-report-docx-service' },
  workDocumentSnapshotService: { kind: 'work-document-snapshot-service' },
  collaborationHandler: vi.fn(),
  workDocxHandler: vi.fn(),
  workReportDocxHandler: vi.fn(),
  workDocumentSnapshotHandler: vi.fn(),
  routedHandler: vi.fn(),
  createCollaborationHandler: vi.fn(),
  createWorkDocxHandler: vi.fn(),
  createWorkReportDocxHandler: vi.fn(),
  createWorkDocumentSnapshotHandler: vi.fn(),
  createRouter: vi.fn(),
  getCollaborationApplication: vi.fn(),
  getHubTaskWorkerService: vi.fn(),
  getHubTaskWorkerInstallationIdDigest: vi.fn(),
  getWorkDocxService: vi.fn(),
  getWorkReportDocxService: vi.fn(),
  getWorkDocumentSnapshotService: vi.fn(),
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
  setHubTaskWorkerLifecycleReporterV1: mocks.setHubTaskWorkerLifecycleReporter,
}))

vi.mock('./hub-task/worker-composition', () => ({
  closeDefaultHubTaskWorkerServiceV1: mocks.closeHubTaskWorkerService,
  getDefaultHubTaskWorkerServiceV1: mocks.getHubTaskWorkerService,
  getDefaultHubTaskWorkerInstallationIdDigestV1: mocks.getHubTaskWorkerInstallationIdDigest,
}))

vi.mock('./hub-task/worker-ipc', () => ({
  registerHubTaskWorkerHandlers: mocks.registerHubTaskWorkerHandlers,
}))

vi.mock('./work-docx-ipc', () => ({
  getDefaultWorkDocxServiceV1: mocks.getWorkDocxService,
  registerWorkDocxHandlers: mocks.registerWorkDocxHandlers,
}))

vi.mock('./template-library-ipc', () => ({
  registerTemplateLibraryHandlersV1: mocks.registerTemplateLibraryHandlers,
}))

vi.mock('./template-library-composition', () => ({
  closeDefaultTemplateLibraryServiceV1: mocks.closeTemplateLibraryService,
}))

vi.mock('./work-document-review-ipc', () => ({
  registerDocumentReviewHandlersV1: mocks.registerDocumentReviewHandlers,
}))

vi.mock('./work-docx-template-intake-composition', () => ({
  closeDefaultWorkDocxTemplateIntakeServiceV1: mocks.closeTemplateIntakeService,
  getDefaultWorkDocxTemplateIntakeServiceV1: vi.fn(),
}))

vi.mock('./work-docx-template-materialize-composition', () => ({
  closeDefaultWorkDocxTemplateMaterializeServiceV1: mocks.closeTemplateMaterializeService,
  getDefaultWorkDocxTemplateMaterializeServiceV1: vi.fn(),
}))

vi.mock('./work-docx-advanced-generation-composition', () => ({
  closeDefaultWorkDocxAdvancedGenerationServiceV1: mocks.closeAdvancedGenerationService,
  getDefaultWorkDocxAdvancedGenerationServiceV1: vi.fn(),
}))

vi.mock('./task-hub/worker-tool', () => ({
  createXiaoguiWorkerToolHandlerV1: mocks.createCollaborationHandler,
}))

vi.mock('./work-docx-worker-tool', () => ({
  createXiaoguiWorkDocxWorkerToolHandlerV1: mocks.createWorkDocxHandler,
}))

vi.mock('./work-report-docx-composition', () => ({
  closeDefaultWorkReportDocxServiceV1: mocks.closeWorkReportDocxService,
  getDefaultWorkReportDocxServiceV1: mocks.getWorkReportDocxService,
}))

vi.mock('./work-report-docx-worker-tool', () => ({
  createXiaoguiWorkReportDocxWorkerToolHandlerV1: mocks.createWorkReportDocxHandler,
}))

vi.mock('./work-document-snapshot-composition', () => ({
  getDefaultWorkDocumentSnapshotServiceV1: mocks.getWorkDocumentSnapshotService,
}))

vi.mock('./work-document-snapshot-worker-tool', () => ({
  createXiaoguiWorkDocumentSnapshotWorkerToolHandlerV1: mocks.createWorkDocumentSnapshotHandler,
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
    expect(mocks.closeHubTaskWorkerService).toHaveBeenCalledOnce()

    sidecar.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    runtime.resolve()
    await shutdown
    expect(settled).toBe(true)
  })
})

describe('xiaogui Worker host-tool wiring', () => {
  it('routes collaboration, WORK DOCX, and WORK document snapshot through the single WorkerManager handler', () => {
    mocks.getCollaborationApplication.mockReturnValue(mocks.collaborationApplication)
    mocks.getHubTaskWorkerService.mockReturnValue({ kind: 'hub-task-worker-service' })
    mocks.getHubTaskWorkerInstallationIdDigest.mockReturnValue(`sha256:${'a'.repeat(64)}`)
    mocks.getWorkDocxService.mockReturnValue(mocks.workDocxService)
    mocks.getWorkReportDocxService.mockReturnValue(mocks.workReportDocxService)
    mocks.getWorkDocumentSnapshotService.mockReturnValue(mocks.workDocumentSnapshotService)
    mocks.createCollaborationHandler.mockReturnValue(mocks.collaborationHandler)
    mocks.createWorkDocxHandler.mockReturnValue(mocks.workDocxHandler)
    mocks.createWorkReportDocxHandler.mockReturnValue(mocks.workReportDocxHandler)
    mocks.createWorkDocumentSnapshotHandler.mockReturnValue(mocks.workDocumentSnapshotHandler)
    mocks.createRouter.mockReturnValue(mocks.routedHandler)

    initXiaogui()

    expect(mocks.registerHubTaskWorkerHandlers).toHaveBeenCalledWith(
      { kind: 'hub-task-worker-service' },
      `sha256:${'a'.repeat(64)}`,
    )
    expect(mocks.setHubTaskWorkerLifecycleReporter).toHaveBeenCalledWith(
      { kind: 'hub-task-worker-service' },
    )

    expect(mocks.createCollaborationHandler).toHaveBeenCalledWith({
      application: mocks.collaborationApplication,
      scopeResolver: mocks.scopeResolver,
    })
    expect(mocks.createWorkDocxHandler).toHaveBeenCalledWith({
      getService: mocks.getWorkDocxService,
      scopeResolver: mocks.scopeResolver,
    })
    expect(mocks.createWorkReportDocxHandler).toHaveBeenCalledWith({
      getService: mocks.getWorkReportDocxService,
      scopeResolver: mocks.scopeResolver,
    })
    expect(mocks.createWorkDocumentSnapshotHandler).toHaveBeenCalledWith({
      getService: mocks.getWorkDocumentSnapshotService,
      scopeResolver: mocks.scopeResolver,
    })
    expect(mocks.createRouter).toHaveBeenCalledWith(expect.objectContaining({
      collaboration: mocks.collaborationHandler,
      workDocx: mocks.workDocxHandler,
      workReportDocx: mocks.workReportDocxHandler,
      workDocumentSnapshot: mocks.workDocumentSnapshotHandler,
    }))
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
