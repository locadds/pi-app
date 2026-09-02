#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(script, args = []) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(root, script), ...args], {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', rejectRun)
    child.once('close', (code) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`PACKAGING_STEP_FAILED:${script}:${code}`))
    })
  })
}

if (process.platform === 'win32') {
  await run('scripts/package-windows.mjs')
} else {
  await run('scripts/generate-release-sbom.mjs')
  await run('scripts/export-app-icon.mjs')
  await run('node_modules/vite/bin/vite.js', ['build', '--config', 'vite.office-viewer.config.ts'])
  await run('scripts/build-office-gateway.mjs')
  await run('node_modules/electron-vite/bin/electron-vite.js', ['build'])
  await run('node_modules/electron-builder/cli.js')
}
