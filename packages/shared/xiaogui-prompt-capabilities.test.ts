import { describe, expect, it } from 'vitest'

import {
  XIAOGUI_CAPABILITY_IDS_V1,
  type XiaoguiPromptContextV1,
} from './xiaogui-prompt-contract'
import {
  activeToolNamesForPromptContextV1,
  resolveEffectiveXiaoguiCapabilitiesV1,
  selectXiaoguiTurnCapabilitiesV1,
  workerBuiltinToolNamesForPromptContextV1,
  workerBuiltinToolNamesForModeV1,
  xiaoguiPromptStickyCandidateForToolActionV1,
  xiaoguiPromptStickyCapabilityFromToolResultV1,
  XIAOGUI_CAPABILITY_REGISTRY_ID_V1,
  XIAOGUI_CAPABILITY_REGISTRY_VERSION_V1,
  XIAOGUI_CAPABILITY_REGISTRY_V1,
  XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1,
} from './xiaogui-prompt-capabilities'

const reportContext = (): XiaoguiPromptContextV1 => ({
  schemaVersion: 1,
  mode: 'WORK',
  phase: 'EXECUTE',
  workspaceAvailable: true,
  projectTrusted: true,
  enabledCapabilities: ['work.report-docx'],
  availableToolNames: ['xiaogui_work_report_docx'],
})

