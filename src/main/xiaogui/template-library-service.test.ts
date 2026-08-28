import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'

import type { TemplateLibrarySaveMetadataV1 } from '@shared/xiaogui-template-library'

import { TemplateLibraryServiceErrorV1, TemplateLibraryServiceV1 } from './template-library-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(
    join(process.env.XIAOGUI_TEST_TEMP_ROOT || tmpdir(), 'xiaogui-template-library-test-'),
  )
  roots.push(root)
  return root
}

async function docx(text: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml"
          ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`,
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
      </w:document>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

function metadata(name: string, tag = '周报'): TemplateLibrarySaveMetadataV1 {
  return {
    name,
    purpose: '生成项目周报',
    tags: [tag, '工作'],
    fields: [
      {
        fieldId: 'project_name',
        name: '项目名称',
        kind: 'TEXT',
        required: true,
      },
    ],
  }
}

function expectCode(error: unknown, code: string): boolean {
  return error instanceof TemplateLibraryServiceErrorV1 && error.code === code
}

describe('小规本机模板库服务', () => {
  it('记住用户选择的根目录，同名保存为不可变新版本并复用相同资产', async () => {
    const root = await fixtureRoot()
    const libraryRoot = join(root, '用户模板库')
    const preferencePath = join(root, 'private', 'template-library.json')
    let clock = new Date('2026-08-28T08:00:00.000Z')
    const first = new TemplateLibraryServiceV1({
      preferencePath,
      now: () => clock,
    })

    await expect(first.getConfiguration()).resolves.toEqual({
      configured: false,
    })
    await expect(first.configureRoot(libraryRoot)).resolves.toEqual({
      configured: true,
    })
    const bytes = await docx('第一版')
    const saved1 = await first.saveFromBuffer(bytes, metadata('项目周报模板'))
    clock = new Date('2026-08-28T08:01:00.000Z')
    const saved2 = await first.saveFromBuffer(bytes, {
      ...metadata('  项目周报模板  '),
      fields: [{ fieldId: 'owner', name: '负责人', kind: 'TEXT', required: false }],
    })

    expect(saved1.assetDeduplicated).toBe(false)
    expect(saved2.assetDeduplicated).toBe(true)
    expect(saved2.entry.entryId).toBe(saved1.entry.entryId)
    expect(saved2.entry.versionCount).toBe(2)
    expect(saved2.version.versionNumber).toBe(2)
    expect(saved2.version.versionId).not.toBe(saved1.version.versionId)
    expect(saved2.entry.versions.map((version) => version.versionNumber)).toEqual([2, 1])
    expect(saved2.entry.versions[0]?.fields[0]?.name).toBe('负责人')
    expect(saved2.entry.versions[1]?.fields[0]?.name).toBe('项目名称')
    expect(JSON.stringify(saved2)).not.toContain(root)
    expect(await first.getUsage()).toMatchObject({
      uniqueAssetCount: 1,
      templateCount: 1,
      versionCount: 2,
      totalAssetBytes: bytes.byteLength,
      capacityLimitBytes: null,
    })
    first.close()

    const restarted = new TemplateLibraryServiceV1({ preferencePath })
    await expect(restarted.getConfiguration()).resolves.toEqual({
      configured: true,
    })
    const list = await restarted.list()
    expect(list.total).toBe(1)
    expect(list.items[0]?.name).toBe('项目周报模板')
    expect(JSON.stringify(list)).not.toContain(root)
    const resolved = await restarted.resolveVersionForUse(saved1.version.versionId)
    expect(resolved.version.versionNumber).toBe(1)
    expect(resolved.assetPath).toBe(join(libraryRoot, 'assets', `${saved1.version.sha256}.docx`))
    expect(await readFile(resolved.assetPath)).toEqual(bytes)
    restarted.close()
  })

  it('支持名称、用途和标签检索，标签筛选采用全部匹配', async () => {
    const root = await fixtureRoot()
    const service = new TemplateLibraryServiceV1({
      preferencePath: join(root, 'private', 'preference.json'),
    })
    await service.configureRoot(join(root, 'library'))
    await service.saveFromBuffer(await docx('A'), metadata('工程周报', '工程'))
    await service.saveFromBuffer(await docx('B'), {
      ...metadata('会议纪要', '会议'),
      purpose: '整理会议结论',
    })

    await expect(service.list({ query: '会议' })).resolves.toMatchObject({
      total: 1,
    })
    await expect(service.list({ query: '项目周报' })).resolves.toMatchObject({
      total: 1,
    })
    await expect(service.list({ tags: ['会议', '工作'] })).resolves.toMatchObject({ total: 1 })
    await expect(service.list({ tags: ['会议', '工程'] })).resolves.toMatchObject({ total: 0 })
    service.close()
  })

  it('回收不删除资产；彻底删除仅清理无引用的内容寻址资产', async () => {
    const root = await fixtureRoot()
    const service = new TemplateLibraryServiceV1({
      preferencePath: join(root, 'private', 'preference.json'),
    })
    await service.configureRoot(join(root, 'library'))
    const sharedBytes = await docx('共享内容')
    const first = await service.saveFromBuffer(sharedBytes, metadata('模板甲'))
    const second = await service.saveFromBuffer(sharedBytes, metadata('模板乙'))
    const assetPath = (await service.resolveVersionForUse(second.version.versionId)).assetPath

    const trashedFirst = await service.moveToTrash(first.entry.entryId)
    expect(trashedFirst.status).toBe('TRASHED')
    await expect(service.resolveVersionForUse(first.version.versionId)).rejects.toSatisfy((error) =>
      expectCode(error, 'TEMPLATE_LIBRARY_ENTRY_TRASHED'),
    )
    expect((await service.list()).total).toBe(1)
    expect((await service.list({ status: 'TRASHED' })).total).toBe(1)
    await service.purgeTrashed(first.entry.entryId)
    await expect(access(assetPath)).resolves.toBeUndefined()
    expect((await service.getUsage()).uniqueAssetCount).toBe(1)

    await service.moveToTrash(second.entry.entryId)
    await service.restore(second.entry.entryId)
    await expect(service.purgeTrashed(second.entry.entryId)).rejects.toSatisfy((error) =>
      expectCode(error, 'TEMPLATE_LIBRARY_ENTRY_NOT_TRASHED'),
    )
    await service.moveToTrash(second.entry.entryId)
    await service.purgeTrashed(second.entry.entryId)
    await expect(access(assetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await service.getUsage()).toEqual({
      uniqueAssetCount: 0,
      templateCount: 0,
      activeTemplateCount: 0,
      trashedTemplateCount: 0,
      versionCount: 0,
      totalAssetBytes: 0,
      capacityLimitBytes: null,
    })
    service.close()
  })

  it('未配置、无效 DOCX 和直接彻底删除活动模板均明确失败', async () => {
    const root = await fixtureRoot()
    const service = new TemplateLibraryServiceV1({
      preferencePath: join(root, 'private', 'preference.json'),
    })
    await expect(service.list()).rejects.toSatisfy((error) =>
      expectCode(error, 'TEMPLATE_LIBRARY_NOT_CONFIGURED'),
    )
    await service.configureRoot(join(root, 'library'))
    await expect(
      service.saveFromBuffer(Buffer.from('不是 DOCX'), metadata('无效模板')),
    ).rejects.toSatisfy((error) => expectCode(error, 'TEMPLATE_LIBRARY_DOCUMENT_INVALID'))
    const saved = await service.saveFromBuffer(await docx('有效'), metadata('有效模板'))
    await expect(service.purgeTrashed(saved.entry.entryId)).rejects.toSatisfy((error) =>
      expectCode(error, 'TEMPLATE_LIBRARY_ENTRY_NOT_TRASHED'),
    )
    service.close()
  })
})
