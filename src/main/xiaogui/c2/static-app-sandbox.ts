import { BrowserWindow, protocol, session } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import { assertChildPath } from './archive-installer'
import { isC2StaticAppUrlAllowedV1 } from './static-app-url-policy'

const STATIC_ID = /^[A-Za-z0-9._-]+$/
let protocolRegistered = false

export function registerC2StaticAppProtocolV1(appsRoot: string): void {
  if (protocolRegistered) return
  protocolRegistered = true
  protocol.handle('xiaogui-app', async (request) => {
    try {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
      const url = new URL(request.url)
      const artifactId = decodeURIComponent(url.hostname)
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      const version = segments.shift() ?? ''
      if (!STATIC_ID.test(artifactId) || !STATIC_ID.test(version) || segments.length === 0) {
        return new Response('Not Found', { status: 404 })
      }
      const appRoot = resolve(appsRoot, artifactId, version)
      const target = assertChildPath(appRoot, join(appRoot, ...segments))
      const bytes = await readFile(target)
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': contentType(target),
          'content-security-policy': "default-src 'self'; connect-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'",
          'x-content-type-options': 'nosniff',
        },
      })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}

export class C2StaticAppSandboxV1 {
  open(value: { artifactId: string; version: string }): void {
    if (!STATIC_ID.test(value.artifactId) || !STATIC_ID.test(value.version)) throw new Error('invalid C2 App identity')
    const origin = `xiaogui-app://${encodeURIComponent(value.artifactId)}`
    const partition = `c2-static:${value.artifactId}:${value.version}`
    const isolatedSession = session.fromPartition(partition, { cache: false })
    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    isolatedSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isC2StaticAppUrlAllowedV1(details.url, value.artifactId, value.version) })
    })
    const window = new BrowserWindow({
      width: 960,
      height: 720,
      title: '小规静态应用',
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, target) => {
      if (!isC2StaticAppUrlAllowedV1(target, value.artifactId, value.version)) event.preventDefault()
    })
    void window.loadURL(`${origin}/${encodeURIComponent(value.version)}/index.html`)
  }
}

function contentType(path: string): string {
  switch (extname(path).toLocaleLowerCase('en-US')) {
    case '.html': case '.htm': return 'text/html; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.js': case '.mjs': return 'text/javascript; charset=utf-8'
    case '.json': case '.map': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.ico': return 'image/x-icon'
    case '.woff': return 'font/woff'
    case '.woff2': return 'font/woff2'
    case '.ttf': return 'font/ttf'
    default: return 'text/plain; charset=utf-8'
  }
}
