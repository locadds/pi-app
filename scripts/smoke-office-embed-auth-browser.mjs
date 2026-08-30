import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { chromium } from '@playwright/test'

import { startOfficeGatewayV1 } from '../out/office-gateway/server.mjs'

const evidenceRoot = process.env.XIAOGUI_OFFICE_EMBED_EVIDENCE_ROOT ?? 'D:\\CodexTemp'
const executablePath = process.env.XIAOGUI_OFFICE_BROWSER_EXECUTABLE
  ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
await mkdir(evidenceRoot, { recursive: true })
const temporaryRoot = await mkdtemp(join(evidenceRoot, 'xiaogui-office-embed-auth-'))
const profileDir = join(temporaryRoot, 'profile')
const parentPath = join(temporaryRoot, 'parent.html')
const viewerRoot = join(temporaryRoot, 'viewer')
const channelNonce = randomBytes(32).toString('hex')
const cookieName = `xiaogui_office_embed_${randomBytes(6).toString('hex')}`
const token = randomBytes(48).toString('base64url')
await mkdir(viewerRoot, { recursive: true })
await writeFile(join(viewerRoot, 'index.html'), '<!doctype html><meta charset="utf-8"><script src="./app.js"></script>', 'utf8')
await writeFile(join(viewerRoot, 'app.js'), `
  const nonce = new URL(location.href).searchParams.get('channelNonce')
  let directStatus = null
  fetch('/api/v1/snapshot', { credentials: 'same-origin', cache: 'no-store' })
    .then((response) => { directStatus = response.status })
    .catch(() => { directStatus = 0 })
  addEventListener('message', (event) => {
    if (event.source !== parent || event.ports.length !== 1) return
    if (event.data?.type !== 'OFFICE_PORT_OFFER' || event.data.channelNonce !== nonce) return
    const port = event.ports[0]
    const requestId = crypto.randomUUID()
    port.onmessage = (portEvent) => {
      const response = portEvent.data
      if (response?.type !== 'PARENT_GATEWAY_RESPONSE' || response.requestId !== requestId) return
      parent.postMessage({ type: 'PROXIED_GATEWAY_RESULT', directStatus, response }, '*')
    }
    port.start()
    port.postMessage({
      protocol: 'xiaogui.office-surface.v1',
      channelNonce: nonce,
      type: 'VIEWER_GATEWAY_READ_REQUEST',
      requestId,
    })
  })
`, 'utf8')
const gateway = await startOfficeGatewayV1({
  sessionCookieName: cookieName,
  sessionToken: token,
  initialSnapshot: { title: 'file parent iframe auth smoke' },
  viewerRoot,
})

await writeFile(
  parentPath,
  `<!doctype html><meta charset="utf-8"><script>
    const nonce = ${JSON.stringify(channelNonce)}
    let proxyPort = null
    window.__deliverOfficeGatewayResponse = (response) => proxyPort?.postMessage(response)
    addEventListener('message', (event) => {
      if (event.data?.type === 'PROXIED_GATEWAY_RESULT') window.__xiaoguiEmbedResult = event.data
    })
    addEventListener('DOMContentLoaded', () => {
      const iframe = document.querySelector('iframe')
      iframe.addEventListener('load', () => {
        const channel = new MessageChannel()
        proxyPort = channel.port1
        proxyPort.onmessage = (event) => {
          console.log('XIAOGUI_OFFICE_PROXY_REQUEST:' + JSON.stringify(event.data))
        }
        proxyPort.start()
        iframe.contentWindow.postMessage({
          protocol: 'xiaogui.office-surface.v1',
          channelNonce: nonce,
          type: 'OFFICE_PORT_OFFER',
        }, ${JSON.stringify(gateway.origin)}, [channel.port2])
      })
    })
  </script><iframe src="${gateway.origin}/viewer/?channelNonce=${channelNonce}"></iframe>`,
  'utf8',
)

const context = await chromium.launchPersistentContext(profileDir, {
  executablePath,
  headless: true,
})

try {
  const page = await context.newPage()
  page.on('console', (message) => {
    const prefix = 'XIAOGUI_OFFICE_PROXY_REQUEST:'
    if (!message.text().startsWith(prefix)) return
    const request = JSON.parse(message.text().slice(prefix.length))
    void (async () => {
      const response = await fetch(`${gateway.origin}/api/v1/snapshot`, {
        headers: { Cookie: `${cookieName}=${encodeURIComponent(token)}` },
      })
      const payload = await response.json()
      await page.evaluate((gatewayResponse) => {
        window.__deliverOfficeGatewayResponse(gatewayResponse)
      }, response.ok
        ? {
            protocol: 'xiaogui.office-surface.v1',
            channelNonce,
            type: 'PARENT_GATEWAY_RESPONSE',
            requestId: request.requestId,
            ok: true,
            headSha256: payload.headSha256,
            snapshot: payload.snapshot,
          }
        : {
            protocol: 'xiaogui.office-surface.v1',
            channelNonce,
            type: 'PARENT_GATEWAY_RESPONSE',
            requestId: request.requestId,
            ok: false,
            errorCode: payload.error ?? 'OFFICE_GATEWAY_PROXY_FAILED',
            message: payload.message ?? 'proxy failed',
          })
    })()
  })
  await page.goto(pathToFileURL(parentPath).toString(), { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__xiaoguiEmbedResult), undefined, { timeout: 10_000 })
  const payload = await page.evaluate(() => window.__xiaoguiEmbedResult)
  const browserCookies = await context.cookies(gateway.origin)
  if (
    payload?.type !== 'PROXIED_GATEWAY_RESULT'
    || payload.directStatus !== 401
    || payload.response?.ok !== true
    || payload.response.snapshot?.title !== 'file parent iframe auth smoke'
    || browserCookies.length !== 0
  ) {
    throw new Error(`file parent iframe snapshot load failed: ${JSON.stringify(payload)}`)
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    directStatus: payload.directStatus,
    proxied: true,
    browserCookieCount: browserCookies.length,
  })}\n`)
} finally {
  await context.close()
  await gateway.close()
  await rm(temporaryRoot, { recursive: true, force: true })
}
