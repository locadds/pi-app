import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkReportDraftV1 } from '@shared/xiaogui-work-report-docx'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'

import { WorkReportDocxServiceV1 } from './work-report-docx-service'
import { WorkReportDocxStoreV1 } from './work-report-docx-store'

const ADDRESS = {
  projectId: `xgp1_${'a'.repeat(64)}`,
  sessionKey: `xgs1_${'b'.repeat(64)}`,
} as SessionAddressV1

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(process.env.XIAOGUI_TEST_TEMP_ROOT || tmpdir(), 'xiaogui-report-docx-test-'))
  roots.push(root)
  return root
}

function lookup(): SessionScopeLookupV1 {
  return {
    lookup: vi.fn(async (address: SessionAddressV1) => ({
      kind: 'FOUND' as const,
      scope: { ...address, sessionMode: 'WORK' as const },
    })),
  }
}

const DRAFT: WorkReportDraftV1 = {
  title: '八月项目进展汇报',
  sections: [
    {
      heading: '本周进展',
      paragraphs: ['已完成标准报告生成链路的方案梳理。'],
      bullets: ['预览阶段不写最终文件', '确认后只另存新文件'],
    },
    {
      heading: '下周计划',
      paragraphs: ['补充真实 Word 冒烟验证。'],
      bullets: [],
    },
  ],
}

describe('WORK 标准报告 DOCX 服务', () => {
  it('先打开标准 Word 预览，跨轮确认后可从 SQLite 恢复并另存新 DOCX', async () => {
    const root = await fixtureRoot()
    const targetPath = join(root, '八月项目进展汇报.docx')
    const databasePath = join(root, 'private', 'report-docx.sqlite')
    const previewPaths: string[] = []
    const chooseNewTarget = vi.fn(async () => targetPath)
    const openPath = vi.fn(async (path: string) => {
      await access(path)
      previewPaths.push(path)
      return ''
    })
    const options = () => ({
      lookup: lookup(),
      store: new WorkReportDocxStoreV1(databasePath),
      dialogs: { chooseNewTarget },
      outputAccess: { openPath, revealPath: vi.fn(async () => undefined) },
      tempRoot: join(root, 'preview'),
      now: () => new Date('2026-08-27T08:00:00.000Z'),
    })

    const first = new WorkReportDocxServiceV1(options())
    const prepared = await first.execute(ADDRESS, {
      action: 'PREPARE',
      draft: DRAFT,
      sourceSessionId: 'session-1',
      sourceRunId: 'run-1',
      toolCallId: 'tool-1',
    })

    expect(prepared.ok && prepared.value.kind).toBe('XIAOGUI_WORK_REPORT_DOCX_PREPARED')
    expect(JSON.stringify(prepared)).not.toContain(root)
    expect(JSON.stringify(prepared)).toContain(DRAFT.title)
    expect(JSON.stringify(prepared)).toContain('已完成标准报告生成链路的方案梳理。')
    expect(JSON.stringify(prepared)).toContain('确认后只另存新文件')
    expect(chooseNewTarget).toHaveBeenCalledOnce()
    expect(previewPaths).toHaveLength(1)
    await expect(access(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const previewZip = await JSZip.loadAsync(await readFile(previewPaths[0]!))
    const previewXml = await previewZip.file('word/document.xml')!.async('string')
    expect(previewXml).toContain(DRAFT.title)
    expect(previewXml).toContain('已完成标准报告生成链路的方案梳理。')
    expect(previewXml).toContain('预览阶段不写最终文件')
    expect(previewXml).toContain('<w:numPr>')

    await expect(
      first.execute(ADDRESS, {
        action: 'CONFIRM',
        sourceSessionId: 'session-1',
        sourceRunId: 'run-1',
        toolCallId: 'tool-2',
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'REPORT_DOCX_CONFIRMATION_REQUIRED' },
    })
    first.close()

    const second = new WorkReportDocxServiceV1(options())
    const published = await second.execute(ADDRESS, {
      action: 'CONFIRM',
      sourceSessionId: 'session-1',
      sourceRunId: 'run-2',
      toolCallId: 'tool-3',
    })

    expect(published.ok && published.value.kind).toBe('XIAOGUI_WORK_REPORT_DOCX_PUBLISHED')
    expect(JSON.stringify(published)).not.toContain(root)
    expect(JSON.stringify(published)).not.toContain(DRAFT.title)
    expect(chooseNewTarget).toHaveBeenCalledOnce()
    const output = await readFile(targetPath)
    const outputHash = createHash('sha256').update(output).digest('hex')
    expect(published.ok && published.value.kind === 'XIAOGUI_WORK_REPORT_DOCX_PUBLISHED'
      ? published.value.receipt.outputSha256
      : null).toBe(outputHash)
    const outputZip = await JSZip.loadAsync(output)
    const outputXml = await outputZip.file('word/document.xml')!.async('string')
    expect(outputXml).toContain(DRAFT.title)
    expect(outputXml).toContain('补充真实 Word 冒烟验证。')
    expect(outputXml).toContain('确认后只另存新文件')
    second.close()
  })

  it('PREPARE 拒绝已存在目标且不覆盖内容、不保留受控预览', async () => {
    const root = await fixtureRoot()
    const targetPath = join(root, '已存在.docx')
    const original = Buffer.from('existing-user-file')
    await writeFile(targetPath, original, { flag: 'wx' })
    const previewRoot = join(root, 'preview')
    const service = new WorkReportDocxServiceV1({
      lookup: lookup(),
      store: new WorkReportDocxStoreV1(join(root, 'private', 'report-docx.sqlite')),
      dialogs: { chooseNewTarget: vi.fn(async () => targetPath) },
      outputAccess: {
        openPath: vi.fn(async () => ''),
        revealPath: vi.fn(async () => undefined),
      },
      tempRoot: previewRoot,
    })

    const outcome = await service.execute(ADDRESS, {
        action: 'PREPARE',
        draft: DRAFT,
        sourceSessionId: 'session-1',
        sourceRunId: 'run-1',
        toolCallId: 'tool-existing',
      })
    service.close()

    expect(outcome).toEqual({ ok: false, error: { code: 'REPORT_DOCX_TARGET_EXISTS' } })
    expect(await readFile(targetPath)).toEqual(original)
    expect(await readdir(previewRoot)).toEqual([])
  })
})
