import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeRuntimeComposition: vi.fn(),
  closeWorkReportDocxService: vi.fn(),
  registerCollaborationHubHandlers: vi.fn(),
  registerWorkDocxHandlers: vi.fn(),
  registerTemplateLibraryHandlers: vi.fn(),
  registerDocumentReviewHandlers: vi.fn(),
  registerOfficeSurfaceHandlers: vi.fn(),
  registerCodingContextHandlers: vi.fn(),
  registerCodingAttemptHandlers: vi.fn(),
  registerCodingRoleHandlers: vi.fn(),
  closeCodingRoleProfiles: vi.fn(),
  registerCodingCheckpointHandlers: vi.fn(),
  closeCodingCheckpointComposition: vi.fn(),
  recordCodingCheckpointSessionAddress: vi.fn(),
  registerXiaoguiHandlers: vi.fn(),
  shutdownSidecar: vi.fn(),
  collaborationApplication: { kind: 'collaboration-application' },
  workDocxService: { kind: 'work-docx-service' },
  workReportDocxService: { kind: 'work-report-docx-service' },
  workDocumentSnapshotService: { kind: 'work-document-snapshot-service' },
  workMaterialsService: { kind: 'work-materials-service' },
  codingPlanModule: { kind: 'coding-plan-module', publishPendingDraft: vi.fn() },
  codingReviewModule: { kind: 'coding-review-module' },
  codingRoleProfileModule: { kind: 'coding-role-profile-module' },
  taskExecutionOrchestrator: { kind: 'task-execution-orchestrator' },
  collaborationHandler: vi.fn(),
  workDocxHandler: vi.fn(),
  workReportDocxHandler: vi.fn(),
  workDocumentSnapshotHandler: vi.fn(),
  workMaterialsHandler: vi.fn(),
  codingPlanHandler: vi.fn(),
  routedHandler: vi.fn(),
  createCollaborationHandler: vi.fn(),
  createWorkDocxHandler: vi.fn(),
  createWorkReportDocxHandler: vi.fn(),
  createWorkDocumentSnapshotHandler: vi.fn(),
  createWorkMaterialsHandler: vi.fn(),
  createCodingPlanHandler: vi.fn(),
  createRouter: vi.fn(),
  getCollaborationApplication: vi.fn(),
  getWorkDocxService: vi.fn(),
  getWorkReportDocxService: vi.fn(),
  getWorkDocumentSnapshotService: vi.fn(),
  getWorkMaterialsService: vi.fn(),
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
  getDefaultCodingAttemptPlanModuleV1: () => mocks.codingPlanModule,
  getDefaultCodingAttemptReviewModuleV1: () => mocks.codingReviewModule,
  getDefaultCodingRoleProfileModuleV1: () => mocks.codingRoleProfileModule,
  getDefaultTaskExecutionOrchestrator: () => mocks.taskExecutionOrchestrator,
  registerCollaborationHubHandlers: mocks.registerCollaborationHubHandlers,
}))

vi.mock('./coding-extensions/context-ipc', () => ({
  registerCodingContextHandlersV1: mocks.registerCodingContextHandlers,
}))

vi.mock('./coding-extensions/attempt-ipc', () => ({
  registerCodingAttemptHandlersV1: mocks.registerCodingAttemptHandlers,
}))

vi.mock('./coding-extensions/role-production-composition', () => ({
  registerDefaultCodingRoleHandlersV1: mocks.registerCodingRoleHandlers,
  closeDefaultCodingRoleProfileModuleV1: mocks.closeCodingRoleProfiles,
}))

vi.mock('./coding-extensions/checkpoint-default-composition', () => ({
  registerDefaultCodingCheckpointHandlersV1: mocks.registerCodingCheckpointHandlers,
  closeDefaultCodingCheckpointProductionCompositionV1: mocks.closeCodingCheckpointComposition,
  recordDefaultCodingCheckpointSessionAddressV1: mocks.recordCodingCheckpointSessionAddress,
}))

