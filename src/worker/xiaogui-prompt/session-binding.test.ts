import { describe, expect, it } from 'vitest'

import {
  decideXiaoguiPromptContextTransitionV1,
  freezeXiaoguiPromptContextV1,
} from './session-binding'

const context = (phase: 'ASK' | 'PLAN' | 'EXECUTE', sessionKey = 'xgs1_one') =>
  freezeXiaoguiPromptContextV1({
    schemaVersion: 1,
    mode: 'WORK',
    phase,
    workspaceAvailable: true,
    projectTrusted: true,
    enabledCapabilities: ['work.file-organize'],
    availableToolNames: ['read'],
    sessionKey,
    projectId: 'xgp1_project',
  })

describe('Worker Session Prompt Context binding', () => {
  it('reuses an identical immutable Context and rebuilds an idle changed Context', () => {
    const current = context('ASK')
    expect(decideXiaoguiPromptContextTransitionV1({
      current,
      next: context('ASK'),
      sameSession: true,
      busy: false,
    }).kind).toBe('REUSE')
    expect(decideXiaoguiPromptContextTransitionV1({
      current,
      next: context('PLAN'),
      sameSession: true,
      busy: false,
    }).kind).toBe('REBUILD')
    expect(Object.isFrozen(current)).toBe(true)
    expect(Object.isFrozen(current.enabledCapabilities)).toBe(true)
  })

  it('rejects Context changes during a running Turn', () => {
    expect(() => decideXiaoguiPromptContextTransitionV1({
      current: context('ASK'),
      next: context('EXECUTE'),
      sameSession: true,
      busy: true,
    })).toThrow('XIAOGUI_PROMPT_CONTEXT_TURN_ACTIVE')
  })

  it('rejects an opaque Session identity mismatch instead of silently rebinding', () => {
    expect(() => decideXiaoguiPromptContextTransitionV1({
      current: context('ASK', 'xgs1_one'),
      next: context('ASK', 'xgs1_two'),
      sameSession: true,
      busy: false,
    })).toThrow('XIAOGUI_PROMPT_CONTEXT_SESSION_MISMATCH')
    expect(() => decideXiaoguiPromptContextTransitionV1({
      current: context('ASK', 'xgs1_one'),
      next: context('ASK', 'xgs1_one'),
      sameSession: false,
      busy: false,
    })).toThrow('XIAOGUI_PROMPT_CONTEXT_SESSION_MISMATCH')
  })
})
