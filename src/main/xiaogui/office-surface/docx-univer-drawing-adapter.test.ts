import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { parseOfficeDrawingDegradationV1 } from '@shared/xiaogui-office-drawing-degradation'
import { buildDocxUniverDocumentV1 } from './docx-univer-document-adapter'
import {
  getDocxUniverDrawingWarningsV1,
  prepareDocxUniverDrawingPackageV1,
  prepareDocxUniverDrawingPartContextV1,
  readDocxUniverDrawingV1,
  selectDocxUniverAlternateContentV1,
  type UniverImageDrawingV1,
} from './docx-univer-drawing-adapter'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xcw6WQAAAABJRU5ErkJggg==',
  'base64',
)
const JPEG_16X16 = Buffer.from(
  '/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAQABADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AjSSb4AAAf//Z',
  'base64',
)
const GIF_2X2 = Buffer.from('R0lGODlhAgACAIAAAExpcdwePCH5BAUAAAAALAAAAAACAAIAAAICjFMAOw==', 'base64')
const BMP_1X1 = Buffer.from('Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAPB7cAA==', 'base64')
const WEBP_2X2 = Buffer.from('UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/vAb38Qu9kOf/37S/8Cd/8Cd/0MAAA==', 'base64')

function drawingMl(relationshipId: string, kind: 'inline' | 'anchor', width: number, height: number): string {
  return `<w:r><w:drawing><wp:${kind}>
    <wp:extent cx="${width * 9_525}" cy="${height * 9_525}"/>
    <wp:docPr id="1" name="${relationshipId}"/>
    ${kind === 'anchor' ? '<wp:positionH relativeFrom="page"><wp:align>center</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>95250</wp:posOffset></wp:positionV><wp:wrapSquare wrapText="bothSides"/>' : ''}
    <a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${relationshipId}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>
  </wp:${kind}></w:drawing></w:r>`
}

function relationship(id: string, target: string): string {
  return `<Relationship Target="${target}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Id="${id}"/>`
}

async function makeDrawingFixture(): Promise<{ zip: JSZip; mainXml: string }> {
  const zip = new JSZip()
  const mainXml = `<w:document
    xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
    xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
    xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
    xmlns:v="urn:schemas-microsoft-com:vml"
    xmlns:o="urn:schemas-microsoft-com:office:office"
    xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main"
    xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
  ><w:body>
    <w:p>${drawingMl('rPng', 'inline', 100, 50)}${drawingMl('rJpeg', 'anchor', 200, 120)}</w:p>
    <w:p><w:r><w:pict><v:shape style="width:72pt;height:36pt"><v:imagedata o:relid="rGif"/></v:shape></w:pict></w:r></w:p>
    <w:p>${drawingMl('rPng', 'inline', 80, 40)}</w:p>
    <w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rSvgFallback"><a:extLst><a:ext><asvg:svgBlip r:embed="rSvg"/></a:ext></a:extLst></a:blip></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    <w:p>${drawingMl('rEmf', 'inline', 90, 90)}${drawingMl('rWmf', 'inline', 90, 90)}${drawingMl('rTiff', 'inline', 90, 90)}</w:p>
    <w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><wpg:wgp/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    <w:p><w:r><w:object><o:OLEObject r:id="rObject"/></w:object></w:r></w:p>
    <w:p><w:r><w:object><v:shape style="width:36pt;height:18pt"><v:imagedata r:id="rObjectPreview"/></v:shape><o:OLEObject r:id="rObject"/></w:object></w:r></w:p>
    <w:sectPr/>
  </w:body></w:document>`
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('word/document.xml', mainXml)
  zip.file('word/_rels/document.xml.rels', `<Relationships>
    ${relationship('rPng', 'media/image.png')}
    ${relationship('rJpeg', 'media/image.jpeg')}
    ${relationship('rGif', 'media/image.gif')}
    ${relationship('rSvgFallback', 'media/svg-fallback.png')}
    ${relationship('rSvg', 'media/image.svg')}
    ${relationship('rEmf', 'media/image.emf')}
    ${relationship('rWmf', 'media/image.wmf')}
    ${relationship('rTiff', 'media/image.tiff')}
    ${relationship('rObjectPreview', 'media/object-preview.png')}
    <Relationship Target="embeddings/object.bin" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Id="rObject"/>
  </Relationships>`)
  zip.file('word/header1.xml', `<w:hdr xmlns:w="x" xmlns:r="x" xmlns:a="x" xmlns:wp="x" xmlns:pic="x"><w:p>${drawingMl('rBmp', 'inline', 64, 32)}</w:p></w:hdr>`)
  zip.file('word/_rels/header1.xml.rels', `<Relationships>${relationship('rBmp', 'media/image.bmp')}</Relationships>`)
  zip.file('word/footer1.xml', `<w:ftr xmlns:w="x" xmlns:r="x" xmlns:a="x" xmlns:wp="x" xmlns:pic="x"><w:p>${drawingMl('rWebp', 'inline', 48, 24)}</w:p></w:ftr>`)
  zip.file('word/_rels/footer1.xml.rels', `<Relationships>${relationship('rWebp', 'media/image.webp')}</Relationships>`)

  zip.file('word/media/image.png', PNG_1X1)
  zip.file('word/media/image.jpeg', JPEG_16X16)
  zip.file('word/media/image.gif', GIF_2X2)
  zip.file('word/media/svg-fallback.png', PNG_1X1)
  zip.file('word/media/image.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
  zip.file('word/media/image.emf', Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]))
  zip.file('word/media/image.wmf', Buffer.from([0xd7, 0xcd, 0xc6, 0x9a]))
  zip.file('word/media/image.tiff', Buffer.from([0x49, 0x49, 0x2a, 0x00]))
  zip.file('word/media/image.bmp', BMP_1X1)
  zip.file('word/media/image.webp', WEBP_2X2)
  zip.file('word/media/object-preview.png', PNG_1X1)
  zip.file('word/embeddings/object.bin', Buffer.from([1, 2, 3]))
  return { zip, mainXml }
}

