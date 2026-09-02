import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'

import {
  addXiaoguiWorkDocxAdvancedGenerationTool,
  XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_TOOL_NAME,
} from './xiaogui-work-docx-advanced-generation-tool'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())

vi.mock('./worker-host-tool-channel.js', () => ({
  requestWorkerHostTool: requestWorkerHostToolMock,
}))

function loadTool() {
  const base = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
  const result = addXiaoguiWorkDocxAdvancedGenerationTool(base, {
    getSourceSessionId: () => 'session-1',
    getSourceRunId: () => 'run-1',
  })
  return result.extensions[0]?.tools.get(
    XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_TOOL_NAME,
  )?.definition
}

beforeEach(() => requestWorkerHostToolMock.mockReset())

describe('xiaogui WORK advanced DOCX generation tool', () => {
  it('tells the user to send the closed confirmation reply after PREPARE', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_PREPARED',
        plan: {
          repeatRecordCount: 2,
          retainedConditionalCount: 1,
        },
      },
    })
    const execute = loadTool()?.execute as unknown as (
      toolCallId: string,
      params: { action: 'PREPARE'; data: Record<string, unknown> },
      signal: AbortSignal,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: { kind: string } }>

    const outcome = await execute(
      'call-prepare',
      {
        action: 'PREPARE',
        data: {
          dataVersion: 1,
          variables: [],
          repeatBlocks: [],
          conditionalBlocks: [],
        },
      },
      new AbortController().signal,
    )

    expect(outcome.content[0]?.text).toContain('如确认继续，请单独回复“确认”。')
  })
})
