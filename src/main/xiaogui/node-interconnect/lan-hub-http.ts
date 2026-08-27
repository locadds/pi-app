import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import {
  validateXiaoguiNodePublicDtoV1,
  type XiaoguiAssignmentPayloadRefV1,
  type XiaoguiNodeCapabilityManifestV1,
  type XiaoguiNodeCapabilityV1,
  type XiaoguiNodeDataEgressPolicyV1,
  type XiaoguiNodeHealthV1,
  type XiaoguiNodePortV1,
} from '@shared/xiaogui-node-contract'
import {
  hasOnlyLanKeysV1 as hasOnlyKeys,
  isLanDataEgressPolicyV1 as isDataEgressPolicy,
  isLanDigestV1 as isDigest,
  isLanHealthV1 as isHealth,
  isLanNodeIdV1 as isNodeId,
  isLanOpaqueIdV1 as isOpaqueId,
  isLanReasonCodeV1 as isReasonCode,
  isLanRecordV1 as isRecord,
  parseXiaoguiLanAssignmentPayloadRefV1 as parsePayloadRef,
  parseXiaoguiLanCapabilitiesV1 as parseCapabilities,
  parseXiaoguiLanEnvelopeResponseV1 as parseEnvelopeResponse,
  parseXiaoguiLanEventsResponseV1 as parseEventsResponse,
  parseXiaoguiLanNodeManifestV1,
  parseXiaoguiLanReconcileResponseV1 as parseReconcileResponse,
  parseXiaoguiLanSimpleResponseV1 as parseSimpleResponse,
} from './lan-contract-shapes'
import { isRfc1918LiteralIpv4V1 } from './lan-network-policy'

const ROUTES = new Set([
  '/register',
  '/heartbeat',
  '/offer',
  '/claim',
  '/approve-local',
  '/mark-running',
  '/complete',
  '/fail',
  '/outcome-unknown',
  '/reconcile',
  '/events',
])

