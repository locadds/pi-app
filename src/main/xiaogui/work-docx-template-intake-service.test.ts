import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TemplateIntakeFinalDecisionItemV1 } from '@shared/xiaogui-work-docx-template-intake'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { DocxSafetyErrorV1 } from './docx-safety'
import { buildTemplateFieldGraphV2 } from './template-intelligence/template-field-graph-builder-v2'
import { parseTemplateIntakeSourceV1 } from './work-docx-template-intake-parser'
import { WorkDocxTemplateIntakeServiceV1 } from './work-docx-template-intake-service'
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

function lookup(): SessionScopeLookupV1 {
  return {
    lookup: vi.fn(async (address: SessionAddressV1) => ({
      kind: 'FOUND' as const,
      scope: { ...address, sessionMode: 'WORK' as const },
    })),
  }
}

describe('WORK 普通成品 Word 整理最小闭环', () => {
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
    const completed = await service.execute(ADDRESS, {
      action: 'START',
      ...COMMON,
      reportId: started.value.reportId,
      analysis: {
        status: 'COMPLETE',
        modelVersion: 'test/model',
        suggestions: fragments.map((fragment) => ({
          fragmentIds: [fragment.fragmentId],
          kind: 'FIXED' as const,
          reason: '测试建议',
          confidence: 0.8,
        })),
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

  it('把超过 20 个位置的有效模型分组拆成可追溯建议而不是全部降级人工判断', async () => {
    const root = await fixtureRoot()
    const sourcePath = join(root, '长分组.docx')
    const paragraphs = Array.from({ length: 21 }, (_, index) => `通用固定说明第 ${index + 1} 段`)
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
    expect(fragments).toHaveLength(21)

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

    expect(completed.value.report.candidates).toHaveLength(21)
    expect(completed.value.report.candidates.every((candidate) => candidate.kind === 'FIXED')).toBe(true)
    expect(
      completed.value.report.candidates.every((candidate) => candidate.sourceAnchors.length === 1),
    ).toBe(true)
    expect(JSON.stringify(completed.value.report)).not.toContain('模型未给出可验证建议')
  })
})
