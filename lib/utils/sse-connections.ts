const activeConnections = new Map<string, number>()

export type SseReservation =
  | { allowed: false }
  | { allowed: true; release: () => void }

export function reserveSseConnection(
  actorId: string,
  runId: string,
  limit = 5,
): SseReservation {
  const key = `${actorId}\u0000${runId}`
  const current = activeConnections.get(key) ?? 0
  if (current >= limit) return { allowed: false }
  activeConnections.set(key, current + 1)
  let released = false
  return {
    allowed: true,
    release() {
      if (released) return
      released = true
      const remaining = (activeConnections.get(key) ?? 1) - 1
      if (remaining <= 0) activeConnections.delete(key)
      else activeConnections.set(key, remaining)
    },
  }
}

export function _clearSseConnections(): void {
  activeConnections.clear()
}
