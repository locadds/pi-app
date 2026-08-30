import { describe, expect, it } from 'vitest'

import {
  XIAOGUI_CAPABILITY_IDS_V1,
  type XiaoguiPromptContextV1,
} from './xiaogui-prompt-contract'
import {
  resolveEffectiveXiaoguiCapabilitiesV1,
  workerBuiltinToolNamesForModeV1,
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

  it('keeps the Word confirmation gates in the single Tool Definition registry', () => {
    const report = XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1.xiaogui_work_report_docx
    const template = XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1.xiaogui_work_docx

    expect(report.promptGuidelines.join('\n')).toContain('下一条消息明确确认')
    expect(report.promptGuidelines.join('\n')).toContain('不得声称覆盖或修改了已有文件')
    expect(template.promptGuidelines.join('\n')).toContain('不得同一轮调用 CONFIRM')
    expect(template.promptGuidelines.join('\n')).toContain('不能猜测')
  })
})
