import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'

import {
  addXiaoguiCodingPlanToolV1,
  XIAOGUI_CODING_PLAN_TOOL_NAME_V1,
} from './xiaogui-coding-plan-tool'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())

vi.mock('./worker-host-tool-channel.js', () => ({
  requestWorkerHostTool: requestWorkerHostToolMock,
}))

function loadTool(sourceSessionId: string | null = 'session-1') {
  const base = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
  const result = addXiaoguiCodingPlanToolV1(base, {
    getSourceSessionId: () => sourceSessionId ?? undefined,
    getSourceTurnId: () => 'turn-1',
  })
  return result.extensions[0]?.tools.get(XIAOGUI_CODING_PLAN_TOOL_NAME_V1)?.definition
}

beforeEach(() => requestWorkerHostToolMock.mockReset())

describe('xiaogui CODING plan Pi tool', () => {
  it('registers one hidden tool whose model schema contains only the plan body', () => {
    const tool = loadTool()
    expect(tool?.label).toBe('提交编程计划草稿')
    expect(tool?.parameters).toMatchObject({
      type: 'object',
      required: ['objective', 'steps', 'constraints'],
      additionalProperties: false,
    })
    expect(JSON.stringify(tool?.parameters)).not.toMatch(/address|path|attemptId|digest/i)
  })

  it('publishes objective, steps and constraints through the narrow host bridge', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: { kind: 'XIAOGUI_CODING_PLAN_DRAFT_SAVED' },
    })
    const tool = loadTool()
    const execute = tool?.execute as unknown as (
      toolCallId: string,
      params: {
        objective: string
        steps: Array<{ stepId: string; title: string; validation: string }>
        constraints: string[]
      },
      signal: AbortSignal,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: { kind: string } }>
    const body = {
      objective: '修复登录错误并验证',
      steps: [{ stepId: 'inspect', title: '定位错误', validation: '聚焦测试复现并通过' }],
      constraints: ['不修改 WORK 模式'],
    }

    const outcome = await execute('call-1', body, new AbortController().signal)

    expect(requestWorkerHostToolMock).toHaveBeenCalledWith({
      method: 'xiaogui.coding.plan-draft.v1',
      payload: {
        sourceSessionId: 'session-1',
        sourceTurnId: 'turn-1',
        toolCallId: 'call-1',
        body,
      },
    }, expect.any(AbortSignal))
    expect(outcome.details).toEqual({ kind: 'XIAOGUI_CODING_PLAN_DRAFT_SAVED' })
    expect(outcome.content[0]?.text).toBe('编程计划草稿已保存，正在等待用户批准。')
    expect(JSON.stringify(outcome)).not.toMatch(/sha256|digest|[A-Za-z]:[\\/]/i)
  })

  it('fails closed when the Worker is not bound to a session', async () => {
    const tool = loadTool(null)
    const execute = tool?.execute as unknown as (
      toolCallId: string,
      params: { objective: string; steps: unknown[]; constraints: string[] },
      signal: AbortSignal,
    ) => Promise<{ isError?: boolean; details: { code?: string } }>
    const outcome = await execute(
      'call-2',
      { objective: '检查代码', steps: [], constraints: [] },
      new AbortController().signal,
    )
    expect(requestWorkerHostToolMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ isError: true, details: { code: 'SESSION_NOT_READY' } })
  })
})
