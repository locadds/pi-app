import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  TemplateReviewRequestV2,
  TemplateReviewTargetV2,
} from '@shared/xiaogui-work-template-review'
import { ipcClient } from '@renderer/lib/ipc-client'
import { TemplateReviewV2Dialog } from './template-review-v2-dialog'

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

function target(overrides: Partial<TemplateReviewTargetV2> = {}): TemplateReviewTargetV2 {
  return {
    targetId: 'target-1',
    kind: 'TEXT',
    preview: '甲乙丙丁',
    sourceAnchor: { part: 'BODY', paragraphIndex: 1 },
    pageRegions: [{ pageNumber: 1, x: 20, y: 30, width: 120, height: 18 }],
    reason: '模型无法确定，需要人工复核',
    confidence: 0.4,
    riskFlags: ['LOW_CONFIDENCE'],
    highlight: 'YELLOW',
    status: 'PENDING',
    highRisk: false,
    ...overrides,
  }
}

function request(
  targets: readonly TemplateReviewTargetV2[],
  mode: 'PDF' | 'STRUCTURED_FALLBACK' = 'STRUCTURED_FALLBACK',
): TemplateReviewRequestV2 {
  return {
    reviewVersion: 2,
    document: {
      reviewVersion: 2,
      reviewId: 'review-1',
      status: 'REVIEWING',
      source: {
        displayName: '测试文档.docx',
        sha256: 'a'.repeat(64),
        byteLength: 1024,
        inputFormat: 'DOCX',
      },
      render: {
        mode,
        pageCount: 2,
        pages: mode === 'PDF'
          ? [
              { pageNumber: 1, pageToken: 'page-token-1', widthPoints: 600, heightPoints: 800, textLayerAvailable: true },
              { pageNumber: 2, pageToken: 'page-token-2', widthPoints: 600, heightPoints: 800, textLayerAvailable: true },
            ]
          : [],
        warnings: [],
      },
      targetCount: targets.length,
      pendingTargetCount: targets.length,
      resolvedTargetCount: 0,
      unmappedTargetCount: 0,
      requiresHumanConfirmation: true,
      sourceReadOnly: true,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    },
    targets,
    draftActions: [],
  }
}

function renderDialog(payload: TemplateReviewRequestV2, requestId: string) {
  const onSubmit = vi.fn()
  const onSuspend = vi.fn()
  const onCancel = vi.fn()
  render(
    <TemplateReviewV2Dialog
      requestId={requestId}
      payload={payload}
      onSubmit={onSubmit}
      onSuspend={onSuspend}
      onCancel={onCancel}
    />,
  )
  return { onSubmit, onSuspend, onCancel }
}

beforeEach(() => {
  invoke.mockReset()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TemplateReviewV2Dialog', () => {
  it('opens on the first pending target page and submits an explicit decision', async () => {
    const user = userEvent.setup()
    const laterTarget = target({ pageRegions: [{ pageNumber: 2, x: 20, y: 30, width: 120, height: 18 }] })
    const { onSubmit } = renderDialog(request([laterTarget]), 'request-page')

    expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '完成复核并预览' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '原样保留' }))
    await user.click(screen.getByRole('button', { name: '完成复核并预览' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      cancelled: false,
      actions: [{ targetId: 'target-1', kind: 'KEEP' }],
    }))
  })

  it('requires a reason and second confirmation before retaining high-risk content', async () => {
    const user = userEvent.setup()
    const highRisk = target({ highRisk: true, riskFlags: ['SIGNATURE'], reason: '疑似签字内容' })
    const { onSubmit } = renderDialog(request([highRisk]), 'request-risk')

    await user.click(screen.getByRole('button', { name: '原样保留' }))
    expect(screen.getByText('此处属于高风险内容，保留或修改前请填写原因。')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('保留或修改此高风险内容的原因'), '本模板必须保留签字栏结构')
    await user.click(screen.getByRole('button', { name: '原样保留' }))
    await user.click(screen.getByRole('button', { name: '完成复核并预览' }))
    expect(screen.getByText('再次确认高风险内容')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '确认并进入整份预览' }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      actions: [expect.objectContaining({
        kind: 'KEEP',
        highRiskOverrideReason: '本模板必须保留签字栏结构',
        highRiskOverrideConfirmed: true,
      })],
    }))
  })

  it('stores an opaque replacement token when the user replaces an image', async () => {
    const user = userEvent.setup()
    invoke.mockResolvedValue({ cancelled: false, token: 'opaque-image-token', displayName: '新示意图.png' })
    const imageTarget = target({ kind: 'IMAGE', preview: '项目区位图' })
    const { onSubmit } = renderDialog(request([imageTarget]), 'request-image')

    await user.click(screen.getByRole('button', { name: '修改' }))
    expect(await screen.findByRole('button', { name: '新示意图.png' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存' }))
    await user.click(screen.getByRole('button', { name: '完成复核并预览' }))

    expect(invoke).toHaveBeenCalledWith('xiaogui.templateReview.image.choose')
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      actions: [{ targetId: 'target-1', kind: 'REPLACE_IMAGE', replacementImageToken: 'opaque-image-token' }],
    }))
  })

  it('records the selected UTF-16 range for a split-and-modify action', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderDialog(request([target()]), 'request-range')
    const previews = screen.getAllByText('甲乙丙丁')
    const reviewText = previews.at(-1)
    expect(reviewText?.firstChild).toBeTruthy()

    const range = document.createRange()
    range.setStart(reviewText!.firstChild!, 1)
    range.setEnd(reviewText!.firstChild!, 3)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.mouseUp(reviewText!)

    expect(screen.getByText(/所选范围以外会原样保留/)).toHaveTextContent('乙丙')
    await user.click(screen.getByRole('button', { name: '拆分后修改' }))
    const editBox = screen.getByPlaceholderText('填写修改后的内容')
    await user.clear(editBox)
    await user.type(editBox, '新内容')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await user.click(screen.getByRole('button', { name: '完成复核并预览' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      actions: [{
        targetId: 'target-1',
        kind: 'REPLACE_TEXT',
        range: { startUtf16: 1, endUtf16Exclusive: 3 },
        replacementText: '新内容',
      }],
    }))
  })

  it('loads a PDF page through an opaque token and keeps yellow regions clickable', async () => {
    const user = userEvent.setup()
    invoke.mockResolvedValue({ pageNumber: 1, pdfBytes: new Uint8Array([1, 2, 3]), text: '甲乙丙丁' })
    renderDialog(request([target()], 'PDF'), 'request-pdf')

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'xiaogui.templateReview.page.read',
      { pageToken: 'page-token-1' },
    ))
    const region = screen.getByRole('button', { name: '复核：甲乙丙丁' })
    await user.click(region)
    expect(screen.getByText('模型无法确定，需要人工复核')).toBeInTheDocument()
  })
})
