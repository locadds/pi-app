import {
  createSyntheticSourceInfo,
  defineTool,
  type Extension,
  type LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1 } from '@shared/xiaogui-prompt-capabilities'
import {
  XIAOGUI_CODING_PLAN_DRAFT_METHOD_V1,
  type XiaoguiCodingPlanDraftResultV1,
  type WorkerHostToolErrorCodeV1,
} from '@shared/worker-host-tools'

import { requestWorkerHostTool } from './worker-host-tool-channel.js'

const TOOL_PROMPT = XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1.xiaogui_publish_coding_plan
export const XIAOGUI_CODING_PLAN_TOOL_NAME_V1 = TOOL_PROMPT.name

const PlanStepSchema = Type.Object(
  {
    stepId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
      description: '当前计划内稳定且唯一的步骤标识，例如 inspect_login。',
    }),
    title: Type.String({ minLength: 1, maxLength: 1000, description: '用户能看懂的步骤标题。' }),
    validation: Type.String({
      minLength: 1,
      maxLength: 2000,
      description: '该步骤如何用真实结果或命令验证；不能使用模型自述。',
    }),
  },
  { additionalProperties: false },
)

const CodingPlanBodySchema = Type.Object(
  {
    objective: Type.String({ minLength: 1, maxLength: 8000, description: '本次编程工作的目标。' }),
    steps: Type.Array(PlanStepSchema, {
      minItems: 1,
      maxItems: 128,
      description: '按执行顺序排列、可以独立检查的步骤。',
    }),
    constraints: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
      maxItems: 128,
      description: '不得突破的范围、安全和产品约束；没有额外约束时传空数组。',
    }),
  },
  { additionalProperties: false },
)

export interface XiaoguiCodingPlanToolOptionsV1 {
  getSourceSessionId: () => string | undefined
  getSourceTurnId: () => string | undefined
}

type XiaoguiCodingPlanToolDetailsV1 =
  | XiaoguiCodingPlanDraftResultV1
  | {
      kind: 'XIAOGUI_CODING_PLAN_DRAFT_FAILED'
      code: WorkerHostToolErrorCodeV1
      message: string
      traceId?: string
    }

export function addXiaoguiCodingPlanToolV1(
  result: LoadExtensionsResult,
  options: XiaoguiCodingPlanToolOptionsV1,
): LoadExtensionsResult {
  const sourceInfo = createSyntheticSourceInfo('<builtin:xiaogui-coding-plan>', {
    source: 'xiaogui-desktop',
    scope: 'temporary',
    origin: 'top-level',
  })
  const definition = defineTool<typeof CodingPlanBodySchema, XiaoguiCodingPlanToolDetailsV1>({
    ...TOOL_PROMPT,
    parameters: CodingPlanBodySchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const sourceSessionId = options.getSourceSessionId()
      if (!sourceSessionId) {
        const message = '当前对话尚未建立完成，请重新进入会话后再试'
        return {
          content: [{ type: 'text', text: message }],
          details: {
            kind: 'XIAOGUI_CODING_PLAN_DRAFT_FAILED' as const,
            code: 'SESSION_NOT_READY' as const,
            message,
          },
          isError: true,
        }
      }
      const sourceTurnId = options.getSourceTurnId()
      const outcome = await requestWorkerHostTool(
        {
          method: XIAOGUI_CODING_PLAN_DRAFT_METHOD_V1,
          payload: {
            sourceSessionId,
            ...(sourceTurnId ? { sourceTurnId } : {}),
            toolCallId,
            body: params,
          },
        },
        signal,
      )
      if (!outcome.ok) {
        return {
          content: [{ type: 'text', text: outcome.error.message }],
          details: {
            kind: 'XIAOGUI_CODING_PLAN_DRAFT_FAILED' as const,
            ...outcome.error,
          },
          isError: true,
        }
      }
      if (outcome.value.kind !== 'XIAOGUI_CODING_PLAN_DRAFT_SAVED') {
        const message = '主进程返回了无法识别的编程计划结果，请稍后重试'
        return {
          content: [{ type: 'text', text: message }],
          details: {
            kind: 'XIAOGUI_CODING_PLAN_DRAFT_FAILED' as const,
            code: 'HOST_TOOL_FAILED' as const,
            message,
          },
          isError: true,
        }
      }
      return {
        content: [{ type: 'text', text: '编程计划草稿已保存，正在等待用户批准。' }],
        details: outcome.value satisfies XiaoguiCodingPlanDraftResultV1,
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
