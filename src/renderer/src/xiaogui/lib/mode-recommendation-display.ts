import type { ModeRecommendationV1 } from '@shared/xiaogui-mode-recommendation'
import type { SessionChromePhase } from '@renderer/lib/session-chrome'

export interface ModeRecommendationDisplayInputV1 {
  readonly enabled: boolean
  readonly recommendation: ModeRecommendationV1 | null
  readonly sessionPhase: SessionChromePhase
  readonly canPreserveDraft: boolean
  readonly draftFingerprint: string
  readonly dismissedDraftFingerprint: string | null
}

export function modeRecommendationDraftFingerprint(
  text: string,
  attachmentNames: readonly string[],
): string {
  const source = JSON.stringify([text.replace(/\r\n?/g, '\n'), [...attachmentNames].sort()])
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `draft-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function shouldShowModeRecommendationV1(
  input: ModeRecommendationDisplayInputV1,
): boolean {
  if (!input.enabled || !input.recommendation || !input.canPreserveDraft) return false
  if (input.recommendation.currentMode === input.recommendation.recommendedMode) return false
  if (input.sessionPhase !== 'idle' && input.sessionPhase !== 'failed') return false
  return input.dismissedDraftFingerprint !== input.draftFingerprint
}
