import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import JSZip from 'jszip'
import * as CFB from 'cfb'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TemplateIntakeFinalDecisionItemV1 } from '@shared/xiaogui-work-docx-template-intake'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { DocxSafetyErrorV1 } from './docx-safety'
import { buildTemplateFieldGraphV2 } from './template-intelligence/template-field-graph-builder-v2'
import { parseTemplateIntakeSourceV1 } from './work-docx-template-intake-parser'
import {
  WorkDocxTemplateIntakeServiceV1,
  type WorkDocxTemplateIntakeServiceOptionsV1,
} from './work-docx-template-intake-service'
import { WorkDocxTemplateIntakeStoreV1 } from './work-docx-template-intake-store'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1
const COMMON = { sourceSessionId: 'session', sourceRunId: 'run', toolCallId: 'tool' }
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const preferred = process.env.XIAOGUI_TEST_TEMP_ROOT || tmpdir()
  const root = await mkdtemp(join(preferred, 'xiaogui-template-intake-test-'))
  roots.push(root)
  return root
}

async function makeDocx(longText = '项目概况'): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body><w:p><w:r><w:t>${longText}</w:t></w:r></w:p><w:p><w:r><w:t>联系人：张三 电话：13800000000</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格字段</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`,
  )
  zip.file(
    'word/header1.xml',
    '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>项目页眉</w:t></w:r></w:p></w:hdr>',
  )
  zip.file('docProps/app.xml', '<?xml version="1.0"?><Properties><Pages>3</Pages></Properties>')
  zip.file('word/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function makeParagraphDocx(paragraphs: readonly string[]): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join('')
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

function makeLegacyDoc(): Buffer {
  const container = CFB.utils.cfb_new()
  const fib = Buffer.alloc(32)
  fib.writeUInt16LE(0xa5ec, 0)
  fib.writeUInt16LE(0x00c1, 2)
  CFB.utils.cfb_add(container, 'WordDocument', fib)
  CFB.utils.cfb_add(container, '1Table', Buffer.alloc(16))
  return Buffer.from(CFB.write(container, { type: 'buffer', fileType: 'cfb' }))
}

function failedLegacyDocRenderer(
  warningCode: 'LEGACY_DOC_CONVERSION_UNAVAILABLE' | 'LEGACY_DOC_CONVERSION_FAILED',
): NonNullable<WorkDocxTemplateIntakeServiceOptionsV1['reviewRenderer']> {
  return {
    prepare: vi.fn(async () => ({
      manifestId: `manifest-${warningCode}`,
      sourceSha256: 'a'.repeat(64),
      normalizedDocxAvailable: false,
      render: {
        mode: 'STRUCTURED_FALLBACK' as const,
        paginationBasis: 'UNKNOWN' as const,
        approximatePageCount: null,
        warnings: [{ code: warningCode, message: 'test warning' }],
      },
      projections: [],
    })),
    readNormalizedDocx: vi.fn(() => null),
    release: vi.fn(() => true),
  }
}

function lookup(): SessionScopeLookupV1 {
  return {
    lookup: vi.fn(async (address: SessionAddressV1) => ({
      kind: 'FOUND' as const,
      scope: { ...address, sessionMode: 'WORK' as const },
    })),
  }
}

describe('WORK 普通成品 Word 整理最小闭环', () => {
  it.each([
    ['未装配 renderer', undefined, 'TEMPLATE_INTAKE_CONVERSION_UNAVAILABLE'],
    ['转换组件不可用', 'LEGACY_DOC_CONVERSION_UNAVAILABLE', 'TEMPLATE_INTAKE_CONVERSION_UNAVAILABLE'],
    ['转换执行失败', 'LEGACY_DOC_CONVERSION_FAILED', 'TEMPLATE_INTAKE_CONVERSION_FAILED'],
  ] as const)('区分旧版 DOC 的%s与真实转换失败', async (_label, warningCode, expectedCode) => {
    const root = await fixtureRoot()
    const sourcePath = join(root, '旧版成品.doc')
    await writeFile(sourcePath, makeLegacyDoc())
    const store = new WorkDocxTemplateIntakeStoreV1(join(root, 'private', 'legacy-doc.sqlite'))
    const reviewRenderer = warningCode ? failedLegacyDocRenderer(warningCode) : undefined
    const service = new WorkDocxTemplateIntakeServiceV1({
      lookup: lookup(),
      dialogs: { chooseSource: vi.fn(async () => sourcePath) },
      handoffs: { consumeTemplateIntakeHandoff: vi.fn(() => null) },
      store,
      ...(reviewRenderer ? { reviewRenderer } : {}),
    })

    try {
      await expect(service.execute(ADDRESS, { action: 'START', ...COMMON })).resolves.toEqual({
        ok: false,
        error: { code: expectedCode },
      })
      if (reviewRenderer) expect(reviewRenderer.release).toHaveBeenCalledOnce()
    } finally {
      service.close()
    }
  })

  it('把模型引用的段内原文拆成多个局部候选，而不是把整段设为变量', async () => {
    const root = await fixtureRoot()
    const sourcePath = join(root, '局部字段.docx')
    const paragraph = '项目名称：下盐公路工程，计划于2026年9月开工。'
    await writeFile(sourcePath, await makeParagraphDocx([paragraph]))
    const store = new WorkDocxTemplateIntakeStoreV1(join(root, 'private', 'partial.sqlite'))
    const service = new WorkDocxTemplateIntakeServiceV1({
      lookup: lookup(),
      dialogs: { chooseSource: vi.fn(async () => sourcePath) },
      handoffs: { consumeTemplateIntakeHandoff: vi.fn(() => null) },
      store,
      semanticParser: vi.fn(async () => ({
        mainText: paragraph,
        headerText: '',
        footerText: '',
        tableCount: 0,
        warningCount: 0,
      })),
    })

    const started = await service.execute(ADDRESS, { action: 'START', ...COMMON })
    if (!started.ok || started.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED') {
      throw new Error('expected analysis request')
    }
    const fragment = started.value.analysisBatches.flatMap((batch) => batch.fragments)[0]
    const projectName = '下盐公路工程'
    const startDate = '2026年9月'
    const projectStart = paragraph.indexOf(projectName)
    const dateStart = paragraph.indexOf(startDate)
    const completed = await service.execute(ADDRESS, {
      action: 'START',
      ...COMMON,
      reportId: started.value.reportId,
      analysis: {
        status: 'COMPLETE',
        modelVersion: 'test/model',
        suggestions: [
          {
            fragmentIds: [fragment.fragmentId],
            scope: 'SELECTION',
            selection: {
              originalText: projectName,
              startUtf16: projectStart,
              endUtf16Exclusive: projectStart + projectName.length,
            },
            kind: 'VARIABLE',
            reason: '项目名称随项目变化',
            confidence: 0.97,
            suggestedName: '项目名称',
          },
          {
            fragmentIds: [fragment.fragmentId],
            scope: 'SELECTION',
            selection: {
              originalText: startDate,
              startUtf16: dateStart,
              endUtf16Exclusive: dateStart + startDate.length,
            },
            kind: 'VARIABLE',
            reason: '开工日期随项目变化',
            confidence: 0.96,
            suggestedName: '计划开工日期',
          },
        ],
      },
    })
    if (!completed.ok || completed.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY') {
      throw new Error('expected report')
    }

    const variables = completed.value.report.candidates.filter((candidate) => candidate.kind === 'VARIABLE')
    expect(variables.map((candidate) => candidate.preview)).toEqual([projectName, startDate])
    expect(variables.map((candidate) => candidate.textRange)).toEqual([
      { startUtf16: projectStart, endUtf16Exclusive: projectStart + projectName.length },
      { startUtf16: dateStart, endUtf16Exclusive: dateStart + startDate.length },
    ])
    expect(variables.every((candidate) => candidate.preview !== paragraph)).toBe(true)

    const graph = buildTemplateFieldGraphV2(completed.value.report).fieldGraph
    service.close()
    expect(new Map(graph.occurrences.map((occurrence) => [occurrence.originalText, occurrence.textRange]))).toEqual(new Map([
      [projectName, { startUtf16: projectStart, endUtf16Exclusive: projectStart + projectName.length }],
      [startDate, { startUtf16: dateStart, endUtf16Exclusive: dateStart + startDate.length }],
    ]))
  })

  it('优先消费主进程暂存文档且不再次打开选择框', async () => {
    const root = await fixtureRoot()
    const sourcePath = join(root, '直接选择.docx')
    await writeFile(sourcePath, await makeDocx())
    const chooseSource = vi.fn(async () => null)
    const store = new WorkDocxTemplateIntakeStoreV1(join(root, 'private', 'direct.sqlite'))
    const service = new WorkDocxTemplateIntakeServiceV1({
      lookup: lookup(),
      dialogs: { chooseSource },
      handoffs: { consumeTemplateIntakeHandoff: vi.fn(() => ({ sourcePath })) },
      store,
      semanticParser: vi.fn(async () => ({
        mainText: '项目概况 联系人：张三 电话：13800000000 表格字段',
        headerText: '项目页眉',
        footerText: '',
        tableCount: 1,
        warningCount: 0,
      })),
    })

    const started = await service.execute(ADDRESS, { action: 'START', ...COMMON })

    expect(started.ok && started.value.kind).toBe(
      'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED',
    )
    expect(chooseSource).not.toHaveBeenCalled()
    service.close()
  })

  it('安全门先于语义解析，表格计数不一致时降级为无法对齐', async () => {
    const semantic = vi.fn(async () => ({
      mainText: '项目概况 联系人：张三 电话：13800000000 表格字段',
      headerText: '项目页眉',
      footerText: '',
      tableCount: 0,
      warningCount: 0,
    }))
    await expect(
      parseTemplateIntakeSourceV1(Buffer.from('not-a-docx'), new AbortController().signal, semantic),
    ).rejects.toBeInstanceOf(DocxSafetyErrorV1)
    expect(semantic).not.toHaveBeenCalled()

    const parsed = await parseTemplateIntakeSourceV1(
      await makeDocx(),
      new AbortController().signal,
      semantic,
    )
    expect(parsed.fragments.find((fragment) => fragment.kind === 'TABLE_CELL')?.semanticAligned).toBe(false)
    expect(parsed.warnings).toContainEqual(
      expect.objectContaining({ code: 'SEMANTIC_COUNT_MISMATCH' }),
    )
    expect(parsed.profile).toMatchObject({
      pageCount: { value: 3, basis: 'DOCUMENT_PROPERTY' },
      tableCount: 1,
      mediaCount: 1,
      scannedPageCount: null,
    })

    const structureOnly = await parseTemplateIntakeSourceV1(
      await makeDocx(),
      new AbortController().signal,
      vi.fn(async () => {
        throw new Error('semantic parser unavailable')
      }),
    )
    expect(structureOnly.fragments.length).toBeGreaterThan(0)
    expect(structureOnly.fragments.every((fragment) => !fragment.semanticAligned)).toBe(true)
    expect(structureOnly.warnings).toContainEqual(
      expect.objectContaining({
        code: 'OTHER',
        message: expect.stringContaining('仅保留结构基线'),
      }),
    )
  })

  it('生成无路径报告、保存逐项草稿、执行高风险双门并在源文件变化后失效', async () => {
    const root = await fixtureRoot()
    const sourcePath = join(root, '普通成品.docx')
    const fullText = `不可持久化全文-${'甲'.repeat(700)}`
    const sourceBuffer = await makeDocx(fullText)
    await writeFile(sourcePath, sourceBuffer)
    const originalHash = createHash('sha256').update(sourceBuffer).digest('hex')
    const store = new WorkDocxTemplateIntakeStoreV1(join(root, 'private', 'template-intake.sqlite'))
    const service = new WorkDocxTemplateIntakeServiceV1({
      lookup: lookup(),
      dialogs: { chooseSource: vi.fn(async () => sourcePath) },
      handoffs: { consumeTemplateIntakeHandoff: vi.fn(() => null) },
      store,
      semanticParser: vi.fn(async () => ({
        mainText: `${fullText}\n联系人：张三 电话：13800000000\n表格字段`,
        headerText: '项目页眉',
        footerText: '',
        tableCount: 1,
        warningCount: 0,
      })),
      now: () => new Date('2026-08-24T08:00:00.000Z'),
    })

    const started = await service.execute(ADDRESS, { action: 'START', ...COMMON })
    expect(started.ok && started.value.kind).toBe(
      'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED',
    )
    if (!started.ok || started.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED') {
      throw new Error('expected analysis request')
    }
    expect(JSON.stringify(started.value.analysisBatches)).toContain(fullText)

    const fragments = started.value.analysisBatches.flatMap((batch) => batch.fragments)
    const contactFragment = fragments.find((fragment) => fragment.text.includes('13800000000'))!
    const selectedContact = '张三 电话：13800000000'
    const contactStart = contactFragment.text.indexOf(selectedContact)
    const completed = await service.execute(ADDRESS, {
      action: 'START',
      ...COMMON,
      reportId: started.value.reportId,
      analysis: {
        status: 'COMPLETE',
        modelVersion: 'test/model',
        suggestions: [{
          fragmentIds: [contactFragment.fragmentId],
          scope: 'SELECTION',
          selection: {
            originalText: selectedContact,
            startUtf16: contactStart,
            endUtf16Exclusive: contactStart + selectedContact.length,
          },
          kind: 'EXCLUDE',
          reason: '联系人和电话不应继承到新模板',
          confidence: 0.98,
          riskFlags: ['CONTACT_INFORMATION'],
        }],
      },
    })
    expect(completed.ok && completed.value.kind).toBe(
      'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY',
    )
    if (!completed.ok || completed.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY') {
      throw new Error('expected report')
    }
    const { report } = completed.value
    expect(JSON.stringify(report)).not.toContain(sourcePath)
    expect(report.requiresHumanConfirmation).toBe(true)
    expect(report.canMaterializeTemplate).toBe(false)
    expect(report.candidates.length).toBeLessThanOrEqual(200)
    expect(Math.max(...report.candidates.map((candidate) => Array.from(candidate.preview).length))).toBeLessThanOrEqual(500)
    expect(store.countPersistedTextOccurrences(fullText)).toBe(0)

    const updated = await service.execute(ADDRESS, {
      action: 'UPDATE',
      ...COMMON,
      operations: [
        {
          candidateIds: report.candidates.map((candidate) => candidate.candidateId),
          decision: 'FIXED',
        },
      ],
    })
    expect(updated.ok && updated.value.kind).toBe('XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED')
    if (!updated.ok || updated.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED') {
      throw new Error('expected updated draft')
    }
    expect(updated.value.draftDecisions).toHaveLength(report.candidates.length)

    const riskUpdated = await service.execute(ADDRESS, {
      action: 'UPDATE',
      ...COMMON,
      operations: [
        {
          match: { riskFlags: ['CONTACT_INFORMATION'] },
          decision: 'EXCLUDE',
        },
      ],
    })
    expect(riskUpdated.ok && riskUpdated.value.kind).toBe(
      'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED',
    )
    if (!riskUpdated.ok || riskUpdated.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED') {
      throw new Error('expected risk update')
    }
    const contactCandidates = report.candidates.filter((candidate) =>
      candidate.riskFlags.includes('CONTACT_INFORMATION'),
    )
    expect(contactCandidates.length).toBeGreaterThan(0)
    expect(
      riskUpdated.value.draftDecisions.filter((item) =>
        contactCandidates.some((candidate) => candidate.candidateId === item.candidateId),
      ),
    ).toEqual(
      expect.arrayContaining(
        contactCandidates.map((candidate) =>
          expect.objectContaining({ candidateId: candidate.candidateId, decision: 'EXCLUDE' }),
        ),
      ),
    )

    const partiallyMatched = await service.execute(ADDRESS, {
      action: 'UPDATE',
      ...COMMON,
      operations: [
        { match: { keywords: ['当前报告不存在的候选'] }, decision: 'EXCLUDE' },
        { match: { riskFlags: ['CONTACT_INFORMATION'] }, decision: 'EXCLUDE' },
      ],
    })
    expect(partiallyMatched.ok && partiallyMatched.value.kind).toBe(
      'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED',
    )

    const noMatch = await service.execute(ADDRESS, {
      action: 'UPDATE',
      ...COMMON,
      operations: [
        { match: { keywords: ['当前报告不存在的候选'] }, decision: 'EXCLUDE' },
      ],
    })
    expect(noMatch).toEqual({
      ok: false,
      error: { code: 'TEMPLATE_INTAKE_INPUT_INVALID' },
    })

    const decisions = report.candidates.map<TemplateIntakeFinalDecisionItemV1>((candidate) => ({
      candidateId: candidate.candidateId,
      decision: 'FIXED',
    }))
    const wrongReport = await service.execute(ADDRESS, {
      action: 'REVIEW',
      ...COMMON,
      reportId: 'xgti1_other-report',
    })
    expect(wrongReport).toEqual({
      ok: false,
      error: { code: 'TEMPLATE_INTAKE_REPORT_NOT_FOUND' },
    })
    const missingReason = await service.execute(ADDRESS, {
      action: 'REVIEW',
      ...COMMON,
      submission: { decisions },
    })
    expect(missingReason).toEqual({
      ok: false,
      error: { code: 'TEMPLATE_INTAKE_HIGH_RISK_REASON_REQUIRED' },
    })

    const withReasons = decisions.map((item) => ({
      ...item,
      ...(report.candidates.find((candidate) => candidate.candidateId === item.candidateId)!.riskFlags
        .length > 0
        ? { highRiskOverrideReason: '经人工核对后保留' }
        : {}),
    }))
    const missingSecondConfirmation = await service.execute(ADDRESS, {
      action: 'REVIEW',
      ...COMMON,
      submission: { decisions: withReasons },
    })
    expect(missingSecondConfirmation).toEqual({
      ok: false,
      error: { code: 'TEMPLATE_INTAKE_SECOND_CONFIRMATION_REQUIRED' },
    })

    const confirmedDecisions = withReasons.map((item) => ({
      ...item,
      ...(item.highRiskOverrideReason ? { highRiskOverrideConfirmed: true as const } : {}),
    }))
    const issueChoicesV2 = buildTemplateFieldGraphV2(report).fieldGraph.issues.map((issue) => ({
      issueId: issue.issueId,
      action: issue.suggestedActions[0],
      reason: '已由本机用户逐项确认',
    }))
    const confirmed = await service.execute(ADDRESS, {
      action: 'REVIEW',
      ...COMMON,
      submission: { decisions: confirmedDecisions, issueChoicesV2 },
    })
    expect(confirmed.ok && confirmed.value.kind).toBe(
      'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CONFIRMED',
    )
    expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex')).toBe(originalHash)

    const reopened = await service.execute(ADDRESS, {
      action: 'REOPEN',
      ...COMMON,
      operations: [
        {
          match: { riskFlags: ['CONTACT_INFORMATION'] },
          decision: 'EXCLUDE',
        },
      ],
    })
    expect(reopened.ok && reopened.value.kind).toBe(
      'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED',
    )
    if (!reopened.ok || reopened.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_UPDATED') {
      throw new Error('expected reopened draft')
    }
    expect(reopened.value.report.reportId).not.toBe(report.reportId)
    expect(reopened.value.report.status).toBe('DRAFT')
    expect(
      reopened.value.draftDecisions.every((item) => item.highRiskOverrideConfirmed !== true),
    ).toBe(true)
    expect(store.get(ADDRESS, report.reportId)).toMatchObject({
      report: { status: 'CONFIRMED' },
      decision: {
        reportId: report.reportId,
        fieldGraphV2: {
          issues: issueChoicesV2.map((choice) => ({
            issueId: choice.issueId,
            status: 'RESOLVED',
            resolution: { action: choice.action, reason: choice.reason },
          })),
        },
      },
    })
    const reopenedRecord = store.get(ADDRESS, reopened.value.report.reportId)
    expect(reopenedRecord).toMatchObject({ report: { status: 'DRAFT' } })
    expect(reopenedRecord?.decision).toBeUndefined()

    await writeFile(sourcePath, await makeDocx('源文件已经变化'))
    const resumed = await service.execute(ADDRESS, {
      action: 'RESUME',
      reportId: reopened.value.report.reportId,
      ...COMMON,
    })
    expect(resumed).toEqual({
      ok: false,
      error: { code: 'TEMPLATE_INTAKE_SOURCE_CHANGED' },
    })
    service.close()
  })

  it('把同一模型建议的多个位置拆成可追溯候选，避免拼接后无法定位', async () => {
    const root = await fixtureRoot()
    const sourcePath = join(root, '长分组.docx')
    const paragraphs = Array.from({ length: 2 }, (_, index) => `通用固定说明第 ${index + 1} 段`)
    await writeFile(sourcePath, await makeParagraphDocx(paragraphs))
    const store = new WorkDocxTemplateIntakeStoreV1(join(root, 'private', 'template-intake.sqlite'))
    const service = new WorkDocxTemplateIntakeServiceV1({
      lookup: lookup(),
      dialogs: { chooseSource: vi.fn(async () => sourcePath) },
      handoffs: { consumeTemplateIntakeHandoff: vi.fn(() => null) },
      store,
      semanticParser: vi.fn(async () => ({
        mainText: paragraphs.join('\n'),
        headerText: '',
        footerText: '',
        tableCount: 0,
        warningCount: 0,
      })),
    })

    const started = await service.execute(ADDRESS, { action: 'START', ...COMMON })
    if (!started.ok || started.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_ANALYSIS_REQUIRED') {
      throw new Error('expected analysis request')
    }
    const fragments = started.value.analysisBatches.flatMap((batch) => batch.fragments)
    expect(fragments).toHaveLength(2)

    const completed = await service.execute(ADDRESS, {
      action: 'START',
      ...COMMON,
      reportId: started.value.reportId,
      analysis: {
        status: 'COMPLETE',
        modelVersion: 'test/model',
        suggestions: [
          {
            fragmentIds: fragments.map((fragment) => fragment.fragmentId),
            kind: 'FIXED',
            reason: '这些是跨项目通用的固定说明',
            confidence: 0.9,
          },
        ],
      },
    })
    if (!completed.ok || completed.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REPORT_READY') {
      throw new Error('expected report')
    }
    service.close()

    expect(completed.value.report.candidates).toHaveLength(2)
    expect(completed.value.report.candidates.every((candidate) => candidate.kind === 'FIXED')).toBe(true)
    expect(
      completed.value.report.candidates.every((candidate) => candidate.sourceAnchors.length === 1),
    ).toBe(true)
    expect(JSON.stringify(completed.value.report)).not.toContain('模型未给出可验证建议')
  })
})
