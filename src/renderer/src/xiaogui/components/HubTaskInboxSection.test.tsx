import { cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HubTaskInboxSection } from './HubTaskInboxSection'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}` as never,
  sessionKey: `xgs1_${'2'.repeat(64)}` as never,
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    assignmentId: 'xgh_assignment_1',
    title: '整理院内资料',
    taskContent: '先生成一份待批准的本机计划。',
    constraints: ['不自动执行'],
    acceptanceRequirements: ['人工批准计划后再执行'],
    attachmentCount: 1,
    mode: 'DIRECT',
    decisionState: 'PENDING',
    hubDeliveryState: 'QUEUED',
    executionState: 'NOT_STARTED',
    openedAt: null,
    receiptPendingSync: false,
    localPlanDraftCreated: false,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  delete window.piDesktop
})

describe('HubTaskInboxSection', () => {
  it('opens a received task, accepts it, and creates only a local plan draft', async () => {
    let opened = false
    let accepted = false
    const invoke = vi.fn(async (channel: string, request?: unknown) => {
      switch (channel) {
        case 'ipc:xiaogui.hubTask.status':
          return { ok: true, value: { configured: true, state: 'READY', lastSyncedAt: null, pendingReceiptCount: opened ? 2 : 1 } }
        case 'ipc:xiaogui.hubTask.inbox.list':
          return {
            ok: true,
            value: [item({
              openedAt: opened ? '2026-09-02T01:00:00.000Z' : null,
              receiptPendingSync: opened,
              decisionState: accepted ? 'ACCEPTED' : 'PENDING',
            })],
          }
        case 'ipc:xiaogui.hubTask.inbox.open':
          opened = true
          return { ok: true, value: item({ openedAt: '2026-09-02T01:00:00.000Z', receiptPendingSync: true }) }
        case 'ipc:xiaogui.hubTask.inbox.decision':
          accepted = true
          return { ok: true, value: item({ openedAt: '2026-09-02T01:00:00.000Z', receiptPendingSync: true, decisionState: 'ACCEPTED' }) }
        case 'ipc:xiaogui.hubTask.inbox.createPlanDraft':
          return { ok: true, value: { localPlanDraftCreated: true } }
        default:
          throw new Error(`unexpected IPC: ${channel}`)
      }
    })
    window.piDesktop = { invoke } as unknown as Window['piDesktop']
    const onPlanDraftCreated = vi.fn()
    const user = userEvent.setup()

    render(<HubTaskInboxSection address={ADDRESS} onPlanDraftCreated={onPlanDraftCreated} />)
    expect(await screen.findByText('整理院内资料')).toBeInTheDocument()
    expect(screen.queryByText('xgh_node_1')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '打开任务' }))
    expect(await screen.findByRole('button', { name: '接受任务' })).toBeInTheDocument()
    expect(screen.getByText('已在本机记录打开时间，等待 Hub 验证回执。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '接受任务' }))
    expect(await screen.findByRole('button', { name: '生成本机计划草稿' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '生成本机计划草稿' }))

    await waitFor(() => expect(onPlanDraftCreated).toHaveBeenCalledOnce())
    expect(invoke).toHaveBeenCalledWith('ipc:xiaogui.hubTask.inbox.createPlanDraft', {
      assignmentId: 'xgh_assignment_1',
      address: ADDRESS,
    })
    expect(screen.queryByRole('button', { name: '开始执行' })).toBeNull()
  })

  it('logs in with a Hub username and password without rendering either account secret after submit', async () => {
    let connected = false
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'ipc:xiaogui.hubTask.status') {
        return { ok: true, value: { configured: connected, state: connected ? 'READY' : 'UNCONFIGURED', lastSyncedAt: null, pendingReceiptCount: 0 } }
      }
      if (channel === 'ipc:xiaogui.hubTask.connect') {
        connected = true
        return { ok: true, value: { configured: true, state: 'READY', lastSyncedAt: null, pendingReceiptCount: 0 } }
      }
      if (channel === 'ipc:xiaogui.hubTask.inbox.list') return { ok: true, value: [] }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    window.piDesktop = { invoke } as unknown as Window['piDesktop']
    const user = userEvent.setup()
    render(<HubTaskInboxSection address={ADDRESS} onPlanDraftCreated={vi.fn()} />)

    await user.type(screen.getByLabelText('Hub 地址'), 'http://hub.intranet:3000')
    await user.type(screen.getByLabelText('Hub 用户名'), 'planner.a')
    await user.type(screen.getByLabelText('密码'), 'correct-horse-battery-staple')
    await user.click(screen.getByRole('button', { name: '登录并配对此小规' }))

    await waitFor(() => expect(screen.getByText('当前没有分配给此小规的任务。')).toBeInTheDocument())
    expect(invoke).toHaveBeenCalledWith('ipc:xiaogui.hubTask.connect', {
      endpoint: 'http://hub.intranet:3000',
      username: 'planner.a',
      password: 'correct-horse-battery-staple',
    })
    expect(screen.queryByDisplayValue('correct-horse-battery-staple')).toBeNull()
  })

  it('clears cached task content when a refresh reports that this node was replaced', async () => {
    let revoked = false
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'ipc:xiaogui.hubTask.status') {
        return {
          ok: true,
          value: {
            configured: !revoked,
            state: revoked ? 'NODE_REVOKED' : 'READY',
            lastSyncedAt: null,
            pendingReceiptCount: 0,
          },
        }
      }
      if (channel === 'ipc:xiaogui.hubTask.inbox.list') return { ok: true, value: [item()] }
      if (channel === 'ipc:xiaogui.hubTask.refresh') {
        revoked = true
        return { ok: false, code: 'HUB_WORKER_NODE_REVOKED' }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    window.piDesktop = { invoke } as unknown as Window['piDesktop']
    const user = userEvent.setup()
    render(<HubTaskInboxSection address={ADDRESS} onPlanDraftCreated={vi.fn()} />)

    expect(await screen.findByText('整理院内资料')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '同步' }))

    await waitFor(() => expect(screen.queryByText('整理院内资料')).toBeNull())
    expect(screen.getByText('这台小规已被新设备替换，已锁定本地任务内容。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '登录并配对此小规' })).toBeInTheDocument()
  })
})
