import { describe, expect, it } from 'vitest'

import type { ModeRecommendationV1 } from '@shared/xiaogui-mode-recommendation'

import {
  modeRecommendationDraftFingerprint,
  shouldShowModeRecommendationV1,
} from './mode-recommendation-display'

const recommendation: ModeRecommendationV1 = {
  schemaVersion: 1,
  currentMode: 'WORK',
  recommendedMode: 'CODING',
  confidence: 'HIGH',
  reasonCode: 'CODE_REPOSITORY_TASK',
  reasonText: '检测到代码维护、仓库或测试构建等组合信号。',
  matchedSignals: ['CODE_CHANGE', 'TEST_BUILD'],
}

describe('shouldShowModeRecommendationV1', () => {
  const draftFingerprint = modeRecommendationDraftFingerprint('修复仓库报错并补测试', ['app.ts'])

  it('shows only for an idle, preservable, undismissed draft with the feature enabled', () => {
    expect(
      shouldShowModeRecommendationV1({
        enabled: true,
        recommendation,
        sessionPhase: 'idle',
        canPreserveDraft: true,
        draftFingerprint,
        dismissedDraftFingerprint: null,
      }),
    ).toBe(true)
  })

  it.each(['streaming', 'tool', 'waiting_ui'] as const)(
    'stays hidden while the session phase is %s',
    (sessionPhase) => {
      expect(
        shouldShowModeRecommendationV1({
          enabled: true,
          recommendation,
          sessionPhase,
          canPreserveDraft: true,
          draftFingerprint,
          dismissedDraftFingerprint: null,
        }),
      ).toBe(false)
    },
  )

  it('stays hidden when attachments cannot be preserved or the same draft was dismissed', () => {
    expect(
      shouldShowModeRecommendationV1({
        enabled: true,
        recommendation,
        sessionPhase: 'idle',
        canPreserveDraft: false,
        draftFingerprint,
        dismissedDraftFingerprint: null,
      }),
    ).toBe(false)
    expect(
      shouldShowModeRecommendationV1({
        enabled: true,
        recommendation,
        sessionPhase: 'idle',
        canPreserveDraft: true,
        draftFingerprint,
        dismissedDraftFingerprint: draftFingerprint,
      }),
    ).toBe(false)
  })

  it('stays hidden when the local feature flag is disabled', () => {
    expect(
      shouldShowModeRecommendationV1({
        enabled: false,
        recommendation,
        sessionPhase: 'idle',
        canPreserveDraft: true,
        draftFingerprint,
        dismissedDraftFingerprint: null,
      }),
    ).toBe(false)
  })
})
