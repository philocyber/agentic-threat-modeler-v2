import { classifyFailure, isRetryableFailure } from '@/lib/llm/failure-class'

export type RetryErrorClass =
  | 'validation'   // StructuredOutputError — retry with Zod issues fed back into the prompt
  | 'truncation'   // model hit its output ceiling — retry only with a smaller ask
  | 'timeout'      // per-call LLM timeout — simple retry
  | 'rate_limit'   // HTTP 429 — exponential backoff + jitter, honor Retry-After
  | 'server'       // HTTP 5xx from the provider — exponential backoff + jitter
  | 'network'      // connection-level failure — short linear backoff
  | 'client_error' // other HTTP 4xx (auth, bad request) — do NOT retry
  | 'unknown'

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const h = headers as { get?: (k: string) => string | null } & Record<string, unknown>
  if (typeof h.get === 'function') {
    const v = h.get(name)
    if (typeof v === 'string' && v.length > 0) return v
  }
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === name && typeof v === 'string') return v
  }
  return undefined
}

/** Parse a provider Retry-After header (seconds or HTTP date) into milliseconds. */
export function extractRetryAfterMs(err: unknown): number | undefined {
  const seen: unknown[] = [err, (err as { cause?: unknown } | null)?.cause]
  for (const c of seen) {
    if (!c || typeof c !== 'object') continue
    const e = c as Record<string, unknown>
    const raw =
      readHeader(e.headers, 'retry-after') ??
      readHeader((e.response as Record<string, unknown> | undefined)?.headers, 'retry-after')
    if (!raw) continue
    const seconds = Number(raw)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const date = Date.parse(raw)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  }
  return undefined
}

export function classifyRetryError(err: unknown): RetryErrorClass {
  switch (classifyFailure(err)) {
    case 'truncation': return 'truncation'
    case 'validation':
    case 'reference':
    case 'invalid_json': return 'validation'
    case 'timeout': return 'timeout'
    case 'rate_limit': return 'rate_limit'
    case 'server': return 'server'
    case 'transport': return 'network'
    case 'authentication':
    case 'billing':
    case 'invalid_params':
    case 'cancelled': return 'client_error'
    default: return 'unknown'
  }
}

export { isRetryableFailure }

const RATE_LIMIT_BASE_MS = 2_000
const SERVER_BASE_MS = 1_000
const NETWORK_BASE_MS = 500
const MAX_DELAY_MS = 30_000
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Delay before the next attempt for a given classified error. Multiplicative
 * jitter (±25%) on the exponential classes; Retry-After, when present, is
 * honored verbatim (capped) instead of the computed backoff.
 */
export function computeRetryDelayMs(
  err: unknown,
  attempt: number,
  cls: RetryErrorClass = classifyRetryError(err),
): number {
  const jittered = (base: number) => Math.round(base * (0.75 + Math.random() * 0.5))
  switch (cls) {
    case 'rate_limit': {
      const retryAfter = extractRetryAfterMs(err)
      if (retryAfter !== undefined) return Math.min(retryAfter, MAX_RETRY_AFTER_MS)
      return Math.min(jittered(RATE_LIMIT_BASE_MS * 2 ** (attempt - 1)), MAX_DELAY_MS)
    }
    case 'server':
      return Math.min(jittered(SERVER_BASE_MS * 2 ** (attempt - 1)), MAX_DELAY_MS)
    case 'timeout':
      return 500
    case 'network':
    case 'unknown':
      return Math.min(jittered(NETWORK_BASE_MS * attempt), 5_000)
    default:
      return 0
  }
}
