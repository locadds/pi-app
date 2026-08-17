import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CanonicalSessionAddressScopeV1 } from '@shared/xiaogui-session-scope'
import type { WorkDocxOperationIdV1 } from '@shared/xiaogui-work-docx'

import { useUIStore } from '@renderer/stores/ui-store'
import type { SessionItem } from '@renderer/stores/ui-store-types'
import { useXiaoguiStore } from '../stores/xiaogui-store'

const clientMocks = vi.hoisted(() => ({
  discover: vi.fn(),
  prepare: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  access: vi.fn(),
}))

vi.mock('../lib/work-docx-client', () => ({
  discoverWorkDocx: clientMocks.discover,
  prepareWorkDocx: clientMocks.prepare,
  confirmWorkDocx: clientMocks.confirm,
  cancelWorkDocx: clientMocks.cancel,
  accessWorkDocxOutput: clientMocks.access,
  shortWorkDocxDigest: (sha: string) => sha.slice(0, 12),
}))

import { ComposerWorkDocxButton } from './ComposerWorkDocxButton'

const workScope: CanonicalSessionAddressScopeV1 = {
  projectId: `xgp1_${'a'.repeat(64)}` as CanonicalSessionAddressScopeV1['projectId'],
  sessionKey: `xgs1_${'1'.repeat(64)}` as CanonicalSessionAddressScopeV1['sessionKey'],
  sessionMode: 'WORK',
}
const codingScope: CanonicalSessionAddressScopeV1 = {
  projectId: workScope.projectId,
  sessionKey: `xgs1_${'2'.repeat(64)}` as CanonicalSessionAddressScopeV1['sessionKey'],
  sessionMode: 'CODING',
}
const operationId = 'xgw1_00000000-0000-4000-8000-000000000000' as WorkDocxOperationIdV1
const sha = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'

