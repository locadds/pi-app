import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  TemplateLibraryDetailV1,
  TemplateLibraryListResultV1,
  TemplateLibraryPreviewV1,
  TemplateLibraryUsageV1,
} from '@shared/xiaogui-template-library'
import { ipcClient } from '@renderer/lib/ipc-client'
import { submitComposerPrompt } from '@renderer/lib/composer-quick-submit'
import { TemplateLibraryView } from './TemplateLibraryView'

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn() },
}))

vi.mock('@renderer/lib/composer-quick-submit', () => ({ submitComposerPrompt: vi.fn() }))

const invoke = vi.mocked(ipcClient.invoke)
const submit = vi.mocked(submitComposerPrompt)
const manifestId = '8a11fa90-09dc-40da-aa18-3f1283350618'
const version = {
  versionId: 'version-1',
  versionNumber: 1,
  sha256: 'a'.repeat(64),
  byteLength: 1024,
  fields: [],
  createdAt: '2026-08-28T10:00:00.000Z',
  isLatest: true,
} as const
const detail: TemplateLibraryDetailV1 = {
  libraryVersion: 1,
  entryId: 'entry-1',
  name: '项目周报模板',
  purpose: '生成项目周报',
  tags: ['周报', '工作'],
  fields: [],
  status: 'ACTIVE',
  latestVersion: version,
  versionCount: 1,
  versions: [version],
  createdAt: '2026-08-28T10:00:00.000Z',
  updatedAt: '2026-08-28T10:00:00.000Z',
}
const list: TemplateLibraryListResultV1 = {
  items: [detail],
  total: 1,
  limit: 100,
  offset: 0,
}
const usage: TemplateLibraryUsageV1 = {
  uniqueAssetCount: 1,
  templateCount: 1,
  activeTemplateCount: 1,
  trashedTemplateCount: 0,
  versionCount: 1,
  totalAssetBytes: 1024,
  capacityLimitBytes: null,
}
const fallbackPreview: TemplateLibraryPreviewV1 = {
  previewVersion: 1,
  manifestId,
  entryId: detail.entryId,
  entryName: detail.name,
  versionId: version.versionId,
  versionNumber: version.versionNumber,
  render: {
    mode: 'STRUCTURED_FALLBACK',
    paginationBasis: 'UNKNOWN',
    approximatePageCount: null,
    warnings: [{ code: 'DOCX_HTML_RENDER_FAILED', message: '本机文档渲染组件不可用' }],
  },
}

beforeEach(() => {
  invoke.mockReset()
  submit.mockReset()
  invoke.mockImplementation(async (method) => {
    if (method === 'xiaogui.templateLibrary.configuration.get') return { configured: true }
    if (method === 'xiaogui.templateLibrary.list') return list
    if (method === 'xiaogui.templateLibrary.usage') return usage
    if (method === 'xiaogui.templateLibrary.detail') return detail
    if (method === 'xiaogui.templateLibrary.preview.prepare') return fallbackPreview
    if (method === 'xiaogui.templateLibrary.preview.release') return { released: true }
    throw new Error(`UNEXPECTED_METHOD:${method}`)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TemplateLibraryView preview seam', () => {
  it('选择历史模板后直接进入生成对话且不暴露内部编号', async () => {
    const user = userEvent.setup()
    render(<TemplateLibraryView onBack={vi.fn()} />)

    await screen.findByText('项目周报模板')
    await user.click(screen.getByRole('button', { name: '使用最新版' }))

    expect(submit).toHaveBeenCalledWith(
      '使用本机模板库中的“项目周报模板”第 1 版生成新文档，先把需要填写的内容列给我确认',
    )
    expect(submit.mock.calls[0]![0]).not.toContain('entry-1')
    expect(submit.mock.calls[0]![0]).not.toContain('version-1')
  })

  it('preserves tag filtering and opens preview from a version record with release on close', async () => {
    const user = userEvent.setup()
    render(<TemplateLibraryView onBack={vi.fn()} />)

    await screen.findByText('项目周报模板')
    await user.click(screen.getByRole('button', { name: '周报' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'xiaogui.templateLibrary.list',
      expect.objectContaining({ tags: ['周报'] }),
    ))

    await user.click(screen.getByRole('button', { name: '版本记录' }))
    await screen.findByText('第 1 版（最新版）')
    await user.click(screen.getByRole('button', { name: '预览' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'xiaogui.templateLibrary.preview.prepare',
      { versionId: version.versionId },
    ))
    expect(await screen.findByRole('heading', { name: '无法生成内置页面预览' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '关闭预览' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'xiaogui.templateLibrary.preview.release',
      { manifestId },
    ))
  })
})
