import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { OfficeSnapshotV1 } from '../../packages/shared/xiaogui-office-surface'

const LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_BODY_LIMIT = 8 * 1024 * 1024

class OfficeGatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface OfficeGatewayOptionsV1 {
  readonly sessionCookieName: string
  readonly sessionToken: string
  readonly initialSnapshot: OfficeSnapshotV1
  readonly viewerRoot?: string
  readonly viewerFallbackHtml?: string
  readonly bodyLimitBytes?: number
}

export interface OfficeGatewayHandleV1 {
  readonly origin: string
  readonly headSha256: string
  close(): Promise<void>
}

interface SnapshotEnvelopeV1 {
  headSha256: string
  snapshot: OfficeSnapshotV1
}

export async function startOfficeGatewayV1(options: OfficeGatewayOptionsV1): Promise<OfficeGatewayHandleV1> {
  assertSessionConfiguration(options.sessionCookieName, options.sessionToken)
  const state: SnapshotEnvelopeV1 = {
    headSha256: digestSnapshot(options.initialSnapshot),
    snapshot: structuredClone(options.initialSnapshot),
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response, options, state).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined)
        return
      }
      if (error instanceof OfficeGatewayHttpError) {
        writeJson(response, error.status, { error: error.code, message: error.message })
      } else {
        writeJson(response, 500, { error: 'OFFICE_GATEWAY_INTERNAL', message: '本机文档网关处理失败。' })
      }
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address() as AddressInfo
  const origin = `http://${LOOPBACK_HOST}:${address.port}`
  return {
    origin,
    get headSha256() {
      return state.headSha256
    },
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose())
    }),
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: OfficeGatewayOptionsV1,
  state: SnapshotEnvelopeV1,
): Promise<void> {
  applySecurityHeaders(response)
  const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`)

  if (request.method === 'GET' && url.pathname === '/health') {
    writeJson(response, 200, { ok: true, service: 'xiaogui-office-gateway', version: 1 })
    return
  }
  if (!isAuthorized(request, options.sessionCookieName, options.sessionToken)) {
    writeJson(response, 401, { error: 'OFFICE_GATEWAY_UNAUTHORIZED', message: '文档会话未授权。' })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/snapshot') {
    writeJson(response, 200, {
      headSha256: state.headSha256,
      snapshot: state.snapshot,
    })
    return
  }

  if (request.method === 'PUT' && url.pathname === '/api/v1/snapshot') {
    const payload = await readJsonBody(request, options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT)
    if (!isSnapshotUpdate(payload)) {
      writeJson(response, 400, { error: 'OFFICE_SNAPSHOT_INVALID', message: '文档快照格式无效。' })
      return
    }
    if (payload.expectedHeadSha256 !== state.headSha256) {
      writeJson(response, 409, {
        error: 'OFFICE_WORKTREE_CONFLICT',
        message: '文档工作副本已经变化，请重新载入。',
        headSha256: state.headSha256,
      })
      return
    }
    state.snapshot = structuredClone(payload.snapshot)
    state.headSha256 = digestSnapshot(state.snapshot)
    writeJson(response, 200, { headSha256: state.headSha256 })
    return
  }

  if (request.method === 'GET' && (url.pathname === '/viewer' || url.pathname.startsWith('/viewer/'))) {
    await serveViewerAsset(response, url.pathname, options)
    return
  }

  writeJson(response, 404, { error: 'OFFICE_GATEWAY_NOT_FOUND', message: '请求的本机文档资源不存在。' })
}

async function serveViewerAsset(
  response: ServerResponse,
  pathname: string,
  options: OfficeGatewayOptionsV1,
): Promise<void> {
  const relativeName = pathname === '/viewer' || pathname === '/viewer/'
    ? 'index.html'
    : decodeURIComponent(pathname.slice('/viewer/'.length))
  if (!relativeName || relativeName.includes('\0')) {
    writeJson(response, 400, { error: 'OFFICE_GATEWAY_BAD_ASSET', message: '资源名称无效。' })
    return
  }
  if (!options.viewerRoot) {
    const fallback = options.viewerFallbackHtml ?? '<!doctype html><title>小规文档界面</title>'
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(fallback)
    return
  }

  const root = resolve(options.viewerRoot)
  const asset = resolve(root, relativeName)
  if (asset !== root && !asset.startsWith(`${root}${sep}`)) {
    writeJson(response, 403, { error: 'OFFICE_GATEWAY_BAD_ASSET', message: '拒绝访问文档界面目录之外的资源。' })
    return
  }
  try {
    await access(asset)
    const metadata = await stat(asset)
    if (!metadata.isFile()) throw new Error('not a file')
  } catch {
    writeJson(response, 404, { error: 'OFFICE_GATEWAY_ASSET_NOT_FOUND', message: '文档界面资源不存在。' })
    return
  }
  response.writeHead(200, {
    'Content-Type': contentType(asset),
    'Cache-Control': relativeName === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
  })
  createReadStream(asset).pipe(response)
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    total += chunk.length
    if (total > limit) {
      request.resume()
      throw new OfficeGatewayHttpError(413, 'OFFICE_GATEWAY_BODY_TOO_LARGE', '文档快照超过本机网关限制。')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return null
  }
}

function isSnapshotUpdate(value: unknown): value is {
  expectedHeadSha256: string
  snapshot: OfficeSnapshotV1
} {
  if (!value || typeof value !== 'object') return false
  const payload = value as Record<string, unknown>
  return /^sha256:[a-f0-9]{64}$/.test(String(payload.expectedHeadSha256))
    && Boolean(payload.snapshot)
    && typeof payload.snapshot === 'object'
    && !Array.isArray(payload.snapshot)
}

function digestSnapshot(snapshot: OfficeSnapshotV1): string {
  return `sha256:${createHash('sha256').update(stableJson(snapshot)).digest('hex')}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function isAuthorized(request: IncomingMessage, cookieName: string, token: string): boolean {
  const cookieValue = readCookie(request.headers.cookie, cookieName)
  if (!cookieValue) return false
  const actual = Buffer.from(cookieValue)
  const expected = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1).trim())
  }
  return null
}

function assertSessionConfiguration(cookieName: string, token: string): void {
  if (!/^[a-zA-Z0-9_-]{8,96}$/.test(cookieName)) throw new Error('Invalid Office Gateway cookie name')
  if (token.length < 32 || token.length > 512) throw new Error('Invalid Office Gateway session token')
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors file: http://127.0.0.1:*",
  )
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.woff': return 'font/woff'
    case '.woff2': return 'font/woff2'
    default: return 'application/octet-stream'
  }
}
