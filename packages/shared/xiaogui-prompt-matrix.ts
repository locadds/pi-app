import type {
  XiaoguiCapabilityId,
  XiaoguiExecutionPhase,
  XiaoguiMode,
} from './xiaogui-prompt-contract'

export const XIAOGUI_PROMPT_MATRIX_ID_V1 = 'xiaogui.prompt-matrix.v1' as const
export const XIAOGUI_PROMPT_MATRIX_VERSION_V1 = '1.1.0' as const

export type XiaoguiModeCapabilityPolicyV1 =
  | 'DEFAULT'
  | 'ALLOWED'
  | 'READ_ONLY_REUSE'
  | 'EXPLICIT_EXPORT_ONLY'
  | 'COMPLEX_TASK_ONLY'
  | 'RECOMMEND_SWITCH'
  | 'HIDDEN'

export type XiaoguiPhaseEffectV1 =
  | 'READ_ONLY'
  | 'REVERSIBLE_DRAFT'
  | 'CONFIRMATION_GATED_PERSISTENT'

export interface XiaoguiPhasePolicyV1 {
  readonly allowedEffects: readonly XiaoguiPhaseEffectV1[]
  readonly mayPublishOrApply: boolean
  readonly irreversibleActionsRequireHumanConfirmation: true
}

export type XiaoguiToolSourceV1 = 'PI_CORE' | 'WORKER_BUILTIN' | 'PROJECT_EXTENSION'

export interface XiaoguiCapabilityToolV1 {
  readonly name: string
  readonly source: XiaoguiToolSourceV1
  /** Omitted means the tool is a candidate in every execution phase. */
  readonly phases?: readonly XiaoguiExecutionPhase[]
}

export interface XiaoguiCapabilityMatrixRowV1 {
  readonly version: string
  readonly modes: Readonly<Record<XiaoguiMode, XiaoguiModeCapabilityPolicyV1>>
  readonly tools: readonly XiaoguiCapabilityToolV1[]
}

export const XIAOGUI_PHASE_POLICY_MATRIX_V1 = {
  ASK: {
    allowedEffects: ['READ_ONLY'],
    mayPublishOrApply: false,
    irreversibleActionsRequireHumanConfirmation: true,
  },
  PLAN: {
    allowedEffects: ['READ_ONLY'],
    mayPublishOrApply: false,
    irreversibleActionsRequireHumanConfirmation: true,
  },
  EXECUTE: {
    allowedEffects: ['READ_ONLY', 'REVERSIBLE_DRAFT', 'CONFIRMATION_GATED_PERSISTENT'],
    mayPublishOrApply: true,
    irreversibleActionsRequireHumanConfirmation: true,
  },
} as const satisfies Readonly<Record<XiaoguiExecutionPhase, XiaoguiPhasePolicyV1>>

/**
 * Versioned source of truth for product Capability policy. Mode-compatible
 * tools may be registered as candidates, but the live Session activates only
 * the per-turn Mode x Phase x Capability x Runtime intersection.
 */
export const XIAOGUI_CAPABILITY_MATRIX_V1 = {
  'collaboration.execution': {
    version: '1.0.0',
    modes: {
      WORK: 'COMPLEX_TASK_ONLY',
      DESIGN: 'COMPLEX_TASK_ONLY',
      CODING: 'ALLOWED',
    },
    tools: [
      { name: 'xiaogui_create_collaboration_plan', source: 'WORKER_BUILTIN' },
    ],
  },
  'work.file-organize': {
    version: '1.0.0',
    modes: {
      WORK: 'DEFAULT',
      DESIGN: 'READ_ONLY_REUSE',
      CODING: 'READ_ONLY_REUSE',
    },
    tools: [
      { name: 'read', source: 'PI_CORE' },
      { name: 'xiaogui_read_pdf', source: 'WORKER_BUILTIN' },
      { name: 'xiaogui_work_read_materials', source: 'WORKER_BUILTIN' },
    ],
  },
  'work.report-docx': {
    version: '1.0.0',
    modes: {
      WORK: 'ALLOWED',
      DESIGN: 'EXPLICIT_EXPORT_ONLY',
      CODING: 'HIDDEN',
    },
    tools: [
      { name: 'xiaogui_work_report_docx', source: 'WORKER_BUILTIN' },
    ],
  },
  'work.template-intake': {
    version: '1.0.0',
    modes: {
      WORK: 'ALLOWED',
      DESIGN: 'HIDDEN',
      CODING: 'HIDDEN',
    },
    tools: [
      { name: 'xiaogui_work_docx_template_intake', source: 'WORKER_BUILTIN' },
      { name: 'xiaogui_work_docx_template_materialize', source: 'WORKER_BUILTIN' },
    ],
  },
  'work.template-generation': {
    version: '1.0.0',
    modes: {
      WORK: 'ALLOWED',
      DESIGN: 'HIDDEN',
      CODING: 'HIDDEN',
    },
    tools: [
      { name: 'xiaogui_work_docx', source: 'WORKER_BUILTIN' },
      { name: 'xiaogui_work_docx_advanced_generation', source: 'WORKER_BUILTIN' },
    ],
  },
  'design.analysis': {
    version: '1.0.0',
    modes: {
      WORK: 'RECOMMEND_SWITCH',
      DESIGN: 'ALLOWED',
      CODING: 'RECOMMEND_SWITCH',
    },
    tools: [
      { name: 'design_project', source: 'PROJECT_EXTENSION' },
      { name: 'design_document', source: 'PROJECT_EXTENSION' },
      { name: 'design_data', source: 'PROJECT_EXTENSION' },
      { name: 'design_cad', source: 'PROJECT_EXTENSION' },
      { name: 'design_gis', source: 'PROJECT_EXTENSION' },
      { name: 'design_spatial', source: 'PROJECT_EXTENSION' },
    ],
  },
  'coding.workspace': {
    version: '1.1.0',
    modes: {
      WORK: 'RECOMMEND_SWITCH',
      DESIGN: 'RECOMMEND_SWITCH',
      CODING: 'DEFAULT',
    },
    tools: [
      { name: 'read', source: 'PI_CORE' },
      { name: 'bash', source: 'PI_CORE' },
      { name: 'edit', source: 'PI_CORE' },
      { name: 'write', source: 'PI_CORE' },
      {
        name: 'xiaogui_publish_coding_plan',
        source: 'WORKER_BUILTIN',
        phases: ['PLAN'],
      },
    ],
  },
} as const satisfies Readonly<Record<XiaoguiCapabilityId, XiaoguiCapabilityMatrixRowV1>>

export function workerBuiltinToolNamesFromPromptMatrixV1(): readonly string[] {
  return [...new Set(
    Object.values(XIAOGUI_CAPABILITY_MATRIX_V1).flatMap((row) =>
      row.tools
        .filter((tool) => tool.source === 'WORKER_BUILTIN')
        .map((tool) => tool.name),
    ),
  )].sort()
}

export const XIAOGUI_DEFAULT_CAPABILITIES_BY_MODE_V1 = {
  WORK: ['work.file-organize'],
  DESIGN: [],
  CODING: ['coding.workspace'],
} as const satisfies Readonly<Record<XiaoguiMode, readonly XiaoguiCapabilityId[]>>
