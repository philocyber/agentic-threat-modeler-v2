import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { redactSecretsInText } from '@/lib/utils/redact'
import { _clearStructuredResponseCache } from '@/lib/llm/response-cache'

export const DEFAULT_ACCEPTANCE_REPORT_BYTES = 256 * 1024
export const DEFAULT_ACCEPTANCE_DIAGNOSTIC_CHARS = 2_000
export const DEFAULT_ACCEPTANCE_MAX_ARRAY_ITEMS = 100
export const DEFAULT_ACCEPTANCE_MAX_OBJECT_KEYS = 200

export class AcceptanceDeadlineError extends Error {
  readonly code = 'ACCEPTANCE_DEADLINE'
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Acceptance run exceeded its ${timeoutMs}ms deadline.`)
    this.name = 'AcceptanceDeadlineError'
    this.timeoutMs = timeoutMs
  }
}

export type AcceptanceRunStatus = 'completed' | 'failed' | 'timed_out'

export type AcceptanceDiagnostic = {
  name: string
  code?: string
  message: string
}

export type AcceptanceRun<T> = {
  status: AcceptanceRunStatus
  startedAt: string
  durationMs: number
  value?: T
  error?: AcceptanceDiagnostic
}

type Clock = () => number
type Timer = ReturnType<typeof setTimeout>

function boundedText(value: string, maxChars: number): string {
  // Avoid scanning an unbounded provider payload. Omitting the whole value is
  // safer than redacting a prefix, which could cut a credential-bearing URI
  // between its password and host and leave an unsafe fragment behind.
  const scanLimit = Math.max(16_384, maxChars * 8)
  if (value.length > scanLimit) return `[truncated ${value.length} chars]`
  const redacted = redactSecretsInText(value)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
  if (redacted.length <= maxChars) return redacted
  return `${redacted.slice(0, Math.max(0, maxChars - 16))}… [truncated]`
}

export function acceptanceDiagnostic(error: unknown, maxChars = DEFAULT_ACCEPTANCE_DIAGNOSTIC_CHARS): AcceptanceDiagnostic {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown } | null
  const name = typeof candidate?.name === 'string' && candidate.name ? candidate.name : 'Error'
  const code = typeof candidate?.code === 'string' && candidate.code ? candidate.code : undefined
  const rawMessage = typeof candidate?.message === 'string' ? candidate.message : String(error)
  return {
    name: boundedText(name, 120),
    ...(code ? { code: boundedText(code, 120) } : {}),
    message: boundedText(rawMessage, maxChars),
  }
}

/**
 * Run one acceptance attempt under one wall clock deadline. The provider call
 * receives the same signal for the entire attempt, including every round.
 * The race also bounds adapters that do not honor AbortSignal promptly.
 */
export async function runWithAcceptanceDeadline<T>(params: {
  timeoutMs: number
  run: (signal: AbortSignal, deadlineAt: number) => Promise<T>
  now?: Clock
  setTimer?: (callback: () => void, delayMs: number) => Timer
  clearTimer?: (timer: Timer) => void
}): Promise<T> {
  if (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) {
    throw new Error('Acceptance deadline must be a positive finite duration.')
  }

  const now = params.now ?? Date.now
  const setTimer = params.setTimer ?? setTimeout
  const clearTimer = params.clearTimer ?? clearTimeout
  const controller = new AbortController()
  const deadlineAt = now() + params.timeoutMs
  let timedOut = false
  let timer: Timer | undefined

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimer(() => {
      timedOut = true
      const error = new AcceptanceDeadlineError(params.timeoutMs)
      controller.abort(error)
      reject(error)
    }, params.timeoutMs)
  })

  try {
    const operation = Promise.resolve().then(() => params.run(controller.signal, deadlineAt))
    const result = await Promise.race([operation, timeout])
    // If the operation resolves from the abort handler in the same turn as the
    // timer, the deadline still wins semantically.
    if (timedOut) throw new AcceptanceDeadlineError(params.timeoutMs)
    return result
  } catch (error) {
    // Some adapters reject with AbortError as soon as the shared signal aborts,
    // before the timeout branch wins the race. Keep the status honest.
    if (timedOut) throw new AcceptanceDeadlineError(params.timeoutMs)
    throw error
  } finally {
    if (timer !== undefined) clearTimer(timer)
  }
}

/** Convert a throwing attempt into a reportable result with its partial state intact. */
export async function runAcceptanceAttempt<T>(params: {
  timeoutMs: number
  run: (signal: AbortSignal, deadlineAt: number) => Promise<T>
  now?: Clock
}): Promise<AcceptanceRun<T>> {
  const now = params.now ?? Date.now
  const started = now()
  try {
    const value = await runWithAcceptanceDeadline({ ...params, now })
    return {
      status: 'completed',
      startedAt: new Date(started).toISOString(),
      durationMs: Math.max(0, now() - started),
      value,
    }
  } catch (error) {
    const timedOut = error instanceof AcceptanceDeadlineError
    return {
      status: timedOut ? 'timed_out' : 'failed',
      startedAt: new Date(started).toISOString(),
      durationMs: Math.max(0, now() - started),
      error: acceptanceDiagnostic(error),
    }
  }
}

/** Keep acceptance probes independent even when the process has response caching enabled. */
export async function withResponseCacheDisabled<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.LLM_RESPONSE_CACHE_ENABLED
  process.env.LLM_RESPONSE_CACHE_ENABLED = '0'
  _clearStructuredResponseCache()
  try {
    return await run()
  } finally {
    _clearStructuredResponseCache()
    if (previous === undefined) delete process.env.LLM_RESPONSE_CACHE_ENABLED
    else process.env.LLM_RESPONSE_CACHE_ENABLED = previous
  }
}

function boundForReport(value: unknown, depth = 0): unknown {
  // Keep ordinary report nesting intact. The explicit array/object/string
  // bounds below cap untrusted diagnostics without erasing evaluation cases.
  if (depth > 20) return '[truncated]'
  if (typeof value === 'string') return boundedText(value, DEFAULT_ACCEPTANCE_DIAGNOSTIC_CHARS)
  if (Array.isArray(value)) return value.slice(0, DEFAULT_ACCEPTANCE_MAX_ARRAY_ITEMS).map((item) => boundForReport(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, DEFAULT_ACCEPTANCE_MAX_OBJECT_KEYS).map(([key, child]) => [
      boundedText(key, 120),
      boundForReport(child, depth + 1),
    ]))
  }
  return value
}

/** Persist a bounded, redacted JSON report, including a minimal fallback if it is oversized. */
export async function writeAcceptanceReport(
  output: string,
  report: unknown,
  maxBytes = DEFAULT_ACCEPTANCE_REPORT_BYTES,
): Promise<void> {
  const bounded = boundForReport(report)
  let encoded = JSON.stringify(bounded, null, 2)
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    const summary = bounded && typeof bounded === 'object' && !Array.isArray(bounded)
      ? Object.fromEntries(Object.entries(bounded).filter(([key]) => [
        'stage', 'scope', 'status', 'passed', 'blocked', 'error', 'diagnostic',
        // Keep cost and call evidence when the transcript is too large.
        'model', 'provider', 'maxCalls', 'attemptedCalls', 'maxUsd',
        'unconfirmedCostUsd', 'usage', 'rounds', 'transcriptTruncated',
      ].includes(key)))
      : { status: 'failed', passed: false }
    encoded = JSON.stringify(boundForReport({
      ...summary,
      diagnostic: 'Acceptance report exceeded the storage bound; transcript details were omitted.',
    }), null, 2)
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
      encoded = JSON.stringify({ status: 'failed', passed: false, diagnostic: 'Acceptance report exceeded its storage bound.' })
    }
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) encoded = '{}'
  }
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, encoded, { mode: 0o600 })
    await rename(temporary, output)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}
