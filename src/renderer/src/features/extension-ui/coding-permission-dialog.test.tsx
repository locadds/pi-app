import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CodingPermissionDialog } from './coding-permission-dialog'

describe('CodingPermissionDialog', () => {
  it('只展示安全摘要和相对路径，并提供冻结的三个决定', () => {
    const onChoose = vi.fn()
    render(
      <CodingPermissionDialog
        prompt={{
          schemaVersion: 1,
          operation: 'WRITE',
          relativePaths: ['src/a.ts'],
          dataEgress: 'NONE',
          summary: 'Agent 请求修改本任务已批准范围内的文件。',
          choices: ['ALLOW_ONCE', 'ALLOW_TASK_RULE', 'DENY'],
        }}
        onChoose={onChoose}
      />,
    )

    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByRole('button', { name: '允许一次' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '允许本次任务中的相同规则' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }))
    expect(onChoose).toHaveBeenCalledWith('ALLOW_ONCE')
  })

  it('显示命令摘要和外传目标，不展示底层原始命令', () => {
    const onChoose = vi.fn()
    const { rerender } = render(
      <CodingPermissionDialog
        prompt={{
          schemaVersion: 1,
          operation: 'COMMAND',
          relativePaths: [],
          dataEgress: 'NONE',
          commandSummary: 'npm run typecheck',
          summary: 'Agent 请求在当前任务工作树中运行命令。',
          choices: ['ALLOW_ONCE', 'ALLOW_TASK_RULE', 'DENY'],
        }}
        onChoose={onChoose}
      />,
    )
    expect(screen.getByText('npm run typecheck')).toBeTruthy()

    rerender(
      <CodingPermissionDialog
        prompt={{
          schemaVersion: 1,
          operation: 'DATA_EGRESS',
          relativePaths: [],
          dataEgress: 'REQUESTED',
          egressDestination: 'approved.example.test',
          summary: 'Agent 请求将本任务数据发送到外部服务。',
          choices: ['ALLOW_ONCE', 'ALLOW_TASK_RULE', 'DENY'],
        }}
        onChoose={onChoose}
      />,
    )
    expect(screen.getByText('approved.example.test')).toBeTruthy()
    expect(screen.getByText('此操作会把任务数据发送到外部服务。')).toBeTruthy()
  })
})