type LanRouteRequestV1 =
  | { route: '/register'; nodeId: string; manifest: XiaoguiNodeCapabilityManifestV1 }
  | { route: '/heartbeat'; nodeId: string; health: XiaoguiNodeHealthV1 }
  | {
      route: '/offer'
      taskId: string
      requiredCapabilities: XiaoguiNodeCapabilityV1[]
      dataEgressPolicy: XiaoguiNodeDataEgressPolicyV1
      payloadRef: XiaoguiAssignmentPayloadRefV1
    }
  | { route: '/claim'; nodeId: string }
  | { route: '/approve-local' | '/mark-running'; nodeId: string; assignmentId: string; leaseId: string }
  | { route: '/complete'; nodeId: string; assignmentId: string; leaseId: string; resultDigest: string }
  | { route: '/fail' | '/outcome-unknown'; nodeId: string; assignmentId: string; leaseId: string; reasonCode: string }
  | { route: '/reconcile'; assignmentId: string; nodeId?: string }
  | { route: '/events' }

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
    trustedManifests: ReadonlyMap<string, XiaoguiNodeCapabilityManifestV1>
  }
  port?: number
  bindHost?: string
  exposureMode?: 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT'
}): Promise<XiaoguiLanHubHttpServerV1> {
  assertAuthorization(options.authorization)
  const bindHost = options.bindHost ?? ''
  if (!isRfc1918LiteralIpv4V1(bindHost)) throw new Error('LAN_HUB_BIND_HOST_INVALID')
  if (options.exposureMode !== 'EXPLICIT_INTERFACE_TOKEN_AUTHENTICATED_HTTP_PILOT') {
    throw new Error('LAN_HUB_EXPOSURE_NOT_APPROVED')
  }
  const server = createServer(async (request, response) => {
    try {
      if (!request.url || request.method !== 'POST' || !ROUTES.has(request.url)) {
        return write(response, 404, { ok: false, reasonCode: 'LAN_ROUTE_NOT_FOUND' })
      }
      const contentType = request.headers['content-type']
      if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
        return write(response, 415, { ok: false, reasonCode: 'LAN_CONTENT_TYPE_INVALID' })
      }
      const body = await readJson(request)
      if (!validateXiaoguiNodePublicDtoV1(body).ok) {
        return write(response, 400, { ok: false, reasonCode: 'NODE_PUBLIC_DTO_LEAK' })
      }
      const parsed = parseRouteRequest(request.url, body)
      if (!parsed.ok) return write(response, 400, parsed)
      if (!authorizeRequest(parsed.request, bearerToken(request), options.authorization)) {
        return write(response, 401, { ok: false, reasonCode: 'LAN_NODE_UNAUTHORIZED' })
      }
      const result = await route(parsed.request, options.hub)
      if (!validateXiaoguiNodePublicDtoV1(result).ok) {
        return write(response, 500, { ok: false, reasonCode: 'NODE_PUBLIC_DTO_LEAK' })
      }
      const validatedResult = parseRouteResponse(parsed.request, result)
      if (!validatedResult) {
        return write(response, 500, { ok: false, reasonCode: 'LAN_HUB_RESPONSE_INVALID' })
      }
      return write(response, isFailure(validatedResult) ? 409 : 200, validatedResult)
    } catch (error) {
      if (error instanceof BodyLimitError) {
        return write(response, 413, { ok: false, reasonCode: 'LAN_BODY_TOO_LARGE' })
      }
      if (error instanceof JsonBodyError) {
        return write(response, 400, { ok: false, reasonCode: 'LAN_JSON_INVALID' })
      }
      return write(response, 500, { ok: false, reasonCode: 'LAN_HUB_INTERNAL' })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, bindHost, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('LAN_HUB_LISTEN_FAILED')
  return {
    port: address.port,
    origin: `http://${bindHost}:${address.port}`,
    close: () => closeServer(server),
  }
}

function parseRouteResponse(request: LanRouteRequestV1, value: unknown): unknown | null {
  switch (request.route) {
    case '/offer':
      return parseEnvelopeResponse(value)
    case '/claim':
      return parseEnvelopeResponse(value, { expectedNodeId: request.nodeId })
    case '/reconcile':
      return parseReconcileResponse(value)
    case '/events':
      return parseEventsResponse(value)
    default:
      return parseSimpleResponse(value)
  }
}

async function route(request: LanRouteRequestV1, hub: XiaoguiNodePortV1): Promise<unknown> {
  switch (request.route) {
    case '/register':
      return hub.register(request.manifest)
    case '/heartbeat':
      return hub.heartbeat(request.nodeId, request.health)
    case '/offer':
      return hub.offer({
        taskId: request.taskId,
        requiredCapabilities: request.requiredCapabilities,
        dataEgressPolicy: request.dataEgressPolicy,
        payloadRef: request.payloadRef,
      })
    case '/claim':
      return hub.claim(request.nodeId)
    case '/approve-local':
      return hub.approveLocal(request.nodeId, request.assignmentId, request.leaseId)
    case '/mark-running':
      return hub.markRunning(request.nodeId, request.assignmentId, request.leaseId)
    case '/complete':
      return hub.complete(request.nodeId, request.assignmentId, request.leaseId, request.resultDigest)
    case '/fail':
      return hub.fail(request.nodeId, request.assignmentId, request.leaseId, request.reasonCode)
    case '/outcome-unknown':
      return hub.outcomeUnknown(request.nodeId, request.assignmentId, request.leaseId, request.reasonCode)
    case '/reconcile':
      return hub.reconcile(request.assignmentId, request.nodeId)
    case '/events':
      return { ok: true, events: hub.events() }
  }
}

function parseRouteRequest(routeName: string, body: unknown):
  | { ok: true; request: LanRouteRequestV1 }
  | { ok: false; reasonCode: 'LAN_REQUEST_INVALID' } {
  if (!isRecord(body)) return invalidRequest()
  switch (routeName) {
    case '/register': {
      if (!hasOnlyKeys(body, ['manifest'])) return invalidRequest()
      const manifest = parseXiaoguiLanNodeManifestV1(body.manifest)
      return manifest
        ? { ok: true, request: { route: '/register', nodeId: String(manifest.identity.nodeId), manifest } }
        : invalidRequest()
    }
    case '/heartbeat': {
      if (!hasOnlyKeys(body, ['nodeId', 'health']) || !isNodeId(body.nodeId) || !isHealth(body.health)) return invalidRequest()
      return { ok: true, request: { route: '/heartbeat', nodeId: body.nodeId, health: body.health } }
    }
    case '/offer': {
      if (!hasOnlyKeys(body, ['taskId', 'requiredCapabilities', 'dataEgressPolicy', 'payloadRef'])) return invalidRequest()
      const requiredCapabilities = parseCapabilities(body.requiredCapabilities)
      const payloadRef = parsePayloadRef(body.payloadRef)
      if (!isOpaqueId(body.taskId) || !requiredCapabilities || !isDataEgressPolicy(body.dataEgressPolicy) || !payloadRef) {
        return invalidRequest()
      }
      return {
        ok: true,
        request: {
          route: '/offer',
          taskId: body.taskId,
          requiredCapabilities,
          dataEgressPolicy: body.dataEgressPolicy,
          payloadRef,
        },
      }
    }
    case '/claim':
      return hasOnlyKeys(body, ['nodeId']) && isNodeId(body.nodeId)
        ? { ok: true, request: { route: '/claim', nodeId: body.nodeId } }
        : invalidRequest()
    case '/approve-local':
    case '/mark-running':
      return hasOnlyKeys(body, ['nodeId', 'assignmentId', 'leaseId'])
        && isNodeId(body.nodeId)
        && isOpaqueId(body.assignmentId)
        && isOpaqueId(body.leaseId)
        ? { ok: true, request: { route: routeName, nodeId: body.nodeId, assignmentId: body.assignmentId, leaseId: body.leaseId } }
        : invalidRequest()
    case '/complete':
      return hasOnlyKeys(body, ['nodeId', 'assignmentId', 'leaseId', 'resultDigest'])
        && isNodeId(body.nodeId)
        && isOpaqueId(body.assignmentId)
        && isOpaqueId(body.leaseId)
        && isDigest(body.resultDigest)
        ? { ok: true, request: { route: '/complete', nodeId: body.nodeId, assignmentId: body.assignmentId, leaseId: body.leaseId, resultDigest: body.resultDigest } }
        : invalidRequest()
    case '/fail':
    case '/outcome-unknown':
      return hasOnlyKeys(body, ['nodeId', 'assignmentId', 'leaseId', 'reasonCode'])
        && isNodeId(body.nodeId)
        && isOpaqueId(body.assignmentId)
        && isOpaqueId(body.leaseId)
        && isReasonCode(body.reasonCode)
        ? { ok: true, request: { route: routeName, nodeId: body.nodeId, assignmentId: body.assignmentId, leaseId: body.leaseId, reasonCode: body.reasonCode } }
        : invalidRequest()
    case '/reconcile':
      return hasOnlyKeys(body, ['assignmentId', 'nodeId'])
        && isOpaqueId(body.assignmentId)
        && (body.nodeId === undefined || isNodeId(body.nodeId))
        ? { ok: true, request: { route: '/reconcile', assignmentId: body.assignmentId, ...(body.nodeId ? { nodeId: body.nodeId } : {}) } }
        : invalidRequest()
    case '/events':
      return hasOnlyKeys(body, []) ? { ok: true, request: { route: '/events' } } : invalidRequest()
    default:
      return invalidRequest()
  }
}

function authorizeRequest(
  request: LanRouteRequestV1,
  presented: string,
  authorization: {
    hubToken: string
    nodeTokens: ReadonlyMap<string, string>
    trustedManifests: ReadonlyMap<string, XiaoguiNodeCapabilityManifestV1>
  },
): boolean {
  if (request.route === '/offer' || request.route === '/events') {
    return sameToken(presented, authorization.hubToken)
  }
  if (request.route === '/reconcile' && !request.nodeId) {
    return sameToken(presented, authorization.hubToken)
  }
  const nodeId = request.nodeId
  if (!nodeId) return false
  const expected = authorization.nodeTokens.get(nodeId)
  return Boolean(expected && sameToken(presented, expected))
}

function assertAuthorization(authorization: {
  hubToken: string
  nodeTokens: ReadonlyMap<string, string>
  trustedManifests: ReadonlyMap<string, XiaoguiNodeCapabilityManifestV1>
}): void {
  assertPrivateToken(authorization.hubToken)
  if (!authorization.nodeTokens.size || authorization.nodeTokens.size !== authorization.trustedManifests.size) {
    throw new Error('LAN_NODE_IDENTITY_BINDING_INVALID')
  }
  const tokens = new Set<string>([authorization.hubToken])
  for (const [nodeId, token] of authorization.nodeTokens) {
    assertPrivateToken(token)
    const manifest = authorization.trustedManifests.get(nodeId)
    const parsedManifest = parseXiaoguiLanNodeManifestV1(manifest)
    if (
      tokens.has(token)
      || !parsedManifest
      || String(parsedManifest.identity.nodeId) !== nodeId
      || !validateXiaoguiNodePublicDtoV1(parsedManifest).ok
    ) {
      throw new Error('LAN_NODE_IDENTITY_BINDING_INVALID')
    }
    tokens.add(token)
  }
  for (const nodeId of authorization.trustedManifests.keys()) {
    if (!authorization.nodeTokens.has(nodeId)) throw new Error('LAN_NODE_IDENTITY_BINDING_INVALID')
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
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new JsonBodyError())
      }
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
  if (token.length < 32 || token !== token.trim() || /[\r\n\0]/.test(token)) {
    throw new Error('LAN_PRIVATE_TOKEN_INVALID')
  }
}

function isFailure(value: unknown): value is { ok: false; reasonCode: string } {
  return isRecord(value) && value.ok === false && typeof value.reasonCode === 'string'
}

function invalidRequest(): { ok: false; reasonCode: 'LAN_REQUEST_INVALID' } {
  return { ok: false, reasonCode: 'LAN_REQUEST_INVALID' }
}

class BodyLimitError extends Error {}
class JsonBodyError extends Error {}
