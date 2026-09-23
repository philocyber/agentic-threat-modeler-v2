import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { clientIpFromRequest, checkRateLimit, _clearRateLimitBuckets } from '@/lib/utils/rate-limit'
import { signWebhookBody, verifyWebhookSignature } from '@/lib/webhooks/sign'
import { redactEnvironmentVars, redactSecretsInText, toPublicErrorMessage } from '@/lib/utils/redact'

describe('clientIpFromRequest', () => {
  const prev = process.env.TRUSTED_PROXY_HOPS

  afterEach(() => {
    if (prev === undefined) delete process.env.TRUSTED_PROXY_HOPS
    else process.env.TRUSTED_PROXY_HOPS = prev
  })

  it('ignores client-controlled forwarding headers when TRUSTED_PROXY_HOPS is unset/0', () => {
    delete process.env.TRUSTED_PROXY_HOPS
    const headers = new Headers({
      'x-forwarded-for': '1.2.3.4, 10.0.0.1',
      'x-real-ip': '9.9.9.9',
    })
    expect(clientIpFromRequest(headers)).toBe('unknown')
  })

  it('uses the trusted hop from the right when TRUSTED_PROXY_HOPS=1', () => {
    process.env.TRUSTED_PROXY_HOPS = '1'
    const headers = new Headers({
      'x-forwarded-for': '1.2.3.4, 203.0.113.9',
    })
    expect(clientIpFromRequest(headers)).toBe('203.0.113.9')
  })

  it('skips the closest proxy hop when TRUSTED_PROXY_HOPS=2', () => {
    process.env.TRUSTED_PROXY_HOPS = '2'
    const headers = new Headers({
      'x-forwarded-for': '1.2.3.4, 203.0.113.9, 10.0.0.5',
    })
    expect(clientIpFromRequest(headers)).toBe('203.0.113.9')
  })
})

describe('checkRateLimit', () => {
  beforeEach(() => _clearRateLimitBuckets())

  it('enforces a sliding window', () => {
    expect(checkRateLimit('t', 2, 60_000).allowed).toBe(true)
    expect(checkRateLimit('t', 2, 60_000).allowed).toBe(true)
    expect(checkRateLimit('t', 2, 60_000).allowed).toBe(false)
  })
})

describe('webhook HMAC', () => {
  it('round-trips signature verification', () => {
    const body = JSON.stringify({ analysisId: 'tm_1', status: 'completed' })
    const ts = '1710000000'
    const sig = signWebhookBody(body, 'super-secret', ts)
    expect(verifyWebhookSignature(body, 'super-secret', ts, sig)).toBe(true)
    expect(verifyWebhookSignature(body, 'wrong', ts, sig)).toBe(false)
  })
})

describe('redact helpers', () => {
  it('redacts sensitive environment vars', () => {
    const out = redactEnvironmentVars([
      { name: 'API_KEY', value: 'sk-live-abc', isSensitive: true, component: 'api' },
      { name: 'PUBLIC_URL', value: 'https://example.com', isSensitive: false, component: 'web' },
    ])
    expect(out[0]!.value).toBe('[REDACTED]')
    expect(out[1]!.value).toBe('https://example.com')
  })

  it('maps provider errors to stable public messages', () => {
    expect(toPublicErrorMessage(new Error('UnrecognizedClientException AKIA1234567890ABCDEF'))).toBe(
      'An unexpected error occurred'
    )
    const abort = new Error('Stopped by user')
    abort.name = 'AbortError'
    expect(toPublicErrorMessage(abort)).toBe('Stopped by user')
    const phaseTimeout = new Error('Phase private-system timed out after 900s')
    phaseTimeout.name = 'PhaseTimeoutError'
    expect(toPublicErrorMessage(phaseTimeout)).toBe(
      'An analysis phase exceeded its time budget. Review the phase workload and timeout configuration before resuming.',
    )
    expect(toPublicErrorMessage(new Error('Pipeline timed out after 600s (PhiloCyber)'))).toBe(
      'Pipeline timed out',
    )
    expect(
      toPublicErrorMessage(
        new Error('[ThreatSynthesizer] structured LLM call timed out after 12000ms'),
      ),
    ).toBe('The model call timed out')
  })

  it('redacts URI userinfo before it can reach a provider', () => {
    const redacted = redactSecretsInText(
      'DATABASE_URL=postgres://app:s3cret-pass@db.internal:5432/prod mongodb://user:hunter2@mongo.internal/app',
    )
    expect(redacted).not.toContain('s3cret-pass')
    expect(redacted).not.toContain('hunter2')
    expect(redacted).toContain('[REDACTED]')
  })
})
