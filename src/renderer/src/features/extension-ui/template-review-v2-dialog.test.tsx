import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  TemplateReviewRequestV2,
  TemplateReviewRequestV3,
  TemplateReviewTargetV2,
  TemplateReviewTargetV3,
} from '@shared/xiaogui-work-template-review'
import type { TemplateDraftReviewRequestV2 } from '@shared/xiaogui-template-draft-review'
import { ipcClient } from '@renderer/lib/ipc-client'
import { TemplateReviewV2Dialog } from './template-review-v2-dialog'

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn() },
}))

vi.mock('@renderer/components/icons', () => ({
  AlertTriangle: () => <span data-testid="icon-alert" />,
  FileText: () => <span data-testid="icon-file" />,
  Search: () => <span data-testid="icon-search" />,
  X: () => <span data-testid="icon-close" />,
}))

vi.mock('docx-preview', () => ({
  renderAsync: vi.fn(async (_blob: Blob, body: HTMLElement) => {
    body.innerHTML = [
      '<div class="docx-wrapper"><section class="docx">',
      '<span id="xg_start_1"></span>甲乙丙丁<span id="xg_end_1"></span>',
      '</section></div>',
    ].join('')
  }),
}))

const invoke = vi.mocked(ipcClient.invoke)

function target(overrides: Partial<TemplateReviewTargetV2> = {}): TemplateReviewTargetV2 {
  return {
    targetId: 'target-1',
    kind: 'TEXT',
    preview: '甲乙丙丁',
    sourceAnchor: { part: 'BODY', paragraphIndex: 1 },
    pageRegions: [],
    reason: '模型无法确定，需要人工复核',
    confidence: 0.4,
    riskFlags: ['LOW_CONFIDENCE'],
    highlight: 'YELLOW',
    status: 'PENDING',
    highRisk: false,
    ...overrides,
  }
}

function targetV3(overrides: Partial<TemplateReviewTargetV3> = {}): TemplateReviewTargetV3 {
  return {
    ...target(overrides),
    renderAnchor: {
      status: 'PROJECTED',
      startBookmark: 'xg_start_1',
      endBookmark: 'xg_end_1',
      textSelectionAllowed: true,
      expectedTextSha256: '081eceef8c4885fb5b1c536efc36a27eac1c81e713f9abecafc521eea6b1f6d6',
      expectedTextLengthUtf16: 4,
    },
    ...overrides,
  }
}

