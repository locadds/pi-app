import { afterEach, describe, expect, it, vi } from 'vitest'

import { onComposerQuickSubmit, submitComposerPrompt } from './composer-quick-submit'

describe('composer quick submit channel', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup())
  })

  it('delivers a trimmed prompt once and never emits an empty request', () => {
    const listener = vi.fn()
    cleanups.push(onComposerQuickSubmit(listener))

    submitComposerPrompt('  开始整理文档  ')
    submitComposerPrompt('   ')

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith('开始整理文档')
  })
})
