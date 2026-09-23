import type { NextRequest } from 'next/server'

function isLoopback(hostname: string): boolean {
  // URL has already parsed/validated the address. All of 127/8 is loopback,
  // including the local browser proxy's 127.0.2.2 address.
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

/** Filesystem and process mutations are intentionally restricted to the local UI. */
export function isTrustedLocalMutation(request: NextRequest): boolean {
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  try {
    const protocol = request.nextUrl.protocol
    if (protocol !== 'http:' && protocol !== 'https:') return false
    // NextURL (and NextRequest.url) rewrites IPv4/IPv6 loopback hosts to
    // localhost and can use the server's bind address. Host retains the
    // browser-facing authority. Never substitute Origin or forwarded headers.
    // The fallback supports in-process requests without an HTTP Host header.
    const host = request.headers.get('host') ?? request.nextUrl.host
    if (!host || /[\s,/@\\?#]/.test(host)) return false
    const target = new URL(`${protocol}//${host}`)
    if (!isLoopback(target.hostname)) return false

    const origin = request.headers.get('origin')
    if (origin === null) return true // Direct local CLI clients omit Origin.
    const source = new URL(origin)
    return origin === source.origin && source.origin === target.origin
  } catch {
    return false
  }
}
