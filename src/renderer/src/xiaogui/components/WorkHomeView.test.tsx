import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useXiaoguiStore } from '../stores/xiaogui-store'

import { WorkHomeView } from './WorkHomeView'

let xiaoguiSnapshot: ReturnType<typeof useXiaoguiStore.getState>

beforeEach(() => {
  xiaoguiSnapshot = useXiaoguiStore.getState()
  useXiaoguiStore.setState({ mode: 'WORK' })
})

afterEach(() => {
  cleanup()
  useXiaoguiStore.setState(xiaoguiSnapshot, true)
})

describe('WorkHomeView', () => {
  it('非 WORK 模式只渲染占位提示', () => {
    useXiaoguiStore.setState({ mode: 'CODING' })
    render(<WorkHomeView />)
    expect(screen.getByText(/工作台仅在/)).toBeInTheDocument()
    expect(screen.queryByText('试试这样说')).toBeNull()
  })

  it('WORK 模式主说明引导用户直接在对话框说明需求', () => {
    render(<WorkHomeView />)
    expect(screen.getByText(/在下方对话框里直接说明需求/)).toBeInTheDocument()
    expect(screen.getByText('试试这样说')).toBeInTheDocument()
  })

  it('只把 DOCX 模板+JSON 另存新文档写成已接入能力', () => {
    render(<WorkHomeView />)
    expect(screen.getByText(/根据 DOCX 模板和 JSON 数据另存一份新文档/)).toBeInTheDocument()
    // 不得宣传尚未接入的能力
    expect(screen.queryByText(/PDF/)).toBeNull()
    expect(screen.queryByText(/XLSX/)).toBeNull()
    expect(screen.queryByText(/自动校审/)).toBeNull()
  })

  it('DOCX 工具栏按钮仅以弱化的过渡入口出现，不新增功能按钮', () => {
    render(<WorkHomeView />)
    expect(screen.getByText(/过渡入口：也可以点击输入框旁的文档按钮/)).toBeInTheDocument()
    // 本页不提供任何功能按钮
    expect(screen.queryByRole('button')).toBeNull()
  })
})
