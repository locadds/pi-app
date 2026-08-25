import { describe, expect, it, vi } from 'vitest'

import type { WorkerHostToolRequestV1 } from '@shared/worker-host-tools'

import { createXiaoguiWorkerHostToolRouterV1 } from './worker-host-tool-router'

const metadata = (request: WorkerHostToolRequestV1) => ({
  request,
  fromCwd: 'D:/project',
  fromPoolKey: 'D:/session.jsonl',
  sessionFile: 'D:/session.jsonl',
  fromSessionId: 'session-1',
})

describe('xiaogui Worker host-tool router', () => {
  it('keeps collaboration, all WORK DOCX contracts, and document snapshot on one seam', async () => {
    const collaboration = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_COLLABORATION_DRAFT_CREATED' as const, taskCount: 1, sessionVersion: 1 },
    }))
    const workDocx = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED' as const },
    }))
    const workDocxTemplateData = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED' as const },
    }))
    const workDocxTemplateIntake = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_SELECTION_CANCELLED' as const },
    }))
    const workDocxTemplateMaterialize = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_CANCELLED' as const },
    }))
    const workDocumentSnapshot = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_WORK_DOCUMENT_SELECTION_CANCELLED' as const },
    }))
    const router = createXiaoguiWorkerHostToolRouterV1({
      collaboration,
      workDocx,
      workDocxTemplateData,
      workDocxTemplateIntake,
      workDocxTemplateMaterialize,
      workDocumentSnapshot,
    })
    const collaborationRequest: WorkerHostToolRequestV1 = {
      type: 'host-tool-request',
      requestId: 'collaboration-1',
      method: 'xiaogui.collaboration.create-plan-draft',
      payload: {
        sourceSessionId: 'session-1',
        sourceTurnId: 'turn-1',
        toolCallId: 'call-1',
        draft: { objective: '完成汇报', tasks: [{ taskKey: 'draft', title: '起草' }] },
      },
    }
    const workRequest: WorkerHostToolRequestV1 = {
      type: 'host-tool-request',
      requestId: 'work-1',
      method: 'xiaogui.work.docx.v1',
      payload: {
        action: 'PREPARE',
        sourceSessionId: 'session-1',
        sourceRunId: 'run-1',
        toolCallId: 'call-2',
      },
    }
    const snapshotRequest: WorkerHostToolRequestV1 = {
      type: 'host-tool-request',
      requestId: 'snapshot-1',
      method: 'xiaogui.work.document-snapshot.v1',
      payload: {
        action: 'READ_PDF',
        sourceSessionId: 'session-1',
        sourceRunId: 'run-1',
        toolCallId: 'call-3',
      },
    }
    const templateDataRequest: WorkerHostToolRequestV1 = {
      type: 'host-tool-request',
      requestId: 'template-data-1',
      method: 'xiaogui.work.docx-template-data.v1',
      payload: {
        action: 'SELECT_TEMPLATE',
        sourceSessionId: 'session-1',
        sourceRunId: 'run-1',
        toolCallId: 'call-4',
      },
    }
    const templateIntakeRequest: WorkerHostToolRequestV1 = {
      type: 'host-tool-request',
      requestId: 'template-intake-1',
      method: 'xiaogui.work.docx-template-intake.v1',
      payload: {
        action: 'START',
        sourceSessionId: 'session-1',
        sourceRunId: 'run-1',
        toolCallId: 'call-5',
      },
    }
    const templateMaterializeRequest: WorkerHostToolRequestV1 = {
      type: 'host-tool-request',
      requestId: 'template-materialize-1',
      method: 'xiaogui.work.docx-template-materialize.v1',
      payload: {
        action: 'CANCEL',
        sourceSessionId: 'session-1',
        sourceRunId: 'run-2',
        toolCallId: 'call-6',
      },
    }

    await router(metadata(collaborationRequest))
    await router(metadata(workRequest))
    await router(metadata(templateDataRequest))
    await router(metadata(templateIntakeRequest))
    await router(metadata(templateMaterializeRequest))
    await router(metadata(snapshotRequest))

    expect(collaboration).toHaveBeenCalledOnce()
    expect(workDocx).toHaveBeenCalledOnce()
    expect(workDocxTemplateData).toHaveBeenCalledOnce()
    expect(workDocxTemplateIntake).toHaveBeenCalledOnce()
    expect(workDocxTemplateMaterialize).toHaveBeenCalledOnce()
    expect(workDocumentSnapshot).toHaveBeenCalledOnce()
    expect(collaboration).toHaveBeenCalledWith(metadata(collaborationRequest))
    expect(workDocx).toHaveBeenCalledWith(metadata(workRequest))
    expect(workDocxTemplateData).toHaveBeenCalledWith(metadata(templateDataRequest))
    expect(workDocxTemplateIntake).toHaveBeenCalledWith(metadata(templateIntakeRequest))
    expect(workDocxTemplateMaterialize).toHaveBeenCalledWith(metadata(templateMaterializeRequest))
    expect(workDocumentSnapshot).toHaveBeenCalledWith(metadata(snapshotRequest))
  })
})
