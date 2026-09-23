/**
 * Simple in-memory sliding-window rate limiter (per process).
 * Suitable for single-instance / local deployments.
 * For multi-instance production, enforce limits at the edge or use a shared store.
 */

type Bucket = { timestamps: number[]; lastSeen: number }

const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 10_000

function evictBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.timestamps.length === 0 || now - bucket.lastSeen > 60 * 60 * 1000) buckets.delete(key)
  }
  while (buckets.size >= MAX_BUCKETS) {
    let oldestKey: string | undefined
    let oldest = Number.POSITIVE_INFINITY
    for (const [key, bucket] of buckets) {
      if (bucket.lastSeen < oldest) {
        oldest = bucket.lastSeen
        oldestKey = key
      }
    }
    if (!oldestKey) break
    buckets.delete(oldestKey)
  }
}

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now()
  if (!buckets.has(key)) evictBuckets(now)
  const bucket = buckets.get(key) ?? { timestamps: [], lastSeen: now }
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs)
  bucket.lastSeen = now

  if (bucket.timestamps.length >= limit) {
    buckets.set(key, bucket)
    const oldest = bucket.timestamps[0] ?? now
    const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000))
    return { allowed: false, remaining: 0, retryAfterSeconds }
  }

  bucket.timestamps.push(now)
  buckets.set(key, bucket)
  return {
    allowed: true,
    remaining: Math.max(0, limit - bucket.timestamps.length),
    retryAfterSeconds: 0,
  }
}

export function rateLimitSubject(headers: Headers, actorId?: string): string {
  return actorId ? `actor:${actorId}` : `ip:${clientIpFromRequest(headers)}`
}

/**
 * Resolve client IP for rate limiting.
 *
 * Forwarding headers are client-controlled unless a trusted proxy overwrites
 * them. `X-Forwarded-For` is used only when `TRUSTED_PROXY_HOPS` > 0 (count of
 * reverse proxies; address that many entries from the right). `X-Real-IP` is
 * never used. Without trusted hops, callers share the `unknown` bucket.
 */
export function clientIpFromRequest(headers: Headers): string {
  const hops = Math.max(0, Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '0', 10) || 0)
  if (hops <= 0) return 'unknown'

  const forwarded = headers.get('x-forwarded-for')
  if (!forwarded) return 'unknown'

  const parts = forwarded
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return 'unknown'
  const idx = Math.max(0, parts.length - hops)
  return parts[idx]!
}

/** Test helper */
export function _clearRateLimitBuckets(): void {
  buckets.clear()
}
