import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Sign a webhook body with HMAC-SHA256.
 * Header format: `X-AgenticTM-Signature: sha256=<hex>`
 */
export function signWebhookBody(payload: string, secret: string, timestamp: string): string {
  const mac = createHmac('sha256', secret)
  mac.update(`${timestamp}.`)
  mac.update(payload)
  return `sha256=${mac.digest('hex')}`
}

/** Timing-safe verification helper for receivers (also used in tests). */
export function verifyWebhookSignature(
  payload: string,
  secret: string,
  timestamp: string,
  signatureHeader: string
): boolean {
  const expected = signWebhookBody(payload, secret, timestamp)
  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
