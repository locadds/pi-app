import {
  createSyntheticSourceInfo,
  defineTool,
  type Extension,
  type LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import {
  XIAOGUI_CREATE_COLLABORATION_PLAN_METHOD_V1,
  type XiaoguiCollaborationPlanCreatedV1,
  type WorkerHostToolErrorCodeV1,
} from '@shared/worker-host-tools'

import { requestWorkerHostTool } from './worker-host-tool-channel.js'

export const XIAOGUI_COLLABORATION_PLAN_TOOL_NAME = 'xiaogui_create_collaboration_plan'

const PlanTaskSchema = Type.Object(
  {
    taskKey: Type.String({
      minLength: 1,
      maxLength: 80,
      description: '任务内部标识，只供依赖引用，例如 research、draft、review；不要展示给用户。',
    }),
    title: Type.String({ minLength: 1, maxLength: 200, description: '用户能看懂的任务名称。' }),
    summary: Type.Optional(
      Type.String({ maxLength: 1200, description: '任务要完成什么、交付什么；用简洁中文。' }),
    ),
    dependsOn: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
        maxItems: 32,
        description: '必须先完成的 taskKey；没有依赖时省略。',
      }),
    ),
  },
  { additionalProperties: false },
)

const PlanDraftSchema = Type.Object(
  {
    objective: Type.String({ minLength: 1, maxLength: 4000, description: '整项工作的最终目标。' }),
    tasks: Type.Array(PlanTaskSchema, {
      minItems: 1,
      maxItems: 32,
      description: '可以分别完成并验收的任务；依赖关系必须是无环的。',
    }),
  },
  { additionalProperties: false },
)

export interface XiaoguiCollaborationToolOptions {
  getSourceSessionId: () => string | undefined
  getSourceTurnId: () => string | undefined
}

type XiaoguiCollaborationToolDetails =
  | XiaoguiCollaborationPlanCreatedV1
  | {
      kind: 'XIAOGUI_COLLABORATION_DRAFT_FAILED'
      code: WorkerHostToolErrorCodeV1
      message: string
      traceId?: string
    }

export function addXiaoguiCollaborationTool(
  result: LoadExtensionsResult,
  options: XiaoguiCollaborationToolOptions,
): LoadExtensionsResult {
  const sourceInfo = createSyntheticSourceInfo('<builtin:xiaogui-collaboration>', {
    source: 'xiaogui-desktop',
    scope: 'temporary',
    origin: 'top-level',
  })
  const definition = defineTool<typeof PlanDraftSchema, XiaoguiCollaborationToolDetails>({
    name: XIAOGUI_COLLABORATION_PLAN_TOOL_NAME,
    label: '创建协作计划',
    description:
      '把用户明确要求拆分、分工或交给多个 Agent 协作的工作，保存成待用户批准的协作计划草稿。仅在用户明确要创建执行计划或多 Agent 分工时调用；普通问答、单步工作和规划设计（DESIGN）研究不要调用。',
    promptSnippet: '把明确的多步骤协作需求写入小规协作计划，等待用户批准',
    promptGuidelines: [
      '用户明确要求任务拆分、分工、多 Agent 协作或建立执行计划时，使用 xiaogui_create_collaboration_plan。',
      '先从自然语言提炼目标、可验收任务和真实依赖；不要让用户填写 taskKey、依赖标识等内部字段。',
      '此工具只创建待批准草稿，不代表用户已经批准或开始执行。',
    ],
    parameters: PlanDraftSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const sourceSessionId = options.getSourceSessionId()
      if (!sourceSessionId) {
        return {
          content: [{ type: 'text', text: '当前对话尚未建立完成，请重新进入会话后再试' }],
          details: {
            kind: 'XIAOGUI_COLLABORATION_DRAFT_FAILED' as const,
            code: 'SESSION_NOT_READY' as const,
            message: '当前对话尚未建立完成，请重新进入会话后再试',
          },
          isError: true,
        }
      }
      const outcome = await requestWorkerHostTool(
        {
          method: XIAOGUI_CREATE_COLLABORATION_PLAN_METHOD_V1,
          payload: {
            draft: params,
            sourceSessionId,
            sourceTurnId: options.getSourceTurnId(),
            toolCallId,
          },
        },
        signal,
      )
      if (!outcome.ok) {
        return {
          content: [{ type: 'text', text: outcome.error.message }],
          details: {
            kind: 'XIAOGUI_COLLABORATION_DRAFT_FAILED' as const,
            ...outcome.error,
          },
          isError: true,
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: `已创建包含 ${outcome.value.taskCount} 项任务的协作计划草稿，正在等待用户确认；可打开右侧“协作”面板查看。`,
          },
        ],
        details: outcome.value satisfies XiaoguiCollaborationPlanCreatedV1,
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
