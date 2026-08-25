import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

import {
  validateXiaoguiNodePublicDtoV1,
  type XiaoguiAssignmentPayloadRefV1,
  type XiaoguiNodeCapabilityManifestV1,
  type XiaoguiNodeCapabilityV1,
  type XiaoguiNodeDataEgressPolicyV1,
  type XiaoguiNodeHealthV1,
  type XiaoguiNodePortV1,
} from '@shared/xiaogui-node-contract'

export interface XiaoguiLanHubHttpServerV1 {
  readonly port: number
  readonly origin: string
  close(): Promise<void>
}

export async function startXiaoguiLanHubHttpServerV1(options: {
  hub: XiaoguiNodePortV1
  authorization: {
    hubToken: string
    nodeTokens: ReadonlyMap<string, string>
  }
  port?: number
  bindHost?: string
}): Promise<XiaoguiLanHubHttpServerV1> {
  assertPrivateToken(options.authorization.hubToken)
  for (const token of options.authorization.nodeTokens.values()) assertPrivateToken(token)
  const bindHost = options.bindHost ?? '127.0.0.1'
  const server = createServer(async (request, response) => {
    try {
      if (!request.url || request.method !== 'POST') return write(response, 404, { ok: false, reasonCode: 'LAN_ROUTE_NOT_FOUND' })
      const body = await readJson(request)
      if (!validateXiaoguiNodePublicDtoV1(body).ok) return write(response, 400, { ok: false, reasonCode: 'NODE_PUBLIC_DTO_LEAK' })
      if (!authorizeRequest(request.url, body, bearerToken(request), options.authorization)) {
        return write(response, 401, { ok: false, reasonCode: 'LAN_NODE_UNAUTHORIZED' })
      }
      const result = await route(request.url, body, options.hub)
      if (!validateXiaoguiNodePublicDtoV1(result).ok) return write(response, 500, { ok: false, reasonCode: 'NODE_PUBLIC_DTO_LEAK' })
      return write(response, isFailure(result) ? 409 : 200, result)
    } catch (error) {
      return write(response, error instanceof BodyLimitError ? 413 : 500, {
        ok: false,
        reasonCode: error instanceof BodyLimitError ? 'LAN_BODY_TOO_LARGE' : 'LAN_HUB_INTERNAL',
      })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, bindHost, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('LAN_HUB_LISTEN_FAILED')
  const clientHost = bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost
  return { port: address.port, origin: `http://${clientHost}:${address.port}`, close: () => closeServer(server) }
}

async function route(url: string, body: unknown, hub: XiaoguiNodePortV1): Promise<unknown> {
  switch (url) {
    case '/register':
      return hub.register((body as { manifest: XiaoguiNodeCapabilityManifestV1 }).manifest)
    case '/heartbeat': {
      const input = body as { nodeId: string; health: XiaoguiNodeHealthV1 }
      return hub.heartbeat(input.nodeId, input.health)
    }
    case '/offer': {
      const input = body as {
        taskId: string
        requiredCapabilities: XiaoguiNodeCapabilityV1[]
        dataEgressPolicy: XiaoguiNodeDataEgressPolicyV1
        payloadRef: XiaoguiAssignmentPayloadRefV1
      }
      return hub.offer(input)
    }
    case '/claim':
      return hub.claim((body as { nodeId: string }).nodeId)
    case '/approve-local': {
      const input = body as { nodeId: string; assignmentId: string; leaseId: string }
      return hub.approveLocal(input.nodeId, input.assignmentId, input.leaseId)
    }
    case '/mark-running': {
      const input = body as { nodeId: string; assignmentId: string; leaseId: string }
      return hub.markRunning(input.nodeId, input.assignmentId, input.leaseId)
    }
    case '/complete': {
      const input = body as { nodeId: string; assignmentId: string; leaseId: string; resultDigest: string }
      return hub.complete(input.nodeId, input.assignmentId, input.leaseId, input.resultDigest)
    }
    case '/fail': {
      const input = body as { nodeId: string; assignmentId: string; leaseId: string; reasonCode: string }
      return hub.fail(input.nodeId, input.assignmentId, input.leaseId, input.reasonCode)
    }
    case '/outcome-unknown': {
      const input = body as { nodeId: string; assignmentId: string; leaseId: string; reasonCode: string }
      return hub.outcomeUnknown(input.nodeId, input.assignmentId, input.leaseId, input.reasonCode)
    }
    case '/reconcile': {
      const input = body as { nodeId?: string; assignmentId: string }
      return hub.reconcile(input.assignmentId, input.nodeId)
    }
    case '/events':
      return { ok: true, events: hub.events() }
    default:
      return { ok: false, reasonCode: 'LAN_ROUTE_NOT_FOUND' }
  }
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) {
        reject(new BodyLimitError())
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', reject)
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new Error('LAN_JSON_INVALID')) }
    })
  })
}

function write(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function isFailure(value: unknown): value is { ok: false; reasonCode: string } {
  return typeof value === 'object' && value !== null && 'ok' in value && (value as { ok?: unknown }).ok === false
}

class BodyLimitError extends Error {}

function authorizeRequest(
  route: string,
  body: unknown,
  presented: string,
  authorization: { hubToken: string; nodeTokens: ReadonlyMap<string, string> },
): boolean {
  if (route === '/reconcile' && sameToken(presented, authorization.hubToken)) return true
  if (['/offer', '/events'].includes(route)) return sameToken(presented, authorization.hubToken)
  const input = body as { nodeId?: unknown; manifest?: { identity?: { nodeId?: unknown } } }
  const nodeId = typeof input.nodeId === 'string'
    ? input.nodeId
    : typeof input.manifest?.identity?.nodeId === 'string'
      ? input.manifest.identity.nodeId
      : ''
  const expected = authorization.nodeTokens.get(nodeId)
  return Boolean(expected && sameToken(presented, expected))
}

function bearerToken(request: IncomingMessage): string {
  const value = request.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : ''
}

function sameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function assertPrivateToken(token: string): void {
  if (token.length < 32 || /[\r\n\0]/.test(token)) throw new Error('LAN_PRIVATE_TOKEN_INVALID')
}
