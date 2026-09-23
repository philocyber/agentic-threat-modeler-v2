/**
 * Shared status predicates for client and server.
 *
 * `partial` was added when phases started degrading instead of killing the run.
 * Anything that only checked for `completed` or `failed` silently stopped
 * treating those runs as finished: the progress panel kept polling a run that
 * had already ended and only settled after a manual reload.
 */
/** Every status a run can end on. Exported so queries filter on the same list. */
export const TERMINAL_ANALYSIS_STATUSES = ['completed', 'partial', 'failed'] as const

const TERMINAL_STATUSES = new Set<string>(TERMINAL_ANALYSIS_STATUSES)
const DELIVERED_STATUSES = new Set(['completed', 'partial'])

export function isTerminalAnalysisStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL_STATUSES.has(status)
}

/** Reached the end with results, whether or not a phase degraded on the way. */
export function analysisDeliveredResults(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && DELIVERED_STATUSES.has(status)
}
