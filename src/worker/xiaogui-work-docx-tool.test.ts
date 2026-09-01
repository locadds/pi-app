import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'
import { XIAOGUI_LEGACY_WORK_DOCX_TOOL_PROMPT_DEFINITION_V1 } from '@shared/xiaogui-prompt-capabilities'

import { addXiaoguiWorkDocxTool, XIAOGUI_WORK_DOCX_TOOL_NAME } from './xiaogui-work-docx-tool'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())

vi.mock('./worker-host-tool-channel.js', () => ({
  requestWorkerHostTool: requestWorkerHostToolMock,
}))

function loadTool(options?: { sessionId?: string; runId?: string }) {
  const base = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
  const result = addXiaoguiWorkDocxTool(base, {
    getSourceSessionId: () => options?.sessionId ?? 'session-1',
    getSourceRunId: () => options?.runId ?? 'run-1',
  })
  return result.extensions[0]?.tools.get(XIAOGUI_WORK_DOCX_TOOL_NAME)?.definition
}

type Execute = (
  toolCallId: string,
  params: { action: 'PREPARE' | 'CONFIRM' | 'CANCEL' | 'OPEN' | 'REVEAL' },
  signal: AbortSignal,
) => Promise<{
  content: Array<{ type: string; text: string }>
  details: { kind: string }
  isError?: boolean
}>

beforeEach(() => requestWorkerHostToolMock.mockReset())

describe('xiaogui WORK DOCX Pi tool', () => {
  it('registers one natural-language tool with a closed action interface and confirmation guidance', () => {
    const tool = loadTool()

    expect(tool?.label).toBe('生成 DOCX')
    expect(tool?.promptGuidelines)
      .toBe(XIAOGUI_LEGACY_WORK_DOCX_TOOL_PROMPT_DEFINITION_V1.promptGuidelines)
    expect(tool?.parameters).toMatchObject({ type: 'object', required: ['action'] })
    expect(tool?.promptGuidelines?.join('\n')).toContain('不得在 PREPARE 的同一轮调用')
    expect(tool?.promptGuidelines?.join('\n')).toContain('请单独回复“确认”')
    expect(tool?.promptGuidelines?.join('\n')).toContain('不要让用户输入路径')
  })

  it('prepares through the existing host bridge and returns only a safe user summary', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_PREPARED',
        templateDisplayName: '周报模板.docx',
        payloadDisplayName: '周报数据.json',
        placeholders: ['title', 'summary'],
        templateSha256: 'a'.repeat(64),
        payloadSha256: 'b'.repeat(64),
      },
    })
    const execute = loadTool()?.execute as unknown as Execute

    const outcome = await execute('call-1', { action: 'PREPARE' }, new AbortController().signal)

    expect(requestWorkerHostToolMock).toHaveBeenCalledWith(
      {
        method: 'xiaogui.work.docx.v1',
        payload: {
          action: 'PREPARE',
          sourceSessionId: 'session-1',
          sourceRunId: 'run-1',
          toolCallId: 'call-1',
        },
      },
      expect.any(AbortSignal),
    )
    expect(outcome.isError).not.toBe(true)
    expect(outcome.content[0]?.text).toContain('尚未生成文件')
    expect(outcome.content[0]?.text).toContain('如确认继续，请单独回复“确认”。')
    expect(outcome.content[0]?.text).toContain('周报模板.docx')
    expect(outcome.content[0]?.text).not.toContain('aaaaaaaa')
    expect(outcome.content[0]?.text).not.toMatch(/[A-Z]:[\\/]/)
  })

  it.each(['CONFIRM', 'CANCEL', 'OPEN', 'REVEAL'] as const)(
    'forwards %s without an address, path, or operation identifier',
    async (action) => {
      requestWorkerHostToolMock.mockResolvedValue({
        ok: true,
        value:
          action === 'CONFIRM'
            ? {
                kind: 'XIAOGUI_WORK_DOCX_PUBLISHED',
                outputSha256: 'c'.repeat(64),
                templateSha256: 'a'.repeat(64),
                payloadSha256: 'b'.repeat(64),
                originalInputsUnchanged: true,
              }
            : action === 'CANCEL'
              ? { kind: 'XIAOGUI_WORK_DOCX_CANCELLED' }
              : { kind: 'XIAOGUI_WORK_DOCX_ACCESSED', action },
      })
      const execute = loadTool()?.execute as unknown as Execute

      await execute(`call-${action}`, { action }, new AbortController().signal)

      const sent = requestWorkerHostToolMock.mock.calls[0]?.[0]
      expect(sent).toMatchObject({
        method: 'xiaogui.work.docx.v1',
        payload: { action, sourceSessionId: 'session-1', sourceRunId: 'run-1' },
      })
      expect(sent.payload).not.toHaveProperty('projectId')
      expect(sent.payload).not.toHaveProperty('sessionKey')
      expect(sent.payload).not.toHaveProperty('path')
      expect(sent.payload).not.toHaveProperty('operationId')
    },
  )

  it('treats confirmed publication as a non-cancellable commit and waits for the real result', async () => {
    let finish!: (outcome: {
      ok: true
      value: {
        kind: 'XIAOGUI_WORK_DOCX_PUBLISHED'
        outputSha256: string
        templateSha256: string
        payloadSha256: string
        originalInputsUnchanged: true
      }
    }) => void
    requestWorkerHostToolMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const controller = new AbortController()
    const execute = loadTool()?.execute as unknown as Execute

    const pending = execute('call-confirm', { action: 'CONFIRM' }, controller.signal)
    await vi.waitFor(() => expect(requestWorkerHostToolMock).toHaveBeenCalledOnce())
    expect(requestWorkerHostToolMock.mock.calls[0]?.[1]).toBeUndefined()

    controller.abort()
    finish({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_PUBLISHED',
        outputSha256: 'c'.repeat(64),
        templateSha256: 'a'.repeat(64),
        payloadSha256: 'b'.repeat(64),
        originalInputsUnchanged: true,
      },
    })

    const outcome = await pending
    expect(outcome).not.toHaveProperty('isError')
    expect(outcome).toMatchObject({
      details: { kind: 'XIAOGUI_WORK_DOCX_PUBLISHED' },
    })
  })

  it('fails before the host bridge when the trusted turn identity is unavailable', async () => {
    const execute = loadTool({ sessionId: 'session-1', runId: '' })?.execute as unknown as Execute

    const outcome = await execute('call-2', { action: 'PREPARE' }, new AbortController().signal)

    expect(requestWorkerHostToolMock).not.toHaveBeenCalled()
    expect(outcome.isError).toBe(true)
    expect(outcome.details.kind).toBe('XIAOGUI_WORK_DOCX_FAILED')
  })
})
