const MINUTE_MS = 60_000

/** Each planned source pass may contain evidence, emission and bounded retries. */
export function sourcePhaseTimeoutMs(baseMs: number, passes: number, pipelineMs: number): number {
  const count = Number.isSafeInteger(passes) && passes > 0 ? passes : 1
  return Math.min(pipelineMs, baseMs * count)
}

/** Serial batch waves each need a phase budget; concurrent batches share one. */
export function batchedPhaseTimeoutMs(baseMs: number, batches: number, concurrency: number, pipelineMs: number): number {
  const count = Number.isSafeInteger(batches) && batches > 0 ? batches : 1
  const workers = Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : 1
  return sourcePhaseTimeoutMs(baseMs, Math.ceil(count / workers), pipelineMs)
}

/** Kimi full-power runs have historically needed 25-30 minutes. */
export const DEFAULT_PIPELINE_TIMEOUT_MS = 60 * MINUTE_MS

/** One phase may contain several structured calls and classified retries. */
export const DEFAULT_PIPELINE_PHASE_TIMEOUT_MS = 15 * MINUTE_MS

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function resolvePipelineTimeouts(
  env: Partial<Record<'PIPELINE_TIMEOUT_MS' | 'PIPELINE_PHASE_TIMEOUT_MS', string | undefined>> = {
    PIPELINE_TIMEOUT_MS: process.env.PIPELINE_TIMEOUT_MS,
    PIPELINE_PHASE_TIMEOUT_MS: process.env.PIPELINE_PHASE_TIMEOUT_MS,
  },
): { pipelineTimeoutMs: number; phaseTimeoutMs: number } {
  const pipelineTimeoutMs = positiveInteger(env.PIPELINE_TIMEOUT_MS, DEFAULT_PIPELINE_TIMEOUT_MS)
  const requestedPhaseTimeoutMs = positiveInteger(
    env.PIPELINE_PHASE_TIMEOUT_MS,
    DEFAULT_PIPELINE_PHASE_TIMEOUT_MS,
  )
  return {
    pipelineTimeoutMs,
    phaseTimeoutMs: Math.min(pipelineTimeoutMs, requestedPhaseTimeoutMs),
  }
}
