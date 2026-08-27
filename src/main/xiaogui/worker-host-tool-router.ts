import {
  XIAOGUI_CREATE_COLLABORATION_PLAN_METHOD_V1,
  XIAOGUI_WORK_DOCX_METHOD_V1,
  XIAOGUI_WORK_REPORT_DOCX_METHOD_V1,
  XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_METHOD_V1,
  XIAOGUI_WORK_DOCX_TEMPLATE_DATA_METHOD_V1,
  XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_METHOD_V1,
  XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_METHOD_V1,
  XIAOGUI_WORK_DOCUMENT_SNAPSHOT_METHOD_V1,
} from '@shared/worker-host-tools'

import type { WorkerHostToolRequestHandler } from '../worker-manager-types'

export interface XiaoguiWorkerHostToolRouterOptionsV1 {
  collaboration: WorkerHostToolRequestHandler
  workDocx: WorkerHostToolRequestHandler
  workReportDocx: WorkerHostToolRequestHandler
  workDocxAdvancedGeneration: WorkerHostToolRequestHandler
  workDocxTemplateData: WorkerHostToolRequestHandler
  workDocxTemplateIntake: WorkerHostToolRequestHandler
  workDocxTemplateMaterialize: WorkerHostToolRequestHandler
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
      case XIAOGUI_WORK_REPORT_DOCX_METHOD_V1:
        return options.workReportDocx(payload)
      case XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_METHOD_V1:
        return options.workDocxAdvancedGeneration(payload)
      case XIAOGUI_WORK_DOCX_TEMPLATE_DATA_METHOD_V1:
        return options.workDocxTemplateData(payload)
      case XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_METHOD_V1:
        return options.workDocxTemplateIntake(payload)
      case XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_METHOD_V1:
        return options.workDocxTemplateMaterialize(payload)
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
