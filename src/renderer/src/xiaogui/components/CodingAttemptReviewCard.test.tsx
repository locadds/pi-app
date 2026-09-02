import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1 } from '@shared/xiaogui-coding-extension-control'

import { useCodingAttemptStore } from '../stores/coding-attempt-store'
import { CodingAttemptReviewCard } from './CodingAttemptReviewCard'

const loadReview = vi.fn().mockResolvedValue(true)
const review = {
  contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
  bundle: {
    schemaVersion: 1 as const,
    attemptId: 'xhba_private_1',
    changeSetDigest: `sha256:${'a'.repeat(64)}`,
    changedRelativePaths: ['src/login.tsx', 'src/login.test.tsx'],
    verifications: [
      {
        label: '组件测试',
        commandDigest: `sha256:${'b'.repeat(64)}`,
        exitCode: 0,
        status: 'PASSED' as const,
      },
      {
        label: '界面冒烟',
        commandDigest: `sha256:${'c'.repeat(64)}`,
        exitCode: null,
        status: 'UNKNOWN' as const,
      },
    ],
    unresolvedIssues: ['尚未完成窄屏检查'],
  },
  unifiedDiff: '--- a/src/login.tsx\n+++ b/src/login.tsx\n@@ -1 +1 @@\n-old\n+new',
  unifiedDiffDigest: `sha256:${'d'.repeat(64)}`,
}

describe('CodingAttemptReviewCard', () => {
  beforeEach(() => {
    loadReview.mockClear()
    useCodingAttemptStore.setState({
      reviewsByAttempt: {},
      reviewErrorsByAttempt: {},
      loadingReviewAttemptIds: [],
      loadReview,
    })
  })
  afterEach(cleanup)

  it('按需通过审阅入口读取真实修改', async () => {
    const user = userEvent.setup()
    render(<CodingAttemptReviewCard attemptId="xhba_private_1" available />)
    await user.click(screen.getByRole('button', { name: '查看真实修改' }))
    expect(loadReview).toHaveBeenCalledWith('xhba_private_1')
  })

  it('只显示相对文件、验证状态/退出码、问题和 Diff，不显示命令或内部摘要', async () => {
    const user = userEvent.setup()
    useCodingAttemptStore.setState({ reviewsByAttempt: { xhba_private_1: review } })
    const { container } = render(<CodingAttemptReviewCard attemptId="xhba_private_1" available />)
    expect(screen.getByText('src/login.tsx')).toBeVisible()
    expect(screen.getByText('组件测试')).toBeVisible()
    expect(screen.getByText('通过 · 退出码 0')).toBeVisible()
    expect(screen.getByText('结果未知')).toBeVisible()
    expect(screen.getByText('尚未完成窄屏检查')).toBeVisible()
    await user.click(screen.getByText('查看 Diff'))
    expect(screen.getByText(/--- a\/src\/login\.tsx/)).toBeVisible()
    expect(container.textContent).not.toContain('xhba_private_1')
    expect(container.textContent).not.toContain('commandDigest')
    expect(container.textContent).not.toContain('sha256:')
  })

  it('审阅不可用时只显示可重试的安全文案', async () => {
    const user = userEvent.setup()
    useCodingAttemptStore.setState({
      reviewErrorsByAttempt: {
        xhba_private_1: { code: 'REVIEW_UNAVAILABLE', messageKey: 'xiaogui.coding.extension.review_unavailable' },
      },
    })
    render(<CodingAttemptReviewCard attemptId="xhba_private_1" available />)
    expect(screen.getByText('暂时无法读取真实修改与验证，请稍后重试。')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '重试读取审阅' }))
    expect(loadReview).toHaveBeenCalledWith('xhba_private_1')
  })

  it('执行前不渲染审阅入口', () => {
    const { container } = render(<CodingAttemptReviewCard attemptId="xhba_private_1" available={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
