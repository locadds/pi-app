/**
 * 小规集成入口：由 src/main/index.ts 在 app.whenReady() 后调用。
 *
 * 职责：
 * - 注册小规 IPC handlers（白名单见 packages/shared/ipc-channels.ts）。
 *
 * sidecar 优雅退出已并入主进程 gracefulShutdownWorkers 链（带超时 await），
 * 不再在 before-quit 里 fire-and-forget——否则 app.exit(0) 会竞态残留孤儿
 * python 进程。见 shutdownXiaoguiSidecar。
 */

import { registerXiaoguiHandlers } from './ipc-handlers'
import { xiaogui } from './sidecar-bridge'
import {
  closeDefaultCollaborationHubRuntimeComposition,
  registerCollaborationHubHandlers,
} from './task-hub/ipc'
import { getDefaultWorkDocxServiceV1, registerWorkDocxHandlers } from './work-docx-ipc'
import { getDefaultWorkDocumentSnapshotServiceV1 } from './work-document-snapshot-composition'
import { workerManager } from '../worker-manager'
import { sessionScopeResolverV1 } from './scope-service'
import { createXiaoguiWorkerToolHandlerV1 } from './task-hub/worker-tool'
import { getDefaultCollaborationHubApplication } from './task-hub/ipc'
import { createXiaoguiWorkDocxWorkerToolHandlerV1 } from './work-docx-worker-tool'
import { createXiaoguiWorkDocxTemplateDataWorkerToolHandlerV1 } from './work-docx-template-data-worker-tool'
import {
  closeDefaultWorkDocxTemplateIntakeServiceV1,
  getDefaultWorkDocxTemplateIntakeServiceV1,
} from './work-docx-template-intake-composition'
import { createXiaoguiWorkDocxTemplateIntakeWorkerToolHandlerV1 } from './work-docx-template-intake-worker-tool'
import {
  closeDefaultWorkDocxTemplateMaterializeServiceV1,
  getDefaultWorkDocxTemplateMaterializeServiceV1,
} from './work-docx-template-materialize-composition'
import { createXiaoguiWorkDocxTemplateMaterializeWorkerToolHandlerV1 } from './work-docx-template-materialize-worker-tool'
import { createXiaoguiWorkDocumentSnapshotWorkerToolHandlerV1 } from './work-document-snapshot-worker-tool'
import { createXiaoguiWorkerHostToolRouterV1 } from './worker-host-tool-router'

let initialized = false

export function initXiaogui(): void {
  if (initialized) return
  initialized = true

  registerXiaoguiHandlers()
  registerCollaborationHubHandlers()
  registerWorkDocxHandlers()
  workerManager.setHostToolRequestHandler(
    createXiaoguiWorkerHostToolRouterV1({
      collaboration: createXiaoguiWorkerToolHandlerV1({
        application: getDefaultCollaborationHubApplication(),
        scopeResolver: sessionScopeResolverV1,
      }),
      workDocx: createXiaoguiWorkDocxWorkerToolHandlerV1({
        getService: getDefaultWorkDocxServiceV1,
        scopeResolver: sessionScopeResolverV1,
      }),
      workDocxTemplateData: createXiaoguiWorkDocxTemplateDataWorkerToolHandlerV1({
        getService: getDefaultWorkDocxServiceV1,
        scopeResolver: sessionScopeResolverV1,
      }),
      workDocxTemplateIntake: createXiaoguiWorkDocxTemplateIntakeWorkerToolHandlerV1({
        getService: getDefaultWorkDocxTemplateIntakeServiceV1,
        scopeResolver: sessionScopeResolverV1,
      }),
      workDocxTemplateMaterialize: createXiaoguiWorkDocxTemplateMaterializeWorkerToolHandlerV1({
        getService: getDefaultWorkDocxTemplateMaterializeServiceV1,
        scopeResolver: sessionScopeResolverV1,
      }),
      workDocumentSnapshot: createXiaoguiWorkDocumentSnapshotWorkerToolHandlerV1({
        getService: getDefaultWorkDocumentSnapshotServiceV1,
        scopeResolver: sessionScopeResolverV1,
      }),
    }),
  )

  console.log('[xiaogui] 集成层已初始化（sidecar 惰性启动：首次 tool.invoke 时 spawn）')
}

/** 优雅停止 Python sidecar 与内嵌任务中枢运行时。 */
export async function shutdownXiaoguiSidecar(): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => xiaogui.shutdown()),
    Promise.resolve().then(() => closeDefaultCollaborationHubRuntimeComposition()),
    Promise.resolve().then(() => closeDefaultWorkDocxTemplateIntakeServiceV1()),
    Promise.resolve().then(() => closeDefaultWorkDocxTemplateMaterializeServiceV1()),
  ])
  const firstFailure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (firstFailure) throw firstFailure.reason
}
