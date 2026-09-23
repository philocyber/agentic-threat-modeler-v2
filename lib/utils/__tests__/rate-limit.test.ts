import { describe, it, expect, beforeEach } from 'vitest'
import { checkRateLimit, _clearRateLimitBuckets } from '@/lib/utils/rate-limit'

describe('checkRateLimit', () => {
  beforeEach(() => {
    _clearRateLimitBuckets()
  })

  it('allows up to the limit then blocks', () => {
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit('t', 3, 60_000).allowed).toBe(true)
    }
    const blocked = checkRateLimit('t', 3, 60_000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('isolates keys', () => {
    expect(checkRateLimit('a', 1, 60_000).allowed).toBe(true)
    expect(checkRateLimit('a', 1, 60_000).allowed).toBe(false)
    expect(checkRateLimit('b', 1, 60_000).allowed).toBe(true)
  })
})
