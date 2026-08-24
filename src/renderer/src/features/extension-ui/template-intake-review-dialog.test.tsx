import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  TemplateIntakeCandidateV1,
  TemplateIntakeReviewRequestV1,
  TemplateIntakeReviewResultV1,
} from '@shared/xiaogui-work-docx-template-intake'

vi.mock('@renderer/components/icons', () => ({
  FileText: () => null,
  AlertTriangle: () => null,
  Search: () => null,
  ChevronLeft: () => null,
  ChevronRight: () => null,
  X: () => null,
}))

import {
  TemplateIntakeReviewDialog,
  clearTemplateIntakeDraft,
  formatSourceAnchor,
  initialTemplateIntakeDecisions,
} from './template-intake-review-dialog'

const REQUEST_ID = 'req-test'

function makeCandidate(id: string, over: Partial<TemplateIntakeCandidateV1> = {}): TemplateIntakeCandidateV1 {
  return {
    candidateId: id,
    kind: over.defaultDecision ?? 'FIXED',
    preview: `预览内容 ${id}`,
    sourceAnchors: [{ part: 'BODY', sectionIndex: 1, paragraphIndex: 3 }],
    reason: `识别理由 ${id}`,
    confidence: 0.9,
    riskFlags: [],
    defaultDecision: 'FIXED',
    ...over,
  }
}

function makePayload(
  candidates: TemplateIntakeCandidateV1[],
  draftDecisions: TemplateIntakeReviewRequestV1['draftDecisions'] = [],
): TemplateIntakeReviewRequestV1 {
  return {
    report: {
      reportVersion: 1,
      reportId: 'report-1',
      status: 'REVIEWING',
      file: { displayName: '模板示例.docx', sha256: 'sha', byteLength: 123 },
      profile: {
        pageCount: { value: 3, basis: 'ACTUAL_RENDERING' },
        sectionCount: 1,
        headerPartCount: 0,
        footerPartCount: 0,
        tableCount: 0,
        mediaCount: 0,
        inlineDrawingCount: 0,
        floatingDrawingCount: 0,
        textBoxCount: 0,
        fieldCount: 0,
        contentControlCount: 0,
        scannedPageCount: null,
      },
      versions: { safetyGate: 'v', structureParser: 'v', semanticParser: 'v', rules: 'v', model: null },
      warnings: [],
      candidates,
      requiresHumanConfirmation: true,
      canMaterializeTemplate: false,
      createdAt: '2026-08-24T00:00:00Z',
      updatedAt: '2026-08-24T00:00:00Z',
    },
    draftDecisions,
    pageSize: 20,
  }
}

function renderDialog(payload: TemplateIntakeReviewRequestV1) {
  const onSubmit = vi.fn<(r: TemplateIntakeReviewResultV1) => void>()
  const onSuspend = vi.fn()
  const onCancel = vi.fn()
  const utils = render(
    <TemplateIntakeReviewDialog
      requestId={REQUEST_ID}
      payload={payload}
      onSubmit={onSubmit}
      onSuspend={onSuspend}
      onCancel={onCancel}
    />,
  )
  return { onSubmit, onSuspend, onCancel, ...utils }
}

beforeEach(() => {
  cleanup()
  clearTemplateIntakeDraft(REQUEST_ID)
})

describe('formatSourceAnchor（无路径来源位置）', () => {
  it('把锚点转成中文逻辑位置，不含任何路径或 OOXML', () => {
    expect(formatSourceAnchor({ part: 'BODY', sectionIndex: 1, paragraphIndex: 3 })).toBe(
      '正文 · 第 1 节 · 第 3 段',
    )
    expect(formatSourceAnchor({ part: 'TABLE', tableIndex: 2, rowIndex: 1, cellIndex: 2 })).toBe(
      '表格 · 表格 2 · 第 1 行 · 第 2 列',
    )
    expect(formatSourceAnchor({ part: 'HEADER', partIndex: 1 })).toBe('页眉 · 片段 1')
  })
})

describe('高风险默认排除', () => {
  it('带风险标记的候选即使默认决定是 FIXED 也初始为 EXCLUDE', () => {
    const payload = makePayload([
      makeCandidate('hr', { defaultDecision: 'FIXED', riskFlags: ['SEAL'] }),
    ])
    const state = initialTemplateIntakeDecisions(payload)
    expect(state.hr.decision).toBe('EXCLUDE')
  })
})

