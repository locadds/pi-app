export interface C2InstallDeepLinkV1 {
  installIntentId: string
  nonce: string
}

export type C2InstallDeepLinkConsumerV1 = (value: C2InstallDeepLinkV1) => void

const INSTALL_INTENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseC2InstallDeepLink(value: string): C2InstallDeepLinkV1 {
  const url = new URL(value)
  if (url.protocol !== 'xiaogui:' || url.hostname !== 'install' || url.hash) {
    throw new TypeError('unsupported C2 install deep link')
  }
  const installIntentId = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const nonceValues = url.searchParams.getAll('nonce')
  if (
    !INSTALL_INTENT_ID.test(installIntentId) ||
    nonceValues.length !== 1 ||
    nonceValues[0]!.trim().length === 0 ||
    [...url.searchParams.keys()].some((key) => key !== 'nonce')
  ) {
    throw new TypeError('invalid C2 install deep link')
  }
  return { installIntentId, nonce: nonceValues[0]! }
}

/**
 * Process-lifetime dispatcher used by both first-start argv and Electron's
 * second-instance callback. Links arriving before the C2 composition is ready
 * remain in memory and are drained in arrival order once a consumer attaches.
 */
export class C2InstallDeepLinkDispatcher {
  private readonly pending: C2InstallDeepLinkV1[] = []
  private consumer: C2InstallDeepLinkConsumerV1 | null = null

  setConsumer(consumer: C2InstallDeepLinkConsumerV1): void {
    this.consumer = consumer
    for (const value of this.pending.splice(0)) consumer(value)
  }

  acceptArgv(argv: readonly string[]): boolean {
    for (const argument of argv) {
      if (!argument.toLowerCase().startsWith('xiaogui://install/')) continue
      try {
        const parsed = parseC2InstallDeepLink(argument)
        if (this.consumer) this.consumer(parsed)
        else this.pending.push(parsed)
        return true
      } catch {
        return false
      }
    }
    return false
  }
}

export const c2InstallDeepLinkDispatcher = new C2InstallDeepLinkDispatcher()
