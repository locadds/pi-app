import { describe, expect, it, vi } from 'vitest'

import type { WorkerHostToolRequestV1 } from '@shared/worker-host-tools'
import type { WorkDocxOperationIdV1 } from '@shared/xiaogui-work-docx'

import type { SessionScopeResolverV1 } from './scope-resolver'
import type { PiSessionScopeV1 } from './scope-derive'
import {
  createXiaoguiWorkDocxTemplateDataWorkerToolHandlerV1,
  type WorkDocxTemplateDataWorkerToolServiceV1,
} from './work-docx-template-data-worker-tool'
import type { WorkDocxTemplateSelectionIdV1 } from './work-docx-service'

const PROJECT = `xgp1_${'1'.repeat(64)}`
const SESSION = `xgs1_${'2'.repeat(64)}`
const SELECTION = 'xgws1_00000000-0000-4000-8000-000000000001' as WorkDocxTemplateSelectionIdV1
const OPERATION = 'xgw1_00000000-0000-4000-8000-000000000002' as WorkDocxOperationIdV1

function request(
  action: 'SELECT_TEMPLATE' | 'PREPARE' | 'CONFIRM' | 'CANCEL' | 'OPEN' | 'REVEAL',
  sourceRunId: string,
  fields?: Extract<WorkerHostToolRequestV1, { method: 'xiaogui.work.docx-template-data.v1' }>['payload']['fields'],
): WorkerHostToolRequestV1 {
  return {
    type: 'host-tool-request',
    requestId: `host-${action}`,
    method: 'xiaogui.work.docx-template-data.v1',
    payload: {
      action,
      ...(fields ? { fields } : {}),
      sourceSessionId: 'pi-session-1',
      sourceRunId,
      toolCallId: `call-${action}`,
    },
  }
}

function setup() {
  const scope: PiSessionScopeV1 = {
    projectId: PROJECT as never,
    sessionKey: SESSION as never,
    sessionMode: 'WORK',
    rootPath: 'D:/project',
    sessionFile: 'D:/session.jsonl',
  }
  const selectTemplate = vi.fn(async () => ({
    ok: true as const,
    value: {
      kind: 'TEMPLATE_SELECTED' as const,
      selectionId: SELECTION,
      templateDisplayName: '模板.docx',
      templateSha256: 'a'.repeat(64),
      fields: [{ name: 'title', required: true as const, occurrences: 1, locations: ['正文' as const] }],
      profile: {
        bodyPartCount: 1 as const,
        sectionCount: 1,
        headerPartCount: 0,
        footerPartCount: 0,
        inlineDrawingCount: 0,
        floatingDrawingCount: 0,
        mediaCount: 0,
        fieldCount: 0,
      },
    },
  }))
  const prepareTemplateData = vi.fn(async () => ({
    ok: true as const,
    value: {
      kind: 'PREPARED' as const,
      operationId: OPERATION,
      templateDisplayName: '模板.docx',
      fields: ['title'],
      templateSha256: 'a'.repeat(64),
      dataSha256: 'b'.repeat(64),
    },
  }))
  const confirmTemplateData = vi.fn(async () => ({
    ok: true as const,
    value: {
      kind: 'PUBLISHED' as const,
      operationId: OPERATION,
      outputSha256: 'c'.repeat(64),
      templateSha256: 'a'.repeat(64),
      dataSha256: 'b'.repeat(64),
      originalInputsUnchanged: true as const,
    },
  }))
  const cancelTemplateSelection = vi.fn(async () => ({
    ok: true as const,
    value: { kind: 'CANCELLED' as const },
  }))
  const cancel = vi.fn(async () => ({
    ok: true as const,
    value: { kind: 'CANCELLED' as const, operationId: OPERATION },
  }))
  const accessOutput = vi.fn(async (input: { action: 'OPEN' | 'REVEAL' }) => ({
    ok: true as const,
    value: { kind: 'ACCESSED' as const, operationId: OPERATION, action: input.action },
  }))
  const service = {
    selectTemplate,
    prepareTemplateData,
    confirmTemplateData,
    cancelTemplateSelection,
    cancel,
    accessOutput,
  } as unknown as WorkDocxTemplateDataWorkerToolServiceV1
  const handler = createXiaoguiWorkDocxTemplateDataWorkerToolHandlerV1({
    scopeResolver: { resolveExisting: vi.fn(async () => scope) } as unknown as SessionScopeResolverV1,
    getService: () => service,
  })
  const metadata = (toolRequest: WorkerHostToolRequestV1) => ({
    request: toolRequest,
    fromCwd: 'D:/project',
    fromPoolKey: 'D:/session.jsonl',
    sessionFile: 'D:/session.jsonl',
    fromSessionId: 'pi-session-1',
  })
  return { handler, metadata, selectTemplate, prepareTemplateData, confirmTemplateData }
}

describe('WORK DOCX template-data Worker adapter', () => {
  it('returns only a safe field/profile summary after template selection', async () => {
    const test = setup()
    const outcome = await test.handler(test.metadata(request('SELECT_TEMPLATE', 'run-1')))

    expect(outcome).toMatchObject({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_SELECTED',
        templateDisplayName: '模板.docx',
        fields: [{ name: 'title' }],
      },
    })
    expect(JSON.stringify(outcome)).not.toContain('xgws1_')
    expect(JSON.stringify(outcome)).not.toContain('D:/')
  })

  it('blocks same-run confirmation and publishes only after the next user run', async () => {
    const test = setup()
    const fields = [{ name: 'title', status: 'READY' as const, value: '工作周报' }]
    await test.handler(test.metadata(request('SELECT_TEMPLATE', 'run-1')))
    const prepared = await test.handler(test.metadata(request('PREPARE', 'run-1', fields)))
    expect(prepared).toMatchObject({
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCX_PREPARED', dataSha256: 'b'.repeat(64) },
    })
    expect(JSON.stringify(prepared)).not.toContain('xgw1_')

    await expect(
      test.handler(test.metadata(request('CONFIRM', 'run-1'))),
    ).resolves.toMatchObject({ ok: false, error: { code: 'WORK_DOCX_CONFIRMATION_REQUIRED' } })
    expect(test.confirmTemplateData).not.toHaveBeenCalled()

    await expect(
      test.handler(test.metadata(request('CONFIRM', 'run-2'))),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: 'XIAOGUI_WORK_DOCX_PUBLISHED', dataSha256: 'b'.repeat(64) },
    })
    expect(test.prepareTemplateData).toHaveBeenCalledWith({
      address: { projectId: PROJECT, sessionKey: SESSION },
      selectionId: SELECTION,
      fields,
    })
  })

  it('never ignores revised fields while an older document is waiting for confirmation', async () => {
    const test = setup()
    await test.handler(test.metadata(request('SELECT_TEMPLATE', 'run-1')))
    await test.handler(
      test.metadata(
        request('PREPARE', 'run-1', [{ name: 'title', status: 'READY', value: '第一版' }]),
      ),
    )

    await expect(
      test.handler(
        test.metadata(
          request('PREPARE', 'run-2', [{ name: 'title', status: 'READY', value: '修改版' }]),
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'WORK_DOCX_OPERATION_ACTIVE', message: expect.stringContaining('先取消') },
    })
    expect(test.prepareTemplateData).toHaveBeenCalledOnce()
  })
})
