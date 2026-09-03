import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { OmpRuntimeStorageConfigV1 } from './omp-runtime-storage-config'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OMP runtime storage private configuration', () => {
  it('persists only a normalized absolute directory outside Renderer-visible settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaogui-omp-storage-config-'))
    roots.push(root)
    const configPath = join(root, 'private', 'omp-runtime-storage-v1.json')
    const config = new OmpRuntimeStorageConfigV1({
      configPath,
      now: () => '2026-09-03T10:00:00.000Z',
    })
    await expect(config.read()).resolves.toBeNull()
    await expect(config.save('relative/runtime')).rejects.toThrow('OMP_RUNTIME_STORAGE_DIR_INVALID')
    const absolute = process.platform === 'win32' ? 'D:\\XiaoguiRuntimeAssets' : '/tmp/xiaogui-runtime-assets'
    await expect(config.save(absolute)).resolves.toBe(absolute)
    await expect(config.read()).resolves.toBe(absolute)
    expect(await readFile(configPath, 'utf8')).toContain('"recordDigest"')

    await writeFile(configPath, '{"selectedStorageDirectory":"D:\\\\tampered"}')
    await expect(config.read()).rejects.toThrow('OMP_RUNTIME_STORAGE_CONFIG_INVALID')
  })
})
