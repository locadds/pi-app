#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDDriveCacheRoot } from './verify-libreoffice-runtime.mjs'

if (process.platform !== 'win32') throw new Error('WINDOWS_PACKAGING_REQUIRES_WINDOWS')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prebuilt = process.argv.includes('--prebuilt')
const buildCacheRoot = assertDDriveCacheRoot(
  process.env.XIAOGUI_BUILD_CACHE_ROOT || 'D:\\CodexTemp\\xiaogui-build-cache',
)
const libreOfficeCacheRoot = assertDDriveCacheRoot(
  process.env.XIAOGUI_LIBREOFFICE_CACHE_ROOT || 'D:\\CodexTemp\\xiaogui-libreoffice-cache',
)
const cachePaths = {
  npm: join(buildCacheRoot, 'npm'),
  electron: join(buildCacheRoot, 'electron'),
  electronBuilder: join(buildCacheRoot, 'electron-builder'),
  temporary: join(buildCacheRoot, 'temp'),
}
await Promise.all(Object.values(cachePaths).map((path) => mkdir(path, { recursive: true })))

const packagingEnvironment = {
  ...process.env,
  XIAOGUI_BUILD_CACHE_ROOT: buildCacheRoot,
  XIAOGUI_LIBREOFFICE_CACHE_ROOT: libreOfficeCacheRoot,
  npm_config_cache: cachePaths.npm,
  ELECTRON_CACHE: cachePaths.electron,
  ELECTRON_BUILDER_CACHE: cachePaths.electronBuilder,
  TEMP: cachePaths.temporary,
  TMP: cachePaths.temporary,
}

function run(script, args = []) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(root, script), ...args], {
      cwd: root,
      env: packagingEnvironment,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', rejectRun)
    child.once('close', (code) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`WINDOWS_PACKAGING_STEP_FAILED:${script}:${code}`))
    })
  })
}

await run('scripts/generate-release-sbom.mjs')
await run('scripts/prepare-libreoffice-runtime.mjs')
await run('scripts/verify-libreoffice-runtime.mjs')
if (!prebuilt) {
  await run('scripts/export-app-icon.mjs')
  await run('node_modules/electron-vite/bin/electron-vite.js', ['build'])
}
await run('node_modules/electron-builder/cli.js', ['--win', '--publish', 'never'])
