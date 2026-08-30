import { describe, expect, it } from 'vitest'

import {
  adaptDocxTableToUniverV1,
  createDocxTableStyleCatalogV1,
} from './docx-univer-table-adapter'

const TABLE_STYLES_XML = `
  <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:type="table" w:styleId="TableBase">
      <w:tblPr>
        <w:tblBorders>
          <w:top w:val="single" w:sz="12" w:color="1F4E78"/>
          <w:left w:val="single" w:sz="12" w:color="1F4E78"/>
          <w:bottom w:val="single" w:sz="12" w:color="1F4E78"/>
          <w:right w:val="single" w:sz="12" w:color="1F4E78"/>
          <w:insideH w:val="dashed" w:sz="6" w:color="5B9BD5"/>
          <w:insideV w:val="dotted" w:sz="6" w:color="5B9BD5"/>
        </w:tblBorders>
      </w:tblPr>
    </w:style>
    <w:style w:type="table" w:styleId="TableGrid">
      <w:basedOn w:val="TableBase"/>
      <w:tblPr>
        <w:tblCellMar>
          <w:top w:w="60" w:type="dxa"/>
          <w:start w:w="120" w:type="dxa"/>
          <w:bottom w:w="60" w:type="dxa"/>
          <w:end w:w="120" w:type="dxa"/>
        </w:tblCellMar>
      </w:tblPr>
    </w:style>
  </w:styles>
`

const MERGED_TABLE_XML = `
  <w:tbl xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:tblPr>
      <w:tblStyle w:val="TableGrid"/>
      <w:tblW w:w="7200" w:type="dxa"/>
      <w:jc w:val="center"/>
      <w:tblLayout w:type="fixed"/>
    </w:tblPr>
    <w:tblGrid>
      <w:gridCol w:w="1800"/>
      <w:gridCol w:w="2400"/>
      <w:gridCol w:w="3000"/>
    </w:tblGrid>
    <w:tr>
      <w:trPr><w:trHeight w:val="600" w:hRule="exact"/><w:tblHeader/></w:trPr>
      <w:tc>
        <w:tcPr>
          <w:gridSpan w:val="2"/>
          <w:vMerge w:val="restart"/>
          <w:shd w:fill="FFF2CC"/>
          <w:vAlign w:val="center"/>
          <w:tcBorders><w:top w:val="double" w:sz="18" w:color="C00000"/></w:tcBorders>
        </w:tcPr>
        <w:p><w:r><w:t>合并标题</w:t></w:r></w:p>
      </w:tc>
      <w:tc><w:p><w:r><w:t>末列</w:t></w:r></w:p></w:tc>
    </w:tr>
    <w:tr>
      <w:trPr><w:trHeight w:val="450" w:hRule="atLeast"/></w:trPr>
      <w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:p/></w:tc>
      <w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>责任单位</w:t></w:r></w:p></w:tc>
    </w:tr>
  </w:tbl>
`

describe('DOCX 到 Univer 表格深适配器', () => {
  it('按 Univer 逻辑网格保留合并、尺寸、边框、底纹和对齐', () => {
    const adapted = adaptDocxTableToUniverV1({
      tableXml: MERGED_TABLE_XML,
      tableId: 'table-1',
      styles: createDocxTableStyleCatalogV1(TABLE_STYLES_XML),
    })

    expect(adapted).toMatchObject({
      sourceCellCount: 4,
      logicalColumnCount: 3,
      nestedTableCount: 0,
      warnings: [],
      table: {
        tableId: 'table-1',
        align: 1,
        layout: 1,
        size: { type: 1, width: { v: 480 } },
        tableColumns: [
          { size: { type: 1, width: { v: 120 } } },
          { size: { type: 1, width: { v: 160 } } },
          { size: { type: 1, width: { v: 200 } } },
        ],
        cellMargin: {
          top: { v: 4 },
          start: { v: 8 },
          bottom: { v: 4 },
          end: { v: 8 },
        },
        tableRows: [
          {
            trHeight: { val: { v: 40 }, hRule: 2 },
            repeatHeaderRow: 1,
            tableCells: [
              {
                columnSpan: 2,
                rowSpan: 2,
                backgroundColor: { rgb: '#FFF2CC' },
                vAlign: 3,
                borderTop: { color: { rgb: '#C00000' }, width: { v: 3 }, dashStyle: 1 },
              },
              { columnSpan: 0 },
              expect.objectContaining({
                borderRight: { color: { rgb: '#1F4E78' }, width: { v: 2 }, dashStyle: 1 },
              }),
            ],
          },
          {
            trHeight: { val: { v: 30 }, hRule: 1 },
            tableCells: [
              { rowSpan: 0, columnSpan: 0 },
              { rowSpan: 0, columnSpan: 0 },
              expect.objectContaining({ size: { type: 1, width: { v: 200 } } }),
            ],
          },
        ],
      },
    })
    expect(adapted.rows[0].cells.map((cell) => cell.sourceCellIndex)).toEqual([1, undefined, 2])
    expect(adapted.rows[1].cells.map((cell) => cell.sourceCellIndex)).toEqual([1, undefined, 2])
    expect(adapted.rows[0].cells[0].paragraphXmls).toHaveLength(1)
  })

  it('对嵌套表格和复杂自动适配结构给出明确告警', () => {
    const adapted = adaptDocxTableToUniverV1({
      tableId: 'table-warning',
      styles: createDocxTableStyleCatalogV1(''),
      tableXml: `
        <w:tbl xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblpPr/></w:tblPr>
          <w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>
          <w:tr>
            <w:trPr><w:gridBefore w:val="1"/></w:trPr>
            <w:tc>
              <w:p><w:r><w:t>嵌套前</w:t></w:r></w:p>
              <w:tbl><w:tr><w:tc><w:p><w:r><w:t>嵌套内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
              <w:p><w:r><w:t>嵌套后</w:t></w:r></w:p>
            </w:tc>
          </w:tr>
        </w:tbl>
      `,
    })

    expect(adapted.nestedTableCount).toBe(1)
    expect(adapted.rows[0].cells.find((cell) => cell.sourceCellIndex === 1)?.paragraphXmls).toHaveLength(2)
    expect(adapted.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('嵌套表格'),
      expect.stringContaining('百分比或自动宽度'),
      expect.stringContaining('浮动表格'),
      expect.stringContaining('gridBefore/gridAfter'),
    ]))
  })
})