describe('分组与分页', () => {
  it('每页 20 项，可翻页；分组与关键词筛选生效', () => {
    const candidates = Array.from({ length: 25 }, (_, i) => makeCandidate(`c${i + 1}`))
    const { getByTestId, queryByTestId, getByLabelText } = renderDialog(makePayload(candidates))

    // 第 1 页 20 项
    expect(queryByTestId('candidate-c20')).toBeTruthy()
    expect(queryByTestId('candidate-c21')).toBeNull()

    // 翻到第 2 页剩 5 项
    fireEvent.click(getByTestId('page-next'))
    expect(queryByTestId('candidate-c21')).toBeTruthy()
    expect(queryByTestId('candidate-c25')).toBeTruthy()
    expect(queryByTestId('candidate-c1')).toBeNull()

    // 分组筛选：没有 VARIABLE，切到该分组为空
    fireEvent.click(getByTestId('group-VARIABLE'))
    expect(queryByTestId('candidate-c1')).toBeNull()
    fireEvent.click(getByTestId('group-FIXED'))
    expect(queryByTestId('candidate-c1')).toBeTruthy()

    // 关键词筛选
    fireEvent.change(getByLabelText('按关键词筛选'), { target: { value: 'c7' } })
    expect(queryByTestId('candidate-c7')).toBeTruthy()
    expect(queryByTestId('candidate-c8')).toBeNull()
  })

  it('展示预览、无路径来源、理由、置信度与当前决定', () => {
    renderDialog(makePayload([makeCandidate('c1')]))
    expect(screen.getByText('预览内容 c1')).toBeTruthy()
    expect(screen.getByText(/来源：正文 · 第 1 节 · 第 3 段/)).toBeTruthy()
    expect(screen.getByText(/理由：识别理由 c1/)).toBeTruthy()
    expect(screen.getByText(/置信度：90%/)).toBeTruthy()
    expect(screen.getByTestId('decision-c1-FIXED').className).toContain('bg-primary/10')
  })
})

