import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodingPlanProjectionV1 } from '@shared/xiaogui-coding-extension-pack'

import { useCodingAttemptStore } from '../stores/coding-attempt-store'
import { CodingAttemptPlanCard } from './CodingAttemptPlanCard'

function projection(state: CodingPlanProjectionV1['state'] = 'AWAITING_APPROVAL'): CodingPlanProjectionV1 {
  return {
    schemaVersion: 1,
    attemptId: 'xhba_private_1',
    source: 'PI_DRAFT',
    state,
    plan: {
      schemaVersion: 1,
      planId: 'xhbplan_private_1',
      attemptId: 'xhba_private_1',
      objective: '实现登录页',
      steps: [
        { stepId: 's1', title: '修改表单', validation: '组件测试通过', status: 'PENDING' },
        { stepId: 's2', title: '检查样式', validation: '截图无错位', status: 'IN_PROGRESS' },
      ],
      constraints: ['只修改前端文件'],
      revision: 1,
    },
    planDigest: `sha256:${'d'.repeat(64)}`,
  }
}

describe('CodingAttemptPlanCard', () => {
  const revisePlan = vi.fn().mockResolvedValue(true)
  const approveAndStart = vi.fn().mockResolvedValue(true)
  const resumeExecution = vi.fn().mockResolvedValue(true)

  beforeEach(() => {
    revisePlan.mockClear()
    approveAndStart.mockClear()
    resumeExecution.mockClear()
    useCodingAttemptStore.setState({
      plansByAttempt: { xhba_private_1: projection() },
      planErrorsByAttempt: {},
      resumeRequiredByAttempt: {},
      submittingAttemptIds: [],
      revisePlan,
      approveAndStart,
      resumeExecution,
    })
  })

  afterEach(cleanup)

  it('展示目标、Todo、验证和约束，但不展示内部编号或摘要', () => {
    const { container } = render(<CodingAttemptPlanCard attemptId="xhba_private_1" />)
    expect(screen.getByText('执行计划')).toBeVisible()
    expect(screen.getByText('实现登录页')).toBeVisible()
    expect(screen.getByText(/修改表单/)).toBeVisible()
    expect(screen.getByText('待开始')).toBeVisible()
    expect(screen.getByText('进行中')).toBeVisible()
    expect(screen.getByText(/组件测试通过/)).toBeVisible()
    expect(screen.getByText('只修改前端文件')).toBeVisible()
    expect(container.textContent).not.toContain('xhba_private_1')
    expect(container.textContent).not.toContain('sha256:')
  })

  it('允许编辑目标、步骤标题和验证后提交新 revision', async () => {
    const user = userEvent.setup()
    render(<CodingAttemptPlanCard attemptId="xhba_private_1" />)
    await user.click(screen.getByRole('button', { name: '修改计划' }))
    await user.clear(screen.getByLabelText('计划目标'))
    await user.type(screen.getByLabelText('计划目标'), '优化登录页')
    await user.clear(screen.getByLabelText('第 1 步标题'))
    await user.type(screen.getByLabelText('第 1 步标题'), '更新表单')
    await user.clear(screen.getByLabelText('第 1 步验证方法'))
    await user.type(screen.getByLabelText('第 1 步验证方法'), '运行组件测试')
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    expect(revisePlan).toHaveBeenCalledWith('xhba_private_1', {
      objective: '优化登录页',
      steps: [
        { stepId: 's1', title: '更新表单', validation: '运行组件测试' },
        { stepId: 's2', title: '检查样式', validation: '截图无错位' },
      ],
      constraints: ['只修改前端文件'],
    })
  })

  it('待批准时直接批准并开始；批准落库但启动失败时显示继续执行', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<CodingAttemptPlanCard attemptId="xhba_private_1" />)
    await user.click(screen.getByRole('button', { name: '批准并开始执行' }))
    expect(approveAndStart).toHaveBeenCalledWith('xhba_private_1')

    useCodingAttemptStore.setState({
      plansByAttempt: { xhba_private_1: projection('APPROVED') },
      resumeRequiredByAttempt: { xhba_private_1: true },
      planErrorsByAttempt: {
        xhba_private_1: {
          code: 'EXECUTION_RESUME_FAILED',
          messageKey: 'xiaogui.coding.extension.execution_resume_failed',
        },
      },
    })
    rerender(<CodingAttemptPlanCard attemptId="xhba_private_1" />)
    expect(screen.getByText('计划已批准，但执行尚未开始。')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '继续执行' }))
    expect(resumeExecution).toHaveBeenCalledWith('xhba_private_1')
  })
})
