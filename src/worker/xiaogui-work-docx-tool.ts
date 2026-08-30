import {
  createSyntheticSourceInfo,
  defineTool,
  type Extension,
  type LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { XIAOGUI_LEGACY_WORK_DOCX_TOOL_PROMPT_DEFINITION_V1 } from '@shared/xiaogui-prompt-capabilities'
import {
  XIAOGUI_WORK_DOCX_METHOD_V1,
  type XiaoguiWorkDocxResultV1,
  type WorkerHostToolErrorCodeV1,
} from '@shared/worker-host-tools'

import { requestWorkerHostTool } from './worker-host-tool-channel.js'

const TOOL_PROMPT = XIAOGUI_LEGACY_WORK_DOCX_TOOL_PROMPT_DEFINITION_V1
export const XIAOGUI_WORK_DOCX_TOOL_NAME = TOOL_PROMPT.name

const WorkDocxActionSchema = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal('PREPARE'),
        Type.Literal('CONFIRM'),
        Type.Literal('CANCEL'),
        Type.Literal('OPEN'),
        Type.Literal('REVEAL'),
      ],
      {
        description:
          'PREPARE 选择模板、数据和另存位置；CONFIRM 生成；CANCEL 取消；OPEN 打开；REVEAL 在文件夹中显示。',
      },
    ),
  },
  { additionalProperties: false },
)

export interface XiaoguiWorkDocxToolOptions {
  getSourceSessionId: () => string | undefined
  getSourceRunId: () => string | undefined
}

type XiaoguiWorkDocxToolDetails =
  | XiaoguiWorkDocxResultV1
  | {
      kind: 'XIAOGUI_WORK_DOCX_FAILED'
      code: WorkerHostToolErrorCodeV1
      message: string
      traceId?: string
    }

function successText(result: XiaoguiWorkDocxResultV1): string {
  switch (result.kind) {
    case 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED':
      return '已取消文件选择，没有生成或写入文档。'
    case 'XIAOGUI_WORK_DOCX_PREPARED':
      return `已准备好生成文档：模板“${result.templateDisplayName}”，数据“${result.payloadDisplayName}”，共匹配 ${result.placeholders.length} 个字段。尚未生成文件，请确认是否生成，或告诉我取消。`
    case 'XIAOGUI_WORK_DOCX_CANCELLED':
      return '已取消本次文档生成，没有写入目标文件。'
    case 'XIAOGUI_WORK_DOCX_PUBLISHED':
      return '文档已经生成并通过结构校验，原始模板和数据未被修改。你可以让我打开文档，或在文件夹中显示。'
    case 'XIAOGUI_WORK_DOCX_ACCESSED':
      return result.action === 'OPEN' ? '已请求系统打开生成的文档。' : '已在文件夹中显示生成的文档。'
  }
}

export function addXiaoguiWorkDocxTool(
  result: LoadExtensionsResult,
  options: XiaoguiWorkDocxToolOptions,
): LoadExtensionsResult {
  const sourceInfo = createSyntheticSourceInfo('<builtin:xiaogui-work-docx>', {
    source: 'xiaogui-desktop',
    scope: 'temporary',
    origin: 'top-level',
  })
  const definition = defineTool<typeof WorkDocxActionSchema, XiaoguiWorkDocxToolDetails>({
    ...TOOL_PROMPT,
    parameters: WorkDocxActionSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const sourceSessionId = options.getSourceSessionId()
      const sourceRunId = options.getSourceRunId()
      if (!sourceSessionId || !sourceRunId) {
        const message = '当前用户指令尚未建立完成，请重新发送后再试'
        return {
          content: [{ type: 'text', text: message }],
          details: {
            kind: 'XIAOGUI_WORK_DOCX_FAILED' as const,
            code: 'SESSION_NOT_READY' as const,
            message,
          },
          isError: true,
        }
      }

      const outcome = await requestWorkerHostTool(
        {
          method: XIAOGUI_WORK_DOCX_METHOD_V1,
          payload: {
            action: params.action,
            sourceSessionId,
            sourceRunId,
            toolCallId,
          },
        },
        // 用户已经通过独立消息确认后，CONFIRM 即进入不可取消的发布提交点。
        // 这里必须等待主进程的真实结果，避免界面显示“已取消”但文件仍已发布。
        params.action === 'CONFIRM' ? undefined : signal,
      )
      if (!outcome.ok) {
        return {
          content: [{ type: 'text', text: outcome.error.message }],
          details: {
            kind: 'XIAOGUI_WORK_DOCX_FAILED' as const,
            ...outcome.error,
          },
          isError: true,
        }
      }
      if (!outcome.value.kind.startsWith('XIAOGUI_WORK_DOCX_')) {
        const message = '主进程返回了无法识别的文档结果，请稍后重试'
        return {
          content: [{ type: 'text', text: message }],
          details: {
            kind: 'XIAOGUI_WORK_DOCX_FAILED' as const,
            code: 'HOST_TOOL_FAILED' as const,
            message,
          },
          isError: true,
        }
      }

      const value = outcome.value as XiaoguiWorkDocxResultV1
      return {
        content: [{ type: 'text', text: successText(value) }],
        details: value,
      }
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
  return { ...result, extensions: [...result.extensions, extension] }
}
