import {
  createSyntheticSourceInfo,
  defineTool,
  type Extension,
  type LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import {
  XIAOGUI_WORK_REPORT_DOCX_METHOD_V1,
  type XiaoguiWorkReportDocxResultV1,
  type WorkerHostToolErrorCodeV1,
} from '@shared/worker-host-tools'

import { requestWorkerHostTool } from './worker-host-tool-channel.js'

export const XIAOGUI_WORK_REPORT_DOCX_TOOL_NAME = 'xiaogui_work_report_docx'

const DraftSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 120 }),
    sections: Type.Array(
      Type.Object(
        {
          heading: Type.String({ minLength: 1, maxLength: 120 }),
          paragraphs: Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), {
            maxItems: 20,
          }),
          bullets: Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), {
            maxItems: 30,
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 20 },
    ),
  },
  { additionalProperties: false },
)

// 顶层保持 OpenAI 兼容 object；动作级严格约束由主进程 Zod 边界执行。
const ActionSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal('PREPARE'),
      Type.Literal('CONFIRM'),
      Type.Literal('CANCEL'),
      Type.Literal('OPEN'),
      Type.Literal('REVEAL'),
    ]),
    draft: Type.Optional(DraftSchema),
  },
  { additionalProperties: false },
)

export interface XiaoguiWorkReportDocxToolOptionsV1 {
  getSourceSessionId: () => string | undefined
  getSourceRunId: () => string | undefined
}

type SafeDetails =
  | XiaoguiWorkReportDocxResultV1
  | {
      kind: 'XIAOGUI_WORK_REPORT_DOCX_FAILED'
      code: WorkerHostToolErrorCodeV1
      message: string
    }

function previewText(
  plan: Extract<
    XiaoguiWorkReportDocxResultV1,
    { kind: 'XIAOGUI_WORK_REPORT_DOCX_PREPARED' }
  >['plan'],
): string {
  const lines = [`标题：${plan.preview.title}`]
  plan.preview.sections.forEach((section, index) => {
    lines.push('', `${index + 1}. ${section.heading}`)
    lines.push(...section.paragraphs)
    lines.push(...section.bullets.map((item) => `- ${item}`))
  })
  return lines.join('\n')
}

function publicText(details: SafeDetails): string {
  switch (details.kind) {
    case 'XIAOGUI_WORK_REPORT_DOCX_PREPARED':
      return `已生成并打开标准 Word 预览：${details.plan.sectionCount} 个章节、${details.plan.paragraphCount} 段正文、${details.plan.bulletCount} 条项目符号。\n\n${previewText(details.plan)}\n\n最终文件尚未写入。请检查后在下一条消息中明确确认是否生成。`
    case 'XIAOGUI_WORK_REPORT_DOCX_TARGET_SELECTION_CANCELLED':
      return '已取消选择保存位置，没有保留预览或写入最终文件。'
    case 'XIAOGUI_WORK_REPORT_DOCX_PUBLISHED':
      return `标准 Word 报告已另存完成：${details.receipt.sectionCount} 个章节、${details.receipt.paragraphCount} 段正文、${details.receipt.bulletCount} 条项目符号。`
    case 'XIAOGUI_WORK_REPORT_DOCX_CANCELLED':
      return '已取消标准报告生成并清理受控预览，没有写入最终文件。'
    case 'XIAOGUI_WORK_REPORT_DOCX_ACCESSED':
      return details.action === 'OPEN'
        ? '已打开标准 Word 报告。'
        : '已在文件夹中定位标准 Word 报告。'
    case 'XIAOGUI_WORK_REPORT_DOCX_FAILED':
      return details.message
  }
}

export function addXiaoguiWorkReportDocxTool(
  loaded: LoadExtensionsResult,
  options: XiaoguiWorkReportDocxToolOptionsV1,
): LoadExtensionsResult {
  const sourceInfo = createSyntheticSourceInfo('<builtin:xiaogui-work-report-docx>', {
    source: 'xiaogui-desktop',
    scope: 'temporary',
    origin: 'top-level',
  })
  const definition = defineTool<typeof ActionSchema, SafeDetails>({
    name: XIAOGUI_WORK_REPORT_DOCX_TOOL_NAME,
    label: '生成标准 Word 报告',
    description:
      '把当前 WORK 对话中已经整理好的纯文本草稿生成标准 Word 预览，并在用户下一条消息确认后另存为全新 DOCX。用户明确要求使用自己的模板时不要调用。',
    promptSnippet: '自然语言提交报告草稿、预览、跨轮确认另存、取消或打开',
    promptGuidelines: [
      '只有用户没有指定模板、且明确要求把当前已整理草稿做成 Word 时才调用 PREPARE。',
      'PREPARE 的 draft 只填写当前对话中已经形成的标题、章节、段落和项目符号；不要补写未经用户确认的事实。',
      'PREPARE 打开标准 Word 预览后必须结束本轮；只有用户下一条消息明确确认才调用 CONFIRM。',
      'CONFIRM、CANCEL、OPEN、REVEAL 不得携带 draft 或任何路径。',
      '只有最新一条用户消息明确要求取消、打开文档或在文件夹中显示时，才调用 CANCEL、OPEN 或 REVEAL。',
      '用户明确说使用自己的模板时，改用模板 Word 工具，不要调用标准报告工具。',
      '不要展示或索要预览、成品、数据库或临时目录的绝对路径，也不要在结果中重复草稿全文。',
      '成品只能另存为不存在的新 DOCX；不得声称覆盖或修改了已有文件。',
    ],
    parameters: ActionSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const sourceSessionId = options.getSourceSessionId()
      const sourceRunId = options.getSourceRunId()
      if (!sourceSessionId || !sourceRunId) {
        const details: SafeDetails = {
          kind: 'XIAOGUI_WORK_REPORT_DOCX_FAILED',
          code: 'SESSION_NOT_READY',
          message: '当前用户指令尚未建立完成，请重新发送后再试',
        }
        return {
          content: [{ type: 'text', text: publicText(details) }],
          details,
          isError: true,
        }
      }
      const outcome = await requestWorkerHostTool(
        {
          method: XIAOGUI_WORK_REPORT_DOCX_METHOD_V1,
          payload: { ...params, sourceSessionId, sourceRunId, toolCallId } as never,
        },
        // 确认已越过独立的人类门；必须等待主进程真实另存结果。
        params.action === 'CONFIRM' ? undefined : signal,
      )
      if (!outcome.ok) {
        const details: SafeDetails = {
          kind: 'XIAOGUI_WORK_REPORT_DOCX_FAILED',
          code: outcome.error.code,
          message: outcome.error.message,
        }
        return {
          content: [{ type: 'text', text: publicText(details) }],
          details,
          isError: true,
        }
      }
      if (!outcome.value.kind.startsWith('XIAOGUI_WORK_REPORT_DOCX_')) {
        const details: SafeDetails = {
          kind: 'XIAOGUI_WORK_REPORT_DOCX_FAILED',
          code: 'HOST_TOOL_FAILED',
          message: '标准报告生成返回了不支持的结果',
        }
        return {
          content: [{ type: 'text', text: publicText(details) }],
          details,
          isError: true,
        }
      }
      const details = outcome.value as XiaoguiWorkReportDocxResultV1
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
