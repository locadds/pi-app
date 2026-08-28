import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TemplateReviewReplacementImageStoreV1 } from './work-document-review-image-store'

const roots: string[] = []
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])

async function makeFixture(): Promise<{ root: string; storeRoot: string; sourcePath: string }> {
  const root = await mkdtemp(join(process.env.XIAOGUI_TEST_TEMP_ROOT || tmpdir(), 'xiaogui-review-image-'))
  roots.push(root)
  const storeRoot = join(root, 'store')
  const sourcePath = join(root, '替换图片.png')
  await writeFile(sourcePath, PNG)
  return { root, storeRoot, sourcePath }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('文档复核替换图片令牌库', () => {
  it('导入后只用不透明令牌即可取回已校验图片', async () => {
    const { storeRoot, sourcePath } = await makeFixture()
    const store = new TemplateReviewReplacementImageStoreV1(storeRoot)

    const imported = await store.importFromPath(sourcePath)
    const resolved = await store.resolve(imported.token)

    expect(imported.displayName).toBe('替换图片.png')
    expect(imported.token).toMatch(/^xgtri1_[0-9a-f-]{36}$/i)
    expect(resolved).toMatchObject({ extension: 'png', contentType: 'image/png' })
    expect(resolved.content.equals(PNG)).toBe(true)
  })

  it('元数据暂存失败时清理自己创建的图片暂存文件且不删除冲突文件', async () => {
    const { storeRoot, sourcePath } = await makeFixture()
    const uuid = '00000000-0000-4000-8000-000000000001'
    const token = `xgtri1_${uuid}`
    await mkdir(storeRoot, { recursive: true })
    await writeFile(join(storeRoot, `${token}.json.tmp`), '保留冲突文件')
    const store = new TemplateReviewReplacementImageStoreV1(storeRoot, () => uuid)

    await expect(store.importFromPath(sourcePath)).rejects.toMatchObject({ code: 'EEXIST' })

    expect(await readdir(storeRoot)).toEqual([`${token}.json.tmp`])
  })
})
