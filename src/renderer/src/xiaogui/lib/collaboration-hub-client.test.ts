import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HubAddressV1, HubOutcomeV1, SessionCollaborationProjectionV1 } from '@shared/xiaogui-collaboration-hub'

const invokeMock = vi.fn()
vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: {
    invoke: (method: string, req?: unknown) => invokeMock(method, req),
  },
}))

import { HUB_CONTRACT_VERSION, newHubRequestId, observeCollaborationHub, performHubIntent } from './collaboration-hub-client'

const address: HubAddressV1 = {
  projectId: `xgp1_${'a'.repeat(64)}` as HubAddressV1['projectId'],
  sessionKey: `xgs1_${'b'.repeat(64)}` as HubAddressV1['sessionKey'],
}

const otherAddress: HubAddressV1 = {
  projectId: address.projectId,
  sessionKey: `xgs1_${'c'.repeat(64)}` as HubAddressV1['sessionKey'],
}

function projectionFixture(): SessionCollaborationProjectionV1 {
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
  }
}

beforeEach(() => invokeMock.mockReset())

describe('collaboration-hub-client', () => {
  it('observe 走白名单通道且载荷只含 contractVersion + address', async () => {
    const outcome: HubOutcomeV1<SessionCollaborationProjectionV1> = {
      ok: true,
      value: projectionFixture(),
    }
    invokeMock.mockResolvedValueOnce(outcome)

    const res = await observeCollaborationHub(address)

    expect(res).toEqual(outcome)
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.hub.observe', {
      contractVersion: HUB_CONTRACT_VERSION,
      address,
    })
    const payload = invokeMock.mock.calls[0]![1] as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['address', 'contractVersion'])
    expect(payload.address).toEqual({
      projectId: address.projectId,
      sessionKey: address.sessionKey,
    })
    // 不得携带 path / mode / actor / sessionFile
    expect(JSON.stringify(payload)).not.toMatch(/path|mode|actor|sessionFile/i)
  })

  it('perform 载荷只含 contractVersion + address + request', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: { requestId: 'r1', intentType: 'flow.cancel', sessionVersion: 1 },
    })

    await performHubIntent(address, {
      requestId: 'r1',
      expectedSessionVersion: 1,
      intent: { type: 'flow.cancel', flowId: 'xhbf_1' as never, reason: 'x' },
    })

    expect(invokeMock).toHaveBeenCalledWith('xiaogui.hub.perform', {
      contractVersion: HUB_CONTRACT_VERSION,
      address,
      request: {
        requestId: 'r1',
        expectedSessionVersion: 1,
        intent: { type: 'flow.cancel', flowId: 'xhbf_1', reason: 'x' },
      },
    })
    const payload = invokeMock.mock.calls[0]![1] as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['address', 'contractVersion', 'request'])
  })

  it('IPC 抛异常时映射为安全 INTERNAL 错误且不泄露异常内容', async () => {
    invokeMock.mockRejectedValueOnce(new Error('secret path C:\\Users\\x\\secret'))

    const res = await observeCollaborationHub(address)

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('INTERNAL')
      expect(JSON.stringify(res.error)).not.toContain('secret')
      expect(JSON.stringify(res.error)).not.toContain('C:\\')
    }
  })

  it('非约定返回（非 HubOutcome）映射为安全 INTERNAL 错误', async () => {
    invokeMock.mockResolvedValueOnce({ unexpected: true })

    const res = await observeCollaborationHub(address)

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('INTERNAL')
  })

  it('observe 拒绝与请求 canonical address 不一致的投影', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: { ...projectionFixture(), address: otherAddress },
    })

    const res = await observeCollaborationHub(address)

    expect(res).toEqual({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.error.ipc', traceId: '' },
    })
  })

  it.each([{ ok: true }, { ok: true, value: {} }, { ok: false }, { ok: false, error: { code: 'UNKNOWN', messageKey: 'x', traceId: '' } }])(
    '结构不完整的 HubOutcome 不得进入 Renderer：%j',
    async (malformed) => {
      invokeMock.mockResolvedValueOnce(malformed)

      const res = await observeCollaborationHub(address)

      expect(res).toEqual({
        ok: false,
        error: {
          code: 'INTERNAL',
          messageKey: 'xiaogui.hub.error.ipc',
          traceId: '',
        },
      })
    },
  )

  it('结构不完整的 perform receipt 映射为安全 INTERNAL', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, value: { requestId: 'r1' } })

    const res = await performHubIntent(address, {
      requestId: 'r1',
      expectedSessionVersion: 0,
      intent: { type: 'flow.cancel', flowId: 'xhbf_1' as never, reason: 'x' },
    })

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('INTERNAL')
  })

  it.each([
    { requestId: 'other', intentType: 'flow.cancel', sessionVersion: 1 },
    { requestId: 'r1', intentType: 'flow.start.with_draft', sessionVersion: 1 },
  ])('perform 拒绝与请求不一致的 receipt：%j', async (receipt) => {
    invokeMock.mockResolvedValueOnce({ ok: true, value: receipt })

    const res = await performHubIntent(address, {
      requestId: 'r1',
      expectedSessionVersion: 0,
      intent: { type: 'flow.cancel', flowId: 'xhbf_1' as never, reason: 'x' },
    })

    expect(res).toEqual({
      ok: false,
      error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.error.ipc', traceId: '' },
    })
  })

  it.each(['C:\\Users\\alice\\secret.txt', 'token-secret', 'xhbt_not-a-uuid'])(
    '拒绝不安全 traceId，避免主进程文本进入界面：%s',
    async (traceId) => {
      invokeMock.mockResolvedValueOnce({
        ok: false,
        error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.internal', traceId },
      })

      const res = await observeCollaborationHub(address)

      expect(res).toEqual({
        ok: false,
        error: { code: 'INTERNAL', messageKey: 'xiaogui.hub.error.ipc', traceId: '' },
      })
    },
  )

  it('保留主进程签发的安全 Hub traceId', async () => {
    const traceId = 'xhbt_00000000-0000-4000-8000-000000000000'
    invokeMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'REVISION_CONFLICT', messageKey: 'xiaogui.hub.revision_conflict', traceId },
    })

    await expect(observeCollaborationHub(address)).resolves.toEqual({
      ok: false,
      error: { code: 'REVISION_CONFLICT', messageKey: 'xiaogui.hub.revision_conflict', traceId },
    })
  })

  it('requestId 全局唯一', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newHubRequestId()))
    expect(ids.size).toBe(200)
  })
})
