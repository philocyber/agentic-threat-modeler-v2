/**
 * Webhook URL SSRF checks.
 * Validates protocol, blocks private/link-local/metadata ranges, and re-checks after DNS resolve.
 */

import { lookup } from 'dns/promises'
import { isIP } from 'net'

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google',
])

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  return (
    (n >= ipv4ToInt('10.0.0.0') && n <= ipv4ToInt('10.255.255.255')) ||
    (n >= ipv4ToInt('127.0.0.0') && n <= ipv4ToInt('127.255.255.255')) ||
    (n >= ipv4ToInt('169.254.0.0') && n <= ipv4ToInt('169.254.255.255')) ||
    (n >= ipv4ToInt('172.16.0.0') && n <= ipv4ToInt('172.31.255.255')) ||
    (n >= ipv4ToInt('192.168.0.0') && n <= ipv4ToInt('192.168.255.255')) ||
    (n >= ipv4ToInt('0.0.0.0') && n <= ipv4ToInt('0.255.255.255')) ||
    // RFC 6598 shared/CGNAT address space
    (n >= ipv4ToInt('100.64.0.0') && n <= ipv4ToInt('100.127.255.255')) ||
    // Broadcast / limited broadcast
    n === ipv4ToInt('255.255.255.255') ||
    // Multicast 224.0.0.0/4
    (n >= ipv4ToInt('224.0.0.0') && n <= ipv4ToInt('239.255.255.255')) ||
    // IETF protocol assignments 192.0.0.0/24
    (n >= ipv4ToInt('192.0.0.0') && n <= ipv4ToInt('192.0.0.255')) ||
    // Benchmarking 198.18.0.0/15
    (n >= ipv4ToInt('198.18.0.0') && n <= ipv4ToInt('198.19.255.255')) ||
    // Reserved for future use 240.0.0.0/4 (excludes 255.255.255.255, already blocked)
    (n >= ipv4ToInt('240.0.0.0') && n <= ipv4ToInt('255.255.255.254'))
  )
}

// fe80::/10 fixes only the top 10 bits, so the second hex group ranges
// 0x80-0xBF (fe80.. through febf..) — not just the literal "fe80" prefix.
const IPV6_LINK_LOCAL_RE = /^fe[89ab][0-9a-f]:/

// NAT64 well-known prefix (RFC 6052): the low 32 bits carry an embedded IPv4.
const NAT64_PREFIX_RE = /^64:ff9b:/

/** Expand an IPv6 address into eight 16-bit hex groups (lowercase, zero-padded). */
function expandIPv6Groups(ip: string): string[] | null {
  const lower = ip.toLowerCase()
  if (lower.includes('.')) {
    // Embedded IPv4 dotted-quad in the last group — convert to two hex groups first.
    const lastColon = lower.lastIndexOf(':')
    const v4 = lower.slice(lastColon + 1)
    if (isIP(v4) !== 4) return null
    const octets = v4.split('.').map(Number)
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16)
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16)
    return expandIPv6Groups(`${lower.slice(0, lastColon)}:${hi}:${lo}`)
  }

  const [head, tail] = lower.split('::')
  const headGroups = head ? head.split(':').filter(Boolean) : []
  const tailGroups = tail !== undefined && tail !== '' ? tail.split(':').filter(Boolean) : []
  if (lower.includes('::')) {
    const missing = 8 - headGroups.length - tailGroups.length
    if (missing < 0) return null
    const groups = [...headGroups, ...Array(missing).fill('0'), ...tailGroups]
    if (groups.length !== 8) return null
    return groups.map((g) => g.padStart(4, '0'))
  }

  const groups = lower.split(':')
  if (groups.length !== 8) return null
  return groups.map((g) => g.padStart(4, '0'))
}

function groupsToIPv4(hi: string, lo: string): string | null {
  const h = parseInt(hi, 16)
  const l = parseInt(lo, 16)
  if (Number.isNaN(h) || Number.isNaN(l)) return null
  const candidate = `${(h >> 8) & 0xff}.${h & 0xff}.${(l >> 8) & 0xff}.${l & 0xff}`
  return isIP(candidate) === 4 ? candidate : null
}

/**
 * Extract an embedded IPv4 from common IPv6 transition forms:
 * - IPv4-mapped (::ffff:a.b.c.d / ::ffff:AABB:CCDD)
 * - IPv4-compatible (::a.b.c.d / ::AABB:CCDD) — deprecated but still routed on some stacks
 * - NAT64 well-known prefix (64:ff9b::/96)
 * - 6to4 (2002:AABB:CCDD::/48)
 */
