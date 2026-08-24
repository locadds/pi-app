import {
  createSyntheticSourceInfo,
  defineTool,
  type Extension,
  type LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import {
  XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_METHOD_V1,
  type XiaoguiWorkDocxTemplateMaterializeResultV1,
  type WorkerHostToolErrorCodeV1,
} from '@shared/worker-host-tools'

import { requestWorkerHostTool } from './worker-host-tool-channel.js'

export const XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_TOOL_NAME =
  'xiaogui_work_docx_template_materialize'

const ActionSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal('PREPARE'),
      reportId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    },
    { additionalProperties: false },
  ),
  ...(['CONFIRM', 'RESUME', 'CANCEL', 'OPEN', 'REVEAL'] as const).map((action) =>
    Type.Object({ action: Type.Literal(action) }, { additionalProperties: false }),
  ),
])

export interface XiaoguiWorkDocxTemplateMaterializeToolOptionsV1 {
  getSourceSessionId: () => string | undefined
  getSourceRunId: () => string | undefined
}

type SafeDetails =
  | XiaoguiWorkDocxTemplateMaterializeResultV1
  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED'
      code: WorkerHostToolErrorCodeV1
      message: string
    }

function publicText(details: SafeDetails): string {
  switch (details.kind) {
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PREPARED': {
      const plan = details.plan
      const advanced = plan.advancedGenerationRequired
        ? '重复块或条件块已写入 Word 内容控件，当前简单字段生成器不会展开这些结构。'
        : ''
      return `已生成并打开只读模板预览：变量 ${plan.variables.length} 项、重复块 ${plan.repeatBlocks.length} 项、条件块 ${plan.conditionalBlocks.length} 项、排除 ${plan.excludedCandidateCount} 项、移除媒体 ${plan.removedMediaCount} 项。原 Word 未修改。请检查预览后，在下一条消息中明确确认是否另存正式模板。${advanced}`
    }
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_RESUMED':
      return details.receipt
        ? '已恢复已发布的正式模板记录。'
        : '已重新核对源文件和确认记录，并重新生成、打开模板预览。原 Word 未修改。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_TARGET_SELECTION_CANCELLED':
      return '已取消选择正式模板保存位置；预览仍保留，可稍后再次确认。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PUBLISHED':
      return `正式模板已另存完成：变量 ${details.receipt.variableNames.length} 项、重复块 ${details.receipt.repeatBlockNames.length} 项、条件块 ${details.receipt.conditionalBlockNames.length} 项、排除 ${details.receipt.excludedCandidateCount} 项。原 Word 未修改。`
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_CANCELLED':
      return '已取消模板物化并清理受控预览；原 Word 未修改。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_ACCESSED':
      return details.action === 'OPEN' ? '已打开正式模板。' : '已在文件夹中定位正式模板。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED':
      return details.message
  }
}

export function addXiaoguiWorkDocxTemplateMaterializeTool(
  loaded: LoadExtensionsResult,
  options: XiaoguiWorkDocxTemplateMaterializeToolOptionsV1,
): LoadExtensionsResult {
  const sourceInfo = createSyntheticSourceInfo('<builtin:xiaogui-work-docx-template-materialize>', {
    source: 'xiaogui-desktop',
    scope: 'temporary',
    origin: 'top-level',
  })
  const definition = defineTool<typeof ActionSchema, SafeDetails>({
    name: XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_TOOL_NAME,
    label: '生成正式 Word 模板',
    description: '把已人工确认的普通 Word 整理报告生成受控预览，并在下一轮确认后另存为全新正式模板。',
    promptSnippet: '从已确认的模板整理报告生成预览、确认另存、恢复、取消、打开或定位正式模板',
    promptGuidelines: [
      '只有用户已经完成普通 Word 整理报告的人工确认，并明确要求生成正式模板时，才调用 PREPARE。',
      'PREPARE 生成并打开预览后必须结束本轮；同一轮绝对不能继续调用 CONFIRM。',
      '只有用户下一条消息明确表示已看过预览并确认另存时，才调用 CONFIRM。',
      '用户取消保存位置后不要自动重试；等待用户下一条消息。',
      '不要展示或索要源文件、预览文件、正式模板、数据库或临时目录的绝对路径。',
      '重复块和条件块使用 Word 内容控件，当前简单字段生成器不会展开；必须如实告诉用户这个能力边界。',
      '不得声称覆盖或修改了原 Word；正式模板只能另存为不存在的新 DOCX。',
    ],
    parameters: ActionSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const sourceSessionId = options.getSourceSessionId()
      const sourceRunId = options.getSourceRunId()
      if (!sourceSessionId || !sourceRunId) {
        const details: SafeDetails = {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED',
          code: 'SESSION_NOT_READY',
          message: '当前用户指令尚未建立完成，请重新发送后再试',
        }
        return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
      }
      const outcome = await requestWorkerHostTool(
        {
          method: XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_METHOD_V1,
          payload: { ...params, sourceSessionId, sourceRunId, toolCallId },
        },
        signal,
      )
      if (!outcome.ok) {
        const details: SafeDetails = {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED',
          code: outcome.error.code,
          message: outcome.error.message,
        }
        return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
      }
      const result = outcome.value
      if (!result.kind.startsWith('XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_')) {
        const details: SafeDetails = {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED',
          code: 'HOST_TOOL_FAILED',
          message: '模板物化返回了不支持的结果',
        }
        return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
      }
      const details = result as XiaoguiWorkDocxTemplateMaterializeResultV1
      return { content: [{ type: 'text', text: publicText(details) }], details }
    },
  })
  const extension: Extension = {
    path: sourceInfo.path,
    resolvedPath: sourceInfo.path,
    hidden: true,
    sourceInfo,
    handlers: new Map(),
    tools: new Map([[definition.name, { definition, sourceInfo }]]),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  }
  return { ...loaded, extensions: [...loaded.extensions, extension] }
}
