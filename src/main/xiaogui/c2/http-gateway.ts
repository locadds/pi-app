import {
  C2_PACKAGE_LIMITS,
  parseC2ArtifactReceiptV1,
  parseC2InstallClaimV1,
  parseC2InstallIntentPreviewV1,
  type C2ArtifactReceiptV1,
  type C2InstallClaimV1,
  type C2InstallIntentPreviewV1,
} from '@shared/xiaogui-c2-artifact'
import type { HubTaskWorkerCredentialBundleV1 } from '../hub-task/worker-service'
import type { C2InstallDeepLinkV1 } from './deep-link-dispatcher'
import type { C2ArtifactGatewayV1 } from './install-coordinator'

export interface C2CredentialSourceV1 {
  read(): HubTaskWorkerCredentialBundleV1 | null
}

export class C2GatewayErrorV1 extends Error {
  constructor(readonly code: 'CREDENTIALS_UNAVAILABLE' | 'REQUEST_FAILED' | 'RESPONSE_INVALID') {
    super(code)
  }
}

/** All package bytes traverse the Hub ticket proxy; registryRef is never dereferenced. */
export class C2HubProxyGatewayV1 implements C2ArtifactGatewayV1 {
  constructor(
    private readonly credentials: C2CredentialSourceV1,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async preview(link: C2InstallDeepLinkV1): Promise<C2InstallIntentPreviewV1> {
    const payload = await this.requestJson(
      `/api/v2/install-intents/${encodeURIComponent(link.installIntentId)}/preview`,
      { method: 'GET' },
      'device',
    )
    return parseC2InstallIntentPreviewV1(payload)
  }

  async claim(link: C2InstallDeepLinkV1): Promise<C2InstallClaimV1> {
    const payload = await this.requestJson(
      `/api/v2/install-intents/${encodeURIComponent(link.installIntentId)}/claim`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: link.nonce }),
      },
      'both',
    )
    return parseC2InstallClaimV1(payload)
  }

  async download(ticket: string): Promise<Buffer> {
    const credentials = this.requireCredentials()
    let response: Response
    try {
      response = await this.fetchImpl(
        `${normalizeEndpoint(credentials.endpoint)}/api/v2/download-tickets/${encodeURIComponent(requireText(ticket))}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/zip',
            'x-xiaogui-device-token': credentials.node.deviceToken,
          },
          signal: AbortSignal.timeout(60_000),
        },
      )
    } catch {
      throw new C2GatewayErrorV1('REQUEST_FAILED')
    }
    if (!response.ok) throw new C2GatewayErrorV1('REQUEST_FAILED')
    const length = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(length) && length > C2_PACKAGE_LIMITS.maxPackageBytes) {
      throw new C2GatewayErrorV1('RESPONSE_INVALID')
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > C2_PACKAGE_LIMITS.maxPackageBytes) {
      throw new C2GatewayErrorV1('RESPONSE_INVALID')
    }
    return bytes
  }

  async cancel(installIntentId: string): Promise<void> {
    await this.requestJson(
      `/api/v2/install-intents/${encodeURIComponent(requireText(installIntentId))}/cancel`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      'bearer',
    )
  }

  async submitReceipt(receipt: C2ArtifactReceiptV1): Promise<unknown> {
    return this.requestJson(
      '/api/v2/receipts',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parseC2ArtifactReceiptV1(receipt)),
      },
      'device',
    )
  }

  private async requestJson(
    path: string,
    init: RequestInit,
    authorization: 'bearer' | 'device' | 'both',
  ): Promise<unknown> {
    const credentials = this.requireCredentials()
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    }
    if (authorization === 'bearer' || authorization === 'both') headers.authorization = `Bearer ${credentials.accessToken}`
    if (authorization === 'device' || authorization === 'both') headers['x-xiaogui-device-token'] = credentials.node.deviceToken
    let response: Response
    try {
      response = await this.fetchImpl(`${normalizeEndpoint(credentials.endpoint)}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new C2GatewayErrorV1('REQUEST_FAILED')
    }
    if (!response.ok) throw new C2GatewayErrorV1('REQUEST_FAILED')
    try {
      return await response.json()
    } catch {
      throw new C2GatewayErrorV1('RESPONSE_INVALID')
    }
  }

  private requireCredentials(): HubTaskWorkerCredentialBundleV1 {
    const credentials = this.credentials.read()
    if (!credentials) throw new C2GatewayErrorV1('CREDENTIALS_UNAVAILABLE')
    return credentials
  }
}

function normalizeEndpoint(value: string): string {
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid')
    }
    return url.origin
  } catch {
    throw new C2GatewayErrorV1('CREDENTIALS_UNAVAILABLE')
  }
}

function requireText(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new C2GatewayErrorV1('REQUEST_FAILED')
  return value
}
