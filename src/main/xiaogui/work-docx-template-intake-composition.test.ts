import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  legacyConsume: vi.fn((_address: unknown) => null as { sourcePath: string } | null),
  serviceOptions: null as null | {
    handoffs: {
      consumeTemplateIntakeHandoff: (address: { projectId: string; sessionKey: string }) =>
        { sourcePath: string } | null
    }
  },
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\xiaogui-test-userData' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: mocks.showOpenDialog },
}))
vi.mock('./scope-service', () => ({ sessionScopeResolverV1: {} }))
vi.mock('./work-docx-ipc', () => ({
  getDefaultWorkDocxServiceV1: () => ({
    consumeTemplateIntakeHandoff: mocks.legacyConsume,
  }),
}))
vi.mock('./work-docx-template-intake-service', () => ({
  WorkDocxTemplateIntakeServiceV1: vi.fn(function (options: unknown) {
    mocks.serviceOptions = options as never
    return { close: vi.fn() }
  }),
}))
vi.mock('./work-docx-template-intake-store', () => ({
  WorkDocxTemplateIntakeStoreV1: vi.fn(function () {
    return { close: vi.fn() }
  }),
}))
vi.mock('./work-document-review-renderer-composition', () => ({
  getDefaultDocumentReviewRendererV1: () => ({}),
}))

import { opaqueScopeIdDeriverV1 } from './scope-derive'
import {
  chooseTemplateIntakeSourceForWorkspaceV1,
  closeDefaultWorkDocxTemplateIntakeServiceV1,
  getDefaultWorkDocxTemplateIntakeServiceV1,
  hasStagedTemplateIntakeSourceForProjectV1,
} from './work-docx-template-intake-composition'

const WORKSPACE_ROOT = 'D:\\sandbox-workspaces\\普通文档整理'

function addressFor(workspaceRoot: string): { projectId: string; sessionKey: string } {
  return {
    projectId: opaqueScopeIdDeriverV1.deriveProject(workspaceRoot).projectId,
    sessionKey: `xgs1_${'c'.repeat(64)}`,
  }
}

describe('WORK 普通文档模板整理来源的私有交接', () => {
  beforeEach(() => {
    mocks.showOpenDialog.mockReset()
    mocks.legacyConsume.mockClear()
    mocks.serviceOptions = null
  })

  afterEach(() => {
    closeDefaultWorkDocxTemplateIntakeServiceV1()
  })

  it('取消选择时不暂存来源', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

    await expect(chooseTemplateIntakeSourceForWorkspaceV1(WORKSPACE_ROOT))
      .resolves.toEqual({ cancelled: true })
    expect(hasStagedTemplateIntakeSourceForProjectV1(addressFor(WORKSPACE_ROOT).projectId))
      .toBe(false)
  })

  it('非 Word 输入被拒绝且不暂存', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['D:\\资料\\notes.txt'] })

    await expect(chooseTemplateIntakeSourceForWorkspaceV1(WORKSPACE_ROOT))
      .rejects.toThrow('TEMPLATE_INTAKE_INPUT_INVALID')
    expect(hasStagedTemplateIntakeSourceForProjectV1(addressFor(WORKSPACE_ROOT).projectId))
      .toBe(false)
  })

  it('DOCX 来源按工作区项目登记，被同项目会话消费且仅消费一次', async () => {
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\资料\\个人小结.docx'],
    })

    await expect(chooseTemplateIntakeSourceForWorkspaceV1(WORKSPACE_ROOT))
      .resolves.toEqual({ cancelled: false, fileDisplayName: '个人小结.docx' })

    const address = addressFor(WORKSPACE_ROOT)
    expect(hasStagedTemplateIntakeSourceForProjectV1(address.projectId)).toBe(true)

    // 服务构造时捕获私有交接回调（intake 工具运行时经此消费暂存来源）。
    getDefaultWorkDocxTemplateIntakeServiceV1()
    const consume = mocks.serviceOptions!.handoffs.consumeTemplateIntakeHandoff

    // 其他项目的会话看不到本次暂存，也不会消费掉它。
    const foreign = addressFor('D:\\sandbox-workspaces\\其他项目')
    expect(consume(foreign)).toBeNull()
    expect(mocks.legacyConsume).toHaveBeenCalledWith(foreign)
    expect(hasStagedTemplateIntakeSourceForProjectV1(address.projectId)).toBe(true)

    expect(consume(address)).toEqual({ sourcePath: 'D:\\资料\\个人小结.docx' })
    expect(hasStagedTemplateIntakeSourceForProjectV1(address.projectId)).toBe(false)

    // 第二次消费回落到既有交接通道，不再返回本次来源。
    expect(consume(address)).toBeNull()
    expect(mocks.legacyConsume).toHaveBeenCalledWith(address)
  })
})
