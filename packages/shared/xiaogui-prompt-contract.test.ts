import { describe, expect, it } from 'vitest'

import {
  assertStaticXiaoguiPromptLayerV1,
  parseXiaoguiPromptContextV1,
  XIAOGUI_CAPABILITY_IDS_V1,
  XIAOGUI_PROMPT_CONTRACT_ID_V1,
  XIAOGUI_PROMPT_CONTRACT_VERSION_V1,
  XIAOGUI_PROMPT_MODES_V1,
  XIAOGUI_PROMPT_PHASES_V1,
} from './xiaogui-prompt-contract'

const validContext = () => ({
  schemaVersion: 1,
  mode: 'WORK',
  phase: 'ASK',
  workspaceAvailable: true,
  projectTrusted: true,
  enabledCapabilities: ['work.file-organize'],
  availableToolNames: ['read', 'xiaogui_read_pdf'],
  sessionKey: 'session-01',
  projectId: 'project-01',
})

describe('Xiaogui Prompt Contract V1', () => {
  it('is explicitly versioned and has no AUTO mode', () => {
    expect(XIAOGUI_PROMPT_CONTRACT_ID_V1).toBe('xiaogui.prompt-contract.v1')
    expect(XIAOGUI_PROMPT_CONTRACT_VERSION_V1).toBe('1.0.0')
    expect(XIAOGUI_PROMPT_MODES_V1).toEqual(['WORK', 'DESIGN', 'CODING'])
    expect(XIAOGUI_PROMPT_PHASES_V1).toEqual(['ASK', 'PLAN', 'EXECUTE'])
    expect(XIAOGUI_CAPABILITY_IDS_V1).toHaveLength(7)
  })

  it('accepts only selection facts and opaque identifiers', () => {
    expect(parseXiaoguiPromptContextV1(validContext())).toEqual(validContext())
    expect(() => parseXiaoguiPromptContextV1({
      ...validContext(),
      promptBody: 'dynamic project text',
    })).toThrow('XIAOGUI_PROMPT_CONTEXT_UNKNOWN_FIELD')
    expect(() => parseXiaoguiPromptContextV1({
      ...validContext(),
      projectId: 'C:\\projects\\secret',
    })).toThrow('XIAOGUI_PROMPT_CONTEXT_IDENTIFIER_INVALID')
  })

  it('rejects unknown, duplicated or malformed selection values', () => {
    expect(() => parseXiaoguiPromptContextV1({ ...validContext(), mode: 'AUTO' }))
      .toThrow('XIAOGUI_PROMPT_CONTEXT_MODE_INVALID')
    expect(() => parseXiaoguiPromptContextV1({
      ...validContext(),
      enabledCapabilities: ['work.file-organize', 'work.file-organize'],
    })).toThrow('XIAOGUI_PROMPT_CONTEXT_CAPABILITIES_INVALID')
    expect(() => parseXiaoguiPromptContextV1({
      ...validContext(),
      availableToolNames: ['read', '../write'],
    })).toThrow('XIAOGUI_PROMPT_CONTEXT_TOOLS_INVALID')
  })

  it('allows static product layers and blocks paths, credentials and dynamic bodies', () => {
    expect(assertStaticXiaoguiPromptLayerV1({
      id: 'xiaogui.base',
      version: '1.0.0',
      kind: 'BASE',
      required: true,
      content: '只陈述实际发生并且可以验证的动作。',
    }).id).toBe('xiaogui.base')

    for (const content of [
      '读取 C:\\Users\\example\\project',
      '读取 /tmp',
      '读取 /srv/example/project',
      'api_key = sk-example',
      'token = opaque-example',
      '把 ${projectContent} 拼接到这里',
    ]) {
      expect(() => assertStaticXiaoguiPromptLayerV1({
        id: 'xiaogui.base',
        version: '1.0.0',
        kind: 'BASE',
        required: true,
        content,
      })).toThrow(/XIAOGUI_PROMPT_LAYER_.*_FORBIDDEN/)
    }
  })
})
