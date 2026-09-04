import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

/**
 * Behaviours retained from the OMP research and provided by the existing
 * Xiaogui Pi/TaskHub seams. They are deliberately not a Runtime selector or a
 * user-facing product mode.
 */
export const XIAOGUI_CODING_TRANSPARENT_CAPABILITIES_V1 = Object.freeze([
  'PROJECT_RULES_AND_SKILLS',
  'CONTROLLED_CONTEXT',
  'ROLE_SCOPED_TOOLS',
  'HOST_MEDIATED_PERMISSION',
  'USER_SELECTED_PLANNING',
  'EVIDENCE_AND_CHECKPOINT',
] as const)

export const XIAOGUI_CODING_TRANSPARENT_HARNESS_MARKER_V1 =
  '【小规 CODING 透明能力包】' as const

export interface XiaoguiCodingTransparentHarnessExtensionV1 {
  readonly name: 'xiaogui-coding-transparent-harness-v1'
  readonly hidden: true
  readonly capabilities: typeof XIAOGUI_CODING_TRANSPARENT_CAPABILITIES_V1
  readonly factory: ExtensionFactory
}

/**
 * Pi-side policy glue for capabilities whose hard enforcement stays with the
 * existing role guard and TaskHub. No OMP process, configuration or UI is
 * introduced here.
 */
export function createXiaoguiCodingTransparentHarnessExtensionV1(): XiaoguiCodingTransparentHarnessExtensionV1 {
  const factory: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', (event) => ({
      systemPrompt: [
        event.systemPrompt,
        '',
        XIAOGUI_CODING_TRANSPARENT_HARNESS_MARKER_V1,
        '按需使用 Pi 已加载的项目规则与 Skill，并以小规提供的受控上下文为准。',
        '普通编程请求直接处理；仅当用户明确要求规划或当前会话已处于 PLAN 时使用计划流程，不得强制切换到 ASK 或 PLAN。',
        '写入、命令和外传必须服从宿主的角色、权限及工作树边界，不得自行批准或绕过。',
        '完成结论必须基于宿主提供的真实差异和实际验证结果；检查点恢复必须经过预览与人工确认。',
      ].join('\n'),
    }))
  }
  return Object.freeze({
    name: 'xiaogui-coding-transparent-harness-v1',
    hidden: true,
    capabilities: XIAOGUI_CODING_TRANSPARENT_CAPABILITIES_V1,
    factory,
  })
}
