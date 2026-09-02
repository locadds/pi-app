import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AdvancedTemplateDataV1 } from '@shared/xiaogui-work-docx-advanced-generation'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { WorkDocxAdvancedGenerationServiceV1 } from './work-docx-advanced-generation-service'
import { WorkDocxAdvancedGenerationStoreV1 } from './work-docx-advanced-generation-store'

const ADDRESS = { projectId: `xgp1_${'a'.repeat(64)}`, sessionKey: `xgs1_${'b'.repeat(64)}` } as SessionAddressV1
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(process.env.XIAOGUI_TEST_TEMP_ROOT || tmpdir(), 'xiaogui-advanced-generation-test-'))
  roots.push(root)
  return root
}

async function makeTemplate(path: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>项目：{{项目名称}}</w:t></w:r></w:p><w:sdt><w:sdtPr><w:tag w:val="xiaogui.repeat:事项"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>旧事项</w:t></w:r></w:p></w:sdtContent></w:sdt><w:sdt><w:sdtPr><w:tag w:val="xiaogui.conditional:显示说明"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>保留说明</w:t></w:r></w:p></w:sdtContent></w:sdt><w:sectPr/></w:body></w:document>')
  const content = await zip.generateAsync({ type: 'nodebuffer' })
  await writeFile(path, content, { flag: 'wx' })
  return content
}

function lookup(): SessionScopeLookupV1 {
  return { lookup: vi.fn(async (address: SessionAddressV1) => ({ kind: 'FOUND' as const, scope: { ...address, sessionMode: 'WORK' as const } })) }
}

const DATA: AdvancedTemplateDataV1 = {
  dataVersion: 1,
  variables: [{ name: '项目名称', status: 'RESOLVED', value: '下盐路迁改' }],
  repeatBlocks: [{ name: '事项', status: 'RESOLVED', records: [{ slots: [{ slotId: 's1', value: '第一项' }] }, { slots: [{ slotId: 's1', value: '第二项' }] }] }],
  conditionalBlocks: [{ name: '显示说明', status: 'RESOLVED', value: true }],
}

describe('WORK 高级 Word 生成服务', () => {
  it('选择、准备、跨轮确认、重启恢复并只另存新文件', async () => {
    const root = await fixtureRoot(); const templatePath = join(root, '小规模板.docx'); const targetPath = join(root, '小规成品.docx'); const databasePath = join(root, 'private', 'advanced.sqlite')
    const template = await makeTemplate(templatePath); const originalHash = createHash('sha256').update(template).digest('hex')
    const openPath = vi.fn(async (path: string) => { await access(path); return '' })
    const options = () => ({ lookup: lookup(), store: new WorkDocxAdvancedGenerationStoreV1(databasePath), dialogs: { chooseTemplate: vi.fn(async () => templatePath), chooseNewTarget: vi.fn(async () => targetPath) }, outputAccess: { openPath, revealPath: vi.fn(async () => undefined) }, tempRoot: join(root, 'preview'), now: () => new Date('2026-08-25T08:00:00.000Z') })

    const first = new WorkDocxAdvancedGenerationServiceV1(options())
    const selected = await first.execute(ADDRESS, { action: 'START', sourceSessionId: 'session', sourceRunId: 'run-1', toolCallId: 'tool-1' })
    expect(selected.ok && selected.value.kind).toBe('XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_SCHEMA_READY')
    expect(JSON.stringify(selected)).not.toContain(root)
    const prepared = await first.execute(ADDRESS, { action: 'PREPARE', data: DATA, sourceSessionId: 'session', sourceRunId: 'run-1', toolCallId: 'tool-2' })
    expect(prepared.ok && prepared.value.kind).toBe('XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_PREPARED')
    expect(await first.execute(ADDRESS, { action: 'CONFIRM', sourceSessionId: 'session', sourceRunId: 'run-1', toolCallId: 'tool-3' })).toEqual({ ok: false, error: { code: 'ADVANCED_GENERATION_CONFIRMATION_REQUIRED' } })
    first.close()

    const second = new WorkDocxAdvancedGenerationServiceV1(options())
    const resumed = await second.execute(ADDRESS, { action: 'RESUME', sourceSessionId: 'session', sourceRunId: 'run-2', toolCallId: 'tool-4' })
    expect(resumed.ok && resumed.value.kind).toBe('XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_RESUMED')
    const published = await second.execute(ADDRESS, { action: 'CONFIRM', sourceSessionId: 'session', sourceRunId: 'run-2', toolCallId: 'tool-5' })
    expect(published.ok && published.value.kind).toBe('XIAOGUI_WORK_DOCX_ADVANCED_GENERATION_PUBLISHED')
    expect(JSON.stringify(published)).not.toContain(root)
    expect(createHash('sha256').update(await readFile(templatePath)).digest('hex')).toBe(originalHash)
    const outputZip = await JSZip.loadAsync(await readFile(targetPath)); const xml = await outputZip.file('word/document.xml')!.async('string')
    expect(xml).toContain('下盐路迁改'); expect(xml).toContain('第一项'); expect(xml).toContain('第二项'); expect(xml).not.toContain('旧事项'); expect(xml).not.toContain('{{')
    second.close()
  })
})
