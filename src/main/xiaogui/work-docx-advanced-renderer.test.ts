import { createHash } from 'node:crypto'

import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import type { AdvancedTemplateDataV1 } from '@shared/xiaogui-work-docx-advanced-generation'
import { AdvancedGenerationRendererErrorV1, analyzeAdvancedTemplateV1, renderAdvancedTemplateV1 } from './work-docx-advanced-renderer'

const p = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const cell = (text: string): string => `<w:tc><w:tcPr/>${p(text)}</w:tc>`
const row = (...values: string[]): string => `<w:tr>${values.map(cell).join('')}</w:tr>`
const control = (kind: 'repeat' | 'conditional', name: string, content: string): string => `<w:sdt><w:sdtPr><w:alias w:val="小规结构"/><w:tag w:val="xiaogui.${kind}:${name}"/></w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`

async function makeTemplate(extra = ''): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('项目：{{项目名称}}')}${control('repeat', '事项', p('旧事项{{局部字段}}') + p('旧说明'))}<w:tbl><w:tblPr/>${row('姓名', '职责')}${control('repeat', '人员', row('旧姓名', '旧职责'))}</w:tbl>${control('conditional', '显示备注', p('备注：{{备注内容}}'))}${extra}<w:sectPr/></w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

function data(): AdvancedTemplateDataV1 {
  return {
    dataVersion: 1,
    variables: [
      { name: '项目名称', status: 'RESOLVED', value: '下盐路迁改' },
      { name: '备注内容', status: 'RESOLVED', value: '需要复核' },
    ],
    repeatBlocks: [
      { name: '事项', status: 'RESOLVED', records: [
        { slots: [{ slotId: 's1', value: '第一项' }, { slotId: 's2', value: '说明一' }] },
        { slots: [{ slotId: 's1', value: '第二项' }, { slotId: 's2', value: '说明二' }] },
      ] },
      { name: '人员', status: 'RESOLVED', records: [
        { slots: [{ slotId: 's1', value: '张三' }, { slotId: 's2', value: '设计' }] },
        { slots: [{ slotId: 's1', value: '李四' }, { slotId: 's2', value: '复核' }] },
      ] },
    ],
    conditionalBlocks: [{ name: '显示备注', status: 'RESOLVED', value: true }],
  }
}

async function documentText(content: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(content)
  const xml = await zip.file('word/document.xml')!.async('string')
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => match[1]).join('|')
}

describe('work docx advanced renderer v1', () => {
  it('discovers slots and deterministically renders variables, repeats and conditions', async () => {
    const template = await makeTemplate()
    const originalHash = createHash('sha256').update(template).digest('hex')
    const schema = await analyzeAdvancedTemplateV1(template, '小规模板.docx')
    expect(schema.variables).toEqual(['备注内容', '项目名称'])
    expect(schema.repeatBlocks.map((block) => [block.name, block.slots.length]).sort()).toEqual([['事项', 2], ['人员', 2]].sort())
    expect(schema.conditionalBlocks.map((block) => block.name)).toEqual(['显示备注'])

    const first = await renderAdvancedTemplateV1({ template, displayName: '小规模板.docx', data: data() })
    const second = await renderAdvancedTemplateV1({ template, displayName: '小规模板.docx', data: data() })
    expect(first.plan.previewSha256).toBe(second.plan.previewSha256)
    expect(first.plan.repeatRecordCount).toBe(4)
    expect(first.plan.retainedConditionalCount).toBe(1)
    const text = await documentText(first.content)
    expect(text).toContain('下盐路迁改')
    expect(text).toContain('第一项')
    expect(text).toContain('第二项')
    expect(text).toContain('张三')
    expect(text).toContain('李四')
    expect(text).toContain('需要复核')
    expect(text).not.toContain('旧事项')
    expect(text).not.toContain('{{')
    expect(createHash('sha256').update(template).digest('hex')).toBe(originalHash)
  })

  it('removes a false condition and refuses unresolved input', async () => {
    const template = await makeTemplate()
    const input = data()
    input.conditionalBlocks = [{ name: '显示备注', status: 'RESOLVED', value: false }]
    const rendered = await renderAdvancedTemplateV1({ template, displayName: '小规模板.docx', data: input })
    expect(await documentText(rendered.content)).not.toContain('需要复核')
    input.variables = [{ name: '项目名称', status: 'UNRESOLVED' }, { name: '备注内容', status: 'RESOLVED', value: '备注' }]
    await expect(renderAdvancedTemplateV1({ template, displayName: '小规模板.docx', data: input })).rejects.toMatchObject({ code: 'ADVANCED_GENERATION_INPUT_REQUIRED' } satisfies Partial<AdvancedGenerationRendererErrorV1>)
  })

  it('rejects unsupported drawing content inside a repeat block', async () => {
    const template = await makeTemplate(control('repeat', '图件', `${p('图件')}<w:drawing/>`))
    await expect(analyzeAdvancedTemplateV1(template, '小规模板.docx')).rejects.toMatchObject({ code: 'ADVANCED_GENERATION_TEMPLATE_UNSUPPORTED' } satisfies Partial<AdvancedGenerationRendererErrorV1>)
  })
})
