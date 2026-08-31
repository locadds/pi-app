import JSZip from 'jszip'
import { DocumentDataModel } from '@univerjs/core'
import { DocumentViewModel } from '@univerjs/engine-render'
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

async function makeMergedTableDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('word/styles.xml', `
    <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="table" w:styleId="TableGrid">
        <w:tblPr>
          <w:tblBorders>
            <w:top w:val="single" w:sz="12" w:color="1F4E78"/>
            <w:left w:val="single" w:sz="12" w:color="1F4E78"/>
            <w:bottom w:val="single" w:sz="12" w:color="1F4E78"/>
            <w:right w:val="single" w:sz="12" w:color="1F4E78"/>
            <w:insideH w:val="single" w:sz="6" w:color="5B9BD5"/>
            <w:insideV w:val="single" w:sz="6" w:color="5B9BD5"/>
          </w:tblBorders>
        </w:tblPr>
      </w:style>
    </w:styles>
  `)
  zip.file('word/document.xml', `
    <w:document
      xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
      xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
    >
      <w:body>
        <w:p><w:r><w:t>表格前</w:t></w:r></w:p>
        <w:tbl>
          <w:tblPr>
            <w:tblStyle w:val="TableGrid"/>
            <w:tblW w:w="7200" w:type="dxa"/>
            <w:jc w:val="center"/>
            <w:tblLayout w:type="fixed"/>
          </w:tblPr>
          <w:tblGrid>
            <w:gridCol w:w="1800"/><w:gridCol w:w="2400"/><w:gridCol w:w="3000"/>
          </w:tblGrid>
          <w:tr>
            <w:trPr><w:trHeight w:val="600" w:hRule="exact"/></w:trPr>
            <w:tc>
              <w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/><w:shd w:fill="FFF2CC"/><w:vAlign w:val="center"/></w:tcPr>
              <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="C00000"/></w:rPr><w:t>合并标题</w:t></w:r><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="2" name="单元格图片"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImage1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
            </w:tc>
            <w:tc><w:p><w:r><w:t>末列</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:trPr><w:trHeight w:val="450" w:hRule="atLeast"/></w:trPr>
            <w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:p/></w:tc>
            <w:tc><w:p><w:r><w:t>责任单位</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl>
        <w:p><w:r><w:t>表格后</w:t></w:r></w:p>
        <w:sectPr/>
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

async function makeNestedTableDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('word/document.xml', `
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:tbl>
          <w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr>
          <w:tr><w:tc>
            <w:p><w:r><w:t>外层前</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>嵌套内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            <w:p><w:r><w:t>外层后</w:t></w:r></w:p>
          </w:tc></w:tr>
        </w:tbl>
        <w:sectPr/>
      </w:body>
    </w:document>
  `)
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function makeRepeatedTextDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>名称：旧项目；简称：旧项目</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function makeHeaderFooterTableDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('word/settings.xml', `
    <w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:evenAndOddHeaders/>
    </w:settings>
  `)
  zip.file('word/document.xml', `
    <w:document
      xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    >
      <w:body>
        <w:p><w:r><w:t>正文</w:t></w:r></w:p>
        <w:sectPr>
          <w:headerReference w:type="even" r:id="rIdHeaderEven"/>
          <w:headerReference w:type="default" r:id="rIdHeaderDefault"/>
          <w:headerReference w:type="first" r:id="rIdHeaderFirst"/>
          <w:footerReference w:type="first" r:id="rIdFooterFirst"/>
          <w:footerReference w:type="default" r:id="rIdFooterDefault"/>
          <w:footerReference w:type="even" r:id="rIdFooterEven"/>
          <w:titlePg/>
        </w:sectPr>
      </w:body>
    </w:document>
  `)
  zip.file('word/_rels/document.xml.rels', `
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdFooterEven" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer3.xml"/>
      <Relationship Id="rIdHeaderDefault" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/>
      <Relationship Id="rIdFooterFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
      <Relationship Id="rIdHeaderEven" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header3.xml"/>
      <Relationship Id="rIdFooterDefault" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer2.xml"/>
      <Relationship Id="rIdHeaderFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
    </Relationships>
  `)
  for (const [kind, values] of Object.entries({
    header: ['首页页眉', '默认页眉', '偶数页页眉'],
    footer: ['首页页脚', '默认页脚', '偶数页页脚'],
  })) {
    for (let index = 0; index < values.length; index += 1) {
      const root = kind === 'header' ? 'hdr' : 'ftr'
      zip.file(`word/${kind}${index + 1}.xml`, `
        <w:${root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:tbl><w:tblGrid><w:gridCol w:w="1800"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>${values[index]}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:${root}>
      `)
    }
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function makeMultiSectionHeaderDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('word/document.xml', `
    <w:document
      xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    >
      <w:body>
        <w:p>
          <w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rIdHeaderFirstSection"/></w:sectPr></w:pPr>
          <w:r><w:t>第一节</w:t></w:r>
        </w:p>
        <w:p><w:r><w:t>末节</w:t></w:r></w:p>
        <w:sectPr><w:headerReference w:type="default" r:id="rIdHeaderLastSection"/></w:sectPr>
      </w:body>
    </w:document>
  `)
  zip.file('word/_rels/document.xml.rels', `
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdHeaderFirstSection" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
      <Relationship Id="rIdHeaderLastSection" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/>
    </Relationships>
  `)
  zip.file('word/header1.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>第一节页眉</w:t></w:r></w:p></w:hdr>')
  zip.file('word/header2.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>末节页眉</w:t></w:r></w:p></w:hdr>')
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('DOCX 到 Office Surface 结构化投影', () => {
  it('同段相同文字按模型给出的局部范围只标黄指定一次', async () => {
    const paragraph = '名称：旧项目；简称：旧项目'
    const selected = '旧项目'
    const secondStart = paragraph.lastIndexOf(selected)
    const projection = await projectDocxToUniverV1({
      content: await makeRepeatedTextDocx(),
      title: '重复文字.docx',
      purpose: 'TEMPLATE_DRAFT',
      readOnly: false,
      occurrences: [{
        occurrenceId: 'second-project-name',
        fieldId: 'project.short-name',
        originalText: selected,
        sourceAnchor: { part: 'BODY', paragraphIndex: 1 },
        textRange: {
          startUtf16: secondStart,
          endUtf16Exclusive: secondStart + selected.length,
        },
        state: 'FIELD',
      }],
    })
    const document = projection.univerDocument as {
      body: { dataStream: string; textRuns: Array<{ st: number; ed: number; ts?: { bg?: { rgb?: string } } }> }
    }
    const firstDocumentStart = document.body.dataStream.indexOf(selected)
    const secondDocumentStart = document.body.dataStream.lastIndexOf(selected)

    expect(projection.occurrences[0]).toMatchObject({
      startUtf16: secondDocumentStart,
      endUtf16Exclusive: secondDocumentStart + selected.length,
    })
    expect(document.body.textRuns.some((run) => (
      run.st <= secondDocumentStart && secondDocumentStart < run.ed && run.ts?.bg?.rgb === '#FFF2B2'
    ))).toBe(true)
    expect(document.body.textRuns.some((run) => (
      run.st <= firstDocumentStart && firstDocumentStart < run.ed && run.ts?.bg?.rgb
    ))).toBe(false)
  })

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
        tables?: Array<{ startIndex: number; endIndex: number; tableId: string }>
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
    const table = document.body.tables?.[0]
    expect(document.body.dataStream).toContain('\x1D\x0E\x0F')
    expect(table?.endIndex).toBe(document.body.dataStream.indexOf('\x0F') + 1)
    const viewModel = new DocumentViewModel(new DocumentDataModel(projection.univerDocument))
    expect(viewModel.findTableNodeById('xiaogui-table-body-0-1')).toMatchObject({
      nodeType: 'TABLE',
    })
    viewModel.dispose()
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

  it('把合并表格作为真实 Univer 表格渲染，并保持字段锚点与单元格图片', async () => {
    const projection = await projectDocxToUniverV1({
      content: await makeMergedTableDocx(),
      title: '合并表格.docx',
      purpose: 'TEMPLATE_DRAFT',
      readOnly: false,
      occurrences: [
        {
          occurrenceId: 'merged-title',
          fieldId: 'table.title',
          originalText: '合并标题',
          sourceAnchor: { part: 'TABLE_CELL', tableIndex: 1, rowIndex: 1, cellIndex: 1 },
          state: 'FIELD',
        },
        {
          occurrenceId: 'owner',
          fieldId: 'owner',
          originalText: '责任单位',
          sourceAnchor: { part: 'TABLE_CELL', tableIndex: 1, rowIndex: 2, cellIndex: 2 },
          state: 'WARNING',
        },
      ],
    })

    expect(projection.statistics).toMatchObject({
      tableCount: 1,
      tableCellCount: 4,
      mappedOccurrenceCount: 2,
      unmappedOccurrenceCount: 0,
    })
    const document = projection.univerDocument as {
      body: {
        dataStream: string
        tables: Array<{ startIndex: number; endIndex: number; tableId: string }>
        paragraphs: Array<{ startIndex: number; paragraphStyle?: { horizontalAlign?: number } }>
        customBlocks?: Array<{ startIndex: number; blockId: string }>
        textRuns: Array<{ st: number; ed: number; ts?: { bg?: { rgb?: string }; bl?: number; cl?: { rgb?: string } } }>
      }
      tableSource: Record<string, {
        align: number
        tableRows: Array<{
          trHeight: { val: { v: number }; hRule: number }
          tableCells: Array<{
            columnSpan?: number
            rowSpan?: number
            backgroundColor?: { rgb?: string }
            borderRight?: { color?: { rgb?: string } }
          }>
        }>
      }>
    }
    const table = document.body.tables[0]
    const tableSource = document.tableSource[table.tableId]
    expect(document.body.dataStream.slice(table.startIndex, table.endIndex)).toMatch(/^\x1A[\s\S]*\x0F$/)
    expect(tableSource).toMatchObject({
      align: 1,
      tableRows: [
        {
          trHeight: { val: { v: 40 }, hRule: 2 },
          tableCells: [
            { columnSpan: 2, rowSpan: 2, backgroundColor: { rgb: '#FFF2CC' } },
            { columnSpan: 0 },
            expect.objectContaining({
              borderRight: { color: { rgb: '#1F4E78' }, width: { v: 2 }, dashStyle: 1 },
            }),
          ],
        },
        {
          trHeight: { val: { v: 30 }, hRule: 1 },
          tableCells: [{ rowSpan: 0, columnSpan: 0 }, { rowSpan: 0, columnSpan: 0 }, expect.any(Object)],
        },
      ],
    })
    const viewModel = new DocumentViewModel(new DocumentDataModel(projection.univerDocument))
    const tableNode = viewModel.findTableNodeById(table.tableId)
    expect(tableNode?.children).toHaveLength(2)
    expect(tableNode?.children.map((row) => row.children.length)).toEqual([3, 3])
    viewModel.dispose()
    const drawingIndex = document.body.dataStream.indexOf('\b', table.startIndex)
    expect(drawingIndex).toBeGreaterThan(table.startIndex)
    expect(drawingIndex).toBeLessThan(table.endIndex)
    expect(document.body.customBlocks?.some((block) => block.startIndex === drawingIndex)).toBe(true)
    for (const occurrence of projection.occurrences) {
      expect(document.body.dataStream.slice(occurrence.startUtf16, occurrence.endUtf16Exclusive))
        .toBe(occurrence.originalText)
      expect(document.body.textRuns.some((run) => (
        run.st <= occurrence.startUtf16
        && occurrence.endUtf16Exclusive <= run.ed
        && run.ts?.bg?.rgb?.startsWith('#FF')
      ))).toBe(true)
    }
    const titleStart = document.body.dataStream.indexOf('合并标题')
    expect(document.body.textRuns.some((run) => (
      run.st <= titleStart && titleStart < run.ed && run.ts?.bl === 1 && run.ts?.cl?.rgb === '#C00000'
    ))).toBe(true)
    const titleParagraphEnd = document.body.dataStream.indexOf('\r', titleStart)
    expect(document.body.paragraphs.find((paragraph) => paragraph.startIndex === titleParagraphEnd)?.paragraphStyle)
      .toMatchObject({ horizontalAlign: 2 })
  })

  it('把不支持的嵌套表格与自动宽度提升为投影告警', async () => {
    const projection = await projectDocxToUniverV1({
      content: await makeNestedTableDocx(),
      title: '嵌套表格.docx',
      purpose: 'TEMPLATE_DRAFT',
      readOnly: true,
    })

    expect(projection.plainText).toContain('外层前')
    expect(projection.plainText).toContain('外层后')
    expect(projection.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('嵌套表格'),
      expect.stringContaining('百分比或自动宽度'),
      expect.stringContaining('缺少 tblGrid'),
    ]))
  })

  it('按 document relationships 绑定单节首页、默认和偶数页眉页脚，并让子模型取得表格配置', async () => {
    const projection = await projectDocxToUniverV1({
      content: await makeHeaderFooterTableDocx(),
      title: '页眉页脚表格.docx',
      purpose: 'TEMPLATE_DRAFT',
      readOnly: true,
    })
    const document = projection.univerDocument as {
      documentStyle: {
        defaultHeaderId?: string
        firstPageHeaderId?: string
        evenPageHeaderId?: string
        defaultFooterId?: string
        firstPageFooterId?: string
        evenPageFooterId?: string
        evenAndOddHeaders?: number
        useFirstPageHeaderFooter?: number
      }
      headers: Record<string, {
        body: { dataStream: string; tables: Array<{ startIndex: number; tableId: string }> }
        tableSource?: Record<string, unknown>
      }>
      footers: Record<string, {
        body: { dataStream: string; tables: Array<{ startIndex: number; tableId: string }> }
        tableSource?: Record<string, unknown>
      }>
    }

    expect(document.documentStyle).toMatchObject({
      defaultHeaderId: 'xiaogui-header-2',
      firstPageHeaderId: 'xiaogui-header-1',
      evenPageHeaderId: 'xiaogui-header-3',
      defaultFooterId: 'xiaogui-footer-2',
      firstPageFooterId: 'xiaogui-footer-1',
      evenPageFooterId: 'xiaogui-footer-3',
      evenAndOddHeaders: 1,
      useFirstPageHeaderFooter: 1,
    })
    expect(document.headers['xiaogui-header-2'].body.dataStream).toContain('默认页眉')
    expect(document.footers['xiaogui-footer-3'].body.dataStream).toContain('偶数页页脚')

    const viewModel = new DocumentViewModel(new DocumentDataModel(projection.univerDocument))
    for (const [segmentId, segment] of [
      ['xiaogui-header-2', document.headers['xiaogui-header-2']],
      ['xiaogui-footer-2', document.footers['xiaogui-footer-2']],
    ] as const) {
      const table = segment.body.tables[0]
      expect(segment.tableSource?.[table.tableId]).toBeDefined()
      expect(viewModel.getSelfOrHeaderFooterViewModel(segmentId).getTableByStartIndex(table.startIndex)).toMatchObject({
        tableSource: { tableId: table.tableId },
      })
    }
    viewModel.dispose()
  })

  it('多节页眉无法等价表达时仅绑定末节并显式告警', async () => {
    const projection = await projectDocxToUniverV1({
      content: await makeMultiSectionHeaderDocx(),
      title: '多节页眉.docx',
      purpose: 'TEMPLATE_DRAFT',
      readOnly: true,
    })
    const document = projection.univerDocument as {
      documentStyle: { defaultHeaderId?: string }
      headers: Record<string, { body: { dataStream: string } }>
    }

    expect(document.documentStyle.defaultHeaderId).toBe('xiaogui-header-2')
    expect(document.headers['xiaogui-header-2'].body.dataStream).toContain('末节页眉')
    expect(projection.warnings).toContainEqual(expect.stringContaining('2 个分节'))
    expect(projection.warnings).toContainEqual(expect.stringContaining('仅绑定末节'))
  })
})
