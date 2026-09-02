import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendToMainMock = vi.hoisted(() => vi.fn())

vi.mock('./worker-transport.js', () => ({ sendToMain: sendToMainMock }))

import { receiveWorkerHostToolResponse, requestWorkerHostTool } from './worker-host-tool-channel'

beforeEach(() => sendToMainMock.mockClear())

describe('worker host-tool response routing', () => {
  it('consumes a valid late response instead of leaking it into ordinary RPC dispatch', () => {
    expect(
      receiveWorkerHostToolResponse({
        type: 'host-tool-response',
        requestId: 'already-timed-out',
        outcome: {
          ok: false,
          error: {
            code: 'HOST_TOOL_TIMEOUT',
            message: 'late response',
          },
        },
      }),
    ).toBe(true)
  })

  it('leaves unrelated messages for ordinary RPC dispatch', () => {
    expect(receiveWorkerHostToolResponse({ type: 'response', requestId: 'rpc-1' })).toBe(false)
  })

  it('turns a malformed success body into a safe failure instead of passing it to a tool', async () => {
    const pending = requestWorkerHostTool({
      method: 'xiaogui.work.docx.v1',
      payload: {
        action: 'PREPARE',
        sourceSessionId: 'session-1',
        sourceRunId: 'run-1',
        toolCallId: 'call-1',
      },
    })
    const requestId = sendToMainMock.mock.calls.at(-1)?.[0]?.requestId as string

    expect(
      receiveWorkerHostToolResponse({
        type: 'host-tool-response',
        requestId,
        outcome: { ok: true },
      }),
    ).toBe(true)
    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: 'HOST_TOOL_FAILED', message: '主进程返回了无法识别的结果' },
    })
  })

  it('notifies main when the user aborts an in-flight interactive request', async () => {
    const controller = new AbortController()
    const pending = requestWorkerHostTool(
      {
        method: 'xiaogui.work.docx.v1',
        payload: {
          action: 'PREPARE',
          sourceSessionId: 'session-1',
          sourceRunId: 'run-1',
          toolCallId: 'call-abort',
        },
      },
      controller.signal,
    )
    const requestId = sendToMainMock.mock.calls[0]?.[0]?.requestId as string

    controller.abort()

    expect(sendToMainMock).toHaveBeenLastCalledWith({ type: 'host-tool-cancel', requestId })
    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: 'HOST_TOOL_ABORTED', message: '操作已取消' },
    })
  })

  it.each(['xiaogui.work.docx.v1', 'xiaogui.work.docx-template-data.v1'] as const)(
    'does not locally time out a confirmed publication for %s',
    async (method) => {
    vi.useFakeTimers()
    try {
      const pending = requestWorkerHostTool({
        method,
        payload: {
          action: 'CONFIRM',
          sourceSessionId: 'session-1',
          sourceRunId: 'run-2',
          toolCallId: 'call-confirm',
        },
      })
      const requestId = sendToMainMock.mock.calls[0]?.[0]?.requestId as string

      await vi.advanceTimersByTimeAsync(16 * 60_000)
      expect(sendToMainMock).toHaveBeenCalledTimes(1)
      expect(sendToMainMock).not.toHaveBeenCalledWith({ type: 'host-tool-cancel', requestId })

      receiveWorkerHostToolResponse({
        type: 'host-tool-response',
        requestId,
        outcome: {
          ok: true,
          value: {
            kind: 'XIAOGUI_WORK_DOCX_PUBLISHED',
            outputSha256: 'c'.repeat(64),
            templateSha256: 'a'.repeat(64),
            ...(method === 'xiaogui.work.docx.v1'
              ? { payloadSha256: 'b'.repeat(64) }
              : { dataSha256: 'b'.repeat(64) }),
            originalInputsUnchanged: true,
          },
        },
      })

      await expect(pending).resolves.toMatchObject({
        ok: true,
        value: { kind: 'XIAOGUI_WORK_DOCX_PUBLISHED' },
      })
    } finally {
      vi.useRealTimers()
    }
    },
  )

  it('does not locally time out a confirmed standard report publication', async () => {
    vi.useFakeTimers()
    try {
      const pending = requestWorkerHostTool({
        method: 'xiaogui.work.report-docx.v1',
        payload: {
          action: 'CONFIRM',
          sourceSessionId: 'session-1',
          sourceRunId: 'run-2',
          toolCallId: 'call-report-confirm',
        },
      })
      const requestId = sendToMainMock.mock.calls[0]?.[0]?.requestId as string

      await vi.advanceTimersByTimeAsync(16 * 60_000)
      expect(sendToMainMock).toHaveBeenCalledTimes(1)
      expect(sendToMainMock).not.toHaveBeenCalledWith({ type: 'host-tool-cancel', requestId })

      receiveWorkerHostToolResponse({
        type: 'host-tool-response',
        requestId,
        outcome: {
          ok: true,
          value: {
            kind: 'XIAOGUI_WORK_REPORT_DOCX_PUBLISHED',
            receipt: {
              receiptVersion: 1,
              sectionCount: 1,
              paragraphCount: 1,
              bulletCount: 1,
              characterCount: 12,
              outputSha256: 'd'.repeat(64),
              publishedAtLocal: '2026-08-27T16:00:00.000+08:00',
            },
          },
        },
      })

      await expect(pending).resolves.toMatchObject({
        ok: true,
        value: { kind: 'XIAOGUI_WORK_REPORT_DOCX_PUBLISHED' },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives the interactive PDF read an interactive timeout instead of the 30s default', async () => {
    vi.useFakeTimers()
    try {
      const pending = requestWorkerHostTool({
        method: 'xiaogui.work.document-snapshot.v1',
        payload: {
          action: 'READ_PDF',
          sourceSessionId: 'session-1',
          sourceRunId: 'run-1',
          toolCallId: 'call-read',
        },
      })
      const requestId = sendToMainMock.mock.calls[0]?.[0]?.requestId as string

      await vi.advanceTimersByTimeAsync(31_000)
      expect(sendToMainMock).toHaveBeenCalledTimes(1)
      expect(sendToMainMock).not.toHaveBeenCalledWith({ type: 'host-tool-cancel', requestId })

      await vi.advanceTimersByTimeAsync(15 * 60_000)
      expect(sendToMainMock).toHaveBeenLastCalledWith({ type: 'host-tool-cancel', requestId })
      await expect(pending).resolves.toEqual({
        ok: false,
        error: { code: 'HOST_TOOL_TIMEOUT', message: '小规操作超时，请稍后重试' },
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
