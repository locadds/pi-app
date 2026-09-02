import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'

import { addXiaoguiWorkMaterialsToolV1, XIAOGUI_READ_MATERIALS_TOOL_NAME } from './xiaogui-work-materials-tool'

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())
vi.mock('./worker-host-tool-channel.js', () => ({ requestWorkerHostTool: requestWorkerHostToolMock }))

function loadTool() {
  const base = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
  const loaded = addXiaoguiWorkMaterialsToolV1(base, {
    getSourceSessionId: () => 'session-1',
    getSourceRunId: () => 'run-1',
  })
  return loaded.extensions[0]?.tools.get(XIAOGUI_READ_MATERIALS_TOOL_NAME)?.definition
}

beforeEach(() => requestWorkerHostToolMock.mockReset())

describe('xiaogui WORK materials tool', () => {
  it('accepts absolute paths and exposes extracted and metadata-only files to the Agent', async () => {
    requestWorkerHostToolMock.mockResolvedValue({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_MATERIALS_READY',
        snapshot: {
          version: 'work-materials-snapshot.v1',
          requestedPaths: ['D:\\院内资料'],
          totalFileCount: 2,
          totalDirectoryCount: 1,
          extractedFileCount: 1,
          metadataOnlyFileCount: 1,
          failedFileCount: 0,
          files: [
            { absolutePath: 'D:\\院内资料\\说明.docx', displayName: '说明.docx', extension: '.docx', byteSize: 10, status: 'CONTENT_EXTRACTED', extractor: 'OFFICEPARSER', content: '正文', warnings: [] },
            { absolutePath: 'D:\\院内资料\\现状图.dwg', displayName: '现状图.dwg', extension: '.dwg', byteSize: 20, status: 'METADATA_ONLY', extractor: 'METADATA', warnings: ['FORMAT_NOT_SEMANTICALLY_SUPPORTED'] },
          ],
          warnings: ['FORMAT_NOT_SEMANTICALLY_SUPPORTED'],
          originalInputsUnchanged: true,
        },
      },
    })
    const tool = loadTool()
    const execute = tool!.execute as unknown as (
      toolCallId: string,
      params: { paths?: string[] },
      signal: AbortSignal,
    ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>
    const outcome = await execute(
      'call-1',
      { paths: ['D:\\院内资料'] },
      new AbortController().signal,
    )

    expect(requestWorkerHostToolMock).toHaveBeenCalledWith({
      method: 'xiaogui.work.materials.v1',
      payload: {
        paths: ['D:\\院内资料'],
        sourceSessionId: 'session-1',
        sourceRunId: 'run-1',
        toolCallId: 'call-1',
      },
    }, expect.any(AbortSignal))
    const text = outcome.content.map((part) => part.text).join('\n')
    expect(text).toContain('扫描了 1 个目录节点（包含用户选择的根目录）')
    expect(text).toContain('D:\\院内资料\\说明.docx')
    expect(text).toContain('正文')
    expect(text).toContain('D:\\院内资料\\现状图.dwg')
    expect(text).toContain('METADATA_ONLY')
    expect(outcome.isError).not.toBe(true)
  })
})
