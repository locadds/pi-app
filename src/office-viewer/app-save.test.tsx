import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeParentBridgeV1 } from './core/parent-bridge'

const harness = vi.hoisted(() => ({
  snapshot: { id: 'test', body: { dataStream: '初始内容\r\n' } },
  command: (_command: { id: string }) => {},
  save: vi.fn(),
}))
vi.mock('@univerjs/core', () => ({
  Univer: class { registerPlugin() {} dispose() {} }, LocaleType: { ZH_CN: 'zh-CN' }, LogLevel: { WARN: 1 },
  mergeLocales: () => ({}), DEFAULT_DOCUMENT_PARAGRAPH_LINE_SPACING: 1, DocumentFlavor: {}, MODERN_DOCUMENT_WIDTH: 600, ModernDocumentWidthMode: {},
}))
vi.mock('@univerjs/core/facade', () => ({ FUniver: { newAPI: () => ({
  getActiveDocument: () => null,
  createUniverDoc: () => ({ getSnapshot: () => harness.snapshot }),
  onCommandExecuted: (callback: typeof harness.command) => { harness.command = callback; return { dispose() {} } },
}) } }))
vi.mock('@univerjs/docs', () => ({ UniverDocsPlugin: class {}, SetTextSelectionsOperation: { id: 'selection' } }))
vi.mock('@univerjs/docs-ui', () => ({ UniverDocsUIPlugin: class {}, ReplaceSelectionCommand: { id: 'replace' } }))
vi.mock('@univerjs/docs-ui/facade', () => ({}))
vi.mock('@univerjs/docs-drawing', () => ({ UniverDocsDrawingPlugin: class {} }))
vi.mock('@univerjs/docs-drawing-ui', () => ({ UniverDocsDrawingUIPlugin: class {} }))
vi.mock('@univerjs/drawing', () => ({ UniverDrawingPlugin: class {} }))
vi.mock('@univerjs/drawing-ui', () => ({ UniverDrawingUIPlugin: class {} }))
vi.mock('@univerjs/engine-render', () => ({ UniverRenderEnginePlugin: class {} }))
vi.mock('@univerjs/ui', () => ({ UniverUIPlugin: class {} }))
vi.mock('./core/doc-drawing-resources', () => ({ ensureUniverDocDrawingResourcesV1: (snapshot: unknown) => snapshot }))
vi.mock('./core/synthetic-field-decoration', () => ({ ensureSyntheticFieldDecorationV1: vi.fn() }))
vi.mock('./core/gateway-client', () => ({ OfficeGatewayClientV1: class {
  load = async () => ({ headSha256: `sha256:${'1'.repeat(64)}`, snapshot: harness.snapshot })
  save = harness.save
  getHeadSha256 = () => `sha256:${'1'.repeat(64)}`
} }))
import { OfficeViewerApp } from './app'

function createBridge(): OfficeParentBridgeV1 {
  return { post: vi.fn(), waitForConnection: async () => {}, subscribe: () => () => {}, dispose: vi.fn() }
}
function edit(text: string) {
  act(() => {
    harness.snapshot = { id: 'test', body: { dataStream: `${text}\r\n` } }
    harness.command({ id: 'text-edit' })
  })
}
beforeEach(() => {
  harness.snapshot = { id: 'test', body: { dataStream: '初始内容\r\n' } }
  harness.save.mockReset().mockResolvedValue(`sha256:${'2'.repeat(64)}`)
})

describe('Office Viewer 保存状态', () => {
  it('手动保存失败保留编辑，继续输入仍标记未保存，重试成功后清除错误', async () => {
    const bridge = createBridge()
    harness.save.mockRejectedValueOnce(new Error('模拟磁盘故障'))
    render(<OfficeViewerApp parentBridge={bridge} />)
    await screen.findByText('可以编辑')
    edit('第一次编辑')
    fireEvent.click(screen.getByRole('button', { name: '保存工作副本' }))
    await screen.findByText('保存失败，可重试')
    await screen.findByText('模拟磁盘故障')
    expect(harness.snapshot.body.dataStream).toBe('第一次编辑\r\n')
    edit('故障之后继续编辑')
    expect(screen.getByText('有未保存修改')).toBeTruthy()
    expect(bridge.post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'VIEWER_DIRTY_STATE', dirty: true }))
    fireEvent.click(screen.getByRole('button', { name: '保存工作副本' }))
    await screen.findByText('已保存')
    expect(harness.save).toHaveBeenLastCalledWith(harness.snapshot)
    expect(screen.queryByText('模拟磁盘故障')).toBeNull()
    expect(bridge.post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'VIEWER_DIRTY_STATE', dirty: false }))
  })

  it('保存请求等待期间继续编辑，旧请求完成后仍保持未保存状态', async () => {
    let finish!: (head: string) => void
    harness.save.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
    const bridge = createBridge()
    render(<OfficeViewerApp parentBridge={bridge} />)
    await screen.findByText('可以编辑')
    edit('提交的内容')
    fireEvent.click(screen.getByRole('button', { name: '保存工作副本' }))
    await waitFor(() => expect(harness.save).toHaveBeenCalledOnce())
    edit('保存期间的新内容')
    await act(async () => { finish(`sha256:${'2'.repeat(64)}`) })
    expect(screen.getByText('有未保存修改')).toBeTruthy()
    expect(bridge.post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'VIEWER_DIRTY_STATE', dirty: true }))
    fireEvent.click(screen.getByRole('button', { name: '保存工作副本' }))
    await screen.findByText('已保存')
    expect(harness.save).toHaveBeenLastCalledWith(harness.snapshot)
  })
})
