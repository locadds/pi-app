import { describe, expect, it } from 'vitest'

import type { IDocumentData } from '@univerjs/core'
import { ensureUniverDocDrawingResourcesV1 } from './doc-drawing-resources'

describe('Univer 首次绘图资源自愈', () => {
  it('从已有 drawings 补齐插件资源，同时保留其他资源和工作副本内容', () => {
    const drawing = {
      drawingId: 'drawing-1',
      unitId: 'doc-1',
      subUnitId: 'doc-1',
      drawingType: 0,
      imageSourceType: 'BASE64',
      source: 'data:image/png;base64,AA==',
      title: '',
      description: '',
      transform: { left: 0, top: 0, width: 10, height: 10 },
      docTransform: {
        size: { width: 10, height: 10 },
        positionH: { relativeFrom: 2, posOffset: 0 },
        positionV: { relativeFrom: 2, posOffset: 0 },
        angle: 0,
      },
      layoutType: 0,
    }
    const stale = {
      id: 'doc-1',
      title: '保留已有标题',
      drawings: { 'drawing-1': drawing },
      drawingsOrder: ['drawing-1'],
      resources: [
        { name: 'OTHER_PLUGIN', data: '{"kept":true}' },
        { name: 'DOC_DRAWING_PLUGIN', data: '{"data":{},"order":[]}' },
      ],
    } as unknown as Partial<IDocumentData>

    const repaired = ensureUniverDocDrawingResourcesV1(stale)
    expect(repaired).not.toBe(stale)
    expect(repaired.title).toBe('保留已有标题')
    expect(repaired.resources?.map((resource) => resource.name)).toEqual(['OTHER_PLUGIN', 'DOC_DRAWING_PLUGIN'])
    expect(JSON.parse(repaired.resources?.[1]?.data ?? '{}')).toEqual({
      data: { 'drawing-1': drawing },
      order: ['drawing-1'],
    })
  })
})
