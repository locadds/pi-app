import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcClient } from '@renderer/lib/ipc-client'
import { activateWorkspace } from '@renderer/lib/activate-workspace'
import { submitComposerPrompt } from '@renderer/lib/composer-quick-submit'
import { useUIStore } from '@renderer/stores/ui-store'
import { useXiaoguiStore } from '../stores/xiaogui-store'

import { WorkHomeView } from './WorkHomeView'

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn(async () => ({})) } }))
vi.mock('@renderer/lib/activate-workspace', () => ({ activateWorkspace: vi.fn() }))
vi.mock('@renderer/lib/composer-quick-submit', () => ({ submitComposerPrompt: vi.fn() }))
vi.mock('./TemplateLibraryView', () => ({
  TemplateLibraryView: ({ onBack }: { onBack: () => void }) => (
    <div><span>历史模板选择</span><button type="button" onClick={onBack}>返回</button></div>
  ),
}))

const invoke = vi.mocked(ipcClient.invoke)
const activate = vi.mocked(activateWorkspace)
const submit = vi.mocked(submitComposerPrompt)

let xiaoguiSnapshot: ReturnType<typeof useXiaoguiStore.getState>
let uiSnapshot: ReturnType<typeof useUIStore.getState>

beforeEach(() => {
  xiaoguiSnapshot = useXiaoguiStore.getState()
  uiSnapshot = useUIStore.getState()
  useXiaoguiStore.setState({ mode: 'WORK' })
  useUIStore.setState({ currentWorkspace: 'D:\\workspace', composerPrefill: null })
  invoke.mockClear()
  activate.mockReset()
  submit.mockReset()
})

afterEach(() => {
  cleanup()
  useXiaoguiStore.setState(xiaoguiSnapshot, true)
  useUIStore.setState(uiSnapshot, true)
})

describe('WorkHomeView', () => {
  it('非 WORK 模式只渲染占位提示', () => {
    useXiaoguiStore.setState({ mode: 'CODING' })
    render(<WorkHomeView />)
    expect(screen.getByText(/工作台仅在/)).toBeInTheDocument()
    expect(screen.queryByText('试试这样说')).toBeNull()
  })

  it('WORK 模式保留三张完整示例卡片', () => {
    render(<WorkHomeView />)
    expect(screen.getByText('试试这样说')).toBeInTheDocument()
    expect(screen.getAllByTestId('work-quick-action').map((button) => button.textContent)).toEqual([
      expect.stringContaining('整理资料'),
      expect.stringContaining('整理普通文档'),
      expect.stringContaining('按模板生成'),
    ])
    expect(
      screen.getByText('选择 DOC 或 DOCX，开始只读分析和模板整理'),
    ).toBeInTheDocument()
  })

  it('只移除长篇能力说明，保留简短边界提示', () => {
    render(<WorkHomeView />)
    expect(screen.queryByText(/保留原文件/)).toBeNull()
    expect(screen.getByText(/专用能力以实际接入状态为准/)).toBeInTheDocument()
    expect(screen.queryByText(/需要选择资料、确认范围或展示结果时/)).toBeNull()
    expect(screen.queryByText(/直接告诉小规你想完成什么/)).toBeNull()
  })

  it('整理资料先选择文件夹，再把相对目录清单交给 Agent', async () => {
    const user = userEvent.setup()
    invoke.mockImplementation(async (method, request) => {
      if (method === 'dialog:openDirectory') return { path: 'D:\\资料目录' }
      if (method === 'workspace.fs.listDir') {
        if (request.path !== '.') return { ok: true, entries: [] }
        expect(request).toEqual({ workspaceRoot: 'D:\\资料目录', path: '.' })
        return {
          ok: true,
          entries: [
            { name: '方案.docx', path: '方案.docx', isDirectory: false, size: 1024 },
            { name: '附图', path: '附图', isDirectory: true },
          ],
        }
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`)
    })
    render(<WorkHomeView />)
    await user.click(screen.getByRole('button', { name: '选择文件夹并整理资料' }))

    expect(activate).toHaveBeenCalledWith('D:\\资料目录', { preferHome: true })
    expect(submit).toHaveBeenCalledOnce()
    const prompt = submit.mock.calls[0]![0]
    expect(prompt).toContain('方案.docx')
    expect(prompt).toContain('[目录] 附图')
    expect(prompt).not.toContain('D:\\资料目录')
    expect(useUIStore.getState().composerPrefill).toBeNull()
  })

  it('整理普通文档通过主进程私有交接后自动开始分析', async () => {
    const user = userEvent.setup()
    invoke.mockResolvedValue({ cancelled: false, fileDisplayName: '个人小结.docx' })
    render(<WorkHomeView />)

    await user.click(screen.getByRole('button', { name: '选择普通文档并开始分析' }))

    expect(invoke).toHaveBeenCalledWith('xiaogui.work.template-intake.source.choose', {
      workspaceRoot: 'D:\\workspace',
    })
    expect(submit).toHaveBeenCalledWith(expect.stringContaining('个人小结.docx'))
    expect(submit.mock.calls[0]![0]).not.toMatch(/[A-Za-z]:[\\/]/)
  })

  it('按模板生成直接打开历史模板选择界面', async () => {
    const user = userEvent.setup()
    render(<WorkHomeView />)
    await user.click(screen.getByRole('button', { name: '从历史模板生成文档' }))
    expect(screen.getByText('历史模板选择')).toBeInTheDocument()
  })
})
