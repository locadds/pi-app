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

function preview(mode: 'PDF' | 'STRUCTURED_FALLBACK'): TemplateLibraryPreviewV1 {
  return {
    previewVersion: 1,
    manifestId,
    entryId: 'entry-1',
    entryName: '项目周报模板',
    versionId: version.versionId,
    versionNumber: version.versionNumber,
    render: mode === 'PDF' ? {
      mode,
      pageCount: 2,
      pages: [
        { pageNumber: 1, pageToken: 'opaque-page-token-1', widthPoints: 600, heightPoints: 800, textLayerAvailable: true },
        { pageNumber: 2, pageToken: 'opaque-page-token-2', widthPoints: 600, heightPoints: 800, textLayerAvailable: true },
      ],
      warnings: [],
    } : {
      mode,
      pageCount: null,
      pages: [],
      warnings: [
        { code: 'LIBREOFFICE_UNAVAILABLE', message: '本机文档渲染组件不可用，已切换为结构化复核视图' },
        { code: 'STRUCTURED_FALLBACK_ACTIVE', message: '所有无法定位的内容必须进入人工清单，不会静默遗漏' },
      ],
    },
  }
}

beforeEach(() => {
  invoke.mockReset()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TemplateLibraryPreviewDialog', () => {
  it('loads and navigates pages by opaque token, then releases the manifest on close', async () => {
    const user = userEvent.setup()
    invoke.mockImplementation(async (method, request) => {
      if (method === 'xiaogui.templateLibrary.preview.prepare') return preview('PDF')
      if (method === 'xiaogui.templateReview.page.read') {
        return {
          pageNumber: request.pageToken === 'opaque-page-token-2' ? 2 : 1,
          pdfBytes: new Uint8Array([1, 2, 3]),
          text: '',
        }
      }
      if (method === 'xiaogui.templateLibrary.preview.release') return { released: true }
      throw new Error(`UNEXPECTED_METHOD:${method}`)
    })
    const rendered = render(
      <TemplateLibraryPreviewDialog entryName="项目周报模板" version={version} onClose={() => rendered.unmount()} />,
    )

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'xiaogui.templateReview.page.read',
      { pageToken: 'opaque-page-token-1' },
    ))
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'xiaogui.templateReview.page.read',
      { pageToken: 'opaque-page-token-2' },
    ))

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
    expect(screen.getByText('LIBREOFFICE_UNAVAILABLE')).toBeInTheDocument()
    expect(screen.getByText(/不代表页面预览成功/)).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('xiaogui.templateReview.page.read', expect.anything())
    rendered.unmount()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'xiaogui.templateLibrary.preview.release',
      { manifestId },
    ))
  })
})
