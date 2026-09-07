import { expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
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

type PiDesktopWindow = Window & {
  piDesktop: {
    invoke(channel: string, request?: unknown): Promise<unknown>
  }
}

/**
 * Exercises the production trust boundary: only the Main-process native directory
 * picker registers a workspace before the Renderer asks to open it.
 */
export async function openTrustedWorkspace(
  app: ElectronApplication,
  page: Page,
  workspace: string,
): Promise<void> {
  await app.evaluate(({ dialog }, selectedWorkspace) => {
    const patchKey = Symbol.for('xiaogui.e2e.openDirectory.originalShowOpenDialog')
    const state = globalThis as Record<PropertyKey, unknown>
    if (state[patchKey]) throw new Error('native directory picker already patched')
    state[patchKey] = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedWorkspace] })
  }, workspace)

  try {
    const selection = await page.evaluate(
      async () => (window as PiDesktopWindow).piDesktop.invoke('ipc:dialog:openDirectory') as Promise<{ path: string | null }>,
    )
    if (!selection.path) throw new Error('native directory picker did not return a workspace')
    await page.evaluate(
      async (workspacePath) =>
        (window as PiDesktopWindow).piDesktop.invoke('ipc:workspace.open', {
          path: workspacePath,
          awaitWorker: false,
        }),
      selection.path,
    )
  } finally {
    await app.evaluate(({ dialog }) => {
      const patchKey = Symbol.for('xiaogui.e2e.openDirectory.originalShowOpenDialog')
      const state = globalThis as Record<PropertyKey, unknown>
      const original = state[patchKey]
      if (typeof original !== 'function') throw new Error('native directory picker patch missing original')
      dialog.showOpenDialog = original as typeof dialog.showOpenDialog
      delete state[patchKey]
    })
  }
}

export async function refreshProjectSidebar(page: Page): Promise<void> {
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('pi-desktop:settings-changed', {
        detail: { key: 'recentProjects' },
      }),
    ),
  )
}

export async function launchApp(extraEnv: Record<string, string> = {}, extraArgs: string[] = []) {
  const hasExplicitUserDataDir = extraArgs.some((arg) =>
    arg === '--user-data-dir' || arg.startsWith('--user-data-dir='),
  )
  const profileArg = hasExplicitUserDataDir
    ? []
    : [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'xiaogui-e2e-'))}`]
  return electron.launch({
    executablePath: electronExecutable,
    args: [mainEntry, ...profileArg, ...extraArgs],
    env: { ...baseEnv, ...extraEnv },
    timeout: 60_000,
  })
}

/** 当前产品品牌：窗口标题稳定包含“小规 Agent”。 */
export async function expectXiaoguiTitle(window: Page) {
  expect(await window.title()).toContain('小规 Agent')
}
