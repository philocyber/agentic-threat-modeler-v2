const SHORT_DATE = new Intl.DateTimeFormat('en-US', {
  day: '2-digit',
  month: 'short',
  timeZone: 'UTC',
})

const FULL_DATE = new Intl.DateTimeFormat('en-US', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
})

const INTEGER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export function formatShortDate(value: string | Date): string {
  return SHORT_DATE.format(new Date(value))
}

export function formatFullDate(value: string | Date): string {
  return FULL_DATE.format(new Date(value))
}

export function formatDateTime(value: string | Date): string {
  return DATE_TIME.format(new Date(value))
}

export function formatInteger(value: number): string {
  return INTEGER.format(value)
}

/** Analysis execution time is stored in seconds. */
export function formatRuntime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`
}

/**
 * Finished runs keep the persisted duration. In-flight runs have no stored
 * elapsed time until completion, so the caller supplies `now` and we count
 * from `startedAt` (or `createdAt` while the worker has not claimed yet).
 * Pass `now` only after mount so this stays hydration-safe.
 */
export function elapsedRunSeconds(input: {
  status: string
  durationSeconds?: number | null | undefined
  startedAt?: string | Date | null | undefined
  createdAt: string | Date
  now?: number | null
}): number | undefined {
  if (input.status === 'pending' || input.status === 'running') {
    if (input.now == null || input.now <= 0) return undefined
    const start = Date.parse(String(input.startedAt ?? input.createdAt))
    if (!Number.isFinite(start)) return undefined
    return Math.max(0, Math.floor((input.now - start) / 1000))
  }
  if (input.durationSeconds == null) return undefined
  return input.durationSeconds
}

export function formatDurationMs(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return '—'
  const ms = Math.max(0, milliseconds)
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const totalSeconds = Math.round(ms / 1_000)
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`
}
