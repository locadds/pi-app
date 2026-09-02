import { describe, expect, it } from 'vitest'

import {
  XIAOGUI_CAPABILITY_IDS_V1,
  XIAOGUI_PROMPT_MODES_V1,
  XIAOGUI_PROMPT_PHASES_V1,
} from './xiaogui-prompt-contract'
import {
  workerBuiltinToolNamesFromPromptMatrixV1,
  XIAOGUI_CAPABILITY_MATRIX_V1,
  XIAOGUI_PHASE_POLICY_MATRIX_V1,
  XIAOGUI_PROMPT_MATRIX_ID_V1,
  XIAOGUI_PROMPT_MATRIX_VERSION_V1,
  type XiaoguiCapabilityMatrixRowV1,
} from './xiaogui-prompt-matrix'

describe('Xiaogui Prompt Mode / Phase / Capability / Tool Matrix V1', () => {
  it('is versioned and covers every declared mode, phase and capability once', () => {
    expect(XIAOGUI_PROMPT_MATRIX_ID_V1).toBe('xiaogui.prompt-matrix.v1')
    expect(XIAOGUI_PROMPT_MATRIX_VERSION_V1).toBe('1.0.0')
    expect(Object.keys(XIAOGUI_CAPABILITY_MATRIX_V1).sort())
      .toEqual([...XIAOGUI_CAPABILITY_IDS_V1].sort())
    expect(Object.keys(XIAOGUI_PHASE_POLICY_MATRIX_V1)).toEqual(XIAOGUI_PROMPT_PHASES_V1)
    for (const row of Object.values(XIAOGUI_CAPABILITY_MATRIX_V1)) {
      expect(Object.keys(row.modes)).toEqual(XIAOGUI_PROMPT_MODES_V1)
    }
  })

  it('encodes the specified mode policy without adding AUTO', () => {
    expect(XIAOGUI_CAPABILITY_MATRIX_V1['work.file-organize'].modes).toEqual({
      WORK: 'DEFAULT',
      DESIGN: 'READ_ONLY_REUSE',
      CODING: 'READ_ONLY_REUSE',
    })
    expect(XIAOGUI_CAPABILITY_MATRIX_V1['design.analysis'].modes).toEqual({
      WORK: 'RECOMMEND_SWITCH',
      DESIGN: 'ALLOWED',
      CODING: 'RECOMMEND_SWITCH',
    })
    expect(XIAOGUI_CAPABILITY_MATRIX_V1['coding.workspace'].modes).toEqual({
      WORK: 'RECOMMEND_SWITCH',
      DESIGN: 'RECOMMEND_SWITCH',
      CODING: 'ALLOWED',
    })
    expect(JSON.stringify(XIAOGUI_CAPABILITY_MATRIX_V1)).not.toContain('AUTO')
  })

  it('keeps ASK and PLAN read-only while preserving EXECUTE confirmation gates', () => {
    expect(XIAOGUI_PHASE_POLICY_MATRIX_V1.ASK.allowedEffects).toEqual(['READ_ONLY'])
    expect(XIAOGUI_PHASE_POLICY_MATRIX_V1.PLAN.allowedEffects).toEqual(['READ_ONLY'])
    expect(XIAOGUI_PHASE_POLICY_MATRIX_V1.EXECUTE.allowedEffects)
      .toContain('CONFIRMATION_GATED_PERSISTENT')
    for (const row of Object.values(XIAOGUI_PHASE_POLICY_MATRIX_V1)) {
      expect(row.irreversibleActionsRequireHumanConfirmation).toBe(true)
    }
  })

  it('uses static tool identifiers only and accounts for all current Worker built-ins', () => {
    const rows = Object.values(XIAOGUI_CAPABILITY_MATRIX_V1) as readonly XiaoguiCapabilityMatrixRowV1[]
    const tools = rows.flatMap((row) => row.tools)
    expect(tools.every((tool) => /^[A-Za-z][A-Za-z0-9._:-]*$/.test(tool.name))).toBe(true)
    expect(workerBuiltinToolNamesFromPromptMatrixV1()).toEqual([
      'xiaogui_create_collaboration_plan',
      'xiaogui_publish_coding_plan',
      'xiaogui_read_pdf',
      'xiaogui_work_docx',
      'xiaogui_work_docx_advanced_generation',
      'xiaogui_work_docx_template_intake',
      'xiaogui_work_docx_template_materialize',
      'xiaogui_work_read_materials',
      'xiaogui_work_report_docx',
    ])
    expect(XIAOGUI_CAPABILITY_MATRIX_V1['design.analysis'].tools.map((tool) => tool.name))
      .toEqual([
        'design_project',
        'design_document',
        'design_data',
        'design_cad',
        'design_gis',
        'design_spatial',
      ])
  })
})
