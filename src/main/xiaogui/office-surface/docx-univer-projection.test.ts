import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { projectDocxToUniverV1 } from './docx-univer-projection'

async function makeDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('word/document.xml', `
    <w:document
      xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
      xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
    >
      <w:body>
        <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="4BACC6"/><w:sz w:val="32"/></w:rPr><w:t>项目名称：下盐公路工程</w:t></w:r><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="测试图片"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImage1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
        <w:tbl><w:tr>
          <w:tc><w:p><w:r><w:t>建设单位</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>华东送变电工程有限公司</w:t></w:r></w:p></w:tc>
        </w:tr></w:tbl>
        <w:p><w:r><w:t>再次引用：下盐公路工程</w:t></w:r></w:p>
        <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
      </w:body>
    </w:document>
  `)
  zip.file('word/_rels/document.xml.rels', `
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
    </Relationships>
  `)
  zip.file('word/media/image1.png', Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xcw6WQAAAABJRU5ErkJggg==',
    'base64',
  ))
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('DOCX 到 Office Surface 结构化投影', () => {
  it('保留正文和表格文字，并按逻辑锚点区分重复字段', async () => {
    const projection = await projectDocxToUniverV1({
      content: await makeDocx(),
      title: '测试项目.docx',
      purpose: 'TEMPLATE_DRAFT',
      readOnly: false,
      fields: [{ fieldId: 'project.name', displayName: '项目名称', occurrenceIds: ['o1', 'o2'] }],
      occurrences: [
        {
          occurrenceId: 'o1',
          fieldId: 'project.name',
          originalText: '下盐公路工程',
          sourceAnchor: { part: 'BODY', paragraphIndex: 1 },
          state: 'FIELD',
        },
        {
          occurrenceId: 'o2',
          fieldId: 'project.name',
          originalText: '下盐公路工程',
          sourceAnchor: { part: 'BODY', paragraphIndex: 2 },
          state: 'WARNING',
        },
        {
          occurrenceId: 'o3',
          fieldId: 'owner',
          originalText: '华东送变电工程有限公司',
          sourceAnchor: { part: 'TABLE_CELL', tableIndex: 1, rowIndex: 1, cellIndex: 2 },
          state: 'FIELD',
        },
      ],
    })

    expect(projection.plainText).toContain('项目名称：下盐公路工程')
    expect(projection).toMatchObject({ purpose: 'TEMPLATE_DRAFT', readOnly: false })
    expect(projection.plainText).toContain('华东送变电工程有限公司')
    expect(projection.statistics).toMatchObject({
      paragraphCount: 4,
      tableCount: 1,
      tableCellCount: 2,
      mappedOccurrenceCount: 3,
      unmappedOccurrenceCount: 0,
    })
    const document = projection.univerDocument as {
      body: {
        dataStream: string
        customBlocks?: Array<{ startIndex: number; blockId: string }>
        textRuns: Array<{ st: number; ed: number; ts?: { bg?: { rgb?: string }; bl?: number; fs?: number } }>
      }
      drawings?: Record<string, { source?: string; imageSourceType?: string; docTransform?: { size?: { width?: number } } }>
      drawingsOrder?: string[]
      resources?: Array<{ name: string; data: string }>
      tableSource?: Record<string, unknown>
      documentStyle: { pageSize?: { width: number; height: number } }
    }
    expect(document.body.dataStream).toContain('\x1A\x1B\x1C')
    expect(Object.keys(document.tableSource ?? {})).toHaveLength(1)
    expect(document.documentStyle.pageSize?.width).toBeCloseTo(11906 / 15, 1)
    expect(document.body.customBlocks).toEqual([{ startIndex: 11, blockId: 'xiaogui-body-0-drawing-1', blockType: 0 }])
    expect(document.body.dataStream[11]).toBe('\b')
    expect(document.drawingsOrder).toEqual(['xiaogui-body-0-drawing-1'])
    expect(document.drawings?.['xiaogui-body-0-drawing-1']).toMatchObject({
      imageSourceType: 'BASE64',
      docTransform: { size: { width: 100 } },
    })
    expect(document.drawings?.['xiaogui-body-0-drawing-1'].source).toMatch(/^data:image\/png;base64,/)
    expect(document.resources).toEqual([
      expect.objectContaining({
        name: 'DOC_DRAWING_PLUGIN',
        data: expect.stringContaining('xiaogui-body-0-drawing-1'),
      }),
    ])
    for (const occurrence of projection.occurrences) {
      expect(document.body.dataStream.slice(occurrence.startUtf16, occurrence.endUtf16Exclusive))
        .toBe(occurrence.originalText)
      expect(document.body.textRuns.some((run) => (
        run.st <= occurrence.startUtf16
        && occurrence.endUtf16Exclusive <= run.ed
        && run.ts?.bg?.rgb?.startsWith('#FF')
      ))).toBe(true)
    }
    expect(document.body.textRuns.some((run) => run.ts?.bl === 1 && run.ts?.fs === 16)).toBe(true)
  })
})
