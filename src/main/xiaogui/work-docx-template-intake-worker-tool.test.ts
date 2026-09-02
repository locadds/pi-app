import { describe, expect, it, vi } from 'vitest'

import type { WorkerHostToolRequestV1 } from '@shared/worker-host-tools'
import type { TemplateIntakeErrorCodeV1 } from '@shared/xiaogui-work-docx-template-intake'

import type { SessionScopeResolverV1 } from './scope-resolver'
import {
  createXiaoguiWorkDocxTemplateIntakeWorkerToolHandlerV1,
} from './work-docx-template-intake-worker-tool'

const PROJECT = `xgp1_${'1'.repeat(64)}`
const SESSION = `xgs1_${'2'.repeat(64)}`

function request(): WorkerHostToolRequestV1 {
  return {
    type: 'host-tool-request',
    requestId: 'host-intake-start',
    method: 'xiaogui.work.docx-template-intake.v1',
    payload: {
      action: 'START',
      sourceSessionId: 'pi-session-1',
      sourceRunId: 'run-1',
      toolCallId: 'call-start',
    },
  }
}

function handlerFor(code: TemplateIntakeErrorCodeV1) {
  return createXiaoguiWorkDocxTemplateIntakeWorkerToolHandlerV1({
    scopeResolver: {
      resolveExisting: vi.fn(async () => ({
        projectId: PROJECT,
        sessionKey: SESSION,
        sessionMode: 'WORK' as const,
        rootPath: 'D:/project',
        sessionFile: 'D:/session.jsonl',
      })),
    } as unknown as SessionScopeResolverV1,
    getService: () => ({
      execute: vi.fn(async () => ({ ok: false as const, error: { code } })),
    }),
  })
}

describe('WORK DOCX template-intake Worker adapter', () => {
  it.each([
    [
      'TEMPLATE_INTAKE_CONVERSION_UNAVAILABLE',
      '转换组件尚未安装或装配',
      '转换组件已可用',
    ],
    [
      'TEMPLATE_INTAKE_CONVERSION_FAILED',
      '转换组件已可用，但本次文档转换失败',
      '尚未安装或装配',
    ],
  ] as const)('向用户区分 %s', async (code, expected, excluded) => {
    const outcome = await handlerFor(code)({
      request: request(),
      fromCwd: 'D:/project',
      fromPoolKey: 'D:/session.jsonl',
      sessionFile: 'D:/session.jsonl',
      fromSessionId: 'pi-session-1',
    })

    expect(outcome).toMatchObject({
      ok: false,
      error: { code, message: expect.stringContaining(expected) },
    })
    if (!outcome.ok) {
      expect(outcome.error.message).not.toContain(excluded)
      expect(outcome.error.message).not.toMatch(/[A-Z]:[\\/]/)
    }
  })
})
