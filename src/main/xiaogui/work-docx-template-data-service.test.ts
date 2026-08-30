import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Document, Packer, Paragraph, TextRun, patchDetector } from 'docx'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { TemplateLibraryServiceV1 } from './template-library-service'
import { WorkDocxServiceV1, type WorkDocxDialogPortV1 } from './work-docx-service'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as SessionAddressV1
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'xiaogui-template-data-test-'))
  roots.push(value)
  return value
}

async function writeDocx(path: string, text: string): Promise<void> {
  const document = new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun(text)] })] }],
  })
  await writeFile(path, await Packer.toBuffer(document))
}

function lookup(): SessionScopeLookupV1 {
  return {
    lookup: vi.fn(async (address: SessionAddressV1) => ({
      kind: 'FOUND' as const,
      scope: { ...address, sessionMode: 'WORK' as const },
    })),
  }
}

function dialogPort(template: string, target: string): WorkDocxDialogPortV1 {
  return {
    chooseTemplate: vi.fn(async () => template),
    choosePayload: vi.fn(async () => null),
    chooseNewTarget: vi.fn(async () => target),
  }
}

describe('WorkDocxServiceV1 template data flow', () => {
  it('keeps unresolved fields before save-as, then publishes from canonical conversation data', async () => {
    const dir = await root()
    const template = join(dir, '模板.docx')
    const target = join(dir, '结果.docx')
    await writeDocx(template, '项目：{{项目名称}}；负责人：{{负责人}}')
    const before = await readFile(template)
    const dialogs = dialogPort(template, target)
    const service = new WorkDocxServiceV1({ lookup: lookup(), dialogs, tempRoot: join(dir, 'stage') })

    const selected = await service.selectTemplate({ address: ADDRESS })
    expect(selected).toMatchObject({
      ok: true,
      value: {
        kind: 'TEMPLATE_SELECTED',
        templateDisplayName: '模板.docx',
        fields: [
          { name: '负责人', required: true, occurrences: 1, locations: ['正文'] },
          { name: '项目名称', required: true, occurrences: 1, locations: ['正文'] },
        ],
        profile: { bodyPartCount: 1, sectionCount: 1, headerPartCount: 0, footerPartCount: 0 },
      },
    })
    if (!selected.ok || selected.value.kind !== 'TEMPLATE_SELECTED') throw new Error('expected selection')
    const fieldByName = new Map(selected.value.fields.map((field) => [field.name, field]))
    const ownerField = fieldByName.get('负责人')!
    const projectField = fieldByName.get('项目名称')!

    await expect(
      service.prepareTemplateData({
        address: ADDRESS,
        selectionId: selected.value.selectionId,
        fields: [
          { fieldId: ownerField.fieldId, name: '负责人', status: 'UNRESOLVED' },
          { fieldId: projectField.fieldId, name: '项目名称', status: 'READY', value: '下盐路' },
        ],
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        kind: 'INPUT_REQUIRED',
        unresolvedFields: ['负责人'],
        unresolvedFieldIds: [ownerField.fieldId],
      },
    })
    expect(dialogs.chooseNewTarget).not.toHaveBeenCalled()

    const prepared = await service.prepareTemplateData({
      address: ADDRESS,
      selectionId: selected.value.selectionId,
      fields: [
        { fieldId: projectField.fieldId, name: '项目名称', status: 'READY', value: '下盐路', sourceSummary: '来自当前对话' },
        { fieldId: ownerField.fieldId, name: '负责人', status: 'READY', value: '规划一组' },
      ],
    })
    expect(prepared).toMatchObject({
      ok: true,
      value: { kind: 'PREPARED', fields: ['负责人', '项目名称'] },
    })
    if (!prepared.ok || prepared.value.kind !== 'PREPARED') throw new Error('expected prepared')
    expect(prepared.value.dataSha256).toBe(
      createHash('sha256')
        .update(JSON.stringify([
          { fieldId: ownerField.fieldId, name: '负责人', value: '规划一组' },
          { fieldId: projectField.fieldId, name: '项目名称', value: '下盐路' },
        ].sort((left, right) => left.fieldId.localeCompare(right.fieldId))))
        .digest('hex'),
    )

    const published = await service.confirmTemplateData({
      address: ADDRESS,
      operationId: prepared.value.operationId,
    })
    expect(published).toMatchObject({
      ok: true,
      value: { kind: 'PUBLISHED', dataSha256: prepared.value.dataSha256, originalInputsUnchanged: true },
    })
    const output = await readFile(target)
    expect(await patchDetector({ data: output })).toEqual([])
    const zip = await JSZip.loadAsync(output)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('下盐路')
    expect(xml).toContain('规划一组')
    expect(await readFile(template)).toEqual(before)
  })

  it('classifies a finished document without selecting a save target or retaining an operation', async () => {
    const dir = await root()
    const template = join(dir, '成品.docx')
    const target = join(dir, '不应生成.docx')
    await writeDocx(template, '这是一份已经写好的方案文本')
    const dialogs = dialogPort(template, target)
    const service = new WorkDocxServiceV1({ lookup: lookup(), dialogs, tempRoot: join(dir, 'stage') })

    await expect(service.selectTemplate({ address: ADDRESS })).resolves.toMatchObject({
      ok: true,
      value: { kind: 'TEMPLATE_PREPARATION_REQUIRED', templateDisplayName: '成品.docx' },
    })
    expect(service.consumeTemplateIntakeHandoff(ADDRESS)).toMatchObject({
      sourcePath: template,
      templateDisplayName: '成品.docx',
    })
    expect(service.consumeTemplateIntakeHandoff(ADDRESS)).toBeNull()
    expect(dialogs.chooseNewTarget).not.toHaveBeenCalled()
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects duplicate and unknown fields before selecting a save target', async () => {
    const dir = await root()
    const template = join(dir, '模板.docx')
    const target = join(dir, '结果.docx')
    await writeDocx(template, '{{project}} / {{owner}}')
    const dialogs = dialogPort(template, target)
    const service = new WorkDocxServiceV1({ lookup: lookup(), dialogs, tempRoot: join(dir, 'stage') })
    const selected = await service.selectTemplate({ address: ADDRESS })
    if (!selected.ok || selected.value.kind !== 'TEMPLATE_SELECTED') throw new Error('expected selection')
    const projectField = selected.value.fields.find((field) => field.name === 'project')!
    const ownerField = selected.value.fields.find((field) => field.name === 'owner')!

    await expect(
      service.prepareTemplateData({
        address: ADDRESS,
        selectionId: selected.value.selectionId,
        fields: [
          { fieldId: projectField.fieldId, name: 'project', status: 'READY', value: 'A' },
          { fieldId: projectField.fieldId, name: 'project', status: 'READY', value: 'B' },
        ],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INPUT_INVALID' } })
    await expect(
      service.prepareTemplateData({
        address: ADDRESS,
        selectionId: selected.value.selectionId,
        fields: [
          { fieldId: projectField.fieldId, name: 'project', status: 'READY', value: 'A' },
          { fieldId: ownerField.fieldId, name: 'unknown', status: 'READY', value: 'B' },
        ],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INPUT_INVALID' } })
    expect(dialogs.chooseNewTarget).not.toHaveBeenCalled()
  })

  it('按历史模板的稳定字段编号取值，只追问必填字段并将未提供的可选字段留空', async () => {
    const dir = await root()
    const template = join(dir, '资产模板.docx')
    const target = join(dir, '资产模板结果.docx')
    await writeDocx(template, '项目：{{项目名称}}；备注：{{备注}}')
    const library = new TemplateLibraryServiceV1({
      preferencePath: join(dir, 'private', 'template-library.json'),
    })
    await library.configureRoot(join(dir, 'library'))
    const saved = await library.saveFromBuffer(await readFile(template), {
      name: '资产模板',
      fields: [
        { fieldId: 'xgfield2_project', name: '项目名称', kind: 'TEXT', required: true },
        { fieldId: 'xgfield2_note', name: '备注', kind: 'TEXT', required: false },
      ],
    })
    const dialogs = dialogPort(template, target)
    const service = new WorkDocxServiceV1({
      lookup: lookup(),
      dialogs,
      tempRoot: join(dir, 'stage'),
      templateLibrary: library,
    })
    const selected = await service.selectTemplate({
      address: ADDRESS,
      templateVersionId: saved.version.versionId,
    })
    if (!selected.ok || selected.value.kind !== 'TEMPLATE_SELECTED') {
      throw new Error('expected library template selection')
    }
    expect(selected.value.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: 'xgfield2_project', required: true }),
      expect.objectContaining({ fieldId: 'xgfield2_note', required: false }),
    ]))
    const prepared = await service.prepareTemplateData({
      address: ADDRESS,
      selectionId: selected.value.selectionId,
      fields: [{
        fieldId: 'xgfield2_project',
        name: '项目名称',
        status: 'READY',
        value: '下盐路迁改工程',
      }],
    })
    if (!prepared.ok || prepared.value.kind !== 'PREPARED') {
      throw new Error('expected optional field to remain non-blocking')
    }
    expect(prepared.value.fieldIds).toEqual(['xgfield2_note', 'xgfield2_project'])
    await expect(service.confirmTemplateData({
      address: ADDRESS,
      operationId: prepared.value.operationId,
    })).resolves.toMatchObject({ ok: true, value: { kind: 'PUBLISHED' } })
    const xml = await (await JSZip.loadAsync(await readFile(target)))
      .file('word/document.xml')!
      .async('string')
    expect(xml).toContain('下盐路迁改工程')
    expect(xml).not.toContain('{{备注}}')
    library.close()
  })
})
