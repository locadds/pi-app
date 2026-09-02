import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  TemplateLibraryPreviewV1,
  TemplateLibraryVersionSummaryV1,
} from '@shared/xiaogui-template-library'
import { ipcClient } from '@renderer/lib/ipc-client'
import { TemplateLibraryPreviewDialog } from './TemplateLibraryPreviewDialog'

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn() },
}))

vi.mock('@renderer/components/docx-html-viewer', () => ({
  DocxHtmlViewer: ({ documentToken }: { documentToken?: string }) => (
    <div data-testid="docx-library-preview" data-token={documentToken}>模板 DOCX 预览</div>
  ),
}))

const invoke = vi.mocked(ipcClient.invoke)
const manifestId = '8a11fa90-09dc-40da-aa18-3f1283350618'
const version: TemplateLibraryVersionSummaryV1 = {
  versionId: 'version-2',
  versionNumber: 2,
  sha256: 'a'.repeat(64),
  byteLength: 1024,
  fields: [],
  createdAt: '2026-08-28T10:00:00.000Z',
  isLatest: true,
}

function preview(mode: 'DOCX_HTML' | 'STRUCTURED_FALLBACK'): TemplateLibraryPreviewV1 {
  return {
    previewVersion: 1,
    manifestId,
    entryId: 'entry-1',
    entryName: '项目周报模板',
    versionId: version.versionId,
    versionNumber: version.versionNumber,
    render: mode === 'DOCX_HTML' ? {
      mode,
      documentToken: 'library-doc-token',
      paginationBasis: 'DOCX_STORED_BREAKS',
      approximatePageCount: 2,
      warnings: [],
    } : {
      mode,
      documentToken: undefined,
      paginationBasis: 'UNKNOWN',
      approximatePageCount: null,
      warnings: [
        { code: 'DOCX_HTML_RENDER_FAILED', message: '本机文档渲染失败，已切换为结构化复核视图' },
        { code: 'STRUCTURED_FALLBACK_ACTIVE', message: '所有无法定位的内容必须进入人工清单，不会静默遗漏' },
      ],
    },
  }
}

beforeEach(() => {
  invoke.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TemplateLibraryPreviewDialog', () => {
  it('loads a DOCX document token, renders the shared viewer, then releases the manifest on close', async () => {
    const user = userEvent.setup()
    invoke.mockImplementation(async (method) => {
      if (method === 'xiaogui.templateLibrary.preview.prepare') return preview('DOCX_HTML')
      if (method === 'xiaogui.templateLibrary.preview.release') return { released: true }
      throw new Error(`UNEXPECTED_METHOD:${method}`)
    })
    const rendered = render(
      <TemplateLibraryPreviewDialog entryName="项目周报模板" version={version} onClose={() => rendered.unmount()} />,
    )

    expect(await screen.findByTestId('docx-library-preview')).toHaveAttribute('data-token', 'library-doc-token')
    expect(invoke).not.toHaveBeenCalledWith('xiaogui.templateReview.page.read', expect.anything())

    await user.click(screen.getByRole('button', { name: '关闭预览' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'xiaogui.templateLibrary.preview.release',
      { manifestId },
    ))
  })

  it('shows an explicit structured fallback and never claims that page preview succeeded', async () => {
    invoke.mockImplementation(async (method) => {
      if (method === 'xiaogui.templateLibrary.preview.prepare') return preview('STRUCTURED_FALLBACK')
      if (method === 'xiaogui.templateLibrary.preview.release') return { released: true }
      throw new Error(`UNEXPECTED_METHOD:${method}`)
    })
    const rendered = render(
      <TemplateLibraryPreviewDialog entryName="项目周报模板" version={version} onClose={() => rendered.unmount()} />,
    )

    expect(await screen.findByRole('heading', { name: '无法生成内置页面预览' })).toBeInTheDocument()
    expect(screen.getByText('DOCX_HTML_RENDER_FAILED')).toBeInTheDocument()
    expect(screen.queryByTestId('docx-library-preview')).not.toBeInTheDocument()
    rendered.unmount()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'xiaogui.templateLibrary.preview.release',
      { manifestId },
    ))
  })
})
