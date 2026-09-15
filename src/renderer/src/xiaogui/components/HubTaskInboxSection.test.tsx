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

  it('uses the projected V2 binding for repeat clicks and never presents association recovery as success', async () => {
    const user = userEvent.setup()
    const requests: unknown[] = []
    let callCount = 0
    const address = { projectId: `xgp1_${'a'.repeat(64)}`, sessionKey: `xgs1_${'b'.repeat(64)}` } as HubAddressV1
    const packageSha256 = `sha256:${'c'.repeat(64)}`
    const item = () => ({
      assignmentId: 'assignment-v2',
      title: 'V2 task',
      taskContent: 'trusted task body',
      mode: 'DIRECT' as const,
      decisionState: 'ACCEPTED' as const,
      executionState: 'NOT_STARTED' as const,
      openedAt: '2026-09-15T00:00:00.000Z',
      receiptPendingSync: false,
      localPlanDraftCreated: false,
      acceptAndExecuteV2: {
        state: 'AVAILABLE' as const,
        requestId: 'stable-request-v2',
        observedPackageSha256: packageSha256,
        phase: null,
      },
    })
    invoke.mockImplementation(async (method, request) => {
      if (method === 'xiaogui.hubTask.status') return { ok: true, value: { configured: true, state: 'READY' } }
      if (method === 'xiaogui.hubTask.inbox.list') return { ok: true, value: [item()] }
      if (method === 'xiaogui.hubTask.refresh') return { ok: true, value: { configured: true, state: 'READY' } }
      if (method === 'xiaogui.hubTask.inbox.acceptAndExecute') {
        requests.push(request)
        callCount += 1
        return {
          ok: true,
          value: callCount === 1
            ? { executionState: 'PREPARED', actualAttemptStatus: 'STARTING', flowId: 'flow-v2', revisionId: 'revision-v2' }
            : { executionState: 'ASSOCIATION_RECOVERED', actualAttemptStatus: 'RUNNING', flowId: 'flow-v2', revisionId: 'revision-v2' },
        }
      }
      return { ok: true, value: item() }
    })

    render(<HubTaskInboxSection address={address} targetProjectLabel="示例项目" targetProjectPath="D:/Projects/示例项目" />)
    await user.click(await screen.findByRole('button', { name: '接受并执行' }))
    await screen.findByText('任务已接受，执行已准备。')
    expect(requests[0]).toEqual({
      assignmentId: 'assignment-v2',
      address,
      observedPackageSha256: packageSha256,
      requestId: 'stable-request-v2',
    })
    expect(screen.getByText('目标项目：示例项目')).toBeInTheDocument()
    expect(screen.getByTitle('D:/Projects/示例项目')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '接受并执行' }))
    await screen.findByText('原执行关联已恢复；当前尝试状态：RUNNING。')
    expect(requests[1]).toEqual(requests[0])
    expect(screen.queryByText('任务已接受并开始执行。')).not.toBeInTheDocument()
  })

  it.each([
    ['RUNNING', '执行中'],
    ['FAILED', '执行失败'],
  ] as const)('recovers a BOUND assignment with the original requestId when Hub is %s', async (executionState, executionText) => {
    const user = userEvent.setup()
    const address = { projectId: `xgp1_${'d'.repeat(64)}`, sessionKey: `xgs1_${'e'.repeat(64)}` } as HubAddressV1
    const packageSha256 = `sha256:${'f'.repeat(64)}`
    const requests: unknown[] = []
    let listCalls = 0
    const item = () => ({
      assignmentId: 'assignment-recovery',
      title: 'recovery task',
      taskContent: 'trusted body',
      mode: 'DIRECT' as const,
      decisionState: 'ACCEPTED' as const,
      executionState: executionState as 'RUNNING' | 'FAILED',
      openedAt: '2026-09-15T00:00:00.000Z',
      receiptPendingSync: false,
      localPlanDraftCreated: false,
      acceptAndExecuteV2: {
        state: 'BOUND' as const,
        requestId: 'original-request-id',
        observedPackageSha256: packageSha256,
        phase: 'HUB_ACCEPTED' as const,
        projectId: address.projectId,
        sessionKey: address.sessionKey,
      },
    })
    invoke.mockImplementation(async (method, request) => {
      if (method === 'xiaogui.hubTask.status') return { ok: true, value: { configured: true, state: 'READY' } }
      if (method === 'xiaogui.hubTask.inbox.list') {
        listCalls += 1
        return { ok: true, value: [item()] }
      }
      if (method === 'xiaogui.hubTask.inbox.acceptAndExecute') {
        requests.push(request)
        return { ok: false, code: 'HUB_EXECUTION_OUTCOME_UNKNOWN' }
      }
      return { ok: true, value: { configured: true, state: 'READY' } }
    })

    render(<HubTaskInboxSection address={address} />)
    expect(await screen.findByRole('button', { name: '恢复执行记录' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '接受并执行' })).not.toBeInTheDocument()
    expect(screen.getByText(`执行记录待恢复；当前任务状态：${executionText}。`)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '恢复执行记录' }))
    await screen.findByRole('alert')
    await waitFor(() => expect(listCalls).toBe(2))
    expect(requests).toEqual([{
      assignmentId: 'assignment-recovery',
      address,
      observedPackageSha256: packageSha256,
      requestId: 'original-request-id',
    }])
    expect(screen.queryByText('任务已接受并开始执行。')).not.toBeInTheDocument()
  })
})
