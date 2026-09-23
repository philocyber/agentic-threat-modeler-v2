/** How long a claimed run may sit without a successful renewal before another worker may take it. */
export const PIPELINE_LEASE_TTL_MS = 180_000
/** Renewal cadence while a run is executing. Must stay well below the TTL. */
export const PIPELINE_HEARTBEAT_MS = 10_000
export const PIPELINE_CANCEL_POLL_MS = 1_000
export const PIPELINE_WORKER_POLL_MS = 1_000
/** A worker that has not recorded liveness within this window is treated as down. */
export const PIPELINE_WORKER_STALE_MS = 60_000

export function leaseExpiryFrom(now = new Date(), ttlMs = PIPELINE_LEASE_TTL_MS): Date {
  return new Date(now.getTime() + ttlMs)
}
