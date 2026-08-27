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
  const raw = parseRawOriginAuthority(value)
  if (!raw.ok) return raw
  if (!isRfc1918LiteralIpv4V1(raw.hostname)) {
    return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_HOST_INVALID' }
  }
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
    if (parsed.hostname !== raw.hostname || !isRfc1918LiteralIpv4V1(parsed.hostname)) {
      return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_HOST_INVALID' }
    }
    return { ok: true, origin: parsed.origin, protocol: parsed.protocol }
  } catch {
    return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_INVALID' }
  }
}

function parseRawOriginAuthority(value: string):
  | { ok: true; hostname: string }
  | { ok: false; reasonCode: 'LAN_HUB_ORIGIN_INVALID' | 'LAN_HUB_ORIGIN_HOST_INVALID' } {
  const match = /^(?:https?):\/\/([^/?#]+)\/?$/i.exec(value)
  if (!match) return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_INVALID' }
  const authority = match[1]
  if (authority.includes('@')) return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_INVALID' }
  const firstColon = authority.indexOf(':')
  const lastColon = authority.lastIndexOf(':')
  if (firstColon !== lastColon) return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_HOST_INVALID' }
  const hostname = firstColon < 0 ? authority : authority.slice(0, firstColon)
  const port = firstColon < 0 ? undefined : authority.slice(firstColon + 1)
  if (port !== undefined && (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535)) {
    return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_INVALID' }
  }
  const octets = hostname.split('.')
  if (
    octets.length !== 4
    || octets.some((octet) => !/^(?:0|[1-9][0-9]{0,2})$/.test(octet) || Number(octet) > 255)
  ) {
    return { ok: false, reasonCode: 'LAN_HUB_ORIGIN_HOST_INVALID' }
  }
  return { ok: true, hostname }
}
