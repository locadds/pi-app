import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RightPanelTabs } from './right-panel-tabs'

let originalScrollIntoView: typeof Element.prototype.scrollIntoView | undefined
let scrollIntoView: ReturnType<typeof vi.fn>

beforeEach(() => {
  originalScrollIntoView = Element.prototype.scrollIntoView
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView
})

afterEach(() => {
  cleanup()
  if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView
  else delete (Element.prototype as Partial<Element>).scrollIntoView
})

describe('RightPanelTabs', () => {
  it('将当前激活标签滚入横向可视区，并在切换后跟随新标签', async () => {
    const panels = [
      { key: 'review', label: '审查' },
      { key: 'run', label: '运行' },
      { key: 'context', label: '上下文' },
      { key: 'tree', label: '树' },
      { key: 'files', label: '文件' },
      { key: 'collaboration', label: '协作' },
    ]
    const { rerender } = render(
      <RightPanelTabs panels={panels} activePanel="files" setActivePanel={vi.fn()} />,
    )

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('tab', { name: '文件' }))
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' })

    rerender(<RightPanelTabs panels={panels} activePanel="collaboration" setActivePanel={vi.fn()} />)

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2))
    expect(scrollIntoView.mock.contexts[1]).toBe(screen.getByRole('tab', { name: '协作' }))
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' })
  })

  it('active key 不变但标签列表延迟恢复时仍滚入新出现的标签', async () => {
    const initialPanels = [{ key: 'files', label: '文件' }]
    const restoredPanels = [...initialPanels, { key: 'collaboration', label: '协作' }]
    const { rerender } = render(
      <RightPanelTabs panels={initialPanels} activePanel="collaboration" setActivePanel={vi.fn()} />,
    )
    expect(scrollIntoView).not.toHaveBeenCalled()

    rerender(
      <RightPanelTabs panels={restoredPanels} activePanel="collaboration" setActivePanel={vi.fn()} />,
    )

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('tab', { name: '协作' }))
  })
})
