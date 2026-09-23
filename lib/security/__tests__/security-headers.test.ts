import { describe, expect, it } from 'vitest'
import nextConfig from '../../../next.config'
import { buildContentSecurityPolicy } from '../../../proxy'

describe('security headers', () => {
  it('protects every route with baseline non-CSP headers', async () => {
    const rules = await nextConfig.headers?.()
    const headers = new Map(rules?.[0]?.headers.map(({ key, value }) => [key, value]))

    expect(rules?.[0]?.source).toBe('/:path*')
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('X-Frame-Options')).toBe('DENY')
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })

  it('uses a nonce CSP that permits development hydration only in development', () => {
    const developmentPolicy = buildContentSecurityPolicy('test-nonce', true)
    const productionPolicy = buildContentSecurityPolicy('test-nonce', false)

    expect(developmentPolicy).toContain("'nonce-test-nonce'")
    expect(developmentPolicy).toContain("'unsafe-eval'")
    expect(developmentPolicy).toContain("style-src 'self' 'unsafe-inline'")
    expect(productionPolicy).not.toContain("'unsafe-eval'")
    expect(productionPolicy).not.toContain("'unsafe-inline'")
    expect(productionPolicy).toContain("frame-ancestors 'none'")
    expect(productionPolicy).toContain("object-src 'none'")
  })
})
