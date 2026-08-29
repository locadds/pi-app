import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { startOfficeGatewayV1 } from '../out/office-gateway/server.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const profileDir = process.env.XIAOGUI_OFFICE_BROWSER_PROFILE
  ?? 'D:\\CodexTemp\\xiaogui-office-browser-profile'
const executablePath = process.env.XIAOGUI_OFFICE_BROWSER_EXECUTABLE
  ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
await mkdir(profileDir, { recursive: true })

const cookieName = `xiaogui_office_browser_${randomBytes(6).toString('hex')}`
const token = randomBytes(48).toString('base64url')
const gateway = await startOfficeGatewayV1({
  sessionCookieName: cookieName,
  sessionToken: token,
  viewerRoot: resolve(projectRoot, 'artifacts', 'office-viewer'),
  initialSnapshot: {},
})

const context = await chromium.launchPersistentContext(profileDir, {
  executablePath,
  headless: true,
})
try {
  await context.addCookies([{
    name: cookieName,
    value: token,
    url: gateway.origin,
    httpOnly: true,
    sameSite: 'Strict',
  }])
  const page = await context.newPage()
  page.on('console', (message) => process.stderr.write(`[viewer:${message.type()}] ${message.text()}\n`))
  page.on('pageerror', (error) => process.stderr.write(`[viewer:error] ${error.message}\n`))
  await page.goto(`${gateway.origin}/viewer/`, { waitUntil: 'domcontentloaded' })
  try {
    await page.getByText('可以编辑', { exact: true }).waitFor({ timeout: 20_000 })
  } catch (error) {
    process.stderr.write(`[viewer:body] ${await page.locator('body').innerText()}\n`)
    throw error
  }
  await page.locator('[data-field-decoration="verified"]').waitFor({ timeout: 10_000 })
  await assertNonDestructiveFieldDecoration(page)
  await page.getByRole('button', { name: '保存工作副本' }).click()
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 10_000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('可以编辑', { exact: true }).waitFor({ timeout: 20_000 })
  await page.locator('[data-field-decoration="verified"]').waitFor({ timeout: 10_000 })
  await assertNonDestructiveFieldDecoration(page)
  const usedJsHeapSize = await page.evaluate(() => {
    return globalThis.performance.memory?.usedJSHeapSize ?? null
  })
  process.stdout.write(`${JSON.stringify({ ok: true, usedJsHeapSize })}\n`)
} finally {
  await context.close()
  await gateway.close()
}

async function assertNonDestructiveFieldDecoration(page) {
  const snapshot = await page.evaluate(async () => {
    const response = await fetch('/api/v1/snapshot', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error(`snapshot read failed: ${response.status}`)
    return response.json()
  })
  const body = snapshot?.snapshot?.body
  const fieldText = '小规文档界面验证'
  const startIndex = body?.dataStream?.indexOf(fieldText) ?? -1
  const decoration = body?.customDecorations?.find(
    (item) => item.id === 'xiaogui.synthetic-field.office-surface.v1',
  )
  if (startIndex < 0) throw new Error('synthetic field text is missing')
  if (!decoration) throw new Error('synthetic field decoration is missing')
  if (decoration.startIndex !== startIndex || decoration.endIndex !== startIndex + fieldText.length - 1) {
    throw new Error('synthetic field decoration range does not match the text')
  }
}
