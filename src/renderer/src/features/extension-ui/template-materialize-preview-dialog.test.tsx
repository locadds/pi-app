import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TemplateMaterializePlanV1 } from '@shared/xiaogui-work-docx-template-materialize'
import { ipcClient } from '@renderer/lib/ipc-client'
import {
  TemplateMaterializePreviewDialog,
  type TemplateMaterializePreviewPayloadV1,
} from './template-materialize-preview-dialog'

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn() },
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      getPage: vi.fn(async () => ({
        getViewport: () => ({ width: 600, height: 800 }),
        render: () => ({ promise: Promise.resolve() }),
        cleanup: vi.fn(),
      })),
    }),
    destroy: vi.fn(async () => undefined),
  })),
}))

const invoke = vi.mocked(ipcClient.invoke)

const plan: TemplateMaterializePlanV1 = {
  materializeVersion: 1,
  reportSummary: {
    reportId: 'report-1',
    fileDisplayName: '原文档.docx',
    fileSha256: 'a'.repeat(64),
    candidateCount: 2,
    warningCount: 0,
  },
  source: { displayName: '原文档.docx', sha256: 'a'.repeat(64), byteLength: 1024 },
  previewSha256: 'b'.repeat(64),
  variables: [],
  repeatBlocks: [],
  conditionalBlocks: [],
  excludedCandidateCount: 1,
  removedMediaCount: 0,
  retainedHighRiskCount: 0,
  warnings: [],
  requiresSecondConfirmation: true,
  originalSourceUnchanged: true,
  advancedGenerationRequired: false,
}

const payload: TemplateMaterializePreviewPayloadV1 = {
  previewVersion: 1,
  plan,
  suggestedTemplateName: '原文档模板',
  document: {
    reviewVersion: 2,
    reviewId: 'preview-1',
    status: 'PREVIEWING',
    source: { displayName: '原文档-模板.docx', sha256: plan.previewSha256, byteLength: 2048, inputFormat: 'DOCX' },
    render: {
      mode: 'PDF',
      pageCount: 2,
      pages: [
        { pageNumber: 1, pageToken: 'preview-page-1', widthPoints: 600, heightPoints: 800, textLayerAvailable: true },
        { pageNumber: 2, pageToken: 'preview-page-2', widthPoints: 600, heightPoints: 800, textLayerAvailable: true },
      ],
      warnings: [],
    },
    targetCount: 0,
    pendingTargetCount: 0,
    resolvedTargetCount: 0,
    unmappedTargetCount: 0,
    requiresHumanConfirmation: true,
    sourceReadOnly: true,
    createdAt: '2026-08-28T10:00:00+08:00',
    updatedAt: '2026-08-28T10:00:00+08:00',
  },
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (_method, request) => ({
    pageNumber: request.pageToken === 'preview-page-2' ? 2 : 1,
    pdfBytes: new Uint8Array([1, 2, 3]),
    text: '',
  }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TemplateMaterializePreviewDialog', () => {
  it('renders the in-app preview and exposes only the two final decision actions', async () => {
    const onResult = vi.fn()
    render(<TemplateMaterializePreviewDialog payload={payload} onResult={onResult} />)

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'xiaogui.templateReview.page.read',
      { pageToken: 'preview-page-1' },
    ))
    await waitFor(() => expect(screen.getByText('已检查 1 / 2 页')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '生成正式模板' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '需要修改' })).toBeDisabled()
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument()
  })

  it('returns to review with the exact preview digest', async () => {
    const user = userEvent.setup()
    const onResult = vi.fn()
    render(<TemplateMaterializePreviewDialog payload={payload} onResult={onResult} />)

    await user.type(screen.getByPlaceholderText('输入要修改的内容，再点“需要修改”'), '把日期设为待填写内容')
    await user.click(screen.getByRole('button', { name: '需要修改' }))
    expect(onResult).toHaveBeenCalledWith({
      action: 'MODIFY',
      previewSha256: plan.previewSha256,
      instruction: '把日期设为待填写内容',
    })
  })

  it('navigates by opaque page token and confirms the same rendered candidate', async () => {
    const user = userEvent.setup()
    const onResult = vi.fn()
    render(<TemplateMaterializePreviewDialog payload={payload} onResult={onResult} />)
    await waitFor(() => expect(screen.getByText('已检查 1 / 2 页')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '生成正式模板' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'xiaogui.templateReview.page.read',
      { pageToken: 'preview-page-2' },
    ))
    await waitFor(() => expect(screen.getByText('已检查 2 / 2 页')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: '生成正式模板' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '生成正式模板' }))

    expect(onResult).toHaveBeenCalledWith({
      action: 'CONFIRM',
      previewSha256: plan.previewSha256,
    })
  })
})
