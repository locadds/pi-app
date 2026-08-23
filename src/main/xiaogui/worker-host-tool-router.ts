import {
  XIAOGUI_CREATE_COLLABORATION_PLAN_METHOD_V1,
  XIAOGUI_WORK_DOCX_METHOD_V1,
  XIAOGUI_WORK_DOCUMENT_SNAPSHOT_METHOD_V1,
} from '@shared/worker-host-tools'

import type { WorkerHostToolRequestHandler } from '../worker-manager-types'

export interface XiaoguiWorkerHostToolRouterOptionsV1 {
  collaboration: WorkerHostToolRequestHandler
  workDocx: WorkerHostToolRequestHandler
  workDocumentSnapshot: WorkerHostToolRequestHandler
}

/** WorkerManager 只暴露一个 host-tool 接缝；领域 Adapter 在主进程内按版本化方法路由。 */
export function createXiaoguiWorkerHostToolRouterV1(
  options: XiaoguiWorkerHostToolRouterOptionsV1,
): WorkerHostToolRequestHandler {
  return (payload) => {
    switch (payload.request.method) {
      case XIAOGUI_CREATE_COLLABORATION_PLAN_METHOD_V1:
        return options.collaboration(payload)
      case XIAOGUI_WORK_DOCX_METHOD_V1:
        return options.workDocx(payload)
      case XIAOGUI_WORK_DOCUMENT_SNAPSHOT_METHOD_V1:
        return options.workDocumentSnapshot(payload)
      default:
        return Promise.resolve({
          ok: false,
          error: {
            code: 'HOST_TOOL_REQUEST_INVALID',
            message: '请求的小规能力不存在或版本不受支持',
          },
        })
    }
  }
}
