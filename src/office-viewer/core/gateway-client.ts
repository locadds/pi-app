import type { OfficeSnapshotV1 } from '../../../packages/shared/xiaogui-office-surface'

export interface OfficeGatewaySnapshotV1 {
  readonly headSha256: string
  readonly snapshot: OfficeSnapshotV1
}

export class OfficeGatewayClientV1 {
  private headSha256 = ''
  private accessToken = ''

  authorize(accessToken: string): void {
    if (accessToken.length < 32 || accessToken.length > 512) throw new Error('文档工作副本授权无效。')
    this.accessToken = accessToken
  }

  async load(): Promise<OfficeGatewaySnapshotV1> {
    const response = await fetch('/api/v1/snapshot', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: this.authorizationHeaders(),
    })
    if (!response.ok) throw new Error(`读取文档工作副本失败（${response.status}）。`)
    const envelope = await response.json() as OfficeGatewaySnapshotV1
    if (!isSnapshotEnvelope(envelope)) throw new Error('本机文档网关返回了无效快照。')
    this.headSha256 = envelope.headSha256
    return envelope
  }

  async save(snapshot: OfficeSnapshotV1): Promise<string> {
    if (!this.headSha256) throw new Error('尚未载入文档工作副本。')
    const response = await fetch('/api/v1/snapshot', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { ...this.authorizationHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedHeadSha256: this.headSha256, snapshot }),
    })
    if (response.status === 409) throw new Error('文档工作副本已经变化，请重新载入。')
    if (!response.ok) throw new Error(`保存文档工作副本失败（${response.status}）。`)
    const result = await response.json() as { headSha256?: unknown }
    if (typeof result.headSha256 !== 'string') throw new Error('本机文档网关没有返回新版本摘要。')
    this.headSha256 = result.headSha256
    return this.headSha256
  }

  getHeadSha256(): string {
    return this.headSha256
  }

  private authorizationHeaders(): Record<string, string> {
    return this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}
  }
}

function isSnapshotEnvelope(value: unknown): value is OfficeGatewaySnapshotV1 {
  if (!value || typeof value !== 'object') return false
  const envelope = value as Record<string, unknown>
  return typeof envelope.headSha256 === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(envelope.headSha256)
    && Boolean(envelope.snapshot)
    && typeof envelope.snapshot === 'object'
    && !Array.isArray(envelope.snapshot)
}
