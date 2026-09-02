import { describe, expect, it } from 'vitest'

import type { XiaoguiPromptLayerV1 } from '@shared/xiaogui-prompt-contract'
import {
  createXiaoguiPromptBuilderV1,
  XIAOGUI_PRODUCT_PROMPT_MAX_CHARACTERS_V1,
  XIAOGUI_RUNTIME_FACTS_MAX_CHARACTERS_V1,
  xiaoguiPromptBuilderV1,
} from './builder'

const context = (mode: 'WORK' | 'DESIGN' | 'CODING' = 'WORK', phase: 'ASK' | 'PLAN' | 'EXECUTE' = 'ASK') => ({
  schemaVersion: 1 as const,
  mode,
  phase,
  workspaceAvailable: true,
  projectTrusted: true,
  enabledCapabilities: mode === 'DESIGN'
    ? ['design.analysis' as const]
    : mode === 'CODING'
      ? ['coding.workspace' as const]
      : ['work.file-organize' as const],
  availableToolNames: ['read', 'xiaogui_read_pdf', 'xiaogui_work_read_materials'],
  sessionKey: 'xgs1_session',
  projectId: 'xgp1_project',
})

describe('Xiaogui effective Prompt Builder V1', () => {
  it('selects exactly one versioned Base, Mode and Phase Layer', () => {
    const work = xiaoguiPromptBuilderV1.build({
      context: context('WORK', 'ASK'),
      piSystemPrompt: 'PI base',
      generatedAt: '2026-08-30T00:00:00.000Z',
    })
    const coding = xiaoguiPromptBuilderV1.build({
      context: context('CODING', 'EXECUTE'),
      piSystemPrompt: 'PI base',
      generatedAt: '2026-08-30T00:00:00.000Z',
    })

    expect(work.prompt).toContain('# 小规 Agent')
    expect(work.prompt).toContain('# 当前模式：WORK｜工作')
    expect(work.prompt).toContain('# 当前执行阶段：ASK')
    expect(work.prompt).not.toContain('# 当前模式：CODING｜编程')
    expect(coding.prompt).toContain('# 当前模式：CODING｜编程')
    expect(coding.prompt).toContain('# 当前执行阶段：EXECUTE')
    expect(work.diagnostics.manifest.layers.map((layer) => layer.id)).toEqual([
      'pi.system-context',
      'xiaogui.base',
      'xiaogui.mode.work',
      'xiaogui.phase.ask',
      'xiaogui.capability.work.file-organize',
      'xiaogui.runtime.facts',
    ])
    expect(work.productPrompt).toContain('# 运行事实')
    expect(work.productPrompt).toContain('本轮可用产品能力：work.file-organize')
    expect(work.productPrompt).not.toContain('template-intake-analysis@1.2.0')
  })

  it('hashes the complete normalized Effective Prompt and excludes generatedAt', () => {
    const layers: readonly XiaoguiPromptLayerV1[] = [
      { id: 'xiaogui.base', version: '1.0.0', kind: 'BASE', required: true, content: 'BASE' },
      { id: 'xiaogui.mode.work', version: '1.0.0', kind: 'MODE', required: true, content: 'MODE' },
      { id: 'xiaogui.phase.ask', version: '1.0.0', kind: 'PHASE', required: true, content: 'PHASE' },
    ]
    const builder = createXiaoguiPromptBuilderV1(layers)
    const first = builder.build({
      context: { ...context(), enabledCapabilities: [] },
      piSystemPrompt: 'PI\r\nBASELINE',
      runtimeTools: [],
      generatedAt: '2026-08-30T00:00:00.000Z',
    })
    const second = builder.build({
      context: { ...context(), enabledCapabilities: [] },
      piSystemPrompt: 'PI\nBASELINE',
      runtimeTools: [],
      generatedAt: '2026-08-31T00:00:00.000Z',
    })

    expect(first.prompt).toContain('PI\nBASELINE')
    expect(first.prompt).toContain('<!-- XIAOGUI:PRODUCT:BEGIN -->\nBASE\n\nMODE\n\nPHASE')
    expect(first.prompt).toContain('# 运行事实')
    expect(first.diagnostics.manifest.completePromptCharacterCount).toBe(first.prompt.length)
    expect(first.diagnostics.manifest.completePromptSha256)
      .toMatch(/^[a-f0-9]{64}$/)
    expect(second.diagnostics.manifest.completePromptSha256)
      .toBe(first.diagnostics.manifest.completePromptSha256)
  })

  it('restores current Tool snippets and guidelines only for Pi custom SYSTEM', () => {
    const custom = xiaoguiPromptBuilderV1.build({
      context: context(),
      piSystemPrompt: 'USER SYSTEM\n\n<project_context>project facts</project_context>',
      piCustomSystem: true,
      runtimeTools: [
        { name: 'read', promptSnippet: '读取文件', promptGuidelines: ['只读所需内容'] },
        { name: 'xiaogui_read_pdf', promptSnippet: '读取 PDF', promptGuidelines: ['不让用户输入路径'] },
        {
          name: 'xiaogui_work_read_materials',
          promptSnippet: '读取所有类型资料',
          promptGuidelines: ['不支持语义解析时保留元数据'],
        },
      ],
      generatedAt: '2026-08-30T00:00:00.000Z',
    })
    const defaultHarness = xiaoguiPromptBuilderV1.build({
      context: context(),
      piSystemPrompt: 'PI harness already contains current guidelines',
      piCustomSystem: false,
      runtimeTools: [
        { name: 'read', promptSnippet: '读取文件', promptGuidelines: ['只读所需内容'] },
        { name: 'xiaogui_work_read_materials' },
      ],
      generatedAt: '2026-08-30T00:00:00.000Z',
    })

    expect(custom.prompt).toContain('USER SYSTEM')
    expect(custom.prompt).toContain('<project_context>project facts</project_context>')
    expect(custom.prompt).toContain('## read')
    expect(custom.prompt).toContain('工具摘要：读取文件')
    expect(custom.prompt).toContain('- 不让用户输入路径')
    expect(custom.productPrompt).not.toContain('USER SYSTEM')
    expect(custom.productPrompt).not.toContain('<project_context>')
    expect(custom.productPrompt).not.toContain('工具摘要：读取文件')
    expect(custom.diagnostics.manifest.layers.map((layer) => layer.id))
      .toContain('pi.custom-system-tool-guidelines')
    expect(defaultHarness.prompt).not.toContain('工具摘要：读取文件')
    expect(defaultHarness.diagnostics.manifest.layers.map((layer) => layer.id))
      .not.toContain('pi.custom-system-tool-guidelines')
  })

  it('renders shared rules once while keeping structured guidance under each tool name', () => {
    const sharedRule = '生成成果必须另存为新文件。'
    const result = xiaoguiPromptBuilderV1.build({
      context: { ...context(), enabledCapabilities: [] },
      piSystemPrompt: 'USER SYSTEM',
      piCustomSystem: true,
      runtimeTools: [
        {
          name: 'external_alpha',
          promptSnippet: '执行甲类任务',
          sharedRules: [{ id: 'save-as-new', content: sharedRule }],
          usage: { when: ['用户要求甲类任务时调用。'], whenNot: ['乙类任务时不调用。'] },
          protocol: { sequence: ['先执行甲步骤。'], output: ['只返回甲结果。'] },
        },
        {
          name: 'external_beta',
          promptSnippet: '执行乙类任务',
          sharedRules: [{ id: 'save-as-new', content: sharedRule }],
          usage: { when: ['用户要求乙类任务时调用。'], whenNot: ['甲类任务时不调用。'] },
          protocol: { sequence: ['先执行乙步骤。'], output: ['只返回乙结果。'] },
        },
      ],
      generatedAt: '2026-09-02T00:00:00.000Z',
    })

    const alpha = result.prompt.slice(
      result.prompt.indexOf('## external_alpha'),
      result.prompt.indexOf('## external_beta'),
    )
    const beta = result.prompt.slice(result.prompt.indexOf('## external_beta'))

    expect(result.prompt).toContain('## 共享规则')
    expect(result.prompt.split(sharedRule)).toHaveLength(2)
    expect(alpha).toContain('### 何时调用/不调用')
    expect(alpha).toContain('用户要求甲类任务时调用。')
    expect(alpha).toContain('### 调用协议')
    expect(alpha).toContain('先执行甲步骤。')
    expect(alpha).not.toContain('用户要求乙类任务时调用。')
    expect(beta).toContain('用户要求乙类任务时调用。')
    expect(result.diagnostics.manifest.layers).toContainEqual(expect.objectContaining({
      id: 'pi.custom-system-tool-guidelines',
      version: '0.84.1-compat.2',
    }))
  })

  it('deduplicates the legacy DESIGN marker in memory without dropping surrounding project context', () => {
    const result = xiaoguiPromptBuilderV1.build({
      context: context('DESIGN', 'PLAN'),
      piSystemPrompt: [
        'USER APPEND',
        '<!-- XIAOGUI:DESIGN:BEGIN -->',
        'legacy design body',
        '<!-- XIAOGUI:DESIGN:END -->',
        'BETWEEN LEGACY BLOCKS',
        '<!-- XIAOGUI:DESIGN:BEGIN -->',
        'second legacy design body',
        '<!-- XIAOGUI:DESIGN:END -->',
        '<project_context>keep me</project_context>',
      ].join('\n'),
      generatedAt: '2026-08-30T00:00:00.000Z',
    })

    expect(result.prompt).not.toContain('legacy design body')
    expect(result.prompt).not.toContain('second legacy design body')
    expect(result.prompt).toContain('BETWEEN LEGACY BLOCKS')
    expect(result.prompt).toContain('<project_context>keep me</project_context>')
    expect(result.prompt).toContain('# 当前模式：DESIGN｜规划设计')
    expect(result.diagnostics.migrationNotices).toEqual([
      { code: 'LEGACY_DESIGN_PROMPT_RUNTIME_DEDUPED', fileMutation: false },
    ])
  })

  it('fails explicitly for duplicate or missing required registry Layers', () => {
    const base: XiaoguiPromptLayerV1 = {
      id: 'xiaogui.base', version: '1.0.0', kind: 'BASE', required: true, content: 'BASE',
    }
    expect(() => createXiaoguiPromptBuilderV1([base, base]))
      .toThrow('XIAOGUI_PROMPT_LAYER_DUPLICATE')
    expect(() => createXiaoguiPromptBuilderV1([base]).build({
      context: context(),
      piSystemPrompt: 'PI',
    })).toThrow('XIAOGUI_PROMPT_REQUIRED_LAYER_MISSING')
  })

  it('derives effective Capabilities from Mode, Phase and actual Runtime tools', () => {
    const designWithoutProfessionalTools = xiaoguiPromptBuilderV1.build({
      context: context('DESIGN', 'ASK'),
      piSystemPrompt: 'PI',
      runtimeTools: [{ name: 'read' }],
    })
    const designWithProfessionalTool = xiaoguiPromptBuilderV1.build({
      context: context('DESIGN', 'ASK'),
      piSystemPrompt: 'PI',
      runtimeTools: [
        { name: 'read' },
        { name: 'design_project' },
        { name: 'design_document' },
        { name: 'design_data' },
        { name: 'design_cad' },
        { name: 'design_gis' },
        { name: 'design_spatial' },
      ],
    })
    const reportContext = {
      ...context('WORK', 'ASK'),
      enabledCapabilities: ['work.report-docx' as const],
    }
    const reportExecute = xiaoguiPromptBuilderV1.build({
      context: { ...reportContext, phase: 'EXECUTE' as const },
      piSystemPrompt: 'PI',
      runtimeTools: [{ name: 'xiaogui_work_report_docx' }],
    })

    expect(designWithoutProfessionalTools.diagnostics.manifest.capabilityIds).toEqual([])
    expect(designWithProfessionalTool.diagnostics.manifest.capabilityIds)
      .toEqual(['design.analysis'])
    expect(() => xiaoguiPromptBuilderV1.build({
      context: reportContext,
      piSystemPrompt: 'PI',
      runtimeTools: [{ name: 'xiaogui_work_report_docx' }],
    })).toThrow('XIAOGUI_PROMPT_TOOL_PHASE_MISMATCH')
    expect(reportExecute.diagnostics.manifest.capabilityIds).toEqual(['work.report-docx'])
    expect(() => xiaoguiPromptBuilderV1.build({
      context: { ...context('WORK', 'ASK'), enabledCapabilities: ['design.analysis'] },
      piSystemPrompt: 'PI',
      runtimeTools: [{ name: 'design_gis' }],
    })).toThrow('XIAOGUI_PROMPT_TOOL_MODE_MISMATCH')
  })

  it('keeps Runtime Facts and the code-owned product Prompt within their budgets', () => {
    const result = xiaoguiPromptBuilderV1.build({
      context: {
        ...context('WORK', 'EXECUTE'),
        enabledCapabilities: [
          'work.file-organize',
          'work.report-docx',
          'work.template-intake',
          'work.template-generation',
        ],
      },
      piSystemPrompt: 'PI',
      runtimeTools: [
        { name: 'read' },
        { name: 'xiaogui_read_pdf' },
        { name: 'xiaogui_work_read_materials' },
        { name: 'xiaogui_work_report_docx' },
        { name: 'xiaogui_work_docx_template_intake' },
        { name: 'xiaogui_work_docx_template_materialize' },
        { name: 'xiaogui_work_docx' },
        { name: 'xiaogui_work_docx_advanced_generation' },
      ],
    })
    const runtimeManifest = result.diagnostics.manifest.layers
      .find((layer) => layer.id === 'xiaogui.runtime.facts')

    expect(runtimeManifest?.version).toBe('1.1.0')
    expect(runtimeManifest?.characterCount).toBeLessThanOrEqual(
      XIAOGUI_RUNTIME_FACTS_MAX_CHARACTERS_V1,
    )
    expect(result.productPrompt).not.toContain('Runtime 实际加载工具')
    expect(result.diagnostics.manifest.toolNames).toEqual([
      'read',
      'xiaogui_read_pdf',
      'xiaogui_work_docx',
      'xiaogui_work_docx_advanced_generation',
      'xiaogui_work_docx_template_intake',
      'xiaogui_work_docx_template_materialize',
      'xiaogui_work_read_materials',
      'xiaogui_work_report_docx',
    ])
    expect(result.productPrompt.length).toBeLessThanOrEqual(
      XIAOGUI_PRODUCT_PROMPT_MAX_CHARACTERS_V1,
    )
    expect(result.productPrompt).not.toMatch(/[A-Za-z]:[\\/]|\\\\|api[_-]?key|token\s*[:=]/i)
  })
})
