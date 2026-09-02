import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { startOfficeGatewayV1 } from '../out/office-gateway/server.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const userData = process.env.XIAOGUI_OFFICE_SMOKE_USER_DATA
  ?? 'D:\\CodexTemp\\xiaogui-office-spike-user-data'
await mkdir(userData, { recursive: true })
app.setPath('userData', userData)
app.disableHardwareAcceleration()
const evidencePath = resolve(userData, 'office-viewer-smoke-result.json')

const cookieName = `xiaogui_office_smoke_${randomBytes(6).toString('hex')}`
const token = randomBytes(48).toString('base64url')
const gateway = await startOfficeGatewayV1({
  sessionCookieName: cookieName,
  sessionToken: token,
  viewerRoot: resolve(projectRoot, 'artifacts', 'office-viewer'),
  initialSnapshot: {},
})

let window
let finalExitCode = 0
try {
  await Promise.race([
    app.whenReady(),
    new Promise((_, rejectReady) => setTimeout(() => rejectReady(new Error('Electron app ready timeout')), 20_000)),
  ])
  await session.defaultSession.cookies.set({
    url: gateway.origin,
    name: cookieName,
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
  })
  window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  await window.loadURL(`${gateway.origin}/viewer/`)
  await waitForText(window, '可以编辑', 20_000)
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('保存工作副本'))?.click()
  `)
  await waitForText(window, '已保存', 10_000)
  window.webContents.reloadIgnoringCache()
  await waitForText(window, '可以编辑', 20_000)

  const metrics = app.getAppMetrics().map((metric) => ({
    type: metric.type,
    workingSetSizeKiB: metric.memory.workingSetSize,
  }))
  const evidence = { ok: true, origin: gateway.origin, metrics }
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
} catch (error) {
  const evidence = { ok: false, error: error instanceof Error ? error.message : String(error) }
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  process.stderr.write(`${JSON.stringify(evidence)}\n`)
  finalExitCode = 1
} finally {
  window?.destroy()
  await gateway.close().catch(() => {})
  app.exit(finalExitCode)
}

async function waitForText(browserWindow, text, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const body = await browserWindow.webContents.executeJavaScript('document.body.innerText')
    if (String(body).includes('载入失败')) throw new Error(`Office Viewer reported failure: ${body}`)
    if (String(body).includes(text)) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  throw new Error(`Timed out waiting for Office Viewer text: ${text}`)
}
