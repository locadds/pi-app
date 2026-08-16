import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  FlowId,
  HubAddressV1,
  PlanRevisionId,
  SessionCollaborationProjectionV1,
  TaskRunId,
  TaskSpecId,
} from '@shared/xiaogui-collaboration-hub'
import type { CanonicalSessionAddressScopeV1 } from '@shared/xiaogui-session-scope'

import { useUIStore } from '@renderer/stores/ui-store'
import type { SessionItem } from '@renderer/stores/ui-store-types'

const observeMock = vi.fn()
const performMock = vi.fn()
let requestCounter = 0
vi.mock('../lib/collaboration-hub-client', () => ({
  HUB_CONTRACT_VERSION: 'm2a.v1',
  observeCollaborationHub: (address: HubAddressV1) => observeMock(address),
  performHubIntent: (address: HubAddressV1, request: unknown) => performMock(address, request),
  newHubRequestId: () => `test-req-${++requestCounter}`,
}))

import { useCollaborationHubStore } from '../stores/collaboration-hub-store'
import { CollaborationHubPanel } from './CollaborationHubPanel'

function scopeOf(sessionKeyHex: string, mode: 'WORK' | 'DESIGN' | 'CODING'): CanonicalSessionAddressScopeV1 {
  return {
    projectId: `xgp1_${'a'.repeat(64)}` as CanonicalSessionAddressScopeV1['projectId'],
    sessionKey: `xgs1_${sessionKeyHex.repeat(64)}` as CanonicalSessionAddressScopeV1['sessionKey'],
    sessionMode: mode,
  }
}

const scopeWork = scopeOf('1', 'WORK')
const scopeCoding = scopeOf('2', 'CODING')
const scopeDesign = scopeOf('3', 'DESIGN')

function sessionWith(id: string, scope?: CanonicalSessionAddressScopeV1): SessionItem {
  return {
    sessionId: id,
    title: id,
    updatedAt: 0,
    modelId: 'm',
    ...(scope ? { canonicalScope: scope } : {}),
  }
}

function baseProjection(address: HubAddressV1, patch: Partial<SessionCollaborationProjectionV1> = {}): SessionCollaborationProjectionV1 {
  return {
    kind: 'SESSION_COLLABORATION_PROJECTION',
    version: 'm2a.v1',
    address,
    sessionVersion: 0,
    sessionMode: 'WORK',
    authoritativeMode: 'WORK',
    reserved: false,
    activeFlow: null,
    activeRevision: null,
    taskSpecs: [],
    taskRuns: [],
    history: [],
    availableActions: ['flow.start.with_draft'],
    ...patch,
  }
}

function reservedProjection(address: HubAddressV1): SessionCollaborationProjectionV1 {
  return baseProjection(address, {
    sessionMode: 'DESIGN',
    authoritativeMode: 'DESIGN',
    reserved: {
      code: 'DESIGN_RESERVED',
      messageKey: 'xiaogui.hub.design_reserved',
    },
    availableActions: [],
  })
}

function awaitingProjection(address: HubAddressV1): SessionCollaborationProjectionV1 {
  const flowId = 'xhbf_flow1' as FlowId
  const revisionId = 'xhbr_rev1' as PlanRevisionId
  return baseProjection(address, {
    sessionVersion: 4,
    activeFlow: {
      flowId,
      status: 'AWAITING_PLAN_APPROVAL',
      activeRevisionId: revisionId,
      objective: '目标X',
    },
    activeRevision: {
      revisionId,
      status: 'DRAFT',
      digest: 'digest-1',
      draft: {
        objective: '目标X',
        tasks: [{ taskKey: 't1', title: '投影任务' }],
      },
    },
    availableActions: ['plan.revision.submit', 'flow.cancel'],
  })
}

function activeProjection(address: HubAddressV1): SessionCollaborationProjectionV1 {
  const flowId = 'xhbf_flow1' as FlowId
  const revisionId = 'xhbr_rev1' as PlanRevisionId
  return baseProjection(address, {
    sessionMode: 'CODING',
    authoritativeMode: 'CODING',
    sessionVersion: 5,
    activeFlow: {
      flowId,
      status: 'PLAN_ACTIVE',
      activeRevisionId: revisionId,
      objective: '目标X',
    },
    activeRevision: {
      revisionId,
      status: 'ACTIVE',
      digest: 'digest-1',
      draft: {
        objective: '目标X',
        tasks: [{ taskKey: 't1', title: '投影任务' }],
      },
    },
    taskSpecs: [
      {
        taskSpecId: 'xhbts_1' as TaskSpecId,
        taskKey: 't1',
        title: '投影任务',
        dependsOn: [],
        unavailableReason: 'AGENT_DISABLED_M2A',
      },
    ],
    taskRuns: [
      {
        taskRunId: 'xhbtr_1' as TaskRunId,
        taskSpecId: 'xhbts_1' as TaskSpecId,
        taskKey: 't1',
        status: 'PENDING_DISABLED',
        unavailableReason: 'AGENT_DISABLED_M2A',
      },
    ],
    availableActions: ['flow.cancel'],
  })
}