describe('DOCX Univer 图片适配', () => {
  it('稳定映射正文、页眉页脚、inline、anchor、VML 和重复图片，并明确警告不支持对象', async () => {
    const { zip, mainXml } = await makeDrawingFixture()
    const built = await buildDocxUniverDocumentV1({
      zip,
      mainXml,
      documentId: 'drawing-fixture',
      title: 'drawing-fixture.docx',
    })

    const drawings = (built.document.drawings ?? {}) as Record<string, UniverImageDrawingV1>
    const order = built.document.drawingsOrder ?? []
    expect(order).toHaveLength(8)
    expect(new Set(order).size).toBe(8)
    expect(order.map((id) => drawings[id]?.source)).toEqual([
      expect.stringMatching(/^data:image\/png;base64,/),
      expect.stringMatching(/^data:image\/jpeg;base64,/),
      expect.stringMatching(/^data:image\/gif;base64,/),
      expect.stringMatching(/^data:image\/png;base64,/),
      expect.stringMatching(/^data:image\/png;base64,/),
      expect.stringMatching(/^data:image\/png;base64,/),
      expect.stringMatching(/^data:image\/bmp;base64,/),
      expect.stringMatching(/^data:image\/webp;base64,/),
    ])
    expect(order[0]).not.toBe(order[3])
    expect(drawings[order[0]]?.source).toBe(drawings[order[3]]?.source)
    expect(drawings[order[0]]?.docTransform.size).toEqual({ width: 100, height: 50 })
    expect(drawings[order[1]]?.docTransform).toMatchObject({
      size: { width: 200, height: 120 },
      positionH: { relativeFrom: 0, align: 0 },
      positionV: { relativeFrom: 1, posOffset: 10 },
    })
    expect(drawings[order[2]]?.docTransform.size).toEqual({ width: 96, height: 48 })
    expect(drawings[order[5]]?.docTransform.size).toEqual({ width: 48, height: 24 })
    expect(drawings[order[6]]).toMatchObject({ isMultiTransform: 1 })
    expect(drawings[order[7]]).toMatchObject({ isMultiTransform: 1 })
    expect(built.warnings.join('\n')).toMatch(/EMF/)
    expect(built.warnings.join('\n')).toMatch(/WMF/)
    expect(built.warnings.join('\n')).toMatch(/SVG/)
    expect(built.warnings.join('\n')).toMatch(/TIFF/)
    expect(built.warnings.join('\n')).toMatch(/组合图形/)
    expect(built.warnings.join('\n')).toMatch(/嵌入对象/)
    expect(built.warnings.join('\n')).toMatch(/仅显示其浏览器可用的栅格预览/)
  })

  it('映射 VML left/top 与可可靠读取的 DrawingML/VML rotation、flip、crop', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/media/image.png', PNG_1X1)
    zip.file('word/_rels/document.xml.rels', `<Relationships>${relationship('rPng', 'media/image.png')}</Relationships>`)
    const drawingPackage = await prepareDocxUniverDrawingPackageV1(zip)
    const context = await prepareDocxUniverDrawingPartContextV1(zip, drawingPackage, {
      part: 'BODY',
      partIndex: 1,
      partPath: 'word/document.xml',
      documentId: 'transform-fixture',
      drawingSequence: { value: 0 },
    })

    const vml = readDocxUniverDrawingV1(
      '<w:pict><v:shape style="position:absolute;left:18pt;top:-9pt;width:72pt;height:36pt;rotation:90;flip:x"><v:imagedata r:id="rPng"/></v:shape></w:pict>',
      context,
    )?.drawing
    expect(vml?.transform).toMatchObject({
      left: 24,
      top: -12,
      width: 96,
      height: 48,
      angle: 90,
      flipX: true,
      flipY: false,
    })
    expect(vml?.docTransform).toMatchObject({
      positionH: { posOffset: 24 },
      positionV: { posOffset: -12 },
      angle: 90,
    })

    const drawingMl = readDocxUniverDrawingV1(
      '<w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><a:graphic><pic:pic><pic:blipFill><a:blip r:embed="rPng"/><a:srcRect l="10000" t="20000" r="30000" b="40000"/></pic:blipFill><pic:spPr><a:xfrm rot="5400000" flipH="1" flipV="true"/></pic:spPr></pic:pic></a:graphic></wp:inline></w:drawing>',
      context,
    )?.drawing
    expect(drawingMl?.transform).toMatchObject({ angle: 90, flipX: true, flipY: true })
    expect(drawingMl?.docTransform.angle).toBe(90)
    expect(drawingMl?.srcRect).toEqual({
      left: expect.closeTo(100 / 6),
      top: expect.closeTo(25),
      right: expect.closeTo(50),
      bottom: expect.closeTo(50),
    })

    const invalidCrop = readDocxUniverDrawingV1(
      '<w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><a:graphic><pic:pic><pic:blipFill><a:blip r:embed="rPng"/><a:srcRect l="90000" r="20000"/></pic:blipFill></pic:pic></a:graphic></wp:inline></w:drawing>',
      context,
    )?.drawing
    expect(invalidCrop?.srcRect).toBeUndefined()
    expect(getDocxUniverDrawingWarningsV1(drawingPackage)
      .map(parseOfficeDrawingDegradationV1))
      .toContainEqual(expect.objectContaining({ reason: 'CROP_NOT_APPLIED', sequence: 3 }))
  })

  it('把缺失/不支持图片对象输出为可显示的结构化降级记录', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/media/image.emf', Buffer.from([0xd7, 0xcd, 0xc6, 0x9a]))
    zip.file('word/_rels/document.xml.rels', `<Relationships>${relationship('rEmf', 'media/image.emf')}</Relationships>`)
    const drawingPackage = await prepareDocxUniverDrawingPackageV1(zip)
    const context = await prepareDocxUniverDrawingPartContextV1(zip, drawingPackage, {
      part: 'BODY',
      partIndex: 1,
      partPath: 'word/document.xml',
      documentId: 'degradation-fixture',
      drawingSequence: { value: 0 },
    })

    expect(readDocxUniverDrawingV1('<w:drawing><a:blip r:embed="rEmf"/></w:drawing>', context)).toBeUndefined()
    expect(readDocxUniverDrawingV1('<w:drawing><a:blip r:embed="rMissing"/></w:drawing>', context)).toBeUndefined()

    const records = getDocxUniverDrawingWarningsV1(drawingPackage)
      .map(parseOfficeDrawingDegradationV1)
      .filter((item) => item !== null)
    expect(records).toEqual([
      expect.objectContaining({
        part: 'BODY',
        sequence: 1,
        reason: 'UNSUPPORTED_FORMAT',
        relationshipId: 'rEmf',
        format: 'WMF',
      }),
      expect.objectContaining({
        part: 'BODY',
        sequence: 2,
        reason: 'RELATIONSHIP_NOT_FOUND',
        relationshipId: 'rMissing',
      }),
    ])
  })

  it('外链图片降级不会把 file URI、UNC、HTTPS 路径或凭据带入投影消息', async () => {
    const fileTarget = 'file:///C:/Users/Alice/private/client-logo.png'
    const uncTarget = String.raw`\\fileserver\finance\budget-2026.png`
    const httpsTarget = 'https://alice:supersecret@example.com/private/logo.png?token=abc123'
    const externalDrawing = (relationshipId: string) => `<w:p><w:r><w:drawing><wp:inline>
      <wp:extent cx="952500" cy="476250"/><a:graphic><pic:pic><pic:blipFill>
      <a:blip r:link="${relationshipId}"/>
      </pic:blipFill></pic:pic></a:graphic>
    </wp:inline></w:drawing></w:r></w:p>`
    const mainXml = `<w:document xmlns:w="w" xmlns:r="r" xmlns:wp="wp" xmlns:a="a" xmlns:pic="pic">
      <w:body>
        ${externalDrawing('rFile')}
        ${externalDrawing('rUnc')}
        ${externalDrawing('rHttps')}
        <w:sectPr/>
      </w:body>
    </w:document>`
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/document.xml', mainXml)
    zip.file('word/_rels/document.xml.rels', `<Relationships>
      <Relationship Id="rFile" Target="${fileTarget}" TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/>
      <Relationship Id="rUnc" Target="${uncTarget}" TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/>
      <Relationship Id="rHttps" Target="${httpsTarget}" TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/>
    </Relationships>`)

    const built = await buildDocxUniverDocumentV1({
      zip,
      mainXml,
      documentId: 'external-image-fixture',
      title: 'external-image.docx',
    })
    const records = built.warnings
      .map(parseOfficeDrawingDegradationV1)
      .filter((item) => item !== null)
    expect(records).toEqual([
      expect.objectContaining({ reason: 'EXTERNAL_IMAGE', relationshipId: 'rFile', format: 'EXTERNAL_FILE_URI' }),
      expect.objectContaining({ reason: 'EXTERNAL_IMAGE', relationshipId: 'rUnc', format: 'EXTERNAL_UNC_PATH' }),
      expect.objectContaining({ reason: 'EXTERNAL_IMAGE', relationshipId: 'rHttps', format: 'EXTERNAL_HTTPS_URL' }),
    ])
    for (const record of records) {
      expect(record).not.toHaveProperty('target')
      expect(record).not.toHaveProperty('packagePath')
    }

    const transported = JSON.stringify({ warnings: built.warnings, document: built.document })
    for (const secret of [
      fileTarget,
      uncTarget,
      httpsTarget,
      'C:/Users/Alice',
      'fileserver',
      'supersecret',
      'abc123',
    ]) expect(transported).not.toContain(secret)
  })

  it('对未映射的 tight/through 环绕多边形逐对象输出结构化降级记录', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/media/image.png', PNG_1X1)
    zip.file('word/_rels/document.xml.rels', `<Relationships>${relationship('rPng', 'media/image.png')}</Relationships>`)
    const drawingPackage = await prepareDocxUniverDrawingPackageV1(zip)
    const context = await prepareDocxUniverDrawingPartContextV1(zip, drawingPackage, {
      part: 'BODY',
      partIndex: 1,
      partPath: 'word/document.xml',
      documentId: 'wrap-fixture',
      drawingSequence: { value: 0 },
    })

    const tight = readDocxUniverDrawingV1(
      '<w:drawing><wp:anchor><wp:extent cx="952500" cy="476250"/><wp:wrapTight wrapText="bothSides"><wp:wrapPolygon edited="1"><wp:start x="0" y="0"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="21600" y="21600"/></wp:wrapPolygon></wp:wrapTight><a:graphic><pic:pic><pic:blipFill><a:blip r:embed="rPng"/></pic:blipFill></pic:pic></a:graphic></wp:anchor></w:drawing>',
      context,
    )
    const through = readDocxUniverDrawingV1(
      '<w:drawing><wp:anchor><wp:extent cx="952500" cy="476250"/><wp:wrapThrough wrapText="largest"><wp:wrapPolygon><wp:start x="0" y="0"/><wp:lineTo x="21600" y="21600"/></wp:wrapPolygon></wp:wrapThrough><a:graphic><pic:pic><pic:blipFill><a:blip r:embed="rPng"/></pic:blipFill></pic:pic></a:graphic></wp:anchor></w:drawing>',
      context,
    )

    expect(tight?.drawing.layoutType).toBe(5)
    expect(through?.drawing.layoutType).toBe(4)
    expect(getDocxUniverDrawingWarningsV1(drawingPackage)
      .map(parseOfficeDrawingDegradationV1))
      .toEqual([
        expect.objectContaining({
          reason: 'COMPLEX_WRAP_APPROXIMATION',
          relationshipId: 'rPng',
          sequence: 1,
        }),
        expect.objectContaining({
          reason: 'COMPLEX_WRAP_APPROXIMATION',
          relationshipId: 'rPng',
          sequence: 2,
        }),
      ])
  })

  it('提供 mc:AlternateContent 单分支选择接缝，避免 Choice/Fallback 重复投影', () => {
    const xml = '<w:r><mc:AlternateContent><mc:Choice Requires="wp"><w:drawing><a:blip r:embed="rChoice"/></w:drawing></mc:Choice><mc:Fallback><w:pict><v:imagedata r:id="rFallback"/></w:pict></mc:Fallback></mc:AlternateContent></w:r>'
    const selected = selectDocxUniverAlternateContentV1(xml)
    expect(selected).toContain('rChoice')
    expect(selected).not.toContain('rFallback')
    expect(selected.match(/r:(?:embed|id)=/g)).toHaveLength(1)
  })

  it('Choice 需要不可解析能力时选择可读 Fallback，并按归一化分支只计一个对象', async () => {
    const zip = new JSZip()
    const mainXml = `<w:document xmlns:w="w" xmlns:r="r" xmlns:mc="mc" xmlns:wps="wps" xmlns:wp="wp" xmlns:a="a" xmlns:v="v">
      <w:body><w:p><w:r><mc:AlternateContent>
        <mc:Choice Requires="wps"><w:drawing><wp:inline><a:graphic><a:graphicData><wps:wsp/></a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice>
        <mc:Fallback><w:pict><v:shape style="width:72pt;height:36pt"><v:imagedata r:id="rFallback"/></v:shape></w:pict></mc:Fallback>
      </mc:AlternateContent></w:r></w:p><w:sectPr/></w:body>
    </w:document>`
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/document.xml', mainXml)
    zip.file('word/_rels/document.xml.rels', `<Relationships>${relationship('rFallback', 'media/fallback.png')}</Relationships>`)
    zip.file('word/media/fallback.png', PNG_1X1)

    const built = await buildDocxUniverDocumentV1({
      zip,
      mainXml,
      documentId: 'alternate-fallback-fixture',
      title: 'alternate-fallback.docx',
    })

    expect(built.statistics.drawingCount).toBe(1)
    expect(built.document.drawingsOrder).toHaveLength(1)
    expect(Object.values(built.document.drawings ?? {})[0]).toMatchObject({
      source: expect.stringMatching(/^data:image\/png;base64,/),
    })
    expect(built.warnings.join('\n')).not.toMatch(/另有 1 个绘图对象/)
  })

})
