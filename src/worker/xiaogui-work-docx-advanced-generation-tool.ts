import { createSyntheticSourceInfo, defineTool, type Extension, type LoadExtensionsResult } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1 } from '@shared/xiaogui-prompt-capabilities'
import { XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_METHOD_V1, type XiaoguiWorkDocxAdvancedGenerationResultV1, type WorkerHostToolErrorCodeV1 } from '@shared/worker-host-tools'
import { requestWorkerHostTool } from './worker-host-tool-channel.js'

const TOOL_PROMPT = XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1.xiaogui_work_docx_advanced_generation
export const XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_TOOL_NAME = TOOL_PROMPT.name
const ValueSchema = Type.Union([Type.String({ maxLength: 20_000 }), Type.Number(), Type.Boolean()])
const DataSchema = Type.Object({
  dataVersion: Type.Literal(1),
  variables: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), status: Type.Union([Type.Literal('RESOLVED'), Type.Literal('UNRESOLVED')]), value: Type.Optional(ValueSchema) }, { additionalProperties: false }), { maxItems: 200 }),
  repeatBlocks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), status: Type.Union([Type.Literal('RESOLVED'), Type.Literal('UNRESOLVED')]), records: Type.Optional(Type.Array(Type.Object({ slots: Type.Array(Type.Object({ slotId: Type.String({ minLength: 1, maxLength: 40 }), value: ValueSchema }, { additionalProperties: false }), { maxItems: 50 }) }, { additionalProperties: false }), { maxItems: 500 })) }, { additionalProperties: false }), { maxItems: 50 }),
  conditionalBlocks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), status: Type.Union([Type.Literal('RESOLVED'), Type.Literal('UNRESOLVED')]), value: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), { maxItems: 50 }),
}, { additionalProperties: false })
// 顶层固定为 object；data 只在 PREPARE 使用，主进程负责动作级严格校验。
const ActionSchema = Type.Object({
  action: Type.Union([
    Type.Literal('START'), Type.Literal('PREPARE'), Type.Literal('CONFIRM'), Type.Literal('RESUME'),
    Type.Literal('CANCEL'), Type.Literal('OPEN'), Type.Literal('REVEAL'),
  ]),
  data: Type.Optional(DataSchema),
}, { additionalProperties: false })

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
    ...TOOL_PROMPT,
    parameters: ActionSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const sourceSessionId = options.getSourceSessionId(); const sourceRunId = options.getSourceRunId()
      if (!sourceSessionId || !sourceRunId) { const details: SafeDetails = { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_FAILED', code: 'SESSION_NOT_READY', message: '当前用户指令尚未建立完成，请重新发送后再试' }; return { content: [{ type: 'text', text: publicText(details) }], details, isError: true } }
      const outcome = await requestWorkerHostTool({ method: XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_METHOD_V1, payload: { ...params, sourceSessionId, sourceRunId, toolCallId } as never }, signal)
      if (!outcome.ok) { const details: SafeDetails = { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_FAILED', code: outcome.error.code, message: outcome.error.message }; return { content: [{ type: 'text', text: publicText(details) }], details, isError: true } }
      if (!outcome.value.kind.startsWith('XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_')) { const details: SafeDetails = { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_FAILED', code: 'HOST_TOOL_FAILED', message: '高级 Word 生成返回了不支持的结果' }; return { content: [{ type: 'text', text: publicText(details) }], details, isError: true } }
      const details = outcome.value as XiaoguiWorkDocxAdvancedGenerationResultV1
      return { content: [{ type: 'text', text: publicText(details) }], details }
    },
  })
  const extension: Extension = { path: sourceInfo.path, resolvedPath: sourceInfo.path, hidden: true, sourceInfo, handlers: new Map(), tools: new Map([[definition.name, { definition, sourceInfo }]]), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() }
  return { ...loaded, extensions: [...loaded.extensions, extension] }
}