describe('批量决定展开为逐项记录', () => {
  it('批量设置作用于当前筛选结果，提交时逐项展开且不遗漏不新增', () => {
    const payload = makePayload([
      makeCandidate('c1', { defaultDecision: 'UNRESOLVED', confidence: null }),
      makeCandidate('c2', { defaultDecision: 'UNRESOLVED', confidence: null }),
      makeCandidate('c3', { defaultDecision: 'UNRESOLVED', confidence: null }),
    ])
    const { getByTestId, onSubmit } = renderDialog(payload)

    fireEvent.click(getByTestId('batch-FIXED'))
    fireEvent.click(getByTestId('submit-review'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const result = onSubmit.mock.calls[0][0]
    expect(result.cancelled).toBe(false)
    if (result.cancelled) return
    expect(result.decisions).toHaveLength(3)
    expect(result.decisions.map((d) => d.candidateId)).toEqual(['c1', 'c2', 'c3'])
    expect(result.decisions.every((d) => d.decision === 'FIXED')).toBe(true)
  })
})

describe('无法判断禁提交', () => {
  it('存在 UNRESOLVED 时提示剩余数量并禁止提交', () => {
    const payload = makePayload([
      makeCandidate('c1', { defaultDecision: 'UNRESOLVED', confidence: null }),
    ])
    const { getByTestId, onSubmit } = renderDialog(payload)

    expect(getByTestId('unresolved-hint').textContent).toContain('还有 1 项无法判断')
    const submit = getByTestId('submit-review') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(submit)
    expect(onSubmit).not.toHaveBeenCalled()

    // 逐项决定后可提交
    fireEvent.click(getByTestId('decision-c1-REPEAT'))
    expect((getByTestId('submit-review') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(getByTestId('submit-review'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const result = onSubmit.mock.calls[0][0]
    if (!result.cancelled) {
      expect(result.decisions[0]).toEqual({ candidateId: 'c1', decision: 'REPEAT' })
    }
  })
})

describe('高风险覆盖理由与二次确认', () => {
  const payload = () =>
    makePayload([makeCandidate('hr', { defaultDecision: 'EXCLUDE', riskFlags: ['SEAL', 'SIGNATURE'] })])

  it('从 EXCLUDE 改为其他决定必须填写覆盖理由', () => {
    const { getByTestId, getByLabelText, onSubmit } = renderDialog(payload())

    fireEvent.click(getByTestId('decision-hr-FIXED'))
    fireEvent.click(getByTestId('submit-review'))
    expect(getByTestId('submit-error').textContent).toContain('覆盖理由')
    expect(onSubmit).not.toHaveBeenCalled()

    // 填写理由后进入二次确认，仍未返回
    fireEvent.change(getByLabelText('覆盖理由 hr'), { target: { value: '确认是本次项目新印章页' } })
    fireEvent.click(getByTestId('submit-review'))
    expect(getByTestId('second-confirm-ok')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()

    // 返回修改不产生结果
    fireEvent.click(getByTestId('second-confirm-back'))
    expect(onSubmit).not.toHaveBeenCalled()

    // 再次提交并明确二次确认后才返回，且写入 highRiskOverrideConfirmed
    fireEvent.click(getByTestId('submit-review'))
    fireEvent.click(getByTestId('second-confirm-ok'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const result = onSubmit.mock.calls[0][0]
    expect(result.cancelled).toBe(false)
    if (!result.cancelled) {
      expect(result.decisions[0]).toEqual({
        candidateId: 'hr',
        decision: 'FIXED',
        highRiskOverrideReason: '确认是本次项目新印章页',
        highRiskOverrideConfirmed: true,
      })
    }
  })

  it('高风险保持 EXCLUDE 时无需理由与二次确认', () => {
    const { getByTestId, onSubmit } = renderDialog(payload())
    fireEvent.click(getByTestId('submit-review'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const result = onSubmit.mock.calls[0][0]
    if (!result.cancelled) {
      expect(result.decisions[0]).toEqual({ candidateId: 'hr', decision: 'EXCLUDE' })
    }
  })
})

describe('VARIABLE 字段名', () => {
  it('改为可变字段时可编辑字段名并随结果返回', () => {
    const payload = makePayload([makeCandidate('v1', { suggestedName: '项目名称' })])
    const { getByTestId, getByLabelText, onSubmit } = renderDialog(payload)

    fireEvent.click(getByTestId('decision-v1-VARIABLE'))
    const input = getByLabelText('字段名 v1') as HTMLInputElement
    expect(input.value).toBe('项目名称')
    fireEvent.change(input, { target: { value: '合同编号' } })
    fireEvent.click(getByTestId('submit-review'))

    const result = onSubmit.mock.calls[0][0]
    if (!result.cancelled) {
      expect(result.decisions[0]).toEqual({
        candidateId: 'v1',
        decision: 'VARIABLE',
        fieldName: '合同编号',
      })
    }
  })

  it('没有建议名时必须填写字段名才能提交', () => {
    const payload = makePayload([makeCandidate('v2', { suggestedName: undefined })])
    const { getByTestId, onSubmit } = renderDialog(payload)
    fireEvent.click(getByTestId('decision-v2-VARIABLE'))
    fireEvent.click(getByTestId('submit-review'))
    expect(getByTestId('submit-error').textContent).toContain('字段名')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('挂起不 respond，恢复保留卡内草稿', () => {
  it('「稍后」、Esc 只挂起；恢复后草稿保留；放弃才清除', () => {
    const payload = makePayload([makeCandidate('c1', { defaultDecision: 'UNRESOLVED', confidence: null })])
    const first = renderDialog(payload)

    fireEvent.click(first.getByTestId('decision-c1-VARIABLE'))
    fireEvent.change(first.getByLabelText('字段名 c1'), { target: { value: '甲方名称' } })

    // 「稍后」：挂起，不 respond
    fireEvent.click(first.getByText('稍后'))
    expect(first.onSuspend).toHaveBeenCalledTimes(1)
    expect(first.onSubmit).not.toHaveBeenCalled()

    // Esc：同样只挂起
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(first.onSuspend).toHaveBeenCalledTimes(2)
    expect(first.onSubmit).not.toHaveBeenCalled()

    // 恢复（重新挂载同一 requestId）：草稿保留
    first.unmount()
    const second = renderDialog(payload)
    expect(second.getByTestId('decision-c1-VARIABLE').className).toContain('bg-primary/10')
    expect((second.getByLabelText('字段名 c1') as HTMLInputElement).value).toBe('甲方名称')

    // 放弃复核：把当前决定作为逐项草稿回传主进程，再清除渲染层临时副本
    fireEvent.click(second.getByText('关闭并保存草稿'))
    expect(second.onCancel).toHaveBeenCalledTimes(1)
    expect(second.onCancel).toHaveBeenCalledWith({
      cancelled: true,
      draftDecisions: [
        { candidateId: 'c1', decision: 'VARIABLE', fieldName: '甲方名称' },
      ],
    })
    second.unmount()
    const third = renderDialog(payload)
    expect(third.getByTestId('unresolved-hint').textContent).toContain('还有 1 项无法判断')
  })
})
