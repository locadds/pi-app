import {
  createSyntheticSourceInfo,
  defineTool,
  type Extension,
  type LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import {
  XIAOGUI_WORK_DOCX_TEMPLATE_DATA_METHOD_V1,
  type XiaoguiWorkDocxTemplateDataResultV1,
  type WorkerHostToolErrorCodeV1,
} from '@shared/worker-host-tools'

import { requestWorkerHostTool } from './worker-host-tool-channel.js'

export const XIAOGUI_WORK_DOCX_TOOL_NAME = 'xiaogui_work_docx'

const SourceSummarySchema = Type.Optional(
  Type.String({ maxLength: 500, description: '只写字段来源的简短说明，不要放路径或内部编号。' }),
)
const FieldSchema = Type.Object(
  {
    fieldId: Type.String({
      minLength: 1,
      maxLength: 160,
      description: '必须原样使用 SELECT_TEMPLATE 返回的稳定字段编号，不得自行生成。',
    }),
    name: Type.String({ minLength: 1, maxLength: 64 }),
    status: Type.Union([Type.Literal('READY'), Type.Literal('UNRESOLVED')], {
      description: 'READY 必须同时提供 value；UNRESOLVED 不提供 value。',
    }),
    value: Type.Optional(
      Type.Union([Type.String({ maxLength: 20_000 }), Type.Number(), Type.Boolean()]),
    ),
    sourceSummary: SourceSummarySchema,
  },
  {
    additionalProperties: false,
    description: '字段的动作约束由主进程再次严格校验。',
  },
)

// 模型工具的顶层参数必须固定为 JSON Schema object。动作之间的严格条件
// 仍由主进程版本化契约校验，避免不同模型供应商拒绝顶层 anyOf。
const WorkDocxTemplateDataActionSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal('SELECT_TEMPLATE'),
      Type.Literal('PREPARE'),
      Type.Literal('CONFIRM'),
      Type.Literal('CANCEL'),
      Type.Literal('OPEN'),
      Type.Literal('REVEAL'),
    ]),
    fields: Type.Optional(
      Type.Array(FieldSchema, {
        maxItems: 200,
        description: '仅 PREPARE 使用；按稳定 fieldId 提交已知字段，缺失必填字段会由小规继续追问。',
      }),
    ),
    libraryTemplateName: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 120,
        description: '仅 SELECT_TEMPLATE 使用；来自用户明确点选或说出的模板名称。',
      }),
    ),
    libraryVersionNumber: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: '仅 SELECT_TEMPLATE 使用；未指定时使用该模板的最新版。',
      }),
    ),
  },
  { additionalProperties: false },
)

export interface XiaoguiWorkDocxTemplateDataToolOptions {
  getSourceSessionId: () => string | undefined
  getSourceRunId: () => string | undefined
}

type XiaoguiWorkDocxTemplateDataToolDetails =
  | XiaoguiWorkDocxTemplateDataResultV1
  | {
      kind: 'XIAOGUI_WORK_DOCX_FAILED'
      code: WorkerHostToolErrorCodeV1
      message: string
      traceId?: string
    }

function profileText(result: {
  profile: {
    bodyPartCount: 1
    sectionCount: number
    headerPartCount: number
    footerPartCount: number
    inlineDrawingCount: number
    floatingDrawingCount: number
    mediaCount: number
    fieldCount: number
  }
}): string {
  const profile = result.profile
  return `正文 ${profile.bodyPartCount} 个，分节 ${profile.sectionCount} 个，页眉 ${profile.headerPartCount} 个，页脚 ${profile.footerPartCount} 个，行内图形 ${profile.inlineDrawingCount} 个，浮动图形 ${profile.floatingDrawingCount} 个，媒体 ${profile.mediaCount} 个，域 ${profile.fieldCount} 个`
}

function successText(result: XiaoguiWorkDocxTemplateDataResultV1): string {
  switch (result.kind) {
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_LIBRARY_CHOICES':
      return `模板库中有 ${result.templates.length} 个可用模板。`
    case 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED':
      return '已取消选择模板，没有生成或写入文档。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_PREPARATION_REQUIRED':
      return `“${result.templateDisplayName}”这是一份成品文档，需要先整理成模板。已识别的结构摘要：${profileText(result)}。没有选择保存位置，也没有创建待发布文档。`
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_SELECTED':
      return `已读取模板“${result.templateDisplayName}”。字段清单：${result.fields.map((field) => `${field.name}${field.required ? '' : '（选填）'}`).join('、')}。结构摘要：${profileText(result)}。请按返回的稳定字段编号整理当前对话，只追问缺失的必填字段。`
    case 'XIAOGUI_WORK_DOCX_INPUT_REQUIRED':
      return `还需要用户补充这些字段：${result.unresolvedFields.join('、')}。尚未选择保存位置，也没有创建待发布文档。`
    case 'XIAOGUI_WORK_DOCX_TARGET_SELECTION_CANCELLED':
      return '已取消选择保存位置，模板字段仍保留；需要时可以再次准备。'
    case 'XIAOGUI_WORK_DOCX_PREPARED':
      return `已准备按模板“${result.templateDisplayName}”生成文档，共 ${result.fields.length} 个字段。尚未生成文件，请向用户复述后等待下一条消息明确确认或取消。`
    case 'XIAOGUI_WORK_DOCX_CANCELLED':
      return '已取消本次模板文档生成，没有写入目标文件。'
    case 'XIAOGUI_WORK_DOCX_PUBLISHED':
      return '文档已经生成并通过结构校验，原始模板未被修改。你可以让我打开文档，或在文件夹中显示。'
    case 'XIAOGUI_WORK_DOCX_ACCESSED':
      return result.action === 'OPEN' ? '已请求系统打开生成的文档。' : '已在文件夹中显示生成的文档。'
  }
}

