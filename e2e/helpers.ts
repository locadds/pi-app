import { expect, _electron as electron, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronExecutable = require('electron') as string

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = path.join(root, 'out/main/index.js')

const baseEnv = {
  ...process.env,
  PI_E2E: '1',
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  // Linux CI: avoid dbus/session noise
  ELECTRON_NO_ATTACH_CONSOLE: '1',
}

export async function launchApp(extraEnv: Record<string, string> = {}, extraArgs: string[] = []) {
  return electron.launch({
    executablePath: electronExecutable,
    args: [mainEntry, ...extraArgs],
    env: { ...baseEnv, ...extraEnv },
    timeout: 60_000,
  })
}

/** 当前产品品牌：窗口标题稳定包含“小规 Agent”。 */
export async function expectXiaoguiTitle(window: Page) {
  expect(await window.title()).toContain('小规 Agent')
}
