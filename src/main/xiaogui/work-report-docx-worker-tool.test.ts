import { describe, expect, it, vi } from 'vitest'

import type {
  WorkerHostToolRequestV1,
  XiaoguiWorkReportDocxPayloadV1,
} from '@shared/worker-host-tools'

import { createXiaoguiWorkReportDocxWorkerToolHandlerV1 } from './work-report-docx-worker-tool'

const DRAFT = {
  title: '项目汇报',
  sections: [{ heading: '进展', paragraphs: ['已完成。'], bullets: ['待验证。'] }],
} as const

function request(
  payload: XiaoguiWorkReportDocxPayloadV1,
): WorkerHostToolRequestV1 {
  return {
    type: 'host-tool-request',
    requestId: 'request-1',
    method: 'xiaogui.work.report-docx.v1',
    payload,
  }
}

describe('WORK 标准报告 DOCX 主进程工具适配器', () => {
  it('只从前台 Worker 元数据派生 WORK 地址并转发严格 PREPARE 草稿', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      value: {
        kind: 'XIAOGUI_WORK_REPORT_DOCX_PREPARED' as const,
        plan: {
          planVersion: 1 as const,
          sectionCount: 1,
          paragraphCount: 1,
          bulletCount: 1,
          characterCount: 16,
          previewSha256: 'a'.repeat(64),
          preview: DRAFT,
          requiresSecondConfirmation: true as const,
        },
      },
    }))
    const resolveExisting = vi.fn(async () => ({
      projectId: `xgp1_${'a'.repeat(64)}`,
      sessionKey: `xgs1_${'b'.repeat(64)}`,
      sessionMode: 'WORK' as const,
    }))
    const handler = createXiaoguiWorkReportDocxWorkerToolHandlerV1({
      getService: () => ({ execute }),
      scopeResolver: { resolveExisting } as never,
    })
    const toolRequest = request({
      action: 'PREPARE',
      draft: DRAFT,
      sourceSessionId: 'session-1',
      sourceRunId: 'run-1',
      toolCallId: 'tool-1',
    })

    const result = await handler({
      request: toolRequest,
      fromCwd: 'D:/project',
      fromPoolKey: 'D:/session.jsonl',
      sessionFile: 'D:/session.jsonl',
      fromSessionId: 'session-1',
    })

    expect(result.ok && result.value.kind).toBe('XIAOGUI_WORK_REPORT_DOCX_PREPARED')
    expect(resolveExisting).toHaveBeenCalledWith({
      rootPath: 'D:/project',
      sessionFile: 'D:/session.jsonl',
    })
    expect(execute).toHaveBeenCalledWith(
      {
        projectId: `xgp1_${'a'.repeat(64)}`,
        sessionKey: `xgs1_${'b'.repeat(64)}`,
      },
      toolRequest.payload,
      undefined,
    )
  })

  it('拒绝会话串线和在 CONFIRM 中夹带草稿', async () => {
    const execute = vi.fn()
    const handler = createXiaoguiWorkReportDocxWorkerToolHandlerV1({
      getService: () => ({ execute }),
      scopeResolver: { resolveExisting: vi.fn() } as never,
    })
    const prepare = request({
      action: 'PREPARE',
      draft: DRAFT,
      sourceSessionId: 'other-session',
      sourceRunId: 'run-1',
      toolCallId: 'tool-1',
    })

    await expect(
      handler({
        request: prepare,
        fromCwd: 'D:/project',
        fromPoolKey: 'D:/session.jsonl',
        sessionFile: 'D:/session.jsonl',
        fromSessionId: 'session-1',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'SESSION_SCOPE_MISMATCH' } })

    await expect(
      handler({
        request: {
          type: 'host-tool-request',
          requestId: 'request-2',
          method: 'xiaogui.work.report-docx.v1',
          payload: {
            action: 'CONFIRM',
            draft: DRAFT,
            sourceSessionId: 'session-1',
            sourceRunId: 'run-2',
            toolCallId: 'tool-2',
          },
        } as never,
        fromCwd: 'D:/project',
        fromPoolKey: 'D:/session.jsonl',
        sessionFile: 'D:/session.jsonl',
        fromSessionId: 'session-1',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'HOST_TOOL_REQUEST_INVALID' } })
    expect(execute).not.toHaveBeenCalled()
  })
})