describe('Xiaogui Prompt Capability Registry V1', () => {
  it('is versioned and covers every Capability exactly once', () => {
    expect(XIAOGUI_CAPABILITY_REGISTRY_ID_V1).toBe('xiaogui.capability-registry.v1')
    expect(XIAOGUI_CAPABILITY_REGISTRY_VERSION_V1).toBe('1.0.0')
    expect(Object.keys(XIAOGUI_CAPABILITY_REGISTRY_V1).sort())
      .toEqual([...XIAOGUI_CAPABILITY_IDS_V1].sort())
    expect(Object.entries(XIAOGUI_CAPABILITY_REGISTRY_V1).every(
      ([id, capability]) => capability.id === id && capability.promptLayer.kind === 'CAPABILITY',
    )).toBe(true)
  })

  it('does not claim a Capability when one of its required Runtime tools is absent', () => {
    expect(resolveEffectiveXiaoguiCapabilitiesV1(reportContext(), [])).toEqual([])
    expect(resolveEffectiveXiaoguiCapabilitiesV1(
      reportContext(),
      ['xiaogui_work_report_docx'],
    ).map((capability) => capability.id)).toEqual(['work.report-docx'])
  })

  it('never auto-activates ALLOWED capabilities merely because their tools exist', () => {
    const base = {
      ...reportContext(),
      enabledCapabilities: ['work.file-organize' as const],
    }
    expect(resolveEffectiveXiaoguiCapabilitiesV1(base, [
      'read',
      'xiaogui_work_read_materials',
    ]).map((entry) => entry.id))
      .toEqual(['work.file-organize'])
    expect(resolveEffectiveXiaoguiCapabilitiesV1(base, [
      'read',
      'xiaogui_work_read_materials',
      'xiaogui_work_report_docx',
    ]).map((entry) => entry.id)).toEqual(['work.file-organize'])
    expect(resolveEffectiveXiaoguiCapabilitiesV1({
      ...base,
      enabledCapabilities: ['work.file-organize', 'work.report-docx'],
    }, [
      'read',
      'xiaogui_work_read_materials',
      'xiaogui_work_report_docx',
    ]).map((entry) => entry.id)).toEqual(['work.file-organize', 'work.report-docx'])
    expect(resolveEffectiveXiaoguiCapabilitiesV1({
      ...base,
      phase: 'ASK',
      enabledCapabilities: ['work.file-organize', 'work.report-docx'],
    }, [
      'read',
      'xiaogui_work_read_materials',
      'xiaogui_work_report_docx',
    ]).map((entry) => entry.id)).toEqual(['work.file-organize'])
  })

  it('keeps file-based WORK capabilities usable without a project workspace', () => {
    expect(resolveEffectiveXiaoguiCapabilitiesV1({
      ...reportContext(),
      workspaceAvailable: false,
    }, ['xiaogui_work_report_docx']).map((entry) => entry.id)).toEqual(['work.report-docx'])
    expect(resolveEffectiveXiaoguiCapabilitiesV1({
      ...reportContext(),
      mode: 'CODING',
      workspaceAvailable: false,
      enabledCapabilities: ['coding.workspace'],
    }, ['read', 'bash', 'edit', 'write']).map((entry) => entry.id)).toEqual([])
  })

  it('rejects a Capability requested from a hidden or recommend-switch mode', () => {
    expect(() => resolveEffectiveXiaoguiCapabilitiesV1({
      ...reportContext(),
      mode: 'CODING',
    }, ['xiaogui_work_report_docx'])).toThrow(
      'XIAOGUI_PROMPT_CONTEXT_CAPABILITY_MODE_MISMATCH',
    )
  })

  it('exposes only Worker built-ins allowed by the selected mode', () => {
    expect(workerBuiltinToolNamesForModeV1('WORK')).toContain('xiaogui_work_docx_template_intake')
    expect(workerBuiltinToolNamesForModeV1('DESIGN')).toContain('xiaogui_work_report_docx')
    expect(workerBuiltinToolNamesForModeV1('CODING')).not.toContain('xiaogui_work_report_docx')
    expect(workerBuiltinToolNamesForModeV1('CODING'))
      .not.toContain('xiaogui_work_docx_template_intake')
  })

  it('uses immutable Mode + Phase + explicit Capability facts for Worker Host Tool Policy', () => {
    const work = {
      mode: 'WORK' as const,
      phase: 'EXECUTE' as const,
      workspaceAvailable: true,
      enabledCapabilities: ['work.file-organize' as const],
    }
    expect(workerBuiltinToolNamesForPromptContextV1(work))
      .toEqual(['xiaogui_read_pdf', 'xiaogui_work_read_materials'])
    expect(workerBuiltinToolNamesForPromptContextV1({ ...work, phase: 'PLAN' }))
      .toEqual(['xiaogui_read_pdf', 'xiaogui_work_read_materials'])
    expect(workerBuiltinToolNamesForPromptContextV1({
      ...work,
      enabledCapabilities: ['work.file-organize', 'collaboration.execution'],
    })).toContain('xiaogui_create_collaboration_plan')
  })

  it('enforces ASK/PLAN against the final registered Tool set', () => {
    const registered = [
      'read', 'bash', 'edit', 'write', 'design_gis',
      'xiaogui_read_pdf', 'xiaogui_work_read_materials', 'xiaogui_work_report_docx',
    ]
    const plan = {
      mode: 'CODING' as const,
      phase: 'PLAN' as const,
      workspaceAvailable: true,
      enabledCapabilities: ['coding.workspace' as const],
    }
    expect(activeToolNamesForPromptContextV1(plan, registered)).toEqual(['read'])
    expect(activeToolNamesForPromptContextV1({
      ...plan,
      phase: 'EXECUTE',
    }, registered)).toEqual(['bash', 'edit', 'read', 'write'])
  })

  it.each([
    ['把这份普通成品文档整理成模板', ['work.file-organize', 'work.template-intake']],
    ['用我自己的模板生成报告', ['work.file-organize', 'work.template-generation']],
    ['把刚才写好的内容生成 Word', ['work.file-organize', 'work.report-docx']],
    ['写一份报告内容', ['work.file-organize']],
    ['请拆分任务并交给多个 Agent 协作', ['collaboration.execution', 'work.file-organize']],
  ])('selects an exact WORK capability for %s', (input, expected) => {
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, input).capabilityIds).toEqual(expected)
  })

  it('abandons mixed or cross-mode intent instead of pre-activating a high-risk capability', () => {
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, '做选址分析并写成 Word 报告')).toMatchObject({
      decision: 'AMBIGUOUS',
      capabilityIds: ['work.file-organize'],
      inferredCapabilityIds: [],
      reasonCodes: expect.arrayContaining(['MIXED_TASK_ABSTAINED']),
    })
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, '帮我修这个 TypeScript bug 并跑测试')).toMatchObject({
      capabilityIds: ['work.file-organize'],
      inferredCapabilityIds: [],
      reasonCodes: expect.arrayContaining(['MODE_BLOCKED']),
    })
  })

  it('uses a confirmation-gated Capability for one continuation only and lets new intent win', () => {
    const context = { mode: 'WORK' as const, enabledCapabilities: [] as const }
    const sticky = ['work.template-generation' as const]
    expect(selectXiaoguiTurnCapabilitiesV1(context, '看起来可以', {
      oneTurnStickyCapabilityIds: sticky,
    })).toMatchObject({
      continuedCapabilityIds: sticky,
      capabilityIds: ['work.file-organize', 'work.template-generation'],
    })
    expect(selectXiaoguiTurnCapabilitiesV1(context, '把这份普通成品文档整理成模板', {
      oneTurnStickyCapabilityIds: sticky,
    })).toMatchObject({
      continuedCapabilityIds: [],
      inferredCapabilityIds: ['work.template-intake'],
      capabilityIds: ['work.file-organize', 'work.template-intake'],
    })
  })

  it('commits continuation only for an exact successful preparation tool result', () => {
    expect(xiaoguiPromptStickyCandidateForToolActionV1(
      'xiaogui_work_docx',
      'PREPARE',
    )).toBe('work.template-generation')
    expect(xiaoguiPromptStickyCapabilityFromToolResultV1({
      toolName: 'xiaogui_work_docx',
      action: 'PREPARE',
      resultKind: 'XIAOGUI_WORK_DOCX_PREPARED',
      isError: false,
    })).toBe('work.template-generation')
    expect(xiaoguiPromptStickyCapabilityFromToolResultV1({
      toolName: 'xiaogui_work_docx',
      action: 'PREPARE',
      resultKind: 'XIAOGUI_WORK_DOCX_FAILED',
      isError: true,
    })).toBeNull()
    expect(xiaoguiPromptStickyCapabilityFromToolResultV1({
      toolName: 'xiaogui_work_docx',
      action: 'PREPARE',
      resultKind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED',
      isError: false,
    })).toBeNull()
  })

  it('keeps the Word confirmation gates in the single Tool Definition registry', () => {
    const report = XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1.xiaogui_work_report_docx
    const template = XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1.xiaogui_work_docx

    expect(report.promptGuidelines.join('\n')).toContain('下一条消息明确确认')
    expect(report.promptGuidelines.join('\n')).toContain('不得声称覆盖或修改了已有文件')
    expect(template.promptGuidelines.join('\n')).toContain('不得同一轮调用 CONFIRM')
    expect(template.promptGuidelines.join('\n')).toContain('不能猜测')
  })
})
