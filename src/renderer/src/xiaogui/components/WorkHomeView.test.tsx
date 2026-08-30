import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useUIStore } from '@renderer/stores/ui-store'
import { useXiaoguiStore } from '../stores/xiaogui-store'

import { WorkHomeView } from './WorkHomeView'

let xiaoguiSnapshot: ReturnType<typeof useXiaoguiStore.getState>
let uiSnapshot: ReturnType<typeof useUIStore.getState>

beforeEach(() => {
  xiaoguiSnapshot = useXiaoguiStore.getState()
  uiSnapshot = useUIStore.getState()
  useXiaoguiStore.setState({ mode: 'WORK' })
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
    expect(screen.getAllByRole('button', { name: /填写示例提示词/ })).toHaveLength(3)
    expect(
      screen.getByText('把我选择的普通成品文档整理成可复用模板，先给我一份候选内容报告'),
    ).toBeInTheDocument()
  })

  it('只移除长篇能力说明，保留简短边界提示', () => {
    render(<WorkHomeView />)
    expect(screen.queryByText(/保留原文件/)).toBeNull()
    expect(screen.getByText(/专用能力以实际接入状态为准/)).toBeInTheDocument()
    expect(screen.queryByText(/需要选择资料、确认范围或展示结果时/)).toBeNull()
    expect(screen.queryByText(/直接告诉小规你想完成什么/)).toBeNull()
  })

  it('三个示例只填写提示词，不直接执行任务', async () => {
    const user = userEvent.setup()
    render(<WorkHomeView />)
    const examples = screen.getAllByRole('button', { name: /填写示例提示词/ })
    expect(examples).toHaveLength(3)

    await user.click(screen.getByRole('button', { name: '填写示例提示词：整理普通文档' }))

    expect(useUIStore.getState().composerPrefill).toBe(
      '把我选择的普通成品文档整理成可复用模板，先给我一份候选内容报告',
    )
    expect(useUIStore.getState().runState.status).toBe(uiSnapshot.runState.status)
  })
})
