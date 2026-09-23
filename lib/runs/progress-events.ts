import type { ProgressEvent } from '@/lib/models/types'

/** Replay durable events without inventing timestamps or dropping known counts. */
export function mergeProgressEvents(...groups: ProgressEvent[][]): ProgressEvent[] {
  const events = new Map<string, ProgressEvent>()
  for (const group of groups) for (const event of group) {
    const key = `${event.phase}:${event.status}`
    const previous = events.get(key)
    events.set(key, { ...previous, ...event, count: event.count ?? previous?.count })
  }
  return [...events.values()].sort((a, b) => a.timestamp - b.timestamp)
}

export function parseProgressEvents(text: string): ProgressEvent[] {
  return text.split('\n').flatMap(line => {
    try {
      const e = JSON.parse(line)
      return typeof e.phase === 'string' && ['start', 'done', 'error'].includes(e.status) && Number.isFinite(e.timestamp)
        ? [{ phase: e.phase, status: e.status, timestamp: e.timestamp, ...(Number.isFinite(e.count) ? { count: e.count } : {}) }] : []
    } catch { return [] }
  })
}
