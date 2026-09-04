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
    const codingPlan = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_CODING_PLAN_DRAFT_SAVED' as const },
    }))
    const directCoding = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'DIRECT_CODING_PERMISSION_DENIED' as const,
        message: '测试拒绝',
      },
    }))
    const collaboration = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_COLLABORATION_DRAFT_CREATED' as const, taskCount: 1, sessionVersion: 1 },
    }))
    const workDocx = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_WORK_DOCX_SELECTION_CANCELLED' as const },
    }))
    const workReportDocx = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_WORK_REPORT_DOCX_CANCELLED' as const },
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
    const workDocxAdvancedGeneration = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_CANCELLED' as const },
    }))
    const workDocumentSnapshot = vi.fn(async () => ({
      ok: true as const,
      value: { kind: 'XIAOGUI_WORK_DOCUMENT_SELECTION_CANCELLED' as const },
    }))
    const workMaterials = vi.fn(async () => ({
      ok: true as const,
      value: {
        kind: 'XIAOGUI_WORK_MATERIALS_READY' as const,
        snapshot: {
          version: 'work-materials-snapshot.v1' as const,
          requestedPaths: ['D:/project'],
          totalFileCount: 0,
          totalDirectoryCount: 1,
          extractedFileCount: 0,
          metadataOnlyFileCount: 0,
          failedFileCount: 0,
          files: [],
          warnings: [],
          originalInputsUnchanged: true as const,
        },
      },
    }))
    const router = createXiaoguiWorkerHostToolRouterV1({
      codingPlan,
      directCoding,
      collaboration,
      workDocx,
      workReportDocx,
      workDocxTemplateData,
      workDocxTemplateIntake,
      workDocxTemplateMaterialize,
      workDocxAdvancedGeneration,
      workDocumentSnapshot,
      workMaterials,
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
    const codingPlanRequest: WorkerHostToolRequestV1 = {
      type: 'host-tool-request',
      requestId: 'coding-plan-1',
      method: 'xiaogui.coding.plan-draft.v1',
      payload: {
        sourceSessionId: 'session-1',
        sourceTurnId: 'turn-1',
        toolCallId: 'call-coding-plan',
        body: {
          objective: '修复登录回归',
          steps: [{ stepId: 'inspect', title: '定位问题', validation: '复现用例通过' }],
          constraints: ['只改项目内文件'],
        },
      },
    }
    const directCodingRequest: WorkerHostToolRequestV1 = {
      type: 'host-tool-request',
      requestId: 'direct-coding-1',
      method: 'xiaogui.coding.direct.preflight.v2',
      payload: {
        sourceSessionId: 'session-1',
        toolCallId: 'call-direct-1',
        requestDigest: `sha256:${'a'.repeat(64)}`,
        phase: 'EXECUTE',
        operation: 'WRITE',
        relativePath: 'src/a.ts',
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
    const materialsRequest: WorkerHostToolRequestV1 = {
      type: 'host-tool-request',
      requestId: 'materials-1',
      method: 'xiaogui.work.materials.v1',
      payload: {
        paths: ['D:/other'],
        sourceSessionId: 'session-1',
        sourceRunId: 'run-1',
        toolCallId: 'call-materials',
      },
    }
    const reportRequest: WorkerHostToolRequestV1 = {
      type: 'host-tool-request',
      requestId: 'report-1',
      method: 'xiaogui.work.report-docx.v1',
      payload: {
        action: 'CANCEL',
        sourceSessionId: 'session-1',
        sourceRunId: 'run-1',
        toolCallId: 'call-report',
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
    const advancedGenerationRequest: WorkerHostToolRequestV1 = {
      type: 'host-tool-request',
      requestId: 'advanced-generation-1',
      method: 'xiaogui.work.docx-advanced-generation.v1',
      payload: {
        action: 'CANCEL',
        sourceSessionId: 'session-1',
        sourceRunId: 'run-3',
        toolCallId: 'call-7',
      },
    }

    await router(metadata(codingPlanRequest))
    await router(metadata(directCodingRequest))
    await router(metadata(collaborationRequest))
    await router(metadata(workRequest))
    await router(metadata(reportRequest))
    await router(metadata(templateDataRequest))
    await router(metadata(templateIntakeRequest))
    await router(metadata(templateMaterializeRequest))
    await router(metadata(advancedGenerationRequest))
    await router(metadata(snapshotRequest))
    await router(metadata(materialsRequest))

    expect(codingPlan).toHaveBeenCalledOnce()
    expect(directCoding).toHaveBeenCalledOnce()
    expect(collaboration).toHaveBeenCalledOnce()
    expect(workDocx).toHaveBeenCalledOnce()
    expect(workReportDocx).toHaveBeenCalledOnce()
    expect(workDocxTemplateData).toHaveBeenCalledOnce()
    expect(workDocxTemplateIntake).toHaveBeenCalledOnce()
    expect(workDocxTemplateMaterialize).toHaveBeenCalledOnce()
    expect(workDocxAdvancedGeneration).toHaveBeenCalledOnce()
    expect(workDocumentSnapshot).toHaveBeenCalledOnce()
    expect(workMaterials).toHaveBeenCalledOnce()
    expect(codingPlan).toHaveBeenCalledWith(metadata(codingPlanRequest))
    expect(directCoding).toHaveBeenCalledWith(metadata(directCodingRequest))
    expect(collaboration).toHaveBeenCalledWith(metadata(collaborationRequest))
    expect(workDocx).toHaveBeenCalledWith(metadata(workRequest))
    expect(workReportDocx).toHaveBeenCalledWith(metadata(reportRequest))
    expect(workDocxTemplateData).toHaveBeenCalledWith(metadata(templateDataRequest))
    expect(workDocxTemplateIntake).toHaveBeenCalledWith(metadata(templateIntakeRequest))
    expect(workDocxTemplateMaterialize).toHaveBeenCalledWith(metadata(templateMaterializeRequest))
    expect(workDocxAdvancedGeneration).toHaveBeenCalledWith(metadata(advancedGenerationRequest))
    expect(workDocumentSnapshot).toHaveBeenCalledWith(metadata(snapshotRequest))
    expect(workMaterials).toHaveBeenCalledWith(metadata(materialsRequest))
  })
})
