import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { buildDocxUniverDocumentV1 } from './docx-univer-document-adapter'
import type { UniverImageDrawingV1 } from './docx-univer-drawing-adapter'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xcw6WQAAAABJRU5ErkJggg==',
  'base64',
)

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
  zip.file('word/media/image.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  zip.file('word/media/image.gif', Buffer.from('GIF89a', 'ascii'))
  zip.file('word/media/svg-fallback.png', PNG_1X1)
  zip.file('word/media/image.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
  zip.file('word/media/image.emf', Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]))
  zip.file('word/media/image.wmf', Buffer.from([0xd7, 0xcd, 0xc6, 0x9a]))
  zip.file('word/media/image.tiff', Buffer.from([0x49, 0x49, 0x2a, 0x00]))
  zip.file('word/media/image.bmp', Buffer.from('BM', 'ascii'))
  zip.file('word/media/image.webp', Buffer.from('RIFF0000WEBP', 'ascii'))
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

})