let uiSnapshot: ReturnType<typeof useUIStore.getState>

beforeEach(() => {
  observeMock.mockReset()
  performMock.mockReset()
  requestCounter = 0
  uiSnapshot = useUIStore.getState()
  useCollaborationHubStore.getState().setAddress(null)
})

afterEach(() => {
  cleanup()
  useUIStore.setState(uiSnapshot, true)
  useCollaborationHubStore.getState().setAddress(null)
})

function showSession(session: SessionItem) {
  act(() =>
    useUIStore.setState({
      sessions: [session],
      currentSessionId: session.sessionId,
    }),
  )
}

describe('CollaborationHubPanel', () => {
  it('没有 canonical 会话时不调用 Hub IPC 并提示先进入会话', async () => {
    showSession(sessionWith('s-plain'))
    render(<CollaborationHubPanel />)
    expect(await screen.findByTestId('hub-no-session')).toHaveTextContent('请先进入已建立的会话')
    expect(observeMock).not.toHaveBeenCalled()
  })

  it('DESIGN reserved 不渲染任何 perform 按钮', async () => {
    observeMock.mockResolvedValue({
      ok: true,
      value: reservedProjection(scopeDesign),
    })
    showSession(sessionWith('s-design', scopeDesign))
    render(<CollaborationHubPanel />)
    expect(await screen.findByTestId('hub-design-reserved')).toHaveTextContent('DESIGN_RESERVED')
    expect(screen.queryByRole('button', { name: '建立草稿' })).toBeNull()
    expect(screen.queryByRole('button', { name: '批准计划' })).toBeNull()
    expect(screen.queryByRole('button', { name: '取消协作计划' })).toBeNull()
    expect(performMock).not.toHaveBeenCalled()
  })

  it('availableActions 不含动作时对应按钮不渲染', async () => {
    const p = awaitingProjection(scopeWork)
    p.availableActions = [] // 主进程未授予任何动作
    observeMock.mockResolvedValue({ ok: true, value: p })
    showSession(sessionWith('s-work', scopeWork))
    render(<CollaborationHubPanel />)
    await screen.findByTestId('hub-awaiting-approval')
    expect(screen.queryByRole('button', { name: '批准计划' })).toBeNull()
    expect(screen.queryByRole('button', { name: '取消协作计划' })).toBeNull()
  })

  it('WORK 建稿：填表 → 建立草稿 → 重新 observe 后进入待批准', async () => {
    const address: HubAddressV1 = {
      projectId: scopeWork.projectId,
      sessionKey: scopeWork.sessionKey,
    }
    observeMock
      .mockResolvedValueOnce({ ok: true, value: baseProjection(address) })
      .mockResolvedValue({ ok: true, value: awaitingProjection(address) })
    performMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: 'r',
        intentType: 'flow.start.with_draft',
        sessionVersion: 1,
      },
    })
    showSession(sessionWith('s-work', scopeWork))
    const user = userEvent.setup()
    render(<CollaborationHubPanel />)

    await screen.findByTestId('hub-draft-form')
    await user.type(screen.getByLabelText('协作计划目标'), '完成报告')
    await user.type(screen.getByLabelText('任务 1 标识'), 't1')
    await user.type(screen.getByLabelText('任务 1 标题'), '写报告')
    await user.click(screen.getByRole('button', { name: '建立草稿' }))

    await screen.findByTestId('hub-awaiting-approval')
    expect(performMock).toHaveBeenCalledTimes(1)
    expect(performMock.mock.calls[0]![1].intent.draft).toEqual({
      objective: '完成报告',
      tasks: [{ taskKey: 't1', title: '写报告' }],
    })
    expect(screen.getByText('digest-1')).toBeInTheDocument()
  })

  it('刷新后仍可批准：审批提交投影携带的 canonical draft', async () => {
    const address: HubAddressV1 = {
      projectId: scopeWork.projectId,
      sessionKey: scopeWork.sessionKey,
    }
    // 直接以待批准投影挂载（模拟刷新/重启后从 M2A 投影恢复）
    observeMock.mockResolvedValue({
      ok: true,
      value: awaitingProjection(address),
    })
    performMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: 'r',
        intentType: 'plan.revision.submit',
        sessionVersion: 5,
      },
    })
    showSession(sessionWith('s-work', scopeWork))
    const user = userEvent.setup()
    render(<CollaborationHubPanel />)

    await screen.findByTestId('hub-awaiting-approval')
    await user.click(screen.getByRole('button', { name: '批准计划' }))

    await waitFor(() => expect(performMock).toHaveBeenCalledTimes(1))
    const [, request] = performMock.mock.calls[0]!
    expect(request.expectedSessionVersion).toBe(4)
    expect(request.intent).toEqual({
      type: 'plan.revision.submit',
      flowId: 'xhbf_flow1',
      baseRevisionId: 'xhbr_rev1',
      draft: {
        objective: '目标X',
        tasks: [{ taskKey: 't1', title: '投影任务' }],
      },
    })
  })

  it('取消失败时保留确认表单和用户填写的原因', async () => {
    observeMock.mockResolvedValue({ ok: true, value: awaitingProjection(scopeWork) })
    performMock.mockResolvedValue({
      ok: false,
      error: {
        code: 'STALE_SESSION_VERSION',
        messageKey: 'xiaogui.hub.stale_session_version',
        traceId: 'xhbt_00000000-0000-4000-8000-000000000000',
      },
    })
    showSession(sessionWith('s-cancel-failure', scopeWork))
    const user = userEvent.setup()
    render(<CollaborationHubPanel />)
    await screen.findByTestId('hub-awaiting-approval')

    await user.click(screen.getByRole('button', { name: '取消协作计划' }))
    const reason = screen.getByLabelText('取消原因')
    await user.type(reason, '仍需调整任务')
    await user.click(screen.getByRole('button', { name: '确认取消' }))

    expect(await screen.findByText(/STALE_SESSION_VERSION/)).toBeInTheDocument()
    expect(screen.getByLabelText('取消原因')).toHaveValue('仍需调整任务')
    expect(screen.getByRole('button', { name: '确认取消' })).toBeInTheDocument()
  })

  it('PLAN_ACTIVE 只读展示 PENDING_DISABLED，不出现执行中措辞', async () => {
    const address: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    observeMock.mockResolvedValue({
      ok: true,
      value: activeProjection(address),
    })
    showSession(sessionWith('s-coding', scopeCoding))
    render(<CollaborationHubPanel />)

    const view = await screen.findByTestId('hub-active-plan')
    expect(view).toHaveTextContent('PENDING_DISABLED')
    expect(view).toHaveTextContent('AGENT_DISABLED_M2A')
    expect(view).toHaveTextContent('执行能力将在后续 CODING Adapter 接入')
    expect(view.textContent).not.toMatch(/运行中|已完成|自动派发/)
  })

  it('切换会话后旧投影不串到新会话', async () => {
    const addrWork: HubAddressV1 = {
      projectId: scopeWork.projectId,
      sessionKey: scopeWork.sessionKey,
    }
    const addrCoding: HubAddressV1 = {
      projectId: scopeCoding.projectId,
      sessionKey: scopeCoding.sessionKey,
    }
    observeMock.mockImplementation((address: HubAddressV1) => {
      if (address.sessionKey === addrWork.sessionKey) {
        return Promise.resolve({
          ok: true,
          value: awaitingProjection(addrWork),
        })
      }
      return Promise.resolve({ ok: true, value: baseProjection(addrCoding) })
    })
    showSession(sessionWith('s-work', scopeWork))
    render(<CollaborationHubPanel />)
    await screen.findByTestId('hub-awaiting-approval')

    // 切换到 CODING 会话（空投影）→ 待批准视图必须消失
    showSession(sessionWith('s-coding', scopeCoding))
    await screen.findByTestId('hub-draft-form')
    expect(screen.queryByTestId('hub-awaiting-approval')).toBeNull()
  })

  it('同一 canonical address 的权威模式变化后重新读取投影', async () => {
    const designAtSameAddress: CanonicalSessionAddressScopeV1 = {
      ...scopeWork,
      sessionMode: 'DESIGN',
    }
    observeMock
      .mockResolvedValueOnce({ ok: true, value: baseProjection(scopeWork) })
      .mockResolvedValueOnce({ ok: true, value: reservedProjection(scopeWork) })

    showSession(sessionWith('s-mode-change', scopeWork))
    render(<CollaborationHubPanel />)
    await screen.findByTestId('hub-draft-form')

    showSession(sessionWith('s-mode-change', designAtSameAddress))

    expect(await screen.findByTestId('hub-design-reserved')).toHaveTextContent('DESIGN_RESERVED')
    expect(observeMock).toHaveBeenCalledTimes(2)
  })

  it('错误只显示安全码、中文短文案和 traceId', async () => {
    observeMock.mockResolvedValue({
      ok: false,
      error: {
        code: 'STALE_SESSION_VERSION',
        messageKey: 'xiaogui.hub.stale',
        traceId: 'tr-9',
      },
    })
    showSession(sessionWith('s-work', scopeWork))
    render(<CollaborationHubPanel />)
    const banner = await screen.findByText(/STALE_SESSION_VERSION/)
    expect(banner.textContent).toContain('会话状态已变化')
    expect(await screen.findByText(/tr-9/)).toBeInTheDocument()
  })
})
