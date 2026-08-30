import '@testing-library/jest-dom/vitest'

import { createRef, forwardRef, useImperativeHandle } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OfficeSurfaceFieldV1, OfficeSurfaceOccurrenceV1 } from '@shared/xiaogui-office-surface'
import type { TemplateReviewTargetV3 } from '@shared/xiaogui-work-template-review'
import { ipcClient } from '@renderer/lib/ipc-client'
import {
  DocumentSurfaceViewerV1,
  type DocumentSurfaceViewerHandleV1,
} from './document-surface-viewer'

const htmlFocus = vi.fn<(targetId: string) => boolean>()
const htmlReadSelection = vi.fn(() => null)

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn() },
}))

vi.mock('@renderer/components/docx-html-viewer', () => ({
  DocxHtmlViewer: forwardRef(function MockDocxHtmlViewer(
    props: {
      targets?: readonly TemplateReviewTargetV3[]
      selectedId?: string
      readonlyLabel?: string
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({
      focus: htmlFocus,
      readSelection: htmlReadSelection,
      dispose: vi.fn(),
    }))
    return (
      <div
        data-testid="docx-html-fallback"
        data-selected-id={props.selectedId}
        data-target-count={props.targets?.length ?? 0}
      >
        {props.readonlyLabel}
      </div>
    )
  }),
}))

vi.mock('@renderer/features/office-surface/office-surface-frame', () => ({
  OfficeSurfaceFrameV1: () => <div data-testid="office-surface-frame" />,
}))

const invoke = vi.mocked(ipcClient.invoke)
const target = {
  targetId: 'target-image-1',
  kind: 'IMAGE',
  preview: '图片或图件 1',
  sourceAnchor: { part: 'DRAWING', drawingIndex: 1 },
  renderAnchor: {
    status: 'PROJECTED',
    startBookmark: 'image-start',
    endBookmark: 'image-end',
    textSelectionAllowed: false,
    objectSelectionAllowed: true,
  },
  reason: '图件需要人工确认',
  confidence: 1,
  riskFlags: ['OLD_PROJECT_DRAWING'],
  highlight: 'YELLOW',
  status: 'PENDING',
  highRisk: true,
} satisfies TemplateReviewTargetV3
const field = {
  fieldId: 'field:image',
  displayName: '待复核图片',
  occurrenceIds: ['occurrence:image'],
} satisfies OfficeSurfaceFieldV1
const occurrence = {
  occurrenceId: 'occurrence:image',
  fieldId: 'field:image',
  originalText: '图片或图件 1',
  sourceAnchor: { part: 'DRAWING', drawingIndex: 1 },
  state: 'WARNING',
} satisfies OfficeSurfaceOccurrenceV1

beforeEach(() => {
  invoke.mockReset()
  htmlFocus.mockReset()
  htmlFocus.mockReturnValue(true)
  htmlReadSelection.mockReset()
  htmlReadSelection.mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('DocumentSurfaceViewerV1 Office 失败回退', () => {
  it('Office Surface=OFF 时只显示现有 DOCX HTML 视图，并把 target 聚焦交给回退视图', async () => {
    invoke.mockResolvedValueOnce({ mode: 'OFF' })
    const ref = createRef<DocumentSurfaceViewerHandleV1>()
    render(
      <DocumentSurfaceViewerV1
        ref={ref}
        purpose="TEMPLATE_ADVANCED_REVIEW"
        documentToken="opaque-token"
        title="样例.docx"
        targets={[target]}
        selectedId="target-image-1"
        readonlyLabel="Office 失败后的只读预览"
      />,
    )

    const fallback = await screen.findByTestId('docx-html-fallback')
    expect(fallback).toHaveTextContent('Office 失败后的只读预览')
    expect(fallback).toHaveAttribute('data-selected-id', 'target-image-1')
    expect(fallback).toHaveAttribute('data-target-count', '1')
    expect(screen.queryByTestId('office-surface-frame')).not.toBeInTheDocument()
    expect(ref.current?.focusTarget('target-image-1')).toBe(true)
    expect(htmlFocus).toHaveBeenCalledWith('target-image-1')
  })

  it('Office session 启动失败后自动切到同一 DOCX HTML 回退视图', async () => {
    invoke
      .mockResolvedValueOnce({ mode: 'UNIVER_PREFERRED' })
      .mockRejectedValueOnce(new Error('gateway unavailable'))
    render(
      <DocumentSurfaceViewerV1
        purpose="TEMPLATE_ADVANCED_REVIEW"
        documentToken="opaque-token"
        title="样例.docx"
        targets={[target]}
      />,
    )

    await waitFor(() => expect(screen.getByTestId('docx-html-fallback')).toBeInTheDocument())
    expect(screen.getByText(/gateway unavailable/)).toBeInTheDocument()
    expect(screen.queryByTestId('office-surface-frame')).not.toBeInTheDocument()
  })

  it('HTML 回退视图把 occurrence/field 聚焦桥接到匹配 sourceAnchor 的 target', async () => {
    invoke.mockResolvedValueOnce({ mode: 'OFF' })
    const ref = createRef<DocumentSurfaceViewerHandleV1>()
    render(
      <DocumentSurfaceViewerV1
        ref={ref}
        purpose="TEMPLATE_ADVANCED_REVIEW"
        documentToken="opaque-token"
        title="样例.docx"
        fields={[field]}
        occurrences={[occurrence]}
        targets={[target]}
        activeOccurrenceId="occurrence:image"
      />,
    )

    await screen.findByTestId('docx-html-fallback')
    await waitFor(() => expect(htmlFocus).toHaveBeenCalledWith('target-image-1'))

    htmlFocus.mockClear()
    ref.current?.focusOccurrence('occurrence:image')
    expect(htmlFocus).toHaveBeenCalledWith('target-image-1')

    htmlFocus.mockClear()
    ref.current?.focusField('field:image')
    expect(htmlFocus).toHaveBeenCalledWith('target-image-1')
  })

  it('Office 正常启动时仍只显示 Univer，并保留全部普通和结构化导入告警', async () => {
    const structuredWarning = `XIAOGUI_DOCX_DRAWING_DEGRADATION_V1:${JSON.stringify({
      kind: 'XIAOGUI_DOCX_DRAWING_DEGRADATION',
      version: 1,
      id: 'body-0-1-unsupported_format',
      part: 'BODY',
      partIndex: 0,
      sequence: 1,
      severity: 'WARNING',
      reason: 'UNSUPPORTED_FORMAT',
      message: '正文图片使用暂不支持的 EMF。',
    })}`
    invoke
      .mockResolvedValueOnce({ mode: 'UNIVER_PREFERRED' })
      .mockResolvedValueOnce({
        sessionId: 'session-1',
        gatewayOrigin: 'http://127.0.0.1:3000',
        warnings: ['普通告警', structuredWarning, '第三条告警'],
        mappedOccurrenceIds: [],
      })
    render(
      <DocumentSurfaceViewerV1
        purpose="TEMPLATE_ADVANCED_REVIEW"
        documentToken="opaque-token"
        title="样例.docx"
      />,
    )

    expect(await screen.findByTestId('office-surface-frame')).toBeInTheDocument()
    expect(screen.queryByTestId('docx-html-fallback')).not.toBeInTheDocument()
    expect(screen.getByText('3 条导入提示（展开查看全部）')).toBeInTheDocument()
    expect(screen.getByText('普通告警')).toBeInTheDocument()
    expect(screen.getByText('正文图片使用暂不支持的 EMF。')).toBeInTheDocument()
    expect(screen.getByText('第三条告警')).toBeInTheDocument()
  })
})
