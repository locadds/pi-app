import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

const invokeMock = vi.fn()
vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: {
    invoke: (method: string, request?: unknown) => invokeMock(method, request),
  },
}))

import {
  accessWorkDocxOutput,
  cancelWorkDocx,
  confirmWorkDocx,
  discoverWorkDocx,
  prepareWorkDocx,
  shortWorkDocxDigest,
} from './work-docx-client'

const address: SessionAddressV1 = {
  projectId: `xgp1_${'a'.repeat(64)}` as SessionAddressV1['projectId'],
  sessionKey: `xgs1_${'b'.repeat(64)}` as SessionAddressV1['sessionKey'],
}
const operationId = 'xgw1_00000000-0000-4000-8000-000000000000' as never
const sha = '1'.repeat(64)

beforeEach(() => invokeMock.mockReset())

describe('work-docx-client', () => {
  it('discover 只接受严格能力闭集', async () => {
    invokeMock.mockResolvedValueOnce({
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

    await expect(discoverWorkDocx(address)).resolves.toEqual({
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
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.work.docx.discover', address)

    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        capabilities: [
          {
            id: 'docx-template-patch',
            version: '9.7.1',
            status: 'AVAILABLE',
            intents: ['PREPARE', 'CONFIRM', 'CANCEL', 'OPEN'],
          },
        ],
      },
    })

    await expect(discoverWorkDocx(address)).resolves.toMatchObject({ ok: false, code: 'IPC_FAILURE' })
  })

  it('prepare / confirm / cancel 使用窄载荷且不泄露 IPC 异常', async () => {
    invokeMock
      .mockResolvedValueOnce({
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
      .mockResolvedValueOnce({
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
      .mockResolvedValueOnce({ ok: true, value: { kind: 'CANCELLED', operationId } })
      .mockRejectedValueOnce(new Error('C:\\Users\\secret\\docx'))

    await expect(prepareWorkDocx(address)).resolves.toMatchObject({ ok: true })
    await expect(confirmWorkDocx(address, operationId)).resolves.toMatchObject({ ok: true })
    await expect(cancelWorkDocx(address, operationId)).resolves.toMatchObject({ ok: true })
    const failed = await prepareWorkDocx(address)

    expect(invokeMock.mock.calls.map(([channel]) => channel)).toEqual([
      'xiaogui.work.docx.prepare',
      'xiaogui.work.docx.confirm',
      'xiaogui.work.docx.cancel',
      'xiaogui.work.docx.prepare',
    ])
    expect(invokeMock.mock.calls[0]![1]).toEqual({ address })
    expect(invokeMock.mock.calls[1]![1]).toEqual({ address, operationId })
    expect(invokeMock.mock.calls[2]![1]).toEqual({ address, operationId })
    expect(failed).toEqual({
      ok: false,
      code: 'IPC_FAILURE',
      message: '文档功能暂时不可用，请稍后再试。',
    })
    expect(JSON.stringify(failed)).not.toContain('C:\\')
  })

  it('access 使用窄载荷并安全映射失败', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: { kind: 'ACCESSED', operationId, action: 'OPEN' },
    })
    await expect(accessWorkDocxOutput(address, operationId, 'OPEN')).resolves.toEqual({
      ok: true,
      value: { kind: 'ACCESSED', operationId, action: 'OPEN' },
    })
    expect(invokeMock).toHaveBeenCalledWith('xiaogui.work.docx.output.access', {
      address,
      operationId,
      action: 'OPEN',
    })

    invokeMock.mockResolvedValueOnce({ ok: false, error: { code: 'OPERATION_NOT_FOUND', messageKey: 'workDocx.operationNotFound' } })
    await expect(accessWorkDocxOutput(address, operationId, 'REVEAL')).resolves.toEqual({
      ok: false,
      code: 'OPERATION_NOT_FOUND',
      message: '这次准备已经失效，请重新选择文件。',
    })
    expect(invokeMock).toHaveBeenLastCalledWith('xiaogui.work.docx.output.access', {
      address,
      operationId,
      action: 'REVEAL',
    })

    invokeMock.mockResolvedValueOnce({ ok: false, error: { code: 'ACCESS_DENIED', messageKey: 'x' } })
    await expect(accessWorkDocxOutput(address, operationId, 'OPEN')).resolves.toMatchObject({
      ok: false,
      code: 'IPC_FAILURE',
    })

    invokeMock.mockRejectedValueOnce(new Error('C:\\Users\\secret\\docx'))
    const failed = await accessWorkDocxOutput(address, operationId, 'OPEN')
    expect(failed).toEqual({
      ok: false,
      code: 'IPC_FAILURE',
      message: '文档功能暂时不可用，请稍后再试。',
    })
    expect(JSON.stringify(failed)).not.toContain('C:\\')
  })

  it('摘要只展示前 12 位', () => {
    expect(shortWorkDocxDigest('abcdef1234567890')).toBe('abcdef123456')
  })

  it('拒绝把路径伪装成确认用文件名', async () => {
    invokeMock.mockResolvedValueOnce({
      ok: true,
      value: {
        kind: 'PREPARED',
        operationId,
        templateDisplayName: 'C:\\Users\\secret\\模板.docx',
        payloadDisplayName: '数据.json',
        placeholders: ['title'],
        templateSha256: sha,
        payloadSha256: sha,
      },
    })

    await expect(prepareWorkDocx(address)).resolves.toEqual({
      ok: false,
      code: 'IPC_FAILURE',
      message: '文档功能暂时不可用，请稍后再试。',
    })
  })
})