function sessionWith(id: string, canonicalScope?: CanonicalSessionAddressScopeV1): SessionItem {
  return {
    sessionId: id,
    title: id,
    updatedAt: 0,
    modelId: 'm',
    ...(canonicalScope ? { canonicalScope } : {}),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

let uiSnapshot: ReturnType<typeof useUIStore.getState>
let xiaoguiSnapshot: ReturnType<typeof useXiaoguiStore.getState>

beforeEach(() => {
  uiSnapshot = useUIStore.getState()
  xiaoguiSnapshot = useXiaoguiStore.getState()
  clientMocks.discover.mockResolvedValue({
    ok: true,
    value: {
      capabilities: [
        {
          id: 'docx-template-patch',
          version: '9.7.1',
          status: 'AVAILABLE',
          intents: ['PREPARE', 'CONFIRM', 'CANCEL'],
        },
      ],
    },
  })
  clientMocks.prepare.mockResolvedValue({
    ok: true,
    value: {
      kind: 'PREPARED',
      operationId,
      templateDisplayName: '模板.docx',
      payloadDisplayName: '数据.json',
      placeholders: ['title'],
      templateSha256: sha,
      payloadSha256: sha,
    },
  })
  clientMocks.confirm.mockResolvedValue({
    ok: true,
    value: {
      kind: 'PUBLISHED',
      operationId,
      outputSha256: sha,
      templateSha256: sha,
      payloadSha256: sha,
      originalInputsUnchanged: true,
    },
  })
  clientMocks.cancel.mockResolvedValue({ ok: true, value: { kind: 'CANCELLED', operationId } })
  clientMocks.access.mockResolvedValue({ ok: true, value: {} })
  useXiaoguiStore.setState({ mode: 'WORK' })
})

afterEach(() => {
  cleanup()
  clientMocks.discover.mockReset()
  clientMocks.prepare.mockReset()
  clientMocks.confirm.mockReset()
  clientMocks.cancel.mockReset()
  clientMocks.access.mockReset()
  useUIStore.setState(uiSnapshot, true)
  useXiaoguiStore.setState(xiaoguiSnapshot, true)
})

describe('ComposerWorkDocxButton', () => {
  it('只在 WORK 模式展示，并且只有 canonical WORK 会话可点击', () => {
    useXiaoguiStore.setState({ mode: 'CODING' })
    useUIStore.setState({ sessions: [sessionWith('s1', workScope)], currentSessionId: 's1' })
    const { rerender } = render(<ComposerWorkDocxButton />)
    expect(screen.queryByRole('button', { name: '生成 DOCX 文档' })).toBeNull()

    useXiaoguiStore.setState({ mode: 'WORK' })
    useUIStore.setState({ sessions: [sessionWith('s1', codingScope)], currentSessionId: 's1' })
    rerender(<ComposerWorkDocxButton />)
    expect(screen.getByRole('button', { name: '生成 DOCX 文档' })).toBeDisabled()

    useUIStore.setState({ sessions: [sessionWith('s1', workScope)], currentSessionId: 's1' })
    rerender(<ComposerWorkDocxButton />)
    expect(screen.getByRole('button', { name: '生成 DOCX 文档' })).toBeEnabled()
  })

  it('完成 discover 到 prepare 后显示二次确认，取消只调用一次 cancel', async () => {
    useUIStore.setState({ sessions: [sessionWith('s1', workScope)], currentSessionId: 's1' })
    const user = userEvent.setup()
    render(<ComposerWorkDocxButton />)

    await user.click(screen.getByRole('button', { name: '生成 DOCX 文档' }))

    expect(await screen.findByRole('dialog', { name: '确认生成 DOCX' })).toBeInTheDocument()
    expect(screen.getByText('待填字段（1 个）')).toBeInTheDocument()
    expect(screen.getByText('模板：模板.docx')).toBeInTheDocument()
    expect(screen.getByText('数据：数据.json')).toBeInTheDocument()
    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.getByText('模板摘要：abcdef123456')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成 DOCX 文档' })).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(clientMocks.prepare).toHaveBeenCalledTimes(1)

    await user.dblClick(screen.getByRole('button', { name: '取消' }))

    await waitFor(() => expect(clientMocks.cancel).toHaveBeenCalledTimes(1))
    expect(clientMocks.cancel).toHaveBeenCalledWith(
      { projectId: workScope.projectId, sessionKey: workScope.sessionKey },
      operationId,
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认生成 DOCX' })).toBeNull())
  })

  it('确认后只调用一次 confirm，并展示另存和结构检查结果', async () => {
    useUIStore.setState({ sessions: [sessionWith('s1', workScope)], currentSessionId: 's1' })
    const user = userEvent.setup()
    render(<ComposerWorkDocxButton />)

    await user.click(screen.getByRole('button', { name: '生成 DOCX 文档' }))
    await user.dblClick(await screen.findByRole('button', { name: '确认生成' }))

    await waitFor(() => expect(clientMocks.confirm).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('dialog', { name: 'DOCX 已生成' })).toBeInTheDocument()
    expect(screen.getByText('已另存为新文件。')).toBeInTheDocument()
    expect(screen.getByText('结构检查通过。')).toBeInTheDocument()
    expect(screen.getByText('原模板和原数据未修改。')).toBeInTheDocument()
    expect(screen.getByText('输出摘要：abcdef123456')).toBeInTheDocument()
  })

  it('取消清理失败时保留确认内容，并允许再次取消', async () => {
    useUIStore.setState({ sessions: [sessionWith('s1', workScope)], currentSessionId: 's1' })
    clientMocks.cancel.mockResolvedValueOnce({
      ok: false,
      code: 'PUBLISH_FAILED',
      message: '没有清理完本次准备内容，请重试取消。',
    })
    const user = userEvent.setup()
    render(<ComposerWorkDocxButton />)

    await user.click(screen.getByRole('button', { name: '生成 DOCX 文档' }))
    await user.click(await screen.findByRole('button', { name: '取消' }))

    expect(await screen.findByText(/你可以重试取消/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))

    await waitFor(() => expect(clientMocks.cancel).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认生成 DOCX' })).toBeNull())
  })

  it('会话切换后忽略旧响应并尽力取消旧 prepared', async () => {
    useUIStore.setState({
      sessions: [sessionWith('s1', workScope), sessionWith('s2', { ...workScope, sessionKey: `xgs1_${'3'.repeat(64)}` as never })],
      currentSessionId: 's1',
    })
    const pendingPrepare = deferred<Awaited<ReturnType<typeof clientMocks.prepare>>>()
    clientMocks.prepare.mockReturnValueOnce(pendingPrepare.promise)
    const user = userEvent.setup()
    render(<ComposerWorkDocxButton />)

    await user.click(screen.getByRole('button', { name: '生成 DOCX 文档' }))
    useUIStore.setState({ currentSessionId: 's2' })
    await waitFor(() => expect(screen.getByRole('button', { name: '生成 DOCX 文档' })).toBeEnabled())
    pendingPrepare.resolve({
      ok: true,
      value: {
        kind: 'PREPARED',
        operationId,
        templateDisplayName: '旧模板.docx',
        payloadDisplayName: '旧数据.json',
        placeholders: ['late'],
        templateSha256: sha,
        payloadSha256: sha,
      },
    })

    await waitFor(() => expect(clientMocks.cancel).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog', { name: '确认生成 DOCX' })).toBeNull()
  })

  it('成功弹窗提供打开与定位，同一时刻只发一次访问请求且不自动打开', async () => {
    useUIStore.setState({ sessions: [sessionWith('s1', workScope)], currentSessionId: 's1' })
    const pendingAccess = deferred<Awaited<ReturnType<typeof clientMocks.access>>>()
    clientMocks.access.mockReturnValueOnce(pendingAccess.promise)
    const user = userEvent.setup()
    render(<ComposerWorkDocxButton />)

    await user.click(screen.getByRole('button', { name: '生成 DOCX 文档' }))
    await user.click(await screen.findByRole('button', { name: '确认生成' }))
    await screen.findByRole('dialog', { name: 'DOCX 已生成' })
    expect(clientMocks.access).not.toHaveBeenCalled()

    await user.dblClick(screen.getByRole('button', { name: '打开文件' }))
    await waitFor(() => expect(clientMocks.access).toHaveBeenCalledTimes(1))
    expect(clientMocks.access).toHaveBeenCalledWith(
      { projectId: workScope.projectId, sessionKey: workScope.sessionKey },
      operationId,
      'OPEN',
    )
    expect(screen.getByRole('button', { name: '在文件夹中显示' })).toBeDisabled()

    pendingAccess.resolve({ ok: true, value: {} })
    await waitFor(() => expect(screen.getByRole('button', { name: '在文件夹中显示' })).toBeEnabled())

    await user.click(screen.getByRole('button', { name: '在文件夹中显示' }))
    await waitFor(() => expect(clientMocks.access).toHaveBeenCalledTimes(2))
    expect(clientMocks.access).toHaveBeenLastCalledWith(
      { projectId: workScope.projectId, sessionKey: workScope.sessionKey },
      operationId,
      'REVEAL',
    )

    await user.click(screen.getByRole('button', { name: '完成' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'DOCX 已生成' })).toBeNull())
  })

  it('访问失败保留成功事实，弹窗内提示中文并允许重试', async () => {
    useUIStore.setState({ sessions: [sessionWith('s1', workScope)], currentSessionId: 's1' })
    clientMocks.access.mockResolvedValueOnce({ ok: false, code: 'IPC_FAILURE', message: '文档功能暂时不可用，请稍后再试。' })
    const user = userEvent.setup()
    render(<ComposerWorkDocxButton />)

    await user.click(screen.getByRole('button', { name: '生成 DOCX 文档' }))
    await user.click(await screen.findByRole('button', { name: '确认生成' }))
    await screen.findByRole('dialog', { name: 'DOCX 已生成' })

    await user.click(screen.getByRole('button', { name: '打开文件' }))
    expect(await screen.findByText('暂时打不开文件，请重试。')).toBeInTheDocument()
    expect(screen.getByText('已另存为新文件。')).toBeInTheDocument()
    expect(screen.getByText('输出摘要：abcdef123456')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '打开文件' }))
    await waitFor(() => expect(clientMocks.access).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('暂时打不开文件，请重试。')).toBeNull())
    expect(screen.getByRole('dialog', { name: 'DOCX 已生成' })).toBeInTheDocument()
  })

  it('会话切换后丢弃旧的访问响应', async () => {
    useUIStore.setState({
      sessions: [sessionWith('s1', workScope), sessionWith('s2', { ...workScope, sessionKey: `xgs1_${'3'.repeat(64)}` as never })],
      currentSessionId: 's1',
    })
    const pendingAccess = deferred<Awaited<ReturnType<typeof clientMocks.access>>>()
    clientMocks.access.mockReturnValueOnce(pendingAccess.promise)
    const user = userEvent.setup()
    render(<ComposerWorkDocxButton />)

    await user.click(screen.getByRole('button', { name: '生成 DOCX 文档' }))
    await user.click(await screen.findByRole('button', { name: '确认生成' }))
    await screen.findByRole('dialog', { name: 'DOCX 已生成' })
    await user.click(screen.getByRole('button', { name: '打开文件' }))
    await waitFor(() => expect(clientMocks.access).toHaveBeenCalledTimes(1))

    useUIStore.setState({ currentSessionId: 's2' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'DOCX 已生成' })).toBeNull())
    pendingAccess.resolve({ ok: false, code: 'IPC_FAILURE', message: '文档功能暂时不可用，请稍后再试。' })

    await waitFor(() => expect(screen.getByRole('button', { name: '生成 DOCX 文档' })).toBeEnabled())
    expect(screen.queryByText(/暂时打不开文件/)).toBeNull()
  })
})
