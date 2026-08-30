import { describe, expect, it } from 'vitest'

import {
  encodeOfficeDrawingDegradationV1,
  officeSurfaceWarningDisplayItemsV1,
  parseOfficeDrawingDegradationV1,
} from './xiaogui-office-drawing-degradation'

describe('Office 绘图降级记录', () => {
  it('在 string-only Office 契约中往返结构化记录，并保留全部普通与结构化告警', () => {
    const encoded = encodeOfficeDrawingDegradationV1({
      kind: 'XIAOGUI_DOCX_DRAWING_DEGRADATION',
      version: 1,
      id: 'body-1-3-unsupported',
      part: 'BODY',
      partIndex: 1,
      sequence: 3,
      severity: 'WARNING',
      reason: 'UNSUPPORTED_FORMAT',
      message: '正文绘图对象 3 使用暂不支持的 EMF 图片。',
      relationshipId: 'rEmf',
      format: 'EMF',
    })

    expect(parseOfficeDrawingDegradationV1(encoded)).toMatchObject({
      id: 'body-1-3-unsupported',
      reason: 'UNSUPPORTED_FORMAT',
      relationshipId: 'rEmf',
      format: 'EMF',
    })
    expect(parseOfficeDrawingDegradationV1('普通告警')).toBeNull()
    expect(officeSurfaceWarningDisplayItemsV1([
      '普通告警一',
      encoded,
      '普通告警二',
    ])).toEqual([
      expect.objectContaining({ key: 'warning-1', message: '普通告警一', degradation: null }),
      expect.objectContaining({
        key: 'drawing-body-1-3-unsupported',
        message: '正文绘图对象 3 使用暂不支持的 EMF 图片。',
        degradation: expect.objectContaining({ reason: 'UNSUPPORTED_FORMAT' }),
      }),
      expect.objectContaining({ key: 'warning-3', message: '普通告警二', degradation: null }),
    ])
  })

  it('编码时只保留安全字段，调用方误传的位置字段也不会进入 warning', () => {
    const fileTarget = 'file:///C:/Users/Alice/private/client-logo.png'
    const uncPath = String.raw`\\fileserver\finance\budget-2026.png`
    const encoded = encodeOfficeDrawingDegradationV1({
      kind: 'XIAOGUI_DOCX_DRAWING_DEGRADATION',
      version: 1,
      id: 'body-0-1-external',
      part: 'BODY',
      partIndex: 0,
      sequence: 1,
      severity: 'WARNING',
      reason: 'EXTERNAL_IMAGE',
      message: '正文绘图对象 1 引用外部图片，未自动加载。',
      relationshipId: 'rFile',
      format: 'EXTERNAL_FILE_URI',
      target: fileTarget,
      packagePath: uncPath,
    } as Parameters<typeof encodeOfficeDrawingDegradationV1>[0] & {
      target: string
      packagePath: string
    })

    expect(encoded).not.toContain(fileTarget)
    expect(encoded).not.toContain(uncPath)
    expect(parseOfficeDrawingDegradationV1(encoded)).toEqual({
      kind: 'XIAOGUI_DOCX_DRAWING_DEGRADATION',
      version: 1,
      id: 'body-0-1-external',
      part: 'BODY',
      partIndex: 0,
      sequence: 1,
      severity: 'WARNING',
      reason: 'EXTERNAL_IMAGE',
      message: '正文绘图对象 1 引用外部图片，未自动加载。',
      relationshipId: 'rFile',
      format: 'EXTERNAL_FILE_URI',
    })
  })

  it('拒绝伪造或不完整的结构化记录，而不是让 UI 静默吞掉原始告警', () => {
    const malformed = 'XIAOGUI_DOCX_DRAWING_DEGRADATION_V1:{"kind":"wrong"}'
    expect(parseOfficeDrawingDegradationV1(malformed)).toBeNull()
    expect(officeSurfaceWarningDisplayItemsV1([malformed])).toEqual([
      expect.objectContaining({ message: malformed, degradation: null }),
    ])
  })
})
