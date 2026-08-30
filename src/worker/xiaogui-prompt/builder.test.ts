import { describe, expect, it } from 'vitest'

import type { XiaoguiPromptLayerV1 } from '@shared/xiaogui-prompt-contract'
import {
  createXiaoguiPromptBuilderV1,
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
  availableToolNames: ['read', 'xiaogui_read_pdf'],
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
    ])
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
      generatedAt: '2026-08-30T00:00:00.000Z',
    })
    const second = builder.build({
      context: { ...context(), enabledCapabilities: [] },
      piSystemPrompt: 'PI\nBASELINE',
      generatedAt: '2026-08-31T00:00:00.000Z',
    })

    expect(first.prompt).toBe([
      'PI\nBASELINE',
      '<!-- XIAOGUI:PRODUCT:BEGIN -->\nBASE\n\nMODE\n\nPHASE\n<!-- XIAOGUI:PRODUCT:END -->',
    ].join('\n\n'))
    expect(first.diagnostics.manifest.completePromptCharacterCount).toBe(first.prompt.length)
    expect(first.diagnostics.manifest.completePromptSha256)
      .toBe('7cdfcf900502c06ca507cfe405a1cd1b47d25ec2924774cdbf2e773ce4d79d60')
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
      ],
      generatedAt: '2026-08-30T00:00:00.000Z',
    })
    const defaultHarness = xiaoguiPromptBuilderV1.build({
      context: context(),
      piSystemPrompt: 'PI harness already contains current guidelines',
      piCustomSystem: false,
      runtimeTools: [
        { name: 'read', promptSnippet: '读取文件', promptGuidelines: ['只读所需内容'] },
      ],
      generatedAt: '2026-08-30T00:00:00.000Z',
    })

    expect(custom.prompt).toContain('USER SYSTEM')
    expect(custom.prompt).toContain('<project_context>project facts</project_context>')
    expect(custom.prompt).toContain('read: 读取文件')
    expect(custom.prompt).toContain('- 不让用户输入路径')
    expect(custom.diagnostics.manifest.layers.map((layer) => layer.id))
      .toContain('pi.custom-system-tool-guidelines')
    expect(defaultHarness.prompt).not.toContain('read: 读取文件')
    expect(defaultHarness.diagnostics.manifest.layers.map((layer) => layer.id))
      .not.toContain('pi.custom-system-tool-guidelines')
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
    const reportAsk = xiaoguiPromptBuilderV1.build({
      context: reportContext,
      piSystemPrompt: 'PI',
      runtimeTools: [{ name: 'xiaogui_work_report_docx' }],
    })
    const reportExecute = xiaoguiPromptBuilderV1.build({
      context: { ...reportContext, phase: 'EXECUTE' as const },
      piSystemPrompt: 'PI',
      runtimeTools: [{ name: 'xiaogui_work_report_docx' }],
    })

    expect(designWithoutProfessionalTools.diagnostics.manifest.capabilityIds).toEqual([])
    expect(designWithProfessionalTool.diagnostics.manifest.capabilityIds)
      .toEqual(['design.analysis'])
    expect(reportAsk.diagnostics.manifest.capabilityIds).toEqual([])
    expect(reportExecute.diagnostics.manifest.capabilityIds).toEqual(['work.report-docx'])
    expect(() => xiaoguiPromptBuilderV1.build({
      context: { ...context('WORK', 'ASK'), enabledCapabilities: ['design.analysis'] },
      piSystemPrompt: 'PI',
      runtimeTools: [{ name: 'design_gis' }],
    })).toThrow('XIAOGUI_PROMPT_TOOL_MODE_MISMATCH')
  })
})
