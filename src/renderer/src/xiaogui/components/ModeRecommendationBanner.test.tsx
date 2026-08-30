import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModeRecommendationV1 } from '@shared/xiaogui-mode-recommendation'

import { ModeRecommendationBanner } from './ModeRecommendationBanner'

const recommendation: ModeRecommendationV1 = {
  schemaVersion: 1,
  currentMode: 'WORK',
  recommendedMode: 'CODING',
  confidence: 'HIGH',
  reasonCode: 'CODE_REPOSITORY_TASK',
  reasonText: '检测到代码维护、仓库或测试构建等组合信号。',
  matchedSignals: ['CODE_CHANGE', 'REPOSITORY_WORKFLOW', 'TEST_BUILD'],
}

afterEach(cleanup)

describe('ModeRecommendationBanner', () => {
  it('offers only preserve-and-switch or dismiss in the current mode', async () => {
    const user = userEvent.setup()
    const onSwitch = vi.fn()
    const onDismiss = vi.fn()
    render(
      <ModeRecommendationBanner
        recommendation={recommendation}
        switching={false}
        onSwitch={onSwitch}
        onDismiss={onDismiss}
      />,
    )

    expect(screen.getByText(/这项任务更适合「编程」模式/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '切换并保留输入' }))
    expect(onSwitch).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: '仍在工作模式（忽略）' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
