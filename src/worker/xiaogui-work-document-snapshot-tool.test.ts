import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'
import type { DocumentSnapshotV1 } from '@shared/xiaogui-document-snapshot'

import {
  addXiaoguiWorkDocumentSnapshotTool,
  XIAOGUI_READ_PDF_TOOL_NAME,
} from './xiaogui-work-document-snapshot-tool'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())

vi.mock('./worker-host-tool-channel.js', () => ({
  requestWorkerHostTool: requestWorkerHostToolMock,
}))

const SNAPSHOT: DocumentSnapshotV1 = {
  version: 'document-snapshot.v1',
  kind: 'PDF',
  sourceDisplayName: '周报.pdf',
  sourceSha256: 'a'.repeat(64),
  extractorId: 'unpdf',
  extractorVersion: '1.6.2',
  pageCount: 2,
  pages: [
    { pageNumber: 1, text: '本周完成事项', textSha256: 'b'.repeat(64) },
    { pageNumber: 2, text: '下周计划', textSha256: 'c'.repeat(64) },
  ],
  contentSha256: 'd'.repeat(64),
  warnings: ['TRUNCATED'],
  originalInputUnchanged: true,
}

function loadTool(options?: { sessionId?: string; runId?: string }) {
  const base = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
  const result = addXiaoguiWorkDocumentSnapshotTool(base, {
    getSourceSessionId: () => options?.sessionId ?? 'session-1',
    getSourceRunId: () => options?.runId ?? 'run-1',
  })
  return result.extensions[0]?.tools.get(XIAOGUI_READ_PDF_TOOL_NAME)?.definition
}

type Execute = (
  toolCallId: string,
  params: { startPage?: number; endPage?: number },
  signal: AbortSignal,
) => Promise<{
  content: Array<{ type: string; text: string }>
  details: { kind: string }
  isError?: boolean
}>

beforeEach(() => requestWorkerHostToolMock.mockReset())

describe('xiaogui WORK document snapshot Pi tool', () => {
  it('registers one natural-language read tool with only an optional page range', () => {
    const tool = loadTool()

    expect(tool?.label).toBe('读取 PDF')
    expect(tool?.parameters).toMatchObject({ type: 'object', additionalProperties: false })
    expect(tool?.parameters).not.toHaveProperty('required')
    expect(tool?.promptGuidelines?.join('\n')).toContain('不要让用户输入路径')
  })

  it('reads through the existing host bridge and returns page text without any path', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCUMENT_SNAPSHOT_READY', snapshot: SNAPSHOT },
    })
    const execute = loadTool()?.execute as unknown as Execute

    const outcome = await execute('call-1', { startPage: 1, endPage: 2 }, new AbortController().signal)

    expect(requestWorkerHostToolMock).toHaveBeenCalledWith(
      {
        method: 'xiaogui.work.document-snapshot.v1',
        payload: {
          action: 'READ_PDF',
          startPage: 1,
          endPage: 2,
          sourceSessionId: 'session-1',
          sourceRunId: 'run-1',
          toolCallId: 'call-1',
        },
      },
      expect.any(AbortSignal),
    )
    expect(outcome.isError).not.toBe(true)
    expect(outcome.details.kind).toBe('XIAOGUI_WORK_DOCUMENT_SNAPSHOT_READY')
    const text = outcome.content.map((part) => part.text).join('\n')
    expect(text).toContain('周报.pdf')
    expect(text).toContain('第 1 页')
    expect(text).toContain('本周完成事项')
    expect(text).toContain('快照已截断')
    expect(text).not.toContain('aaaaaaaa')
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/)
  })

  it('sends no address, path, handle, or password fields to the host', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCUMENT_SNAPSHOT_READY', snapshot: SNAPSHOT },
    })
    const execute = loadTool()?.execute as unknown as Execute

    await execute('call-2', {}, new AbortController().signal)

    const sent = requestWorkerHostToolMock.mock.calls[0]?.[0]
    expect(sent).toMatchObject({
      method: 'xiaogui.work.document-snapshot.v1',
      payload: {
        action: 'READ_PDF',
        startPage: undefined,
        endPage: undefined,
        sourceSessionId: 'session-1',
        sourceRunId: 'run-1',
      },
    })
    expect(sent.payload).not.toHaveProperty('projectId')
    expect(sent.payload).not.toHaveProperty('sessionKey')
    expect(sent.payload).not.toHaveProperty('path')
    expect(sent.payload).not.toHaveProperty('filePath')
    expect(sent.payload).not.toHaveProperty('password')
  })

  it('reports a normal user message when the picker was cancelled', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCUMENT_SELECTION_CANCELLED' },
    })
    const execute = loadTool()?.execute as unknown as Execute

    const outcome = await execute('call-3', {}, new AbortController().signal)

    expect(outcome.isError).not.toBe(true)
    expect(outcome.content[0]?.text).toContain('已取消文件选择')
  })

  it('surfaces host failures as errors with their user message', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: false,
      error: { code: 'PDF_ENCRYPTED', message: '该 PDF 已加密，当前版本暂不支持读取加密文档' },
    })
    const execute = loadTool()?.execute as unknown as Execute

    const outcome = await execute('call-4', {}, new AbortController().signal)

    expect(outcome.isError).toBe(true)
    expect(outcome.details.kind).toBe('XIAOGUI_WORK_DOCUMENT_FAILED')
    expect(outcome.content[0]?.text).toContain('该 PDF 已加密')
  })

  it('fails closed when the host returns an unrelated successful result', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED' },
    })
    const execute = loadTool()?.execute as unknown as Execute

    const outcome = await execute('call-unrelated', {}, new AbortController().signal)

    expect(outcome.isError).toBe(true)
    expect(outcome.details.kind).toBe('XIAOGUI_WORK_DOCUMENT_FAILED')
    expect(outcome.content[0]?.text).toContain('无法识别')
  })

  it('fails before the host bridge when the trusted turn identity is unavailable', async () => {
    const execute = loadTool({ sessionId: 'session-1', runId: '' })?.execute as unknown as Execute

    const outcome = await execute('call-5', {}, new AbortController().signal)

    expect(requestWorkerHostToolMock).not.toHaveBeenCalled()
    expect(outcome.isError).toBe(true)
    expect(outcome.details.kind).toBe('XIAOGUI_WORK_DOCUMENT_FAILED')
  })
})
