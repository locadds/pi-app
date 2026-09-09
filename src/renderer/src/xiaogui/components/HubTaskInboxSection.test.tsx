import { cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke },
}))

import { HubTaskInboxSection } from './HubTaskInboxSection'
import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'

afterEach(cleanup)

describe('HubTaskInboxSection', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue({ ok: true, value: { configured: true, state: 'READY' } })
  })

  it('uses Main openedAt after same-instance re-login and requires another manual open', async () => {
    const user = userEvent.setup()
    let openedAt: string | null = null
    let opens = 0
    const item = () => ({ assignmentId: 'assignment', title: 'task', taskContent: 'content', mode: 'DIRECT',
      decisionState: 'ACCEPTED', executionState: 'NOT_STARTED', openedAt, receiptPendingSync: false, localPlanDraftCreated: false })
    invoke.mockImplementation(async method => {
      if (method === 'xiaogui.hubTask.inbox.list') return { ok: true, value: [item()] }
      if (method === 'xiaogui.hubTask.inbox.open') { opens++; openedAt = '2026-09-09T00:00:00.000Z'; return { ok: true, value: item() } }
      if (method === 'xiaogui.hubTask.connect') openedAt = null
      return { ok: true, value: { configured: true, state: 'READY' } }
    })
    render(<HubTaskInboxSection address={{ projectId: `xgp1_${'a'.repeat(64)}`, sessionKey: `xgs1_${'b'.repeat(64)}` } as HubAddressV1} />)
    await user.click(await screen.findByRole('button', { name: '打开任务' }))
    await screen.findByRole('button', { name: '生成本机计划草稿' })
    expect(opens).toBe(1)
    await user.click(screen.getByRole('button', { name: '重新登录并配对此小规' }))
    await user.type(screen.getByPlaceholderText('http://hub.intranet:3000'), 'http://hub.example')
    await user.type(screen.getByPlaceholderText('Hub 用户名'), 'alice')
    await user.type(screen.getByPlaceholderText('密码'), 'test-password')
    await user.click(screen.getByRole('button', { name: '登录并配对此小规' }))
    await user.click(await screen.findByRole('button', { name: '同步' }))
    const openAgain = await screen.findByRole('button', { name: '打开任务' })
    expect(openAgain).toBeEnabled()
    expect(opens).toBe(1)
    await user.click(openAgain)
    await screen.findByRole('button', { name: '生成本机计划草稿' })
    expect(opens).toBe(2)
  })

  it('requires an explicit configured-account re-login before connecting, and keeps the form available after failure', async () => {
    const user = userEvent.setup()
    render(<HubTaskInboxSection />)

    await screen.findByText('可收取任务')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenLastCalledWith('xiaogui.hubTask.status', undefined)
    expect(screen.queryByPlaceholderText('Hub 用户名')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重新登录并配对此小规' }))
    expect(screen.getByPlaceholderText('Hub 用户名')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledTimes(1)

    await user.type(screen.getByPlaceholderText('http://hub.intranet:3000'), 'http://hub.example')
    await user.type(screen.getByPlaceholderText('Hub 用户名'), 'alice')
    await user.type(screen.getByPlaceholderText('密码'), 'test-password')
    invoke.mockResolvedValueOnce({ ok: false, code: 'HUB_WORKER_AUTHENTICATION_FAILED' })

    await user.click(screen.getByRole('button', { name: '登录并配对此小规' }))
    await screen.findByRole('alert')
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith('xiaogui.hubTask.connect', {
      endpoint: 'http://hub.example', username: 'alice', password: 'test-password',
    })

    invoke.mockResolvedValueOnce({ ok: true, value: { configured: true, state: 'READY' } })
    await user.click(screen.getByRole('button', { name: '登录并配对此小规' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3))
    expect(invoke).toHaveBeenLastCalledWith('xiaogui.hubTask.connect', {
      endpoint: 'http://hub.example', username: 'alice', password: 'test-password',
    })
    await screen.findByRole('button', { name: '重新登录并配对此小规' })
    expect(screen.queryByPlaceholderText('密码')).not.toBeInTheDocument()
  })

  it('keeps the credential form available for an unconfigured account', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: { configured: false, state: 'UNCONFIGURED' } })
    render(<HubTaskInboxSection />)

    expect(await screen.findByPlaceholderText('Hub 用户名')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新登录并配对此小规' })).not.toBeInTheDocument()
  })
})
