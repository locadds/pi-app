import type {
  OfficeSnapshotV1,
  OfficeSurfaceParentMessageV1,
  OfficeSurfaceViewerMessageV1,
} from '../../../packages/shared/xiaogui-office-surface'
import type { OfficeParentBridgeV1 } from './parent-bridge'

export interface OfficeGatewaySnapshotV1 {
  readonly headSha256: string
  readonly snapshot: OfficeSnapshotV1
}

export class OfficeGatewayClientV1 {
  private headSha256 = ''

  constructor(private readonly parentBridge: OfficeParentBridgeV1 | null) {}

  async load(): Promise<OfficeGatewaySnapshotV1> {
    const response = await this.request({ type: 'VIEWER_GATEWAY_READ_REQUEST' })
    if (!response.ok) throw gatewayFailure(response)
    const envelope = {
      headSha256: response.headSha256,
      snapshot: response.snapshot,
    }
    if (!isSnapshotEnvelope(envelope)) throw new Error('本机文档网关返回了无效快照。')
    this.headSha256 = envelope.headSha256
    return envelope
  }

  async save(snapshot: OfficeSnapshotV1): Promise<string> {
    if (!this.headSha256) throw new Error('尚未载入文档工作副本。')
    const response = await this.request({
      type: 'VIEWER_GATEWAY_WRITE_REQUEST',
      expectedHeadSha256: this.headSha256,
      snapshot,
    })
    if (!response.ok) throw gatewayFailure(response)
    this.headSha256 = response.headSha256
    return this.headSha256
  }

  getHeadSha256(): string {
    return this.headSha256
  }

  private async request(
    request: GatewayRequestPayloadV1,
  ): Promise<Extract<OfficeSurfaceParentMessageV1, { type: 'PARENT_GATEWAY_RESPONSE' }>> {
    if (!this.parentBridge) throw new Error('文档工作副本代理不可用。')
    await this.parentBridge.waitForConnection()
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {}
      const timer = window.setTimeout(() => {
        unsubscribe()
        reject(new Error('读取或保存文档工作副本超时。'))
      }, 15_000)
      unsubscribe = this.parentBridge!.subscribe((message) => {
        if (message.type !== 'PARENT_GATEWAY_RESPONSE' || message.requestId !== requestId) return
        window.clearTimeout(timer)
        unsubscribe()
        resolve(message)
      })
      this.parentBridge!.post({ ...request, requestId })
    })
  }
}

type GatewayRequestPayloadV1 = OfficeSurfaceViewerMessageV1 extends infer Message
  ? Message extends { type: 'VIEWER_GATEWAY_READ_REQUEST' | 'VIEWER_GATEWAY_WRITE_REQUEST' }
    ? Omit<Message, 'protocol' | 'channelNonce' | 'requestId'>
    : never
  : never

function gatewayFailure(
  response: Extract<OfficeSurfaceParentMessageV1, { type: 'PARENT_GATEWAY_RESPONSE'; ok: false }>,
): Error {
  if (response.errorCode === 'OFFICE_WORKTREE_CONFLICT') {
    return new Error('文档工作副本已经变化，请重新载入。')
  }
  return new Error(response.message)
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
