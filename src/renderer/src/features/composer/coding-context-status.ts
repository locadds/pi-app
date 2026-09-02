import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import type { AttachmentMeta } from './attachments'

export async function resolveCodingContextStatus(input: {
  readonly enabled: boolean
  readonly address: SessionAddressV1 | null
  readonly relativePath: string
}): Promise<Pick<AttachmentMeta, 'codingContextStatus' | 'codingContextSnapshotId'>> {
  if (!input.enabled) return {}
  // Full text is read only immediately before send, after the canonical Coding session exists.
  void input.address
  void input.relativePath
  return { codingContextStatus: 'PENDING_SESSION' }
}