function requestV2(targets: readonly TemplateReviewTargetV2[]): TemplateReviewRequestV2 {
  return {
    reviewVersion: 2,
    document: {
      reviewVersion: 2,
      reviewId: 'review-1',
      status: 'REVIEWING',
      source: { displayName: '测试文档.docx', sha256: 'a'.repeat(64), byteLength: 1024, inputFormat: 'DOCX' },
      render: { mode: 'STRUCTURED_FALLBACK', pageCount: null, pages: [], warnings: [] },
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

function requestV3(targets: readonly TemplateReviewTargetV3[]): TemplateReviewRequestV3 {
  return {
    reviewVersion: 3,
    document: {
      reviewVersion: 3,
      reviewId: 'review-3',
      status: 'REVIEWING',
      source: { displayName: '测试文档.docx', sha256: 'a'.repeat(64), byteLength: 1024, inputFormat: 'DOCX' },
      render: {
        mode: 'DOCX_HTML',
        documentToken: 'doc-token-1',
        paginationBasis: 'DOCX_STORED_BREAKS',
        approximatePageCount: 2,
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

function requestDraftV2(): TemplateDraftReviewRequestV2 {
  const advancedReview = requestV3([targetV3({
    highlight: 'YELLOW',
    reason: '项目名称需要确认',
  })])
  return {
    reviewVersion: 4,
    mode: 'QUICK',
    document: advancedReview.document,
    fieldGraph: {
      graphVersion: 2,
      graphId: 'graph-1',
      source: advancedReview.document.source,
      fields: [{
        fieldId: 'field-1',
        canonicalKey: 'project.name',
        displayName: '项目名称',
        valueType: 'TEXT',
        structureKind: 'SIMPLE',
        required: true,
        sampleValue: '甲乙丙丁',
        aliases: [],
        occurrenceIds: ['occurrence-1'],
        confidence: 0.8,
        status: 'NEEDS_REVIEW',
      }],
      occurrences: [{
        occurrenceId: 'occurrence-1',
        fieldId: 'field-1',
        sourceAnchor: { part: 'BODY', paragraphIndex: 1 },
        originalText: '甲乙丙丁',
        confidence: 0.8,
        riskFlags: [],
        status: 'MAPPED',
      }],
      issues: [{
        issueId: 'issue-1',
        kind: 'FIELD_AMBIGUOUS',
        severity: 'WARNING',
        title: '确认“项目名称”',
        question: '是否把这一处作为项目名称？',
        fieldIds: ['field-1'],
        occurrenceIds: ['occurrence-1'],
        suggestedActions: ['ACCEPT_SUGGESTION', 'KEEP_ORIGINAL', 'OPEN_ADVANCED_REVIEW'],
        status: 'OPEN',
      }],
      analysisEvidenceId: 'evidence-1',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    },
    targetBindings: [{
      targetId: 'target-1',
      fieldId: 'field-1',
      issueIds: ['issue-1'],
      recommendedAction: { targetId: 'target-1', kind: 'FIELD', fieldName: '项目名称' },
    }],
    recommendedActions: [{ targetId: 'target-1', kind: 'FIELD', fieldName: '项目名称' }],
    quickIssueLimit: 15,
    advancedReview,
  }
}

function renderDialog(payload: TemplateDraftReviewRequestV2 | TemplateReviewRequestV2 | TemplateReviewRequestV3, requestId: string) {
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
  invoke.mockImplementation(async (method) => {
    if (method === 'xiaogui.templateReview.document.read') {
      return { docxBytes: new Uint8Array([1, 2, 3]), sha256: 'b'.repeat(64) }
    }
    throw new Error(`UNEXPECTED_METHOD:${method}`)
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
describe('TemplateReviewV2Dialog', () => {
  it('默认展示业务字段和合并问题，技术候选只留在高级检查', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderDialog(requestDraftV2(), 'request-draft-v2')

    expect(screen.getByRole('heading', { name: '模板草稿' })).toBeInTheDocument()
    expect(screen.getByText('先确认模板要复用什么')).toBeInTheDocument()
    expect(screen.getByText('是否把这一处作为项目名称？')).toBeInTheDocument()
    expect(screen.queryByText('固定内容')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认字段草稿' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '按建议处理' }))
    await user.click(screen.getByRole('button', { name: '确认字段草稿' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      actions: [{ targetId: 'target-1', kind: 'FIELD', fieldName: '项目名称' }],
    }))
  })

  it('renders V3 through a DOCX document token and submits an explicit decision', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderDialog(requestV3([targetV3()]), 'request-docx')

    expect(screen.getByText('页面视图（近似分页） · 2 个页面段')).toBeInTheDocument()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'xiaogui.templateReview.document.read',
      { documentToken: 'doc-token-1' },
    ))
    expect(screen.getByRole('button', { name: '完成复核并预览' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '原样保留' }))
    await user.click(screen.getByRole('button', { name: '完成复核并预览' }))

    expect(invoke).not.toHaveBeenCalledWith('xiaogui.templateReview.page.read', expect.anything())
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      cancelled: false,
      actions: [{ targetId: 'target-1', kind: 'KEEP' }],
    }))
  })

  it('keeps the old V2 structured fallback usable without PDF page reads', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderDialog(requestV2([target()]), 'request-v2')

    expect(screen.getByText('结构化视图')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '原样保留' }))
    await user.click(screen.getByRole('button', { name: '完成复核并预览' }))

    expect(invoke).not.toHaveBeenCalledWith('xiaogui.templateReview.page.read', expect.anything())
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      actions: [{ targetId: 'target-1', kind: 'KEEP' }],
    }))
  })

  it('requires a reason and second confirmation before retaining high-risk content', async () => {
    const user = userEvent.setup()
    const highRisk = targetV3({ highRisk: true, riskFlags: ['SIGNATURE'], reason: '疑似签字内容' })
    const { onSubmit } = renderDialog(requestV3([highRisk]), 'request-risk')

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
})
