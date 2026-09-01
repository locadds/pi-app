import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcClient } from '@renderer/lib/ipc-client'
import { activateWorkspace } from '@renderer/lib/activate-workspace'
import { submitComposerPrompt } from '@renderer/lib/composer-quick-submit'
import { useUIStore } from '@renderer/stores/ui-store'
import { selectXiaoguiTurnCapabilitiesV1 } from '@shared/xiaogui-prompt-capabilities'
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
const synchronizeWorkMode = vi.fn(async () => true)

let xiaoguiSnapshot: ReturnType<typeof useXiaoguiStore.getState>
let uiSnapshot: ReturnType<typeof useUIStore.getState>

beforeEach(() => {
  xiaoguiSnapshot = useXiaoguiStore.getState()
  uiSnapshot = useUIStore.getState()
  useXiaoguiStore.setState({ mode: 'WORK', switchMode: synchronizeWorkMode })
  useUIStore.setState({ currentWorkspace: 'D:\\workspace', composerPrefill: null })
  invoke.mockClear()
  activate.mockReset()
  submit.mockReset()
  synchronizeWorkMode.mockClear()
  synchronizeWorkMode.mockResolvedValue(true)
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

  it('整理资料先选择文件夹，再要求 Agent 读取其中所有文件类型', async () => {
    const user = userEvent.setup()
    invoke.mockImplementation(async (method) => {
      if (method === 'dialog:openDirectory') return { path: 'D:\\资料目录' }
      throw new Error(`UNEXPECTED_METHOD:${method}`)
    })
    render(<WorkHomeView />)
    await user.click(screen.getByRole('button', { name: '选择文件夹并整理资料' }))

    expect(activate).toHaveBeenCalledWith('D:\\资料目录', { preferHome: true })
    expect(submit).toHaveBeenCalledOnce()
    const prompt = submit.mock.calls[0]![0]
    expect(prompt).toContain('所有类型的文件')
    expect(prompt).toContain('暂时不能语义解析的格式也必须')
    expect(prompt).toContain('D:\\资料目录')
    expect(invoke).not.toHaveBeenCalledWith('workspace.fs.listDir', expect.anything())
    expect(useUIStore.getState().composerPrefill).toBeNull()
  })

  it('长中文 .doc 快捷消息通过公开能力选择器稳定命中模板整理', async () => {
    const user = userEvent.setup()
    const fileDisplayName = '上海市浦东新区综合交通专项规划阶段成果汇编最终送审版说明文件.doc'
    invoke.mockResolvedValue({ cancelled: false, fileDisplayName })
    render(<WorkHomeView />)

    await user.click(screen.getByRole('button', { name: '选择普通文档并开始分析' }))

    expect(invoke).toHaveBeenCalledWith('xiaogui.work.template-intake.source.choose', {
      workspaceRoot: 'D:\\workspace',
    })
    const prompt = submit.mock.calls[0]![0]
    expect(prompt).toBe(
      `请使用普通文档模板整理能力，把普通成品文档整理成可复用模板。我刚选择的文件是“${fileDisplayName}”。请立即开始只读分析并生成模板整理报告，不要再次让我选择文件；原文档不得修改。`,
    )
    expect(prompt).not.toMatch(/[A-Za-z]:[\\/]/)
    expect(selectXiaoguiTurnCapabilitiesV1({
      mode: 'WORK',
      enabledCapabilities: [],
    }, prompt)).toMatchObject({
      decision: 'SELECTED',
      capabilityIds: ['work.file-organize', 'work.template-intake'],
      inferredCapabilityIds: ['work.template-intake'],
      reasonCodes: expect.arrayContaining(['LOCAL_TEMPLATE_INTAKE']),
    })
  })

  it('整理普通文档先把主进程显式绑定为 WORK，再打开文件选择器', async () => {
    const user = userEvent.setup()
    invoke.mockResolvedValue({ cancelled: true })
    render(<WorkHomeView />)

    await user.click(screen.getByRole('button', { name: '选择普通文档并开始分析' }))

    expect(synchronizeWorkMode).toHaveBeenCalledOnce()
    expect(synchronizeWorkMode).toHaveBeenCalledWith('WORK')
    expect(synchronizeWorkMode.mock.invocationCallOrder[0]).toBeLessThan(
      invoke.mock.invocationCallOrder[0]!,
    )
  })

  it('WORK 模式绑定失败时不继续选择文件或创建错误模式的工作区', async () => {
    const user = userEvent.setup()
    synchronizeWorkMode.mockResolvedValueOnce(false)
    render(<WorkHomeView />)

    await user.click(screen.getByRole('button', { name: '选择普通文档并开始分析' }))

    expect(invoke).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('未能进入 WORK 模式')
  })

  it('取消普通文档选择时不提交提示词也不切换工作区', async () => {
    const user = userEvent.setup()
    invoke.mockResolvedValue({ cancelled: true })
    render(<WorkHomeView />)

    await user.click(screen.getByRole('button', { name: '选择普通文档并开始分析' }))

    expect(synchronizeWorkMode).toHaveBeenCalledWith('WORK')
    expect(invoke).toHaveBeenCalledWith('xiaogui.work.template-intake.source.choose', {
      workspaceRoot: 'D:\\workspace',
    })
    expect(submit).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('没有工作区时自动建立内部 WORK 工作区并打开普通文档选择器', async () => {
    const user = userEvent.setup()
    useUIStore.setState({
      currentWorkspace: null,
      ephemeralSandboxDraft: false,
    })
    invoke.mockImplementation(async (method) => {
      if (method === 'workspace.sandbox.create') {
        return { sandbox: { path: 'D:\\sandbox-workspaces\\普通文档整理' } }
      }
      if (method === 'xiaogui.work.template-intake.source.choose') {
        return { cancelled: false, fileDisplayName: '个人小结.docx' }
      }
      throw new Error(`UNEXPECTED_METHOD:${method}`)
    })
    render(<WorkHomeView />)

    await user.click(screen.getByRole('button', { name: '选择普通文档并开始分析' }))

    expect(invoke).toHaveBeenNthCalledWith(1, 'workspace.sandbox.create', {
      label: '普通文档整理',
    })
    expect(activate).toHaveBeenCalledWith('D:\\sandbox-workspaces\\普通文档整理', {
      preferHome: true,
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'xiaogui.work.template-intake.source.choose', {
      workspaceRoot: 'D:\\sandbox-workspaces\\普通文档整理',
    })
    expect(submit).toHaveBeenCalledWith(expect.stringContaining('个人小结.docx'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('首页标题栏不再渲染会与右侧浮动控件重叠的模板库按钮', () => {
    render(<WorkHomeView />)
    expect(screen.queryByRole('button', { name: '模板库' })).toBeNull()
  })

  it('按模板生成直接打开历史模板选择界面', async () => {
    const user = userEvent.setup()
    render(<WorkHomeView />)
    await user.click(screen.getByRole('button', { name: '从历史模板生成文档' }))
    expect(screen.getByText('历史模板选择')).toBeInTheDocument()
  })
})
