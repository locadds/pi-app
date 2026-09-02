import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { renderAdvancedTemplateV1 } from './work-docx-advanced-renderer'

const outputRoot = process.env.XIAOGUI_ADVANCED_GENERATION_SMOKE_ROOT
const realSmoke = outputRoot ? it : it.skip

describe('WORK 高级 Word 生成真实桌面冒烟', () => {
  realSmoke('生成最小重复与条件成品且不修改模板', async () => {
    await mkdir(outputRoot!, { recursive: true })
    const sourcePath = join(outputRoot!, '小规模板-原始.docx')
    const outputPath = join(outputRoot!, '小规成品-预览.docx')
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>项目：{{项目名称}}</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>事项</w:t></w:r></w:p></w:tc></w:tr><w:sdt><w:sdtPr><w:tag w:val="xiaogui.repeat:任务"/></w:sdtPr><w:sdtContent><w:tr><w:tc><w:p><w:r><w:t>旧任务</w:t></w:r></w:p></w:tc></w:tr></w:sdtContent></w:sdt></w:tbl><w:sdt><w:sdtPr><w:tag w:val="xiaogui.conditional:显示说明"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>已人工确认</w:t></w:r></w:p></w:sdtContent></w:sdt><w:sectPr/></w:body></w:document>')
    const source = await zip.generateAsync({ type: 'nodebuffer' })
    const sourceSha256 = createHash('sha256').update(source).digest('hex')
    await writeFile(sourcePath, source, { flag: 'wx' })
    const result = await renderAdvancedTemplateV1({
      template: source,
      displayName: '小规模板-原始.docx',
      data: {
        dataVersion: 1,
        variables: [{ name: '项目名称', status: 'RESOLVED', value: '下盐路迁改' }],
        repeatBlocks: [{ name: '任务', status: 'RESOLVED', records: [
          { slots: [{ slotId: 's1', value: '方案编制' }] },
          { slots: [{ slotId: 's1', value: '成果复核' }] },
        ] }],
        conditionalBlocks: [{ name: '显示说明', status: 'RESOLVED', value: true }],
      },
    })
    await writeFile(outputPath, result.content, { flag: 'wx' })
    expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex')).toBe(sourceSha256)
    expect(createHash('sha256').update(await readFile(outputPath)).digest('hex')).toBe(result.plan.previewSha256)
    expect(result.plan.originalTemplateUnchanged).toBe(true)
  })
})