function unwrapEmbeddedIPv4(ip: string): string | null {
  const groups = expandIPv6Groups(ip)
  if (!groups) return null

  // ::ffff:x.x.x.x  → groups[0..4]=0, groups[5]=ffff
  if (
    groups.slice(0, 5).every((g) => g === '0000') &&
    groups[5] === 'ffff'
  ) {
    return groupsToIPv4(groups[6]!, groups[7]!)
  }

  // IPv4-compatible ::x.x.x.x (not ::1 / ::) — groups[0..5]=0
  if (groups.slice(0, 6).every((g) => g === '0000')) {
    const embedded = groupsToIPv4(groups[6]!, groups[7]!)
    if (embedded && embedded !== '0.0.0.0') return embedded
  }

  // NAT64 64:ff9b::/96
  if (groups[0] === '0064' && groups[1] === 'ff9b' && groups.slice(2, 6).every((g) => g === '0000')) {
    return groupsToIPv4(groups[6]!, groups[7]!)
  }
  // Also accept compressed forms detected via prefix regex when expand missed edge cases
  const lower = ip.toLowerCase()
  if (NAT64_PREFIX_RE.test(lower.replace(/::+/, '::'))) {
    // fall through — expandIPv6Groups already handled the common case
  }

  // 6to4 2002:AABB:CCDD::/48 — next 32 bits after 2002 are the IPv4
  if (groups[0] === '2002') {
    return groupsToIPv4(groups[1]!, groups[2]!)
  }

  return null
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase()
  const groups = expandIPv6Groups(normalized)

  if (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    IPV6_LINK_LOCAL_RE.test(normalized) ||
    normalized.startsWith('::ffff:')
  ) {
    return true
  }

  // IPv6 multicast ff00::/8
  if (normalized.startsWith('ff')) return true

  // Deprecated site-local fec0::/10
  if (groups) {
    const first = parseInt(groups[0]!, 16)
    if ((first & 0xffc0) === 0xfec0) return true
  } else if (/^fec[0-9a-f]:/i.test(normalized) || /^fe[de][0-9a-f]:/i.test(normalized)) {
    return true
  }

  return false
}

export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isPrivateIPv4(ip)
  if (version === 6) {
    const embedded = unwrapEmbeddedIPv4(ip)
    if (embedded && isPrivateIPv4(embedded)) return true
    return isPrivateIPv6(ip)
  }
  return true
}

export type WebhookValidationResult =
  | { ok: true; url: URL }
  | { ok: false; error: string }

export type ResolvedWebhookUrl =
  | { ok: true; url: URL; address: string; family: 4 | 6 }
  | { ok: false; error: string }

/**
 * Synchronous structural validation (protocol + literal IP / hostname denylist).
 * Call `assertSafeWebhookUrl` before delivery for DNS rebinding defense.
 */
export function validateWebhookUrlStructure(raw: string): WebhookValidationResult {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'webhookUrl is not a valid URL' }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, error: 'webhookUrl must use https' }
  }

  // Reject credentials in the URL (would be sent as HTTP Basic and persisted in DB).
  if (url.username || url.password) {
    return { ok: false, error: 'webhookUrl must not include username or password' }
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    return { ok: false, error: 'webhookUrl cannot point to private network' }
  }

  if (isIP(hostname) && isBlockedIp(hostname)) {
    return { ok: false, error: 'webhookUrl cannot point to private network' }
  }

  return { ok: true, url }
}

/**
 * Full validation including DNS resolution (use at delivery time).
 */
export async function assertSafeWebhookUrl(raw: string): Promise<WebhookValidationResult> {
  const resolved = await resolveSafeWebhookUrl(raw)
  if (!resolved.ok) return resolved
  return { ok: true, url: resolved.url }
}

/**
 * Resolves a webhook once and returns the public address to pin for the request.
 * The caller must use this address in its connection lookup to avoid DNS rebinding.
 */
export async function resolveSafeWebhookUrl(raw: string): Promise<ResolvedWebhookUrl> {
  const structural = validateWebhookUrlStructure(raw)
  if (!structural.ok) return structural

  const hostname = structural.url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(hostname)) {
    const family = isIP(hostname)
    return { ok: true, url: structural.url, address: hostname, family: family as 4 | 6 }
  }

  try {
    const results = await lookup(hostname, { all: true, verbatim: true })
    if (results.length === 0) {
      return { ok: false, error: 'webhookUrl hostname could not be resolved' }
    }
    for (const { address } of results) {
      if (isBlockedIp(address)) {
        return { ok: false, error: 'webhookUrl resolves to a private network address' }
      }
    }

    const selected = results[0]
    if (!selected) {
      return { ok: false, error: 'webhookUrl hostname could not be resolved' }
    }
    return {
      ok: true,
      url: structural.url,
      address: selected.address,
      family: selected.family as 4 | 6,
    }
  } catch {
    return { ok: false, error: 'webhookUrl hostname could not be resolved' }
  }
}
