import { createHash, randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { startOfficeGatewayV1 } from '../out/office-gateway/server.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const profileDir = process.env.XIAOGUI_OFFICE_BROWSER_PROFILE ?? 'D:\\CodexTemp\\xiaogui-office-browser-profile'
const executablePath =
  process.env.XIAOGUI_OFFICE_BROWSER_EXECUTABLE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
await mkdir(profileDir, { recursive: true })

const cookieName = `xiaogui_office_browser_${randomBytes(6).toString('hex')}`
const token = randomBytes(48).toString('base64url')
const projectedText = [
  '模板资产化试验文档',
  '项目名称：下盐公路电力排管迁改工程',
  '建设单位：华东送变电工程有限公司',
  '复核摘要：下盐公路电力排管迁改工程正在整理为模板资产。',
  '本视图用于核对字段图谱、编辑工作副本和恢复状态。',
].join('\n')
const projectName = '下盐公路电力排管迁改工程'
const projectStart = projectedText.indexOf(projectName)
const projectSecondStart = projectedText.indexOf(projectName, projectStart + projectName.length)
const replacementProjectName = '临港测试项目'
const channelNonce = randomBytes(32).toString('hex')
const initialProjection = {
  projectionVersion: 1,
  kind: 'XIAOGUI_DOCX_STRUCTURED_PROJECTION',
  documentId: 'xiaogui-office-real-projection-smoke',
  title: '模板资产化与 Office Surface 联合冒烟',
  sourceSha256: createHash('sha256').update(projectedText).digest('hex'),
  purpose: 'TEMPLATE_DRAFT',
  readOnly: false,
  plainText: projectedText,
  fields: [
    {
      fieldId: 'project.name',
      displayName: '项目名称',
      occurrenceIds: ['occurrence.project.name.1', 'occurrence.project.name.2'],
    },
  ],
  occurrences: [projectStart, projectSecondStart].map((start, index) => ({
    occurrenceId: `occurrence.project.name.${index + 1}`,
    fieldId: 'project.name',
    originalText: projectName,
    startUtf16: start,
    endUtf16Exclusive: start + projectName.length,
    state: 'FIELD',
  })),
  warnings: ['当前为 DOCX 结构化试验视图，不代表 Word 原版式。'],
  statistics: {
    paragraphCount: 4,
    tableCount: 0,
    tableCellCount: 0,
    mappedOccurrenceCount: 2,
    unmappedOccurrenceCount: 0,
  },
}
const gateway = await startOfficeGatewayV1({
  sessionCookieName: cookieName,
  sessionToken: token,
  viewerRoot: resolve(projectRoot, 'artifacts', 'office-viewer'),
  initialSnapshot: initialProjection,
})

const context = await chromium.launchPersistentContext(profileDir, {
  executablePath,
  headless: true,
})
try {
  await context.addCookies([
    {
      name: cookieName,
      value: token,
      url: gateway.origin,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ])
  const page = await context.newPage()
  page.on('console', (message) => process.stderr.write(`[viewer:${message.type()}] ${message.text()}\n`))
  page.on('pageerror', (error) => process.stderr.write(`[viewer:error] ${error.message}\n`))
  await page.goto(`${gateway.origin}/viewer/?channelNonce=${channelNonce}`, {
    waitUntil: 'domcontentloaded',
  })
  await authorizeViewer(page, token, channelNonce)
  try {
    await page.getByText('可以编辑', { exact: true }).waitFor({ timeout: 20_000 })
  } catch (error) {
    process.stderr.write(`[viewer:body] ${await page.locator('body').innerText()}\n`)
    throw error
  }
  await page.locator('[data-field-decoration="verified"]').waitFor({ timeout: 10_000 })
  await assertStructuredProjection(page, projectName, 2)
  const updateResult = await updateFieldThroughParentBridge(page, channelNonce, replacementProjectName)
  if (updateResult.updatedOccurrenceIds.length !== 2 || updateResult.failedOccurrenceIds.length !== 0) {
    throw new Error(`field sync did not update both occurrences: ${JSON.stringify(updateResult)}`)
  }
  await assertStructuredProjection(page, replacementProjectName, 2)
  await page.getByRole('button', { name: '保存工作副本' }).click()
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 10_000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await authorizeViewer(page, token, channelNonce)
  await page.getByText('可以编辑', { exact: true }).waitFor({ timeout: 20_000 })
  await page.locator('[data-field-decoration="verified"]').waitFor({ timeout: 10_000 })
  await assertStructuredProjection(page, replacementProjectName, 2)
  const usedJsHeapSize = await page.evaluate(() => {
    return globalThis.performance.memory?.usedJSHeapSize ?? null
  })
  process.stdout.write(`${JSON.stringify({ ok: true, usedJsHeapSize })}\n`)
} finally {
  await context.close()
  await gateway.close()
}

async function authorizeViewer(page, accessToken, nonce) {
  await page.evaluate(
    ({ accessToken, nonce }) =>
      new Promise((resolve, reject) => {
        const channel = new MessageChannel()
        const timer = window.setTimeout(() => reject(new Error('viewer parent bridge ready timeout')), 20_000)
        channel.port1.onmessage = (event) => {
          if (event.data?.type !== 'VIEWER_READY') return
          window.clearTimeout(timer)
          globalThis.__xiaoguiOfficeSmokePort = channel.port1
          resolve(event.data)
        }
        channel.port1.start()
        window.postMessage(
          {
            protocol: 'xiaogui.office-surface.v1',
            channelNonce: nonce,
            type: 'OFFICE_PORT_OFFER',
            gatewayAccessToken: accessToken,
          },
          window.location.origin,
          [channel.port2],
        )
      }),
    { accessToken, nonce },
  )
}

async function updateFieldThroughParentBridge(page, nonce, value) {
  return page.evaluate(
    ({ nonce, value }) =>
      new Promise((resolve, reject) => {
        const port = globalThis.__xiaoguiOfficeSmokePort
        if (!port) return reject(new Error('viewer parent bridge is unavailable'))
        const requestId = `smoke-${Date.now()}`
        const timer = window.setTimeout(() => reject(new Error('field update result timeout')), 20_000)
        const listener = (event) => {
          if (event.data?.type !== 'VIEWER_FIELD_UPDATE_RESULT' || event.data.requestId !== requestId) return
          window.clearTimeout(timer)
          port.removeEventListener('message', listener)
          resolve(event.data)
        }
        port.addEventListener('message', listener)
        port.postMessage({
          protocol: 'xiaogui.office-surface.v1',
          channelNonce: nonce,
          type: 'PARENT_UPDATE_FIELD',
          requestId,
          fieldId: 'project.name',
          value,
          occurrenceIds: ['occurrence.project.name.1', 'occurrence.project.name.2'],
        })
      }),
    { nonce, value },
  )
}

async function assertStructuredProjection(page, fieldText, expectedCount) {
  const snapshot = await page.evaluate(async () => {
    const response = await fetch('/api/v1/snapshot', {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`snapshot read failed: ${response.status}`)
    return response.json()
  })
  const worktree = snapshot?.snapshot
  const body = worktree?.document?.body ?? worktree?.body
  const matches = [...String(body?.dataStream ?? '').matchAll(new RegExp(fieldText, 'g'))]
  if (matches.length !== expectedCount) {
    throw new Error(`structured DOCX field occurrence count mismatch: ${matches.length}`)
  }
  for (let index = 0; index < expectedCount; index += 1) {
    const decoration = body?.customDecorations?.find(
      (item) => item.id === `xiaogui.occurrence.v1:occurrence.project.name.${index + 1}`,
    )
    if (!decoration) throw new Error('structured DOCX field decoration is missing')
    if (decoration.startIndex !== matches[index].index) {
      throw new Error('structured DOCX field decoration start does not match the text')
    }
  }
}
