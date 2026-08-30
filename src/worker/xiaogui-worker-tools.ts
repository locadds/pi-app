import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'

import {
  isXiaoguiCapabilityToolAllowedInModeV1,
  workerBuiltinToolNamesForModeV1,
} from '@shared/xiaogui-prompt-capabilities'
import type { XiaoguiPromptContextV1 } from '@shared/xiaogui-prompt-contract'

import {
  addXiaoguiCollaborationTool,
  type XiaoguiCollaborationToolOptions,
} from './xiaogui-collaboration-tool'
import { addXiaoguiWorkDocxAdvancedGenerationTool } from './xiaogui-work-docx-advanced-generation-tool'
import { addXiaoguiWorkDocumentSnapshotTool } from './xiaogui-work-document-snapshot-tool'
import { addXiaoguiWorkReportDocxTool } from './xiaogui-work-report-docx-tool'
import {
  addXiaoguiWorkDocxTemplateDataTool,
  type XiaoguiWorkDocxTemplateDataToolOptions,
} from './xiaogui-work-docx-template-data-tool'
import { addXiaoguiWorkDocxTemplateIntakeTool } from './xiaogui-work-docx-template-intake-tool'
import { addXiaoguiWorkDocxTemplateMaterializeTool } from './xiaogui-work-docx-template-materialize-tool'

export interface XiaoguiWorkerToolOptionsV1 {
  readonly collaboration: XiaoguiCollaborationToolOptions
  readonly session: XiaoguiWorkDocxTemplateDataToolOptions
}

function removeKnownContextDisallowedTools(
  result: LoadExtensionsResult,
  context: Pick<XiaoguiPromptContextV1, 'mode'>,
): LoadExtensionsResult {
  return {
    ...result,
    extensions: result.extensions.map((extension) => ({
      ...extension,
      tools: new Map([...extension.tools].filter(([name]) =>
        isXiaoguiCapabilityToolAllowedInModeV1(name, context.mode),
      )),
    })),
  }
}

export function addXiaoguiWorkerToolsV1(
  result: LoadExtensionsResult,
  context: Pick<XiaoguiPromptContextV1, 'mode'>,
  options: XiaoguiWorkerToolOptionsV1,
): LoadExtensionsResult {
  // Register every mode-compatible candidate. The live AgentSession applies
  // the per-turn Host Tool Policy with setActiveToolsByName().
  const allowed = new Set(workerBuiltinToolNamesForModeV1(context.mode))
  let loaded = removeKnownContextDisallowedTools(result, context)
  if (allowed.has('xiaogui_create_collaboration_plan')) {
    loaded = addXiaoguiCollaborationTool(loaded, options.collaboration)
  }
  if (allowed.has('xiaogui_work_docx')) {
    loaded = addXiaoguiWorkDocxTemplateDataTool(loaded, options.session)
  }
  if (allowed.has('xiaogui_work_docx_template_intake')) {
    loaded = addXiaoguiWorkDocxTemplateIntakeTool(loaded, options.session)
  }
  if (allowed.has('xiaogui_work_docx_template_materialize')) {
    loaded = addXiaoguiWorkDocxTemplateMaterializeTool(loaded, options.session)
  }
  if (allowed.has('xiaogui_read_pdf')) {
    loaded = addXiaoguiWorkDocumentSnapshotTool(loaded, options.session)
  }
  if (allowed.has('xiaogui_work_docx_advanced_generation')) {
    loaded = addXiaoguiWorkDocxAdvancedGenerationTool(loaded, options.session)
  }
  if (allowed.has('xiaogui_work_report_docx')) {
    loaded = addXiaoguiWorkReportDocxTool(loaded, options.session)
  }
  return loaded
}
