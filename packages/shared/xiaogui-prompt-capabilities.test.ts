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
  XIAOGUI_SHARED_TOOL_PROMPT_RULES_V1,
  XIAOGUI_TURN_CAPABILITY_SELECTOR_VERSION_V1,
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
    expect(XIAOGUI_CAPABILITY_REGISTRY_VERSION_V1).toBe('1.1.0')
    expect(Object.keys(XIAOGUI_CAPABILITY_REGISTRY_V1).sort())
      .toEqual([...XIAOGUI_CAPABILITY_IDS_V1].sort())
    expect(Object.entries(XIAOGUI_CAPABILITY_REGISTRY_V1).every(
      ([id, capability]) => capability.id === id && capability.promptLayer.kind === 'CAPABILITY',
    )).toBe(true)
    for (const id of [
      'work.file-organize',
      'work.report-docx',
      'work.template-intake',
      'work.template-generation',
    ] as const) {
      expect(XIAOGUI_CAPABILITY_REGISTRY_V1[id].version).toBe('1.1.0')
      expect(XIAOGUI_CAPABILITY_REGISTRY_V1[id].promptLayer.version).toBe('1.1.0')
    }
  })

  it('publishes structured usage and protocol groups while deriving the legacy flat guidelines', () => {
    const report = XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1.xiaogui_work_report_docx

    expect(Object.keys(XIAOGUI_SHARED_TOOL_PROMPT_RULES_V1)).toEqual([
      'system-selector-no-path',
      'no-internal-runtime-details',
      'save-as-new-no-overwrite',
    ])
    expect(report.sharedRuleIds).toEqual([
      'system-selector-no-path',
      'no-internal-runtime-details',
      'save-as-new-no-overwrite',
    ])
    expect(report.usage.when.join('\n')).toContain('明确要求')
    expect(report.usage.whenNot.join('\n')).toContain('自有模板')
    expect(report.protocol.sequence.join('\n')).toContain('PREPARE')
    expect(report.protocol.output.join('\n')).toContain('草稿全文')
    for (const ruleId of report.sharedRuleIds) {
      expect(report.promptGuidelines).toContain(
        XIAOGUI_SHARED_TOOL_PROMPT_RULES_V1[ruleId].content,
      )
    }
  })

  it('structures every Runtime tool without dropping the Pi flat guideline contract', () => {
    for (const tool of Object.values(XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1)) {
      expect(tool.usage, tool.name).toEqual({
        when: expect.any(Array),
        whenNot: expect.any(Array),
      })
      expect(tool.protocol, tool.name).toEqual({
        sequence: expect.any(Array),
        output: expect.any(Array),
      })
      expect([
        ...(tool.usage?.when ?? []),
        ...(tool.usage?.whenNot ?? []),
        ...(tool.protocol?.sequence ?? []),
        ...(tool.protocol?.output ?? []),
      ].length, tool.name).toBeGreaterThan(0)
      for (const guideline of [
        ...(tool.usage?.when ?? []),
        ...(tool.usage?.whenNot ?? []),
        ...(tool.protocol?.sequence ?? []),
        ...(tool.protocol?.output ?? []),
      ]) {
        expect(tool.promptGuidelines, `${tool.name}: ${guideline}`).toContain(guideline)
      }
    }
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

  it('uses explicit WORK Capability facts for Worker built-in tool policy', () => {
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
      enabledCapabilities: [],
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

  it('routes the ordinary-document quick action to template intake instead of generic materials', () => {
    const input = '整理我刚选择的普通成品文档“8.26海火变更文件 .doc”。请立即开始只读分析并生成候选内容报告，不要再次让我选择文件；原文档不得修改。'
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, input)).toMatchObject({
      decision: 'SELECTED',
      inferredCapabilityIds: ['work.template-intake'],
      reasonCodes: expect.arrayContaining(['LOCAL_TEMPLATE_INTAKE']),
    })
  })

  it('publishes selector 1.1.0 and preserves long .docx quick-action routing', () => {
    const fileDisplayName = '上海市浦东新区综合交通专项规划阶段成果汇编最终送审版说明文件.docx'
    const input = `请使用普通文档模板整理能力，把普通成品文档整理成可复用模板。我刚选择的文件是“${fileDisplayName}”。请立即开始只读分析并生成模板整理报告，不要再次让我选择文件；原文档不得修改。`
    expect(XIAOGUI_TURN_CAPABILITY_SELECTOR_VERSION_V1).toBe('1.1.0')
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, input)).toMatchObject({
      selectorVersion: '1.1.0',
      decision: 'SELECTED',
      inferredCapabilityIds: ['work.template-intake'],
    })
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

  it('continues a prepared capability when the complete reply is 可以生成', () => {
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, '可以生成', {
      oneTurnStickyCapabilityIds: ['work.template-generation'],
    })).toMatchObject({
      continuedCapabilityIds: ['work.template-generation'],
    })
  })

  it('continues a prepared capability when the complete reply is 可以生成了', () => {
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, '可以生成了', {
      oneTurnStickyCapabilityIds: ['work.template-generation'],
    })).toMatchObject({
      continuedCapabilityIds: ['work.template-generation'],
    })
  })

  it('accepts 好的 as a separated politeness prefix for a complete confirmation reply', () => {
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, '好的，可以生成了', {
      oneTurnStickyCapabilityIds: ['work.template-generation'],
    })).toMatchObject({
      continuedCapabilityIds: ['work.template-generation'],
    })
  })

  it('normalizes a full-width trailing period before matching the complete reply', () => {
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, '确认．', {
      oneTurnStickyCapabilityIds: ['work.template-generation'],
    })).toMatchObject({
      continuedCapabilityIds: ['work.template-generation'],
    })
  })

  it.each([
    '看起来可以',
    '可以',
    '可以生成',
    '可以生成了',
    '确认',
    '确认生成',
    '生成吧',
    '继续',
    '没问题',
    '就这样',
    '保存',
    '开始复核',
    '复核',
    '打开复核卡',
  ])('accepts the closed confirmation core phrase %s', (input) => {
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, input, {
      oneTurnStickyCapabilityIds: ['work.template-generation'],
    }).continuedCapabilityIds).toEqual(['work.template-generation'])
  })

  it.each([
    '好，确认',
    '好 确认',
    '好的,确认',
    '好的   确认！',
  ])('accepts the separated politeness form %s', (input) => {
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, input, {
      oneTurnStickyCapabilityIds: ['work.template-generation'],
    }).continuedCapabilityIds).toEqual(['work.template-generation'])
  })

  it.each([
    '不要确认',
    '暂时不可以生成',
    '可以先别生成',
    '继续解释，不要保存',
    '好的，可以生成了，但先改标题',
    '好可以生成',
    '好的可以生成了',
    '取消',
    '打开文件',
    '修改后再生成',
  ])('rejects the non-confirmation or mixed-intent reply %s', (input) => {
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, input, {
      oneTurnStickyCapabilityIds: ['work.template-generation'],
    }).continuedCapabilityIds).toEqual([])
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
    expect(
      XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1.xiaogui_work_read_materials.promptGuidelines.join('\n'),
    ).toContain('不得代替普通文档模板整理')
  })
})
