import { isIP } from 'node:net'

/**
 * Network exposure is intentionally narrower than "not public": only an
 * explicit RFC1918 IPv4 interface is eligible for the LAN pilot.
 */
export function isRfc1918LiteralIpv4V1(value: string): boolean {
  if (isIP(value) !== 4) return false
  const [first, second] = value.split('.').map(Number)
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

export function validateXiaoguiLanHubOriginV1(value: string):
  | { ok: true; origin: string; protocol: 'http:' | 'https:' }
  | { ok: false; reasonCode: 'LAN_HUB_ORIGIN_INVALID' | 'LAN_HUB_ORIGIN_HOST_INVALID' } {
  if (!value || value !== value.trim()) return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_INVALID' }
  try {
    const parsed = new URL(value)
    if (
      parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    ) {
      return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_INVALID' }
    }
    if (!isRfc1918LiteralIpv4V1(parsed.hostname)) {
      return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_HOST_INVALID' }
    }
    return { ok: true, origin: parsed.origin, protocol: parsed.protocol }
  } catch {
    return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_INVALID' }
  }
}
