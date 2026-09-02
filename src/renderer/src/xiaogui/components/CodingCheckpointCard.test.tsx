import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import type { CodingCheckpointClientPortV1 } from '../lib/coding-checkpoint-client'

import { CodingCheckpointCard } from './CodingCheckpointCard'

const address: HubAddressV1 = {
  projectId: `xgp1_${'a'.repeat(64)}` as HubAddressV1['projectId'],
  sessionKey: `xgs1_${'b'.repeat(64)}` as HubAddressV1['sessionKey'],
}

afterEach(cleanup)

describe('CodingCheckpointCard', () => {
  it('Attempt 不在安全就绪状态时不允许创建检查点', () => {
    const client: CodingCheckpointClientPortV1 = {
      availability: { available: true },
      list: vi.fn(() => new Promise<never>(() => undefined)),
      capture: vi.fn(),
      prepareRestore: vi.fn(),
      confirmRestore: vi.fn(),
    }
    render(<CodingCheckpointCard address={address} attemptId="xhba_private" client={client} enabled={false} />)
    expect(screen.getByText(/不处于可安全恢复的就绪状态/)).toBeVisible()
    expect(screen.getByRole('button', { name: '创建检查点' })).toBeDisabled()
    expect(client.capture).not.toHaveBeenCalled()
  })

  it('可用接缝必须先创建、再预览影响、勾选确认，最后才能恢复', async () => {
    const capture = vi.fn().mockResolvedValue({
      ok: true,
      value: { checkpointRef: 'private-checkpoint', status: 'AVAILABLE' },
    })
    const prepareRestore = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        previewRef: 'private-preview',
        previewDigest: `sha256:${'1'.repeat(64)}`,
        checkpointRef: 'private-checkpoint',
        expiresAt: '2099-08-31T00:05:00.000Z',
        impact: {
          changedRelativePaths: ['src/login.tsx', 'src/login.test.tsx'],
          workspaceChangeCount: 2,
          sessionEffect: '对话将回到创建检查点时的上下文。',
          warning: '检查点之后的未交付修改将被撤销。',
        },
      },
    })
    const confirmRestore = vi.fn().mockResolvedValue({
      ok: true,
      value: { checkpointRef: 'private-checkpoint', status: 'RESTORED' },
    })
    const client: CodingCheckpointClientPortV1 = {
      availability: { available: true },
      list: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      capture,
      prepareRestore,
      confirmRestore,
    }
    const user = userEvent.setup()
    const { container } = render(
      <CodingCheckpointCard address={address} attemptId="xhba_private" client={client} />,
    )

    await user.click(screen.getByRole('button', { name: '创建检查点' }))
    expect(await screen.findByText('检查点已创建。')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '预览恢复影响' }))
    expect(await screen.findByText('将影响 2 个文件')).toBeVisible()
    expect(screen.getByText('src/login.tsx')).toBeVisible()
    expect(screen.getByText('对话将回到创建检查点时的上下文。')).toBeVisible()
    expect(screen.getByText('检查点之后的未交付修改将被撤销。')).toBeVisible()
    const restore = screen.getByRole('button', { name: '确认恢复到此检查点' })
    expect(restore).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: '我已了解上述影响' }))
    await user.click(restore)
    expect(confirmRestore).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('已恢复到检查点。')).toBeVisible()
    expect(container.textContent).not.toContain('private-checkpoint')
    expect(container.textContent).not.toContain('private-preview')
    expect(container.textContent).not.toContain('sha256:')
  })

  it('影响摘要含绝对路径时 fail closed，不显示确认恢复', async () => {
    const client: CodingCheckpointClientPortV1 = {
      availability: { available: true },
      list: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      capture: vi.fn().mockResolvedValue({
        ok: true,
        value: { checkpointRef: 'private-checkpoint', status: 'AVAILABLE' },
      }),
      prepareRestore: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          previewRef: 'private-preview',
          previewDigest: `sha256:${'1'.repeat(64)}`,
          checkpointRef: 'private-checkpoint',
          expiresAt: '2099-08-31T00:05:00.000Z',
          impact: {
            changedRelativePaths: ['C:\\private\\login.tsx'],
            workspaceChangeCount: 1,
            sessionEffect: '回退对话',
            warning: '撤销修改',
          },
        },
      }),
      confirmRestore: vi.fn(),
    }
    const user = userEvent.setup()
    const { container } = render(<CodingCheckpointCard address={address} attemptId="xhba_private" client={client} />)
    await user.click(screen.getByRole('button', { name: '创建检查点' }))
    await user.click(screen.getByRole('button', { name: '预览恢复影响' }))
    expect(await screen.findByText('恢复影响无法安全显示，已停止恢复。')).toBeVisible()
    expect(screen.queryByRole('button', { name: '确认恢复到此检查点' })).toBeNull()
    expect(container.textContent).not.toContain('C:\\private')
  })
})
