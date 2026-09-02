import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'

import {
  addXiaoguiCollaborationTool,
  XIAOGUI_COLLABORATION_PLAN_TOOL_NAME,
} from './xiaogui-collaboration-tool'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())

vi.mock('./worker-host-tool-channel.js', () => ({
  requestWorkerHostTool: requestWorkerHostToolMock,
}))

function loadTool() {
  const base = {
    extensions: [],
    errors: [],
    runtime: {},
  } as unknown as LoadExtensionsResult
  const result = addXiaoguiCollaborationTool(base, {
    getSourceSessionId: () => 'session-1',
    getSourceTurnId: () => 'turn-1',
  })
  return result.extensions[0]?.tools.get(XIAOGUI_COLLABORATION_PLAN_TOOL_NAME)?.definition
}

beforeEach(() => requestWorkerHostToolMock.mockReset())

describe('xiaogui collaboration Pi tool', () => {
  it('adds one hidden natural-language collaboration tool without replacing other extensions', () => {
    const base = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
    const result = addXiaoguiCollaborationTool(base, {
      getSourceSessionId: () => 'session-1',
      getSourceTurnId: () => 'turn-1',
    })

    expect(result.extensions).toHaveLength(1)
    expect(result.extensions[0]?.hidden).toBe(true)
    const tool = result.extensions[0]?.tools.get(XIAOGUI_COLLABORATION_PLAN_TOOL_NAME)?.definition
    expect(tool?.label).toBe('创建协作计划')
    expect(tool?.promptGuidelines?.join('\n')).toContain('不要让用户填写 taskKey')
    expect(tool?.parameters).toMatchObject({
      type: 'object',
      required: ['objective', 'tasks'],
    })
  })

  it('executes through the host bridge and returns refreshable success details', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: {
        kind: 'XIAOGUI_COLLABORATION_DRAFT_CREATED',
        taskCount: 1,
        sessionVersion: 1,
      },
    })
    const tool = loadTool()
    const execute = tool?.execute as unknown as (
      toolCallId: string,
      params: { objective: string; tasks: Array<{ taskKey: string; title: string }> },
      signal: AbortSignal,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: { kind: string }; isError?: boolean }>
    const params = {
      objective: '完成周报',
      tasks: [{ taskKey: 'draft', title: '起草周报' }],
    }

    const outcome = await execute('call-1', params, new AbortController().signal)

    expect(requestWorkerHostToolMock).toHaveBeenCalledWith(
      {
        method: 'xiaogui.collaboration.create-plan-draft',
        payload: {
          draft: params,
          sourceSessionId: 'session-1',
          sourceTurnId: 'turn-1',
          toolCallId: 'call-1',
        },
      },
      expect.any(AbortSignal),
    )
    expect(outcome.isError).not.toBe(true)
    expect(outcome.details.kind).toBe('XIAOGUI_COLLABORATION_DRAFT_CREATED')
    expect(outcome.content[0]?.text).toContain('右侧“协作”面板')
  })

  it('returns a safe tool error without claiming that a draft exists', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: false,
      error: { code: 'DESIGN_RESERVED', message: '规划设计会话暂不创建协作计划' },
    })
    const tool = loadTool()
    const execute = tool?.execute as unknown as (
      toolCallId: string,
      params: { objective: string; tasks: Array<{ taskKey: string; title: string }> },
      signal: AbortSignal,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: { kind: string }; isError?: boolean }>

    const outcome = await execute(
      'call-2',
      { objective: '研究方案', tasks: [{ taskKey: 'research', title: '研究' }] },
      new AbortController().signal,
    )

    expect(outcome.isError).toBe(true)
    expect(outcome.details.kind).toBe('XIAOGUI_COLLABORATION_DRAFT_FAILED')
    expect(outcome.content[0]?.text).toBe('规划设计会话暂不创建协作计划')
  })
})
