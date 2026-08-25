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

  it('简要说明已标记模板和普通 Word 整理能力', () => {
    render(<WorkHomeView />)
    expect(screen.getByText(/按已标记模板生成文档/)).toBeInTheDocument()
    expect(screen.getAllByText(/普通成品 Word/).length).toBeGreaterThan(0)
    expect(screen.getByText(/保留原文件/)).toBeInTheDocument()
    // 不得宣传尚未接入的能力
    expect(screen.queryByText(/PDF/)).toBeNull()
    expect(screen.queryByText(/XLSX/)).toBeNull()
    expect(screen.queryByText(/自动校审/)).toBeNull()
  })

  it('DOCX 生成走自然语言对话，本页不提供功能按钮', () => {
    render(<WorkHomeView />)
    expect(screen.getByText(/在下方对话框里直接说明需求/)).toBeInTheDocument()
    expect(screen.getByText('整理普通 Word')).toBeInTheDocument()
    // 过渡入口文案已移除，不再提及文档按钮
    expect(screen.queryByText(/文档按钮/)).toBeNull()
    // 本页不提供任何功能按钮
    expect(screen.queryByRole('button')).toBeNull()
  })
})
