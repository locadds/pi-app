import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveTaskHubDesignRuntimeV1 } from './design-runtime-source'

describe('resolveTaskHubDesignRuntimeV1', () => {
  const previousRepo = process.env['XIAOGUI_REPO']
  const previousRuntimeDir = process.env['XIAOGUI_RUNTIME_DIR']
  const previousPython = process.env['XIAOGUI_PYTHON']
  const testRoot = 'E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910'
  const roots: string[] = []

  afterEach(async () => {
    if (previousRepo === undefined) delete process.env['XIAOGUI_REPO']
    else process.env['XIAOGUI_REPO'] = previousRepo
    if (previousRuntimeDir === undefined) delete process.env['XIAOGUI_RUNTIME_DIR']
    else process.env['XIAOGUI_RUNTIME_DIR'] = previousRuntimeDir
    if (previousPython === undefined) delete process.env['XIAOGUI_PYTHON']
    else process.env['XIAOGUI_PYTHON'] = previousPython
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('accepts the fixed private source and consumes its complete manifest', () => {
    const sourceRoot =
      'E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910/design-private-2d7/source'
    process.env['XIAOGUI_REPO'] = sourceRoot
    delete process.env['XIAOGUI_RUNTIME_DIR']
    delete process.env['XIAOGUI_PYTHON']

    const resolved = resolveTaskHubDesignRuntimeV1()

    expect(resolved.config.runtimeSource).toBe('env-repo')
    expect(resolved.config.repoRoot).toBe(sourceRoot)
    expect(resolved.config.pythonCwd).toBe(join(sourceRoot, 'python'))
    expect(resolved.extensionPath).toBe(join(sourceRoot, 'src', 'design', 'design-extension', 'index.ts'))
  })

  it('rejects a synthetic source whose manifest is not the fixed private manifest', async () => {
    const root = await mkdtemp(join(testRoot, 'TEST-root-'))
    roots.push(root)
    await mkdir(join(root, 'python'), { recursive: true })
    await writeFile(
      join(root, 'runtime-manifest.json'),
      JSON.stringify({ schemaVersion: 1, sourceSha: '2d7e98ffe88a1ec7afff34fcb327d49c35b6e625', files: [] }),
    )
    process.env['XIAOGUI_REPO'] = root
    delete process.env['XIAOGUI_RUNTIME_DIR']

    expect(() => resolveTaskHubDesignRuntimeV1()).toThrow('MANIFEST_HASH_MISMATCH')
  })

  it('rejects a runtime directory that is not the manifest source python directory', async () => {
    const runtimeDir = await mkdtemp(join(testRoot, 'TEST-root-'))
    roots.push(runtimeDir)
    process.env['XIAOGUI_REPO'] =
      'E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910/design-private-2d7/source'
    process.env['XIAOGUI_RUNTIME_DIR'] = runtimeDir

    expect(() => resolveTaskHubDesignRuntimeV1()).toThrow('PYTHON_RUNTIME_MISMATCH')
  })
})
