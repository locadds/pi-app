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
  it('keeps collaboration, WORK DOCX, and WORK document snapshot on the same WorkerManager seam', async () => {
    const collaboration = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_COLLABORATION_DRAFT_CREATED' as const, taskCount: 1, sessionVersion: 1 },
    }))
    const workDocx = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED' as const },
    }))
    const workDocumentSnapshot = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_WORK_DOCUMENT_SELECTION_CANCELLED' as const },
    }))
    const router = createXiaoguiWorkerHostToolRouterV1({
      collaboration,
      workDocx,
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

    await router(metadata(collaborationRequest))
    await router(metadata(workRequest))
    await router(metadata(snapshotRequest))

    expect(collaboration).toHaveBeenCalledOnce()
    expect(workDocx).toHaveBeenCalledOnce()
    expect(workDocumentSnapshot).toHaveBeenCalledOnce()
    expect(collaboration).toHaveBeenCalledWith(metadata(collaborationRequest))
    expect(workDocx).toHaveBeenCalledWith(metadata(workRequest))
    expect(workDocumentSnapshot).toHaveBeenCalledWith(metadata(snapshotRequest))
  })
})
