import { createHash } from 'node:crypto'

import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import {
  createTemplateIntakeReportSummaryV1,
  type TemplateIntakeCandidateV1,
  type TemplateIntakeDecisionV1,
  type TemplateIntakeReportV1,
} from '@shared/xiaogui-work-docx-template-intake'

import {
  materializeConfirmedTemplateV1,
  TemplateMaterializerErrorV1,
} from './work-docx-template-materializer'

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>旧项目</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>名称</w:t></w:r></w:p>
    <w:p><w:r><w:t>应排除的联系方式</w:t></w:r></w:p>
    <w:p><w:r><w:t>重复内容第一行</w:t></w:r></w:p>
    <w:p><w:r><w:t>重复内容第二行</w:t></w:r></w:p>
    <w:p><w:r><w:t>条件内容</w:t></w:r></w:p>
    <w:p><w:r><w:t>固定内容</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><w:txbxContent><w:p><w:r><w:t>人工确认保留的文本框</w:t></w:r><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><a:blip r:embed="rIdImage1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:txbxContent></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`

async function makeSource(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file('word/document.xml', DOCUMENT_XML)
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
  )
  zip.file('word/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function makeTwoImageSource(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>
    <w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><a:blip r:embed="rIdImage1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><a:blip r:embed="x00000001"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`,
  )
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="x00000001" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/></Relationships>',
  )
  zip.file('word/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]))
  zip.file('word/media/image2.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]))
  return zip.generateAsync({ type: 'nodebuffer' })
}

function candidate(
  candidateId: string,
  kind: TemplateIntakeCandidateV1['kind'],
  sourceAnchors: TemplateIntakeCandidateV1['sourceAnchors'],
  suggestedName?: string,
): TemplateIntakeCandidateV1 {
  return {
    candidateId,
    kind,
    preview: candidateId,
    sourceAnchors,
    reason: '测试确认项',
    confidence: 1,
    riskFlags: kind === 'EXCLUDE' ? ['CONTACT_INFORMATION'] : [],
    defaultDecision: kind,
    ...(suggestedName ? { suggestedName } : {}),
  }
}

function reportFor(source: Buffer): TemplateIntakeReportV1 {
  return {
    reportVersion: 1,
    reportId: 'xgtir1_test',
    status: 'CONFIRMED',
    file: {
      displayName: '普通成品.docx',
      sha256: createHash('sha256').update(source).digest('hex'),
      byteLength: source.byteLength,
    },
    profile: {
      pageCount: { value: null, basis: 'UNKNOWN' },
      sectionCount: 1,
      headerPartCount: 0,
      footerPartCount: 0,
      tableCount: 0,
      mediaCount: 1,
      inlineDrawingCount: 1,
      floatingDrawingCount: 0,
      textBoxCount: 0,
      fieldCount: 0,
      contentControlCount: 0,
      scannedPageCount: null,
    },
    versions: {
      safetyGate: 'test',
      structureParser: 'test',
      semanticParser: 'test',
      rules: 'test',
      model: null,
    },
    warnings: [],
    candidates: [
      candidate('variable', 'VARIABLE', [{ part: 'BODY', sectionIndex: 1, paragraphIndex: 1 }], '项目名称'),
      candidate('exclude', 'EXCLUDE', [{ part: 'BODY', sectionIndex: 1, paragraphIndex: 2 }]),
      candidate(
        'repeat',
        'REPEAT',
        [
          { part: 'BODY', sectionIndex: 1, paragraphIndex: 3 },
          { part: 'BODY', sectionIndex: 1, paragraphIndex: 4 },
        ],
        '工作明细',
      ),
      candidate('conditional', 'CONDITIONAL', [{ part: 'BODY', sectionIndex: 1, paragraphIndex: 5 }], '可选说明'),
      candidate('fixed', 'FIXED', [{ part: 'BODY', sectionIndex: 1, paragraphIndex: 6 }]),
      {
        ...candidate('text-box', 'FIXED', [{ part: 'TEXT_BOX', drawingIndex: 1 }]),
        riskFlags: ['TEXT_BOX', 'FLOATING_OBJECT'],
        defaultDecision: 'EXCLUDE',
      },
      candidate('drawing', 'EXCLUDE', [{ part: 'DRAWING', drawingIndex: 1 }]),
    ],
    requiresHumanConfirmation: true,
    canMaterializeTemplate: false,
    createdAt: '2026-08-24T08:00:00.000Z',
    updatedAt: '2026-08-24T08:00:00.000Z',
  }
}

function decisionFor(report: TemplateIntakeReportV1): TemplateIntakeDecisionV1 {
  return {
    decisionVersion: 1,
    reportId: report.reportId,
    reportSummary: createTemplateIntakeReportSummaryV1(report),
    decisions: report.candidates.map((item) => ({
      candidateId: item.candidateId,
      decision: item.kind === 'UNRESOLVED' ? 'FIXED' : item.kind,
      ...(item.suggestedName ? { fieldName: item.suggestedName } : {}),
      ...(item.riskFlags.length > 0 && item.kind !== 'EXCLUDE'
        ? {
            highRiskOverrideReason: '测试人工确认保留',
            highRiskOverrideConfirmed: true as const,
          }
        : {}),
    })),
    confirmedAtLocal: '2026-08-24T16:00:00.000+08:00',
    confirmedBy: 'LOCAL_USER',
  }
}

describe('WORK 已确认整理报告物化', () => {
  it('整项替换、结构标记和高风险媒体移除可同时完成且结果可重复生成', async () => {
    const source = await makeSource()
    const sourceHash = createHash('sha256').update(source).digest('hex')
    const report = reportFor(source)
    const decision = decisionFor(report)

    const first = await materializeConfirmedTemplateV1({ source, report, decision })
    const second = await materializeConfirmedTemplateV1({ source, report, decision })

    expect(first.plan.previewSha256).toBe(second.plan.previewSha256)
    expect(first.content.equals(second.content)).toBe(true)
    expect(createHash('sha256').update(source).digest('hex')).toBe(sourceHash)
    expect(first.plan).toMatchObject({
      excludedCandidateCount: 2,
      removedMediaCount: 1,
      retainedHighRiskCount: 1,
      requiresSecondConfirmation: true,
      originalSourceUnchanged: true,
      advancedGenerationRequired: true,
    })

    const output = await JSZip.loadAsync(first.content)
    const xml = await output.file('word/document.xml')!.async('string')
    const relationships = await output.file('word/_rels/document.xml.rels')!.async('string')
    expect(xml).toContain('{{项目名称}}')
    expect(xml).not.toContain('应排除的联系方式')
    expect(xml).toContain('w:tag w:val="xiaogui.repeat:工作明细"')
    expect(xml).toContain('重复内容第一行')
    expect(xml).toContain('重复内容第二行')
    expect(xml).toContain('w:tag w:val="xiaogui.conditional:可选说明"')
    expect(xml).toContain('固定内容')
    expect(xml).toContain('人工确认保留的文本框')
    expect(xml.match(/<w:drawing\b/g)).toHaveLength(1)
    expect(relationships).not.toContain('rIdImage1')
    expect(output.file('word/media/image1.png')).toBeNull()
  })

  it('拒绝重名动态字段、摘要漂移和对复杂图件的动态猜测', async () => {
    const source = await makeSource()
    const report = reportFor(source)

    const duplicateName = decisionFor(report)
    duplicateName.decisions = duplicateName.decisions.map((item) =>
      item.candidateId === 'conditional' ? { ...item, fieldName: '项目名称' } : item,
    )
    await expect(materializeConfirmedTemplateV1({ source, report, decision: duplicateName })).rejects.toMatchObject({
      code: 'TEMPLATE_MATERIALIZE_DYNAMIC_NAME_INVALID',
    } satisfies Partial<TemplateMaterializerErrorV1>)

    const drifted = decisionFor(report)
    drifted.reportSummary = { ...drifted.reportSummary, candidateCount: 999 }
    await expect(materializeConfirmedTemplateV1({ source, report, decision: drifted })).rejects.toMatchObject({
      code: 'TEMPLATE_MATERIALIZE_DECISION_CHANGED',
    } satisfies Partial<TemplateMaterializerErrorV1>)

    const guessedDrawing = decisionFor(report)
    guessedDrawing.decisions = guessedDrawing.decisions.map((item) =>
      item.candidateId === 'drawing'
        ? {
            ...item,
            decision: 'VARIABLE',
            fieldName: '旧图件',
            highRiskOverrideReason: '测试显式覆盖',
            highRiskOverrideConfirmed: true,
          }
        : item,
    )
    await expect(materializeConfirmedTemplateV1({ source, report, decision: guessedDrawing })).rejects.toMatchObject({
      code: 'TEMPLATE_MATERIALIZE_UNSUPPORTED_CONTENT',
    } satisfies Partial<TemplateMaterializerErrorV1>)
  })

  it('按 V2 人工框选范围跨多个文字运行局部替换，范围外文字和格式保持不变', async () => {
    const source = await makeSource()
    const baseReport = reportFor(source)
    const report: TemplateIntakeReportV1 = {
      ...baseReport,
      candidates: baseReport.candidates.map((item) =>
        item.candidateId === 'variable' ? { ...item, preview: '旧项目名称' } : item,
      ),
    }
    const decision = decisionFor(report)
    decision.reviewActionsV2 = [
      {
        targetId: 'variable',
        kind: 'REPLACE_TEXT',
        range: { startUtf16: 0, endUtf16Exclusive: 3 },
        replacementText: '新工程',
      },
      {
        targetId: 'variable',
        kind: 'FIELD',
        range: { startUtf16: 3, endUtf16Exclusive: 5 },
        fieldName: '项目名称',
      },
    ]

    const result = await materializeConfirmedTemplateV1({ source, report, decision })
    const output = await JSZip.loadAsync(result.content)
    const xml = await output.file('word/document.xml')!.async('string')

    expect(xml).toContain('<w:t>新工程</w:t>')
    expect(xml).toContain('<w:rPr><w:b/></w:rPr><w:t>{{项目名称}}</w:t>')
    expect(xml).not.toContain('旧项目名称')
    expect(result.plan.variables.map((item) => item.name)).toContain('项目名称')
    expect(result.plan.warnings).toContain('已按人工框选范围完成局部修改，框选范围外内容保持不变')
  })

  it('只替换指定图片并保留同一文档中的其他图片及其关系', async () => {
    const source = await makeTwoImageSource()
    const baseReport = reportFor(source)
    const report: TemplateIntakeReportV1 = {
      ...baseReport,
      profile: {
        ...baseReport.profile,
        mediaCount: 2,
        inlineDrawingCount: 2,
      },
      candidates: [
        candidate('drawing-one', 'FIXED', [{ part: 'DRAWING', drawingIndex: 1 }]),
        candidate('drawing-two', 'FIXED', [{ part: 'DRAWING', drawingIndex: 2 }]),
      ],
    }
    const decision = decisionFor(report)
    decision.reviewActionsV2 = [
      {
        targetId: 'drawing-one',
        kind: 'REPLACE_IMAGE',
        replacementImageToken: 'replacement-one',
      },
      { targetId: 'drawing-two', kind: 'KEEP' },
    ]
    const replacement = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x99])

    const result = await materializeConfirmedTemplateV1({
      source,
      report,
      decision,
      replacementImages: new Map([
        ['replacement-one', { content: replacement, extension: 'png', contentType: 'image/png' }],
      ]),
    })
    const output = await JSZip.loadAsync(result.content)
    const xml = await output.file('word/document.xml')!.async('string')
    const relationships = await output.file('word/_rels/document.xml.rels')!.async('string')
    const relationshipIds = [...relationships.matchAll(/\bId="([^"]+)"/g)].map((match) => match[1])
    const embedIds = [...xml.matchAll(/\br:embed="([^"]+)"/g)].map((match) => match[1])
    const kept = await output.file('word/media/image2.png')!.async('nodebuffer')
    const replaced = await output.file('word/media/xiaogui-replacement-1.png')!.async('nodebuffer')

    expect(xml).not.toContain('r:embed="rIdImage1"')
    expect(xml).toContain('r:embed="x00000001"')
    expect(new Set(relationshipIds).size).toBe(relationshipIds.length)
    expect(embedIds[0]).not.toBe(embedIds[1])
    expect(relationships).not.toContain('Target="media/image1.png"')
    expect(relationships).toContain('Target="media/image2.png"')
    expect(relationships).toContain('Target="media/xiaogui-replacement-1.png"')
    expect(output.file('word/media/image1.png')).toBeNull()
    expect(kept.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]))).toBe(true)
    expect(replaced.equals(replacement)).toBe(true)
    expect(result.plan.removedMediaCount).toBe(1)
  })
})
