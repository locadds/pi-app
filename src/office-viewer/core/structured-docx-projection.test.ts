import { describe, expect, it } from 'vitest'

import {
  isOfficeUniverDocumentSnapshotV1,
  isOfficeUniverWorktreeEnvelopeV1,
} from './structured-docx-projection'

describe('Office Viewer 快照接缝', () => {
  it('不把缺少 univerDocument 的投影元数据误当成 Univer 文档', () => {
    const projectionMetadata = {
      projectionVersion: 1,
      kind: 'XIAOGUI_DOCX_STRUCTURED_PROJECTION',
      plainText: '项目名称：测试项目',
      fields: [],
      occurrences: [],
    }
    expect(isOfficeUniverDocumentSnapshotV1(projectionMetadata)).toBe(false)
    expect(isOfficeUniverWorktreeEnvelopeV1({
      envelopeVersion: 1,
      kind: 'XIAOGUI_UNIVER_WORKTREE',
      document: projectionMetadata,
      projection: {},
    })).toBe(false)
  })

  it('接受最小合法文档和包含该文档的工作副本', () => {
    const document = {
      id: 'doc-1',
      documentStyle: {},
      body: { dataStream: '测试\r\n' },
    }
    expect(isOfficeUniverDocumentSnapshotV1(document)).toBe(true)
    expect(isOfficeUniverWorktreeEnvelopeV1({
      envelopeVersion: 1,
      kind: 'XIAOGUI_UNIVER_WORKTREE',
      document,
      projection: {},
    })).toBe(true)
  })
})
