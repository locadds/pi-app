import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { parseTemplateIntakeSourceV1 } from './work-docx-template-intake-parser'

async function docxWithInlineAndFloatingImage(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file(
    'word/document.xml',
    [
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>',
      '<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><a:blip r:embed="rIdInline"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
      '<w:p><w:r><w:drawing><wp:anchor><a:graphic><a:graphicData><a:blip r:embed="rIdFloating"/></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>',
      '</w:body></w:document>',
    ].join(''),
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('parseTemplateIntakeSourceV1 drawing risks', () => {
  it('adds FLOATING_OBJECT only to the actual floating drawing candidate', async () => {
    const parsed = await parseTemplateIntakeSourceV1(
      await docxWithInlineAndFloatingImage(),
      new AbortController().signal,
      async () => ({ mainText: '', headerText: '', footerText: '', tableCount: 0, warningCount: 0 }),
    )
    const drawings = parsed.deterministicCandidates.filter(
      (candidate) => candidate.sourceAnchors[0]?.part === 'DRAWING',
    )

    expect(drawings).toHaveLength(2)
    expect(drawings[0].riskFlags).not.toContain('FLOATING_OBJECT')
    expect(drawings[1].riskFlags).toContain('FLOATING_OBJECT')
  })
})
