import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WorkMaterialsServiceV1 } from './work-materials-service'

const roots: string[] = []

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(process.env.XIAOGUI_TEST_TEMP || tmpdir(), `${label}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('WorkMaterialsServiceV1', () => {
  it('includes every file type and extracts supported office/text content without changing inputs', async () => {
    const root = await temporaryRoot('xiaogui-materials')
    await mkdir(join(root, '子目录'))
    await writeFile(join(root, '说明.txt'), '普通文本内容')
    await writeFile(join(root, '子目录', '汇总.xlsx'), Buffer.from('fake-xlsx'))
    const binary = Buffer.from([0, 1, 2, 3, 4])
    await writeFile(join(root, '现状图.dwg'), binary)
    const extractOfficeText = vi.fn(async (_content, type) => type === 'xlsx' ? '表格中的工程量' : '')
    const service = new WorkMaterialsServiceV1({ extractOfficeText })

    const snapshot = await service.read({ cwd: root }, new AbortController().signal)

    expect(snapshot.totalFileCount).toBe(3)
    expect(snapshot.files.map((file) => file.displayName).sort()).toEqual(['汇总.xlsx', '现状图.dwg', '说明.txt'].sort())
    expect(snapshot.files.find((file) => file.displayName === '说明.txt')).toMatchObject({
      status: 'CONTENT_EXTRACTED', extractor: 'PLAIN_TEXT', content: '普通文本内容',
    })
    expect(snapshot.files.find((file) => file.displayName === '汇总.xlsx')).toMatchObject({
      status: 'CONTENT_EXTRACTED', extractor: 'OFFICEPARSER', content: '表格中的工程量',
    })
    expect(snapshot.files.find((file) => file.displayName === '现状图.dwg')).toMatchObject({
      status: 'METADATA_ONLY', warnings: ['FORMAT_NOT_SEMANTICALLY_SUPPORTED'],
    })
    expect(extractOfficeText).toHaveBeenCalledWith(expect.any(Buffer), 'xlsx', expect.any(AbortSignal))
    expect(await readFile(join(root, '现状图.dwg'))).toEqual(binary)
    expect(snapshot.originalInputsUnchanged).toBe(true)
  })

  it('accepts an absolute path outside cwd and returns that path unchanged', async () => {
    const cwd = await temporaryRoot('xiaogui-materials-cwd')
    const outside = await temporaryRoot('xiaogui-materials-outside')
    const file = join(outside, '跨目录资料.md')
    await writeFile(file, '# 跨目录内容')
    const service = new WorkMaterialsServiceV1()

    const snapshot = await service.read(
      { cwd, paths: [file] },
      new AbortController().signal,
    )

    expect(snapshot.requestedPaths).toEqual([file])
    expect(snapshot.files).toHaveLength(1)
    expect(snapshot.files[0]).toMatchObject({
      absolutePath: file,
      status: 'CONTENT_EXTRACTED',
      content: '# 跨目录内容',
    })
  })
})
