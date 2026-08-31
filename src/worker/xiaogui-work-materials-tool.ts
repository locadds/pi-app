import {
  createSyntheticSourceInfo,
  defineTool,
  type Extension,
  type LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1 } from '@shared/xiaogui-prompt-capabilities'
import {
  XIAOGUI_WORK_MATERIALS_METHOD_V1,
  type WorkerHostToolErrorCodeV1,
  type XiaoguiWorkMaterialsResultV1,
} from '@shared/worker-host-tools'
import type { WorkMaterialsSnapshotV1 } from '@shared/xiaogui-work-materials'

import { requestWorkerHostTool } from './worker-host-tool-channel.js'

const TOOL_PROMPT = XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1.xiaogui_work_read_materials
export const XIAOGUI_READ_MATERIALS_TOOL_NAME = TOOL_PROMPT.name

const ReadMaterialsParamsSchema = Type.Object(
  {
    paths: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          maxLength: 32_768,
          description: '要读取的文件或目录；绝对路径和相对路径均可。',
        }),
        {
          minItems: 1,
          maxItems: 32,
          description: '省略时读取当前工作目录中的全部资料。',
        },
      ),
    ),
  },
  { additionalProperties: false },
)

export interface XiaoguiWorkMaterialsToolOptionsV1 {
  getSourceSessionId: () => string | undefined
  getSourceRunId: () => string | undefined
}

type XiaoguiWorkMaterialsToolDetailsV1 =
  | XiaoguiWorkMaterialsResultV1
  | {
      kind: 'XIAOGUI_WORK_MATERIALS_FAILED'
      code: WorkerHostToolErrorCodeV1
      message: string
      traceId?: string
    }

function snapshotText(snapshot: WorkMaterialsSnapshotV1): string {
  const lines = [
    `资料读取完成：共 ${snapshot.totalFileCount} 个文件；扫描了 ${snapshot.totalDirectoryCount} 个目录节点（包含用户选择的根目录）；已提取正文 ${snapshot.extractedFileCount} 个，仅元数据 ${snapshot.metadataOnlyFileCount} 个，读取失败 ${snapshot.failedFileCount} 个。`,
  ]
  if (snapshot.warnings.length > 0) lines.push(`整体提醒：${snapshot.warnings.join('、')}`)

  for (const file of snapshot.files) {
    lines.push('', `=== ${file.absolutePath} ===`)
    lines.push(`状态：${file.status}；类型：${file.extension || '无扩展名'}；大小：${file.byteSize} 字节；读取器：${file.extractor}`)
    if (file.warnings.length > 0) lines.push(`提醒：${file.warnings.join('、')}`)
    if (file.content) lines.push('', file.content)
  }
  return lines.join('\n')
}

export function addXiaoguiWorkMaterialsToolV1(
  result: LoadExtensionsResult,
  options: XiaoguiWorkMaterialsToolOptionsV1,
): LoadExtensionsResult {
  const sourceInfo = createSyntheticSourceInfo('<builtin:xiaogui-work-materials>', {
    source: 'xiaogui-desktop',
    scope: 'temporary',
    origin: 'top-level',
  })
  const definition = defineTool<typeof ReadMaterialsParamsSchema, XiaoguiWorkMaterialsToolDetailsV1>({
    ...TOOL_PROMPT,
    parameters: ReadMaterialsParamsSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const sourceSessionId = options.getSourceSessionId()
      const sourceRunId = options.getSourceRunId()
      if (!sourceSessionId || !sourceRunId) {
        const message = '当前用户指令尚未建立完成，请重新发送后再试'
        return {
          content: [{ type: 'text', text: message }],
          details: {
            kind: 'XIAOGUI_WORK_MATERIALS_FAILED' as const,
            code: 'SESSION_NOT_READY' as const,
            message,
          },
          isError: true,
        }
      }

      const outcome = await requestWorkerHostTool(
        {
          method: XIAOGUI_WORK_MATERIALS_METHOD_V1,
          payload: {
            paths: params.paths,
            sourceSessionId,
            sourceRunId,
            toolCallId,
          },
        },
        signal,
      )
      if (!outcome.ok) {
        return {
          content: [{ type: 'text', text: outcome.error.message }],
          details: { kind: 'XIAOGUI_WORK_MATERIALS_FAILED' as const, ...outcome.error },
          isError: true,
        }
      }
      if (outcome.value.kind !== 'XIAOGUI_WORK_MATERIALS_READY') {
        const message = '主进程返回了无法识别的资料读取结果，请稍后重试'
        return {
          content: [{ type: 'text', text: message }],
          details: {
            kind: 'XIAOGUI_WORK_MATERIALS_FAILED' as const,
            code: 'HOST_TOOL_FAILED' as const,
            message,
          },
          isError: true,
        }
      }
      const value: XiaoguiWorkMaterialsResultV1 = outcome.value
      return {
        content: [{ type: 'text', text: snapshotText(value.snapshot) }],
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
