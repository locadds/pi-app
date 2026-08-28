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

import { getDesktopUIBridge } from './desktop-ui-bridge.js'
import { requestWorkerHostTool } from './worker-host-tool-channel.js'

export const XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_TOOL_NAME =
  'xiaogui_work_docx_template_materialize'

// 顶层固定为 object；reportId 只在 PREPARE 使用，主进程负责动作级严格校验。
const ActionSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal('PREPARE'),
      Type.Literal('CONFIRM'),
      Type.Literal('RESUME'),
      Type.Literal('CANCEL'),
      Type.Literal('OPEN'),
      Type.Literal('REVEAL'),
      Type.Literal('EXPORT'),
    ]),
    reportId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 160, description: '仅 PREPARE 使用。' }),
    ),
    templateName: Type.Optional(
      Type.String({ minLength: 1, maxLength: 120, description: '仅 CONFIRM 使用；本机模板库中的名称。' }),
    ),
    purpose: Type.Optional(
      Type.String({ maxLength: 500, description: '仅 CONFIRM 使用；模板用途说明。' }),
    ),
    tags: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 20, description: '仅 CONFIRM 使用。' }),
    ),
  },
  { additionalProperties: false },
)

export interface XiaoguiWorkDocxTemplateMaterializeToolOptionsV1 {
  getSourceSessionId: () => string | undefined
  getSourceRunId: () => string | undefined
}

type SafeDetails =
  | XiaoguiWorkDocxTemplateMaterializeResultV1
  | {
      kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_MODIFICATION_REQUESTED'
      instruction: string
    }
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
      return '已取消选择模板库或另存位置；当前记录仍保留，可稍后继续。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PUBLISHED':
      return `${details.receipt.library ? `正式模板“${details.receipt.library.templateName}”第 ${details.receipt.library.versionNumber} 版已保存到本机模板库` : '正式模板已另存完成'}：变量 ${details.receipt.variableNames.length} 项、重复块 ${details.receipt.repeatBlockNames.length} 项、条件块 ${details.receipt.conditionalBlockNames.length} 项、排除 ${details.receipt.excludedCandidateCount} 项。以后可在“按模板生成”中直接选择；原文档未修改。`
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_EXPORTED':
      return '已从本机模板库另存一份 DOCX；模板库原版本未改变。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_CANCELLED':
      return '已取消模板物化并清理受控预览；原 Word 未修改。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_ACCESSED':
      return details.action === 'OPEN' ? '已打开正式模板。' : '已在文件夹中定位正式模板。'
    case 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_MODIFICATION_REQUESTED':
      return `用户在修改后预览中提出了新的修改要求：${details.instruction}\n请返回文档复核记录，按这条要求更新后重新生成预览。`
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
    label: '生成正式文档模板',
    description: '把已人工确认的普通文档整理报告生成小规内置预览，并在用户点击确认后保存进本机模板库。',
    promptSnippet: '从已确认的模板整理报告生成预览、保存模板库、另存一份、恢复、取消或打开正式模板',
    promptGuidelines: [
      '只有用户已经完成普通文档整理报告的人工确认，并明确要求生成正式模板时，才调用 PREPARE。',
      'PREPARE 会打开小规内置整份预览；只有用户点击“生成正式模板”后，Worker 才携带私有确认令牌继续保存，模型不得自行构造该令牌。',
      '用户在内置预览填写“需要修改”时，收到修改要求后应调用模板整理工具 REOPEN/UPDATE，不得继续发布旧预览。',
      '如果用户在后续新消息明确表示已经看过预览并确认生成，仍可调用 CONFIRM，并可同时带模板名称、用途和标签。',
      '用户明确要求另存一份本机模板时才调用 EXPORT；模板会先存在本机模板库。',
      '用户取消保存位置后不要自动重试；等待用户下一条消息。',
      '不要展示或索要源文件、预览文件、正式模板、数据库或临时目录的绝对路径。',
      '重复块和条件块使用文档内容控件，当前简单字段生成器不会展开；必须如实告诉用户这个能力边界。',
      '不得声称覆盖或修改了原文档；正式模板只能保存为新的 DOCX。',
    ],
    parameters: ActionSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal, _onUpdate, context) {
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
      const callHost = (payload: Record<string, unknown>) => requestWorkerHostTool(
        {
          method: XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_METHOD_V1,
          payload: { ...payload, sourceSessionId, sourceRunId, toolCallId } as never,
        },
        signal,
      )
      let outcome = await callHost(params as unknown as Record<string, unknown>)
      if (!outcome.ok) {
        const details: SafeDetails = {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED',
          code: outcome.error.code,
          message: outcome.error.message,
        }
        return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
      }
      let result = outcome.value
      if (!result.kind.startsWith('XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_')) {
        const details: SafeDetails = {
          kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED',
          code: 'HOST_TOOL_FAILED',
          message: '模板物化返回了不支持的结果',
        }
        return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
      }
      if (
        result.kind === 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PREPARED' ||
        (result.kind === 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_RESUMED' && result.preview)
      ) {
        const bridge = getDesktopUIBridge(context.ui)
        if (!bridge) {
          const details: SafeDetails = {
            kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED',
            code: 'HOST_TOOL_UNAVAILABLE',
            message: '当前界面无法打开修改后模板预览，请稍后重试',
          }
          return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
        }
        const preview = result.preview
        const confirmationToken = result.previewConfirmationToken
        if (!preview || !confirmationToken) {
          const details: SafeDetails = {
            kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED',
            code: 'HOST_TOOL_FAILED',
            message: '修改后模板预览信息不完整，请重新生成预览',
          }
          return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
        }
        const previewResult = await bridge.requestTemplateMaterializePreview(
          toolCallId,
          preview,
          signal,
        )
        if (!['CANCEL', 'MODIFY', 'CONFIRM'].includes(previewResult.action)) {
          const details: SafeDetails = {
            kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED',
            code: 'HOST_TOOL_FAILED',
            message: '修改后模板预览返回了不支持的操作',
          }
          return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
        }
        if (previewResult.action === 'CANCEL') {
          outcome = await callHost({ action: 'CANCEL' })
        } else if (previewResult.previewSha256 !== preview.plan.previewSha256) {
          const details: SafeDetails = {
            kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED',
            code: 'HOST_TOOL_FAILED',
            message: '预览版本已经变化，请重新打开修改后模板预览',
          }
          return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
        } else if (previewResult.action === 'MODIFY') {
          const instruction = previewResult.instruction.trim().slice(0, 2000)
          if (!instruction) {
            const details: SafeDetails = {
              kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED',
              code: 'HOST_TOOL_FAILED',
              message: '请先输入需要修改的内容',
            }
            return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
          }
          const cancelled = await callHost({ action: 'CANCEL' })
          if (!cancelled.ok) {
            const details: SafeDetails = {
              kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED',
              code: cancelled.error.code,
              message: cancelled.error.message,
            }
            return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
          }
          const details: SafeDetails = {
            kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_MODIFICATION_REQUESTED',
            instruction,
          }
          return { content: [{ type: 'text', text: publicText(details) }], details }
        } else {
          outcome = await callHost({
            action: 'CONFIRM',
            previewConfirmationToken: confirmationToken,
            templateName: previewResult.templateName ?? preview.suggestedTemplateName,
            purpose: previewResult.purpose,
            tags: previewResult.tags,
          })
        }
        if (!outcome.ok) {
          const details: SafeDetails = {
            kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_FAILED',
            code: outcome.error.code,
            message: outcome.error.message,
          }
          return { content: [{ type: 'text', text: publicText(details) }], details, isError: true }
        }
        result = outcome.value
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
