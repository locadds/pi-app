import type { XiaoguiMode } from '@shared/xiaogui-prompt-contract'

import type { Segment } from './attachments'
import { rememberTransientComposerDraft } from './composer-transient-draft'

export function canPreserveComposerSegments(segments: readonly Segment[]): boolean {
  return segments.every((segment) => {
    if (segment.type === 'text') return true
    if (segment.type === 'clipboard-image') {
      return segment.path.trim().length > 0 && segment.name.trim().length > 0
    }
    return (
      segment.attachment.path.trim().length > 0 &&
      segment.attachment.name.trim().length > 0
    )
  })
}

export async function switchModePreservingComposerDraftV1(input: {
  readonly targetMode: XiaoguiMode
  readonly segments: readonly Segment[]
  readonly switchMode: (mode: XiaoguiMode) => Promise<boolean>
  readonly getTargetDraftContextKey: () => string
  readonly restoreSegments: (segments: Segment[]) => void
}): Promise<boolean> {
  if (!canPreserveComposerSegments(input.segments)) return false

  const preservedSegments = input.segments.map((segment): Segment => {
    if (segment.type === 'file') {
      return { ...segment, attachment: { ...segment.attachment } }
    }
    return { ...segment }
  })
  const switchPromise = input.switchMode(input.targetMode)
  rememberTransientComposerDraft(input.getTargetDraftContextKey(), preservedSegments)
  let switched = false
  try {
    switched = await switchPromise
  } finally {
    input.restoreSegments(preservedSegments)
  }
  return switched
}
