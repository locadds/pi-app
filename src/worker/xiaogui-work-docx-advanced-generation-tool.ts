import { createSyntheticSourceInfo, defineTool, type Extension, type LoadExtensionsResult } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_METHOD_V1, type XiaoguiWorkDocxAdvancedGenerationResultV1, type WorkerHostToolErrorCodeV1 } from '@shared/worker-host-tools'
import { requestWorkerHostTool } from './worker-host-tool-channel.js'

export const XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_TOOL_NAME = 'xiaogui_work_docx_advanced_generation'
const ValueSchema = Type.Union([Type.String({ maxLength: 20_000 }), Type.Number(), Type.Boolean()])
const DataSchema = Type.Object({
  dataVersion: Type.Literal(1),
  variables: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), status: Type.Union([Type.Literal('RESOLVED'), Type.Literal('UNRESOLVED')]), value: Type.Optional(ValueSchema) }, { additionalProperties: false }), { maxItems: 200 }),
  repeatBlocks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), status: Type.Union([Type.Literal('RESOLVED'), Type.Literal('UNRESOLVED')]), records: Type.Optional(Type.Array(Type.Object({ slots: Type.Array(Type.Object({ slotId: Type.String({ minLength: 1, maxLength: 40 }), value: ValueSchema }, { additionalProperties: false }), { maxItems: 50 }) }, { additionalProperties: false }), { maxItems: 500 })) }, { additionalProperties: false }), { maxItems: 50 }),
  conditionalBlocks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), status: Type.Union([Type.Literal('RESOLVED'), Type.Literal('UNRESOLVED')]), value: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), { maxItems: 50 }),
}, { additionalProperties: false })
const ActionSchema = Type.Union([
  Type.Object({ action: Type.Literal('START') }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('PREPARE'), data: DataSchema }, { additionalProperties: false }),
  ...(['CONFIRM', 'RESUME', 'CANCEL', 'OPEN', 'REVEAL'] as const).map((action) => Type.Object({ action: Type.Literal(action) }, { additionalProperties: false })),
])

export interface XiaoguiWorkDocxAdvancedGenerationToolOptionsV1 { getSourceSessionId: () => string | undefined; getSourceRunId: () => string | undefined }
type SafeDetails = XiaoguiWorkDocxAdvancedGenerationResultV1 | { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_FAILED'; code: WorkerHostToolErrorCodeV1; message: string }

function publicText(details: SafeDetails): string {
  switch (details.kind) {
    case 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_SELECTION_CANCELLED': return '已取消选择正式模板。'
    case 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_SCHEMA_READY': return `已只读识别模板：普通字段 ${details.schema.variables.length} 项、重复块 ${details.schema.repeatBlocks.length} 项、条件块 ${details.schema.conditionalBlocks.length} 项。请根据当前对话补齐全部字段和槽位；无法确定的项目必须明确标为未解决。`
    case 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_PREPARED': return `已生成并打开只读成品预览：重复记录 ${details.plan.repeatRecordCount} 条、保留条件块 ${details.plan.retainedConditionalCount} 项。原模板未修改。请检查后在下一条消息中明确确认是否另存成品。`
    case 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_RESUMED': return details.receipt ? '已恢复已发布的 Word 成品记录。' : details.plan ? '已重新核对模板并打开成品预览。原模板未修改。' : '已恢复模板结构摘要，可以继续补齐成品数据。'
    case 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_TARGET_SELECTION_CANCELLED': return '已取消选择成品保存位置；预览仍保留，可稍后再次确认。'
    case 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_PUBLISHED': return `Word 成品已另存完成：重复记录 ${details.receipt.repeatRecordCount} 条、保留条件块 ${details.receipt.retainedConditionalCount} 项。原模板未修改。`
    case 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_CANCELLED': return '已取消高级 Word 生成并清理受控预览；原模板未修改。'
    case 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_ACCESSED': return details.action === 'OPEN' ? '已打开 Word 成品。' : '已在文件夹中定位 Word 成品。'
    case 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_FAILED': return details.message
  }
}

export function addXiaoguiWorkDocxAdvancedGenerationTool(loaded: LoadExtensionsResult, options: XiaoguiWorkDocxAdvancedGenerationToolOptionsV1): LoadExtensionsResult {
  const sourceInfo = createSyntheticSourceInfo('<builtin:xiaogui-work-docx-advanced-generation>', { source: 'xiaogui-desktop', scope: 'temporary', origin: 'top-level' })
  const definition = defineTool<typeof ActionSchema, SafeDetails>({
    name: XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_TOOL_NAME,
    label: '按小规模板生成 Word 成品',
    description: '从包含小规重复块或条件块的正式模板生成只读预览，并在下一轮确认后另存全新 Word 成品。',
    promptSnippet: '自然语言选择正式模板、补齐普通字段和结构槽位、预览、确认另存、恢复或取消',
    promptGuidelines: [
      '用户明确要求按正式模板生成含重复块或条件块的 Word 成品时调用 START；不要要求用户手写工具参数。',
      'START 返回结构摘要后，从当前对话整理 PREPARE 数据；每个名称和槽位必须与摘要完全一致。',
      '无法确定的字段、重复块或条件决定必须标为 UNRESOLVED，并向用户追问；不要猜测旧项目内容。',
      'PREPARE 打开预览后必须结束本轮；只有用户下一条消息明确确认才调用 CONFIRM。',
      '不要展示或索要源模板、预览、成品、数据库或临时目录的绝对路径。',
      '不得声称覆盖或修改了原模板；成品只能另存为不存在的新 DOCX。',
    ],
    parameters: ActionSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const sourceSessionId = options.getSourceSessionId(); const sourceRunId = options.getSourceRunId()
      if (!sourceSessionId || !sourceRunId) { const details: SafeDetails = { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_FAILED', code: 'SESSION_NOT_READY', message: '当前用户指令尚未建立完成，请重新发送后再试' }; return { content: [{ type: 'text', text: publicText(details) }], details, isError: true } }
      const outcome = await requestWorkerHostTool({ method: XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_METHOD_V1, payload: { ...params, sourceSessionId, sourceRunId, toolCallId } }, signal)
      if (!outcome.ok) { const details: SafeDetails = { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_FAILED', code: outcome.error.code, message: outcome.error.message }; return { content: [{ type: 'text', text: publicText(details) }], details, isError: true } }
      if (!outcome.value.kind.startsWith('XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_')) { const details: SafeDetails = { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_FAILED', code: 'HOST_TOOL_FAILED', message: '高级 Word 生成返回了不支持的结果' }; return { content: [{ type: 'text', text: publicText(details) }], details, isError: true } }
      const details = outcome.value as XiaoguiWorkDocxAdvancedGenerationResultV1
      return { content: [{ type: 'text', text: publicText(details) }], details }
    },
  })
  const extension: Extension = { path: sourceInfo.path, resolvedPath: sourceInfo.path, hidden: true, sourceInfo, handlers: new Map(), tools: new Map([[definition.name, { definition, sourceInfo }]]), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() }
  return { ...loaded, extensions: [...loaded.extensions, extension] }
}
