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

import { TemplateLibraryServiceV1 } from './template-library-service'
import { WorkDocxServiceV1 } from './work-docx-service'
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
    fieldGraphV2: {
      graphVersion: 2,
      graphId: 'xggraph2_service',
      source: report.file,
      fields: [{
        fieldId: 'xgfield2_project_name',
        canonicalKey: 'project.name',
        displayName: '项目名称',
        valueType: 'TEXT',
        structureKind: 'SIMPLE',
        required: true,
        sampleValue: '旧项目名称',
        aliases: [],
        occurrenceIds: ['xgocc2_project_name'],
        confidence: 1,
        status: 'CONFIRMED',
      }],
      occurrences: [{
        occurrenceId: 'xgocc2_project_name',
        fieldId: 'xgfield2_project_name',
        sourceAnchor: { part: 'BODY', sectionIndex: 1, paragraphIndex: 1 },
        originalText: '旧项目名称',
        confidence: 1,
        riskFlags: [],
        status: 'MAPPED',
      }],
      issues: [],
      analysisEvidenceId: 'xgevidence2_service',
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    },
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

    const crossRunWithoutToken = await secondService.execute(ADDRESS, {
      action: 'CONFIRM',
      sourceSessionId: 'session',
      sourceRunId: 'run-2',
      toolCallId: 'tool-4',
    })
    expect(crossRunWithoutToken).toEqual({
      ok: false,
      error: { code: 'TEMPLATE_MATERIALIZE_CONFIRMATION_REQUIRED' },
    })
    if (!resumed.ok || resumed.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_RESUMED' || !('previewConfirmationToken' in resumed.value)) {
      throw new Error('expected resumed preview confirmation token')
    }
    const published = await secondService.execute(ADDRESS, {
      action: 'CONFIRM',
      sourceSessionId: 'session',
      sourceRunId: 'run-2',
      toolCallId: 'tool-4-confirmed',
      previewConfirmationToken: resumed.value.previewConfirmationToken,
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

  it('只接受本次内置预览签发的令牌在同一轮生成正式模板', async () => {
    const root = await fixtureRoot()
    const sourcePath = join(root, '原文.docx')
    const targetPath = join(root, '正式模板.docx')
    const confirmed = await makeConfirmedSource(sourcePath)
    const service = new WorkDocxTemplateMaterializeServiceV1({
      lookup: lookup(),
      intake: { loadConfirmedForMaterialization: vi.fn(() => confirmed) },
      store: new WorkDocxTemplateMaterializeStoreV1(join(root, 'private', 'materialize.sqlite')),
      dialogs: { chooseNewTarget: vi.fn(async () => targetPath) },
      outputAccess: { openPath: vi.fn(async () => ''), revealPath: vi.fn(async () => undefined) },
      tempRoot: join(root, 'preview'),
    })
    const prepared = await service.execute(ADDRESS, {
      action: 'PREPARE',
      sourceSessionId: 'session',
      sourceRunId: 'run-1',
      toolCallId: 'tool-1',
    })
    if (!prepared.ok || prepared.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PREPARED') {
      throw new Error('expected prepared preview')
    }
    await expect(service.execute(ADDRESS, {
      action: 'CONFIRM',
      sourceSessionId: 'session',
      sourceRunId: 'run-1',
      toolCallId: 'tool-2',
      previewConfirmationToken: 'forged-token',
    })).resolves.toEqual({
      ok: false,
      error: { code: 'TEMPLATE_MATERIALIZE_CONFIRMATION_REQUIRED' },
    })
    await expect(service.execute(ADDRESS, {
      action: 'CONFIRM',
      sourceSessionId: 'session',
      sourceRunId: 'run-2',
      toolCallId: 'tool-cross-run',
    })).resolves.toEqual({
      ok: false,
      error: { code: 'TEMPLATE_MATERIALIZE_CONFIRMATION_REQUIRED' },
    })
    const published = await service.execute(ADDRESS, {
      action: 'CONFIRM',
      sourceSessionId: 'session',
      sourceRunId: 'run-1',
      toolCallId: 'tool-3',
      previewConfirmationToken: prepared.value.previewConfirmationToken,
    })
    expect(published.ok && published.value.kind).toBe(
      'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PUBLISHED',
    )
    expect(JSON.stringify(published)).not.toContain(prepared.value.previewConfirmationToken)
    await expect(access(targetPath)).resolves.toBeUndefined()
    service.close()
  })

  it('正式模板先进入本机模板库，并可按指定历史版本生成新文档', async () => {
    const root = await fixtureRoot()
    const sourcePath = join(root, '原文.docx')
    const outputPath = join(root, '使用历史模板生成.docx')
    const confirmed = await makeConfirmedSource(sourcePath)
    const sourceHash = createHash('sha256')
      .update(await readFile(sourcePath))
      .digest('hex')
    const chooseMaterializedTarget = vi.fn(async () => join(root, '不应直接另存.docx'))
    const library = new TemplateLibraryServiceV1({
      preferencePath: join(root, 'private', 'template-library.json'),
      now: () => new Date('2026-08-28T08:00:00.000Z'),
    })
    await library.configureRoot(join(root, '用户模板库'))

    const materialize = new WorkDocxTemplateMaterializeServiceV1({
      lookup: lookup(),
      intake: { loadConfirmedForMaterialization: vi.fn(() => confirmed) },
      store: new WorkDocxTemplateMaterializeStoreV1(
        join(root, 'private', 'template-materialize.sqlite'),
      ),
      dialogs: { chooseNewTarget: chooseMaterializedTarget },
      outputAccess: {
        openPath: vi.fn(async () => ''),
        revealPath: vi.fn(async () => undefined),
      },
      tempRoot: join(root, 'preview'),
      templateLibrary: library,
      now: () => new Date('2026-08-28T08:00:00.000Z'),
    })

    const prepared = await materialize.execute(ADDRESS, {
      action: 'PREPARE',
      sourceSessionId: 'session',
      sourceRunId: 'run-1',
      toolCallId: 'tool-1',
    })
    expect(prepared.ok && prepared.value.kind).toBe(
      'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PREPARED',
    )
    if (!prepared.ok || prepared.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PREPARED') {
      throw new Error('expected prepared preview')
    }
    const published = await materialize.execute(ADDRESS, {
      action: 'CONFIRM',
      sourceSessionId: 'session',
      sourceRunId: 'run-1',
      toolCallId: 'tool-2',
      previewConfirmationToken: prepared.value.previewConfirmationToken,
      templateName: '施工方案模板',
      purpose: '生成施工方案',
      tags: ['施工', '方案'],
    })
    expect(published).toMatchObject({
      ok: true,
      value: {
        kind: 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PUBLISHED',
        receipt: {
          library: { templateName: '施工方案模板', versionNumber: 1 },
          originalSourceUnchanged: true,
        },
      },
    })
    expect(chooseMaterializedTarget).not.toHaveBeenCalled()
    expect(JSON.stringify(published)).not.toContain(root)
    expect(
      createHash('sha256')
        .update(await readFile(sourcePath))
        .digest('hex'),
    ).toBe(sourceHash)
    if (
      !published.ok ||
      published.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_MATERIALIZE_PUBLISHED' ||
      !published.value.receipt.library
    ) {
      throw new Error('expected a published local-library template')
    }

    const listed = await library.list({ status: 'ACTIVE' })
    expect(listed.items).toEqual([
      expect.objectContaining({
        name: '施工方案模板',
        latestVersion: expect.objectContaining({ versionNumber: 1 }),
        versionCount: 1,
      }),
    ])
    expect(JSON.stringify(listed)).not.toContain(root)
    const detail = await library.getDetail(published.value.receipt.library.entryId)
    expect(detail.versions.map((version) => version.versionNumber)).toEqual([1])
    expect(detail.latestVersion.fields).toEqual([
      expect.objectContaining({
        fieldId: 'xgfield2_project_name',
        name: '项目名称',
        kind: 'TEXT',
        required: true,
      }),
    ])
    expect(detail.latestVersion.assetManifestV2).toMatchObject({
      manifestVersion: 2,
      lifecycle: 'VALIDATING',
      fieldGraph: {
        graphId: 'xggraph2_service',
        fields: [expect.objectContaining({ fieldId: 'xgfield2_project_name' })],
      },
      validation: {
        status: 'WARNING',
        checks: expect.arrayContaining([
          expect.objectContaining({ code: '01_DOCX_SAFETY_GATE', status: 'PASSED' }),
          expect.objectContaining({ code: '02_SOURCE_HASH_MATCH', status: 'PASSED' }),
          expect.objectContaining({ code: '14_ORIGINAL_UNCHANGED', status: 'PASSED' }),
          expect.objectContaining({ code: 'OFFICE_SURFACE_TRIAL_GATE', status: 'WARNING' }),
        ]),
      },
      provenance: {
        reportId: confirmed.report.reportId,
        sourceSha256: confirmed.sourceSha256,
        materializedSha256: published.value.receipt.outputSha256,
      },
    })
    expect(JSON.stringify(detail)).not.toContain(root)

    const chooseLibraryFile = vi.fn(async () => null)
    const workDocx = new WorkDocxServiceV1({
      lookup: lookup(),
      dialogs: {
        chooseTemplate: chooseLibraryFile,
        choosePayload: vi.fn(async () => null),
        chooseNewTarget: vi.fn(async () => outputPath),
      },
      tempRoot: join(root, 'document-generation'),
      templateLibrary: library,
    })
    const selected = await workDocx.selectTemplate({
      address: ADDRESS,
      templateVersionId: published.value.receipt.library.versionId,
    })
    expect(selected).toMatchObject({
      ok: true,
      value: {
        kind: 'TEMPLATE_SELECTED',
        templateDisplayName: '施工方案模板（第 1 版）.docx',
        templateVersionId: published.value.receipt.library.versionId,
        fields: [{ fieldId: 'xgfield2_project_name', name: '项目名称', required: true }],
      },
    })
    expect(chooseLibraryFile).not.toHaveBeenCalled()
    expect(JSON.stringify(selected)).not.toContain(root)
    if (!selected.ok || selected.value.kind !== 'TEMPLATE_SELECTED') {
      throw new Error('expected historical template selection')
    }
    const generated = await workDocx.prepareTemplateData({
      address: ADDRESS,
      selectionId: selected.value.selectionId,
      fields: [{
        fieldId: 'xgfield2_project_name',
        name: '项目名称',
        status: 'READY',
        value: '下盐路迁改工程',
      }],
    })
    expect(generated).toMatchObject({ ok: true, value: { kind: 'PREPARED' } })
    if (!generated.ok || generated.value.kind !== 'PREPARED') {
      throw new Error('expected prepared document from historical template')
    }
    await expect(
      workDocx.confirmTemplateData({
        address: ADDRESS,
        operationId: generated.value.operationId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        kind: 'PUBLISHED',
        templateVersionId: published.value.receipt.library.versionId,
      },
    })
    const output = await readFile(outputPath)
    const outputZip = await JSZip.loadAsync(output)
    expect(await outputZip.file('word/document.xml')!.async('string')).toContain('下盐路迁改工程')

    materialize.close()
    library.close()
  })
})
