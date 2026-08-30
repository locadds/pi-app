import {
  createSyntheticSourceInfo,
  defineTool,
  type Extension,
  type LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1 } from '@shared/xiaogui-prompt-capabilities'
import {
  XIAOGUI_WORK_DOCUMENT_SNAPSHOT_METHOD_V1,
  type WorkerHostToolErrorCodeV1,
  type XiaoguiWorkDocumentSnapshotResultV1,
} from '@shared/worker-host-tools'
import type { DocumentSnapshotV1 } from '@shared/xiaogui-document-snapshot'

import { requestWorkerHostTool } from './worker-host-tool-channel.js'

const TOOL_PROMPT = XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1.xiaogui_read_pdf
export const XIAOGUI_READ_PDF_TOOL_NAME = TOOL_PROMPT.name

const ReadPdfParamsSchema = Type.Object(
  {
    startPage: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: '从第几页开始读取（1 起始）；省略时从第 1 页开始。',
      }),
    ),
    endPage: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: '读到第几页为止（含端点）；省略时最多读取 20 页。',
      }),
    ),
  },
  { additionalProperties: false },
)

export interface XiaoguiWorkDocumentSnapshotToolOptions {
  getSourceSessionId: () => string | undefined
  getSourceRunId: () => string | undefined
}

type XiaoguiWorkDocumentSnapshotToolDetails =
  | XiaoguiWorkDocumentSnapshotResultV1
  | {
      kind: 'XIAOGUI_WORK_DOCUMENT_FAILED'
      code: WorkerHostToolErrorCodeV1
      message: string
      traceId?: string
    }

function successText(snapshot: DocumentSnapshotV1): string {
  const lines: string[] = []
  const firstPage = snapshot.pages[0]?.pageNumber
  const lastPage = snapshot.pages[snapshot.pages.length - 1]?.pageNumber
  if (snapshot.pages.length === 0) {
    lines.push(`已读取“${snapshot.sourceDisplayName}”：共 ${snapshot.pageCount} 页，但本次没有抽取出任何页面。`)
  } else {
    lines.push(
      `已读取“${snapshot.sourceDisplayName}”：共 ${snapshot.pageCount} 页，本次读取第 ${firstPage}–${lastPage} 页。`,
    )
  }
  for (const page of snapshot.pages) {
    lines.push('', `—— 第 ${page.pageNumber} 页 ——`, '')
    lines.push(page.text)
  }
  if (snapshot.warnings.includes('SCANNED_OR_EMPTY')) {
    lines.push('', '（未抽取到正文文字：该文档可能是扫描件或空白页。）')
  }
  if (snapshot.warnings.includes('TRUNCATED')) {
    lines.push('', '（快照已截断：未包含全部页面或正文达到字符上限。）')
  }
  return lines.join('\n')
}

export function addXiaoguiWorkDocumentSnapshotTool(
  result: LoadExtensionsResult,
  options: XiaoguiWorkDocumentSnapshotToolOptions,
): LoadExtensionsResult {
  const sourceInfo = createSyntheticSourceInfo('<builtin:xiaogui-work-document-snapshot>', {
    source: 'xiaogui-desktop',
    scope: 'temporary',
    origin: 'top-level',
  })
  const definition = defineTool<typeof ReadPdfParamsSchema, XiaoguiWorkDocumentSnapshotToolDetails>({
    ...TOOL_PROMPT,
    parameters: ReadPdfParamsSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const sourceSessionId = options.getSourceSessionId()
      const sourceRunId = options.getSourceRunId()
      if (!sourceSessionId || !sourceRunId) {
        const message = '当前用户指令尚未建立完成，请重新发送后再试'
        return {
          content: [{ type: 'text', text: message }],
          details: {
            kind: 'XIAOGUI_WORK_DOCUMENT_FAILED' as const,
            code: 'SESSION_NOT_READY' as const,
            message,
          },
          isError: true,
        }
      }

      const outcome = await requestWorkerHostTool(
        {
          method: XIAOGUI_WORK_DOCUMENT_SNAPSHOT_METHOD_V1,
          payload: {
            action: 'READ_PDF',
            startPage: params.startPage,
            endPage: params.endPage,
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
          details: {
            kind: 'XIAOGUI_WORK_DOCUMENT_FAILED' as const,
            ...outcome.error,
          },
          isError: true,
        }
      }
      if (
        outcome.value.kind !== 'XIAOGUI_WORK_DOCUMENT_SELECTION_CANCELLED' &&
        outcome.value.kind !== 'XIAOGUI_WORK_DOCUMENT_SNAPSHOT_READY'
      ) {
        const message = '主进程返回了无法识别的读取结果，请稍后重试'
        return {
          content: [{ type: 'text', text: message }],
          details: {
            kind: 'XIAOGUI_WORK_DOCUMENT_FAILED' as const,
            code: 'HOST_TOOL_FAILED' as const,
            message,
          },
          isError: true,
        }
      }

      const value: XiaoguiWorkDocumentSnapshotResultV1 = outcome.value
      if (value.kind === 'XIAOGUI_WORK_DOCUMENT_SELECTION_CANCELLED') {
        return {
          content: [{ type: 'text', text: '已取消文件选择，没有读取任何文件。' }],
          details: value,
        }
      }
      return {
        content: [{ type: 'text', text: successText(value.snapshot) }],
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
