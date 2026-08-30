import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Segment } from './attachments'
import {
  canPreserveComposerSegments,
  switchModePreservingComposerDraftV1,
} from './mode-recommendation-draft'
import {
  clearTransientComposerDraft,
  readTransientComposerDraft,
} from './composer-transient-draft'

const richDraft: Segment[] = [
  { type: 'text', text: '请修复这个文件并补测试 ' },
  {
    type: 'file',
    attachment: {
      path: 'C:/workspace/src/app.ts',
      name: 'app.ts',
      kind: 'code',
      chipId: 'mode-recommendation-file',
    },
  },
]

afterEach(() => {
  clearTransientComposerDraft('workspace:C:/workspace')
})

describe('mode recommendation draft preservation', () => {
  it('waits for switchMode, preserves rich input, and never sends it', async () => {
    let finishSwitch!: (switched: boolean) => void
    const switchPromise = new Promise<boolean>((resolve) => {
      finishSwitch = resolve
    })
    const switchMode = vi.fn(() => switchPromise)
    const restoreSegments = vi.fn()

    const resultPromise = switchModePreservingComposerDraftV1({
      targetMode: 'CODING',
      segments: richDraft,
      switchMode,
      getTargetDraftContextKey: () => 'workspace:C:/workspace',
      restoreSegments,
    })

    expect(switchMode).toHaveBeenCalledOnce()
    expect(switchMode).toHaveBeenCalledWith('CODING')
    expect(readTransientComposerDraft('workspace:C:/workspace')).toEqual(richDraft)
    expect(restoreSegments).not.toHaveBeenCalled()

    finishSwitch(true)
    await expect(resultPromise).resolves.toBe(true)
    expect(restoreSegments).toHaveBeenCalledOnce()
    expect(restoreSegments).toHaveBeenCalledWith(richDraft)
  })

  it('blocks switching when an attachment cannot be preserved', async () => {
    const segments: Segment[] = [
      { type: 'text', text: 'draft' },
      { type: 'file', attachment: { path: '', name: 'pending.ts', kind: 'code' } },
    ]
    const switchMode = vi.fn(async () => true)

    expect(canPreserveComposerSegments(segments)).toBe(false)
    await expect(
      switchModePreservingComposerDraftV1({
        targetMode: 'CODING',
        segments,
        switchMode,
        getTargetDraftContextKey: () => 'workspace:C:/workspace',
        restoreSegments: vi.fn(),
      }),
    ).resolves.toBe(false)
    expect(switchMode).not.toHaveBeenCalled()
  })

  it('returns false but still restores the rich draft when switchMode fails', async () => {
    const restoreSegments = vi.fn()

    await expect(
      switchModePreservingComposerDraftV1({
        targetMode: 'CODING',
        segments: richDraft,
        switchMode: vi.fn(async () => false),
        getTargetDraftContextKey: () => 'workspace:C:/workspace',
        restoreSegments,
      }),
    ).resolves.toBe(false)

    expect(restoreSegments).toHaveBeenCalledOnce()
    expect(restoreSegments).toHaveBeenCalledWith(richDraft)
  })
})