export function addXiaoguiWorkDocxTemplateDataTool(
  result: LoadExtensionsResult,
  options: XiaoguiWorkDocxTemplateDataToolOptions,
): LoadExtensionsResult {
  const sourceInfo = createSyntheticSourceInfo('<builtin:xiaogui-work-docx-template-data>', {
    source: 'xiaogui-desktop',
    scope: 'temporary',
    origin: 'top-level',
  })
  const definition = defineTool<
    typeof WorkDocxTemplateDataActionSchema,
    XiaoguiWorkDocxTemplateDataToolDetails
  >({
    name: XIAOGUI_WORK_DOCX_TOOL_NAME,
    label: '按模板生成文档',
    description:
      '在日常工作会话中选择已经标记字段的 Word 模板，从当前对话整理字段，经用户单独确认后生成新的 Word 副本。普通成品文档会提示先整理成模板。',
    promptSnippet: '用自然语言选择模板、整理字段、准备、确认、取消或打开 Word；生成前必须等待用户下一条确认消息',
    promptGuidelines: [
      '用户明确要求按 Word 模板创作时先调用 SELECT_TEMPLATE；不要让用户输入路径，也不要索要 JSON。',
      '用户明确说出或从模板库点选了模板名称/版本时，把名称写入 libraryTemplateName、版本号写入 libraryVersionNumber；不要编造名称或版本。',
      'SELECT_TEMPLATE 返回字段清单后，必须原样使用每项 fieldId；优先从当前对话提取字段，不能确定的必填字段用 UNRESOLVED，不能猜测。',
      '调用 PREPARE 时按 fieldId 提交已知字段。READY 只允许字符串、数字或布尔值；选填字段可省略，系统不得因此追问用户。',
      'PREPARE 返回待确认摘要后必须停止调用工具，等待用户下一条消息明确确认。不得同一轮调用 CONFIRM。',
      '只有最新一条用户消息明确要求取消、打开文档或在文件夹中显示时，才调用 CANCEL、OPEN 或 REVEAL。',
      '不要向用户展示文件路径、会话地址、选择编号、操作编号、内部错误代码或摘要编号。',
    ],
    parameters: WorkDocxTemplateDataActionSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal, _onUpdate, context) {
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

      let templateVersionId: string | undefined
      if (params.action === 'SELECT_TEMPLATE') {
        const listed = await requestWorkerHostTool(
          {
            method: XIAOGUI_WORK_DOCX_TEMPLATE_DATA_METHOD_V1,
            payload: {
              action: 'LIST_LIBRARY_TEMPLATES',
              sourceSessionId,
              sourceRunId,
              toolCallId,
            },
          },
          signal,
        )
        if (listed.ok && listed.value.kind === 'XIAOGUI_WORK_DOCX_TEMPLATE_LIBRARY_CHOICES') {
          const requestedName = params.libraryTemplateName?.normalize('NFKC').trim()
          if (requestedName) {
            const exact = listed.value.templates.find(
              (template) => template.name.normalize('NFKC').trim() === requestedName,
            )
            const requestedVersion = params.libraryVersionNumber
              ? exact?.versions.find((version) => version.versionNumber === params.libraryVersionNumber)
              : exact?.latestVersion
            if (requestedVersion) templateVersionId = requestedVersion.versionId
          }
          const choices = new Map<string, string | null>()
          for (const template of listed.value.templates) {
            for (const version of template.versions) {
              const date = new Date(version.createdAt).toLocaleDateString('zh-CN')
              const label = `${template.name} · 第 ${version.versionNumber} 版${version.isLatest ? '（最新版）' : ''} · ${date}`
              choices.set(label, version.versionId)
            }
          }
          if (!templateVersionId && choices.size > 0) {
            const fileChoice = '从电脑选择文档模板…'
            choices.set(fileChoice, null)
            const selected = await context.ui.select(
              '选择模板库历史模板，或从电脑选择文件',
              [...choices.keys()],
              { signal },
            )
            if (!selected) {
              const details = { kind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED' as const }
              return { content: [{ type: 'text', text: successText(details) }], details }
            }
            templateVersionId = choices.get(selected) ?? undefined
          }
        }
      }

      const outcome = await requestWorkerHostTool(
        {
          method: XIAOGUI_WORK_DOCX_TEMPLATE_DATA_METHOD_V1,
          payload: {
            action: params.action,
            ...(params.fields ? { fields: params.fields } : {}),
            ...(templateVersionId ? { templateVersionId } : {}),
            sourceSessionId,
            sourceRunId,
            toolCallId,
          } as never,
        },
        params.action === 'CONFIRM' ? undefined : signal,
      )
      if (!outcome.ok) {
        return {
          content: [{ type: 'text', text: outcome.error.message }],
          details: { kind: 'XIAOGUI_WORK_DOCX_FAILED' as const, ...outcome.error },
          isError: true,
        }
      }
      if (!outcome.value.kind.startsWith('XIAOGUI_WORK_DOCX_')) {
        const message = '主进程返回了无法识别的模板文档结果，请稍后重试'
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

      const value = outcome.value as XiaoguiWorkDocxTemplateDataResultV1
      return { content: [{ type: 'text', text: successText(value) }], details: value }
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