vi.mock('./coding-extensions/plan-worker-tool', () => ({
  createXiaoguiCodingPlanWorkerToolHandlerV1: mocks.createCodingPlanHandler,
}))

vi.mock('./work-docx-ipc', () => ({
  getDefaultWorkDocxServiceV1: mocks.getWorkDocxService,
  registerWorkDocxHandlers: mocks.registerWorkDocxHandlers,
}))

vi.mock('./template-library-ipc', () => ({
  registerTemplateLibraryHandlersV1: mocks.registerTemplateLibraryHandlers,
}))

vi.mock('./work-document-review-ipc', () => ({
  registerDocumentReviewHandlersV1: mocks.registerDocumentReviewHandlers,
}))

vi.mock('./office-surface/ipc', () => ({
  closeOfficeSurfaceSessionsV1: vi.fn(),
  registerOfficeSurfaceHandlersV1: mocks.registerOfficeSurfaceHandlers,
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

vi.mock('./work-materials-composition', () => ({
  getDefaultWorkMaterialsServiceV1: mocks.getWorkMaterialsService,
}))

vi.mock('./work-materials-worker-tool', () => ({
  createXiaoguiWorkMaterialsWorkerToolHandlerV1: mocks.createWorkMaterialsHandler,
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
    expect(mocks.closeCodingRoleProfiles).toHaveBeenCalledOnce()
    expect(mocks.closeCodingCheckpointComposition).toHaveBeenCalledOnce()

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
    mocks.getWorkDocxService.mockReturnValue(mocks.workDocxService)
    mocks.getWorkReportDocxService.mockReturnValue(mocks.workReportDocxService)
    mocks.getWorkDocumentSnapshotService.mockReturnValue(mocks.workDocumentSnapshotService)
    mocks.getWorkMaterialsService.mockReturnValue(mocks.workMaterialsService)
    mocks.createCollaborationHandler.mockReturnValue(mocks.collaborationHandler)
    mocks.createWorkDocxHandler.mockReturnValue(mocks.workDocxHandler)
    mocks.createWorkReportDocxHandler.mockReturnValue(mocks.workReportDocxHandler)
    mocks.createWorkDocumentSnapshotHandler.mockReturnValue(mocks.workDocumentSnapshotHandler)
    mocks.createWorkMaterialsHandler.mockReturnValue(mocks.workMaterialsHandler)
    mocks.createCodingPlanHandler.mockReturnValue(mocks.codingPlanHandler)
    mocks.createRouter.mockReturnValue(mocks.routedHandler)

    initXiaogui()

    expect(mocks.registerCodingAttemptHandlers).toHaveBeenCalledWith({
      plan: mocks.codingPlanModule,
      review: mocks.codingReviewModule,
      roles: mocks.codingRoleProfileModule,
      taskExecution: mocks.taskExecutionOrchestrator,
    })
    expect(mocks.registerCodingRoleHandlers).toHaveBeenCalledOnce()
    expect(mocks.registerCodingCheckpointHandlers).toHaveBeenCalledOnce()
    expect(mocks.createCodingPlanHandler).toHaveBeenCalledWith({
      scopeResolver: mocks.scopeResolver,
      recordTrustedSessionAddress: mocks.recordCodingCheckpointSessionAddress,
      publishPendingDraft: expect.any(Function),
    })

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
    expect(mocks.createWorkMaterialsHandler).toHaveBeenCalledWith({
      getService: mocks.getWorkMaterialsService,
      scopeResolver: mocks.scopeResolver,
      hasPendingTemplateIntakeSource: expect.any(Function),
    })
    expect(mocks.createRouter).toHaveBeenCalledWith(expect.objectContaining({
      codingPlan: mocks.codingPlanHandler,
      collaboration: mocks.collaborationHandler,
      workDocx: mocks.workDocxHandler,
      workReportDocx: mocks.workReportDocxHandler,
      workDocumentSnapshot: mocks.workDocumentSnapshotHandler,
      workMaterials: mocks.workMaterialsHandler,
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
