import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createTemplateIntakeReportSummaryV1,
  type TemplateIntakeDecisionV1,
  type TemplateIntakeReportV1,
} from '@shared/xiaogui-work-docx-template-intake'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'

import type { ConfirmedTemplateIntakeMaterializationSourceV1 } from './work-docx-template-intake-service'
import { WorkDocxTemplateMaterializeServiceV1 } from './work-docx-template-materialize-service'
import { WorkDocxTemplateMaterializeStoreV1 } from './work-docx-template-materialize-store'

const ADDRESS = {
  projectId: `xgp1_${'7'.repeat(64)}`,
  sessionKey: `xgs1_${'8'.repeat(64)}`,
} as SessionAddressV1
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(
    join(process.env.XIAOGUI_TEST_TEMP_ROOT || tmpdir(), 'xiaogui-template-materialize-test-'),
  )
  roots.push(root)
  return root
}

async function makeConfirmedSource(sourcePath: string): Promise<ConfirmedTemplateIntakeMaterializationSourceV1> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>不得覆盖的旧项目名称</w:t></w:r></w:p><w:p><w:r><w:t>保留说明</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
  )
  const source = await zip.generateAsync({ type: 'nodebuffer' })
  await writeFile(sourcePath, source, { flag: 'wx' })
  const sourceSha256 = createHash('sha256').update(source).digest('hex')
  const report: TemplateIntakeReportV1 = {
    reportVersion: 1,
    reportId: 'xgtir1_service',
    status: 'CONFIRMED',
    file: { displayName: '施工方案.docx', sha256: sourceSha256, byteLength: source.byteLength },
    profile: {
      pageCount: { value: null, basis: 'UNKNOWN' },
      sectionCount: 1,
      headerPartCount: 0,
      footerPartCount: 0,
      tableCount: 0,
      mediaCount: 0,
      inlineDrawingCount: 0,
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
      {
        candidateId: 'project-name',
        kind: 'VARIABLE',
        preview: '旧项目名称',
        sourceAnchors: [{ part: 'BODY', sectionIndex: 1, paragraphIndex: 1 }],
        reason: '人工确认变量',
        confidence: 1,
        riskFlags: [],
        defaultDecision: 'VARIABLE',
        suggestedName: '项目名称',
      },
      {
        candidateId: 'fixed',
        kind: 'FIXED',
        preview: '保留说明',
        sourceAnchors: [{ part: 'BODY', sectionIndex: 1, paragraphIndex: 2 }],
        reason: '人工确认固定内容',
        confidence: 1,
        riskFlags: [],
        defaultDecision: 'FIXED',
      },
    ],
    requiresHumanConfirmation: true,
    canMaterializeTemplate: false,
    createdAt: '2026-08-24T08:00:00.000Z',
    updatedAt: '2026-08-24T08:00:00.000Z',
  }
  const decision: TemplateIntakeDecisionV1 = {
    decisionVersion: 1,
    reportId: report.reportId,
    reportSummary: createTemplateIntakeReportSummaryV1(report),
    decisions: [
      { candidateId: 'project-name', decision: 'VARIABLE', fieldName: '项目名称' },
      { candidateId: 'fixed', decision: 'FIXED' },
    ],
    confirmedAtLocal: '2026-08-24T16:00:00.000+08:00',
    confirmedBy: 'LOCAL_USER',
  }
  return {
    sourcePath,
    sourceSha256,
    sourceDisplayName: '施工方案.docx',
    sourceBytes: source.byteLength,
    report,
    decision,
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

describe('WORK 模板物化服务', () => {
  it('预览后必须跨轮确认，重启可恢复，并且只另存新文件', async () => {
    const root = await fixtureRoot()
    const sourcePath = join(root, '原文.docx')
    const targetPath = join(root, '正式模板.docx')
    const databasePath = join(root, 'private', 'template-materialize.sqlite')
    const confirmed = await makeConfirmedSource(sourcePath)
    const originalHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
    const openPath = vi.fn(async (path: string) => {
      await access(path)
      return ''
    })
    const intake = { loadConfirmedForMaterialization: vi.fn(() => confirmed) }
    const serviceOptions = () => ({
      lookup: lookup(),
      intake,
      store: new WorkDocxTemplateMaterializeStoreV1(databasePath),
      dialogs: { chooseNewTarget: vi.fn(async () => targetPath) },
      outputAccess: { openPath, revealPath: vi.fn(async () => undefined) },
      tempRoot: join(root, 'preview'),
      now: () => new Date('2026-08-24T08:00:00.000Z'),
    })

    const firstService = new WorkDocxTemplateMaterializeServiceV1(serviceOptions())
    const prepared = await firstService.execute(ADDRESS, {
      action: 'PREPARE',
      sourceSessionId: 'session',
      sourceRunId: 'run-1',
      toolCallId: 'tool-1',
    })
    expect(prepared.ok && prepared.value.kind).toBe('XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PREPARED')
    expect(JSON.stringify(prepared)).not.toContain(root)

    const sameRun = await firstService.execute(ADDRESS, {
      action: 'CONFIRM',
      sourceSessionId: 'session',
      sourceRunId: 'run-1',
      toolCallId: 'tool-2',
    })
    expect(sameRun).toEqual({
      ok: false,
      error: { code: 'TEMPLATE_MATERIALIZE_CONFIRMATION_REQUIRED' },
    })
    firstService.close()

    const secondService = new WorkDocxTemplateMaterializeServiceV1(serviceOptions())
    const resumed = await secondService.execute(ADDRESS, {
      action: 'RESUME',
      sourceSessionId: 'session',
      sourceRunId: 'run-2',
      toolCallId: 'tool-3',
    })
    expect(resumed.ok && resumed.value.kind).toBe('XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_RESUMED')
    expect(openPath).toHaveBeenCalledTimes(2)

    const published = await secondService.execute(ADDRESS, {
      action: 'CONFIRM',
      sourceSessionId: 'session',
      sourceRunId: 'run-2',
      toolCallId: 'tool-4',
    })
    expect(published.ok && published.value.kind).toBe('XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PUBLISHED')
    expect(JSON.stringify(published)).not.toContain(root)
    expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex')).toBe(originalHash)
    const output = await readFile(targetPath)
    const outputZip = await JSZip.loadAsync(output)
    expect(await outputZip.file('word/document.xml')!.async('string')).toContain('{{项目名称}}')
    expect(targetPath).not.toBe(sourcePath)

    const resumedPublished = await secondService.execute(ADDRESS, {
      action: 'RESUME',
      sourceSessionId: 'session',
      sourceRunId: 'run-3',
      toolCallId: 'tool-5',
    })
    expect(resumedPublished.ok && resumedPublished.value.kind).toBe(
      'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_RESUMED',
    )
    secondService.close()
  })
})
